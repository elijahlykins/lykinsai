// ============================================================================
// mcp-tools/updateStewardItem.js — approve / schedule / cancel queue items
// ============================================================================

import { jsonContent, errorContent } from './index.js';

const ALLOWED = new Set(['backlog', 'ready', 'scheduled', 'cancelled']);

export const updateStewardItemTool = {
  name: 'lykn_updateStewardItem',
  title: 'Update a Night Shift queue item',
  scope: 'write',
  description: [
    'Move a Night Shift steward item between user-controlled states.',
    '',
    'Common flows:',
    '  • ready → scheduled (user approved spec — runs next Night Shift cron)',
    '  • ready → backlog (user rejected spec)',
    '  • any → cancelled',
    '',
    'Do NOT set running/done/blocked — the cron owns those.',
    'ASK before scheduling unless the user explicitly said "run it tonight".',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Steward item UUID from lykn_listStewardItems.' },
      status: {
        type: 'string',
        enum: [...ALLOWED],
      },
      spec: { type: 'string', description: 'Optional edited spec (<=4000 chars).' },
      execution_kind: {
        type: 'string',
        enum: ['research', 'code', 'agent'],
        description: 'How Night Shift runs this when scheduled (delegate tier).',
      },
      repo: { type: 'string', description: 'Target repo for code tasks (github.com/org/repo).' },
      sub_model_id: { type: 'string', description: 'Optional sub-agent UUID for agent tasks.' },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const id = String(args.id || '').trim();
    const status = String(args.status || '').trim();
    if (!id) return errorContent('id is required.');
    if (!ALLOWED.has(status)) return errorContent(`status must be one of: ${[...ALLOWED].join(', ')}`);

    const patch = { status };
    if (args.spec != null) patch.spec = String(args.spec).trim().slice(0, 4000);
    if (args.execution_kind != null) {
      const kind = String(args.execution_kind).trim();
      if (kind === 'research' || kind === 'code' || kind === 'agent') patch.execution_kind = kind;
    }
    if (args.repo != null) patch.repo = String(args.repo).trim().slice(0, 500) || null;
    if (args.sub_model_id != null) {
      const sid = String(args.sub_model_id).trim();
      patch.sub_model_id = sid || null;
    }
    if (status === 'scheduled') patch.approved_at = new Date().toISOString();

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_steward_items')
      .update(patch)
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, title, spec, status, approved_at, updated_at, execution_kind, repo, sub_model_id')
      .maybeSingle();
    if (error) return errorContent(`steward update failed: ${error.message}`);
    if (!data) return errorContent('Item not found.');

    return jsonContent({ ok: true, item: data });
  },
};
