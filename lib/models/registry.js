/**
 * LYKN model registry — the canonical, normalized model catalog.
 *
 * One authority for: which models exist, their capabilities, context windows,
 * price estimates, which gateway serves them, and what clients may select.
 *
 * Sources:
 *   1. Curated seed (catalogSeed.js) — AVAILABLE + RECOMMENDED, always present.
 *   2. Gateway sync (OpenRouter catalog) — merged with visibility 'catalog';
 *      a third-party catalog can never promote itself into the curated picker.
 *
 * The registry is in-memory and rebuilt on process start. Gateway sync
 * refreshes it periodically (see lib/inference/openRouterCatalog.js).
 */

import {
  GATEWAYS,
  MODEL_VISIBILITY,
  buildCuratedSeed,
  openRouterIdFor,
  providerForCatalogId,
} from './catalogSeed.js';

export { GATEWAYS, MODEL_VISIBILITY, openRouterIdFor, providerForCatalogId };

/** @typedef {import('./catalogSeed.js').ModelDefinition} ModelDefinition */

/** Curated ids, keyed by canonical id. Never removed by gateway sync. */
const curated = new Map(buildCuratedSeed().map((def) => [def.id, def]));

/** Gateway-synced catalog entries (OpenRouter), keyed by canonical id. */
const synced = new Map();

/**
 * Canonicalize a client-submitted model id.
 * Registry-level only: brand routing ids ('lykn') are a routing mode, not a
 * model, and provider-level dated aliases stay in server/ai/modelInvoke.js.
 */
export function canonicalModelId(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  if (curated.has(id) || synced.has(id)) return id;
  return null;
}

/** @returns {ModelDefinition|null} */
export function getModel(modelId) {
  const id = String(modelId || '').trim();
  return curated.get(id) || synced.get(id) || null;
}

export function hasModel(modelId) {
  return getModel(modelId) != null;
}

/**
 * May a client select this id directly? Enabled, not deprecated, and known.
 * This is the server-side validation gate for user-submitted model ids.
 */
export function isSelectableModelId(modelId) {
  const def = getModel(modelId);
  return Boolean(def && def.enabled && !def.deprecated);
}

/**
 * @param {object} [filter]
 * @param {string} [filter.provider]
 * @param {string} [filter.gateway]
 * @param {string} [filter.visibility]
 * @param {boolean} [filter.recommended]
 * @param {boolean} [filter.enabledOnly=true]
 * @param {string} [filter.capability]  tools | vision | reasoning | structuredOutput
 * @returns {ModelDefinition[]}
 */
export function listModels(filter = {}) {
  const { provider, gateway, visibility, recommended, capability, enabledOnly = true } = filter;
  const out = [];
  for (const def of [...curated.values(), ...synced.values()]) {
    if (enabledOnly && (!def.enabled || def.deprecated)) continue;
    if (provider && def.provider !== provider) continue;
    if (gateway && def.gateway !== gateway) continue;
    if (visibility && def.visibility !== visibility) continue;
    if (recommended != null && def.recommended !== recommended) continue;
    if (capability && !def.capabilities?.[capability]) continue;
    out.push(def);
  }
  return out;
}

export function listRecommendedModels() {
  return listModels({ recommended: true });
}

export function listCuratedModels() {
  return listModels({ visibility: MODEL_VISIBILITY.PRIMARY });
}

/** Capability check that fails closed for unknown models. */
export function modelSupports(modelId, capability) {
  const def = getModel(modelId);
  return Boolean(def?.capabilities?.[capability]);
}

/** Price estimate metadata (USD per 1K tokens) or null. Estimates only. */
export function modelPricing(modelId) {
  return getModel(modelId)?.pricing || null;
}

/**
 * Where a model call should go.
 * @returns {{gateway:string, provider:string, upstreamId:string}|null}
 */
export function resolveUpstream(modelId) {
  const def = getModel(modelId);
  if (!def) return null;
  if (def.gateway === GATEWAYS.OPENROUTER) {
    return { gateway: GATEWAYS.OPENROUTER, provider: def.provider, upstreamId: def.openRouterId || def.upstreamId };
  }
  return { gateway: def.gateway, provider: def.provider, upstreamId: def.upstreamId };
}

function sanitizeSyncedDefinition(def) {
  if (!def || typeof def !== 'object') return null;
  const id = String(def.id || '').trim();
  if (!id) return null;
  return {
    id,
    upstreamId: String(def.upstreamId || id),
    openRouterId: def.openRouterId ? String(def.openRouterId) : id,
    provider: String(def.provider || 'openrouter'),
    gateway: GATEWAYS.OPENROUTER,
    label: String(def.label || id),
    family: String(def.family || 'other'),
    capabilities: {
      tools: Boolean(def.capabilities?.tools),
      vision: Boolean(def.capabilities?.vision),
      reasoning: Boolean(def.capabilities?.reasoning),
      structuredOutput: Boolean(def.capabilities?.structuredOutput),
    },
    contextWindow: Number(def.contextWindow) || 0,
    modalities: {
      input: Array.isArray(def.modalities?.input) ? def.modalities.input : ['text'],
      output: Array.isArray(def.modalities?.output) ? def.modalities.output : ['text'],
    },
    pricing: def.pricing && Number.isFinite(Number(def.pricing.input))
      ? {
          input: Number(def.pricing.input),
          output: Number(def.pricing.output) || 0,
          ...(Number.isFinite(Number(def.pricing.cachedInput))
            ? { cachedInput: Number(def.pricing.cachedInput) }
            : {}),
        }
      : null,
    enabled: def.enabled !== false,
    // A synced catalog can never mark itself recommended or curated.
    recommended: false,
    visibility: MODEL_VISIBILITY.CATALOG,
    deprecated: Boolean(def.deprecated),
  };
}

/**
 * Merge a gateway catalog sync (OpenRouter). Replaces the previous sync set.
 * Curated ids always win: a synced entry with a curated id is ignored so the
 * upstream catalog cannot redefine curated capabilities/pricing/visibility.
 *
 * @param {ModelDefinition[]} defs
 * @returns {{added:number, skippedCurated:number, invalid:number}}
 */
export function replaceSyncedCatalog(defs) {
  synced.clear();
  let added = 0;
  let skippedCurated = 0;
  let invalid = 0;
  for (const raw of Array.isArray(defs) ? defs : []) {
    const def = sanitizeSyncedDefinition(raw);
    if (!def) {
      invalid += 1;
      continue;
    }
    if (curated.has(def.id)) {
      skippedCurated += 1;
      continue;
    }
    synced.set(def.id, def);
    added += 1;
  }
  return { added, skippedCurated, invalid };
}

export function syncedCatalogSize() {
  return synced.size;
}

/** Mark a curated model deprecated (e.g. provider retired the id). */
export function deprecateModel(modelId) {
  const def = curated.get(String(modelId || '').trim());
  if (!def) return false;
  def.deprecated = true;
  return true;
}

/**
 * Graceful handling for stored references to models that no longer resolve:
 * returns the model if selectable, otherwise a recommended same-provider
 * replacement, otherwise null (caller falls back to LYKN routing).
 */
export function resolveStoredModelId(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  if (isSelectableModelId(id)) return id;
  const def = getModel(id);
  if (def) {
    const replacement = listModels({ provider: def.provider, recommended: true })[0]
      || listModels({ provider: def.provider })[0];
    if (replacement) return replacement.id;
  }
  return null;
}
