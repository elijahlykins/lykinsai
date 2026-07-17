// ============================================================================
// mcp-tools/createEvent.js — put an event on the user's LYKN calendar (chat/voice)
// ============================================================================
// Write. Creates a row in lykn_events when the user asks to schedule something
// ("put lunch with Sarah on Thursday at noon", "block 2-4pm tomorrow for deep
// work", "add my dentist appointment Friday at 9am"). The same handler backs
// text chat, the OpenAI Realtime voice path, and the ElevenLabs voice path.
//
// Time resolution:
//   YOU resolve the WHEN. Pass an absolute ISO 8601 `starts_at` WITH timezone
//   offset (preferred — call lykn_get_current_time first if unsure of "now"),
//   OR a relative `in_minutes` offset from now. For the end, pass `ends_at`
//   (ISO) OR `duration_minutes`; if neither is given a timed event defaults to
//   60 minutes and an all-day event gets no end. Set `all_day: true` for
//   day-level events ("my birthday on the 14th").
//
// LYKN IS the calendar — this writes to the user's own LYKN calendar, which
// they see in the calendar pop-up. It does NOT push to Google/Apple/Outlook.

import { jsonContent, errorContent, requireWrite } from './index.js';
import { resolveInstant } from './_time.js';
import { resolveWriteProjectTarget } from '../lib/projectWriteTarget.js';

const TITLE_MAX = 280;
const DESC_MAX = 4000;
const LOC_MAX = 300;
const TZ_MAX = 64;
const COLOR_MAX = 16;
// ~2 years of minutes — a guardrail so a model typo can't schedule for 9999.
const MAX_IN_MINUTES = 60 * 24 * 366 * 2;
const MAX_DURATION_MINUTES = 60 * 24 * 366; // a single event spans <= ~1 year
const DEFAULT_DURATION_MINUTES = 60;

export const createEventTool = {
  name: 'lykn_createEvent',
  title: 'Add an event to the user\'s calendar',
  scope: 'write',
  description: [
    'Create a calendar event when the user asks to schedule something —',
    '"put lunch with Sarah on Thursday at noon", "block 2-4pm tomorrow for',
    'deep work", "add my dentist appointment Friday 9am", "my birthday is',
    'on the 14th". Writes to the user\'s own LYKN calendar (they see it in the',
    'calendar pop-up). It does NOT sync to Google/Apple/Outlook.',
    '',
    'You must resolve WHEN it starts. Provide ONE of:',
    '  • starts_at  — absolute ISO 8601 instant WITH timezone offset',
    '                 (e.g. "2026-06-11T12:00:00-06:00"). Preferred. If unsure',
    '                 of the current date/time, call lykn_get_current_time first.',
    '  • in_minutes — relative offset from now in minutes (e.g. 60 = in an hour).',
    '',
    'For the end (optional) provide ONE of:',
    '  • ends_at          — absolute ISO 8601 instant (must be >= start).',
    '  • duration_minutes — length in minutes (e.g. 120 for a 2-hour block).',
    'If neither is given, a timed event defaults to 60 minutes.',
    '',
    'Set all_day:true for day-level events (birthdays, trips, deadlines) — pass',
    'starts_at as that day. Optionally pass location, a timezone (IANA, e.g.',
    '"America/Denver"), and remind_at_text-style natural phrasing is NOT needed',
    'here. After saving, confirm WHAT and WHEN in plain language. Do not invent',
    'an event the user did not ask for.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The event name (<=280 chars), e.g. "Lunch with Sarah".',
      },
      starts_at: {
        type: 'string',
        description: 'Absolute ISO 8601 start WITH timezone offset, e.g. "2026-06-11T12:00:00-06:00". Provide this OR in_minutes.',
      },
      in_minutes: {
        type: 'integer',
        minimum: 1,
        description: 'Relative start offset from now, in minutes. Provide this OR starts_at.',
      },
      ends_at: {
        type: 'string',
        description: 'Absolute ISO 8601 end WITH timezone offset (must be >= start). Provide this OR duration_minutes (optional).',
      },
      duration_minutes: {
        type: 'integer',
        minimum: 1,
        description: 'Event length in minutes (e.g. 120 = 2 hours). Provide this OR ends_at. Defaults to 60 for timed events.',
      },
      all_day: {
        type: 'boolean',
        description: 'True for day-level events (birthdays, trips, deadlines). The time-of-day is then informational.',
      },
      location: {
        type: 'string',
        description: 'Optional place, room, or meeting link (<=300 chars).',
      },
      description: {
        type: 'string',
        description: 'Optional agenda / notes / detail (<=4000 chars).',
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone the user is in, e.g. "America/Denver" (<=64 chars). If you pass a naive starts_at/ends_at (no offset), it is interpreted in THIS timezone — so always include timezone when you do not put an explicit offset on the timestamp.',
      },
      color: {
        type: 'string',
        description: 'Optional hex color hint for the calendar UI, e.g. "#34C759".',
      },
      project_id: {
        type: 'string',
        description: 'Optional id of the project this event belongs to (from lykn_listProjects). If omitted, the event is filed under the user\'s currently active/focused project when there is one; pass an explicit id to override that.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const title = String(args?.title || '').trim().slice(0, TITLE_MAX);
    if (!title) return errorContent('title is required — what is the event called?');

    const allDay = args?.all_day === true;
    // The IANA timezone the user meant — used to resolve a NAIVE starts_at/ends_at
    // (one with no offset) to the right instant instead of treating it as UTC.
    const tzHint = typeof args?.timezone === 'string' ? args.timezone.trim() : '';

    // Resolve the start from exactly one of starts_at / in_minutes.
    let startsAt = null;
    const hasInMinutes = args?.in_minutes !== undefined && args?.in_minutes !== null && args?.in_minutes !== '';
    const hasStartsAt = typeof args?.starts_at === 'string' && args.starts_at.trim();

    if (hasStartsAt) {
      const parsed = resolveInstant(args.starts_at, tzHint);
      if (!parsed) {
        return errorContent('starts_at is not a valid ISO 8601 timestamp. Use e.g. "2026-06-11T12:00:00-06:00", or pass in_minutes instead.');
      }
      startsAt = parsed;
    } else if (hasInMinutes) {
      const mins = Number.parseInt(args.in_minutes, 10);
      if (!Number.isFinite(mins) || mins < 1) {
        return errorContent('in_minutes must be a positive integer number of minutes from now.');
      }
      if (mins > MAX_IN_MINUTES) {
        return errorContent('in_minutes is too far in the future (max ~2 years). Pass an absolute starts_at for distant dates.');
      }
      startsAt = new Date(Date.now() + mins * 60_000);
    } else {
      return errorContent('When does it start? Provide starts_at (ISO 8601) or in_minutes (relative).');
    }

    // Resolve the end (optional) from ends_at / duration_minutes.
    let endsAt = null;
    const hasEndsAt = typeof args?.ends_at === 'string' && args.ends_at.trim();
    const hasDuration = args?.duration_minutes !== undefined && args?.duration_minutes !== null && args?.duration_minutes !== '';
    if (hasEndsAt) {
      const parsed = resolveInstant(args.ends_at, tzHint);
      if (!parsed) {
        return errorContent('ends_at is not a valid ISO 8601 timestamp.');
      }
      if (parsed.getTime() < startsAt.getTime()) {
        return errorContent('ends_at is before starts_at — the event would end before it begins.');
      }
      endsAt = parsed;
    } else if (hasDuration) {
      const mins = Number.parseInt(args.duration_minutes, 10);
      if (!Number.isFinite(mins) || mins < 1) {
        return errorContent('duration_minutes must be a positive integer number of minutes.');
      }
      if (mins > MAX_DURATION_MINUTES) {
        return errorContent('duration_minutes is too long (max ~1 year for a single event).');
      }
      endsAt = new Date(startsAt.getTime() + mins * 60_000);
    } else if (!allDay) {
      // Timed events get a sensible default block so the grid can draw them.
      endsAt = new Date(startsAt.getTime() + DEFAULT_DURATION_MINUTES * 60_000);
    }

    const description = typeof args?.description === 'string' ? args.description.trim().slice(0, DESC_MAX) : '';
    const location = typeof args?.location === 'string' ? args.location.trim().slice(0, LOC_MAX) : '';
    const timezone = typeof args?.timezone === 'string' ? args.timezone.trim().slice(0, TZ_MAX) : '';
    const color = typeof args?.color === 'string' ? args.color.trim().slice(0, COLOR_MAX) : '';

    // Resolve which project this event is filed under. An explicit, writable
    // project_id wins; otherwise fall back to the chat's scoped project
    // (custom-model bound / board scope) and finally the user's ACTIVE
    // project — so an event created from the overlay / voice / chat shows up
    // on the focused project's calendar instead of landing unfiled. Mirrors
    // lykn_createTodo / lykn_createStewardItem.
    const explicitProjectId = typeof args?.project_id === 'string' && args.project_id.trim()
      ? args.project_id.trim()
      : null;
    const { project: targetProject } = await resolveWriteProjectTarget(ctx, explicitProjectId);
    const projectId = targetProject?.id || null;

    const source = `lykn-chat-agent:${ctx.attribSurface || 'lykn-chat'}`.slice(0, 64);

    const row = {
      user_id: ctx.userId,
      title,
      description: description || null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt ? endsAt.toISOString() : null,
      all_day: allDay,
      location: location || null,
      timezone: timezone || null,
      color: color || null,
      project_id: projectId,
      source,
    };

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_events')
      .insert(row)
      .select('id, title, description, starts_at, ends_at, all_day, location, timezone, color, status, project_id, created_at')
      .single();
    if (error) {
      console.warn('[mcp:createEvent]', error.message);
      return errorContent(`event insert failed: ${error.message}`);
    }

    const projectSpoken = targetProject?.name ? ` (filed under "${targetProject.name}")` : '';
    return jsonContent({
      ok: true,
      message: `Added "${title}" to your calendar${projectSpoken}.`,
      event: data,
      project: targetProject ? { id: targetProject.id, name: targetProject.name } : null,
    });
  },
};
