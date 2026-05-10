// =====================================================================
// lib/umap.js — UMAP wrapper for the nightly synthesis job
// =====================================================================
// Reduces the 1536-dim text-embedding-3-small fact embeddings down to a
// 2D space that DBSCAN can cluster meaningfully. UMAP preserves local
// structure (semantic neighbours stay neighbours) while collapsing the
// global embedding manifold into something a density-based clusterer
// can walk in O(n²) without dimensionality of the curse killing it.
//
// Why UMAP instead of just running clustering on the raw 1536-d vectors:
//
//   • DBSCAN/HDBSCAN's epsilon (or mutual-reachability) gets useless in
//     high-dim space — pairwise distances concentrate, so every point
//     looks equidistant. UMAP-projected 2D reintroduces meaningful
//     density gradients.
//   • Smaller compute. At ~500 facts/user we're nowhere near the regime
//     where UMAP becomes the bottleneck; the LLM call dominates.
//
// API design notes:
//
//   • computeProjection(vectors, opts) — fits a fresh UMAP and returns
//     coords. Used by the cron when there's no cached projection (every
//     run today; in a future PR we'll cache + only recompute weekly).
//   • Returned coords are deterministic per (vectors, seed). Same
//     embeddings → same 2D positions, important for reproducibility
//     across debug runs of the same date.
//   • All vector inputs are expected to be Float64-y arrays of length
//     1536 (the text-embedding-3-small @ 1536d we standardize on).
//     We do NOT defensively re-normalize; the OpenAI endpoint returns
//     unit-normalized vectors and UMAP works with cosine-equivalent
//     distance off them directly via the L2 metric on unit vectors.

import { UMAP } from 'umap-js';

/**
 * Run UMAP fit + transform on `vectors`, returning a 2D coord array.
 *
 * @param {number[][]} vectors  — n x 1536 fact embeddings.
 * @param {object} [opts]
 * @param {number} [opts.nNeighbors=15]  — UMAP local neighbourhood size.
 *                                          Spec default; smaller n → tighter
 *                                          local clusters, larger n → more
 *                                          global structure preservation.
 * @param {number} [opts.minDist=0.1]    — minimum pairwise distance in 2D.
 *                                          Lower = denser clusters, easier
 *                                          for DBSCAN.
 * @param {number} [opts.spread=1.0]     — UMAP spread parameter.
 * @param {number} [opts.seed=42]        — RNG seed (deterministic runs).
 * @returns {number[][] | null}            n x 2 coords, or null on failure
 *                                          (e.g. fewer than nNeighbors+1
 *                                          inputs — UMAP can't fit).
 */
export function computeProjection(vectors, opts = {}) {
  if (!Array.isArray(vectors) || vectors.length === 0) return null;
  // UMAP requires at least nNeighbors + 1 points. With our default
  // nNeighbors=15 a user with ≤15 facts can't be projected. We adapt
  // the neighbour count downward for small n so the synthesis job
  // still produces useful clusters for early users — at 5 facts you
  // get nNeighbors=4 (matches the typical heuristic of n/2 for tiny
  // datasets), and at 2 facts UMAP degenerates trivially.
  const n = vectors.length;
  const requestedK = opts.nNeighbors ?? 15;
  const nNeighbors = Math.min(requestedK, Math.max(2, n - 1));

  if (n < 3) {
    // Degenerate: with < 3 points UMAP can't produce a meaningful 2D
    // layout. Return a synthetic line layout (x = index, y = 0) so the
    // pipeline can keep going — clustering will just fall back to
    // the raw points anyway and the threshold pass will reject it.
    return vectors.map((_, i) => [i, 0]);
  }

  // Make a deterministic-looking RNG by salting with the seed. umap-js
  // accepts a `random` function in opts.
  const seed = opts.seed ?? 42;
  const random = mulberry32(seed);

  const umap = new UMAP({
    nComponents: 2,
    nNeighbors,
    minDist: opts.minDist ?? 0.1,
    spread: opts.spread ?? 1.0,
    nEpochs: opts.nEpochs ?? 200,
    random,
  });

  try {
    return umap.fit(vectors);
  } catch (err) {
    console.warn('⚠️ umap.fit failed:', err?.message || err);
    return null;
  }
}

// Tiny seeded RNG (Mulberry32). umap-js calls this for layout init and
// negative sampling — using a seedable PRNG instead of Math.random
// makes the projection deterministic for a given (vectors, seed).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cosine similarity between two 1536-d vectors. Used by the synthesis
 * job's "is this proposal a duplicate of an existing belief?" check.
 * Inputs are assumed unit-normalized (which OpenAI embeddings are), so
 * cosine ≡ dot product.
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
