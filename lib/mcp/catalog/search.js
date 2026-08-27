import { curatedCatalogEntries } from './curated.js';
import { fetchOfficialRegistry } from './officialRegistry.js';
import { CATALOG_CATEGORIES } from './types.js';
import { MCP_TRUST_LEVELS } from '../protocol.js';

const TRUST_RANK = {
  [MCP_TRUST_LEVELS.OFFICIAL]: 5,
  [MCP_TRUST_LEVELS.VERIFIED]: 4,
  [MCP_TRUST_LEVELS.ENTERPRISE]: 3,
  [MCP_TRUST_LEVELS.COMMUNITY]: 1,
  [MCP_TRUST_LEVELS.LOCAL_TRUSTED]: 1,
  [MCP_TRUST_LEVELS.CUSTOM]: 0,
  [MCP_TRUST_LEVELS.REMOTE]: 0,
};

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1);
}

function scoreEntry(entry, query, category) {
  const q = String(query || '').trim().toLowerCase();
  let score = TRUST_RANK[entry.trust] || 0;
  score += Number(entry.popularity || 0) / 50;
  if (category && entry.categories?.includes(category)) score += 2;
  if (!q) return score + 1;
  const name = String(entry.name || '').toLowerCase();
  const desc = String(entry.description || '').toLowerCase();
  const caps = (entry.capabilities || []).join(' ');
  if (name === q) score += 20;
  if (name.includes(q)) score += 12;
  if (desc.includes(q)) score += 4;
  if (caps.includes(q)) score += 6;
  const qTokens = tokens(q);
  const hay = tokens(`${name} ${desc} ${caps} ${(entry.categories || []).join(' ')}`);
  for (const token of qTokens) {
    if (hay.includes(token)) score += 2;
  }
  return score;
}

function dedupe(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const urlKey = entry.remoteUrlTemplate ? `url:${entry.remoteUrlTemplate}` : '';
    const key = urlKey || `id:${entry.id}`;
    const prev = byKey.get(key);
    if (!prev || (TRUST_RANK[entry.trust] || 0) > (TRUST_RANK[prev.trust] || 0)) {
      byKey.set(key, entry);
    }
  }
  const byName = new Map();
  for (const entry of byKey.values()) {
    const nameKey = String(entry.name || '').toLowerCase();
    const prev = byName.get(nameKey);
    if (!prev) {
      byName.set(nameKey, entry);
      continue;
    }
    const prevRank = TRUST_RANK[prev.trust] || 0;
    const nextRank = TRUST_RANK[entry.trust] || 0;
    if (nextRank > prevRank) byName.set(nameKey, entry);
    else if (nextRank === prevRank && (entry.popularity || 0) > (prev.popularity || 0)) {
      byName.set(nameKey, entry);
    }
  }
  return [...byName.values()];
}

export async function searchMcpCatalog({
  query = '',
  category,
  includeRegistry = true,
  curated = curatedCatalogEntries(),
  fetchImpl,
  limit = 24,
} = {}) {
  const cat = CATALOG_CATEGORIES.includes(category) ? category : null;
  let registryEntries = [];
  let registryError = null;
  if (includeRegistry && String(query || '').trim()) {
    const remote = await fetchOfficialRegistry({
      search: query,
      limit: Math.min(20, limit),
      fetchImpl,
    });
    if (remote.ok) registryEntries = remote.entries;
    else registryError = remote.error;
  }
  const merged = dedupe([...(curated || []), ...registryEntries]);
  const ranked = merged
    .map((entry) => ({ entry, score: scoreEntry(entry, query, cat) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.entry.name).localeCompare(b.entry.name))
    .slice(0, Math.max(1, limit))
    .map((item) => item.entry);
  return {
    ok: true,
    query: String(query || ''),
    category: cat,
    entries: ranked,
    registryError,
    sources: {
      curated: (curated || []).length,
      officialRegistry: registryEntries.length,
    },
  };
}
