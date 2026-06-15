// ============================================================================
// mcp-tools/getProjectState.js — read the current state of a project
// ============================================================================
// Read-only. Returns the latest non-superseded value at every state_key
// of the requested project, plus the project header. The companion to
// pushProjectState — together they form a per-project kv-store that
// outside AI clients can sync against.
//
// Default behaviour: if no project_id is passed, return the user's
// ACTIVE project (whatever lykn_setActiveProject most recently
// stamped on the synthesis profile). This matches getContextBlock —
// "what's the current working context?" is the natural question, so
// make that the default answer.
//
// Returned shape is intentionally compact (key → value map) rather
// than the row-shaped result the underlying table holds. Clients
// almost always want "give me the current truth," not "show me the
// history" — and rendering 12 keys as a flat object reads cleanly in
// the model's context window.

import { jsonContent, errorContent } from './index.js';
import { resolveWriteProjectTarget } from '../lib/projectWriteTarget.js';

const STATE_LIMIT = 50;

export const getProjectStateTool = {
  name: 'lykn_getProjectState',
  title: 'Get the current state of a LYKN project',
  scope: 'read',
  description: [
    'Return the LYKN user\'s current project context — every state_key',
    'and its latest value, the project header (name, description, last',
    'activity), PLUS the open to-dos and upcoming calendar events filed',
    'under this project (so you can answer "what\'s on the X project" and',
    'reason about its deadlines directly). Defaults to the user\'s active',
    'project so most callers can omit project_id entirely.',
    '',
    'CALL THIS at the start of any conversation that touches the user\'s',
    'active work. The answer is what other AI clients already know about',
    'this project — picking up from there avoids re-litigating decisions',
    'and keeps you in sync with what Claude Desktop / Cursor / Claude',
    'Code agreed on yesterday.',
    '',
    'Read pattern: this is cheap and idempotent. Calling it twice in a',
    'turn is fine. Prefer it over searching the vault when the question',
    'is "what\'s our current take on X in this project?" — vault notes',
    'are long-form, project state is the synthesised current truth.',
    '',
    'If there is no active project (the user hasn\'t worked on anything',
    'recently, or this is a brand-new account), this returns ok=true',
    'with project=null. Don\'t treat that as an error — just don\'t lean',
    'on project context for the rest of the conversation.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Optional UUID. Omit to read the user\'s active project.',
      },
      include_history: {
        type: 'boolean',
        description: 'If true, include the previous (superseded) value at each key. Defaults to false; flip on only when you need to reason about how a state changed.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const includeHistory = Boolean(args?.include_history);

    const explicitId = args?.project_id ? String(args.project_id).trim() : null;
    const { project, resolvedBy } = await resolveWriteProjectTarget(ctx, explicitId);

    if (!project) {
      return jsonContent({
        ok: true,
        project: null,
        state: {},
        message:
          'No writable project in scope. User-created projects live in the LYKN synthesis layer (+ → Create project). Custom-model chats bind to linked_project_id automatically.',
      });
    }
    const projectId = project.id;

    // Latest non-superseded rows at each state_key. Capped at
    // STATE_LIMIT so a project that grows pathologically doesn't blow
    // up the model's context window. If a user runs out of space,
    // they're using projects wrong (long-form notes go in the vault).
    const { data: rows, error: rowsErr } = await ctx.supabaseAdmin
      .from('lykn_project_state')
      .select('state_key, state_value, set_by_client, created_at, reason')
      .eq('user_id', ctx.userId)
      .eq('project_id', projectId)
      .is('superseded_at', null)
      .order('created_at', { ascending: false })
      .limit(STATE_LIMIT);
    if (rowsErr) {
      return errorContent(`state read failed: ${rowsErr.message}`);
    }

    const state = {};
    for (const row of rows || []) {
      // Order by created_at DESC means the first row we see at each
      // key is the latest — but with the partial index on
      // superseded_at IS NULL, every row IS the latest by definition,
      // so duplicates shouldn't happen. Keep the dedup as a defensive
      // belt-and-braces in case a race between supersede + insert ever
      // briefly orphans two rows.
      if (!(row.state_key in state)) {
        state[row.state_key] = {
          value: row.state_value,
          set_by_client: row.set_by_client,
          set_at: row.created_at,
          reason: row.reason,
        };
      }
    }

    // Surface the tasks and calendar events filed under this project so the
    // model can answer "what's on the X project" and reason about deadlines
    // without a separate listTodos/listEvents round-trip. Kept compact.
    const nowIso = new Date().toISOString();
    const [todosRes, eventsRes] = await Promise.all([
      ctx.supabaseAdmin
        .from('lykn_todos')
        .select('id, title, status, priority, due_at, due_at_text')
        .eq('user_id', ctx.userId)
        .eq('project_id', projectId)
        .eq('status', 'open')
        .order('due_at', { ascending: true, nullsFirst: false })
        .limit(25),
      ctx.supabaseAdmin
        .from('lykn_events')
        .select('id, title, starts_at, ends_at, all_day, location, status')
        .eq('user_id', ctx.userId)
        .eq('project_id', projectId)
        .neq('status', 'cancelled')
        .gte('starts_at', nowIso)
        .order('starts_at', { ascending: true })
        .limit(25),
    ]);

    const now = Date.now();
    const todos = (todosRes?.data || []).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      due_at: t.due_at,
      due_at_text: t.due_at_text,
      overdue: t.due_at != null && Date.parse(t.due_at) <= now,
    }));
    const events = (eventsRes?.data || []).map((e) => ({
      id: e.id,
      title: e.title,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      all_day: e.all_day,
      location: e.location,
      status: e.status,
    }));

    let history = null;
    if (includeHistory && Object.keys(state).length) {
      const keys = Object.keys(state);
      const { data: histRows, error: histErr } = await ctx.supabaseAdmin
        .from('lykn_project_state')
        .select('state_key, state_value, set_by_client, created_at, superseded_at')
        .eq('user_id', ctx.userId)
        .eq('project_id', projectId)
        .in('state_key', keys)
        .not('superseded_at', 'is', null)
        .order('created_at', { ascending: false })
        .limit(STATE_LIMIT * 2);
      if (!histErr && Array.isArray(histRows)) {
        history = {};
        for (const row of histRows) {
          if (!history[row.state_key]) history[row.state_key] = [];
          history[row.state_key].push({
            value: row.state_value,
            set_by_client: row.set_by_client,
            set_at: row.created_at,
            superseded_at: row.superseded_at,
          });
        }
      }
    }

    return jsonContent({
      ok: true,
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        created_by_client: project.created_by_client,
        last_active_at: project.last_active_at,
      },
      state,
      todos,
      events,
      ...(history ? { history } : {}),
      keys_count: Object.keys(state).length,
      todos_count: todos.length,
      events_count: events.length,
    });
  },
};
