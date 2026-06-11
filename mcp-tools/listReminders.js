// ============================================================================
// mcp-tools/listReminders.js — read the user's reminders (chat/voice)
// ============================================================================
// Read-only. Backs "what are my reminders / what do I have coming up / what's
// overdue". Defaults to PENDING reminders soonest-first so the model gets the
// signal-dense view; pass status to inspect completed/cancelled history.
//
// Each row carries an `overdue` flag (remind_at is in the past but still
// pending) and the user's original `remind_at_text` so the model can read it
// back naturally. Returned ids are what lykn_updateReminder consumes to
// complete / cancel / reschedule.

import { jsonContent, errorContent } from './index.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const listRemindersTool = {
  name: 'lykn_listReminders',
  title: 'List the user\'s reminders',
  scope: 'read',
  description: [
    'Return the user\'s reminders. Call this when they ask "what are my',
    'reminders", "what do I have coming up", "what\'s overdue", "did I set a',
    'reminder about X", or before completing/cancelling one so you have its id.',
    '',
    'Defaults to PENDING reminders, soonest-first. Each result includes id,',
    'title, body, remind_at (ISO), remind_at_text (the user\'s phrasing —',
    'prefer reading this back), status, `overdue` (true when remind_at is',
    'in the past but still pending), and `overdue_days` (how many whole days',
    'past due — 0 if due today or upcoming). To act on one, pass its id to',
    'lykn_updateReminder.',
    '',
    'Reminders are point-in-time, so a reminder overdue by several days is',
    'usually stale: do NOT proactively present long-overdue reminders (e.g.',
    'overdue_days >= 2) as current or time-sensitive unless the user explicitly',
    'asks what is overdue or about old reminders. Lead with reminders due today',
    'or coming up.',
    '',
    'When reading results back in conversation, summarise naturally — do not',
    'recite ISO timestamps; use remind_at_text or a friendly relative phrasing.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'completed', 'cancelled', 'all'],
        description: 'Which reminders to return. Defaults to "pending".',
      },
      due_only: {
        type: 'boolean',
        description: 'When true, return only reminders that are already due (remind_at <= now). Implies pending.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max reminders to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const dueOnly = args?.due_only === true;
    const status = dueOnly
      ? 'pending'
      : (['pending', 'completed', 'cancelled', 'all'].includes(args?.status) ? args.status : 'pending');
    const limit = Math.min(
      Math.max(Number.parseInt(args?.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const nowIso = new Date().toISOString();

    let q = ctx.supabaseAdmin
      .from('lykn_reminders')
      .select('id, title, body, remind_at, remind_at_text, status, project_id, created_at, completed_at')
      .eq('user_id', ctx.userId)
      .limit(limit);

    if (status !== 'all') q = q.eq('status', status);
    if (dueOnly) q = q.lte('remind_at', nowIso);

    // Pending: soonest first (next thing to act on at the top). History:
    // most-recent first.
    q = status === 'pending'
      ? q.order('remind_at', { ascending: true })
      : q.order('remind_at', { ascending: false });

    const { data: rows, error } = await q;
    if (error) {
      return errorContent(`reminders list failed: ${error.message}`);
    }

    const now = Date.now();
    const reminders = (rows || []).map((r) => {
      const remindMs = Date.parse(r.remind_at);
      const overdue = r.status === 'pending' && remindMs <= now;
      const overdueDays = overdue && Number.isFinite(remindMs)
        ? Math.floor((now - remindMs) / 86_400_000)
        : 0;
      return {
        id: r.id,
        title: r.title,
        body: r.body,
        remind_at: r.remind_at,
        remind_at_text: r.remind_at_text,
        status: r.status,
        project_id: r.project_id,
        overdue,
        overdue_days: overdueDays,
        created_at: r.created_at,
        completed_at: r.completed_at,
      };
    });

    return jsonContent({
      ok: true,
      count: reminders.length,
      filter: { status, due_only: dueOnly, limit },
      reminders,
      message: reminders.length
        ? null
        : (status === 'pending'
          ? 'No pending reminders.'
          : 'No reminders matched that filter.'),
    });
  },
};
