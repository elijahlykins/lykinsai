import { FRONTIER_OPENAI_ID } from '../../../src/lib/modelCatalog.js';
import { LYKN_ROUTED_MODELS, resolveLyknAlias } from '../modelInvoke.js';
import { isSelectableModelId, resolveStoredModelId } from '../../../lib/models/registry.js';
import {
  inferRouteCategory,
  MY_SETUP_ID,
  resolveSetupAssignment,
  sanitizeBotModelPolicy,
  SELECTION_MODES,
} from '../../../lib/models/routingPolicy.js';
import { classifyChatComplexity } from './classifyChatComplexity.js';
import {
  CHAT_MODEL_TIERS,
  CHAT_ROUTE_MODELS,
  ROUTING_SOURCES,
  isAutoRoutedModelId,
} from './chatRoutingConfig.js';
import { planHasUnlimitedNormalChat } from './chatBilling.js';
import {
  clampReasoningEffort,
  defaultReasoningForTier,
} from './resolveReasoningEffort.js';

function modelForTier(tier) {
  if (tier === CHAT_MODEL_TIERS.FAST) return CHAT_ROUTE_MODELS.fast;
  if (tier === CHAT_MODEL_TIERS.ADVANCED) return CHAT_ROUTE_MODELS.advanced;
  return CHAT_ROUTE_MODELS.standard;
}

function inferTierFromModel(modelId) {
  const id = String(modelId || '');
  if (id === CHAT_ROUTE_MODELS.fast || id.includes('luna') || id.includes('nano') || id.includes('flash')) {
    return CHAT_MODEL_TIERS.FAST;
  }
  if (id === CHAT_ROUTE_MODELS.advanced || id === FRONTIER_OPENAI_ID || id.includes('sol') || id.includes('opus')) {
    return CHAT_MODEL_TIERS.ADVANCED;
  }
  return CHAT_MODEL_TIERS.STANDARD;
}

function standardFallback(reason, planId = null) {
  return buildChatRouteDecision({
    modelTier: CHAT_MODEL_TIERS.STANDARD,
    modelId: CHAT_ROUTE_MODELS.standard,
    reasoningEffort: defaultReasoningForTier(CHAT_MODEL_TIERS.STANDARD, planId),
    confidence: 0.5,
    reason,
    routingSource: ROUTING_SOURCES.FALLBACK,
    planId,
  });
}

export function buildChatRouteDecision({
  modelTier,
  modelId,
  reasoningEffort,
  confidence,
  reason,
  routingSource,
  planId,
  routeId = null,
  selectionMode = null,
  fallbackModelIds = null,
}) {
  const resolvedModel = resolveLyknAlias(modelId) || modelId;
  const effort = clampReasoningEffort(resolvedModel, reasoningEffort) || 'none';
  return {
    modelTier,
    modelId: resolvedModel,
    reasoningEffort: effort,
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 0,
    reason: String(reason || '').slice(0, 240),
    billableChatCredits: planHasUnlimitedNormalChat(planId) ? 0 : null,
    routingSource,
    planId: planId || null,
    routeId,
    selectionMode,
    fallbackModelIds,
  };
}

export function chatRouteUsageMetadata(route, extra = {}) {
  const routingSource = route?.routingSource || extra.routingSource || null;
  return {
    model_tier: route?.modelTier || null,
    reasoning_effort: route?.reasoningEffort || extra.reasoningEffort || null,
    routing_source: routingSource,
    routing_reason: route?.reason || null,
    routing_confidence: route?.confidence ?? null,
    plan: extra.planId || route?.planId || null,
    consumed_credits: extra.consumedCredits ?? null,
    route_id: route?.routeId || extra.routeId || null,
    bot_id: extra.botId || null,
    selection_mode: route?.selectionMode || extra.selectionMode || null,
    fallback_model_ids: route?.fallbackModelIds || extra.fallbackModelIds || null,
    // Billing inputs: a manual pick is only included chat while the model's
    // registry pricing stays at or below the Auto advanced tier
    // (lib/billing/usageEntitlements.js decides from these two fields).
    explicit_model_override: routingSource === ROUTING_SOURCES.OVERRIDE,
    requested_model: route?.modelId || null,
  };
}

function explicitDecision(modelId, planId, reason, routingSource, extra = {}) {
  const resolved = LYKN_ROUTED_MODELS[modelId]
    ? resolveLyknAlias(modelId)
    : (resolveStoredModelId(modelId) || modelId);
  const tier = inferTierFromModel(resolved);
  return buildChatRouteDecision({
    modelTier: extra.modelTier || tier,
    modelId: resolved,
    reasoningEffort: extra.reasoningEffort || defaultReasoningForTier(tier, planId),
    confidence: extra.confidence ?? 1,
    reason,
    routingSource,
    planId,
    routeId: extra.routeId || null,
    selectionMode: extra.selectionMode || null,
    fallbackModelIds: extra.fallbackModelIds || null,
  });
}

export async function resolveChatRoute(input = {}) {
  const requested = String(input.requestedModel || '').trim();
  const planId = input.planId || 'free';
  const policy = sanitizeBotModelPolicy(input.modelPolicy);
  const userSetup = input.userSettings || null;

  try {
    if (policy.mode === SELECTION_MODES.ROUTE && input.resolvedRoute?.primaryModelId) {
      return explicitDecision(
        input.resolvedRoute.primaryModelId,
        planId,
        'named route',
        ROUTING_SOURCES.ROUTE,
        {
          routeId: input.resolvedRoute.id || policy.routeId,
          selectionMode: SELECTION_MODES.ROUTE,
          fallbackModelIds: input.resolvedRoute.fallbackModelIds || [],
        },
      );
    }

    if (policy.mode === SELECTION_MODES.MODEL && policy.modelId) {
      return explicitDecision(policy.modelId, planId, 'bot specific model', ROUTING_SOURCES.OVERRIDE, {
        selectionMode: SELECTION_MODES.MODEL,
      });
    }

    const wantsSetup = policy.mode === SELECTION_MODES.MY_SETUP
      || requested === MY_SETUP_ID
      || (!requested && userSetup?.mode === SELECTION_MODES.MY_SETUP);

    if (requested && !isAutoRoutedModelId(requested) && !wantsSetup) {
      const resolved = isSelectableModelId(requested)
        ? requested
        : (resolveStoredModelId(requested) || requested);
      return explicitDecision(resolved, planId, 'explicit model selection', ROUTING_SOURCES.OVERRIDE, {
        selectionMode: SELECTION_MODES.MODEL,
      });
    }

    const classified = await classifyChatComplexity({
      text: input.text,
      planId,
      hasImages: input.hasImages,
      hasLargeContext: input.hasLargeContext,
      conversationLength: input.conversationLength,
      forceImage: input.forceImage,
      deepResearch: input.deepResearch,
      artifactToolName: input.artifactToolName,
      classifyFn: input.classifyFn,
    });

    if (wantsSetup) {
      const category = inferRouteCategory({
        hasImages: input.hasImages,
        forceImage: input.forceImage,
        artifactToolName: input.artifactToolName,
        deepResearch: input.deepResearch,
        autonomous: input.autonomous,
        forAgent: input.forAgent,
        modelTier: classified.modelTier,
      });
      const assigned = resolveSetupAssignment(userSetup, category);
      if (assigned) {
        return explicitDecision(assigned, planId, `my setup ${category}`, ROUTING_SOURCES.USER_SETUP, {
          modelTier: classified.modelTier,
          selectionMode: SELECTION_MODES.MY_SETUP,
          fallbackModelIds: userSetup?.fallbackModelIds || [],
        });
      }
    }

    const modelId = modelForTier(classified.modelTier);
    return buildChatRouteDecision({
      modelTier: classified.modelTier,
      modelId,
      reasoningEffort: defaultReasoningForTier(classified.modelTier, planId),
      confidence: classified.confidence,
      reason: classified.reason,
      routingSource: classified.routingSource,
      planId,
      selectionMode: wantsSetup ? SELECTION_MODES.MY_SETUP : SELECTION_MODES.LYKN,
      fallbackModelIds: wantsSetup ? (userSetup?.fallbackModelIds || []) : null,
    });
  } catch (err) {
    return standardFallback(`classifier failed: ${err?.message || err}`, planId);
  }
}
