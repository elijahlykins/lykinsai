// ============================================================================
// mcp-tools/loadNeuron.js — hydrate a single neuron's FULL content into chat
// ============================================================================
// Read. lykn_findConnections (and lykn_searchVault) return SNIPPETS — enough
// for the model to decide which neurons are relevant, but not enough to
// actually quote / reason about / build on. This tool closes that loop:
// given a `node_id` from any other tool, return the FULL content of that
// neuron so the model can work with it as primary material.
//
// Why it's a separate tool (not "increase findConnections limit"):
//   Snippets-by-default keeps token cost low on cross-source search.
//   Loading a 5KB vault note's full body into context only makes sense
//   when the model has decided that specific note is the answer — making
//   the model opt in via a second call is the right cost model.
//
// node_id format mirrors lykn_findConnections + lykn_addProjectNeurons:
//   • belief_<uuid>   — durable principle row from lykn_beliefs
//   • fact_<uuid>     — atomic fact row from lykn_user_model_facts
//   • concept_<slug>  — named theme / topic / entity from lykn_concepts
//   • vault_<uuid>    — saved note / article / file from notes
//
// Per-kind payload shape — each returns the FULL row plus a `display`
// block the model can quote directly:
//   belief  → { id, text, serves_need, status, rationale, source,
//               proposed_by_clients, ratified_by, created_at }
//   fact    → { id, text, kind, status, reason, confidence,
//               source_id, created_at }
//   concept → { id, label, slug, kind, status, last_touched_at,
//               touch_count, related_concepts? }
//   vault   → { id, title, content, tags, folder, created_at,
//               updated_at, source }
//
// Vault content cap: 16KB. Bigger than the per-hop tool-result cap in
// chat-agent-loop.js (also 16KB) so the full note can fit when there
// isn't a parallel-tool-call competing for budget; smaller than the
// hard `notes.content` 120KB DB cap so we still send "use the link"
// if the note is huge.

import { jsonContent, errorContent } from './index.js';

const VAULT_CONTENT_CAP = 16000;
const FACT_QUERY_FIELDS = 'id, fact_text, fact_kind, status, reason, confidence, source_id, created_at, updated_at';

// Per-kind cap for batch loads via lykn_loadNeurons. When the batch tool
// calls into a vault row it tightens this cap so a 10-item bring-in
// doesn't blow the chat-agent-loop's 16KB tool-result envelope.
const VAULT_CONTENT_CAP_BATCH = 4000;

// Concept "related" lookup — pulls a small set of co-occurring concepts
// off the same user, capped at 8. Concepts are tiny rows so this is
// cheap; the model uses it to spot when the loaded concept is part of
// a richer theme cluster.
async function relatedConcepts(ctx, conceptId, limit = 8) {
  // Concept join tables live behind RPCs (migration 058) but we can
  // also just look at lykn_concept_links_for_user (migration 061) for
  // a simple sibling fetch. If neither exists, skip silently.
  try {
    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_concept_links_for_user')
      .select('related_concept_id, related_label, weight')
      .eq('user_id', ctx.userId)
      .eq('source_concept_id', conceptId)
      .order('weight', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    return data.map((d) => ({
      id: d.related_concept_id,
      label: d.related_label,
      weight: d.weight,
    }));
  } catch {
    return [];
  }
}

function maybeTruncate(text, cap) {
  const str = String(text || '');
  if (str.length <= cap) return { text: str, truncated: false };
  return {
    text: str.slice(0, cap),
    truncated: true,
    full_length: str.length,
  };
}

export const loadNeuronTool = {
  name: 'lykn_loadNeuron',
  title: 'Load a specific neuron\'s full content into the chat',
  scope: 'read',
  description: [
    'Hydrate a SPECIFIC neuron\'s full content into the conversation, given',
    'its node_id from lykn_findConnections, lykn_searchVault, or anywhere',
    'else a node_id appears. Returns the COMPLETE body (not a snippet) so',
    'you can quote, summarise, build on, or reason about the neuron as',
    'primary source material.',
    '',
    'TYPICAL FLOW:',
    '  1. findConnections({ query }) → see snippets across stores',
    '  2. pick the most relevant node_id from the result',
    '  3. loadNeuron({ node_id }) → get the full body to actually use',
    '',
    'WHEN TO CALL:',
    '  • The user asks "what did I save about X?" and findConnections',
    '    returned a vault snippet — load the full note so you can quote',
    '    accurately instead of paraphrasing the snippet.',
    '  • The user references one of their own beliefs / facts and the',
    '    rationale matters ("why do I think X?") — load the belief to',
    '    surface its rationale + provenance.',
    '  • You\'re about to addProjectNeurons and want to confirm the',
    '    neuron is the right one — load it, sanity check the body,',
    '    then cluster.',
    '',
    'WHEN NOT TO CALL:',
    '  • The snippet from findConnections is already enough — don\'t pay',
    '    the extra tokens to hydrate the full body if you don\'t need it.',
    '  • You only want a list of related items → use findConnections.',
    '  • You want EVERY belief / EVERY fact → use lykn_getBeliefs /',
    '    lykn_getFacts (scoped list tools).',
    '',
    'NODE_ID FORMAT (same shape lykn_findConnections returns):',
    '  • belief_<uuid>   — a durable principle from the user\'s beliefs',
    '  • fact_<uuid>     — an atomic fact from the user\'s synthesis profile',
    '  • concept_<slug>  — a named theme / topic / entity',
    '  • vault_<uuid>    — a saved note / article / file from the vault',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        description: 'Stable neuron id from findConnections / searchVault output. Prefixed: belief_<uuid> | fact_<uuid> | concept_<slug> | vault_<uuid>.',
      },
    },
    required: ['node_id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const nodeIdRaw = typeof args?.node_id === 'string' ? args.node_id.trim() : '';
    if (!nodeIdRaw) return errorContent('node_id is required.');
    const result = await loadNeuronById(nodeIdRaw, ctx, { vaultCap: VAULT_CONTENT_CAP });
    if (result?.__error) return errorContent(result.__error);
    return jsonContent(result);
  },
};

// ---------------------------------------------------------------------------
// Shared per-id loader — used by both lykn_loadNeuron (single) and
// lykn_loadNeurons (batch). Returns the bare payload object (NOT wrapped
// in jsonContent) so the batch tool can collect many results into a
// single response array. On hard failures (DB error) returns
// `{ __error: '<msg>' }` so the caller can decide whether to surface the
// failure for THIS id or stop the whole batch.
// ---------------------------------------------------------------------------

export async function loadNeuronById(nodeIdRaw, ctx, options = {}) {
  const vaultCap = Number.isFinite(options.vaultCap) ? options.vaultCap : VAULT_CONTENT_CAP;

  // ── Belief ────────────────────────────────────────────────────
  if (nodeIdRaw.startsWith('belief_')) {
    const id = nodeIdRaw.slice('belief_'.length);
    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_beliefs')
      .select('id, belief_text, serves_need, status, confidence, rationale, source, proposed_by_clients, ratified_by, ratified_at, created_at, updated_at')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) return { __error: `belief load failed: ${error.message}` };
    if (!data) {
      return { ok: false, reason: 'not_found', node_id: nodeIdRaw, message: 'That belief id is not in the user\'s synthesis layer.' };
    }
    return {
      ok: true,
      kind: 'belief',
      node_id: nodeIdRaw,
      display: `Belief: "${data.belief_text}"${data.rationale ? `\nRationale: ${data.rationale}` : ''}`,
      belief: {
        id: data.id,
        text: data.belief_text,
        serves_need: data.serves_need,
        status: data.status,
        confidence: data.confidence,
        rationale: data.rationale,
        source: data.source,
        proposed_by_clients: data.proposed_by_clients || [],
        ratified_by: data.ratified_by,
        ratified_at: data.ratified_at,
        created_at: data.created_at,
        updated_at: data.updated_at,
      },
    };
  }

  // ── Fact ──────────────────────────────────────────────────────
  if (nodeIdRaw.startsWith('fact_')) {
    const id = nodeIdRaw.slice('fact_'.length);
    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_user_model_facts')
      .select(FACT_QUERY_FIELDS)
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) return { __error: `fact load failed: ${error.message}` };
    if (!data) {
      return { ok: false, reason: 'not_found', node_id: nodeIdRaw, message: 'That fact id is not in the user\'s synthesis profile.' };
    }
    return {
      ok: true,
      kind: 'fact',
      node_id: nodeIdRaw,
      display: `Fact (${data.fact_kind || 'identity'}): "${data.fact_text}"${data.reason ? `\nReason: ${data.reason}` : ''}`,
      fact: {
        id: data.id,
        text: data.fact_text,
        kind: data.fact_kind,
        status: data.status,
        confidence: data.confidence,
        reason: data.reason,
        source_id: data.source_id,
        created_at: data.created_at,
        updated_at: data.updated_at,
      },
    };
  }

  // ── Concept ───────────────────────────────────────────────────
  if (nodeIdRaw.startsWith('concept_')) {
    const slug = nodeIdRaw.slice('concept_'.length);
    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_concepts')
      .select('id, label, slug, kind, status, first_seen_at, last_touched_at, created_at')
      .eq('user_id', ctx.userId)
      .eq('slug', slug)
      .maybeSingle();
    if (error) return { __error: `concept load failed: ${error.message}` };
    if (!data) {
      return { ok: false, reason: 'not_found', node_id: nodeIdRaw, message: 'That concept slug is not in the user\'s synthesis layer.' };
    }
    const related = await relatedConcepts(ctx, data.id);
    const touchedAgeDays = data.last_touched_at
      ? Math.floor((Date.now() - new Date(data.last_touched_at).getTime()) / 86_400_000)
      : null;
    const recency = touchedAgeDays === null
      ? ''
      : touchedAgeDays <= 1
        ? ' — touched today'
        : ` — last touched ${touchedAgeDays}d ago`;
    return {
      ok: true,
      kind: 'concept',
      node_id: nodeIdRaw,
      display: `Concept (${data.kind || 'topic'}): "${data.label}"${recency}.`,
      concept: {
        id: data.id,
        label: data.label,
        slug: data.slug,
        kind: data.kind,
        status: data.status,
        first_seen_at: data.first_seen_at,
        last_touched_at: data.last_touched_at,
        related_concepts: related,
      },
    };
  }

  // ── Vault note ────────────────────────────────────────────────
  if (nodeIdRaw.startsWith('vault_')) {
    const id = nodeIdRaw.slice('vault_'.length);
    const { data, error } = await ctx.supabaseAdmin
      .from('notes')
      .select('id, title, content, tags, folder, source, created_at, updated_at')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) return { __error: `vault note load failed: ${error.message}` };
    if (!data) {
      return { ok: false, reason: 'not_found', node_id: nodeIdRaw, message: 'That vault note id is not in the user\'s vault.' };
    }
    const body = maybeTruncate(data.content, vaultCap);
    return {
      ok: true,
      kind: 'vault',
      node_id: nodeIdRaw,
      display: `Vault note: "${data.title || '(untitled)'}"\n\n${body.text}${body.truncated ? `\n\n[truncated — full note is ${body.full_length} chars; open ${`/vault?note=${data.id}`} for the rest]` : ''}`,
      note: {
        id: data.id,
        title: data.title,
        content: body.text,
        truncated: body.truncated,
        full_length: body.truncated ? body.full_length : body.text.length,
        tags: data.tags || [],
        folder: data.folder,
        source: data.source,
        created_at: data.created_at,
        updated_at: data.updated_at,
        url: `/vault?note=${encodeURIComponent(data.id)}`,
      },
    };
  }

  return {
    ok: false,
    reason: 'unrecognised_node_id',
    node_id: nodeIdRaw,
    message: 'node_id must be prefixed with belief_, fact_, concept_, or vault_.',
  };
}

export { VAULT_CONTENT_CAP_BATCH };
