// Hybrid retrieval: L0 automatic block, L1 registry, L2 selected documents,
// budgets, and the thread-level unchanged-version cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMemoryContext,
  buildMemoryL0Block,
  measureMemoryFootprint,
} from '../../server/memory/memoryResolver.js';
import { formatMemoryRegistry } from '../../server/memory/memoryRegistry.js';
import { memoryCreate, memoryPatch } from '../../server/memory/memoryTools.js';
import {
  MEMORY_L0_TOKEN_BUDGET,
  MEMORY_REGISTRY_TOKEN_BUDGET,
  MEMORY_MAX_SELECTED_DOCUMENTS,
  estimateMemoryTokens,
} from '../../server/memory/memoryConfig.js';
import { createInMemoryMemoryStore } from './inMemoryMemoryStore.mjs';

const USER = 'user-resolver';

async function seed() {
  const store = createInMemoryMemoryStore();
  const ctx = { store, userId: USER };
  await memoryCreate(ctx, {
    path: 'profile.md',
    markdown: '- Indie developer building LYKN, an AI desktop companion.\n\n## Background\n\n- Previously shipped consumer apps.',
    sourceType: 'explicit_user',
  });
  await memoryCreate(ctx, {
    path: 'preferences.md',
    markdown: '- Prefers concise answers and plain dashes.\n\n## Coding\n\n- TypeScript, two-space indent.',
    sourceType: 'explicit_user',
  });
  await memoryCreate(ctx, {
    path: 'goals.md',
    markdown: '- Replace the Synthesis memory stack with Markdown memory.',
    sourceType: 'explicit_user',
  });
  await memoryCreate(ctx, {
    path: 'projects/lykn.md',
    markdown: '## Current state\n\n- Memory core Phase 1 under construction.',
    sourceType: 'explicit_user',
    description: 'The LYKN app.',
  });
  return { store, ctx };
}

test('L0 uses only profile/preferences summaries and respects its budget', async () => {
  const { store } = await seed();
  const out = await resolveMemoryContext(store, USER);
  assert.ok(out.l0.text.startsWith('[USER MEMORY]'));
  assert.ok(out.l0.text.includes('Profile:'));
  assert.ok(out.l0.text.includes('Preferences:'));
  assert.ok(!out.l0.text.includes('goals'), 'goals summaries are not L0');
  assert.ok(!out.l0.text.includes('Background\n'), 'no full markdown bodies in L0');
  assert.ok(out.l0.tokens <= MEMORY_L0_TOKEN_BUDGET);
});

test('registry (L1) lists every active memory compactly, no bodies', async () => {
  const { store } = await seed();
  const out = await resolveMemoryContext(store, USER);
  for (const path of ['profile.md', 'preferences.md', 'goals.md', 'projects/lykn.md']) {
    assert.ok(out.registry.text.includes(path), path);
  }
  assert.ok(!out.registry.text.includes('two-space indent'), 'summaries only, not doc bodies');
  assert.ok(out.registry.tokens <= MEMORY_REGISTRY_TOKEN_BUDGET);
  assert.equal(out.registry.entries.length, 4);
});

test('default resolve performs ZERO deep reads', async () => {
  const { store } = await seed();
  const out = await resolveMemoryContext(store, USER);
  assert.deepEqual(out.documents, []);
  assert.equal(out.totalTokens, out.l0.tokens + out.registry.tokens);
});

test('L2 loads selected documents within count and token budgets', async () => {
  const { store } = await seed();
  const out = await resolveMemoryContext(store, USER, {
    selectPaths: ['projects/lykn.md', 'goals.md', 'preferences.md', 'profile.md', 'profile.md'],
  });
  // Dedupe + cap at MEMORY_MAX_SELECTED_DOCUMENTS.
  assert.equal(out.documents.length, MEMORY_MAX_SELECTED_DOCUMENTS);
  assert.ok(out.documents.every((d) => d.markdown && d.tokens > 0));

  const tight = await resolveMemoryContext(store, USER, {
    selectPaths: ['projects/lykn.md', 'goals.md'],
    budgets: { deepRead: estimateMemoryTokens('## Current state\n\n- Memory core Phase 1 under construction.') },
  });
  assert.equal(tight.documents[0].error, undefined);
  assert.equal(tight.documents[1].error, 'deep_read_budget_exhausted');
  assert.equal(tight.documents[1].markdown, null);
});

test('thread cache: unchanged versions come back without bodies; changed docs reload', async () => {
  const { store, ctx } = await seed();
  const first = await resolveMemoryContext(store, USER, { selectPaths: ['goals.md'] });
  const v1 = first.documents[0].version;
  assert.equal(v1, 1);

  const cached = await resolveMemoryContext(store, USER, {
    selectPaths: ['goals.md'],
    knownVersions: { 'goals.md': v1 },
  });
  assert.deepEqual(cached.documents, [{ path: 'goals.md', version: 1, unchanged: true, markdown: null, tokens: 0 }]);

  await memoryPatch(ctx, {
    path: 'goals.md',
    patch: { op: 'append_section', section: 'Next', text: '- Ship Phase 2 cutover.' },
    sourceType: 'explicit_user',
  });
  const reloaded = await resolveMemoryContext(store, USER, {
    selectPaths: ['goals.md'],
    knownVersions: { 'goals.md': v1 },
  });
  assert.equal(reloaded.documents[0].unchanged, false);
  assert.equal(reloaded.documents[0].version, 2);
  assert.ok(reloaded.documents[0].markdown.includes('Ship Phase 2 cutover'));
});

test('invalid or foreign selections fail safely inside resolve', async () => {
  const { store } = await seed();
  const out = await resolveMemoryContext(store, USER, {
    selectPaths: ['../etc/passwd', 'decisions.md'],
  });
  assert.equal(out.documents[0].error, 'invalid_path');
  assert.equal(out.documents[1].error, 'memory_not_found');
});

test('registry formatter degrades gracefully under tiny budgets', async () => {
  const { store } = await seed();
  const { registry } = await resolveMemoryContext(store, USER, { budgets: { registry: 40 } });
  assert.ok(registry.tokens <= 40);
  const entries = (await resolveMemoryContext(store, USER)).registry.entries;
  const formatted = formatMemoryRegistry(entries, { tokenBudget: 40 });
  assert.ok(formatted.includedCount < entries.length || formatted.text === '');
});

test('empty memory state resolves to empty context, not errors', async () => {
  const store = createInMemoryMemoryStore();
  const out = await resolveMemoryContext(store, 'user-with-nothing');
  assert.deepEqual(
    [out.l0.text, out.registry.text, out.documents, out.totalTokens],
    ['', '', [], 0],
  );
  assert.deepEqual(buildMemoryL0Block([]), { text: '', tokens: 0 });
});

test('footprint instrumentation reports sizes/counts, never contents', async () => {
  const { store } = await seed();
  const fp = await measureMemoryFootprint(store, USER);
  assert.equal(fp.documentCount, 4);
  assert.ok(fp.l0Tokens > 0 && fp.l0Tokens <= MEMORY_L0_TOKEN_BUDGET);
  assert.ok(fp.registryTokens > 0 && fp.registryTokens <= MEMORY_REGISTRY_TOKEN_BUDGET);
  assert.deepEqual(
    Object.keys(fp).sort(),
    ['documentCount', 'l0Tokens', 'registryEntriesIncluded', 'registryTokens'],
  );
});
