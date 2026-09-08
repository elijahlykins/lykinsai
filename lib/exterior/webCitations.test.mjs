import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSourcesFromWebToolResult,
  mergeCitationSources,
} from './webCitations.js';

test('mergeCitationSources dedupes by url and caps at 40', () => {
  const merged = mergeCitationSources(
    [{ title: 'First', url: 'https://a.example/1' }],
    [
      { title: 'Again', url: 'https://a.example/1' },
      { title: 'Second', url: 'https://b.example/2' },
    ],
  );
  assert.deepEqual(merged, [
    { title: 'First', url: 'https://a.example/1' },
    { title: 'Second', url: 'https://b.example/2' },
  ]);
  const many = mergeCitationSources(
    [],
    Array.from({ length: 50 }, (_, i) => ({ title: `T${i}`, url: `https://x.example/${i}` })),
  );
  assert.equal(many.length, 40);
});

test('extractSourcesFromWebToolResult reads search hits and fetch pages', () => {
  assert.deepEqual(
    extractSourcesFromWebToolResult('lykn_web_search', {
      ok: true,
      results: [
        { title: 'NYT', url: 'https://nytimes.com/a' },
        { title: 'BBC', url: 'https://bbc.com/b' },
      ],
    }),
    [
      { title: 'NYT', url: 'https://nytimes.com/a' },
      { title: 'BBC', url: 'https://bbc.com/b' },
    ],
  );
  assert.deepEqual(
    extractSourcesFromWebToolResult('lykn_web_fetch', {
      ok: true,
      title: 'Article',
      url: 'https://example.com/story',
    }),
    [{ title: 'Article', url: 'https://example.com/story' }],
  );
  assert.deepEqual(extractSourcesFromWebToolResult('lykn_web_search', { ok: false, results: [] }), []);
  assert.deepEqual(extractSourcesFromWebToolResult('lykn_vault_search', { ok: true, results: [{ url: 'https://x' }] }), []);
});
