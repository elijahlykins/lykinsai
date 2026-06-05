import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkTextByWords, expandNotesToDocumentChunks } from './chunkText.js';

test('chunkTextByWords splits long prose', () => {
  const words = Array.from({ length: 2500 }, (_, i) => `w${i}`);
  const chunks = chunkTextByWords(words.join(' '), 1000);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].includes('w0'));
  assert.ok(chunks[2].includes('w2499'));
});

test('expandNotesToDocumentChunks respects maxChunks', () => {
  const notes = [
    { id: 'a', title: 'A', text: 'word '.repeat(5000) },
    { id: 'b', title: 'B', text: 'word '.repeat(5000) },
  ];
  const chunks = expandNotesToDocumentChunks(notes, { wordsPerChunk: 1000, maxChunks: 2 });
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].text, /^Title: A/);
});
