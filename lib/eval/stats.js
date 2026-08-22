// ============================================================================
// lib/eval/stats.js — the arithmetic the report rests on
// ============================================================================
// Small, dependency-free, and tested against hand-computed values, because a
// wrong interval or a wrong test turns a null result into a finding.
// ============================================================================

export { wilson } from './calibration.js';

/**
 * Percentile of a numeric sample, nearest-rank.
 *
 * Returns null rather than NaN for an empty sample: `ground` is genuinely n=0
 * in the refs arms, and a table full of NaN reads as breakage rather than as
 * "this stage does not run here".
 */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(Math.max(rank, 1), xs.length) - 1];
}

export function summarize(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return { n: 0, p50: null, p95: null, p99: null, mean: null, total: 0 };
  const total = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    p99: percentile(xs, 99),
    mean: total / xs.length,
    total,
  };
}

/** log(n choose k), via log-gamma, so large n cannot overflow. */
function logChoose(n, k) {
  const lg = (x) => {
    // Lanczos approximation; plenty accurate for a binomial tail.
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lg(1 - x);
    const z = x - 1;
    let a = c[0];
    const t = z + g + 0.5;
    for (let i = 1; i < g + 2; i += 1) a += c[i] / (z + i);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
  };
  return lg(n + 1) - lg(k + 1) - lg(n - k + 1);
}

/**
 * McNemar's test on a pair of arms run over the SAME tasks.
 *
 * Only the discordant pairs carry information: b = A succeeded where B failed,
 * c = B succeeded where A failed. Tasks both arms got right, or both got wrong,
 * say nothing about which arm is better and are correctly ignored — which is
 * exactly why the paired test beats comparing two independent proportions here,
 * and why the arms must run the same task list.
 *
 * Exact binomial below 25 discordant pairs, where the chi-square approximation
 * is unreliable; continuity-corrected chi-square above.
 */
export function mcnemar(b, c) {
  const n = b + c;
  if (!n) return { b, c, n: 0, p: 1, method: 'none', significant: false };

  if (n < 25) {
    const k = Math.min(b, c);
    let tail = 0;
    for (let i = 0; i <= k; i += 1) tail += Math.exp(logChoose(n, i) + n * Math.log(0.5));
    const p = Math.min(1, 2 * tail);
    return { b, c, n, p, method: 'exact binomial', significant: p < 0.05 };
  }

  const chi2 = ((Math.abs(b - c) - 1) ** 2) / n;
  // Two-sided p for 1 df: erfc(sqrt(chi2/2)).
  const z = Math.sqrt(chi2);
  const p = Math.min(1, erfc(z / Math.SQRT2));
  return { b, c, n, chi2, p, method: 'chi-square (continuity corrected)', significant: p < 0.05 };
}

/** Complementary error function, Abramowitz & Stegun 7.1.26. */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196
    + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398
    + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/**
 * Build the discordant counts for two arms from per-task verdicts.
 *
 * Tasks missing from either arm are dropped, not guessed: an arm that crashed
 * on a task has no verdict there, and inventing one silently changes the test.
 */
export function pairCounts(aByTask, bByTask) {
  let b = 0; let c = 0; let both = 0; let neither = 0; let skipped = 0;
  for (const [taskId, av] of aByTask) {
    const bv = bByTask.get(taskId);
    if (av == null || bv == null) { skipped += 1; continue; }
    if (av && bv) both += 1;
    else if (av && !bv) b += 1;
    else if (!av && bv) c += 1;
    else neither += 1;
  }
  return { b, c, both, neither, skipped, paired: both + neither + b + c };
}

/**
 * How large a difference this run could actually have detected.
 *
 * Reported alongside a null result, because "no detectable difference" and "no
 * difference" are not the same claim and the gap between them is entirely
 * determined by n. At the sizes this eval runs at, that gap is wide enough that
 * omitting it would be misleading.
 *
 * Monte Carlo rather than a closed form: McNemar's power depends on the
 * DISCORDANT rate, not on n alone, and the discordant rate is something the run
 * measures rather than something we assume.
 *
 * @param {number} n paired tasks
 * @param {number} discordantRate fraction of tasks the two arms disagree on
 * @param {number[]} deltas true differences to probe, as fractions
 */
export function power(n, discordantRate, deltas = [0.05, 0.10, 0.15, 0.20, 0.25], trials = 3000, seed = 7) {
  let state = seed >>> 0;
  const rnd = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const out = [];
  for (const delta of deltas) {
    let hits = 0;
    for (let t = 0; t < trials; t += 1) {
      let b = 0; let c = 0;
      for (let i = 0; i < n; i += 1) {
        if (rnd() >= discordantRate) continue;
        const favourA = Math.min(1, Math.max(0, 0.5 + (delta / discordantRate) / 2));
        if (rnd() < favourA) b += 1; else c += 1;
      }
      if (mcnemar(b, c).significant) hits += 1;
    }
    out.push({ delta, power: hits / trials });
  }
  return out;
}
