// ============================================================================
// mcp-tools/deleteEvent.js — permanently remove a calendar event (chat/voice)
// ============================================================================
// Write. Hard-deletes a row from lykn_events. Use this when the user wants the
// event GONE ("delete that meeting", "remove my dentist appointment"). For a
// reversible "cancel" that keeps history, prefer lykn_updateEvent with
// status:'cancelled'. The id comes from lykn_listEvents. Scoped to the
// caller's own rows (handler filters on user_id; RLS enforces it under JWT).

import { jsonContent, errorContent } from './index.js';

export const deleteEventTool = {
  name: 'lykn_deleteEvent',
  title: 'Delete a calendar event',
  scope: 'write',
  description: [
    'Permanently delete a calendar event. Get its id from lykn_listEvents',
    'first. Use this when the user clearly wants it removed ("delete that",',
    '"take it off my calendar"). If they only want to cancel/keep a record,',
    'prefer lykn_updateEvent with status "cancelled" instead. Confirm the',
    'deletion in plain language afterwards. This cannot be undone.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The event id to delete (from lykn_listEvents).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const id = String(args?.id || '').trim();
    if (!id) return errorContent('id is required — call lykn_listEvents to find the event first.');

    // Synced-in events are read-only — deleting locally would just resurrect
    // on the next sync and can't propagate to the source calendar.
    const { data: existing, error: loadErr } = await ctx.supabaseAdmin
      .from('lykn_events')
      .select('id, read_only, external_provider')
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (loadErr) {
      return errorContent(`event lookup failed: ${loadErr.message}`);
    }
    if (!existing) {
      return errorContent('No event found with that id (it may not exist or not belong to you).');
    }
    if (existing.read_only) {
      const where = existing.external_provider === 'apple'
        ? 'Apple Calendar'
        : existing.external_provider === 'google'
          ? 'Google Calendar'
          : 'an external calendar';
      return errorContent(
        `That event is synced (read-only) from ${where}, so LYKN can't delete it here — remove it in ${where} and it will drop off on the next sync.`,
      );
    }

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_events')
      .delete()
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, title')
      .maybeSingle();

    if (error) {
      console.warn('[mcp:deleteEvent]', error.message);
      return errorContent(`event delete failed: ${error.message}`);
    }
    if (!data) {
      return errorContent('No event found with that id (it may not exist or not belong to you).');
    }

    return jsonContent({
      ok: true,
      message: `Deleted "${data.title}" from your calendar.`,
      deleted_id: data.id,
    });
  },
};
