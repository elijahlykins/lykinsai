import test from 'node:test';
import assert from 'node:assert/strict';

import { boundToolResult, measureResultPayload } from './toolResultBounds.js';

test('small results pass through unchanged', () => {
  const payload = { ok: true, id: 'e1', title: 'Lunch' };
  assert.deepEqual(boundToolResult('lykn_createEvent', payload), payload);
});

test('large calendar lists are compacted and capped', () => {
  const events = Array.from({ length: 80 }, (_, i) => ({
    id: `e${i}`,
    title: `Event ${i}`,
    description: 'x'.repeat(2000),
    starts_at: '2026-08-26T12:00:00Z',
    ends_at: '2026-08-26T13:00:00Z',
    color: '#ff00ff',
    created_at: '2026-01-01T00:00:00Z',
    read_only: false,
  }));
  const before = measureResultPayload({ ok: true, events });
  const after = boundToolResult('lykn_listEvents', { ok: true, count: 80, events });
  const measured = measureResultPayload(after);
  assert.ok(after.events.length <= 25);
  assert.equal(after.events[0].color, undefined);
  assert.ok(after.events[0].description.length <= 281);
  assert.ok(after.id === undefined);
  assert.ok(measured.approxTokens < before.approxTokens / 2);
  assert.equal(after.truncated, true);
});

test('vault search drops duplicate metadata and keeps a follow-up node_id', () => {
  const hits = Array.from({ length: 20 }, (_, i) => ({
    node_id: `vault_${i}`,
    id: String(i),
    title: `Note ${i}`,
    snippet: 'body '.repeat(200),
    tags: ['a', 'b', 'c'],
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
    url: `/vault?note=${i}`,
    match: 'hybrid',
  }));
  const after = boundToolResult('lykn_searchVault', { ok: true, query: 'contract', hits });
  assert.ok(after.hits.length <= 10);
  assert.equal(after.hits[0].node_id, 'vault_0');
  assert.equal(after.hits[0].tags, undefined);
  assert.equal(after.hits[0].url, undefined);
  assert.ok(after.hits[0].snippet.length <= 281);
});

test('web search pages are bounded; snippets stay', () => {
  const payload = {
    ok: true,
    query: 'weather',
    result_count: 5,
    results: [{ rank: 1, title: 'Weather', url: 'https://example.com', snippet: 'Sunny' }],
    pages: [{ title: 'Weather', url: 'https://example.com', content: 'z'.repeat(8000) }],
  };
  const after = boundToolResult('lykn_web_search', payload);
  assert.equal(after.results[0].snippet, 'Sunny');
  assert.ok(after.pages[0].content.length <= 2001);
});

test('http bodies are clipped; full-read documents stay available up to the cap', () => {
  const http = boundToolResult('lykn_http_request', {
    ok: true,
    body: 'h'.repeat(50_000),
  });
  assert.equal(http.truncated, true);
  assert.ok(http.body.length <= 8000);

  const doc = boundToolResult('lykn_loadNeuron', {
    ok: true,
    note: { title: 'Spec', content: 'full text here' },
  });
  assert.equal(doc.note.content, 'full text here');
  assert.equal(doc.truncated, undefined);
});
