// ============================================================================
// mcp-tools/updateReminder.js — complete / cancel / reschedule / edit (chat/voice)
// ============================================================================
// Write. One tool covers every mutation a user voices after a reminder exists:
//   • "mark that done"        → status: 'completed'
//   • "cancel that reminder"  → status: 'cancelled'
//   • "push it to 5pm"        → remind_at / in_minutes (reschedules, stays pending)
//   • "change it to …"        → title / body
// The reminder id comes from lykn_listReminders. At least one mutation must be
// supplied. Scoped to the caller's own rows (handler filters on user_id; RLS
// enforces it again under JWT).

import { jsonContent, errorContent, requireWrite } from './index.js';

const TITLE_MAX = 280;
const BODY_MAX = 4000;
const TEXT_MAX = 200;
const MAX_IN_MINUTES = 60 * 24 * 366 * 2;

export const updateReminderTool = {
  name: 'lykn_updateReminder',
  title: 'Complete, cancel, reschedule, or edit a reminder',
  scope: 'write',
  description: [
    'Update an existing reminder. Get its id from lykn_listReminders first,',
    'then call this to:',
    '  • mark it done      → status: "completed"',
    '  • cancel it         → status: "cancelled"',
    '  • reschedule it     → remind_at (ISO 8601 + tz) OR in_minutes (relative)',
    '  • change the text   → title and/or body',
    '',
    'Supply the id plus at least one field to change. Rescheduling a',
    'completed/cancelled reminder reactivates it (status returns to pending).',
    'Confirm what changed in plain language afterwards.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The reminder id (from lykn_listReminders).',
      },
      status: {
        type: 'string',
        enum: ['completed', 'cancelled', 'pending'],
        description: 'Set "completed" when done, "cancelled" to drop it. "pending" reactivates a closed reminder.',
      },
      remind_at: {
        type: 'string',
        description: 'Reschedule to this absolute ISO 8601 instant WITH timezone offset. Keeps/returns the reminder to pending.',
      },
      in_minutes: {
        type: 'integer',
        minimum: 1,
        description: 'Reschedule to this many minutes from now (relative). Provide this OR remind_at.',
      },
      remind_at_text: {
        type: 'string',
        description: 'Updated human phrasing of the new time, read back verbatim. <=200 chars.',
      },
      title: {
        type: 'string',
        description: 'New reminder text (<=280 chars).',
      },
      body: {
        type: 'string',
        description: 'New detail/context (<=4000 chars). Pass an empty string to clear it.',
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
    if (!id) return errorContent('id is required — call lykn_listReminders to find the reminder first.');

    const patch = {};

    // Reschedule (also flips status back to pending unless an explicit status
    // is given below).
    let rescheduled = false;
    const hasInMinutes = args?.in_minutes !== undefined && args?.in_minutes !== null && args?.in_minutes !== '';
    const hasRemindAt = typeof args?.remind_at === 'string' && args.remind_at.trim();
    if (hasRemindAt) {
      const parsed = new Date(args.remind_at.trim());
      if (Number.isNaN(parsed.getTime())) {
        return errorContent('remind_at is not a valid ISO 8601 timestamp.');
      }
      patch.remind_at = parsed.toISOString();
      rescheduled = true;
    } else if (hasInMinutes) {
      const mins = Number.parseInt(args.in_minutes, 10);
      if (!Number.isFinite(mins) || mins < 1) {
        return errorContent('in_minutes must be a positive integer number of minutes from now.');
      }
      if (mins > MAX_IN_MINUTES) {
        return errorContent('in_minutes is too far in the future (max ~2 years).');
      }
      patch.remind_at = new Date(Date.now() + mins * 60_000).toISOString();
      rescheduled = true;
    }

    if (typeof args?.remind_at_text === 'string') {
      patch.remind_at_text = args.remind_at_text.trim().slice(0, TEXT_MAX) || null;
    }

    if (typeof args?.title === 'string') {
      const t = args.title.trim().slice(0, TITLE_MAX);
      if (!t) return errorContent('title cannot be blank.');
      patch.title = t;
    }

    if (typeof args?.body === 'string') {
      patch.body = args.body.trim().slice(0, BODY_MAX) || null;
    }

    if (['completed', 'cancelled', 'pending'].includes(args?.status)) {
      patch.status = args.status;
      patch.completed_at = args.status === 'completed' ? new Date().toISOString() : null;
    } else if (rescheduled) {
      // Rescheduling implicitly reopens the reminder.
      patch.status = 'pending';
      patch.completed_at = null;
    }

    if (Object.keys(patch).length === 0) {
      return errorContent('Nothing to update — pass a status, a new time (remind_at/in_minutes), or new title/body.');
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_reminders')
      .update(patch)
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, title, body, remind_at, remind_at_text, status, project_id, completed_at, updated_at')
      .maybeSingle();

    if (error) {
      console.warn('[mcp:updateReminder]', error.message);
      return errorContent(`reminder update failed: ${error.message}`);
    }
    if (!data) {
      return errorContent('No reminder found with that id (it may not exist or not belong to you).');
    }

    const verb = data.status === 'completed'
      ? 'marked done'
      : data.status === 'cancelled'
        ? 'cancelled'
        : rescheduled
          ? `rescheduled to ${data.remind_at_text || data.remind_at}`
          : 'updated';

    return jsonContent({
      ok: true,
      message: `Reminder "${data.title}" ${verb}.`,
      reminder: {
        id: data.id,
        title: data.title,
        body: data.body,
        remind_at: data.remind_at,
        remind_at_text: data.remind_at_text,
        status: data.status,
        project_id: data.project_id,
        completed_at: data.completed_at,
        updated_at: data.updated_at,
      },
    });
  },
};
