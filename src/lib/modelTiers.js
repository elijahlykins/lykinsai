// Plan-aware model gating. Shared between the client (picker locks +
// auto-downgrade) and the server (request validation). Keep in sync
// with `PLAN_LIMITS.modelTier` in `src/lib/pricing-config.js`.
//
//   - lykn              : LYKN brand model. Free + Pro.
//   - frontier picks    : GPT / Claude / Gemini / Grok. Pro only.
//
// Plan → access mapping:
//   - free        : LYKN only
//   - studio (Pro): LYKN + frontier
//
// `modelTier` strings from pricing-config.js:
//   "basic"      → LYKN only
//   "top+media"  → LYKN + frontier

import {
  LYKN_ID,
  LEGACY_LYKN_LITE_ID,
  LEGACY_LYKN_FAST_ID,
  LEGACY_LYKN_DEEP_ID,
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
  KNOWN_MODEL_IDS,
  AGENT_BUILDER_MODEL_IDS,
  AGENT_BUILDER_DEFAULT_MODEL,
  CLAUDE_OPUS_4_8_ID,
} from "./modelCatalog.js";

export const MODEL_TIER_BASIC = "basic";
export const MODEL_TIER_FRONTIER = "frontier";

export const BASIC_MODEL_IDS = new Set([LYKN_ID]);

const FRONTIER_MODEL_IDS = new Set([
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
]);

const LEGACY_ALIASES = {
  [LEGACY_LYKN_LITE_ID]: LYKN_ID,
  [LEGACY_LYKN_FAST_ID]: LYKN_ID,
  [LEGACY_LYKN_DEEP_ID]: LYKN_ID,
};

export function canonicalizeModelId(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return null;
  if (LEGACY_ALIASES[id]) return LEGACY_ALIASES[id];
  if (KNOWN_MODEL_IDS.includes(id)) return id;
  return null;
}

export function classifyModel(modelId) {
  const id = canonicalizeModelId(modelId) || String(modelId || "").trim();
  if (!id) return MODEL_TIER_BASIC;
  if (FRONTIER_MODEL_IDS.has(id)) return MODEL_TIER_FRONTIER;
  return MODEL_TIER_BASIC;
}

export function allowedTiersForPlan(planModelTier) {
  switch (String(planModelTier || "basic")) {
    case "top+media":
    case "top":
      return new Set([MODEL_TIER_BASIC, MODEL_TIER_FRONTIER]);
    case "basic":
    default:
      return new Set([MODEL_TIER_BASIC]);
  }
}

export function isModelAllowedForPlan(modelId, planModelTier) {
  const canonical = canonicalizeModelId(modelId);
  if (!canonical) return false;
  return allowedTiersForPlan(planModelTier).has(classifyModel(canonical));
}

export function defaultModelForTier(_planModelTier) {
  return LYKN_ID;
}

/** Older Agent Studio / localStorage ids → Opus 4.8 */
const AGENT_BUILDER_ALIASES = {
  "claude-opus-4-7": CLAUDE_OPUS_4_8_ID,
  "claude-opus-4-6": CLAUDE_OPUS_4_8_ID,
  "claude-opus-4-6-code": CLAUDE_OPUS_4_8_ID,
  "claude-3-opus-20240229": CLAUDE_OPUS_4_8_ID,
};

export function canonicalizeAgentBuilderModelId(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return null;
  if (AGENT_BUILDER_ALIASES[id]) return AGENT_BUILDER_ALIASES[id];
  if (AGENT_BUILDER_MODEL_IDS.includes(id)) return id;
  return null;
}

/**
 * Agent Studio models are Pro-tier frontier picks (not the LYKN alias).
 * @param {{ devUnlock?: boolean }} [opts] — true in local Agent Studio dev to skip plan lock.
 */
export function isAgentBuilderModelAllowed(modelId, planModelTier, opts = {}) {
  const canonical = canonicalizeAgentBuilderModelId(modelId);
  if (!canonical) return false;
  if (opts.devUnlock) return true;
  return allowedTiersForPlan(planModelTier).has(MODEL_TIER_FRONTIER);
}

export function defaultAgentBuilderModelForPlan(planModelTier, opts = {}) {
  for (const id of AGENT_BUILDER_MODEL_IDS) {
    if (isAgentBuilderModelAllowed(id, planModelTier, opts)) return id;
  }
  return AGENT_BUILDER_DEFAULT_MODEL;
}

export {
  LYKN_ID,
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
};
