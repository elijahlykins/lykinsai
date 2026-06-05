import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudePairs, dedupeAndShufflePairs, normalizePromptKey } from './parseClaudePairs.js';

test('parseClaudePairs strips fences and validates rows', () => {
  const raw = '```json\n[{"prompt":"Write a post","response":"Here is a direct take on agents."}]\n```';
  const { pairs, errors } = parseClaudePairs(raw, { minResponseChars: 10 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].prompt, 'Write a post');
  assert.equal(errors.length, 0);
});

test('dedupeAndShufflePairs collapses duplicate prompts', () => {
  const out = dedupeAndShufflePairs(
    [
      { prompt: 'Same', response: 'A' },
      { prompt: 'same', response: 'B' },
    ],
    10,
  );
  assert.equal(out.length, 1);
  assert.equal(normalizePromptKey(' Same  '), 'same');
});
