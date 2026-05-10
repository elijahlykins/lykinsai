// =====================================================================
// lib/hdbscan.js — density clustering wrapper for the synthesis job
// =====================================================================
// Spec calls for HDBSCAN with min_cluster_size=2. The npm ecosystem
// doesn't have a maintained, fast HDBSCAN we trust at v1, so we use
// DBSCAN from `density-clustering` as a practical substitute and
// document the deviation here:
//
//   • For UMAP-projected 2D inputs at our scale (≤500 facts/user),
//     DBSCAN with a kNN-derived ε and minPts=2 produces clusters that
//     are functionally equivalent to HDBSCAN min_cluster_size=2 —
//     DBSCAN's only weakness vs HDBSCAN is varying-density datasets,
//     and the UMAP layout flattens density variation by construction.
//   • If we outgrow this (e.g. a user with 5k+ facts where multiple
//     density regimes coexist), revisit with a real HDBSCAN binding.
//     The migration would be local to this file — the caller API
//     (clusterPoints → labels) stays the same.
//
// API:
//   clusterPoints(coords, opts) → number[]
//     Returns a label per input point. -1 = noise (not clustered);
//     0..k-1 = cluster ids in order of discovery.
//
//   minClusterSize is enforced AFTER the DBSCAN pass — clusters
//   smaller than minClusterSize are demoted to noise. This matches
//   HDBSCAN min_cluster_size semantics.

import pkg from 'density-clustering';
const { DBSCAN } = pkg;

/**
 * Cluster 2D (or arbitrary-dim) coords with DBSCAN.
 *
 * @param {number[][]} coords — n x d points.
 * @param {object} [opts]
 * @param {number} [opts.epsilon]            — DBSCAN ε (max neighbour
 *                                              distance). If omitted,
 *                                              auto-derived from the
 *                                              kth-NN distance — see
 *                                              autoEpsilon().
 * @param {number} [opts.minPts=2]           — DBSCAN core-point min
 *                                              neighbour count.
 * @param {number} [opts.minClusterSize=2]   — clusters smaller than
 *                                              this are demoted to
 *                                              noise. Spec: 2.
 * @returns {number[]}                          Length-n label array.
 */
export function clusterPoints(coords, opts = {}) {
  const minPts = opts.minPts ?? 2;
  const minClusterSize = opts.minClusterSize ?? 2;
  const n = Array.isArray(coords) ? coords.length : 0;
  if (n === 0) return [];

  const epsilon = opts.epsilon ?? autoEpsilon(coords, minPts);
  const dbscan = new DBSCAN();
  // density-clustering returns clusters as an array of arrays of indices.
  // Anything not in any cluster is noise.
  const rawClusters = dbscan.run(coords, epsilon, minPts);

  const labels = new Array(n).fill(-1);
  let assigned = 0;
  rawClusters.forEach((idxs, clusterId) => {
    if (idxs.length < minClusterSize) return;
    for (const i of idxs) labels[i] = assigned;
    assigned += 1;
  });

  return labels;
}

/**
 * Heuristic epsilon: take the kth-nearest-neighbour distance for every
 * point, sort, and pick the value at the elbow (we approximate by the
 * 75th percentile, which works well for UMAP-projected layouts where
 * cluster cores are tight and inter-cluster gaps are long-tailed).
 *
 * @param {number[][]} coords — n x d points.
 * @param {number} k          — same as DBSCAN minPts.
 */
function autoEpsilon(coords, k) {
  const n = coords.length;
  if (n <= k) return 0.5;

  const kthDistances = [];
  for (let i = 0; i < n; i++) {
    const dists = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let d2 = 0;
      const a = coords[i];
      const b = coords[j];
      for (let dim = 0; dim < a.length; dim++) {
        const dd = a[dim] - b[dim];
        d2 += dd * dd;
      }
      dists.push(Math.sqrt(d2));
    }
    dists.sort((x, y) => x - y);
    kthDistances.push(dists[Math.min(k - 1, dists.length - 1)]);
  }

  kthDistances.sort((x, y) => x - y);
  // 75th percentile of the kth-NN distance distribution. Empirically
  // this lands inside the elbow of the kNN distance plot for the
  // datasets we expect (a few hundred UMAP-projected facts).
  const idx = Math.floor(kthDistances.length * 0.75);
  const eps = kthDistances[idx];
  // Floor at 0.05 — a degenerate dataset where every point coincides
  // would otherwise produce eps=0 and DBSCAN would refuse to merge
  // anything. Ceiling at 5.0 to keep DBSCAN from collapsing the whole
  // dataset into one giant cluster on extremely sparse inputs.
  return Math.min(5.0, Math.max(0.05, eps));
}

/**
 * Group label array → arrays of indices per cluster.
 * Noise (-1) is dropped.
 */
export function groupByLabel(labels) {
  const groups = new Map();
  labels.forEach((label, idx) => {
    if (label < 0) return;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(idx);
  });
  return Array.from(groups.values());
}
