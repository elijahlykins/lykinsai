/**
 * LYKN model selection and routing policy.
 *
 * Modes:
 *   lykn      - default intelligent routing (existing chatRouting classifier)
 *   my_setup  - user category assignments, unset categories inherit LYKN
 *   model     - explicit single model
 *   route     - named ModelRoute (primary + LYKN-owned fallbacks)
 *
 * Categories match real LYKN routing meaning, not invented keyword lists.
 */

import { isSelectableModelId, resolveStoredModelId } from './registry.js';

export const SELECTION_MODES = Object.freeze({
  LYKN: 'lykn',
  MY_SETUP: 'my_setup',
  MODEL: 'model',
  ROUTE: 'route',
});

export const ROUTE_CATEGORIES = Object.freeze([
  'default',
  'quick',
  'reasoning',
  'coding',
  'vision',
  'research',
  'agents',
]);

export const MY_SETUP_ID = 'lykn-setup';

const AUTO_IDS = new Set(['lykn', 'lykn-lite', 'lykn-fast', 'lykn-deep', 'unified-auto', MY_SETUP_ID]);

export function isRoutingModeId(modelId) {
  return AUTO_IDS.has(String(modelId || '').trim());
}

export function normalizeSelectionMode(value) {
  const raw = String(value || '').trim();
  if (raw === SELECTION_MODES.MY_SETUP || raw === MY_SETUP_ID) return SELECTION_MODES.MY_SETUP;
  if (raw === SELECTION_MODES.MODEL) return SELECTION_MODES.MODEL;
  if (raw === SELECTION_MODES.ROUTE) return SELECTION_MODES.ROUTE;
  return SELECTION_MODES.LYKN;
}

/**
 * Infer the routing category from signals the stream path already computes.
 * No keyword lists — only structured flags and the classifier tier.
 */
export function inferRouteCategory({
  hasImages = false,
  forceImage = false,
  artifactToolName = '',
  deepResearch = false,
  autonomous = false,
  forAgent = false,
  modelTier = 'standard',
} = {}) {
  if (autonomous || forAgent) return 'agents';
  if (deepResearch) return 'research';
  if (artifactToolName) return 'coding';
  if (hasImages || forceImage) return 'vision';
  if (modelTier === 'fast') return 'quick';
  if (modelTier === 'advanced') return 'reasoning';
  return 'default';
}

export function emptyUserSetup() {
  return {
    mode: SELECTION_MODES.LYKN,
    categories: {},
    fallbackModelIds: [],
  };
}

/**
 * A model the user may assign in My Setup.
 * Accepts curated registry ids and OpenRouter vendor/model ids even before
 * the in-memory catalog has finished syncing.
 */
export function acceptAssignedModelId(value) {
  const raw = String(value || '').trim();
  if (!raw || AUTO_IDS.has(raw) || raw === 'inherit') return null;
  if (isSelectableModelId(raw)) return raw;
  const stored = resolveStoredModelId(raw);
  if (stored) return stored;
  if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9._:/-]+$/i.test(raw) && raw.length <= 160) {
    return raw;
  }
  return null;
}

export function sanitizeCategoryMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const category of ROUTE_CATEGORIES) {
    const id = acceptAssignedModelId(raw[category]);
    if (id) out[category] = id;
  }
  return out;
}

export function sanitizeFallbackIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const id = acceptAssignedModelId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Resolve a user My Setup assignment for a category.
 * Unset categories return null so the caller inherits LYKN defaults.
 */
export function resolveSetupAssignment(setup, category) {
  const map = sanitizeCategoryMap(setup?.categories);
  const key = ROUTE_CATEGORIES.includes(category) ? category : 'default';
  return map[key] || map.default || null;
}

export function sanitizeRouteRecord(input = {}) {
  const primary = acceptAssignedModelId(input.primaryModelId);
  if (!primary) return { ok: false, error: 'invalid_primary_model' };
  const purpose = ROUTE_CATEGORIES.includes(input.purpose) ? input.purpose : 'default';
  return {
    ok: true,
    route: {
      name: String(input.name || purpose).trim().slice(0, 80) || purpose,
      purpose,
      primaryModelId: primary,
      fallbackModelIds: sanitizeFallbackIds(input.fallbackModelIds).filter((id) => id !== primary),
      configuration: sanitizeRouteConfiguration(input.configuration),
      enabled: input.enabled !== false,
    },
  };
}

export function sanitizeRouteConfiguration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  if (typeof raw.fallbackEnabled === 'boolean') out.fallbackEnabled = raw.fallbackEnabled;
  if (Number.isInteger(raw.maxCostMicros) && raw.maxCostMicros > 0) out.maxCostMicros = raw.maxCostMicros;
  if (raw.latencyPreference === 'low' || raw.latencyPreference === 'balanced') {
    out.latencyPreference = raw.latencyPreference;
  }
  return out;
}

/**
 * Bot model policy. Missing/legacy bots inherit LYKN.
 * Designed so a later multi-step workflow can add `steps` without
 * assuming bot → one model string forever.
 */
export function sanitizeBotModelPolicy(raw) {
  if (!raw || typeof raw !== 'object') {
    return { mode: SELECTION_MODES.LYKN, routeId: null, modelId: null, steps: null };
  }
  const mode = normalizeSelectionMode(raw.mode);
  const modelId = mode === SELECTION_MODES.MODEL
    ? (resolveStoredModelId(raw.modelId) || (isSelectableModelId(raw.modelId) ? String(raw.modelId) : null))
    : null;
  const routeId = mode === SELECTION_MODES.ROUTE
    ? String(raw.routeId || '').trim().slice(0, 80) || null
    : null;
  return {
    mode,
    routeId,
    modelId,
    steps: Array.isArray(raw.steps) ? raw.steps.slice(0, 8) : null,
  };
}

export function requestedModelForPolicy(policy) {
  const clean = sanitizeBotModelPolicy(policy);
  if (clean.mode === SELECTION_MODES.MY_SETUP) return MY_SETUP_ID;
  if (clean.mode === SELECTION_MODES.MODEL && clean.modelId) return clean.modelId;
  return 'lykn';
}
