// Conservative Phase 2 migration: trustworthy facts only, idempotent, no overwrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryMemoryStore } from './inMemoryMemoryStore.mjs';
import {
  isTrustworthyLegacyFact,
  groupTrustworthyFactsByPath,
  migrateUserMemory,
  resetMemoryMigrationCache,
  ensureLegacyMemoryMigrated,
} from '../../server/memory/memoryMigration.js';
import { memoryCreate, memoryRead, memoryList } from '../../server/memory/memoryTools.js';

const USER_A = 'user-mig-a';
const USER_B = 'user-mig-b';

function fact(overrides) {
  return {
    id: overrides.id || `f-${Math.random().toString(16).slice(2, 8)}`,
    fact_kind: 'identity',
    fact_text: 'Works as an indie developer.',
    status: 'confirmed',
    pending_confirm: false,
    ...overrides,
  };
}

test('only stated/confirmed/corrected facts are trustworthy', () => {
  assert.equal(isTrustworthyLegacyFact(fact({ status: 'confirmed' })), true);
  assert.equal(isTrustworthyLegacyFact(fact({ status: 'stated' })), true);
  assert.equal(isTrustworthyLegacyFact(fact({ status: 'corrected' })), true);
  assert.equal(isTrustworthyLegacyFact(fact({ status: 'inferred' })), false);
  assert.equal(isTrustworthyLegacyFact(fact({ status: 'pending' })), false);
  assert.equal(isTrustworthyLegacyFact(fact({ status: 'dismissed' })), false);
  assert.equal(isTrustworthyLegacyFact(fact({ status: 'confirmed', pending_confirm: true })), false);
  assert.equal(isTrustworthyLegacyFact(fact({ fact_text: 'hi' })), false);
});

test('weak/inferred/external-shaped facts are excluded from grouping', () => {
  const groups = groupTrustworthyFactsByPath([
    fact({ id: '1', status: 'inferred', fact_text: 'Probably prefers dark mode.' }),
    fact({ id: '2', fact_kind: 'theme', status: 'pending', fact_text: 'Interested in spatial UI.' }),
    fact({ id: '3', fact_kind: 'preference', status: 'stated', fact_text: 'Prefers TypeScript.' }),
  ]);
  assert.equal(groups.has('profile.md'), false);
  assert.equal(groups.get('preferences.md')?.length, 1);
});

test('trustworthy facts migrate into the right documents with migration provenance', async () => {
  const store = createInMemoryMemoryStore();
  const out = await migrateUserMemory(store, USER_A, {
    facts: [
      fact({ id: 'id1', fact_kind: 'identity', fact_text: 'Building LYKN, an AI desktop companion.' }),
      fact({ id: 'pref1', fact_kind: 'preference', status: 'stated', fact_text: 'Prefers concise answers.' }),
      fact({ id: 'goal1', fact_kind: 'goal', status: 'confirmed', fact_text: 'Launch LYKN publicly.' }),
      fact({ id: 'inf1', status: 'inferred', fact_text: 'Seems to like jazz.' }),
    ],
    displayName: 'Sam',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.paths.sort(), ['goals.md', 'preferences.md', 'profile.md']);

  const profile = await memoryRead({ store, userId: USER_A }, { path: 'profile.md' });
  assert.equal(profile.ok, true);
  assert.match(profile.document.markdown, /Building LYKN/);
  assert.match(profile.document.markdown, /The user goes by Sam/);
  assert.ok(!profile.document.markdown.includes('jazz'));

  const versions = await store.listVersions(USER_A, profile.document.version ? (await store.getDocument(USER_A, 'profile.md')).id : '');
  assert.equal(versions[0].source_type, 'migration');
  assert.equal(versions[0].change_type, 'create');
});

test('migration is idempotent — second run does not duplicate', async () => {
  const store = createInMemoryMemoryStore();
  const facts = [
    fact({ id: 'pref1', fact_kind: 'preference', status: 'stated', fact_text: 'Prefers TypeScript going forward.' }),
  ];
  const first = await migrateUserMemory(store, USER_A, { facts });
  const second = await migrateUserMemory(store, USER_A, { facts });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, 0);
  assert.equal(second.patched, 0);

  const read = await memoryRead({ store, userId: USER_A }, { path: 'preferences.md' });
  assert.equal(read.document.markdown.match(/Prefers TypeScript going forward/g).length, 1);
});

test('explicit-user memory is not overwritten by weaker legacy data', async () => {
  const store = createInMemoryMemoryStore();
  await memoryCreate({ store, userId: USER_A }, {
    path: 'preferences.md',
    markdown: '## Preferences\n\n- Prefers TypeScript going forward.\n',
    sourceType: 'explicit_user',
  });
  const out = await migrateUserMemory(store, USER_A, {
    facts: [
      fact({ fact_kind: 'preference', status: 'stated', fact_text: 'Prefers JavaScript.' }),
      fact({ fact_kind: 'preference', status: 'confirmed', fact_text: 'Prefers TypeScript going forward.' }),
    ],
  });
  assert.equal(out.ok, true);
  const read = await memoryRead({ store, userId: USER_A }, { path: 'preferences.md' });
  assert.match(read.document.markdown, /Prefers TypeScript going forward/);
  assert.match(read.document.markdown, /Prefers JavaScript/);
  const versions = await store.listVersions(USER_A, (await store.getDocument(USER_A, 'preferences.md')).id);
  assert.equal(versions.some((v) => v.source_type === 'explicit_user'), true);
  assert.ok(!read.document.markdown.includes('Prefers JavaScript.\n- Prefers JavaScript'));
});

test('archived memory is not revived by migration', async () => {
  const store = createInMemoryMemoryStore();
  const created = await memoryCreate({ store, userId: USER_A }, {
    path: 'goals.md',
    markdown: '## Goals\n\n- Old goal the user forgot.\n',
    sourceType: 'explicit_user',
  });
  await store.updateDocument(USER_A, created.document.id, created.document.version, {
    status: 'archived',
    archived_at: new Date().toISOString(),
  });
  const out = await migrateUserMemory(store, USER_A, {
    facts: [fact({ fact_kind: 'goal', fact_text: 'Brand new migrated goal.' })],
  });
  assert.equal(out.ok, true);
  const list = await memoryList({ store, userId: USER_A });
  assert.equal(list.memories.find((m) => m.path === 'goals.md'), undefined);
});

test('cross-user isolation: user B cannot receive user A facts', async () => {
  const store = createInMemoryMemoryStore();
  await migrateUserMemory(store, USER_A, {
    facts: [fact({ fact_text: 'User A secret identity fact.' })],
  });
  await migrateUserMemory(store, USER_B, {
    facts: [fact({ id: 'b1', fact_text: 'User B public fact about shipping apps.' })],
  });
  const a = await memoryRead({ store, userId: USER_A }, { path: 'profile.md' });
  const b = await memoryRead({ store, userId: USER_B }, { path: 'profile.md' });
  assert.match(a.document.markdown, /User A secret/);
  assert.ok(!b.document.markdown.includes('User A secret'));
  assert.match(b.document.markdown, /User B public/);
});

test('ensureLegacyMemoryMigrated is a one-shot process gate and still idempotent', async () => {
  resetMemoryMigrationCache();
  const store = createInMemoryMemoryStore();
  let calls = 0;
  const load = {
    listFacts: async () => {
      calls += 1;
      return [fact({ fact_kind: 'goal', fact_text: 'Ship the memory cutover.' })];
    },
  };
  const first = await ensureLegacyMemoryMigrated(store, USER_A, load);
  const second = await ensureLegacyMemoryMigrated(store, USER_A, load);
  assert.equal(first.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(calls, 1);
  resetMemoryMigrationCache();
});
