// ============================================================================
// lib/rag/vaultHybrid.js — shared hybrid vault retrieval engine
// ============================================================================
// Used by lykn_searchVault. Lives
// outside mcp-tools/ to avoid circular imports through mcp-tools/index.js.
//
// Pipeline: query normalize → (optional) expand → BM25 + dense → RRF → rerank.

import { embedSingleText } from '../../synthesis-service.js';
import { reciprocalRankFusion } from './rrf.js';
import { rerankCandidates, rerankProvider } from './rerank.js';
import { expandQuery } from './queryExpansion.js';

const MAX_QUERY_LEN = 200;
const MAX_RESULTS = 25;
const DEFAULT_LIMIT = 12;
const SEMANTIC_MATCH_COUNT = 36;
const CANDIDATE_POOL = 56;
const BM25_MATCH_COUNT = 40;
const SEMANTIC_MATCH_THRESHOLD = 0.32;
// Short topic queries get a slightly looser dense floor so related concepts
// ("prosthetics" ↔ "artificial limb") still surface before rerank.
const SEMANTIC_MATCH_THRESHOLD_SHORT = 0.28;

const KEYWORD_STOPWORDS = new Set([
  'the', 'and', 'for', 'any', 'anything', 'about', 'have', 'has', 'had',
  'with', 'that', 'this', 'from', 'your', 'mine', 'vault', 'note', 'notes',
  'saved', 'save', 'find', 'show', 'pull', 'pulled', 'bring', 'image',
  'images', 'img', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics',
  'file', 'files', 'some', 'all', 'did', 'was', 'are', 'can', 'you', 'get',
  'got', 'what', 'when', 'where', 'there', 'their', 'they', 'them', 'whats',
  'something', 'anyting', 'stuff', 'thing', 'things', 'item', 'items',
  'percent', 'definitely', 'definately', 'please', 'thanks', 'thank',
  // Chat leftovers after stripping "pull it in for me" / "I think" / etc.
  'think', 'thought', 'maybe', 'probably', 'guess', 'wondering', 'want',
  'need', 'like', 'just', 'also', 'still', 'really', 'actually', 'basically',
  'me', 'my', 'i', 'it', 'its', 'into', 'onto', 'out', 'up', 'down', 'off',
  'in', 'on', 'to', 'of', 'an', 'as', 'or', 'if', 'so', 'be', 'is', 'am',
  'artifact', 'artifacts', 'interactive',
]);

function keywordVariants(tok) {
  const v = new Set([tok]);
  if (tok.endsWith('ies') && tok.length > 4) {
    v.add(`${tok.slice(0, -3)}y`);
  } else if (tok.endsWith('ses') || tok.endsWith('xes') || tok.endsWith('zes') || tok.endsWith('ches') || tok.endsWith('shes')) {
    v.add(tok.slice(0, -2));
  } else if (tok.endsWith('s') && !tok.endsWith('ss') && tok.length > 3) {
    v.add(tok.slice(0, -1));
  }
  if (!tok.endsWith('s')) {
    if (/[bcdfghjklmnpqrstvwxz]y$/i.test(tok) && tok.length > 3) {
      v.add(`${tok.slice(0, -1)}ies`);
    } else if (/(?:s|x|z|ch|sh)$/i.test(tok)) {
      v.add(`${tok}es`);
    } else {
      v.add(`${tok}s`);
    }
  }
  return [...v];
}

/**
 * Strip chat fluff so "pull up that note I saved about porsche pricing"
 * becomes a sharper probe: "porsche pricing".
 */
export function normalizeVaultSearchQuery(raw) {
  let q = String(raw || '').trim();
  if (!q) return '';
  q = q.replace(/^(hey|hi|hello|yo|please|pls|lykn)\b[\s,!.:-]*/gi, '');
  q = q.replace(/^(can you|could you|would you|will you)\b[\s,]+/gi, '');
  q = q.replace(
    /\b(pull(?:\s+up)?|bring(?:\s+up)?|look(?:\s+up)?|find|search(?:\s+for)?|show(?:\s+me)?|open|get|fetch|locate|grab)\b/gi,
    ' ',
  );
  q = q.replace(
    /\b(that|the|my|a|an|any|some)\s+(note|notes|file|files|doc|docs|document|documents|article|articles|image|images|photo|photos|picture|pictures|link|links|bookmark|bookmarks|thing|things|item|items|stuff)\b/gi,
    ' ',
  );
  q = q.replace(
    /\b((do|did|does)\s+i\s+have|i\s+(saved|have|took|think)|have\s+i\s+saved|anything|something|whatever)\b/gi,
    ' ',
  );
  q = q.replace(/\b(i\s+think|i'm\s+thinking|not\s+sure)\b/gi, ' ');
  q = q.replace(/\b(about|regarding|related to|on the topic of)\b/gi, ' ');
  q = q.replace(/\b(from|in|on)\s+(my\s+)?(vault|notion|drive|lykn)\b/gi, ' ');
  q = q.replace(/\b(please|thanks|thank you|ty|for me|to me)\b/gi, ' ');
  q = q.replace(/\b(it\s+in|pull\s+it|bring\s+it)\b/gi, ' ');
  q = q.replace(/[?!]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Leftover prepositions after stripping ("on launch deck").
  q = q.replace(/^(on|in|for|to|of|with)\s+/i, '').trim();

  const tokens = q
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !KEYWORD_STOPWORDS.has(t.toLowerCase()));
  if (tokens.length === 0) return String(raw || '').trim().slice(0, MAX_QUERY_LEN);
  return tokens.join(' ').slice(0, MAX_QUERY_LEN);
}

function heuristicVaultQueries(raw) {
  const original = String(raw || '').trim().slice(0, MAX_QUERY_LEN);
  if (!original) return [];
  const normalized = normalizeVaultSearchQuery(original);
  const out = [original];
  if (normalized && normalized.toLowerCase() !== original.toLowerCase()) {
    out.push(normalized);
  }
  return out;
}

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

  add(queryRaw);

  const tokens = queryRaw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !KEYWORD_STOPWORDS.has(t));
  for (const tok of tokens) {
    for (const variant of keywordVariants(tok)) add(variant);
  }

  return [...patterns].join(',');
}

function tagsOf(n) {
  return (Array.isArray(n?.tags) ? n.tags : [])
    .map((t) => (typeof t === 'string' ? t : t?.name || t?.label || String(t || '')))
    .filter(Boolean)
    .slice(0, 8);
}

function makeHit(n, extra = {}) {
  return {
    node_id: `vault_${n.id}`,
    id: n.id,
    title: n.title || '(untitled)',
    tags: tagsOf(n),
    created_at: n.created_at,
    updated_at: n.updated_at,
    url: `/vault?note=${encodeURIComponent(n.id)}`,
    ...extra,
  };
}

function snippetFor(n, queryRaw) {
  const ql = String(queryRaw || '').toLowerCase();
  const text = String(n.content || '');
  const idx = ql ? text.toLowerCase().indexOf(ql) : -1;
  if (idx >= 0) {
    return text
      .slice(Math.max(0, idx - 60), Math.min(text.length, idx + queryRaw.length + 180))
      .trim();
  }
  const tokens = ql
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !KEYWORD_STOPWORDS.has(t));
  for (const tok of tokens) {
    const ti = text.toLowerCase().indexOf(tok);
    if (ti >= 0) {
      return text.slice(Math.max(0, ti - 60), Math.min(text.length, ti + tok.length + 180)).trim();
    }
  }
  const summary = String(n.ai_summary || '').trim();
  if (summary) return summary.slice(0, 240);
  const cleaned = text.replace(/\[ATTACHMENTS_JSON:[\s\S]*$/, '').trim();
  return (cleaned || text).slice(0, 240).trim();
}

/**
 * Shared hybrid vault retrieval.
 *
 * @param {{ supabaseAdmin: any, userId: string }} ctx
 * @param {{ query: string, limit?: number, expand?: boolean, llmRerank?: boolean }} opts
 */
export async function retrieveVaultHybridHits(ctx, opts = {}) {
  const queryRaw = String(opts.query || '').trim().slice(0, MAX_QUERY_LEN);
  if (!queryRaw) {
    return { ok: true, query: '', count: 0, hits: [], retrieval: { retrievers: [] } };
  }
  if (!ctx?.supabaseAdmin || !ctx?.userId) {
    return { ok: false, query: queryRaw, count: 0, hits: [], error: 'unauthorized' };
  }

  const limit = Number.isFinite(opts.limit)
    ? Math.max(1, Math.min(MAX_RESULTS, opts.limit))
    : DEFAULT_LIMIT;
  // Related-word expansion always runs (morphological variants offline;
  // synonyms via LLM when OPENAI_API_KEY is set). Kill with RAG_QUERY_EXPANSION=0
  // or opts.expand=false.
  const expansionOff =
    opts.expand === false || process.env.RAG_QUERY_EXPANSION === '0';
  const llmRerank =
    opts.llmRerank !== false &&
    process.env.RAG_LLM_RERANK !== '0' &&
    !!process.env.OPENAI_API_KEY;

  const topicProbe = normalizeVaultSearchQuery(queryRaw) || queryRaw;
  const heuristic = heuristicVaultQueries(queryRaw);
  let queries = heuristic;
  if (!expansionOff) {
    const expanded = await expandQuery(topicProbe, {
      // Morph variants always; LLM synonyms only when a key is present.
      enabled: !!process.env.OPENAI_API_KEY,
      force: true,
      mode: 'related',
      max: 6,
      timeoutMs: 5000,
    });
    const merged = [];
    const seen = new Set();
    for (const q of [...heuristic, ...expanded]) {
      const key = String(q || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(String(q).trim().slice(0, MAX_QUERY_LEN));
      if (merged.length >= 7) break;
    }
    queries = merged.length ? merged : heuristic;
  }

  const shortTopic =
    topicProbe.split(/\s+/).filter(Boolean).length <= 3 && topicProbe.length <= 40;
  const denseThreshold = shortTopic
    ? SEMANTIC_MATCH_THRESHOLD_SHORT
    : SEMANTIC_MATCH_THRESHOLD;

  const rankedLists = [];
  const semanticMeta = new Map();

  let bm25Available = true;
  for (let qi = 0; qi < queries.length; qi++) {
    const { data: bm, error: bmErr } = await ctx.supabaseAdmin.rpc('search_notes_bm25', {
      p_user_id: ctx.userId,
      p_query: queries[qi],
      match_count: BM25_MATCH_COUNT,
    });
    if (bmErr) {
      bm25Available = false;
      console.warn('[vaultHybrid] bm25 rpc:', bmErr.message);
      break;
    }
    const items = (bm || []).map((r) => ({ id: String(r.id) })).filter((x) => x.id);
    // Related sub-queries get a slight lexical weight bump so synonym BM25
    // hits aren't drowned by the original phrasing's ranking.
    if (items.length) {
      rankedLists.push({
        label: `bm25_q${qi}`,
        items,
        weight: qi === 0 ? 1.1 : 1.05,
      });
    }
  }

  // Title ilike boost — original topic + related expansion terms. Artifact
  // notes are often title-only; related words must hit titles too.
  {
    const titleTerms = [];
    const seenTerm = new Set();
    const pushTerm = (term) => {
      const t = String(term || '').trim();
      if (!t || t.length < 2) return;
      const key = t.toLowerCase();
      if (seenTerm.has(key)) return;
      seenTerm.add(key);
      titleTerms.push(t);
    };
    for (const q of [topicProbe, ...queries]) {
      pushTerm(q);
      // Also index significant tokens from multi-word related phrases
      // ("artificial limb" → "artificial", "limb") so titles can partial-match.
      for (const tok of String(q || '').split(/[^a-z0-9]+/i)) {
        if (tok.length >= 4 && !KEYWORD_STOPWORDS.has(tok.toLowerCase())) {
          pushTerm(tok);
          for (const v of keywordVariants(tok.toLowerCase())) pushTerm(v);
        }
      }
      if (titleTerms.length >= 10) break;
    }
    titleTerms.splice(10);
    const titleIdSet = new Set();
    const titlePatterns = [];
    for (const term of titleTerms) {
      const esc = term.replace(/[%_,()]/g, '\\$&');
      titlePatterns.push(`title.ilike.%${esc}%`);
      // Also match ai_summary for described artifacts/images.
      titlePatterns.push(`ai_summary.ilike.%${esc}%`);
    }
    if (titlePatterns.length) {
      try {
        const { data: titleRows } = await ctx.supabaseAdmin
          .from('vault_items')
          .select('id')
          .eq('user_id', ctx.userId)
          .or(titlePatterns.slice(0, 24).join(','))
          .order('updated_at', { ascending: false, nullsFirst: false })
          .limit(24);
        for (const n of titleRows || []) {
          if (n?.id) titleIdSet.add(String(n.id));
        }
      } catch (e) {
        console.warn('[vaultHybrid] title boost:', e?.message || e);
      }
    }
    const titleItems = [...titleIdSet].map((id) => ({ id }));
    if (titleItems.length) rankedLists.push({ label: 'title', items: titleItems, weight: 1.4 });
  }

  if (!bm25Available) {
    const probe = normalizeVaultSearchQuery(queryRaw) || queryRaw;
    const keywordOr = buildKeywordOr(probe);
    const { data: kwData, error: kwError } = await ctx.supabaseAdmin
      .from('vault_items')
      .select('id')
      .eq('user_id', ctx.userId)
      .or(keywordOr)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(MAX_RESULTS);
    if (kwError) console.warn('[vaultHybrid] keyword fallback:', kwError.message);
    const idSet = new Set((kwData || []).map((n) => String(n.id)).filter(Boolean));
    const tagTokens = probe
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 3 && !KEYWORD_STOPWORDS.has(t))
      .slice(0, 4);
    for (const tok of tagTokens) {
      try {
        const { data: tagRows } = await ctx.supabaseAdmin
          .from('vault_items')
          .select('id')
          .eq('user_id', ctx.userId)
          .contains('tags', [tok])
          .limit(15);
        for (const n of tagRows || []) {
          if (n?.id) idSet.add(String(n.id));
        }
      } catch {
        /* ignore */
      }
    }
    const items = [...idSet].map((id) => ({ id }));
    if (items.length) rankedLists.push({ label: 'ilike', items, weight: 1 });
  }

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
          match_threshold: denseThreshold,
        },
      );
      if (rpcError) {
        semanticError = rpcError.message;
        console.warn('[vaultHybrid] dense pass:', rpcError.message);
        continue;
      }
      const noteBest = new Map();
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
      // Dense carries related-concept recall; weight a bit higher on short topics.
      if (ordered.length) {
        rankedLists.push({
          label: `dense_q${qi}`,
          items: ordered,
          weight: shortTopic ? 1.3 : 1.2,
        });
      }
    } catch (e) {
      semanticError = e?.message || String(e);
      console.warn('[vaultHybrid] dense pass threw:', semanticError);
    }
  }

  const fused = reciprocalRankFusion(rankedLists, { limit: CANDIDATE_POOL });
  if (!fused.length) {
    return {
      ok: true,
      query: queryRaw,
      ...(queries.length > 1 ? { subQueries: queries.slice(1) } : {}),
      count: 0,
      hits: [],
      retrieval: {
        retrievers: rankedLists.map((l) => l.label),
        reranker: rerankProvider({ allowLlm: llmRerank }),
      },
    };
  }

  const { data: noteRows, error: hydErr } = await ctx.supabaseAdmin
    .from('vault_items')
    .select('id, title, content, created_at, updated_at, tags, ai_summary, folder, source')
    .eq('user_id', ctx.userId)
    .in('id', fused.map((f) => f.id));
  if (hydErr) console.warn('[vaultHybrid] hydrate:', hydErr.message);
  const rowById = new Map((noteRows || []).map((n) => [String(n.id), n]));

  let candidates = fused
    .map((f) => {
      const n = rowById.get(f.id);
      if (!n) return null;
      const sem = semanticMeta.get(f.id);
      return {
        id: f.id,
        note: n,
        sources: f.sources,
        snippet: (sem && sem.snippet) || snippetFor(n, queryRaw),
        similarity: sem ? Number(sem.similarity.toFixed(3)) : undefined,
      };
    })
    .filter(Boolean);

  const provider = rerankProvider({ allowLlm: llmRerank });
  if (provider !== 'none' && candidates.length > 1) {
    const reranked = await rerankCandidates(
      normalizeVaultSearchQuery(queryRaw) || queryRaw,
      candidates.map((c) => ({
        id: c.id,
        text: `${c.note.title || ''}\n${(c.note.tags || []).join(' ')}\n${c.snippet || ''}\n${String(c.note.ai_summary || '').slice(0, 200)}`,
        payload: c,
      })),
      { topN: Math.max(limit, 14), allowLlm: llmRerank },
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
      folder: c.note.folder || null,
      source: c.note.source || null,
      ...(c.similarity != null ? { similarity: c.similarity } : {}),
      ...(typeof c.rerankScore === 'number' ? { rerank: Number(c.rerankScore.toFixed(4)) } : {}),
    });
  });

  return {
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
  };
}

export const VAULT_HYBRID_MAX_RESULTS = MAX_RESULTS;
export const VAULT_HYBRID_DEFAULT_LIMIT = DEFAULT_LIMIT;
