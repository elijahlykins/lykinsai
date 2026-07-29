// ============================================================================
// mcp-tools/findConnections.js — cross-source related-neuron search
// ============================================================================
// Read-only. The synthesis layer has several "neuron" stores (beliefs,
// facts, concepts, vault notes). Most search tools target ONE store at a
// time (lykn_searchVault for notes, lykn_getBeliefs / lykn_getFacts for
// the relevant scoped slice). This tool is the cross-source surface:
// given a free-text query OR a starter `node_id`, return the closest
// related neurons from EVERY store, interleaved, so the calling AI can
// reason about "what does the user already think / know about X?"
//
// Why it exists:
//   • The in-app chat agent loop and outside AI clients both need a
//     single call that maps a topic ("design tooling", "Q1 plans",
//     "Notion automation") onto the user's portable knowledge base
//     WITHOUT having to know which store to look in. Three separate
//     calls is friction.
//   • lykn_addProjectNeurons takes node_ids of the shape
//     `belief_<uuid>` / `fact_<uuid>` / `concept_<slug>` / `vault_<uuid>`
//     — exactly the ids this tool returns. So a common pattern becomes:
//        findConnections({ query: "X" }) → pick top N → addProjectNeurons.
//
// Search strategy (deliberately dumb on purpose):
//   • Beliefs (active + proposed):  ilike on belief_text + rationale
//   • Facts (active):               ilike on fact_text + reason
//   • Concepts (active + proposed): ilike on label
//   • Vault notes:                  hybrid BM25 + semantic (same engine as
//                                   lykn_searchVault) — ilike only as fallback
//
// Beliefs/facts/concepts stay lexical for determinism + cost. Vault uses
// the shared hybrid retriever so large vaults don't silently miss.
//
// Ordering: each store contributes up to `per_kind_limit` rows, sorted
// by recency within its store. The merged response is bucketed by kind
// in the order [belief, fact, concept, vault] so the highest-signal
// stuff (governance > observation > theme > raw note) reads first.

import { jsonContent, errorContent } from './content.js';
import { retrieveVaultHybridHits } from '../lib/rag/vaultHybrid.js';

const MAX_QUERY_LEN = 200;
const DEFAULT_PER_KIND_LIMIT = 5;
const MAX_PER_KIND_LIMIT = 15;
const ALL_KINDS = ['belief', 'fact', 'concept', 'vault'];
const KIND_SET = new Set(ALL_KINDS);

function snippet(text, query, max = 200) {
  const str = String(text || '');
  if (!query) return str.slice(0, max);
  const idx = str.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return str.slice(0, max);
  const start = Math.max(0, idx - 50);
  const end = Math.min(str.length, idx + query.length + 150);
  return (start > 0 ? '…' : '') + str.slice(start, end) + (end < str.length ? '…' : '');
}

function escapeLike(s) {
  // Two layers of escaping:
  //   1. `,` `(` `)` are PostgREST `.or()` logic-tree delimiters. A raw comma
  //      in the query (e.g. "Greg, Mark models") splits the filter mid-value
  //      and throws "failed to parse logic tree". Neutralise to spaces so the
  //      same pattern is safe in both `.or(...)` and single-column `.ilike()`.
  //   2. `%` `_` are SQL LIKE wildcards — escape so they match literally.
  return String(s)
    .replace(/[,()]/g, ' ')
    .replace(/[%_]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// node_id resolver. addProjectNeurons emits ids like belief_<uuid>,
// fact_<uuid>, concept_<slug>, vault_<uuid>. When the caller passes
// `node_id`, we look up that source row and seed the search query from
// its text — so "what's related to belief_abc?" becomes a substring
// search over the other stores using the belief's text as the query.
// ---------------------------------------------------------------------------

async function resolveNodeIdToQuery(ctx, nodeId) {
  if (!nodeId || typeof nodeId !== 'string') return null;
  const trimmed = nodeId.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('belief_')) {
    const id = trimmed.slice('belief_'.length);
    const { data } = await ctx.supabaseAdmin
      .from('lykn_beliefs')
      .select('belief_text')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    return data?.belief_text ? { query: data.belief_text, seedKind: 'belief' } : null;
  }
  if (trimmed.startsWith('fact_')) {
    const id = trimmed.slice('fact_'.length);
    const { data } = await ctx.supabaseAdmin
      .from('lykn_user_model_facts')
      .select('fact_text')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    return data?.fact_text ? { query: data.fact_text, seedKind: 'fact' } : null;
  }
  if (trimmed.startsWith('concept_')) {
    // concept ids the rest of the system uses are slugs, so we hit by
    // slug not uuid. If the caller has the slug already we just use it
    // as the query string — the slug IS the label for our purposes.
    const slug = trimmed.slice('concept_'.length);
    const { data } = await ctx.supabaseAdmin
      .from('lykn_concepts')
      .select('label')
      .eq('user_id', ctx.userId)
      .eq('slug', slug)
      .maybeSingle();
    return data?.label ? { query: data.label, seedKind: 'concept' } : null;
  }
  if (trimmed.startsWith('vault_')) {
    const id = trimmed.slice('vault_'.length);
    const { data } = await ctx.supabaseAdmin
      .from('vault_items')
      .select('title, content')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (!data) return null;
    const seed = data.title || String(data.content || '').slice(0, 120);
    return seed ? { query: seed, seedKind: 'vault' } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-store searchers. Each returns an array of normalised hits with
// the same shape:
//
//   {
//     node_id: 'belief_<uuid>' | 'fact_<uuid>' | 'concept_<slug>' | 'vault_<uuid>',
//     kind:    'belief' | 'fact' | 'concept' | 'vault',
//     label:   short display string,
//     snippet: longer surrounding-context snippet,
//     extra:   { status?, tags?, last_touched_at?, url? } — kind-specific,
//   }
//
// node_id matches the shape lykn_addProjectNeurons accepts, so a
// findConnections → addProjectNeurons handoff is one copy of node_id +
// label + kind.
// ---------------------------------------------------------------------------

async function searchBeliefs(ctx, query, limit) {
  if (!query) return [];
  const pattern = `%${escapeLike(query)}%`;
  const { data, error } = await ctx.supabaseAdmin
    .from('lykn_beliefs')
    .select('id, belief_text, serves_need, status, rationale, updated_at, created_at')
    .eq('user_id', ctx.userId)
    .in('status', ['active', 'proposed'])
    .or(`belief_text.ilike.${pattern},rationale.ilike.${pattern}`)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    console.warn('[mcp:findConnections:beliefs]', error.message);
    return [];
  }
  return (data || []).map((row) => ({
    node_id: `belief_${row.id}`,
    kind: 'belief',
    label: row.belief_text || '(untitled belief)',
    snippet: snippet(row.rationale || row.belief_text || '', query, 200),
    extra: {
      status: row.status,
      serves_need: row.serves_need,
      updated_at: row.updated_at,
    },
  }));
}

async function searchFacts(ctx, query, limit) {
  if (!query) return [];
  const pattern = `%${escapeLike(query)}%`;
  const { data, error } = await ctx.supabaseAdmin
    .from('lykn_user_model_facts')
    .select('id, fact_text, fact_kind, status, reason, updated_at, created_at')
    .eq('user_id', ctx.userId)
    .neq('status', 'dismissed')
    .or(`fact_text.ilike.${pattern},reason.ilike.${pattern}`)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    console.warn('[mcp:findConnections:facts]', error.message);
    return [];
  }
  return (data || []).map((row) => ({
    node_id: `fact_${row.id}`,
    kind: 'fact',
    label: row.fact_text || '(untitled fact)',
    snippet: snippet(row.reason || row.fact_text || '', query, 200),
    extra: {
      status: row.status,
      fact_kind: row.fact_kind,
      updated_at: row.updated_at,
    },
  }));
}

async function searchConcepts(ctx, query, limit) {
  if (!query) return [];
  const pattern = `%${escapeLike(query)}%`;
  const { data, error } = await ctx.supabaseAdmin
    .from('lykn_concepts')
    .select('id, label, slug, kind, status, last_touched_at, created_at')
    .eq('user_id', ctx.userId)
    .in('status', ['active', 'proposed'])
    .ilike('label', pattern)
    .order('last_touched_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    console.warn('[mcp:findConnections:concepts]', error.message);
    return [];
  }
  return (data || []).map((row) => ({
    node_id: `concept_${row.slug}`,
    kind: 'concept',
    label: row.label || '(untitled concept)',
    snippet: '',
    extra: {
      status: row.status,
      concept_kind: row.kind,
      last_touched_at: row.last_touched_at,
    },
  }));
}

async function searchVaultNotes(ctx, query, limit, opts = {}) {
  if (!query) return [];
  // Same hybrid engine as lykn_searchVault — substring-only was the silent
  // miss path when the model used findConnections for "what do I have on X?".
  // `fast: true` skips expansion + LLM rerank for auto-injection paths
  // (server-side [RELATED] packing) where latency/cost matter more.
  const fast = !!opts.fast;
  try {
    const result = await retrieveVaultHybridHits(ctx, {
      query,
      limit,
      expand: !fast,
      llmRerank: !fast,
    });
    if (result?.ok && Array.isArray(result.hits) && result.hits.length) {
      return result.hits.map((hit) => ({
        node_id: hit.node_id || `vault_${hit.id}`,
        kind: 'vault',
        label: hit.title || '(untitled note)',
        snippet: String(hit.snippet || '').slice(0, 240),
        extra: {
          tags: Array.isArray(hit.tags) ? hit.tags.slice(0, 6) : [],
          updated_at: hit.updated_at,
          url: hit.url || `/vault?note=${encodeURIComponent(hit.id)}`,
          match: hit.match,
          ...(hit.similarity != null ? { similarity: hit.similarity } : {}),
        },
      }));
    }
  } catch (e) {
    console.warn('[mcp:findConnections:vault] hybrid failed:', e?.message || e);
  }
  // Last-resort lexical fallback if hybrid throws (embeddings down, etc.).
  const pattern = `%${escapeLike(query)}%`;
  const { data, error } = await ctx.supabaseAdmin
    .from('vault_items')
    .select('id, title, content, ai_summary, tags, created_at, updated_at')
    .eq('user_id', ctx.userId)
    .or(`title.ilike.${pattern},content.ilike.${pattern},ai_summary.ilike.${pattern}`)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    console.warn('[mcp:findConnections:vault]', error.message);
    return [];
  }
  return (data || []).map((row) => ({
    node_id: `vault_${row.id}`,
    kind: 'vault',
    label: row.title || '(untitled note)',
    snippet: snippet(row.content || row.ai_summary || '', query, 240),
    extra: {
      tags: Array.isArray(row.tags) ? row.tags.slice(0, 6) : [],
      updated_at: row.updated_at,
      url: `/vault?note=${encodeURIComponent(row.id)}`,
    },
  }));
}

/**
 * Programmatic cross-store relatedness search (same engine as the MCP tool).
 * Used by server-side [RELATED] prompt packing so chat doesn't wait for the
 * model to remember to call lykn_findConnections.
 *
 * @returns {{ ok: true, query: string, matches: Array, counts: object } | { ok: false, reason: string }}
 */
export async function findRelatedConnectionHits(ctx, opts = {}) {
  if (!ctx?.supabaseAdmin || !ctx?.userId) {
    return { ok: false, reason: 'unauthorized' };
  }

  const rawQuery = typeof opts?.query === 'string' ? opts.query.trim().slice(0, MAX_QUERY_LEN) : '';
  const rawNodeId = typeof opts?.node_id === 'string' ? opts.node_id.trim() : '';
  if (!rawQuery && !rawNodeId) {
    return { ok: false, reason: 'missing_query' };
  }

  const requestedKinds = Array.isArray(opts?.kinds) && opts.kinds.length > 0
    ? opts.kinds.map((k) => String(k).toLowerCase()).filter((k) => KIND_SET.has(k))
    : ALL_KINDS;

  const perKindLimit = Number.isFinite(opts?.per_kind_limit)
    ? Math.max(1, Math.min(MAX_PER_KIND_LIMIT, opts.per_kind_limit))
    : DEFAULT_PER_KIND_LIMIT;

  let seedKind = null;
  let query = rawQuery;
  if (!query && rawNodeId) {
    const resolved = await resolveNodeIdToQuery(ctx, rawNodeId);
    if (!resolved) return { ok: false, reason: 'node_not_found' };
    query = resolved.query;
    seedKind = resolved.seedKind;
  }
  if (!query) return { ok: false, reason: 'empty_seed' };

  let searchKinds = requestedKinds;
  if (seedKind && !Array.isArray(opts?.kinds)) {
    searchKinds = requestedKinds.filter((k) => k !== seedKind);
  }

  const vaultOpts = { fast: !!opts.fast };
  const tasks = [];
  if (searchKinds.includes('belief')) {
    tasks.push(searchBeliefs(ctx, query, perKindLimit).then((r) => ['belief', r]));
  }
  if (searchKinds.includes('fact')) {
    tasks.push(searchFacts(ctx, query, perKindLimit).then((r) => ['fact', r]));
  }
  if (searchKinds.includes('concept')) {
    tasks.push(searchConcepts(ctx, query, perKindLimit).then((r) => ['concept', r]));
  }
  if (searchKinds.includes('vault')) {
    tasks.push(searchVaultNotes(ctx, query, perKindLimit, vaultOpts).then((r) => ['vault', r]));
  }

  const settled = await Promise.all(tasks);
  const byKind = Object.fromEntries(settled);
  const matches = [];
  for (const kind of ALL_KINDS) {
    if (!searchKinds.includes(kind)) continue;
    for (const row of byKind[kind] || []) matches.push(row);
  }
  const counts = Object.fromEntries(
    ALL_KINDS.map((k) => [k, (byKind[k] || []).length]),
  );

  return {
    ok: true,
    query,
    seed_kind: seedKind,
    kinds_searched: searchKinds,
    per_kind_limit: perKindLimit,
    count: matches.length,
    counts,
    matches,
  };
}

export const findConnectionsTool = {
  name: 'lykn_findConnections',
  title: 'Find related neurons across beliefs, facts, concepts, and vault',
  scope: 'read',
  description: [
    'Cross-source search over the LYKN user\'s synthesis layer. Returns',
    'related neurons from ALL four neuron stores at once:',
    '  • beliefs    — durable principles the user has ratified or proposed',
    '  • facts      — atomic observation-shaped truths about the user',
    '  • concepts   — named themes / topics / entities recurring in their work',
    '  • vault      — saved notes, articles, links, files',
    '',
    'CALL THIS when the user mentions a topic and you want the FULL picture',
    'of what they already think / know about it — e.g. "what do I have on',
    'X?", "remind me what I believe about Y", "pull together my thinking',
    'on Z". One call replaces three separate lookups (getBeliefs +',
    'getFacts + searchVault) and includes concepts which no other tool',
    'surfaces.',
    '',
    'TWO INPUT MODES:',
    '  • query: "...free text..."  — lexical on beliefs/facts/concepts;',
    '    hybrid BM25+semantic on vault (same engine as lykn_searchVault).',
    '  • node_id: "belief_<uuid>"  — find OTHER neurons related to this',
    '    starter neuron. node_id formats: belief_<uuid>, fact_<uuid>,',
    '    concept_<slug>, vault_<uuid>. The tool resolves the starter to',
    '    its text and searches the OTHER stores for matches.',
    '',
    'EACH HIT carries:',
    '  • node_id  — stable id of the shape lykn_addProjectNeurons accepts',
    '    (so "find then cluster into project" is one pipeline)',
    '  • kind     — belief | fact | concept | vault',
    '  • label    — short display string',
    '  • snippet  — surrounding-context snippet (empty for concepts)',
    '  • extra    — kind-specific metadata (status, tags, last_touched_at, …)',
    '',
    'Filter to specific stores via `kinds`. Defaults to all four. Cap per',
    'store via `per_kind_limit` (1–15, default 5).',
    '',
    'When NOT to call:',
    '  • The user asked a question you can answer from the prompt\'s',
    '    existing [BELIEFS_AND_RULES] / [USER_MODEL] / [WORKSPACE_CONTEXT]',
    '    blocks — those are already loaded.',
    '  • You need ONLY beliefs / ONLY facts / ONLY vault — use the',
    '    scoped tools (lykn_getBeliefs / lykn_getFacts / lykn_searchVault)',
    '    instead so the response stays tight.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text topic / phrase. Substring match across every store. One of `query` or `node_id` is required.',
      },
      node_id: {
        type: 'string',
        description: 'Optional starter neuron id (belief_<uuid> | fact_<uuid> | concept_<slug> | vault_<uuid>). The tool resolves its text and searches the OTHER stores for related items.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ALL_KINDS },
        description: `Which stores to search. Defaults to all four (${ALL_KINDS.join(', ')}).`,
      },
      per_kind_limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_PER_KIND_LIMIT,
        description: `Max hits per store (1-${MAX_PER_KIND_LIMIT}). Defaults to ${DEFAULT_PER_KIND_LIMIT}.`,
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const rawQuery = typeof args?.query === 'string' ? args.query.trim().slice(0, MAX_QUERY_LEN) : '';
    const rawNodeId = typeof args?.node_id === 'string' ? args.node_id.trim() : '';

    if (!rawQuery && !rawNodeId) {
      return errorContent('Pass either `query` (free-text) or `node_id` (starter neuron id).');
    }

    const result = await findRelatedConnectionHits(ctx, {
      query: rawQuery,
      node_id: rawNodeId,
      kinds: args?.kinds,
      per_kind_limit: args?.per_kind_limit,
      fast: false,
    });

    if (!result.ok) {
      if (result.reason === 'node_not_found') {
        return jsonContent({
          ok: false,
          reason: 'node_not_found',
          message: `Could not resolve node_id "${rawNodeId}" to a source row. Format must be belief_<uuid>, fact_<uuid>, concept_<slug>, or vault_<uuid>.`,
        });
      }
      if (result.reason === 'empty_seed') {
        return jsonContent({
          ok: false,
          reason: 'empty_seed',
          message: 'Starter neuron has no searchable text. Pass `query` explicitly.',
        });
      }
      return errorContent('Pass either `query` (free-text) or `node_id` (starter neuron id).');
    }

    return jsonContent({
      ...result,
      message: result.count === 0
        ? `No connections found for "${result.query}". The user hasn\'t saved / believed / observed anything matching that yet.`
        : `Found ${result.count} related neuron${result.count === 1 ? '' : 's'} across ${result.kinds_searched.length} store${result.kinds_searched.length === 1 ? '' : 's'}.`,
    });
  },
};
