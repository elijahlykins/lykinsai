// Plan-aware model gating. Shared between the client (picker locks +
// auto-downgrade) and the server (request validation). Keep in sync
// with `PLAN_LIMITS.modelTier` in `src/lib/pricing-config.js`.

import {
  LYKN_ID,
  MY_SETUP_ID,
  LEGACY_LYKN_LITE_ID,
  LEGACY_LYKN_FAST_ID,
  LEGACY_LYKN_DEEP_ID,
  LEGACY_FRONTIER_ALIASES,
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
  KNOWN_MODEL_IDS,
} from "./modelCatalog.js";

export const MODEL_TIER_BASIC = "basic";
export const MODEL_TIER_FRONTIER = "frontier";

export const BASIC_MODEL_IDS = new Set([LYKN_ID, MY_SETUP_ID]);

const FRONTIER_MODEL_IDS = new Set(
  KNOWN_MODEL_IDS.filter((id) => !BASIC_MODEL_IDS.has(id)),
);

const LEGACY_ALIASES = {
  [LEGACY_LYKN_LITE_ID]: LYKN_ID,
  [LEGACY_LYKN_FAST_ID]: LYKN_ID,
  [LEGACY_LYKN_DEEP_ID]: LYKN_ID,
  ...LEGACY_FRONTIER_ALIASES,
};

const OPENROUTER_ID_RE = /^[a-z0-9._-]+\/[a-z0-9._:/-]{1,180}$/i;
const IMAGINE_ID_RE = /^(gpt-image-2|dall-e-3|gemini-2\.5-flash-image|gemini-3\.1-flash-image)$/;

export function canonicalizeModelId(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return null;
  if (id === "auto") return id;
  if (LEGACY_ALIASES[id]) return LEGACY_ALIASES[id];
  if (KNOWN_MODEL_IDS.includes(id)) return id;
  // OpenRouter catalog (vendor/model) and Imagine generators: selectable on
  // paid plans the same way curated frontier ids are. Unknown junk stays out.
  if (OPENROUTER_ID_RE.test(id) || IMAGINE_ID_RE.test(id)) return id;
  return null;
}

export function classifyModel(modelId) {
  const id = canonicalizeModelId(modelId) || String(modelId || "").trim();
  if (!id || id === "auto") return MODEL_TIER_BASIC;
  if (BASIC_MODEL_IDS.has(id)) return MODEL_TIER_BASIC;
  if (FRONTIER_MODEL_IDS.has(id)) return MODEL_TIER_FRONTIER;
  // Catalog / Imagine ids that passed canonicalize are paid-plan frontier.
  return MODEL_TIER_FRONTIER;
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
