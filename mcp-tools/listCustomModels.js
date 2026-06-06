// ============================================================================
// mcp-tools/listCustomModels.js — list the custom models the user has built
// ============================================================================
// Read-only. Surfaces the user's Model Builder creations (lykn_custom_models)
// so the AI — in text chat or voice — can answer "what models have I made",
// "which of my models is published", "what's my main agent". Mirrors the same
// auth-gated table the Model Builder UI + custom-models-service use.
//
// Each row is reshaped to a compact envelope (id, name, status, base model,
// training mode, main-agent flag, belief/rule counts, timestamps). Defaults to
// most-recently-updated first so the user's current work sits at the top.

import { jsonContent, errorContent } from './index.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function countArray(v) {
  return Array.isArray(v) ? v.length : 0;
}

export const listCustomModelsTool = {
  name: 'lykn_listCustomModels',
  title: 'List the user\'s custom models',
  scope: 'read',
  description: [
    'Return the custom models the user has built in LYKN\'s Model Builder,',
    'most-recently-updated first. Call this whenever the user asks about',
    '"my models", "the models I made", "which model is published", "what\'s',
    'my main agent", or wants to pick / switch between their models.',
    '',
    'Each result includes id, name, purpose (what the model is for — its',
    'one-line description), status (draft|published), base_model_id,',
    'base_kind (standard|open_source), training_mode (prompt_only|lora|full),',
    'is_main_agent (the one model wired as their orchestrating agent, if any),',
    'belief_count + rule_count (how much the model was personalised), and',
    'created_at / updated_at / published_at.',
    '',
    'Use purpose to decide which model to hand a task to (see',
    'lykn_communicate_with_model).',
    '',
    'Status defaults to all of the user\'s models; pass status to narrow to',
    'just "published" or "draft".',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['draft', 'published', 'all'],
        description: 'Filter by status. Defaults to "all".',
      },
      query: {
        type: 'string',
        description: 'Optional case-insensitive substring filter against the model name.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max models to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const status = ['draft', 'published', 'all'].includes(args?.status) ? args.status : 'all';
    const rawQuery = typeof args?.query === 'string' ? args.query.trim() : '';
    const limit = Math.min(
      Math.max(Number.parseInt(args?.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    let q = ctx.supabaseAdmin
      .from('lykn_custom_models')
      .select('id, name, status, base_kind, base_model_id, training_mode, is_main_agent, beliefs, rules, metadata, created_at, updated_at, published_at')
      .eq('user_id', ctx.userId)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (status !== 'all') q = q.eq('status', status);
    if (rawQuery) {
      const safe = rawQuery.replace(/[,()]/g, ' ');
      q = q.ilike('name', `%${safe}%`);
    }

    const { data: rows, error } = await q;
    if (error) {
      return errorContent(`custom models list failed: ${error.message}`);
    }

    const models = (rows || []).map((m) => ({
      id: m.id,
      name: m.name,
      purpose: (typeof m.metadata?.description === 'string'
        ? m.metadata.description.trim().slice(0, 240)
        : '') || null,
      status: m.status,
      base_model_id: m.base_model_id,
      base_kind: m.base_kind,
      training_mode: m.training_mode,
      is_main_agent: m.is_main_agent === true,
      belief_count: countArray(m.beliefs),
      rule_count: countArray(m.rules),
      created_at: m.created_at,
      updated_at: m.updated_at,
      published_at: m.published_at,
    }));

    const publishedCount = models.filter((m) => m.status === 'published').length;
    const mainAgent = models.find((m) => m.is_main_agent) || null;

    return jsonContent({
      ok: true,
      count: models.length,
      published_count: publishedCount,
      main_agent: mainAgent ? { id: mainAgent.id, name: mainAgent.name } : null,
      filter: { status, query: rawQuery || null, limit },
      models,
      message: models.length
        ? null
        : (status === 'all'
          ? 'No custom models built yet. The user can create one in Model Builder.'
          : `No ${status} models.`),
    });
  },
};
