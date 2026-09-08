import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESPONSE_LENGTH_OPTIONS, formatResponseLengthPromptNote } from './modelBehavior.js';

test('balanced length note forbids one-or-two-sentence answers', () => {
  const note = formatResponseLengthPromptNote('medium');
  assert.match(note, /BALANCED/);
  assert.match(note, /headings, lists, or a checklist/);
  assert.match(note, /instead of a wall of paragraphs/);
  assert.match(note, /Do NOT compress an answer into one or two sentences/);
  assert.match(note, /simple questions, definitions, and capability asks/);
  assert.match(note, /Who you are \/ what model you are can stay short/);
  assert.doesNotMatch(note, /several paragraphs/);
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
  assert.match(detailed, /headings, lists or checklists/);
});

test('balanced settings hint no longer asks for brief detail', () => {
  const balanced = RESPONSE_LENGTH_OPTIONS.find((o) => o.id === 'medium');
  assert.match(balanced.hint, /Developed answers/i);
  assert.doesNotMatch(balanced.hint, /brief detail/i);
});
