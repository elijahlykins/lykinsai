import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, mcnemar, pairCounts, wilson } from './stats.js';

test('percentile is nearest-rank and returns null on an empty sample', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 100);
  assert.equal(percentile(xs, 10), 10);
  // ground is genuinely n=0 in the refs arms; NaN there reads as breakage.
  assert.equal(percentile([], 50), null);
  assert.equal(summarize([]).p95, null);
});

test('summarize reports n so an empty stage is visible as empty', () => {
  const s = summarize([1, 2, 3, 4]);
  assert.equal(s.n, 4);
  assert.equal(s.mean, 2.5);
  assert.equal(s.total, 10);
  assert.equal(summarize([]).n, 0);
});

test('McNemar uses only the discordant pairs', () => {
  // 100 tasks where both arms agree, plus 10 vs 0 disagreements. The agreeing
  // 100 must not dilute the result — that is the point of the paired test.
  const few = mcnemar(10, 0);
  assert.equal(few.n, 10);
  assert.ok(few.significant, `p=${few.p}`);
  assert.equal(few.method, 'exact binomial');
  // Exact two-sided p for b=10, c=0 is 2 * 0.5^10 = 1/512.
  assert.ok(Math.abs(few.p - 2 / 1024) < 1e-9, `p=${few.p}`);
});

test('McNemar finds nothing when the disagreements are balanced', () => {
  const r = mcnemar(12, 11);
  assert.equal(r.significant, false);
  assert.ok(r.p > 0.5, `p=${r.p}`);
});

test('McNemar switches to chi-square above 25 discordant pairs', () => {
  const r = mcnemar(30, 10);
  assert.equal(r.method, 'chi-square (continuity corrected)');
  // chi2 = (|30-10|-1)^2 / 40 = 361/40 = 9.025 -> p ~ 0.00266
  assert.ok(Math.abs(r.chi2 - 9.025) < 1e-9);
  assert.ok(r.p > 0.002 && r.p < 0.004, `p=${r.p}`);
  assert.ok(r.significant);
});

test('McNemar with no disagreement at all is not a finding', () => {
  const r = mcnemar(0, 0);
  assert.equal(r.p, 1);
  assert.equal(r.significant, false);
});

test('pairCounts drops tasks an arm never produced a verdict for', () => {
  const a = new Map([['t1', 1], ['t2', 0], ['t3', 1], ['t4', 1]]);
  const b = new Map([['t1', 1], ['t2', 1], ['t3', 0], ['t4', null]]);
  const c = pairCounts(a, b);
  assert.equal(c.both, 1);
  assert.equal(c.c, 1, 't2: only B succeeded');
  assert.equal(c.b, 1, 't3: only A succeeded');
  assert.equal(c.skipped, 1, 't4 has no verdict for B and must not be guessed');
  assert.equal(c.paired, 3);
});

test('Wilson bounds stay inside [0,1] at the extremes', () => {
  assert.ok(wilson(0, 72).lo >= 0);
  assert.ok(wilson(72, 72).hi <= 1);
  const w = wilson(36, 72);
  assert.ok(Math.abs(w.p - 0.5) < 1e-9);
  // At n=72 the half-width should be roughly 11-12 points.
  assert.ok((w.hi - w.lo) > 0.20 && (w.hi - w.lo) < 0.24, `width=${w.hi - w.lo}`);
});

test('power is monotonic in effect size and honest about small differences', async () => {
  const { power } = await import('./stats.js');
  const rows = power(72, 0.30, [0.05, 0.15, 0.25], 800, 11);
  assert.ok(rows[0].power < rows[1].power && rows[1].power < rows[2].power, JSON.stringify(rows));
  // The point of reporting this: a 5pp difference is essentially invisible at
  // n=72, so a null result there must not be read as equivalence.
  assert.ok(rows[0].power < 0.25, `5pp power=${rows[0].power}`);
  assert.ok(rows[2].power > 0.6, `25pp power=${rows[2].power}`);
});

test('power is deterministic for a given seed', async () => {
  const { power } = await import('./stats.js');
  assert.deepEqual(power(72, 0.3, [0.1], 500, 3), power(72, 0.3, [0.1], 500, 3));
});
