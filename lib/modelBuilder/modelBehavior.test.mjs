import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatResponseLengthPromptNote } from './modelBehavior.js';

test('balanced length note forbids one-or-two-sentence answers', () => {
  const note = formatResponseLengthPromptNote('medium');
  assert.match(note, /BALANCED/);
  assert.match(note, /several paragraphs/i);
  assert.match(note, /Do NOT compress an answer into one or two sentences/);
  assert.match(note, /simple questions, definitions, and capability asks/);
  assert.doesNotMatch(note, /quick facts/);
});

test('empty length defaults to balanced, not a label-only note', () => {
  const note = formatResponseLengthPromptNote('');
  assert.match(note, /BALANCED/);
  assert.notEqual(note.trim(), '[RESPONSE_LENGTH]\nThe user set response length to BALANCED.');
});

test('concise and detailed keep explicit length rules', () => {
  const concise = formatResponseLengthPromptNote('concise');
  const detailed = formatResponseLengthPromptNote('detailed');
  assert.match(concise, /CONCISE/);
  assert.match(concise, /few sentences/i);
  assert.match(detailed, /DETAILED/);
  assert.match(detailed, /500-900 words/);
});
