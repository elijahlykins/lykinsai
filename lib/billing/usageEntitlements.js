/**
 * What a subscription includes versus what Usage Balance pays for.
 *
 * Pro / Student / Max normal LYKN chat is included: LYKN Auto routing
 * (Luna / Terra / Sol and reasoning routing) never deducts Usage.
 *
 * A manually selected model stays included only while its canonical
 * registry pricing is at or below the most expensive model LYKN Auto
 * itself routes to. Anything above that baseline is premium and meters
 * Usage — decided from model metadata, never model-name keywords.
 *
 * Autonomous compute is never treated as included chat.
 */

import { planIncludesChat } from './planCatalog.js';
import { modelPricing } from '../models/registry.js';
import { findModelPricing } from '../models/pricingTable.js';
import {
  CHAT_ROUTE_MODELS,
  isAutoRoutedModelId,
} from '../../server/ai/chatRouting/chatRoutingConfig.js';

const CHAT_ACTIONS = new Set(['chat_short', 'chat_long', 'chat_complex']);

export function isChatUsageAction(actionType) {
  return CHAT_ACTIONS.has(String(actionType || ''));
}

export const USAGE_KIND = Object.freeze({
  HUMAN_CHAT: 'human_chat',
  AUTONOMOUS: 'autonomous',
});

/**
 * The included-chat ceiling: the advanced tier of LYKN Auto routing.
 * Auto chat can already route here, so any manual model at or below this
 * price adds no cost over what the subscription includes.
 */
export function includedChatBaseline() {
  const baselineId = CHAT_ROUTE_MODELS.advanced;
  const pricing = modelPricing(baselineId) || findModelPricing(baselineId);
  return {
    modelId: baselineId,
    inputPer1k: Number(pricing?.input) || 0,
    outputPer1k: Number(pricing?.output) || 0,
  };
}

function pricingForModel(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  return modelPricing(id) || null;
}

/**
 * Is this manually selected model included for a paid plan's chat?
 *
 * Included only when BOTH input and output unit prices are at or below the
 * baseline. Unknown models fail closed to premium/metered.
 */
export function isModelIncludedForPaidChat(modelId) {
  const id = String(modelId || '').trim();
  if (!id || isAutoRoutedModelId(id)) return true;
  const baseline = includedChatBaseline();
  if (id === baseline.modelId) return true;
  const pricing = pricingForModel(id);
  if (!pricing) return false;
  const input = Number(pricing.input);
  const output = Number(pricing.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return false;
  return input <= baseline.inputPer1k && output <= baseline.outputPer1k;
}

export function resolveUsageKind({ usageKind, autonomous = false } = {}) {
  if (autonomous || usageKind === USAGE_KIND.AUTONOMOUS) return USAGE_KIND.AUTONOMOUS;
  return usageKind || USAGE_KIND.HUMAN_CHAT;
}

/**
 * Does the subscription cover this usage at $0 customer charge?
 * Underlying provider cost is still recorded via lykn_usage_events.
 */
export function isIncludedSubscriptionUsage({
  actionType,
  planId = 'free',
  usageKind,
  autonomous = false,
  explicitModelOverride = false,
  requestedModel = null,
} = {}) {
  const kind = resolveUsageKind({ usageKind, autonomous });
  if (kind === USAGE_KIND.AUTONOMOUS) return false;

  if (!isChatUsageAction(actionType)) return false;
  if (!planIncludesChat(planId)) return false;

  if (explicitModelOverride) {
    return isModelIncludedForPaidChat(requestedModel);
  }

  return true;
}

/**
 * Customer-facing model billing state for a paid plan's picker.
 * 'included' | 'metered' — never expose multipliers or provider cost.
 */
export function modelBillingStateForPaidChat(modelId) {
  return isModelIncludedForPaidChat(modelId) ? 'included' : 'metered';
}
