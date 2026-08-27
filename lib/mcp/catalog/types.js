/**
 * Marketplace catalog types.
 *
 * Catalog entries are untrusted discovery metadata. They never become
 * model system instructions, Task capabilities, or execution authority.
 * Execution always goes through Universal MCP after a real connection.
 */

export const CATALOG_SOURCES = Object.freeze({
  LYKN_CURATED: 'lykn_curated',
  OFFICIAL_REGISTRY: 'official_registry',
  AGGREGATOR: 'aggregator',
  CUSTOM: 'custom',
});

export const CATALOG_CONNECTION_TYPES = Object.freeze({
  REMOTE: 'remote',
  STDIO: 'stdio',
  AGGREGATOR: 'aggregator',
});

export const CATALOG_CATEGORIES = Object.freeze([
  'communication',
  'documents',
  'productivity',
  'development',
  'crm',
  'calendar',
  'finance',
  'other',
]);

export const CATALOG_AUTH_EXPECTATIONS = Object.freeze({
  NONE: 'none',
  OAUTH: 'oauth',
  BEARER: 'bearer',
});

export const OFFICIAL_REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
export const OFFICIAL_REGISTRY_SERVERS = `${OFFICIAL_REGISTRY_BASE}/v0.1/servers`;
