// Plan-aware model gating. Shared between the client (picker locks +
// auto-downgrade) and the server (request validation). Keep in sync
// with `PLAN_LIMITS.modelTier` in `src/lib/pricing-config.js`.
//
// LYKN exposes three Gemini-backed tiers, in ascending capability:
//   - lykn-lite  : cheapest Gemini Flash-Lite. Free plan + logged-out preview.
//   - lykn-fast  : Gemini Flash for everyday reasoning. Paid plans.
//   - lykn-deep  : Gemini Pro for deep, multi-step thinking. Paid plans.
//
// Plan → access mapping:
//   - free        : lykn-lite only
//   - studio      : lykn-lite + lykn-fast + lykn-deep
//   - studio_pro  : lykn-lite + lykn-fast + lykn-deep
//   - studio_max  : lykn-lite + lykn-fast + lykn-deep
//
// `modelTier` strings from pricing-config.js map to these access sets:
//   "basic"      → Lite only
//   "top"        → all three
//   "top+media"  → all three (legacy alias, kept for back-compat)

import {
  LYKN_LITE_ID,
  LYKN_FAST_ID,
  LYKN_DEEP_ID,
  LEGACY_LYKN_ID,
  KNOWN_MODEL_IDS,
} from "./modelCatalog.js";

export const MODEL_TIER_BASIC = "basic";
export const MODEL_TIER_STANDARD = "standard";

// Models available on the free tier.
export const BASIC_MODEL_IDS = new Set([LYKN_LITE_ID]);

// All paid tiers can use these on top of the basic set.
const STANDARD_MODEL_IDS = new Set([LYKN_FAST_ID, LYKN_DEEP_ID]);

// Used to migrate older client storage / DB values that still reference
// the original single-tier "lykn" id. We treat the legacy id as the
// middle "Fast Reasoning" tier.
const LEGACY_ALIASES = {
  [LEGACY_LYKN_ID]: LYKN_FAST_ID,
};

// Resolve a possibly-legacy id to a current LYKN id. Returns `null` for
// anything unrecognised so callers can decide whether to downgrade the
// user to a sensible default.
export function canonicalizeModelId(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return null;
  if (LEGACY_ALIASES[id]) return LEGACY_ALIASES[id];
  if (KNOWN_MODEL_IDS.includes(id)) return id;
  return null;
}

// Given a model id, which internal tier does it belong to? Anything
// outside the LYKN catalog (e.g. stale `claude-sonnet-4-6` from older
// localStorage) classifies as STANDARD so the plan check rejects it on
// free, which triggers `defaultModelForTier` and migrates the user to
// the right LYKN id.
export function classifyModel(modelId) {
  const id = canonicalizeModelId(modelId) || String(modelId || "").trim();
  if (!id) return MODEL_TIER_BASIC;
  if (BASIC_MODEL_IDS.has(id)) return MODEL_TIER_BASIC;
  return MODEL_TIER_STANDARD;
}

// Given a plan's modelTier string (from pricing-config.js), return the
// set of internal model tiers that plan can invoke.
export function allowedTiersForPlan(planModelTier) {
  switch (String(planModelTier || "basic")) {
    case "top+media":
    case "top":
      return new Set([MODEL_TIER_BASIC, MODEL_TIER_STANDARD]);
    case "basic":
    default:
      return new Set([MODEL_TIER_BASIC]);
  }
}

export function isModelAllowedForPlan(modelId, planModelTier) {
  // Reject anything outside the current LYKN catalog. Legacy ids from
  // older localStorage values are accepted only after canonicalisation,
  // which keeps the picker auto-downgrade path honest.
  const canonical = canonicalizeModelId(modelId);
  if (!canonical) return false;
  return allowedTiersForPlan(planModelTier).has(classifyModel(canonical));
}

// Safe default model for a given plan tier. Free gets Lite; every paid
// plan defaults to Fast Reasoning (Deep Thinking is opt-in for heavy
// problems so we don't burn Pro tokens on every reply).
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

// Re-export the canonical ids so callers don't have to chase them
// through `modelCatalog` if they already imported from here.
export { LYKN_LITE_ID, LYKN_FAST_ID, LYKN_DEEP_ID };
