// ============================================================================
// mcp-tools/listStewardItems.js — read Night Shift queue for a project
// ============================================================================

import { jsonContent, errorContent } from './index.js';

export const listStewardItemsTool = {
  name: 'lykn_listStewardItems',
  title: 'List Night Shift steward queue items',
  scope: 'read',
  description: [
    'Return Night Shift queue items for a project (backlog → ready → scheduled → done).',
    'Use when the user asks what is queued overnight, what Night Shift prepared,',
    'or what needs approval before running tonight.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Project UUID. Omit to use active project.',
      },
      status: {
        type: 'string',
        enum: ['backlog', 'ready', 'scheduled', 'running', 'done', 'blocked', 'cancelled'],
        description: 'Optional filter by status.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Max rows (default 20).' },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    let projectId = args.project_id ? String(args.project_id).trim() : null;
    if (!projectId) {
      const { data: prof } = await ctx.supabaseAdmin
        .from('lykn_user_synthesis_profile')
        .select('active_project_id')
        .eq('user_id', ctx.userId)
        .maybeSingle();
      projectId = prof?.active_project_id || null;
    }
    if (!projectId) return errorContent('project_id required or set an active project.');

    const limit = Math.min(40, Math.max(1, Number(args.limit) || 20));
    let q = ctx.supabaseAdmin
      .from('lykn_steward_items')
      .select('id, title, spec, status, result_summary, blocked_reason, approved_at, created_at, updated_at, completed_at, source, execution_kind, repo, sub_model_id, cursor_build_id, sub_model_task_id')
      .eq('user_id', ctx.userId)
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (args.status) q = q.eq('status', String(args.status));
    const { data, error } = await q;
    if (error) return errorContent(`steward list failed: ${error.message}`);

    return jsonContent({ ok: true, project_id: projectId, items: data || [] });
  },
};
