import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDiverseCandidates, formatDeepResearchForPrompt } from './deepResearch.js';

test('selectDiverseCandidates prefers domain diversity', () => {
  const hits = [
    { title: 'A1', url: 'https://a.com/1', snippet: 'a1', rank: 1 },
    { title: 'A2', url: 'https://a.com/2', snippet: 'a2', rank: 2 },
    { title: 'B1', url: 'https://b.com/1', snippet: 'b1', rank: 1 },
    { title: 'C1', url: 'https://c.com/1', snippet: 'c1', rank: 1 },
    { title: 'A3', url: 'https://www.a.com/3', snippet: 'a3', rank: 3 },
  ];
  const picked = selectDiverseCandidates(hits, 3);
  const hosts = picked.map((h) => new URL(h.url).hostname.replace(/^www\./, ''));
  assert.equal(picked.length, 3);
  assert.ok(hosts.includes('a.com'));
  assert.ok(hosts.includes('b.com'));
  assert.ok(hosts.includes('c.com'));
});

test('formatDeepResearchForPrompt requires sources or pages', () => {
  assert.equal(formatDeepResearchForPrompt({ ok: true, sources: [], pages: [] }), '');
  const text = formatDeepResearchForPrompt({
    ok: true,
    angles: ['Overview'],
    queries: ['topic overview'],
    sources: [{ title: 'Example', url: 'https://example.com', snippet: 'hi' }],
    pages: [{ title: 'Example', url: 'https://example.com', content: 'Full page body '.repeat(20) }],
    notes: '',
  });
  assert.match(text, /\[DEEP_RESEARCH_EVIDENCE\]/);
  assert.match(text, /\[RESEARCH_REPORT_INSTRUCTIONS\]/);
  assert.match(text, /https:\/\/example\.com/);
  assert.match(text, /\*\*Sources\*\*/);
});
