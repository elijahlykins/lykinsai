// Run: node --test lib/rag/rag.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion, RRF_DEFAULT_K } from './rrf.js';
import { chunkTextForSynthesis } from '../../synthesis-service.js';

test('RRF: item appearing in multiple lists outranks single-list items', () => {
  const a = { label: 'bm25', items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] };
  const b = { label: 'dense', items: [{ id: 'z' }, { id: 'w' }, { id: 'x' }] };
  const fused = reciprocalRankFusion([a, b]);
  // x is rank1+rank3, z is rank3+rank1 — both beat y/w which appear once.
  assert.ok(['x', 'z'].includes(fused[0].id));
  assert.equal(fused[0].sources.length, 2);
  const single = fused.find((f) => f.id === 'y');
  assert.equal(single.sources.length, 1);
  assert.ok(fused[0].score > single.score);
});

test('RRF: respects per-list weight', () => {
  const a = { label: 'bm25', items: [{ id: 'p' }], weight: 1 };
  const b = { label: 'dense', items: [{ id: 'q' }], weight: 5 };
  const fused = reciprocalRankFusion([a, b]);
  assert.equal(fused[0].id, 'q'); // heavier list wins the tie at rank 1
});

test('RRF: empty / malformed input is safe', () => {
  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.deepEqual(reciprocalRankFusion(null), []);
  assert.deepEqual(reciprocalRankFusion([{ items: null }]), []);
});

test('RRF: score formula matches 1/(k+rank)', () => {
  const fused = reciprocalRankFusion([{ label: 'l', items: [{ id: 'a' }] }]);
  assert.equal(fused[0].score, 1 / (RRF_DEFAULT_K + 1));
});

test('chunker: short text stays a single chunk', () => {
  assert.equal(chunkTextForSynthesis('A short saved note.').length, 1);
  assert.equal(chunkTextForSynthesis('   ').length, 0); // empty/whitespace
});

test('chunker: long text splits without cutting mid-sentence', () => {
  const doc = 'The Porsche 911 is an iconic sports car. '.repeat(120);
  const chunks = chunkTextForSynthesis(doc);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 2000, `chunk too large: ${c.length}`);
    // Every chunk should end at a sentence terminator (no mid-sentence slice).
    assert.match(c.trim(), /[.!?]$/);
  }
});

test('chunker: respects max chunk count', () => {
  const huge = 'Sentence number one is here. '.repeat(5000);
  const chunks = chunkTextForSynthesis(huge);
  assert.ok(chunks.length <= 64);
});
