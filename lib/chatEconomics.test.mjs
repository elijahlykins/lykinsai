import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cachedInputPricePer1k,
  DEFAULT_AUTO_CHAT_MIX,
  estimateAverageChatCost,
  estimateBreakEvenChats,
  estimateMixFromModelRows,
  estimateModelChatCost,
  estimateMonthlyChatCost,
  inferTierFromModelId,
  normalizeMix,
  PLAN_CHAT_PRICES,
  STRESS_CHAT_VOLUMES,
  summarizeCacheUtilization,
} from './chatEconomics.js';

test('average chat cost is a mix, not a single Terra assumption', () => {
  const terraOnly = estimateAverageChatCost({
    mix: { fast: 0, standard: 1, advanced: 0 },
  });
  const mixed = estimateAverageChatCost({ mix: DEFAULT_AUTO_CHAT_MIX });
  assert.ok(mixed.average < terraOnly.average);
  assert.ok(mixed.byTier.fast < mixed.byTier.standard);
  assert.ok(mixed.byTier.standard < mixed.byTier.advanced);
});

test('stress volumes scale linearly from the routed average', () => {
  const one = estimateMonthlyChatCost({ chatsPerMonth: 1 });
  for (const n of STRESS_CHAT_VOLUMES) {
    const row = estimateMonthlyChatCost({ chatsPerMonth: n });
    assert.equal(Math.round(row.monthlyCost * 1e6), Math.round(one.averageChatCost * n * 1e6));
  }
});

test('live by_model rows become a routing mix', () => {
  const mix = estimateMixFromModelRows([
    { model: 'gpt-5.6-luna', calls: 40 },
    { model: 'gpt-5.6-terra', calls: 50 },
    { model: 'gpt-5.6-sol', calls: 10 },
  ]);
  assert.equal(mix.fast, 0.4);
  assert.equal(mix.standard, 0.5);
  assert.equal(mix.advanced, 0.1);
  assert.equal(mix.sampleSize, 100);
});

test('unknown mix falls back to the default auto mix', () => {
  const mix = normalizeMix({ fast: 0, standard: 0, advanced: 0 });
  assert.equal(mix.fast, DEFAULT_AUTO_CHAT_MIX.fast);
  assert.equal(inferTierFromModelId('claude-opus-4-8'), 'advanced');
  assert.ok(estimateModelChatCost('gpt-5.6-luna') > 0);
});

test('cached input uses model-specific cached pricing, not a 50% default', () => {
  const luna = estimateModelChatCost('gpt-5.6-luna', {
    inputTokens: 1000,
    outputTokens: 0,
    cachedInputTokens: 1000,
  });
  const halfPrice = (1000 / 1000) * 0.001 * 0.5;
  const catalogCached = (1000 / 1000) * cachedInputPricePer1k('gpt-5.6-luna');
  assert.equal(luna, catalogCached);
  assert.ok(luna < halfPrice);
});

test('uncached input uses normal input pricing', () => {
  const terra = estimateModelChatCost('gpt-5.6-terra', {
    inputTokens: 1000,
    outputTokens: 0,
    cachedInputTokens: 0,
  });
  assert.equal(terra, 0.0025);
});

test('providers without cached pricing do not invent a discount', () => {
  const grok = estimateModelChatCost('grok-4.5', {
    inputTokens: 1000,
    outputTokens: 0,
    cachedInputTokens: 1000,
  });
  assert.equal(grok, 0.002);
});

test('cache utilization is null when providers did not report cached tokens', () => {
  const empty = summarizeCacheUtilization([{ model: 'gpt-5.6-luna', calls: 10 }]);
  assert.equal(empty.cacheHitRate, null);
  const live = summarizeCacheUtilization([
    { model: 'gpt-5.6-luna', calls: 2, input_tokens: 2000, cached_input_tokens: 800 },
  ]);
  assert.equal(live.cacheHitRate, 0.4);
  assert.equal(live.avgUncachedInputTokens, 600);
});

test('break-even chat volume uses measured average cost', () => {
  const avg = estimateAverageChatCost().average;
  assert.equal(estimateBreakEvenChats(PLAN_CHAT_PRICES.pro, avg), Math.floor(20 / avg));
  assert.equal(estimateBreakEvenChats(PLAN_CHAT_PRICES.max, avg), Math.floor(100 / avg));
});
