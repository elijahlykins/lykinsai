import {
  CHAT_MODEL_TIERS,
  PLAN_REASONING_DEFAULTS,
  REASONING_EFFORTS,
} from './chatRoutingConfig.js';

const GPT56_BASE = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']);
const GPT56_SOL = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const GPT5_FAMILY = Object.freeze(['none', 'low', 'medium', 'high']);
const O_SERIES = Object.freeze(['low', 'medium', 'high']);

export function supportedReasoningEfforts(modelId) {
  const model = String(modelId || '').toLowerCase();
  if (!model) return [];
  if (model === 'gpt-5.6-sol') return [...GPT56_SOL];
  if (model.startsWith('gpt-5.6')) return [...GPT56_BASE];
  if (model.startsWith('gpt-5')) return [...GPT5_FAMILY];
  if (model === 'o3' || model === 'o3-pro' || model === 'o4-mini') return [...O_SERIES];
  return [];
}

export function clampReasoningEffort(modelId, effort) {
  const wanted = String(effort || 'none').toLowerCase();
  const supported = supportedReasoningEfforts(modelId);
  if (!supported.length) return null;
  if (supported.includes(wanted)) return wanted;
  const order = REASONING_EFFORTS;
  const idx = order.indexOf(wanted);
  if (idx < 0) return supported.includes('none') ? 'none' : supported[0];
  for (let i = idx; i >= 0; i -= 1) {
    if (supported.includes(order[i])) return order[i];
  }
  return supported[0];
}

export function defaultReasoningForTier(tier, planId) {
  const plan = String(planId || '').toLowerCase() === 'max'
    ? PLAN_REASONING_DEFAULTS.max
    : PLAN_REASONING_DEFAULTS.default;
  if (tier === CHAT_MODEL_TIERS.FAST) return plan.fast;
  if (tier === CHAT_MODEL_TIERS.ADVANCED) return plan.advanced;
  return plan.standard;
}

/**
 * Provider body fragment. Empty object when the model does not accept
 * reasoning_effort, so callers can spread it safely.
 */
export function openaiReasoningPayload(modelId, effort) {
  const clamped = clampReasoningEffort(modelId, effort);
  if (!clamped) return {};
  if (!String(modelId || '').startsWith('gpt-') && !['o3', 'o3-pro', 'o4-mini'].includes(String(modelId || ''))) {
    return {};
  }
  return { reasoning_effort: clamped };
}
