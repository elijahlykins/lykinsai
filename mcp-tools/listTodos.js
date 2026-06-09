// ============================================================================
// mcp-tools/listTodos.js — read the user's to-do list (chat/voice)
// ============================================================================
// Read-only. Backs "what's on my todo list", "what do I have to do", "what's
// on my plate", "what's overdue on my list". Defaults to OPEN to-dos so the
// model gets the signal-dense view; pass status to inspect completed/cancelled
// history.
//
// Ordering puts high-priority and soonest-due items first. Each row carries an
// `overdue` flag (due_at is in the past but still open) and the user's original
// `due_at_text`. Returned ids are what lykn_updateTodo / lykn_deleteTodo
// consume to complete / edit / remove a task.

import { jsonContent, errorContent } from './index.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

export const listTodosTool = {
  name: 'lykn_listTodos',
  title: 'List the user\'s to-dos',
  scope: 'read',
  description: [
    'Return the user\'s to-do list. Call this when they ask "what\'s on my todo',
    'list", "what do I have to do", "what\'s on my plate", "what\'s overdue", or',
    'before completing / editing / deleting a task so you have its id.',
    '',
    'Defaults to OPEN to-dos, highest-priority and soonest-due first. Each',
    'result includes id, title, notes, status, priority, due_at (ISO, may be',
    'null), due_at_text (the user\'s phrasing — prefer reading this back), and',
    '`overdue` (true when due_at is in the past but still open). To act on one,',
    'pass its id to lykn_updateTodo or lykn_deleteTodo.',
    '',
    'When reading results back in conversation, summarise naturally — do not',
    'recite ISO timestamps; use due_at_text or friendly relative phrasing.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['open', 'completed', 'cancelled', 'all'],
        description: 'Which to-dos to return. Defaults to "open".',
      },
      due_only: {
        type: 'boolean',
        description: 'When true, return only OPEN to-dos that have a due date already in the past (overdue).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max to-dos to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
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
      ? 'open'
      : (['open', 'completed', 'cancelled', 'all'].includes(args?.status) ? args.status : 'open');
    const limit = Math.min(
      Math.max(Number.parseInt(args?.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const nowIso = new Date().toISOString();

    let q = ctx.supabaseAdmin
      .from('lykn_todos')
      .select('id, title, notes, status, priority, due_at, due_at_text, position, project_id, created_at, completed_at')
      .eq('user_id', ctx.userId)
      .limit(limit);

    if (status !== 'all') q = q.eq('status', status);
    if (dueOnly) q = q.not('due_at', 'is', null).lte('due_at', nowIso);

    // Fetch newest-first from the DB, then sort in JS so the open view leads
    // with priority + soonest due (nulls last) while history stays recent-first.
    q = q.order('created_at', { ascending: false });

    const { data: rows, error } = await q;
    if (error) {
      return errorContent(`todos list failed: ${error.message}`);
    }

    const now = Date.now();
    let todos = (rows || []).map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes,
      status: t.status,
      priority: t.priority,
      due_at: t.due_at,
      due_at_text: t.due_at_text,
      position: t.position,
      project_id: t.project_id,
      overdue: t.status === 'open' && t.due_at != null && Date.parse(t.due_at) <= now,
      created_at: t.created_at,
      completed_at: t.completed_at,
    }));

    if (status === 'open') {
      todos = todos.sort((a, b) => {
        // Manual position first when set.
        const pa = a.position == null ? Infinity : a.position;
        const pb = b.position == null ? Infinity : b.position;
        if (pa !== pb) return pa - pb;
        // Then priority (high → low).
        const ra = PRIORITY_RANK[a.priority] ?? 1;
        const rb = PRIORITY_RANK[b.priority] ?? 1;
        if (ra !== rb) return ra - rb;
        // Then soonest due (no due date sinks to the bottom).
        const da = a.due_at ? Date.parse(a.due_at) : Infinity;
        const db = b.due_at ? Date.parse(b.due_at) : Infinity;
        if (da !== db) return da - db;
        // Stable-ish fallback: most recently created first.
        return String(b.created_at).localeCompare(String(a.created_at));
      });
    }

    return jsonContent({
      ok: true,
      count: todos.length,
      filter: { status, due_only: dueOnly, limit },
      todos,
      message: todos.length
        ? null
        : (status === 'open'
          ? 'Nothing on the to-do list right now.'
          : 'No to-dos matched that filter.'),
    });
  },
};
