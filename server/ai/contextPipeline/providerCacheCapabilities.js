import { MODEL_PRICING } from '../../../usageTracking.js';

const GEMINI_CACHE_MIN_CHARS = 4096;

function findPricing(modelId) {
  if (!modelId) return null;
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];
  const lower = String(modelId).toLowerCase();
  for (const [key, val] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return null;
}

export function inferProviderFamily(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4')) return 'openai';
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gemini')) return 'google';
  if (id.startsWith('grok')) return 'xai';
  return 'unknown';
}

export function supportsPromptCaching(modelId) {
  const family = inferProviderFamily(modelId);
  return family === 'openai' || family === 'anthropic' || family === 'google';
}

export function getCachedInputPricing(modelId) {
  const pricing = findPricing(modelId);
  if (!pricing) return null;
  if (Number.isFinite(Number(pricing.cachedInput))) return Number(pricing.cachedInput);
  return null;
}

export function getPromptCacheConfiguration(modelId) {
  const family = inferProviderFamily(modelId);
  const cachedInput = getCachedInputPricing(modelId);
  if (family === 'openai') {
    return {
      provider: 'openai',
      supported: true,
      mechanism: 'automatic_prefix',
      cacheKeyField: 'prompt_cache_key',
      minPrefixTokens: 1024,
      cachedInputPricePer1k: cachedInput,
    };
  }
  if (family === 'anthropic') {
    return {
      provider: 'anthropic',
      supported: true,
      mechanism: 'cache_control_ephemeral',
      cacheKeyField: null,
      minPrefixTokens: 1024,
      cachedInputPricePer1k: cachedInput,
    };
  }
  if (family === 'google') {
    return {
      provider: 'google',
      supported: true,
      mechanism: 'cachedContents',
      cacheKeyField: null,
      minPrefixChars: GEMINI_CACHE_MIN_CHARS,
      cachedInputPricePer1k: cachedInput,
    };
  }
  return {
    provider: family,
    supported: false,
    mechanism: null,
    cacheKeyField: null,
    cachedInputPricePer1k: null,
  };
}
