// ============================================================================
// mcp-tools/searchVault.js — HYBRID search over the user's vault notes
// ============================================================================
// Read-only. Two complementary passes, merged:
//   1. Keyword/substring (`ilike`) on title + content + ai_summary — fast,
//      deterministic, free; catches exact words and filenames.
//   2. Semantic vector search over the embedded synthesis index — catches
//      conceptual queries ("my sunset photo", "that pricing doc") where the
//      literal words aren't in the note, AND image/file uploads whose only
//      meaningful text is the AI vision description folded into the embedding.
//
// Why hybrid: substring-only was the #1 reason the assistant said "nothing in
// your vault" for items that were clearly there — the user phrased a concept,
// the note's title/body didn't contain those exact characters, zero hits. The
// semantic pass closes that gap; substring stays as a precise, free first hit.
//
// The semantic pass runs with the service-role client (no user JWT in MCP
// ctx), so it calls match_lykn_synthesis_chunks_for_user (migration 092),
// which takes user_id explicitly. If embeddings are unavailable it degrades
// silently to substring-only.

import { jsonContent, errorContent } from './index.js';
import { embedSingleText } from '../synthesis-service.js';
import { reciprocalRankFusion } from '../lib/rag/rrf.js';
import { rerankCandidates, rerankProvider } from '../lib/rag/rerank.js';
import { expandQuery } from '../lib/rag/queryExpansion.js';

const MAX_QUERY_LEN = 200;
const MAX_RESULTS = 25;
const SEMANTIC_MATCH_COUNT = 24;
// First-stage retrievers over-fetch into a shared pool; RRF fuses them and the
// reranker (if configured) reorders before we cut to the caller's limit.
const CANDIDATE_POOL = 40;
const BM25_MATCH_COUNT = 30;
// Lowered from 0.5 → 0.35: short, single-word queries ("porsches") have low
// cosine similarity against long vision descriptions, so a 0.5 floor silently
// dropped legitimate image/file matches. 0.35 keeps obvious noise out while
// recovering the "I definitely have this saved" false-negatives.
const SEMANTIC_MATCH_THRESHOLD = 0.35;

// Query filler + vault-domain words that carry no matching signal. Stripped
// from the keyword pass so the distinctive nouns ("porsche") drive recall.
const KEYWORD_STOPWORDS = new Set([
  'the', 'and', 'for', 'any', 'anything', 'about', 'have', 'has', 'had',
  'with', 'that', 'this', 'from', 'your', 'mine', 'vault', 'note', 'notes',
  'saved', 'save', 'find', 'show', 'pull', 'pulled', 'bring', 'image',
  'images', 'img', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics',
  'file', 'files', 'some', 'all', 'did', 'was', 'are', 'can', 'you', 'get',
  'got', 'what', 'when', 'where', 'there', 'their', 'they', 'them', 'whats',
  'something', 'anyting', 'stuff', 'thing', 'things', 'item', 'items',
  'percent', 'definitely', 'definately',
]);

// Singular/plural-tolerant variants for a single token. "porsches" → also
// search "porsche"; "porsche" → also search "porsches". This is the fix for
// the literal-substring miss where the user pluralised a noun the saved item
// stored in the singular (and vice-versa).
function keywordVariants(tok) {
  const v = new Set([tok]);
  if (tok.endsWith('ies') && tok.length > 4) v.add(`${tok.slice(0, -3)}y`); // categories→category
  if (tok.endsWith('es') && tok.length > 4) v.add(tok.slice(0, -2)); // boxes→box
  if (tok.endsWith('s') && tok.length > 3) v.add(tok.slice(0, -1)); // porsches→porsche
  v.add(`${tok}s`); // porsche→porsches
  return [...v];
}

// Build the PostgREST `.or()` condition string for the keyword pass: the full
// phrase plus every significant token (with plural variants), each matched as
// a case-insensitive substring against title + content + ai_summary.
function buildKeywordOr(queryRaw) {
  const esc = (s) => s.replace(/[%_,()]/g, '\\$&');
  const patterns = new Set();
  const add = (term) => {
    const t = term.trim();
    if (!t) return;
    const p = `%${esc(t)}%`;
    patterns.add(`title.ilike.${p}`);
    patterns.add(`content.ilike.${p}`);
    patterns.add(`ai_summary.ilike.${p}`);
  };

  // Full phrase first (precise multi-word matches).
  add(queryRaw);

  // Then each distinctive token + its singular/plural variants.
  const tokens = queryRaw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !KEYWORD_STOPWORDS.has(t));
  for (const tok of tokens) {
    for (const variant of keywordVariants(tok)) add(variant);
  }

  return [...patterns].join(',');
}

export const searchVaultTool = {
  name: 'lykn_searchVault',
  title: 'Search the user\'s LYKN vault for notes / saved items',
  scope: 'read',
  description: [
    'Hybrid search across the LYKN user\'s vault (notes, saved articles,',
    'links, files, IMAGES, AI snippets). Combines exact keyword matching with',
    'semantic/meaning search, so it finds items by CONCEPT — including images',
    'and files matched on their AI vision description / extracted text — not',
    'just literal words. Returns up to 25 hits. Each hit:',
    '{ node_id: "vault_<uuid>", id, title, snippet, tags, match ("keyword" |',
    '"semantic"), similarity (semantic only), created_at, updated_at,',
    'url: "/vault?note=<id>" }.',
    '',
    'Because search is semantic, do NOT conclude "nothing is saved" from a',
    'single narrow query — if the first phrasing returns little, try the',
    'user\'s own words or a broader synonym before telling them it\'s not there.',
    '',
    'IMPORTANT — hits are SNIPPETS, and they DO NOT render in the LYKN',
    'chat on their own. If the user wants to SEE / OPEN / READ / "bring',
    'in" / "pull up" / "show me" a saved item (any verb implying looking',
    'at the thing itself, not just discussing it), you MUST follow up',
    'with `lykn_loadNeuron({ node_id })` — or `lykn_loadNeurons` for',
    'several — using the `node_id` field from the hit (NOT the bare `id`,',
    'which is missing the required `vault_` prefix). loadNeuron returns',
    'the full body AND causes the saved file/note/link/image to render as',
    'a rich card under your reply. Don\'t paraphrase the snippet in that',
    'case — the card shows the content; your prose just frames WHY you',
    'brought it in.',
    '',
    'Skip the loadNeuron step only when the user wants a LIST of titles',
    '("what notes do I have on X?") and is not asking to see the items.',
    '',
    'Typical triggers: "what did I save about X?", "find that article on',
    'Y", "did I take notes on Z?", "pull up my note on …".',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query. Substring match — keep it short and specific.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        description: `Max results to return (1-${MAX_RESULTS}). Defaults to 10.`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const queryRaw = String(args?.query || '').trim().slice(0, MAX_QUERY_LEN);
    if (!queryRaw) return errorContent('query is required and must be non-empty.');
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(MAX_RESULTS, args.limit)) : 10;

    const tagsOf = (n) => (Array.isArray(n?.tags) ? n.tags : [])
      .map((t) => (typeof t === 'string' ? t : t?.name || t?.label || String(t || '')))
      .filter(Boolean)
      .slice(0, 8);

    const makeHit = (n, extra = {}) => ({
      // Stable cross-store id the model can hand directly to
      // lykn_loadNeuron / lykn_loadNeurons / lykn_addProjectNeurons.
      // Without this the model has to know to prefix `vault_` itself,
      // which it routinely got wrong (passing the bare uuid into
      // loadNeuron returns "unrecognised_node_id" and the saved note
      // never makes it into the chat as a rich card).
      node_id: `vault_${n.id}`,
      // Bare uuid kept for backward compat with anything that already
      // reads `id` (the REST mirror docs reference it). New callers
      // should prefer `node_id`.
      id: n.id,
      title: n.title || '(untitled)',
      tags: tagsOf(n),
      created_at: n.created_at,
      updated_at: n.updated_at,
      url: `/vault?note=${encodeURIComponent(n.id)}`,
      ...extra,
    });

    const ql = queryRaw.toLowerCase();
    const snippetFor = (n) => {
      const text = String(n.content || '');
      const idx = text.toLowerCase().indexOf(ql);
      if (idx >= 0) {
        return text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + queryRaw.length + 180)).trim();
      }
      const summary = String(n.ai_summary || '').trim();
      if (summary) return summary.slice(0, 240);
      return text.slice(0, 240).trim();
    };

    // Multi-query expansion (Level 5): split a compound/vague question into a
    // few focused sub-probes. Returns just [queryRaw] unless RAG_QUERY_EXPANSION
    // is enabled, so default behaviour is a single query.
    const queries = await expandQuery(queryRaw);

    // Each (retriever × sub-query) produces one ranked list; RRF fuses them all.
    const rankedLists = [];
    // Best similarity + snippet seen for a note across any dense sub-query.
    const semanticMeta = new Map();

    // --- Lexical retriever: BM25 (Postgres full-text), ilike as fallback -----
    let bm25Available = true;
    for (let qi = 0; qi < queries.length; qi++) {
      const { data: bm, error: bmErr } = await ctx.supabaseAdmin.rpc('search_notes_bm25', {
        p_user_id: ctx.userId,
        p_query: queries[qi],
        match_count: BM25_MATCH_COUNT,
      });
      if (bmErr) {
        // Most likely: migration 098 not applied yet. Stop trying BM25 and fall
        // back to the legacy substring pass below.
        bm25Available = false;
        console.warn('[mcp:searchVault] bm25 rpc:', bmErr.message);
        break;
      }
      const items = (bm || []).map((r) => ({ id: String(r.id) })).filter((x) => x.id);
      if (items.length) rankedLists.push({ label: `bm25_q${qi}`, items, weight: 1 });
    }

    if (!bm25Available) {
      // Legacy keyword pass: tokenized, singular/plural-tolerant substring match
      // on title + content + ai_summary. Lower quality than BM25 (no ranking,
      // no stemming) but keeps lexical recall alive pre-migration.
      const keywordOr = buildKeywordOr(queryRaw);
      const { data: kwData, error: kwError } = await ctx.supabaseAdmin
        .from('notes')
        .select('id')
        .eq('user_id', ctx.userId)
        .or(keywordOr)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(MAX_RESULTS);
      if (kwError) console.warn('[mcp:searchVault] keyword fallback:', kwError.message);
      const items = (kwData || []).map((n) => ({ id: String(n.id) })).filter((x) => x.id);
      if (items.length) rankedLists.push({ label: 'ilike', items, weight: 1 });
    }

    // --- Dense retriever: vector search per sub-query ------------------------
    let semanticError = null;
    for (let qi = 0; qi < queries.length; qi++) {
      try {
        const embedding = await embedSingleText(queries[qi]);
        if (!embedding) continue;
        const { data: rows, error: rpcError } = await ctx.supabaseAdmin.rpc(
          'match_lykn_synthesis_chunks_for_user',
          {
            query_embedding: embedding,
            p_user_id: ctx.userId,
            match_count: SEMANTIC_MATCH_COUNT,
            match_threshold: SEMANTIC_MATCH_THRESHOLD,
          },
        );
        if (rpcError) {
          semanticError = rpcError.message;
          console.warn('[mcp:searchVault] dense pass:', rpcError.message);
          continue;
        }
        const noteBest = new Map(); // noteId -> best similarity for THIS sub-query
        for (const r of rows || []) {
          if (String(r.source_type) !== 'vault_note') continue;
          const noteId = String(r.source_id || '');
          if (!noteId) continue;
          const sim = typeof r.similarity === 'number' ? r.similarity : 0;
          if (!noteBest.has(noteId) || sim > noteBest.get(noteId)) noteBest.set(noteId, sim);
          const gm = semanticMeta.get(noteId);
          if (!gm || sim > gm.similarity) {
            semanticMeta.set(noteId, {
              similarity: sim,
              snippet: String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240),
            });
          }
        }
        const ordered = [...noteBest.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => ({ id }));
        if (ordered.length) rankedLists.push({ label: `dense_q${qi}`, items: ordered, weight: 1 });
      } catch (e) {
        semanticError = e?.message || String(e);
        console.warn('[mcp:searchVault] dense pass threw:', semanticError);
      }
    }

    // --- Fuse every ranked list with Reciprocal Rank Fusion -----------------
    const fused = reciprocalRankFusion(rankedLists, { limit: CANDIDATE_POOL });
    if (!fused.length) {
      return jsonContent({
        ok: true,
        query: queryRaw,
        count: 0,
        hits: [],
        retrieval: { retrievers: rankedLists.map((l) => l.label), reranker: rerankProvider() },
      });
    }

    // Hydrate the fused candidate notes in a single round-trip.
    const { data: noteRows, error: hydErr } = await ctx.supabaseAdmin
      .from('notes')
      .select('id, title, content, created_at, updated_at, tags, ai_summary')
      .eq('user_id', ctx.userId)
      .in('id', fused.map((f) => f.id));
    if (hydErr) console.warn('[mcp:searchVault] hydrate:', hydErr.message);
    const rowById = new Map((noteRows || []).map((n) => [String(n.id), n]));

    let candidates = fused
      .map((f) => {
        const n = rowById.get(f.id);
        if (!n) return null; // orphan: note deleted but chunk lingered
        const sem = semanticMeta.get(f.id);
        return {
          id: f.id,
          note: n,
          sources: f.sources,
          snippet: (sem && sem.snippet) || snippetFor(n),
          similarity: sem ? Number(sem.similarity.toFixed(3)) : undefined,
        };
      })
      .filter(Boolean);

    // --- Rerank (Level 3 ceiling): cross-encoder reorders the pool ----------
    // No-op (identity) unless a rerank provider key is configured.
    const provider = rerankProvider();
    if (provider !== 'none' && candidates.length > 1) {
      const reranked = await rerankCandidates(
        queryRaw,
        candidates.map((c) => ({
          id: c.id,
          text: `${c.note.title || ''}\n${c.snippet || ''}`,
          payload: c,
        })),
        { topN: Math.max(limit, 12) },
      );
      if (reranked.length) {
        candidates = reranked.map((r) => ({ ...r.payload, rerankScore: r.rerankScore }));
      }
    }

    const hits = candidates.slice(0, limit).map((c) => {
      const hasDense = (c.sources || []).some((s) => s.startsWith('dense'));
      const hasLexical = (c.sources || []).some((s) => s.startsWith('bm25') || s === 'ilike');
      const match = hasDense && hasLexical ? 'hybrid' : hasDense ? 'semantic' : 'keyword';
      return makeHit(c.note, {
        snippet: c.snippet,
        match,
        ...(c.similarity != null ? { similarity: c.similarity } : {}),
        ...(typeof c.rerankScore === 'number' ? { rerank: Number(c.rerankScore.toFixed(4)) } : {}),
      });
    });

    return jsonContent({
      ok: true,
      query: queryRaw,
      ...(queries.length > 1 ? { subQueries: queries.slice(1) } : {}),
      count: hits.length,
      retrieval: {
        retrievers: rankedLists.map((l) => l.label),
        fused: fused.length,
        reranker: provider,
        ...(semanticError ? { semanticError } : {}),
      },
      hits,
    });
  },
};
