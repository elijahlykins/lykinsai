// ============================================================================
// mcp-tools/listEvents.js — read the user's calendar events (chat/voice)
// ============================================================================
// Read-only. Backs "what's on my calendar", "what do I have Friday", "am I
// free Tuesday afternoon", "what's next week look like". Returns events in a
// time window, earliest-first, so the model gets a chronological agenda.
//
// Windowing: pass an explicit `from`/`to` ISO range, OR `days_ahead` (a
// look-ahead from now). Default window is now → +14 days. Cancelled events
// are excluded unless status is set explicitly. Returned ids are what
// lykn_updateEvent / lykn_deleteEvent consume.

import { jsonContent, errorContent } from './index.js';

const DEFAULT_DAYS_AHEAD = 14;
const MAX_DAYS_AHEAD = 366;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;

export const listEventsTool = {
  name: 'lykn_listEvents',
  title: 'List the user\'s calendar events',
  scope: 'read',
  description: [
    'Return the user\'s calendar events in a time window, earliest-first. Call',
    'this for "what\'s on my calendar", "what do I have Friday", "what does next',
    'week look like", "am I free Tuesday afternoon", or before editing/deleting',
    'an event so you have its id.',
    '',
    'Windowing — provide ONE of:',
    '  • from + to   — explicit ISO 8601 range (e.g. a single day, a week).',
    '  • days_ahead  — look-ahead from now in days (e.g. 1 = today/tomorrow,',
    '                  7 = the week). Defaults to 14 days.',
    'Pass include_past:true to also return events that already started in the',
    'window (default keeps the window\'s natural bounds).',
    '',
    'Each result includes id, title, description, starts_at (ISO), ends_at,',
    'all_day, location, timezone, color, status, and external_provider/read_only.',
    'To act on one, pass its id to lykn_updateEvent or lykn_deleteEvent. Rows',
    'with read_only:true are synced in from the user\'s Google/Apple calendar',
    '(external_provider tells you which) — they CANNOT be edited or deleted in',
    'LYKN; the user must change those in the source app. When reading results',
    'back, speak natural local times ("Thursday at noon"), never raw ISO',
    'timestamps.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description: 'Window start as ISO 8601 (e.g. "2026-06-11T00:00:00-06:00"). Pair with `to`.',
      },
      to: {
        type: 'string',
        description: 'Window end as ISO 8601. Pair with `from`.',
      },
      days_ahead: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_DAYS_AHEAD,
        description: `Look-ahead from now, in days (1-${MAX_DAYS_AHEAD}). Used when from/to are not given. Defaults to ${DEFAULT_DAYS_AHEAD}.`,
      },
      status: {
        type: 'string',
        enum: ['confirmed', 'tentative', 'cancelled', 'all'],
        description: 'Filter by status. Defaults to confirmed+tentative (cancelled excluded).',
      },
      project_id: {
        type: 'string',
        description: 'Optional. When set, return only events filed under this project (UUID from lykn_listProjects). Use for "what\'s on the calendar for my <project>".',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max events to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const limit = Math.min(
      Math.max(Number.parseInt(args?.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    // Resolve the window: explicit from/to wins, else days_ahead from now.
    let fromIso;
    let toIso;
    const hasFrom = typeof args?.from === 'string' && args.from.trim();
    const hasTo = typeof args?.to === 'string' && args.to.trim();
    if (hasFrom || hasTo) {
      if (hasFrom) {
        const f = new Date(args.from.trim());
        if (Number.isNaN(f.getTime())) return errorContent('`from` is not a valid ISO 8601 timestamp.');
        fromIso = f.toISOString();
      }
      if (hasTo) {
        const t = new Date(args.to.trim());
        if (Number.isNaN(t.getTime())) return errorContent('`to` is not a valid ISO 8601 timestamp.');
        toIso = t.toISOString();
      }
    } else {
      const days = Math.min(
        Math.max(Number.parseInt(args?.days_ahead, 10) || DEFAULT_DAYS_AHEAD, 1),
        MAX_DAYS_AHEAD,
      );
      fromIso = new Date().toISOString();
      toIso = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    const status = ['confirmed', 'tentative', 'cancelled', 'all'].includes(args?.status)
      ? args.status
      : 'active';

    let q = ctx.supabaseAdmin
      .from('lykn_events')
      .select('id, title, description, starts_at, ends_at, all_day, location, timezone, color, status, project_id, external_provider, read_only, created_at')
      .eq('user_id', ctx.userId)
      .order('starts_at', { ascending: true })
      .limit(limit);

    // Range filter against starts_at (the grid anchor). An event that begins
    // within the window is in scope.
    if (fromIso) q = q.gte('starts_at', fromIso);
    if (toIso) q = q.lte('starts_at', toIso);

    const projectFilter = typeof args?.project_id === 'string' && args.project_id.trim()
      ? args.project_id.trim()
      : null;
    if (projectFilter) q = q.eq('project_id', projectFilter);

    if (status === 'all') {
      // no status filter
    } else if (status === 'active') {
      q = q.neq('status', 'cancelled');
    } else {
      q = q.eq('status', status);
    }

    const { data: rows, error } = await q;
    if (error) {
      return errorContent(`events list failed: ${error.message}`);
    }

    const events = rows || [];

    // Resolve project names so the model can see which project each event is
    // filed under without a separate lykn_listProjects call.
    const projectIds = [...new Set(events.map((e) => e.project_id).filter(Boolean))];
    if (projectIds.length) {
      const { data: projRows } = await ctx.supabaseAdmin
        .from('lykn_projects')
        .select('id, name')
        .eq('user_id', ctx.userId)
        .in('id', projectIds);
      const nameById = new Map((projRows || []).map((p) => [p.id, p.name]));
      for (const e of events) {
        e.project_name = e.project_id ? (nameById.get(e.project_id) || null) : null;
      }
    } else {
      for (const e of events) e.project_name = null;
    }

    return jsonContent({
      ok: true,
      count: events.length,
      window: { from: fromIso || null, to: toIso || null, status, project_id: projectFilter },
      events,
      message: events.length ? null : 'No events in that window.',
    });
  },
};
