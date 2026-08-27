/**
 * Official MCP Registry adapter.
 *
 * Preview API at registry.modelcontextprotocol.io. One discovery source,
 * never architectural authority. Listings are metadata only.
 */

import { assertMcpUrlSafe } from '../urlPolicy.js';
import { MCP_TRUST_LEVELS } from '../protocol.js';
import { CATALOG_CONNECTION_TYPES, CATALOG_SOURCES, OFFICIAL_REGISTRY_SERVERS } from './types.js';
import { normalizeCatalogEntry } from './sanitize.js';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_REMOTE_RESULTS = 40;

function inferCategories(name, description) {
  const blob = `${name} ${description}`.toLowerCase();
  if (/\b(gmail|email|mail|slack|discord|teams)\b/.test(blob)) return ['communication'];
  if (/\b(drive|notion|docs|document|file)\b/.test(blob)) return ['documents'];
  if (/\b(calendar|meeting)\b/.test(blob)) return ['calendar'];
  if (/\b(github|gitlab|git|repo)\b/.test(blob)) return ['development'];
  if (/\b(linear|jira|ticket)\b/.test(blob)) return ['productivity'];
  if (/\b(crm|hubspot|salesforce)\b/.test(blob)) return ['crm'];
  if (/\b(bank|stripe|invoice|finance)\b/.test(blob)) return ['finance'];
  return ['other'];
}

function inferCapabilities(name, description, categories) {
  const blob = `${name} ${description}`.toLowerCase();
  if (categories.includes('communication') || /\b(gmail|email)\b/.test(blob)) {
    return ['communication.email.read', 'communication.email.search'];
  }
  if (categories.includes('documents')) return ['documents.read'];
  if (categories.includes('calendar')) return ['calendar.read'];
  if (categories.includes('development') || /\bgithub\b/.test(blob)) return ['source_control.read'];
  if (categories.includes('crm')) return ['crm.read'];
  return [];
}

function remoteUrlFromServer(server) {
  const remotes = Array.isArray(server?.remotes) ? server.remotes : [];
  const http = remotes.find((item) => {
    const type = String(item?.type || item?.transport || '').toLowerCase();
    return type.includes('http') || type.includes('streamable') || item?.url;
  });
  return http?.url ? String(http.url).trim() : '';
}

function localPackageFromServer(server) {
  const packages = Array.isArray(server?.packages) ? server.packages : [];
  const npm = packages.find((item) => /npm|node/i.test(String(item?.registryType || item?.registry || '')));
  return String(npm?.identifier || npm?.name || '').trim();
}

function isOfficialNamespace(name) {
  return /^io\.modelcontextprotocol\//i.test(String(name || ''));
}

export async function fetchOfficialRegistry({
  search = '',
  limit = 20,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const q = String(search || '').trim().slice(0, 80);
  const url = new URL(OFFICIAL_REGISTRY_SERVERS);
  url.searchParams.set('limit', String(Math.min(MAX_REMOTE_RESULTS, Math.max(1, Number(limit) || 20))));
  url.searchParams.set('version', 'latest');
  if (q) url.searchParams.set('search', q);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let payload;
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false, entries: [], error: `registry_http_${res.status}` };
    payload = await res.json();
  } catch (error) {
    return {
      ok: false,
      entries: [],
      error: error?.name === 'AbortError' ? 'registry_timeout' : 'registry_unavailable',
    };
  } finally {
    clearTimeout(timer);
  }

  const rows = Array.isArray(payload?.servers) ? payload.servers : [];
  const entries = [];
  for (const row of rows) {
    const server = row?.server && typeof row.server === 'object' ? row.server : row;
    const registryName = String(server?.name || '').trim();
    if (!registryName) continue;
    const description = String(server?.description || '');
    const remoteUrl = remoteUrlFromServer(server);
    if (remoteUrl) {
      const urlCheck = await assertMcpUrlSafe(remoteUrl, { trustLevel: MCP_TRUST_LEVELS.CUSTOM });
      if (!urlCheck.ok) continue;
    }
    const categories = inferCategories(registryName, description);
    const entry = normalizeCatalogEntry(
      {
        id: `registry:${registryName}`,
        name: registryName.split('/').pop() || registryName,
        description,
        categories,
        connectionType: remoteUrl
          ? CATALOG_CONNECTION_TYPES.REMOTE
          : localPackageFromServer(server)
            ? CATALOG_CONNECTION_TYPES.STDIO
            : CATALOG_CONNECTION_TYPES.REMOTE,
        remoteUrlTemplate: remoteUrl || null,
        localPackage: localPackageFromServer(server) || null,
        capabilities: inferCapabilities(registryName, description, categories),
        popularity: 10,
      },
      {
        source: {
          kind: CATALOG_SOURCES.OFFICIAL_REGISTRY,
          registryName,
        },
      },
    );
    if (entry) entries.push(entry);
    if (isOfficialNamespace(registryName) && entry.trust !== MCP_TRUST_LEVELS.OFFICIAL) {
      /* source policy already promotes official namespace */
    }
  }
  return { ok: true, entries, nextCursor: payload?.metadata?.nextCursor || null };
}
