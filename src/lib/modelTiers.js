// Plan-aware model gating. Shared between the client (picker locks +
// auto-downgrade) and the server (request validation). Keep in sync
// with `PLAN_LIMITS.modelTier` in `src/lib/pricing-config.js`.
//
// LYKN exposes three brand-aliased tiers backed by various models, plus
// direct access to one flagship from each major provider on Pro:
//   - lykn-lite                 : cheapest. Free + paid.
//   - lykn-fast                 : everyday workhorse. Paid plans.
//   - lykn-deep                 : heavy reasoning. Paid plans.
//   - GPT-5 / Claude / Gemini / Grok : raw frontier picks. Pro only.
//
// Plan → access mapping:
//   - free        : Lite only
//   - studio (Pro): Lite + Fast + Deep + Frontier
//   - studio_pro / studio_max (legacy billing ids): same as Pro
//
// `modelTier` strings from pricing-config.js map to these access sets:
//   "basic"      → Lite only
//   "top+media"  → Lite + Fast + Deep + Frontier   (Pro)

import {
  LYKN_LITE_ID,
  LYKN_FAST_ID,
  LYKN_DEEP_ID,
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
  LEGACY_LYKN_ID,
  KNOWN_MODEL_IDS,
} from "./modelCatalog.js";

export const MODEL_TIER_BASIC = "basic";
export const MODEL_TIER_STANDARD = "standard";
export const MODEL_TIER_FRONTIER = "frontier";

export const BASIC_MODEL_IDS = new Set([LYKN_LITE_ID]);

const STANDARD_MODEL_IDS = new Set([LYKN_FAST_ID, LYKN_DEEP_ID]);

const FRONTIER_MODEL_IDS = new Set([
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
]);

const LEGACY_ALIASES = {
  [LEGACY_LYKN_ID]: LYKN_FAST_ID,
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
  if (BASIC_MODEL_IDS.has(id)) return MODEL_TIER_BASIC;
  if (FRONTIER_MODEL_IDS.has(id)) return MODEL_TIER_FRONTIER;
  return MODEL_TIER_STANDARD;
}

export function allowedTiersForPlan(planModelTier) {
  switch (String(planModelTier || "basic")) {
    case "top+media":
    case "top":
      // Pro: full LYKN lineup + frontier flagships.
      return new Set([MODEL_TIER_BASIC, MODEL_TIER_STANDARD, MODEL_TIER_FRONTIER]);
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

export function defaultModelForTier(planModelTier) {
  switch (String(planModelTier || "basic")) {
    case "top+media":
    case "top":
      return LYKN_FAST_ID;
    case "basic":
    default:
      return LYKN_LITE_ID;
  }
}

export {
  LYKN_LITE_ID,
  LYKN_FAST_ID,
  LYKN_DEEP_ID,
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
};
