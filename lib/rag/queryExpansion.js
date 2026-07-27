// ============================================================================
// lib/rag/queryExpansion.js — multi-query / related-term expansion for RAG
// ============================================================================
// A single user query is often a poor retrieval probe: it may bundle several
// sub-questions, or use words that don't match how the saved content is
// phrased ("prosthetics" vs "artificial limbs" / "prosthetic companies").
//
// Two modes:
//   • default  — decompose compound questions + light paraphrases
//   • related  — synonyms / morphological variants / related concepts
//                (used by vault hybrid search so related-word lookup works)
//
// DEGRADE-SAFE: with no OPENAI_API_KEY (or RAG_QUERY_EXPANSION=0) returns
// just the original query (+ cheap morphological variants for related mode).

const EXPANSION_MODEL = process.env.RAG_QUERY_EXPANSION_MODEL || 'gpt-4o-mini';
const MAX_SUBQUERIES = 4;
const MAX_RELATED = 6;

/** In-memory cache so the same topic doesn't re-hit the LLM every turn. */
const _expandCache = new Map(); // key -> { at, queries }
const EXPAND_CACHE_TTL_MS = 15 * 60 * 1000;
const EXPAND_CACHE_MAX = 256;

/** Cheap heuristic: is this query worth expanding at all? */
function looksCompoundOrVague(q) {
  const s = String(q || '').trim();
  if (s.length < 3) return false;
  const words = s.split(/\s+/).length;
  return (
    words >= 6 ||
    /\b(and|or|also|plus|vs\.?|versus|both|as well as)\b/i.test(s) ||
    /[,;]/.test(s)
  );
}

/**
 * Morphological / plural variants with no LLM — always available.
 * "prosthetics" → prosthetic; "companies" → company; etc.
 */
export function morphologicalVariants(query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return [];
  const out = new Set();
  const add = (s) => {
    const t = String(s || '').trim();
    if (t && t.length >= 2) out.add(t);
  };
  add(raw);
  for (const tok of raw.split(/[^a-z0-9]+/i).filter((t) => t.length >= 3)) {
    add(tok);
    // Prefer specific plural rules so "companies" → "company" (not "compani").
    if (tok.endsWith('ies') && tok.length > 4) {
      add(`${tok.slice(0, -3)}y`);
    } else if (tok.endsWith('ses') || tok.endsWith('xes') || tok.endsWith('zes') || tok.endsWith('ches') || tok.endsWith('shes')) {
      add(tok.slice(0, -2));
    } else if (tok.endsWith('s') && !tok.endsWith('ss') && tok.length > 3) {
      add(tok.slice(0, -1));
    }
    // Pluralize carefully: city→cities, company→companies, car→cars.
    if (!tok.endsWith('s')) {
      if (/[bcdfghjklmnpqrstvwxz]y$/i.test(tok) && tok.length > 3) {
        add(`${tok.slice(0, -1)}ies`);
      } else if (/(?:s|x|z|ch|sh)$/i.test(tok)) {
        add(`${tok}es`);
      } else {
        add(`${tok}s`);
      }
    }
    if (tok.endsWith('ing') && tok.length > 5) add(tok.slice(0, -3));
    if (tok.endsWith('tion') && tok.length > 5) add(`${tok.slice(0, -4)}te`);
  }
  return [...out].filter((t) => t !== raw).slice(0, 8);
}

function cacheGet(key) {
  const hit = _expandCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > EXPAND_CACHE_TTL_MS) {
    _expandCache.delete(key);
    return null;
  }
  return hit.queries;
}

function cacheSet(key, queries) {
  _expandCache.set(key, { at: Date.now(), queries });
  while (_expandCache.size > EXPAND_CACHE_MAX) {
    const oldest = _expandCache.keys().next().value;
    _expandCache.delete(oldest);
  }
}

async function callExpansionLlm(original, systemPrompt, max, timeoutMs) {
  const res = await Promise.race([
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EXPANSION_MODEL,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
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
    return [];
  }
  const out = [];
  for (const s of subs) {
    const t = String(s || '').trim().slice(0, 200);
    if (t && !out.some((q) => q.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= max) break;
  }
  return out;
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
 * @param {boolean} [opts.enabled]
 * @param {'default'|'related'} [opts.mode='default']
 * @returns {Promise<string[]>}
 */
export async function expandQuery(
  query,
  {
    force = false,
    max = MAX_SUBQUERIES,
    timeoutMs = 6000,
    enabled: enabledOpt,
    mode = 'default',
  } = {},
) {
  const original = String(query || '').trim();
  if (!original) return [];

  const enabled =
    process.env.RAG_QUERY_EXPANSION === '0'
      ? false
      : typeof enabledOpt === 'boolean'
        ? enabledOpt && !!process.env.OPENAI_API_KEY
        : process.env.RAG_QUERY_EXPANSION === '1' && !!process.env.OPENAI_API_KEY;

  // Related mode: always include morphological variants even without LLM.
  const morph = mode === 'related' ? morphologicalVariants(original) : [];

  if (!enabled) {
    return mode === 'related' ? mergeQueries(original, morph, max) : [original];
  }

  if (mode !== 'related' && !force && !looksCompoundOrVague(original)) {
    return [original];
  }

  const cacheKey = `${mode}|${max}|${original.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return mergeQueries(original, [...cached, ...morph], max);

  const systemPrompt =
    mode === 'related'
      ? [
          'You expand a personal-vault search topic into RELATED retrieval queries.',
          'Include: synonyms, morphological variants (singular/plural), closely related',
          'concepts, and common alternate phrasings people use for the same thing.',
          'Examples: "prosthetics" → prosthetic, artificial limb, bionic arm, prosthesis;',
          '"car" → automobile, vehicle, porsche (only if implied — do NOT invent brands).',
          'Keep each query SHORT (1-4 words). No full sentences. No duplicates of the input.',
          'Respond ONLY as JSON: {"queries":["...","..."]}.',
        ].join(' ')
      : [
          'You rewrite a user search query into a few focused sub-queries for retrieving',
          'from a personal knowledge vault. Split compound questions into parts and add',
          'at most one alternate phrasing per part. Keep each sub-query short and',
          'self-contained. Respond ONLY as JSON: {"queries":["...","..."]}.',
        ].join(' ');

  try {
    const subs = await callExpansionLlm(
      original,
      systemPrompt,
      mode === 'related' ? Math.max(max, MAX_RELATED) : max,
      timeoutMs,
    );
    cacheSet(cacheKey, subs);
    return mergeQueries(original, [...subs, ...morph], mode === 'related' ? MAX_RELATED + 1 : max);
  } catch (e) {
    console.warn('[rag:queryExpansion] failed:', e?.message || e);
    return mode === 'related' ? mergeQueries(original, morph, max) : [original];
  }
}

function mergeQueries(original, extras, max) {
  const out = [];
  const seen = new Set();
  for (const q of [original, ...(extras || [])]) {
    const t = String(q || '').trim().slice(0, 200);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out.length ? out : [original];
}
