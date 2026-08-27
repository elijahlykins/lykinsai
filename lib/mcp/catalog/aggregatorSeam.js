/**
 * Aggregator seam. Composio / Pipedream / others are optional MCP sources,
 * never architectural authority. No vendor SDK is imported here.
 */

import { CATALOG_CONNECTION_TYPES, CATALOG_SOURCES } from './types.js';
import { normalizeCatalogEntry } from './sanitize.js';

export function catalogEntryFromAggregator({
  serviceName,
  description,
  aggregator,
  remoteUrl,
  categories,
  capabilities,
  authExpectation = 'oauth',
} = {}) {
  const provider = String(aggregator || '').trim().toLowerCase();
  if (!provider) return null;
  return normalizeCatalogEntry(
    {
      id: `aggregator:${provider}:${String(serviceName || '').toLowerCase().replace(/\s+/g, '-')}`,
      name: String(serviceName || '').trim(),
      description,
      categories,
      connectionType: CATALOG_CONNECTION_TYPES.AGGREGATOR,
      remoteUrlTemplate: remoteUrl || null,
      authExpectation,
      providedThrough: provider,
      capabilities,
    },
    { source: { kind: CATALOG_SOURCES.AGGREGATOR, provider } },
  );
}

export function displayNameForConnection({ name, providedThrough } = {}) {
  const label = String(name || '').trim() || 'MCP';
  if (providedThrough) return { name: label, providedThrough: String(providedThrough) };
  return { name: label, providedThrough: null };
}
