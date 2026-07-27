// ============================================================================
// lib/rag/rerank.js — pluggable cross-encoder reranking
// ============================================================================
// After first-stage retrieval (BM25 + dense, fused with RRF) we have a good
// candidate set but the ORDER is still based on lexical position + cosine,
// neither of which actually reads the query against each passage. A reranker
// (cross-encoder) scores every (query, passage) pair jointly, which is the
// single biggest precision lever once recall is solid — it consistently
// reorders the truly-relevant passage into the top slot.
//
// This module is provider-agnostic and DEGRADE-SAFE. It tries, in order:
//   1. Cohere Rerank      (COHERE_API_KEY)      — purpose-built, cheapest/fastest
//   2. Voyage Rerank      (VOYAGE_API_KEY)      — strong alternative
//   3. LLM listwise rerank(OPENAI_API_KEY)      — fallback using a cheap model
//   4. Identity            (no keys / failure)  — returns input order unchanged
//
// Callers ALWAYS get a valid ordering back, so reranking can be turned on by
// simply adding a key and never breaks retrieval if a provider is down.

const COHERE_RERANK_MODEL = process.env.COHERE_RERANK_MODEL || 'rerank-english-v3.0';
const VOYAGE_RERANK_MODEL = process.env.VOYAGE_RERANK_MODEL || 'rerank-2';
const LLM_RERANK_MODEL = process.env.RAG_RERANK_LLM_MODEL || 'gpt-4o-mini';

/**
 * Which reranker, if any, is available given the current environment.
 * @param {{ allowLlm?: boolean }} [opts]  When true, LLM listwise rerank is
 *   allowed without RAG_LLM_RERANK=1 (used by vault hybrid search).
 * @returns {'cohere'|'voyage'|'llm'|'none'}
 */
export function rerankProvider({ allowLlm = false } = {}) {
  if (process.env.COHERE_API_KEY) return 'cohere';
  if (process.env.VOYAGE_API_KEY) return 'voyage';
  if (
    process.env.OPENAI_API_KEY &&
    (process.env.RAG_LLM_RERANK === '1' || allowLlm) &&
    process.env.RAG_LLM_RERANK !== '0'
  ) {
    return 'llm';
  }
  return 'none';
}

/**
 * @typedef {Object} RerankCandidate
 * @property {string} id
 * @property {string} text   Passage text the reranker scores against the query.
 * @property {*}      [payload]
 */

/**
 * Rerank `candidates` against `query`. Returns a NEW array ordered best-first,
 * each item augmented with `rerankScore` (provider-specific scale) and
 * `rerankProvider`. Falls back to identity order on any failure.
 *
 * @param {string} query
 * @param {RerankCandidate[]} candidates
 * @param {Object} [opts]
 * @param {number} [opts.topN]  Truncate to this many after reranking.
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<Array<RerankCandidate & {rerankScore?: number, rerankProvider: string}>>}
 */
export async function rerankCandidates(
  query,
  candidates,
  { topN, timeoutMs = 8000, allowLlm = false } = {},
) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.text) : [];
  const identity = () => {
    const out = list.map((c) => ({ ...c, rerankProvider: 'none' }));
    return Number.isFinite(topN) && topN > 0 ? out.slice(0, topN) : out;
  };
  if (list.length <= 1 || !String(query || '').trim()) return identity();

  const provider = rerankProvider({ allowLlm });
  try {
    let ordered = null;
    if (provider === 'cohere') ordered = await rerankCohere(query, list, timeoutMs);
    else if (provider === 'voyage') ordered = await rerankVoyage(query, list, timeoutMs);
    else if (provider === 'llm') ordered = await rerankLLM(query, list, timeoutMs);
    if (!ordered || !ordered.length) return identity();
    return Number.isFinite(topN) && topN > 0 ? ordered.slice(0, topN) : ordered;
  } catch (e) {
    console.warn('[rag:rerank] provider', provider, 'failed:', e?.message || e);
    return identity();
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('rerank_timeout')), ms)),
  ]);
}

async function rerankCohere(query, list, timeoutMs) {
  const res = await withTimeout(
    fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: COHERE_RERANK_MODEL,
        query,
        documents: list.map((c) => c.text.slice(0, 4000)),
        top_n: list.length,
      }),
    }),
    timeoutMs,
  );
  if (!res.ok) throw new Error(`cohere_http_${res.status}`);
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .map((r) => {
      const c = list[r.index];
      if (!c) return null;
      return { ...c, rerankScore: r.relevance_score, rerankProvider: 'cohere' };
    })
    .filter(Boolean);
}

async function rerankVoyage(query, list, timeoutMs) {
  const res = await withTimeout(
    fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: VOYAGE_RERANK_MODEL,
        query,
        documents: list.map((c) => c.text.slice(0, 4000)),
        top_k: list.length,
      }),
    }),
    timeoutMs,
  );
  if (!res.ok) throw new Error(`voyage_http_${res.status}`);
  const data = await res.json();
  const results = Array.isArray(data?.data) ? data.data : [];
  return results
    .map((r) => {
      const c = list[r.index];
      if (!c) return null;
      return { ...c, rerankScore: r.relevance_score, rerankProvider: 'voyage' };
    })
    .filter(Boolean);
}

// Listwise LLM reranker: asks a cheap model to return the candidate indices in
// descending relevance. Bounded, cheap, and fully optional (RAG_LLM_RERANK=1).
async function rerankLLM(query, list, timeoutMs) {
  const numbered = list
    .map((c, i) => `[${i}] ${String(c.text).replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n');
  const res = await withTimeout(
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_RERANK_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a search reranker. Given a query and numbered passages, return the passage indices ordered from MOST to LEAST relevant to the query. Respond ONLY as JSON: {"order":[indices]}. Include every index exactly once.',
          },
          { role: 'user', content: `Query: ${query}\n\nPassages:\n${numbered}` },
        ],
      }),
    }),
    timeoutMs,
  );
  if (!res.ok) throw new Error(`openai_http_${res.status}`);
  const data = await res.json();
  let order = [];
  try {
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    order = Array.isArray(parsed?.order) ? parsed.order : [];
  } catch {
    throw new Error('llm_rerank_parse');
  }
  const seen = new Set();
  const ordered = [];
  for (const idx of order) {
    const i = Number(idx);
    if (Number.isInteger(i) && i >= 0 && i < list.length && !seen.has(i)) {
      seen.add(i);
      ordered.push({ ...list[i], rerankProvider: 'llm' });
    }
  }
  // Append any the model dropped, preserving prior order.
  list.forEach((c, i) => {
    if (!seen.has(i)) ordered.push({ ...c, rerankProvider: 'llm' });
  });
  return ordered;
}
