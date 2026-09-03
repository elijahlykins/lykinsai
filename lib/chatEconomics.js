// Auto-routing mix + context/cache utilization → estimated chat cost.
// Prefer live /admin/usage by_model rows when present; otherwise use the
// configured mix and catalog prices in usageTracking.js.

import { CHAT_ROUTE_MODELS } from '../server/ai/chatRouting/chatRoutingConfig.js';
import { MODEL_PRICING } from '../usageTracking.js';

export const DEFAULT_AUTO_CHAT_MIX = Object.freeze({
  fast: 0.35,
  standard: 0.55,
  advanced: 0.1,
});

export const DEFAULT_CHAT_TOKEN_ASSUMPTIONS = Object.freeze({
  inputTokens: 1800,
  outputTokens: 420,
  cachedInputShare: 0.25,
  reasoningTokens: 0,
});

const TIER_MODEL = {
  fast: CHAT_ROUTE_MODELS.fast,
  standard: CHAT_ROUTE_MODELS.standard,
  advanced: CHAT_ROUTE_MODELS.advanced,
};

function pricingFor(modelId) {
  return MODEL_PRICING[modelId] || { input: 0.0025, output: 0.015 };
}

export function cachedInputPricePer1k(modelId) {
  const pricing = pricingFor(modelId);
  if (Number.isFinite(Number(pricing.cachedInput))) return Number(pricing.cachedInput);
  return Number(pricing.input) || 0;
}

function resolveTokenParts(tokens = DEFAULT_CHAT_TOKEN_ASSUMPTIONS) {
  const input = Number(tokens.inputTokens) || 0;
  const output = Number(tokens.outputTokens) || 0;
  const reasoning = Number(tokens.reasoningTokens) || 0;
  let cached = Number(tokens.cachedInputTokens);
  if (!Number.isFinite(cached)) {
    const share = Math.max(0, Math.min(1, Number(tokens.cachedInputShare) || 0));
    cached = input * share;
  }
  cached = Math.max(0, Math.min(input, cached));
  return {
    input,
    output,
    reasoning,
    cached,
    uncached: Math.max(0, input - cached),
  };
}

export function estimateModelChatCost(modelId, tokens = DEFAULT_CHAT_TOKEN_ASSUMPTIONS) {
  const pricing = pricingFor(modelId);
  const parts = resolveTokenParts(tokens);
  const reasoningRate = Number.isFinite(Number(pricing.reasoning))
    ? Number(pricing.reasoning)
    : pricing.output;
  return (parts.uncached / 1000) * pricing.input
    + (parts.cached / 1000) * cachedInputPricePer1k(modelId)
    + (parts.output / 1000) * pricing.output
    + (parts.reasoning / 1000) * reasoningRate;
}

export function normalizeMix(mix = DEFAULT_AUTO_CHAT_MIX) {
  const fast = Math.max(0, Number(mix.fast) || 0);
  const standard = Math.max(0, Number(mix.standard) || 0);
  const advanced = Math.max(0, Number(mix.advanced) || 0);
  const total = fast + standard + advanced;
  if (total <= 0) return { ...DEFAULT_AUTO_CHAT_MIX };
  return {
    fast: fast / total,
    standard: standard / total,
    advanced: advanced / total,
  };
}

export function inferTierFromModelId(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return 'standard';
  if (id.includes('luna') || id.includes('nano') || id.includes('flash') || id.includes('haiku')) {
    return 'fast';
  }
  if (id.includes('sol') || id.includes('opus') || id === 'gpt-5.6-sol') return 'advanced';
  return 'standard';
}

export function estimateMixFromModelRows(rows = []) {
  const counts = { fast: 0, standard: 0, advanced: 0 };
  let total = 0;
  for (const row of rows) {
    const n = Number(row?.calls || row?.count || 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    const tier = inferTierFromModelId(row.model);
    counts[tier] += n;
    total += n;
  }
  if (total <= 0) return { ...DEFAULT_AUTO_CHAT_MIX, sampleSize: 0 };
  return {
    fast: counts.fast / total,
    standard: counts.standard / total,
    advanced: counts.advanced / total,
    sampleSize: total,
  };
}

export function summarizeCacheUtilization(rows = []) {
  let input = 0;
  let cached = 0;
  let calls = 0;
  let reported = 0;
  for (const row of rows) {
    const n = Number(row?.calls || row?.count || 1);
    const inTok = Number(row?.input_tokens || row?.total_input_tokens || 0);
    const cachedTok = Number(row?.cached_input_tokens || 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    calls += n;
    if (inTok > 0) {
      input += inTok;
      cached += Math.max(0, cachedTok);
      reported += n;
    }
  }
  if (reported <= 0 || input <= 0) {
    return {
      sampleSize: calls,
      reportedCalls: 0,
      cacheHitRate: null,
      avgInputTokens: null,
      avgCachedInputTokens: null,
      avgUncachedInputTokens: null,
    };
  }
  return {
    sampleSize: calls,
    reportedCalls: reported,
    cacheHitRate: cached / input,
    avgInputTokens: input / reported,
    avgCachedInputTokens: cached / reported,
    avgUncachedInputTokens: (input - cached) / reported,
  };
}

export function estimateAverageChatCost({
  mix = DEFAULT_AUTO_CHAT_MIX,
  tokens = DEFAULT_CHAT_TOKEN_ASSUMPTIONS,
  models = TIER_MODEL,
} = {}) {
  const shares = normalizeMix(mix);
  const fastCost = estimateModelChatCost(models.fast, tokens);
  const standardCost = estimateModelChatCost(models.standard, tokens);
  const advancedCost = estimateModelChatCost(models.advanced, tokens);
  const average = shares.fast * fastCost
    + shares.standard * standardCost
    + shares.advanced * advancedCost;
  return {
    average,
    mix: shares,
    byTier: {
      fast: fastCost,
      standard: standardCost,
      advanced: advancedCost,
    },
  };
}

export function estimateMonthlyChatCost({
  chatsPerMonth,
  mix = DEFAULT_AUTO_CHAT_MIX,
  tokens = DEFAULT_CHAT_TOKEN_ASSUMPTIONS,
} = {}) {
  const n = Math.max(0, Number(chatsPerMonth) || 0);
  const avg = estimateAverageChatCost({ mix, tokens });
  return {
    chatsPerMonth: n,
    averageChatCost: avg.average,
    monthlyCost: avg.average * n,
    mix: avg.mix,
    byTier: avg.byTier,
  };
}

export function estimateBreakEvenChats(planPriceUsd, averageChatCost) {
  const price = Number(planPriceUsd) || 0;
  const cogs = Number(averageChatCost) || 0;
  if (price <= 0 || cogs <= 0) return null;
  return Math.floor(price / cogs);
}

export const STRESS_CHAT_VOLUMES = Object.freeze([1000, 3000, 5000, 10000]);
export const PLAN_CHAT_PRICES = Object.freeze({ pro: 20, max: 100 });
