// ============================================================================
// lib/eval/calibration.js — how far to trust the autorater
// ============================================================================
// The benchmark publishes both its judges' verdicts AND human labels for the
// same 300 tasks across six agents. That is a free, already-paid-for
// calibration set of 1,800 judged/labelled pairs, and it answers the question
// the eval otherwise rests on unexamined: when the judge says a run succeeded,
// how often is it right?
//
// Worth computing rather than citing. The headline "~85% agreement" is one
// number for one configuration; measured per judge model it is materially
// lower, and the errors are lopsided in a direction that matters.
// ============================================================================

/** Wilson score interval — sane at small n, unlike the normal approximation. */
export function wilson(successes, total, z = 1.96) {
  if (!total) return { p: 0, lo: 0, hi: 0, n: 0 };
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return { p, lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d), n: total };
}

/**
 * A human label is usable only if it is a clean success/failure.
 *
 * The published labels are strings and take THREE values, not two: "0", "1",
 * and "2". "2" appears on 10 Operator tasks and 7 Claude CU 3.7 tasks and is
 * not a verdict — treating it as one is how a first pass here counted every
 * such task as a true negative, inflating gpt-4o's measured agreement by three
 * points and very nearly picking the wrong judge on the strength of it.
 * Indeterminate labels are excluded and counted separately.
 */
function asBinary(v) {
  if (v === 0 || v === 1) return v;
  const s = String(v).trim();
  if (s === '0') return 0;
  if (s === '1') return 1;
  return null;
}

/**
 * Compare one judge's verdicts against human labels.
 *
 * @param {Array<{taskId:string, verdict:0|1}>} verdicts
 * @param {Map<string, unknown>} humanLabels
 */
export function agreement(verdicts, humanLabels) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0; let indeterminate = 0;
  for (const v of verdicts) {
    const raw = humanLabels.get(v.taskId);
    if (raw === undefined) continue;
    const h = asBinary(raw);
    const j = asBinary(v.verdict);
    if (h === null || j === null) { indeterminate += 1; continue; }
    if (j === 1 && h === 1) tp += 1;
    else if (j === 1 && h === 0) fp += 1;
    else if (j === 0 && h === 1) fn += 1;
    else tn += 1;
  }
  const n = tp + fp + fn + tn;
  const correct = tp + tn;
  return {
    n,
    correct,
    indeterminate,
    accuracy: wilson(correct, n),
    tp, fp, fn, tn,
    // Of the runs this judge CALLED successful, how many really were. This is
    // the number that matters for a success-rate eval: false positives inflate
    // every arm's headline figure.
    precision: wilson(tp, tp + fp),
    recall: wilson(tp, tp + fn),
    /**
     * How much the judge over- or under-counts successes overall. 1.0 is
     * unbiased; above 1 means reported success rates are inflated.
     */
    inflation: (tp + fn) ? (tp + fp) / (tp + fn) : null,
  };
}

/**
 * Whether an error rate this lopsided could plausibly be chance.
 *
 * A judge that misses and over-calls equally adds noise; one that mostly
 * over-calls adds BIAS, which no amount of sampling removes and which favours
 * whichever arm produces the most confident-sounding final answers. McNemar's
 * exact binomial on the discordant pairs is the right test, and at these counts
 * the normal approximation is fine.
 */
export function skewTest(fp, fn) {
  const d = fp + fn;
  if (!d) return { discordant: 0, z: 0, significant: false };
  const z = (Math.abs(fp - fn) - 1) / Math.sqrt(d);
  return { discordant: d, z, significant: z > 1.96, favours: fp > fn ? 'false_positive' : 'false_negative' };
}

export const pct = (x) => `${(x * 100).toFixed(1)}%`;
