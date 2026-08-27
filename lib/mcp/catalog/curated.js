import { MCP_TRUST_LEVELS } from '../protocol.js';
import { CATALOG_CONNECTION_TYPES, CATALOG_SOURCES } from './types.js';
import { normalizeCatalogEntry } from './sanitize.js';

const CURATED = [
  {
    id: 'lykn:gmail',
    name: 'Gmail',
    description: 'Search, read, and draft email through a connected MCP server.',
    categories: ['communication'],
    connectionType: CATALOG_CONNECTION_TYPES.REMOTE,
    authExpectation: 'oauth',
    trust: MCP_TRUST_LEVELS.VERIFIED,
    capabilities: ['communication.email.read', 'communication.email.search', 'communication.email.send'],
    popularity: 100,
  },
  {
    id: 'lykn:google-workspace',
    name: 'Google Workspace',
    description: 'Gmail, Drive, and Calendar through a connected MCP server.',
    categories: ['communication', 'documents', 'calendar'],
    connectionType: CATALOG_CONNECTION_TYPES.REMOTE,
    authExpectation: 'oauth',
    trust: MCP_TRUST_LEVELS.VERIFIED,
    capabilities: ['communication.email.read', 'documents.read', 'calendar.read'],
    popularity: 95,
  },
  {
    id: 'lykn:google-drive',
    name: 'Google Drive',
    description: 'Search and read files from Drive through a connected MCP server.',
    categories: ['documents'],
    connectionType: CATALOG_CONNECTION_TYPES.REMOTE,
    authExpectation: 'oauth',
    trust: MCP_TRUST_LEVELS.VERIFIED,
    capabilities: ['documents.read', 'documents.search', 'documents.create'],
    popularity: 90,
  },
  {
    id: 'lykn:slack',
    name: 'Slack',
    description: 'Search and read Slack messages through a connected MCP server.',
    categories: ['communication'],
    connectionType: CATALOG_CONNECTION_TYPES.REMOTE,
    authExpectation: 'oauth',
    trust: MCP_TRUST_LEVELS.VERIFIED,
    capabilities: ['communication.message.read', 'communication.message.search'],
    popularity: 85,
  },
  {
    id: 'lykn:notion',
    name: 'Notion',
    description: 'Read Notion pages and databases through a connected MCP server.',
    categories: ['documents', 'productivity'],
    connectionType: CATALOG_CONNECTION_TYPES.REMOTE,
    authExpectation: 'oauth',
    trust: MCP_TRUST_LEVELS.VERIFIED,
    capabilities: ['documents.read', 'documents.write'],
    popularity: 80,
  },
  {
    id: 'lykn:github',
    name: 'GitHub',
    description: 'Repositories, issues, and pull requests through a connected MCP server.',
    categories: ['development'],
    connectionType: CATALOG_CONNECTION_TYPES.REMOTE,
    authExpectation: 'oauth',
    trust: MCP_TRUST_LEVELS.VERIFIED,
    capabilities: ['source_control.read'],
    popularity: 88,
  },
  {
    id: 'lykn:linear',
    name: 'Linear',
    description: 'Issues and projects through a connected MCP server.',
    categories: ['productivity', 'development'],
    connectionType: CATALOG_CONNECTION_TYPES.REMOTE,
    authExpectation: 'oauth',
    trust: MCP_TRUST_LEVELS.VERIFIED,
    capabilities: ['projects.read'],
    popularity: 70,
  },
  {
    id: 'lykn:granola',
    name: 'Granola',
    description: 'Meeting notes through a connected MCP server.',
    categories: ['productivity'],
    connectionType: CATALOG_CONNECTION_TYPES.REMOTE,
    authExpectation: 'oauth',
    trust: MCP_TRUST_LEVELS.VERIFIED,
    capabilities: ['documents.read'],
    popularity: 55,
  },
];

export function curatedCatalogEntries() {
  return CURATED.map((entry) =>
    normalizeCatalogEntry(entry, { source: { kind: CATALOG_SOURCES.LYKN_CURATED } }),
  ).filter(Boolean);
}

export function suggestCatalogForCapabilities(needs, entries = curatedCatalogEntries()) {
  const want = Array.isArray(needs) ? needs.map((item) => String(item || '').toLowerCase()) : [];
  if (!want.length) return [];
  return entries
    .map((entry) => {
      let score = 0;
      for (const cap of entry.capabilities || []) {
        for (const need of want) {
          if (cap === need) score += 8;
          else if (cap.split('.')[0] === need.split('.')[0]) score += 2;
        }
      }
      const blob = `${entry.name} ${entry.description}`.toLowerCase();
      if (want.some((need) => need.includes('email') && /gmail|email|mail/.test(blob))) score += 4;
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.popularity - a.entry.popularity)
    .map((item) => item.entry);
}
