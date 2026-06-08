// ============================================================================
// mcp-tools/updateEvent.js — reschedule / edit / cancel a calendar event (chat/voice)
// ============================================================================
// Write. One tool covers every mutation a user voices after an event exists:
//   • "move my dentist to 4pm"      → starts_at / in_minutes (reschedules)
//   • "make it 90 minutes"          → ends_at / duration_minutes
//   • "rename it to …"              → title / description
//   • "change the location to …"    → location
//   • "cancel that meeting"         → status: 'cancelled'
// The event id comes from lykn_listEvents. At least one mutation must be
// supplied. Scoped to the caller's own rows (handler filters on user_id; RLS
// enforces it again under JWT). For permanent removal use lykn_deleteEvent.

import { jsonContent, errorContent, requireWrite } from './index.js';
import { resolveInstant } from './_time.js';

const TITLE_MAX = 280;
const DESC_MAX = 4000;
const LOC_MAX = 300;
const TZ_MAX = 64;
const COLOR_MAX = 16;
const MAX_IN_MINUTES = 60 * 24 * 366 * 2;
const MAX_DURATION_MINUTES = 60 * 24 * 366;

export const updateEventTool = {
  name: 'lykn_updateEvent',
  title: 'Reschedule, edit, or cancel a calendar event',
  scope: 'write',
  description: [
    'Update an existing calendar event. Get its id from lykn_listEvents first,',
    'then call this to:',
    '  • reschedule the start → starts_at (ISO 8601 + tz) OR in_minutes',
    '  • change the length     → ends_at (ISO) OR duration_minutes (from start)',
    '  • edit text             → title and/or description',
    '  • change place          → location',
    '  • toggle all-day        → all_day',
    '  • mark tentative/cancel → status ("tentative" | "cancelled" | "confirmed")',
    '',
    'Supply the id plus at least one field to change. Cancelling hides the event',
    'from the calendar but keeps it (use lykn_deleteEvent to remove permanently).',
    'Confirm what changed in plain language afterwards.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The event id (from lykn_listEvents).',
      },
      starts_at: {
        type: 'string',
        description: 'New absolute ISO 8601 start WITH timezone offset. Provide this OR in_minutes to reschedule.',
      },
      in_minutes: {
        type: 'integer',
        minimum: 1,
        description: 'Reschedule the start to this many minutes from now. Provide this OR starts_at.',
      },
      ends_at: {
        type: 'string',
        description: 'New absolute ISO 8601 end (must be >= start). Provide this OR duration_minutes.',
      },
      duration_minutes: {
        type: 'integer',
        minimum: 1,
        description: 'New length in minutes measured from the (new or existing) start. Provide this OR ends_at.',
      },
      all_day: {
        type: 'boolean',
        description: 'Set true/false to toggle the all-day flag.',
      },
      title: {
        type: 'string',
        description: 'New event name (<=280 chars).',
      },
      description: {
        type: 'string',
        description: 'New notes/agenda (<=4000 chars). Pass an empty string to clear it.',
      },
      location: {
        type: 'string',
        description: 'New location/meeting link (<=300 chars). Pass an empty string to clear it.',
      },
      timezone: {
        type: 'string',
        description: 'New IANA timezone, e.g. "America/Denver".',
      },
      color: {
        type: 'string',
        description: 'New hex color hint for the UI, e.g. "#34C759". Empty string clears it.',
      },
      status: {
        type: 'string',
        enum: ['confirmed', 'tentative', 'cancelled'],
        description: '"cancelled" hides it from the calendar; "confirmed" restores it; "tentative" marks it unsure.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const id = String(args?.id || '').trim();
    if (!id) return errorContent('id is required — call lykn_listEvents to find the event first.');

    // Load the current row so we can validate end-vs-start and compute a
    // duration-based end against the (possibly new) start.
    const { data: current, error: loadErr } = await ctx.supabaseAdmin
      .from('lykn_events')
      .select('id, starts_at, ends_at, all_day, timezone, read_only, external_provider')
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (loadErr) {
      return errorContent(`event lookup failed: ${loadErr.message}`);
    }
    if (!current) {
      return errorContent('No event found with that id (it may not exist or not belong to you).');
    }
    if (current.read_only) {
      const where = current.external_provider === 'apple'
        ? 'Apple Calendar'
        : current.external_provider === 'google'
          ? 'Google Calendar'
          : 'an external calendar';
      return errorContent(
        `That event is synced (read-only) from ${where}, so LYKN can't change it here — edit it in ${where} and it will update on the next sync. You can still create a separate LYKN event.`,
      );
    }

    const patch = {};
    // Resolve a NAIVE starts_at/ends_at against this tz (arg, else the event's
    // stored timezone) so "move it to 3pm" doesn't drift to UTC.
    const tzHint = (typeof args?.timezone === 'string' && args.timezone.trim())
      ? args.timezone.trim()
      : (typeof current.timezone === 'string' ? current.timezone : '');

    // Reschedule the start.
    let newStart = new Date(current.starts_at);
    const hasInMinutes = args?.in_minutes !== undefined && args?.in_minutes !== null && args?.in_minutes !== '';
    const hasStartsAt = typeof args?.starts_at === 'string' && args.starts_at.trim();
    if (hasStartsAt) {
      const parsed = resolveInstant(args.starts_at, tzHint);
      if (!parsed) {
        return errorContent('starts_at is not a valid ISO 8601 timestamp.');
      }
      newStart = parsed;
      patch.starts_at = parsed.toISOString();
    } else if (hasInMinutes) {
      const mins = Number.parseInt(args.in_minutes, 10);
      if (!Number.isFinite(mins) || mins < 1) {
        return errorContent('in_minutes must be a positive integer number of minutes from now.');
      }
      if (mins > MAX_IN_MINUTES) {
        return errorContent('in_minutes is too far in the future (max ~2 years).');
      }
      newStart = new Date(Date.now() + mins * 60_000);
      patch.starts_at = newStart.toISOString();
    }

    // Change the end (absolute or duration from the resolved start).
    const hasEndsAt = typeof args?.ends_at === 'string' && args.ends_at.trim();
    const hasDuration = args?.duration_minutes !== undefined && args?.duration_minutes !== null && args?.duration_minutes !== '';
    if (hasEndsAt) {
      const parsed = resolveInstant(args.ends_at, tzHint);
      if (!parsed) {
        return errorContent('ends_at is not a valid ISO 8601 timestamp.');
      }
      if (parsed.getTime() < newStart.getTime()) {
        return errorContent('ends_at is before the start — the event would end before it begins.');
      }
      patch.ends_at = parsed.toISOString();
    } else if (hasDuration) {
      const mins = Number.parseInt(args.duration_minutes, 10);
      if (!Number.isFinite(mins) || mins < 1) {
        return errorContent('duration_minutes must be a positive integer number of minutes.');
      }
      if (mins > MAX_DURATION_MINUTES) {
        return errorContent('duration_minutes is too long (max ~1 year for a single event).');
      }
      patch.ends_at = new Date(newStart.getTime() + mins * 60_000).toISOString();
    } else if (patch.starts_at && current.ends_at) {
      // Start moved but end not specified: shift the end by the same delta so
      // the event keeps its original length.
      const delta = newStart.getTime() - new Date(current.starts_at).getTime();
      patch.ends_at = new Date(new Date(current.ends_at).getTime() + delta).toISOString();
    }

    if (typeof args?.all_day === 'boolean') patch.all_day = args.all_day;

    if (typeof args?.title === 'string') {
      const t = args.title.trim().slice(0, TITLE_MAX);
      if (!t) return errorContent('title cannot be blank.');
      patch.title = t;
    }
    if (typeof args?.description === 'string') {
      patch.description = args.description.trim().slice(0, DESC_MAX) || null;
    }
    if (typeof args?.location === 'string') {
      patch.location = args.location.trim().slice(0, LOC_MAX) || null;
    }
    if (typeof args?.timezone === 'string') {
      patch.timezone = args.timezone.trim().slice(0, TZ_MAX) || null;
    }
    if (typeof args?.color === 'string') {
      patch.color = args.color.trim().slice(0, COLOR_MAX) || null;
    }
    if (['confirmed', 'tentative', 'cancelled'].includes(args?.status)) {
      patch.status = args.status;
    }

    if (Object.keys(patch).length === 0) {
      return errorContent('Nothing to update — pass a new time (starts_at/in_minutes), end (ends_at/duration_minutes), title/description/location, all_day, or status.');
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_events')
      .update(patch)
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, title, description, starts_at, ends_at, all_day, location, timezone, color, status, project_id, updated_at')
      .maybeSingle();

    if (error) {
      console.warn('[mcp:updateEvent]', error.message);
      return errorContent(`event update failed: ${error.message}`);
    }
    if (!data) {
      return errorContent('No event found with that id (it may not exist or not belong to you).');
    }

    const verb = data.status === 'cancelled'
      ? 'cancelled'
      : patch.starts_at
        ? 'rescheduled'
        : 'updated';

    return jsonContent({
      ok: true,
      message: `Event "${data.title}" ${verb}.`,
      event: data,
    });
  },
};
