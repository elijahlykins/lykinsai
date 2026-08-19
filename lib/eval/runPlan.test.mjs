// Tests for unit ordering, resume, and chunking.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUnits, pendingUnits, chunkUnits, parseResults, unitKey, hostOf } from './runPlan.js';

const TASKS = [
  { taskId: 't1', goal: 'g1', startUrl: 'https://a.com/', level: 'easy', referenceLength: 4 },
  { taskId: 't2', goal: 'g2', startUrl: 'https://b.com/', level: 'hard', referenceLength: 9 },
  { taskId: 't3', goal: 'g3', startUrl: 'https://c.com/', level: 'medium', referenceLength: 6 },
];
const ARMS = [
  { id: 'luna-refs', grounding: 'refs' },
  { id: 'luna-holo', grounding: 'holo' },
  { id: 'gemini-refs', grounding: 'refs' },
  { id: 'gemini-holo', grounding: 'holo' },
];

test('every task/arm pair appears exactly once', () => {
  const units = buildUnits(TASKS, ARMS);
  assert.equal(units.length, TASKS.length * ARMS.length);
  assert.equal(new Set(units.map(unitKey)).size, units.length);
});

test('arms are interleaved within a task, not run to completion one at a time', () => {
  const units = buildUnits(TASKS, ARMS);
  // The first four units must all be task 1, one per arm — that is the whole
  // point: arm 4 must not run three days after arm 1.
  assert.deepEqual(units.slice(0, 4).map((u) => u.taskId), ['t1', 't1', 't1', 't1']);
  assert.deepEqual(units.slice(0, 4).map((u) => u.arm), ARMS.map((a) => a.id));
  assert.deepEqual(units.slice(4, 8).map((u) => u.taskId), ['t2', 't2', 't2', 't2']);
});

test('grounding mode travels with the arm', () => {
  const units = buildUnits(TASKS, ARMS);
  for (const u of units) {
    assert.equal(u.grounding, ARMS.find((a) => a.id === u.arm).grounding);
  }
});

test('task metadata the judge needs is carried onto every unit', () => {
  const [u] = buildUnits(TASKS, ARMS);
  assert.equal(u.goal, 'g1');
  assert.equal(u.startUrl, 'https://a.com/');
  assert.equal(u.level, 'easy');
  assert.equal(u.referenceLength, 4);
});

test('resume skips exactly the finished units and no others', () => {
  const units = buildUnits(TASKS, ARMS);
  const done = new Set(['t1::luna-refs', 't2::gemini-holo']);
  const pending = pendingUnits(units, done);
  assert.equal(pending.length, units.length - 2);
  assert.ok(!pending.some((u) => done.has(unitKey(u))));
});

test('resume treats one arm failing as only that arm needing a re-run', () => {
  // A task that succeeded on three arms and crashed on one must come back for
  // one unit, not four — re-running the other three would change their timing.
  const units = buildUnits([TASKS[0]], ARMS);
  const done = new Set(['t1::luna-refs', 't1::luna-holo', 't1::gemini-refs']);
  assert.deepEqual(pendingUnits(units, done).map((u) => u.arm), ['gemini-holo']);
});

test('parseResults survives a torn final line', () => {
  const text = [
    JSON.stringify({ type: 'result', taskId: 't1', arm: 'luna-refs', ok: true }),
    JSON.stringify({ type: 'result', taskId: 't2', arm: 'luna-refs', ok: false }),
    '{"type":"result","taskId":"t3","ar',   // killed mid-write
  ].join('\n');
  const done = parseResults(text);
  assert.equal(done.size, 2);
  assert.ok(done.has('t1::luna-refs'));
});

test('parseResults ignores non-result lines', () => {
  const text = [
    JSON.stringify({ type: 'chunk_start', tasks: 5 }),
    JSON.stringify({ type: 'block', taskId: 't1', arm: 'luna-refs', rule: 'outbound' }),
    JSON.stringify({ type: 'result', taskId: 't1', arm: 'luna-refs', ok: true }),
  ].join('\n');
  assert.equal(parseResults(text).size, 1);
});

test('chunking covers every unit exactly once', () => {
  const units = buildUnits(TASKS, ARMS);
  const chunks = chunkUnits(units, 5);
  assert.equal(chunks.flat().length, units.length);
  assert.deepEqual(chunks.flat().map(unitKey), units.map(unitKey));
  assert.ok(chunks.every((c) => c.length <= 5));
});

test('chunk size 0 or nonsense still produces valid chunks', () => {
  const units = buildUnits(TASKS, ARMS);
  for (const size of [0, -3, NaN, undefined]) {
    assert.equal(chunkUnits(units, size).flat().length, units.length);
  }
});

test('hostOf normalises for the same-site cooldown', () => {
  assert.equal(hostOf('https://www.Gamestop.com/stores'), 'gamestop.com');
  assert.equal(hostOf('https://new.mta.info/x'), 'new.mta.info');
  assert.equal(hostOf('not a url'), '');
});
