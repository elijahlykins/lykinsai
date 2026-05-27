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

export {
  LYKN_ID,
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
};
