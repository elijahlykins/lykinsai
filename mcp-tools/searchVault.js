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

const MAX_QUERY_LEN = 200;
const MAX_RESULTS = 25;
const SEMANTIC_MATCH_COUNT = 24;
const SEMANTIC_MATCH_THRESHOLD = 0.5;

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

    // --- Pass 1: keyword/substring on title + content + ai_summary ----------
    const escaped = queryRaw.replace(/[%_]/g, '\\$&');
    const pattern = `%${escaped}%`;

    const { data: kwData, error: kwError } = await ctx.supabaseAdmin
      .from('notes')
      .select('id, title, content, created_at, updated_at, tags, ai_summary')
      .eq('user_id', ctx.userId)
      .or(`title.ilike.${pattern},content.ilike.${pattern},ai_summary.ilike.${pattern}`)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(MAX_RESULTS);
    if (kwError) {
      console.warn('[mcp:searchVault] keyword pass:', kwError.message);
    }

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

    const byId = new Map();
    for (const n of kwData || []) {
      if (!n?.id || byId.has(n.id)) continue;
      byId.set(n.id, makeHit(n, { snippet: snippetFor(n), match: 'keyword' }));
    }

    // --- Pass 2: semantic vector search over the embedded index -------------
    // Degrades silently to keyword-only if embeddings are unavailable or the
    // admin match RPC isn't deployed yet (migration 092).
    let semanticError = null;
    try {
      const embedding = await embedSingleText(queryRaw);
      if (embedding) {
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
          console.warn('[mcp:searchVault] semantic pass:', rpcError.message);
        } else {
          // Collapse chunks → best chunk per vault note, keep similarity order.
          const noteScores = new Map(); // noteId -> { similarity, snippet }
          for (const r of rows || []) {
            if (String(r.source_type) !== 'vault_note') continue;
            const noteId = String(r.source_id || '');
            if (!noteId) continue;
            const sim = typeof r.similarity === 'number' ? r.similarity : 0;
            const prev = noteScores.get(noteId);
            if (!prev || sim > prev.similarity) {
              noteScores.set(noteId, {
                similarity: sim,
                snippet: String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240),
              });
            }
          }

          // Only fetch note rows we don't already have from the keyword pass.
          const newIds = [...noteScores.keys()].filter((id) => !byId.has(id));
          let noteRows = [];
          if (newIds.length) {
            const { data: nd, error: ndErr } = await ctx.supabaseAdmin
              .from('notes')
              .select('id, title, content, created_at, updated_at, tags, ai_summary')
              .eq('user_id', ctx.userId)
              .in('id', newIds);
            if (ndErr) console.warn('[mcp:searchVault] semantic note hydrate:', ndErr.message);
            else noteRows = nd || [];
          }
          const rowById = new Map(noteRows.map((n) => [n.id, n]));

          // Append semantic-only hits, best similarity first.
          const ordered = [...noteScores.entries()]
            .filter(([id]) => !byId.has(id))
            .sort((a, b) => b[1].similarity - a[1].similarity);
          for (const [noteId, score] of ordered) {
            const n = rowById.get(noteId);
            if (!n) continue; // chunk orphaned (note deleted) — skip
            byId.set(noteId, makeHit(n, {
              snippet: score.snippet || snippetFor(n),
              match: 'semantic',
              similarity: Number(score.similarity.toFixed(3)),
            }));
          }
        }
      }
    } catch (e) {
      semanticError = e?.message || String(e);
      console.warn('[mcp:searchVault] semantic pass threw:', semanticError);
    }

    // Keyword hits (recency-ordered) first, then semantic extras (already
    // appended in similarity order). Cap to the caller's limit.
    const hits = [...byId.values()].slice(0, limit);

    return jsonContent({
      ok: true,
      query: queryRaw,
      count: hits.length,
      hits,
    });
  },
};
