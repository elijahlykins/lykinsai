// ============================================================================
// lib/rag/rrf.js — Reciprocal Rank Fusion
// ============================================================================
// Combines several ranked result lists (e.g. a BM25/lexical list and a dense
// vector list) into ONE ranking without needing the scores to be on the same
// scale. This is the deterministic, model-free replacement for the old
// "keyword hits first, then semantic by cosine" concatenation in searchVault —
// that ordering was arbitrary and buried strong semantic hits below weak
// lexical ones.
//
// RRF score for a document d:
//     score(d) = Σ_lists  weight_list / (k + rank_d_in_list)
// where rank is 1-based and k is a smoothing constant (60 is the value from
// the original Cormack et al. paper and what most engines use). Larger k
// flattens the contribution of top ranks; k=60 is a good general default.
//
// Why RRF over weighted score normalization: cosine similarity (0..1) and
// ts_rank (unbounded, corpus-dependent) live on totally different scales, so
// naively adding/normalizing them is fragile and needs per-corpus tuning. RRF
// only looks at POSITION, so it's robust and tuning-free — exactly what we
// want as the default fusion step.

export const RRF_DEFAULT_K = 60;

/**
 * @typedef {Object} RankedItem
 * @property {string} id      Stable identifier for the document (note id).
 * @property {*}      [payload] Optional opaque value carried through to output.
 */

/**
 * @typedef {Object} RankedList
 * @property {RankedItem[]} items  Items in rank order (best first).
 * @property {number}       [weight] List weight (default 1). Use to favour one
 *                                   retriever, e.g. weight the dense list 1.2.
 * @property {string}       [label]  Name of the retriever ("bm25" | "dense").
 */

/**
 * Fuse multiple ranked lists into a single ranking via Reciprocal Rank Fusion.
 *
 * @param {RankedList[]} lists
 * @param {Object} [opts]
 * @param {number} [opts.k=60]            RRF smoothing constant.
 * @param {number} [opts.limit]           Max fused results to return.
 * @returns {Array<{id: string, score: number, ranks: Record<string, number>,
 *                   sources: string[], payload: *}>}
 *          Fused results sorted by descending score. `ranks` maps each list
 *          label → the item's 1-based rank in that list (for debugging /
 *          telemetry). `sources` is the set of retrievers that surfaced it.
 */
export function reciprocalRankFusion(lists, { k = RRF_DEFAULT_K, limit } = {}) {
  const kk = Number.isFinite(k) && k > 0 ? k : RRF_DEFAULT_K;
  const acc = new Map(); // id -> { id, score, ranks, sources, payload }

  (Array.isArray(lists) ? lists : []).forEach((list, listIdx) => {
    if (!list || !Array.isArray(list.items)) return;
    const weight = Number.isFinite(list.weight) && list.weight > 0 ? list.weight : 1;
    const label = list.label || `list_${listIdx}`;
    list.items.forEach((item, idx) => {
      const id = item && item.id != null ? String(item.id) : '';
      if (!id) return;
      const rank = idx + 1; // 1-based
      const contribution = weight / (kk + rank);
      let entry = acc.get(id);
      if (!entry) {
        entry = { id, score: 0, ranks: {}, sources: [], payload: undefined };
        acc.set(id, entry);
      }
      entry.score += contribution;
      // Keep the BEST (lowest) rank seen per list if an id appears twice.
      if (entry.ranks[label] == null || rank < entry.ranks[label]) {
        entry.ranks[label] = rank;
      }
      if (!entry.sources.includes(label)) entry.sources.push(label);
      // First non-undefined payload wins; lets callers attach the hydrated row
      // from whichever list carried it.
      if (entry.payload === undefined && item.payload !== undefined) {
        entry.payload = item.payload;
      }
    });
  });

  const fused = [...acc.values()].sort((a, b) => b.score - a.score);
  return Number.isFinite(limit) && limit > 0 ? fused.slice(0, limit) : fused;
}
