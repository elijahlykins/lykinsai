// Plan-aware model gating. Shared between the client (picker locks +
// auto-downgrade) and the server (request validation). Keep in sync
// with `PLAN_LIMITS.modelTier` in `src/lib/pricing-config.js`.
//
// LYKN exposes three brand-aliased tiers backed by various models, plus
// (Max only) direct access to one flagship from each major provider:
//   - lykn-lite                 : cheapest. Free + paid.
//   - lykn-fast                 : everyday workhorse. Paid plans.
//   - lykn-deep                 : heavy reasoning. Paid plans.
//   - GPT-5 / Claude Opus 4.7
//     / Gemini 3.1 Pro / Grok 4 : raw frontier picks. Max only.
//
// Plan → access mapping:
//   - free        : Lite only
//   - studio (Pro): Lite + Fast + Deep
//   - studio_pro (Max) / studio_max (Teams): Lite + Fast + Deep + Frontier
//
// `modelTier` strings from pricing-config.js map to these access sets:
//   "basic"      → Lite only
//   "top"        → Lite + Fast + Deep   (Pro plan)
//   "top+media"  → Lite + Fast + Deep + Frontier   (Max / Teams)

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
// Max-only frontier tier. Gives direct access to one flagship per
// provider (GPT-5 / Claude Opus 4.7 / Gemini 3.1 Pro / Grok 4). Pro
// plan does NOT see these as available — locked badge in the picker.
export const MODEL_TIER_FRONTIER = "frontier";

// Models available on the free tier.
export const BASIC_MODEL_IDS = new Set([LYKN_LITE_ID]);

// Workhorse paid tier — every paid plan can use these.
const STANDARD_MODEL_IDS = new Set([LYKN_FAST_ID, LYKN_DEEP_ID]);

// Frontier picks — Max plan only. One per provider so users on $65/mo
// can run their question against the actual top-tier model from the
// vendor of their choice. Keep in sync with the FRONTIER_* exports
// in `modelCatalog.js`; the constants are the single source of truth.
const FRONTIER_MODEL_IDS = new Set([
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
]);

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
  if (FRONTIER_MODEL_IDS.has(id)) return MODEL_TIER_FRONTIER;
  return MODEL_TIER_STANDARD;
}

// Given a plan's modelTier string (from pricing-config.js), return the
// set of internal model tiers that plan can invoke.
export function allowedTiersForPlan(planModelTier) {
  switch (String(planModelTier || "basic")) {
    case "top+media":
      // Max + Teams: every tier including frontier flagships.
      return new Set([MODEL_TIER_BASIC, MODEL_TIER_STANDARD, MODEL_TIER_FRONTIER]);
    case "top":
      // Pro: full LYKN lineup but no raw frontier models. Locked items
      // still render in the picker so the user sees the upgrade path.
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
// problems, frontier models are opt-in per-question — we don't burn
// $5/M-output models on every reply).
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
export {
  LYKN_LITE_ID,
  LYKN_FAST_ID,
  LYKN_DEEP_ID,
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
};
