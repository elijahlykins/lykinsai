// Tests for judge calibration. The label-parsing test is the one that matters:
// a silent coercion here inflated a judge's measured agreement by three points.

import test from 'node:test';
import assert from 'node:assert/strict';

import { wilson, agreement, skewTest } from './calibration.js';

const labels = (obj) => new Map(Object.entries(obj));

test('an indeterminate human label is excluded, never counted as correct', () => {
  // The published labels take THREE values — "0", "1" and "2". A first pass
  // let "2" fall through to the true-negative branch, so every indeterminate
  // task counted as a correct call and gpt-4o looked 3 points better than it is.
  const a = agreement(
    [{ taskId: 't1', verdict: 0 }, { taskId: 't2', verdict: 0 }, { taskId: 't3', verdict: 1 }],
    labels({ t1: '2', t2: '0', t3: '1' }),
  );
  assert.equal(a.indeterminate, 1);
  assert.equal(a.n, 2, 'the indeterminate task must not be in the denominator');
  assert.equal(a.correct, 2);
  assert.equal(a.tn, 1, 'and must not be counted as a true negative');
});

test('string and number labels are both understood', () => {
  const a = agreement([{ taskId: 't1', verdict: 1 }], labels({ t1: '1' }));
  const b = agreement([{ taskId: 't1', verdict: 1 }], new Map([['t1', 1]]));
  assert.equal(a.correct, 1);
  assert.equal(b.correct, 1);
});

test('a task with no human label is skipped rather than scored', () => {
  const a = agreement([{ taskId: 'unknown', verdict: 1 }], labels({ t1: '1' }));
  assert.equal(a.n, 0);
  assert.equal(a.indeterminate, 0);
});

test('the confusion matrix is counted the right way round', () => {
  const a = agreement(
    [{ taskId: 'a', verdict: 1 }, { taskId: 'b', verdict: 1 }, { taskId: 'c', verdict: 0 }, { taskId: 'd', verdict: 0 }],
    labels({ a: '1', b: '0', c: '1', d: '0' }),
  );
  assert.deepEqual({ tp: a.tp, fp: a.fp, fn: a.fn, tn: a.tn }, { tp: 1, fp: 1, fn: 1, tn: 1 });
  assert.equal(a.correct, 2);
});

test('inflation says whether reported success is over- or under-counted', () => {
  // Judge calls 3 successes where humans found 2 → 1.5x inflation.
  const over = agreement(
    [{ taskId: 'a', verdict: 1 }, { taskId: 'b', verdict: 1 }, { taskId: 'c', verdict: 1 }],
    labels({ a: '1', b: '1', c: '0' }),
  );
  assert.equal(over.inflation, 1.5);
  const under = agreement(
    [{ taskId: 'a', verdict: 1 }, { taskId: 'b', verdict: 0 }],
    labels({ a: '1', b: '1' }),
  );
  assert.equal(under.inflation, 0.5);
});

test('precision measures the runs the judge CALLED successful', () => {
  const a = agreement(
    [{ taskId: 'a', verdict: 1 }, { taskId: 'b', verdict: 1 }],
    labels({ a: '1', b: '0' }),
  );
  assert.equal(a.precision.p, 0.5);
  assert.equal(a.precision.n, 2);
});

test('wilson gives a sane interval at small n', () => {
  const w = wilson(9, 10);
  assert.ok(w.lo > 0.55 && w.lo < 0.9, `lo=${w.lo}`);
  assert.ok(w.hi > 0.9 && w.hi <= 1, `hi=${w.hi}`);
  assert.ok(w.lo < w.p && w.p < w.hi);
  // The normal approximation would run past 1 here; Wilson must not.
  assert.ok(wilson(10, 10).hi <= 1);
  assert.deepEqual(wilson(0, 0), { p: 0, lo: 0, hi: 0, n: 0 });
});

test('skewTest flags a lopsided error pattern and ignores a balanced one', () => {
  assert.equal(skewTest(73, 38).significant, true);
  assert.equal(skewTest(73, 38).favours, 'false_positive');
  assert.equal(skewTest(40, 38).significant, false);
  assert.equal(skewTest(0, 0).discordant, 0);
});
