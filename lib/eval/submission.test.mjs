// Tests for the v2 submission emitter, with the blinding checks front and
// centre — an unblinded trajectory invalidates the whole arm comparison.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderAction, buildSubmission, validateSubmission, findLeaks, blindingTerms }
  from './submission.js';

const shot = (i) => `${String(i).padStart(4, '0')}.jpg`;

/** The SAME task, done the same way, by a refs arm and a holo arm. */
const REFS_RESULT = {
  taskId: 'abc123', goal: 'Find the nearest store.', answer: '123 Main St, open 9-9',
  arm: 'luna-refs', grounding: 'refs',
  steps: [
    { step: 0, screenshot: shot(0), url: 'https://shop.example/', status: 'SUCCESS',
      action: { type: 'click', target: 'e12' }, target: { label: 'Store finder', x: 240, y: 180 },
      thought: 'Open the store finder' },
    { step: 1, screenshot: shot(1), url: 'https://shop.example/stores', status: 'SUCCESS',
      action: { type: 'type', target: 'e4', text: '90028' }, target: { label: 'ZIP code', x: 300, y: 400 },
      thought: 'Enter the zip' },
    { step: 2, screenshot: shot(2), url: 'https://shop.example/stores', action: 'FINAL_STATE', thought: null },
  ],
};

const HOLO_RESULT = {
  taskId: 'abc123', goal: 'Find the nearest store.', answer: '123 Main St, open 9-9',
  arm: 'gemini-holo', grounding: 'holo',
  steps: [
    { step: 0, screenshot: shot(0), url: 'https://shop.example/', status: 'SUCCESS',
      action: { type: 'click_coord', x: 240, y: 180, label: 'Store finder' },
      target: { label: 'Store finder', x: 240, y: 180 }, thought: 'Open the store finder' },
    { step: 1, screenshot: shot(1), url: 'https://shop.example/stores', status: 'SUCCESS',
      action: { type: 'type_coord', x: 300, y: 400, text: '90028', label: 'ZIP code' },
      target: { label: 'ZIP code', x: 300, y: 400 }, thought: 'Enter the zip' },
    { step: 2, screenshot: shot(2), url: 'https://shop.example/stores', action: 'FINAL_STATE', thought: null },
  ],
};

// ---------------------------------------------------------------------------
// Blinding
// ---------------------------------------------------------------------------

test('refs and holo produce a byte-identical trajectory for the same run', () => {
  // The crux. If these differ, the judge can identify the arm from the text and
  // every between-arm comparison is confounded.
  const a = buildSubmission(REFS_RESULT, { referenceLength: 6 });
  const b = buildSubmission(HOLO_RESULT, { referenceLength: 6 });
  assert.deepEqual(a, b);
});

test('no action string reveals how the agent aimed', () => {
  for (const r of [REFS_RESULT, HOLO_RESULT]) {
    for (const s of buildSubmission(r, { referenceLength: 6 }).action_history) {
      assert.doesNotMatch(s.action, /\be\d+\b/, `element ref leaked: ${s.action}`);
      assert.doesNotMatch(s.action, /click_coord|type_coord/, `internal verb leaked: ${s.action}`);
    }
  }
});

test('the assembled submission carries no arm or model identifier', () => {
  const terms = blindingTerms({
    arms: ['luna-refs', 'luna-holo', 'gemini-refs', 'gemini-holo'],
    models: ['gpt-5.6-luna', 'gemini-3.7-flash', 'claude-opus-5', 'holo3-1-35b-a3b'],
  });
  for (const r of [REFS_RESULT, HOLO_RESULT]) {
    assert.deepEqual(findLeaks(buildSubmission(r, { referenceLength: 6 }), terms), []);
  }
});

test('findLeaks actually detects a leak when one is present', () => {
  // A blinding check that cannot fail is not a check.
  const terms = blindingTerms({ arms: ['luna-refs'], models: [] });
  const leaky = { ...buildSubmission(REFS_RESULT, { referenceLength: 6 }), note: 'produced by luna-refs' };
  assert.deepEqual(findLeaks(leaky, terms), ['luna-refs', 'luna']);
});

// ---------------------------------------------------------------------------
// Action rendering
// ---------------------------------------------------------------------------

test('actions render in the upstream Grammar A shape', () => {
  assert.equal(
    renderAction({ action: { type: 'click' }, target: { label: 'Store finder', x: 240, y: 180 }, status: 'SUCCESS' }),
    'CLICK coords(240, 180) -> click Store finder | SUCCESS',
  );
  assert.equal(
    renderAction({ action: { type: 'navigate', url: 'https://x.example/' }, status: 'SUCCESS' }),
    'page -> NAVIGATE -> direct navigation to the destination page | SUCCESS',
  );
  assert.equal(
    renderAction({ action: { type: 'scroll', direction: 'down' }, status: 'SUCCESS' }),
    'page -> SCROLL -> scroll down on the page | SUCCESS',
  );
});

test('a failed action is reported as failed, not quietly as success', () => {
  const s = { action: { type: 'click' }, target: { label: 'Buy', x: 1, y: 2 }, status: 'FAILED' };
  assert.match(renderAction(s), /\| FAILED$/);
  // An unrecorded outcome must not be presented as a success either.
  assert.match(renderAction({ ...s, status: null }), /\| FAILED$/);
});

test('a NAVIGATE action does not embed the URL in the action string', () => {
  // The schema deprecates that; the URL belongs in the step's url field.
  const out = renderAction({ action: { type: 'navigate', url: 'https://secret.example/x' }, status: 'SUCCESS' });
  assert.doesNotMatch(out, /secret\.example/);
});

test('observation steps carry no status suffix', () => {
  assert.equal(renderAction({ action: 'FINAL_STATE' }), 'WAIT page -> final state of the page after the run');
  assert.doesNotMatch(renderAction({ action: 'FINAL_STATE' }), /SUCCESS|FAILED/);
});

// ---------------------------------------------------------------------------
// Schema conformance
// ---------------------------------------------------------------------------

test('a built submission passes the schema checks', () => {
  assert.deepEqual(validateSubmission(buildSubmission(REFS_RESULT, { referenceLength: 6 })), []);
});

test('the terminal step carries the answer and matches agent_final_answer', () => {
  const sub = buildSubmission(REFS_RESULT, { referenceLength: 6 });
  const last = sub.action_history.at(-1);
  assert.match(last.action, /^TASK_COMPLETE -> ANSWER: /);
  assert.ok(last.action.includes(sub.agent_final_answer));
  assert.equal(last.action_status, null, 'TASK_COMPLETE takes no status');
});

test('steps without a screenshot are dropped and indices stay contiguous', () => {
  const r = { ...REFS_RESULT, steps: [
    REFS_RESULT.steps[0],
    { ...REFS_RESULT.steps[1], screenshot: null },
    REFS_RESULT.steps[2],
  ] };
  const sub = buildSubmission(r, { referenceLength: 6 });
  assert.equal(sub.action_history.length, 2);
  assert.deepEqual(sub.action_history.map((s) => s.step), [0, 1]);
  assert.deepEqual(validateSubmission(sub), []);
});

test('screenshot names must sort into step order', () => {
  const sub = buildSubmission(REFS_RESULT, { referenceLength: 6 });
  // Break the padding the way an off-by-one would.
  sub.action_history[1].screenshot = '10.jpg';
  const errs = validateSubmission(sub);
  assert.ok(errs.some((e) => /does not match the schema pattern|sort lexicographically/.test(e)), errs.join('; '));
});

test('validateSubmission catches the mistakes the scorer would fail on', () => {
  assert.ok(validateSubmission({}).length > 0);
  const bad = buildSubmission({ ...REFS_RESULT, taskId: 'has spaces' }, { referenceLength: 6 });
  assert.ok(validateSubmission(bad).some((e) => /task_id has characters/.test(e)));
  const noSteps = buildSubmission({ ...REFS_RESULT, steps: [] }, { referenceLength: 6 });
  assert.ok(validateSubmission(noSteps).some((e) => /at least one step/.test(e)));
});

test('reference_length falls back to the schema minimum rather than the step count', () => {
  // Substituting the attempt's own length would be a quiet lie in a published
  // format — it is a property of the benchmark task, not of this run.
  const sub = buildSubmission(REFS_RESULT, { referenceLength: null });
  assert.equal(sub.reference_length, 1);
  assert.notEqual(sub.reference_length, sub.action_history.length);
});

// ---------------------------------------------------------------------------
// Vocabulary convergence — the residual fingerprint found on real output
// ---------------------------------------------------------------------------

test('the two arms name the same control the same way', async () => {
  const { normalizeTargetLabel } = await import('./submission.js');
  // Observed on a real end-to-end run: refs reported the DOM label and holo the
  // grounder's description of the same button. Left alone, every holo step
  // reads like a sentence and every refs step like a DOM string.
  assert.equal(normalizeTargetLabel('the Show results button'), normalizeTargetLabel('Show results'));
  assert.equal(normalizeTargetLabel('the blue Search button'), 'blue Search');
  assert.equal(normalizeTargetLabel('the ZIP code field'), 'ZIP code');
  assert.equal(normalizeTargetLabel('Add to cart'), 'Add to cart');
});

test('normalisation removes framing, not content', async () => {
  const { normalizeTargetLabel } = await import('./submission.js');
  assert.equal(normalizeTargetLabel('Sort by lowest price'), 'Sort by lowest price');
  assert.equal(normalizeTargetLabel('the 2022 Tesla Model 3 listing'), '2022 Tesla Model 3 listing');
  assert.equal(normalizeTargetLabel(''), '');
  assert.equal(normalizeTargetLabel(null), '');
});

test('a described click and a referenced click of the same control render identically', () => {
  const base = { screenshot: '0000.jpg', url: 'https://x.example/', status: 'SUCCESS', thought: 'go' };
  const refs = renderAction({ ...base, action: { type: 'click', target: 'e7' },
    target: { label: 'Show results', x: 120, y: 173 } });
  const holo = renderAction({ ...base, action: { type: 'click_coord', x: 120, y: 173, label: 'the Show results button' },
    target: { label: 'the Show results button', x: 120, y: 173 } });
  assert.equal(refs, holo);
});
