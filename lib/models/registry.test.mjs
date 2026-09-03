import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATEWAYS,
  MODEL_VISIBILITY,
  canonicalModelId,
  deprecateModel,
  getModel,
  isSelectableModelId,
  listCuratedModels,
  listModels,
  listRecommendedModels,
  modelPricing,
  modelSupports,
  openRouterIdFor,
  replaceSyncedCatalog,
  resolveStoredModelId,
  resolveUpstream,
  syncedCatalogSize,
} from './registry.js';
import { KNOWN_MODEL_IDS } from '../../src/lib/modelCatalog.js';
import { MODEL_PRICING, findModelPricing } from './pricingTable.js';

test('curated seed covers every picker model except the lykn routing id', () => {
  for (const id of KNOWN_MODEL_IDS) {
    if (id === 'lykn' || id === 'lykn-setup') {
      assert.equal(getModel(id), null, 'routing mode ids are not models');
      continue;
    }
    const def = getModel(id);
    assert.ok(def, `missing registry entry for picker id ${id}`);
    assert.equal(def.id, id);
    assert.equal(def.gateway, GATEWAYS.DIRECT);
    assert.ok(def.provider, `no provider for ${id}`);
    assert.ok(def.label, `no label for ${id}`);
    assert.equal(def.visibility, MODEL_VISIBILITY.PRIMARY);
  }
});

test('capabilities are normalized and sensible', () => {
  assert.equal(modelSupports('gpt-5.6-terra', 'tools'), true);
  assert.equal(modelSupports('gpt-5.6-terra', 'vision'), true);
  assert.equal(modelSupports('gpt-5.6-terra', 'reasoning'), true);
  assert.equal(modelSupports('o3', 'vision'), false, 'o-series is Responses-only, no vision');
  assert.equal(modelSupports('claude-haiku-4-5', 'reasoning'), false);
  assert.equal(modelSupports('claude-opus-5', 'reasoning'), true);
  // Unknown model fails closed.
  assert.equal(modelSupports('made-up-model', 'tools'), false);
});

test('pricing metadata matches the shared price table', () => {
  assert.deepEqual(modelPricing('gpt-5.6-luna'), MODEL_PRICING['gpt-5.6-luna']);
  assert.deepEqual(findModelPricing('gpt-5.6-luna'), MODEL_PRICING['gpt-5.6-luna']);
  // Substring fallback still works for dated provider ids.
  assert.deepEqual(findModelPricing('claude-haiku-4-5-20251001'), MODEL_PRICING['claude-haiku-4-5-20251001']);
});

test('selectable id validation fails closed', () => {
  assert.equal(isSelectableModelId('gpt-5.6-sol'), true);
  assert.equal(isSelectableModelId('lykn'), false);
  assert.equal(isSelectableModelId(''), false);
  assert.equal(isSelectableModelId('openai/gpt-nonexistent'), false);
  assert.equal(canonicalModelId('gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(canonicalModelId('nope'), null);
});

test('recommended list is curated and non-empty', () => {
  const rec = listRecommendedModels();
  assert.ok(rec.length >= 6);
  assert.ok(rec.every((d) => d.recommended && d.enabled && !d.deprecated));
  const ids = rec.map((d) => d.id);
  assert.ok(ids.includes('gpt-5.6-terra'));
  assert.ok(ids.includes('claude-fable-5'));
});

test('openrouter id convention maps vendors correctly', () => {
  assert.equal(openRouterIdFor('openai', 'gpt-5.6-terra'), 'openai/gpt-5.6-terra');
  assert.equal(openRouterIdFor('xai', 'grok-4.5'), 'x-ai/grok-4.5');
  assert.equal(openRouterIdFor('unknown-lab', 'x'), null);
  const def = getModel('claude-sonnet-5');
  assert.equal(def.openRouterId, 'anthropic/claude-sonnet-5');
  // OpenRouter lists dated Claude ids with a dot, not a hyphen.
  assert.equal(openRouterIdFor('anthropic', 'claude-haiku-4-5'), 'anthropic/claude-haiku-4.5');
  assert.equal(openRouterIdFor('anthropic', 'claude-opus-4-8'), 'anthropic/claude-opus-4.8');
  assert.equal(getModel('claude-haiku-4-5').openRouterId, 'anthropic/claude-haiku-4.5');
  assert.equal(openRouterIdFor('google', 'gemini-flash-latest'), 'google/gemini-3.6-flash');
});

test('synced catalog merges without touching curated entries', () => {
  const result = replaceSyncedCatalog([
    {
      id: 'deepseek/deepseek-v4',
      provider: 'deepseek',
      label: 'DeepSeek V4',
      capabilities: { tools: true, vision: false, reasoning: true, structuredOutput: true },
      contextWindow: 128000,
      pricing: { input: 0.0003, output: 0.0012 },
    },
    // Attempt to redefine a curated model — must be skipped.
    { id: 'gpt-5.6-terra', label: 'Evil Override', pricing: { input: 0, output: 0 } },
    // Garbage — must be counted invalid.
    null,
    { label: 'no id' },
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.skippedCurated, 1);
  assert.equal(result.invalid, 2);
  assert.equal(syncedCatalogSize(), 1);

  const ds = getModel('deepseek/deepseek-v4');
  assert.ok(ds);
  assert.equal(ds.gateway, GATEWAYS.OPENROUTER);
  assert.equal(ds.visibility, MODEL_VISIBILITY.CATALOG);
  assert.equal(ds.recommended, false, 'synced catalog can never self-recommend');
  assert.equal(isSelectableModelId('deepseek/deepseek-v4'), true);

  // Curated entry unchanged.
  assert.equal(getModel('gpt-5.6-terra').label, 'GPT-5.6 Terra');

  // Upstream resolution for a synced model goes through OpenRouter.
  const upstream = resolveUpstream('deepseek/deepseek-v4');
  assert.deepEqual(upstream, {
    gateway: GATEWAYS.OPENROUTER,
    provider: 'deepseek',
    upstreamId: 'deepseek/deepseek-v4',
  });

  // Re-sync replaces the previous set.
  replaceSyncedCatalog([]);
  assert.equal(syncedCatalogSize(), 0);
  assert.equal(getModel('deepseek/deepseek-v4'), null);
});

test('direct models resolve upstream to their own id', () => {
  assert.deepEqual(resolveUpstream('grok-4.5'), {
    gateway: GATEWAYS.DIRECT,
    provider: 'xai',
    upstreamId: 'grok-4.5',
  });
  assert.equal(resolveUpstream('unknown'), null);
});

test('capability and provider filters work', () => {
  const visionModels = listModels({ capability: 'vision', provider: 'openai' });
  assert.ok(visionModels.length > 0);
  assert.ok(visionModels.every((d) => d.capabilities.vision && d.provider === 'openai'));
  assert.ok(!visionModels.some((d) => d.id === 'o3'));
});

test('deprecated models are hidden and stored references degrade gracefully', () => {
  // gpt-5.3-code is priced but not in the picker, so use a synced sacrifice.
  replaceSyncedCatalog([{
    id: 'testlab/old-model',
    provider: 'openai',
    label: 'Old',
    deprecated: true,
  }]);
  assert.equal(isSelectableModelId('testlab/old-model'), false);
  // A deprecated-but-known model resolves to a recommended same-provider model.
  const replacement = resolveStoredModelId('testlab/old-model');
  assert.ok(replacement);
  assert.equal(getModel(replacement).provider, 'openai');
  assert.ok(isSelectableModelId(replacement));
  // Fully unknown stored ids resolve to null (caller falls back to LYKN).
  assert.equal(resolveStoredModelId('gone/forever'), null);
  replaceSyncedCatalog([]);

  // Deprecating a curated model hides it from selection but keeps metadata.
  assert.equal(deprecateModel('gpt-4o-mini'), true);
  assert.equal(isSelectableModelId('gpt-4o-mini'), false);
  assert.ok(getModel('gpt-4o-mini'), 'metadata retained for graceful display');
  const stillListed = listModels().some((d) => d.id === 'gpt-4o-mini');
  assert.equal(stillListed, false);
  // Restore for other tests (registry is module-level state).
  getModel('gpt-4o-mini').deprecated = false;
});
