// Event/threshold-driven maintenance — one document at a time, no nightly scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  memoryNeedsCompaction,
  compactMemoryMarkdown,
  compactMemoryDocument,
} from '../../server/memory/memoryMaintenance.js';
import { MEMORY_COMPACTION_TRIGGER_CHARS } from '../../server/memory/memoryConfig.js';
import { memoryCreate, memoryRead } from '../../server/memory/memoryTools.js';
import { createInMemoryMemoryStore } from './inMemoryMemoryStore.mjs';

const USER = 'user-maint';

test('size threshold flags a document for compaction', () => {
  assert.equal(memoryNeedsCompaction({ markdown: '- small doc' }).needed, false);
  const big = { markdown: 'x'.repeat(MEMORY_COMPACTION_TRIGGER_CHARS) };
  const out = memoryNeedsCompaction(big);
  assert.equal(out.needed, true);
  assert.ok(out.reasons.includes('size_threshold'));
});

test('heavy duplication flags a document for compaction', () => {
  const dup = Array.from({ length: 20 }, () => '- the same repeated fact').join('\n');
  const out = memoryNeedsCompaction({ markdown: dup });
  assert.equal(out.needed, true);
  assert.ok(out.reasons.includes('duplication'));
});

test('deterministic compaction dedupes content lines, keeps headings and order', () => {
  const doc = [
    '## Facts',
    '- fact one',
    '- fact two',
    '- fact one',
    '',
    '## Facts', // heading duplicates are left alone — structure, not content
    '- fact two',
    '- fact three',
  ].join('\n');
  const out = compactMemoryMarkdown(doc);
  assert.equal(out.match(/- fact one/g).length, 1);
  assert.equal(out.match(/- fact two/g).length, 1);
  assert.ok(out.includes('- fact three'));
  assert.equal(out.match(/## Facts/g).length, 2);
  assert.ok(out.indexOf('- fact one') < out.indexOf('- fact three'));
});

test('compactMemoryDocument persists, versions as compact, and no-ops when clean', async () => {
  const store = createInMemoryMemoryStore();
  const ctx = { store, userId: USER };
  const dup = `## Facts\n\n${Array.from({ length: 12 }, () => '- repeated durable fact').join('\n')}\n- unique fact\n`;
  const created = await memoryCreate(ctx, { path: 'topics/dedupe.md', markdown: dup, sourceType: 'explicit_user' });
  assert.equal(created.ok, true);

  const compacted = await compactMemoryDocument(store, USER, 'topics/dedupe.md');
  assert.equal(compacted.ok, true);
  assert.equal(compacted.ok && compacted.changed, true);

  const read = await memoryRead(ctx, { path: 'topics/dedupe.md' });
  assert.equal(read.ok && read.document.markdown.match(/- repeated durable fact/g).length, 1);
  assert.equal(read.ok && read.document.version, 2);

  const versions = await store.listVersions(USER, created.ok ? created.document.id : '');
  assert.equal(versions[0].change_type, 'compact');
  assert.equal(versions[0].source_type, 'system_event');
  assert.ok(versions[0].meta.beforeChars > versions[0].meta.afterChars);

  const again = await compactMemoryDocument(store, USER, 'topics/dedupe.md');
  assert.deepEqual(again, { ok: true, changed: false });
});

test('a custom compactor is used only when it shrinks and keeps content', async () => {
  const store = createInMemoryMemoryStore();
  const ctx = { store, userId: USER };
  await memoryCreate(ctx, {
    path: 'topics/compactor.md',
    markdown: '- a long fact about the user that could be shortened considerably\n- second fact\n',
    sourceType: 'explicit_user',
  });

  const grew = await compactMemoryDocument(store, USER, 'topics/compactor.md', {
    compactor: async (md) => `${md}\n${'padding '.repeat(100)}`,
  });
  assert.equal(grew.ok && grew.changed, false, 'growing compactor output ignored');

  const emptied = await compactMemoryDocument(store, USER, 'topics/compactor.md', {
    compactor: async () => '   ',
  });
  assert.equal(emptied.ok && emptied.changed, false, 'emptying compactor output ignored');

  const shrunk = await compactMemoryDocument(store, USER, 'topics/compactor.md', {
    compactor: async () => '- condensed fact\n- second fact\n',
  });
  assert.equal(shrunk.ok && shrunk.changed, true);
  const read = await memoryRead(ctx, { path: 'topics/compactor.md' });
  assert.ok(read.ok && read.document.markdown.includes('- condensed fact'));
});

test('compaction respects ownership and unknown paths', async () => {
  const store = createInMemoryMemoryStore();
  await memoryCreate({ store, userId: USER }, { path: 'goals.md', markdown: '- durable goal content', sourceType: 'explicit_user' });
  const foreign = await compactMemoryDocument(store, 'someone-else', 'goals.md');
  assert.deepEqual(foreign, { ok: false, error: 'memory_not_found' });
  const bad = await compactMemoryDocument(store, USER, '../../etc/passwd');
  assert.equal(bad.ok, false);
});
