// Model access tiers. Shared between the client (picker gating) and the
// server (request validation). Keep in sync with `PLAN_LIMITS.modelTier` in
// src/lib/pricing-config.js.
//
// Two internal tiers (listed cheapest → priciest):
//   - "basic"    : fast, non-thinking LLMs. Free plan + logged-out preview.
//   - "standard" : full premium text LLMs (Sonnet 4.6, GPT-5.4, Gemini Pro,
//                  reasoning models, etc). Studio+
//
// Plan → tier access mapping:
//   - free        : basic
//   - studio      : basic + standard
//   - studio_pro  : basic + standard
//   - studio_max  : basic + standard
//
// `modelTier` strings from pricing-config.js map to these buckets:
//   "basic" → basic only
//   "top"   → basic + standard
//   "top+media" → basic + standard (legacy alias kept for back-compat; image/
//                 video generation has been removed from the product)

export const MODEL_TIER_BASIC = "basic";
export const MODEL_TIER_STANDARD = "standard";

// Non-thinking / fast text LLMs available on the free tier.
export const BASIC_MODEL_IDS = new Set([
  // Anthropic
  "claude-haiku-4-5-20251001",
  // Google (Flash family)
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  // OpenAI (mini / nano)
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-5-mini",
  // xAI (non-reasoning / mini)
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-3-mini",
]);

// Given a model id, which internal tier does it belong to?
export function classifyModel(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return MODEL_TIER_BASIC;
  if (BASIC_MODEL_IDS.has(id)) return MODEL_TIER_BASIC;
  return MODEL_TIER_STANDARD;
}

// Given a plan's modelTier string (from pricing-config.js), return the set of
// internal model tiers that plan can invoke.
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
  return allowedTiersForPlan(planModelTier).has(classifyModel(modelId));
}

// Safe default model for a given plan tier. Picked so downgrades keep working
// even if the environment is missing some provider keys.
export function defaultModelForTier(planModelTier) {
  switch (String(planModelTier || "basic")) {
    case "top+media":
    case "top":
      return "claude-sonnet-4-6";
    case "basic":
    default:
      return "claude-haiku-4-5-20251001";
  }
}
