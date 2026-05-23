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
//   • Vault notes:                  ilike on title + content
//
// No embeddings yet. The point of "dumb" is determinism + zero LLM cost
// per call. When we ship embeddings, this tool's name and shape stay
// the same — handler grows a hybrid path. External clients shouldn't
// need to know.
//
// Ordering: each store contributes up to `per_kind_limit` rows, sorted
// by recency within its store. The merged response is bucketed by kind
// in the order [belief, fact, concept, vault] so the highest-signal
// stuff (governance > observation > theme > raw note) reads first.

import { jsonContent, errorContent } from './index.js';

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
  return String(s).replace(/[%_]/g, '\\$&');
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
      .from('notes')
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

async function searchVaultNotes(ctx, query, limit) {
  if (!query) return [];
  const pattern = `%${escapeLike(query)}%`;
  const { data, error } = await ctx.supabaseAdmin
    .from('notes')
    .select('id, title, content, tags, created_at, updated_at')
    .eq('user_id', ctx.userId)
    .or(`title.ilike.${pattern},content.ilike.${pattern}`)
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
    snippet: snippet(row.content || '', query, 240),
    extra: {
      tags: Array.isArray(row.tags) ? row.tags.slice(0, 6) : [],
      updated_at: row.updated_at,
      url: `/vault?note=${encodeURIComponent(row.id)}`,
    },
  }));
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
    '  • query: "...free text..."  — substring search across every store.',
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

    const requestedKinds = Array.isArray(args?.kinds) && args.kinds.length > 0
      ? args.kinds.map((k) => String(k).toLowerCase()).filter((k) => KIND_SET.has(k))
      : ALL_KINDS;

    const perKindLimit = Number.isFinite(args?.per_kind_limit)
      ? Math.max(1, Math.min(MAX_PER_KIND_LIMIT, args.per_kind_limit))
      : DEFAULT_PER_KIND_LIMIT;

    // Resolve node_id → query. If the caller passed BOTH query AND
    // node_id, query wins (explicit > seeded) but we still note the
    // seed_kind in the response so the model knows the original anchor.
    let seedKind = null;
    let query = rawQuery;
    if (!query && rawNodeId) {
      const resolved = await resolveNodeIdToQuery(ctx, rawNodeId);
      if (!resolved) {
        return jsonContent({
          ok: false,
          reason: 'node_not_found',
          message: `Could not resolve node_id "${rawNodeId}" to a source row. Format must be belief_<uuid>, fact_<uuid>, concept_<slug>, or vault_<uuid>.`,
        });
      }
      query = resolved.query;
      seedKind = resolved.seedKind;
    }
    if (!query) {
      // resolveNodeIdToQuery returned a row but no usable text. Bail
      // rather than silently returning every neuron in the system.
      return jsonContent({
        ok: false,
        reason: 'empty_seed',
        message: 'Starter neuron has no searchable text. Pass `query` explicitly.',
      });
    }

    // Skip the seed kind from the search set — finding the starter
    // neuron in its own result list is noise. The caller can pass an
    // explicit `kinds` array if they DO want the same-kind results.
    let searchKinds = requestedKinds;
    if (seedKind && !Array.isArray(args?.kinds)) {
      searchKinds = requestedKinds.filter((k) => k !== seedKind);
    }

    // Fire all enabled store queries in parallel.
    const tasks = [];
    if (searchKinds.includes('belief')) tasks.push(searchBeliefs(ctx, query, perKindLimit).then((r) => ['belief', r]));
    if (searchKinds.includes('fact')) tasks.push(searchFacts(ctx, query, perKindLimit).then((r) => ['fact', r]));
    if (searchKinds.includes('concept')) tasks.push(searchConcepts(ctx, query, perKindLimit).then((r) => ['concept', r]));
    if (searchKinds.includes('vault')) tasks.push(searchVaultNotes(ctx, query, perKindLimit).then((r) => ['vault', r]));

    const settled = await Promise.all(tasks);

    const byKind = Object.fromEntries(settled);
    // Interleave in policy order (belief → fact → concept → vault).
    const matches = [];
    for (const kind of ALL_KINDS) {
      if (!searchKinds.includes(kind)) continue;
      const rows = byKind[kind] || [];
      for (const row of rows) matches.push(row);
    }

    const counts = Object.fromEntries(
      ALL_KINDS.map((k) => [k, (byKind[k] || []).length]),
    );

    return jsonContent({
      ok: true,
      query,
      seed_kind: seedKind,
      kinds_searched: searchKinds,
      per_kind_limit: perKindLimit,
      count: matches.length,
      counts,
      matches,
      message: matches.length === 0
        ? `No connections found for "${query}". The user hasn\'t saved / believed / observed anything matching that yet.`
        : `Found ${matches.length} related neuron${matches.length === 1 ? '' : 's'} across ${searchKinds.length} store${searchKinds.length === 1 ? '' : 's'}.`,
    });
  },
};
