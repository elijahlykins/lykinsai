// ============================================================================
// lib/rag/queryExpansion.js — multi-query / decomposition for agentic RAG
// ============================================================================
// A single user query is often a poor retrieval probe: it may bundle several
// sub-questions ("what did I save about porsche pricing AND insurance?") or use
// words that don't match how the saved content is phrased. Multi-query
// expansion generates a handful of focused paraphrases / sub-queries, retrieves
// for each, and fuses the results (via RRF upstream). This is the cheap,
// well-established first step toward Level-5 agentic RAG — the retriever reasons
// about the question instead of embedding it verbatim.
//
// DEGRADE-SAFE: with no OPENAI_API_KEY (or RAG_QUERY_EXPANSION!=1) this returns
// just the original query, so callers always have at least one probe.

const EXPANSION_MODEL = process.env.RAG_QUERY_EXPANSION_MODEL || 'gpt-4o-mini';
const MAX_SUBQUERIES = 4;

/** Cheap heuristic: is this query worth expanding at all? */
function looksCompoundOrVague(q) {
  const s = String(q || '').trim();
  if (s.length < 3) return false;
  const words = s.split(/\s+/).length;
  return (
    words >= 6 || // longer questions benefit from decomposition
    /\b(and|or|also|plus|vs\.?|versus|both|as well as)\b/i.test(s) ||
    /[,;]/.test(s)
  );
}

/**
 * Expand a query into 1..N retrieval probes. The original query is ALWAYS the
 * first element. Returns `[query]` unchanged when expansion is disabled,
 * unavailable, unnecessary, or fails.
 *
 * @param {string} query
 * @param {Object} [opts]
 * @param {boolean} [opts.force=false]  Expand even if the heuristic says no.
 * @param {number}  [opts.max=4]
 * @param {number}  [opts.timeoutMs=6000]
 * @returns {Promise<string[]>}
 */
export async function expandQuery(query, { force = false, max = MAX_SUBQUERIES, timeoutMs = 6000 } = {}) {
  const original = String(query || '').trim();
  if (!original) return [];
  const enabled = process.env.RAG_QUERY_EXPANSION === '1' && !!process.env.OPENAI_API_KEY;
  if (!enabled) return [original];
  if (!force && !looksCompoundOrVague(original)) return [original];

  try {
    const res = await Promise.race([
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EXPANSION_MODEL,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You rewrite a user search query into a few focused sub-queries for retrieving from a personal knowledge vault. Split compound questions into parts and add at most one alternate phrasing per part. Keep each sub-query short and self-contained. Respond ONLY as JSON: {"queries":["...","..."]}.',
            },
            { role: 'user', content: original },
          ],
        }),
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('expand_timeout')), timeoutMs)),
    ]);
    if (!res.ok) throw new Error(`openai_http_${res.status}`);
    const data = await res.json();
    let subs = [];
    try {
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
      subs = Array.isArray(parsed?.queries) ? parsed.queries : [];
    } catch {
      return [original];
    }
    const out = [original];
    for (const s of subs) {
      const t = String(s || '').trim().slice(0, 200);
      if (t && !out.some((q) => q.toLowerCase() === t.toLowerCase())) out.push(t);
      if (out.length >= max) break;
    }
    return out;
  } catch (e) {
    console.warn('[rag:queryExpansion] failed:', e?.message || e);
    return [original];
  }
}
