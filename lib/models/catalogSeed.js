/**
 * Curated seed for the LYKN model registry.
 *
 * Built from the canonical picker catalog (src/lib/modelCatalog.js) plus
 * capability and context metadata that previously lived implicitly in
 * scattered sets (WEAK_VISION_MODELS, supportsTools, reasoning payload
 * gates). The seed is the AVAILABLE + RECOMMENDED curated set; the broader
 * OpenRouter catalog merges in at runtime with visibility 'catalog' and can
 * never promote itself into the curated picker.
 */

import {
  MODEL_GROUPS,
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
} from '../../src/lib/modelCatalog.js';
import { findModelPricing } from './pricingTable.js';

export const GATEWAYS = Object.freeze({
  DIRECT: 'direct',
  OPENROUTER: 'openrouter',
  LOCAL: 'local',
});

export const MODEL_VISIBILITY = Object.freeze({
  /** Curated primary picker. */
  PRIMARY: 'primary',
  /** "More models" explorer, still curated by LYKN. */
  EXTENDED: 'extended',
  /** Broad gateway catalog (OpenRouter sync). Explorer-only. */
  CATALOG: 'catalog',
});

/** Upstream lab for a model id. Mirrors providerForModel prefix rules. */
export function providerForCatalogId(id) {
  const m = String(id || '').toLowerCase();
  if (m.startsWith('gpt-') || m === 'o3' || m === 'o3-pro' || m === 'o4-mini') return 'openai';
  if (m.includes('claude')) return 'anthropic';
  if (m.startsWith('gemini')) return 'google';
  if (m.includes('grok')) return 'xai';
  return null;
}

/** OpenRouter vendor slug per lab (OpenRouter ids are `vendor/model`). */
const OPENROUTER_VENDOR = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'x-ai',
});

/**
 * OpenRouter slugs that are not `vendor/${lyknId}`.
 * Dated Claude ids use a dot (`claude-haiku-4.5`); Google `*-latest`
 * aliases are not listed without a `~` prefix, so pin them to current models.
 */
const OPENROUTER_UPSTREAM_ALIASES = Object.freeze({
  'gemini-pro-latest': 'gemini-3.1-pro-preview',
  'gemini-flash-latest': 'gemini-3.6-flash',
});

function toOpenRouterSlug(provider, upstreamId) {
  let id = OPENROUTER_UPSTREAM_ALIASES[upstreamId] || String(upstreamId || '');
  if (provider === 'anthropic') {
    // claude-opus-4-8 → claude-opus-4.8. Unversioned ids (claude-opus-5) stay.
    id = id.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)$/, '$1.$2');
  }
  return id;
}

export function openRouterIdFor(provider, upstreamId) {
  const vendor = OPENROUTER_VENDOR[provider];
  if (!vendor) return null;
  const slug = toOpenRouterSlug(provider, upstreamId);
  return slug ? `${vendor}/${slug}` : null;
}

// O-series reasoning models run through the Responses API without vision in
// our stack (see OPENAI_RESPONSES_ONLY in server/ai/modelInvoke.js).
const NO_VISION = new Set(['o3', 'o3-pro', 'o4-mini']);

function supportsReasoning(id) {
  const m = String(id);
  if (/^gpt-5/.test(m)) return true;
  if (m === 'o3' || m === 'o3-pro' || m === 'o4-mini') return true;
  if (/claude-(fable|opus|sonnet)/.test(m)) return true;
  if (/^gemini-3/.test(m) || m === 'gemini-pro-latest') return true;
  if (m === 'grok-4.6' || m === 'grok-4.5') return true;
  return false;
}

function contextWindowFor(id) {
  const m = String(id);
  if (/^gpt-5\.6/.test(m)) return 400_000;
  if (/^gpt-5/.test(m)) return 272_000;
  if (/^gpt-4\.1/.test(m)) return 1_000_000;
  if (/^gpt-4o/.test(m)) return 128_000;
  if (m === 'o3' || m === 'o3-pro' || m === 'o4-mini') return 200_000;
  if (m === 'claude-fable-5') return 1_000_000;
  if (m.startsWith('claude')) return 200_000;
  if (m.startsWith('gemini')) return 1_000_000;
  if (m.startsWith('grok')) return 256_000;
  return 128_000;
}

function familyFor(id, provider) {
  const m = String(id);
  if (provider === 'openai') return m.startsWith('o') ? 'o-series' : 'gpt';
  if (provider === 'anthropic') return 'claude';
  if (provider === 'google') return 'gemini';
  if (provider === 'xai') return 'grok';
  return 'other';
}

// Frontier four plus one fast + one everyday pick per lab. This is what
// "Recommended" means in the explorer and the primary picker ordering.
const RECOMMENDED_IDS = new Set([
  FRONTIER_OPENAI_ID,
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_XAI_ID,
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'gemini-3.6-flash',
  'grok-4.5',
]);

/**
 * @typedef {object} ModelDefinition
 * @property {string} id            Canonical LYKN model id (client-facing).
 * @property {string} upstreamId    Model id at the upstream provider.
 * @property {string|null} openRouterId  OpenRouter `vendor/model` id when servable there.
 * @property {'openai'|'anthropic'|'google'|'xai'|string} provider Upstream lab.
 * @property {'direct'|'openrouter'|'local'} gateway  Default serving gateway.
 * @property {string} label         Display name.
 * @property {string} family        Product family for grouping/filtering.
 * @property {{tools:boolean, vision:boolean, reasoning:boolean, structuredOutput:boolean}} capabilities
 * @property {number} contextWindow Approximate token context window.
 * @property {{input:string[], output:string[]}} modalities
 * @property {{input:number, output:number, cachedInput?:number}|null} pricing USD per 1K tokens (estimate).
 * @property {boolean} enabled
 * @property {boolean} recommended
 * @property {'primary'|'extended'|'catalog'} visibility
 * @property {boolean} deprecated
 */

/** @returns {ModelDefinition[]} */
export function buildCuratedSeed() {
  const defs = [];
  const seen = new Set();
  for (const group of MODEL_GROUPS) {
    for (const item of group.items) {
      const id = item.value;
      if (id === 'lykn' || id === 'lykn-setup' || seen.has(id)) continue;
      seen.add(id);
      const provider = providerForCatalogId(id);
      if (!provider) continue;
      const vision = !NO_VISION.has(id);
      defs.push({
        id,
        upstreamId: id,
        openRouterId: openRouterIdFor(provider, id),
        provider,
        gateway: GATEWAYS.DIRECT,
        label: item.label,
        family: familyFor(id, provider),
        capabilities: {
          tools: true,
          vision,
          reasoning: supportsReasoning(id),
          structuredOutput: true,
        },
        contextWindow: contextWindowFor(id),
        modalities: {
          input: vision ? ['text', 'image'] : ['text'],
          output: ['text'],
        },
        pricing: findModelPricing(id),
        enabled: true,
        recommended: RECOMMENDED_IDS.has(id),
        visibility: MODEL_VISIBILITY.PRIMARY,
        deprecated: false,
      });
    }
  }
  return defs;
}
