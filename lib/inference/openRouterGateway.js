/**
 * OpenRouter adapter.
 *
 * OpenRouter-specific auth, model ids, and usage live here.
 * Other LYKN code should call resolveInferenceTarget / extractOpenRouterUsage
 * instead of formatting OpenRouter requests itself.
 *
 * OpenRouter may reroute a selected model across hosting providers.
 * That is infrastructure fallback, not LYKN model fallback.
 */

import { roundProviderCostMicros } from '../billing/money.js';
import { openRouterHeaders, OPENROUTER_BASE_URL } from './resolveGateway.js';

function extractCompatTokens(data) {
  const u = data?.usage;
  if (!u) return { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || u.input_tokens || 0,
    output_tokens: u.completion_tokens || u.output_tokens || 0,
    cached_input_tokens: u.prompt_tokens_details?.cached_tokens || u.input_tokens_details?.cached_tokens || 0,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || u.output_tokens_details?.reasoning_tokens || 0,
  };
}

export { OPENROUTER_BASE_URL };

export function openRouterAuthHeaders(env = process.env) {
  const key = String(env.OPENROUTER_API_KEY || '').trim();
  if (!key) return null;
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...openRouterHeaders(env),
  };
}

/**
 * OpenRouter reports generation cost in USD on `usage.cost` when available.
 * That figure is authoritative for settlement. Token fields still matter
 * for analytics and for estimate fallback when cost is missing.
 */
export function extractOpenRouterUsage(data) {
  const tokens = extractCompatTokens(data);
  const rawCost = data?.usage?.cost;
  const costUsd = Number.isFinite(Number(rawCost)) ? Number(rawCost) : null;
  return {
    ...tokens,
    cost_usd: costUsd,
    cost_source: costUsd != null ? 'upstream' : 'missing',
    upstream_provider: extractOpenRouterProvider(data),
  };
}

export function extractOpenRouterProvider(data) {
  const raw = data?.provider || data?.usage?.provider || data?.model;
  return raw ? String(raw).slice(0, 80) : null;
}

export function emptyOpenRouterUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: null,
    cost_source: 'missing',
    upstream_provider: null,
  };
}

/** Sum token + cost fields across hops or fallback attempts. */
export function mergeOpenRouterUsage(a = {}, b = {}) {
  const costs = [a.cost_usd, b.cost_usd]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  const costUsd = costs.length ? costs.reduce((sum, n) => sum + n, 0) : null;
  return {
    input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0),
    output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0),
    cached_input_tokens: (a.cached_input_tokens || 0) + (b.cached_input_tokens || 0),
    reasoning_tokens: (a.reasoning_tokens || 0) + (b.reasoning_tokens || 0),
    cost_usd: costUsd,
    cost_source: costUsd != null
      ? (b.cost_source || a.cost_source || 'upstream')
      : (b.cost_source || a.cost_source || 'missing'),
    upstream_provider: b.upstream_provider || a.upstream_provider || null,
  };
}

export function openRouterCostMicros(usage) {
  if (!usage || usage.cost_usd == null) return null;
  try {
    return roundProviderCostMicros(usage.cost_usd);
  } catch {
    return null;
  }
}

export function classifyOpenRouterError(status, message) {
  const msg = String(message || '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'insufficient_credits';
  if (status === 429) return 'rate_limit';
  if (status === 408 || /timeout/.test(msg)) return 'timeout';
  if (status === 404 || /not found|no longer available/.test(msg)) return 'model_unavailable';
  if (status >= 500) return 'upstream_outage';
  if (/context|too many tokens|maximum context/.test(msg)) return 'context_overflow';
  if (/tool|function/.test(msg)) return 'unsupported_tools';
  if (/image|vision|multimodal/.test(msg)) return 'unsupported_image';
  return 'upstream_error';
}
