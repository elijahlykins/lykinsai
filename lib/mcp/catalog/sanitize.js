/**
 * Catalog text is untrusted metadata. Trust labels come from LYKN source
 * policy, never from a server or listing claiming to be official.
 */

import { MCP_TRUST_LEVELS } from '../protocol.js';
import { sanitizeToolDescription } from '../trust.js';
import { CATALOG_CATEGORIES, CATALOG_CONNECTION_TYPES, CATALOG_SOURCES } from './types.js';

const ALLOWED_TRUST = new Set(Object.values(MCP_TRUST_LEVELS));
const ALLOWED_SOURCES = new Set(Object.values(CATALOG_SOURCES));
const ALLOWED_TYPES = new Set(Object.values(CATALOG_CONNECTION_TYPES));

function cleanId(raw) {
  const text = String(raw || '').trim().slice(0, 160);
  if (!/^[a-zA-Z0-9_.:/@-]+$/.test(text)) return '';
  return text;
}

function cleanCategories(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    const cat = String(item || '').trim().toLowerCase();
    if (CATALOG_CATEGORIES.includes(cat) && !out.includes(cat)) out.push(cat);
  }
  return out.length ? out : ['other'];
}

export function sanitizeCatalogDescription(raw) {
  return sanitizeToolDescription(raw).text;
}

export function trustFromSourcePolicy(source, { claimedTrust, officialNamespace = false } = {}) {
  const sourceKind = source?.kind || CATALOG_SOURCES.CUSTOM;
  if (sourceKind === CATALOG_SOURCES.LYKN_CURATED) {
    if (claimedTrust === MCP_TRUST_LEVELS.OFFICIAL || claimedTrust === MCP_TRUST_LEVELS.VERIFIED) {
      return claimedTrust;
    }
    return MCP_TRUST_LEVELS.VERIFIED;
  }
  if (sourceKind === CATALOG_SOURCES.OFFICIAL_REGISTRY) {
    if (officialNamespace) return MCP_TRUST_LEVELS.OFFICIAL;
    return MCP_TRUST_LEVELS.COMMUNITY;
  }
  if (sourceKind === CATALOG_SOURCES.AGGREGATOR) return MCP_TRUST_LEVELS.COMMUNITY;
  return MCP_TRUST_LEVELS.CUSTOM;
}

export function normalizeCatalogEntry(raw, { source } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanId(raw.id);
  const name = String(raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!id || !name) return null;

  const sourceKind = source?.kind || raw.source?.kind || CATALOG_SOURCES.CUSTOM;
  if (!ALLOWED_SOURCES.has(sourceKind)) return null;
  const resolvedSource = {
    kind: sourceKind,
    provider: String(source?.provider || raw.source?.provider || '').trim().slice(0, 40) || undefined,
    registryName: String(source?.registryName || raw.source?.registryName || '').trim().slice(0, 160) || undefined,
  };

  const officialNamespace = /^io\.modelcontextprotocol\//i.test(
    String(resolvedSource.registryName || raw.registryName || id),
  );
  const trust = trustFromSourcePolicy(resolvedSource, {
    claimedTrust: ALLOWED_TRUST.has(raw.trust) ? raw.trust : null,
    officialNamespace,
  });

  const connectionType = ALLOWED_TYPES.has(raw.connectionType)
    ? raw.connectionType
    : CATALOG_CONNECTION_TYPES.REMOTE;

  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean).slice(0, 16)
    : [];

  return Object.freeze({
    id,
    name,
    description: sanitizeCatalogDescription(raw.description || ''),
    icon: String(raw.icon || '').trim().slice(0, 80) || null,
    categories: cleanCategories(raw.categories),
    connectionType,
    remoteUrlTemplate: raw.remoteUrlTemplate ? String(raw.remoteUrlTemplate).trim().slice(0, 2000) : null,
    localPackage: raw.localPackage ? String(raw.localPackage).trim().slice(0, 160) : null,
    authExpectation: raw.authExpectation === 'oauth' || raw.authExpectation === 'bearer' ? raw.authExpectation : 'none',
    trust,
    source: Object.freeze(resolvedSource),
    providedThrough: raw.providedThrough ? String(raw.providedThrough).trim().slice(0, 40) : null,
    capabilities,
    popularity: Number.isFinite(Number(raw.popularity)) ? Number(raw.popularity) : 0,
  });
}
