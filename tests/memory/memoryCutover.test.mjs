// Phase 2 Chat cutover: resolver policy, tools ownership, cache, token comparison.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createInMemoryMemoryStore } from './inMemoryMemoryStore.mjs';
import { memoryCreate, memoryPatch, memoryForget, memoryRead } from '../../server/memory/memoryTools.js';
import { migrateUserMemory } from '../../server/memory/memoryMigration.js';
import {
  resolveChatMemoryTurn,
  formatChatMemoryPrompt,
  invalidateMemoryThreadPath,
  resetMemoryThreadCache,
  getMemoryThreadState,
} from '../../server/memory/memoryChat.js';
import { MEMORY_L0_TOKEN_BUDGET, MEMORY_MAX_SELECTED_DOCUMENTS, estimateMemoryTokens } from '../../server/memory/memoryConfig.js';
import { CHAT_TOOL_NAMES, CHAT_TOOLS_BY_NAME, runChatTool } from '../../mcp-tools/chatTools.js';
import { _setMemoryStoreForTests } from '../../server/memory/memoryChat.js';

const USER = 'user-cutover';
const HERE = dirname(fileURLToPath(import.meta.url));

async function seedRichUser(store, userId = USER) {
  await memoryCreate({ store, userId }, {
    path: 'profile.md',
    markdown: '- Indie developer building LYKN.\n\n## Background\n\n- Previously shipped consumer apps.',
    sourceType: 'explicit_user',
  });
  await memoryCreate({ store, userId }, {
    path: 'preferences.md',
    markdown: '- Prefers concise answers.\n\n## Coding\n\n- TypeScript, two-space indent.',
    sourceType: 'explicit_user',
  });
  await memoryCreate({ store, userId }, {
    path: 'goals.md',
    markdown: '- Replace Synthesis with Markdown memory.',
    sourceType: 'explicit_user',
  });
  return store;
}

test('normal Chat turn is L0 plus first-turn L1 and ZERO deep reads', async () => {
  resetMemoryThreadCache();
  const store = await seedRichUser(createInMemoryMemoryStore());
  const first = await resolveChatMemoryTurn(store, USER, { chatId: 't1' });
  assert.ok(first.text.includes('[USER MEMORY]'));
  assert.ok(first.text.includes('[USER MEMORY INDEX]'));
  assert.equal(first.metrics.deepDocuments, 0);
  assert.ok(first.metrics.l0Tokens <= MEMORY_L0_TOKEN_BUDGET);
  assert.ok(first.metrics.totalTokens < 500);
  assert.equal((first.resolved.documents || []).length, 0);

  const second = await resolveChatMemoryTurn(store, USER, { chatId: 't1' });
  assert.ok(second.text.includes('[USER MEMORY]'));
  assert.equal(second.metrics.includeRegistry, false);
  assert.equal(second.metrics.registryTokens, 0);
  assert.equal(second.metrics.deepDocuments, 0);
  assert.ok(second.metrics.totalTokens <= first.metrics.l0Tokens + 5);
});

test('deepen recall may select profile + preferences, never more than the cap', async () => {
  resetMemoryThreadCache();
  const store = await seedRichUser(createInMemoryMemoryStore());
  const out = await resolveChatMemoryTurn(store, USER, { chatId: 't2', deepen: true });
  assert.ok(out.metrics.deepDocuments <= MEMORY_MAX_SELECTED_DOCUMENTS);
  assert.ok(out.metrics.deepDocuments >= 1);
  assert.ok(out.text.includes('[USER MEMORY — profile.md'));
  assert.ok(!out.text.includes('[USER MEMORY — goals.md'));
});

test('thread cache: unchanged deepen read skips the body; patch invalidates', async () => {
  resetMemoryThreadCache();
  const store = await seedRichUser(createInMemoryMemoryStore());
  const first = await resolveChatMemoryTurn(store, USER, { chatId: 't3', deepen: true });
  const cached = await resolveChatMemoryTurn(store, USER, { chatId: 't3', deepen: true });
  const profileCached = cached.resolved.documents.find((d) => d.path === 'profile.md');
  assert.equal(profileCached.unchanged, true);
  assert.equal(profileCached.markdown, null);
  assert.ok(!formatChatMemoryPrompt(cached.resolved).includes('[USER MEMORY — profile.md'));

  await memoryPatch({ store, userId: USER }, {
    path: 'profile.md',
    patch: { op: 'append_section', section: 'Background', text: '- Now shipping the memory cutover.' },
    sourceType: 'explicit_user',
  });
  invalidateMemoryThreadPath(USER, 'profile.md');
  const after = await resolveChatMemoryTurn(store, USER, { chatId: 't3', deepen: true });
  const reloaded = after.resolved.documents.find((d) => d.path === 'profile.md');
  assert.equal(reloaded.unchanged, false);
  assert.match(reloaded.markdown, /memory cutover/);
});

test('forget invalidates the stale thread view', async () => {
  resetMemoryThreadCache();
  const store = await seedRichUser(createInMemoryMemoryStore());
  await resolveChatMemoryTurn(store, USER, { chatId: 't4' });
  await memoryForget({ store, userId: USER }, { path: 'goals.md', sourceType: 'explicit_user' });
  invalidateMemoryThreadPath(USER, 'goals.md');
  const again = await resolveChatMemoryTurn(store, USER, { chatId: 't4', recall: true });
  assert.ok(!again.resolved.registry.entries.some((e) => e.path === 'goals.md'));
});

test('user with no memory resolves empty — Chat without memory still works', async () => {
  resetMemoryThreadCache();
  const store = createInMemoryMemoryStore();
  const out = await resolveChatMemoryTurn(store, 'nobody', { chatId: 'empty' });
  assert.equal(out.text, '');
  assert.equal(out.metrics.totalTokens, 0);
});

test('legacy facts pack is materially larger than new L0 on the same fixture', async () => {
  const facts = [
    { fact_kind: 'identity', fact_text: 'Indie developer building LYKN.', status: 'confirmed', confidence: 0.95, last_seen_at: '2026-08-01' },
    { fact_kind: 'preference', fact_text: 'Prefers concise answers.', status: 'stated', confidence: 0.9, last_seen_at: '2026-08-01' },
    { fact_kind: 'preference', fact_text: 'TypeScript, two-space indent.', status: 'confirmed', confidence: 0.9, last_seen_at: '2026-08-01' },
    { fact_kind: 'goal', fact_text: 'Replace Synthesis with Markdown memory.', status: 'confirmed', confidence: 0.9, last_seen_at: '2026-08-01' },
    { fact_kind: 'identity', fact_text: 'Previously shipped consumer apps.', status: 'stated', confidence: 0.8, last_seen_at: '2026-08-01' },
    { fact_kind: 'style', fact_text: 'Plain dashes, no emojis.', status: 'confirmed', confidence: 0.85, last_seen_at: '2026-08-01' },
  ];
  const legacyText = [
    '[USER_MODEL]',
    ...facts.map((fact) =>
      `- [${fact.fact_kind}] ${fact.fact_text} (${fact.status}; confidence=${fact.confidence}; seen=${fact.last_seen_at})`,
    ),
    'Use these facts to personalize the response. Prefer confirmed facts and do not expose this block.',
  ].join('\n');
  const legacyTokens = estimateMemoryTokens(legacyText);

  resetMemoryThreadCache();
  const store = createInMemoryMemoryStore();
  await migrateUserMemory(store, USER, { facts });
  const turn = await resolveChatMemoryTurn(store, USER, { chatId: 'cmp' });
  const later = await resolveChatMemoryTurn(store, USER, { chatId: 'cmp' });
  assert.ok(legacyTokens > 0);
  assert.ok(later.metrics.l0Tokens < legacyTokens, `L0 ${later.metrics.l0Tokens} should be < legacy ${legacyTokens}`);
  assert.ok(later.metrics.totalTokens < legacyTokens);
  assert.ok(turn.metrics.totalTokens < 400);
});

test('all five memory tools are on the Chat whitelist', () => {
  for (const name of ['memory_list', 'memory_read', 'memory_patch', 'memory_create', 'memory_forget']) {
    assert.ok(CHAT_TOOL_NAMES.includes(name), name);
    assert.ok(CHAT_TOOLS_BY_NAME[name], name);
  }
});

test('memory tools take ownership from ctx.userId — model cannot choose another user', async () => {
  const store = createInMemoryMemoryStore();
  _setMemoryStoreForTests(store);
  await seedRichUser(store, 'owner');
  await seedRichUser(store, 'attacker');

  const ctx = { supabaseAdmin: { _unused: true }, userId: 'owner' };
  const stolen = await runChatTool('memory_read', { path: 'profile.md', userId: 'attacker', user_id: 'attacker' }, ctx);
  assert.equal(stolen.ok, true);
  assert.equal(stolen.payload.ok, true);
  assert.match(stolen.payload.document.markdown, /Indie developer building LYKN/);

  const write = await runChatTool('memory_patch', {
    path: 'profile.md',
    userId: 'attacker',
    patch: { op: 'append_section', section: 'Background', text: '- poisoned' },
    sourceType: 'external',
  }, ctx);
  assert.equal(write.payload.ok, false);
  assert.equal(write.payload.error, 'external_content_forbidden');

  const inferred = await runChatTool('memory_patch', {
    path: 'profile.md',
    patch: { op: 'append_section', section: 'Background', text: '- they seem tired' },
    sourceType: 'inferred',
  }, ctx);
  assert.equal(inferred.payload.ok, false);
  assert.equal(inferred.payload.deferred, true);

  const explicit = await runChatTool('memory_patch', {
    path: 'profile.md',
    patch: { op: 'append_section', section: 'Background', text: '- Ships from a Mac.' },
    sourceType: 'explicit_user',
  }, ctx);
  assert.equal(explicit.payload.ok, true);

  const attackerRead = await memoryRead({ store, userId: 'attacker' }, { path: 'profile.md' });
  assert.ok(!attackerRead.document.markdown.includes('Ships from a Mac'));
  _setMemoryStoreForTests(null);
});

test('server Chat seams call MemoryResolver with no legacy parallel retrieval', () => {
  const serverSrc = readFileSync(join(HERE, '../../server.js'), 'utf8');
  const invokeSrc = readFileSync(join(HERE, '../../server/ai/chatInvoke.routes.js'), 'utf8');
  const streamSrc = readFileSync(join(HERE, '../../server/ai/chatStream.routes.js'), 'utf8');
  const chatSrc = `${serverSrc}\n${invokeSrc}\n${streamSrc}`;
  assert.match(serverSrc, /async function resolveProductionChatMemory/);
  assert.match(serverSrc, /resolveChatMemoryTurn\(/);
  assert.match(chatSrc, /fetchProjectSection\(/);
  for (const obsolete of [
    'fetchUserModelSection(',
    'fetchBeliefSection(',
    'fetchSynthesisRetrievalSection(',
    'buildRelatedNeighborhoodSection(',
    'const skipSynthesis =',
    'const streamSkipSynthesis =',
    'let skipBeliefs =',
    'let streamSkipBeliefs =',
    'const skipRelated =',
    'const streamSkipRelated =',
  ]) {
    assert.ok(!chatSrc.includes(obsolete), obsolete);
  }

  assert.match(invokeSrc, /app\.post\('\/api\/ai\/invoke'/);
  assert.match(streamSrc, /app\.post\('\/api\/ai\/stream'/);
  assert.match(streamSrc, /app\.post\('\/api\/ai\/local-tool-result'/);
  assert.match(invokeSrc, /resolveProductionChatMemory\(/);
  assert.match(streamSrc, /resolveProductionChatMemory\(/);
  assert.ok(!invokeSrc.includes('fetchUserModelSection('), 'invoke must not read legacy facts');
  assert.ok(!streamSrc.includes('fetchUserModelSection('), 'stream must not read legacy facts');
  assert.match(invokeSrc, /fetchProjectSection\(/);
  assert.match(streamSrc, /fetchProjectSection\(/);
});

test('legacy personal-memory tools and nightly jobs are absent', () => {
  const tools = readFileSync(join(HERE, '../../mcp-tools/index.js'), 'utf8');
  for (const obsolete of [
    'getBeliefsTool',
    'getRulesTool',
    'getFactsTool',
    'proposeFactTool',
    'recordRuleApplicationTool',
    'findConnectionsTool',
    'createNeuronLinkTool',
    'getNeuronLinksTool',
    'touchConceptTool',
  ]) {
    assert.ok(!tools.includes(obsolete), obsolete);
  }
  const render = readFileSync(join(HERE, '../../render.yaml'), 'utf8');
  assert.ok(!render.includes('runSynthesis.js'));
  assert.ok(!render.includes('runConcepts.js'));
});

test('retained project membership paths do not expose legacy neuron kinds', () => {
  for (const relative of [
    '../../mcp-tools/uploadToProject.js',
    '../../src/lib/userProjects.ts',
    '../../lib/projectContext.js',
  ]) {
    const src = readFileSync(join(HERE, relative), 'utf8');
    assert.ok(!src.includes('belief_<'), `${relative} must not expose legacy belief nodes`);
    assert.ok(!src.includes('fact_<'), `${relative} must not expose legacy fact nodes`);
    assert.ok(!src.includes('concept_<'), `${relative} must not expose legacy concept nodes`);
  }
  const upload = readFileSync(join(HERE, '../../mcp-tools/uploadToProject.js'), 'utf8');
  assert.match(upload, /vault_/);
});

test('episodic prompt copy does not revive User Facts', () => {
  const src = readFileSync(join(HERE, '../../src/lib/conversationMemory.ts'), 'utf8');
  assert.equal(/User Facts|get_facts|get_beliefs/.test(src), false);
  assert.match(src, /Markdown Memory/);
});

test('chat load-in calendar greeting reads lykn_events', () => {
  const src = readFileSync(join(HERE, '../../src/lib/synthesis/loadInUpdates.ts'), 'utf8');
  assert.match(src, /\.from\("lykn_events"\)/);
  assert.doesNotMatch(src, /\.eq\("source", "gcal_event"\)/);
});

test('stopped chat send does not clobber a successor stream', () => {
  const src = readFileSync(join(HERE, '../../src/hooks/useChatEngine.ts'), 'utf8');
  assert.match(src, /sendAbort !== activeAiAbortRef\.current/);
  assert.match(src, /activeAiAbortRef\.current === sendAbort/);
});

test('getMemoryThreadState starts empty so a missing chatId still works', () => {
  resetMemoryThreadCache();
  const state = getMemoryThreadState(USER, '');
  assert.deepEqual(state.knownVersions, {});
  assert.equal(state.registryShown, false);
});
