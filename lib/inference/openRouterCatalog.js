/**
 * OpenRouter catalog sync.
 *
 * Pulls the broad model list and maps it into LYKN ModelDefinitions.
 * Synced rows are visibility=catalog and never recommended.
 * Curated LYKN models stay owned by catalogSeed.js.
 */

import { replaceSyncedCatalog } from '../models/registry.js';
import { OPENROUTER_BASE_URL, openRouterAuthHeaders } from './openRouterGateway.js';

const SYNC_TTL_MS = 6 * 60 * 60 * 1000;
let lastSyncAt = 0;
let lastResult = { added: 0, skippedCurated: 0, invalid: 0 };

export function mapOpenRouterModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id || !id.includes('/')) return null;
  const [vendor, ...rest] = id.split('/');
  const slug = rest.join('/');
  const pricing = normalizeOpenRouterPricing(raw.pricing);
  const arch = raw.architecture || {};
  const inputMods = Array.isArray(arch.input_modalities) ? arch.input_modalities : ['text'];
  const outputMods = Array.isArray(arch.output_modalities) ? arch.output_modalities : ['text'];
  return {
    id,
    upstreamId: id,
    openRouterId: id,
    provider: String(vendor || 'openrouter'),
    label: String(raw.name || slug || id),
    family: String(vendor || 'other'),
    capabilities: {
      tools: Boolean(raw.supported_parameters?.includes?.('tools') || raw.supported_parameters?.includes?.('tool_choice')),
      vision: inputMods.includes('image'),
      reasoning: Boolean(raw.supported_parameters?.includes?.('reasoning') || /reason|r1|thinking/i.test(id)),
      structuredOutput: Boolean(
        raw.supported_parameters?.includes?.('response_format')
        || raw.supported_parameters?.includes?.('structured_outputs'),
      ),
    },
    contextWindow: Number(raw.context_length) || 0,
    modalities: { input: inputMods, output: outputMods },
    pricing,
    enabled: true,
    deprecated: false,
  };
}

function normalizeOpenRouterPricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  const inputPerToken = Number(pricing.prompt);
  const outputPerToken = Number(pricing.completion);
  if (!Number.isFinite(inputPerToken) || !Number.isFinite(outputPerToken)) return null;
  // OpenRouter prices are USD per token. LYKN tables are USD per 1K tokens.
  return {
    input: inputPerToken * 1000,
    output: outputPerToken * 1000,
  };
}

export async function syncOpenRouterCatalog({ fetchImpl = fetch, env = process.env, force = false } = {}) {
  const headers = openRouterAuthHeaders(env);
  if (!headers) return { ok: false, reason: 'not_configured', ...lastResult };
  if (!force && lastSyncAt && Date.now() - lastSyncAt < SYNC_TTL_MS) {
    return { ok: true, cached: true, ...lastResult };
  }
  const res = await fetchImpl(`${OPENROUTER_BASE_URL}/models`, { headers });
  if (!res.ok) {
    return { ok: false, reason: 'upstream', status: res.status, ...lastResult };
  }
  const body = await res.json().catch(() => ({}));
  const rows = Array.isArray(body?.data) ? body.data : [];
  const defs = rows.map(mapOpenRouterModel).filter(Boolean);
  lastResult = replaceSyncedCatalog(defs);
  lastSyncAt = Date.now();
  return { ok: true, cached: false, fetched: rows.length, ...lastResult };
}

export function lastCatalogSync() {
  return { lastSyncAt, ...lastResult };
}
