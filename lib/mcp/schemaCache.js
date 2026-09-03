/**
 * Discovered MCP metadata cache.
 * Invalidated on reconnect, server version change, explicit refresh,
 * or schema mismatch. Not queried on every model turn.
 */

import { createHash } from 'node:crypto';
import { MCP_BOUNDS } from './bounds.js';
import { selectToolsForCache } from './toolCacheSelect.js';

function hashSchema(value) {
  return createHash('sha256').update(JSON.stringify(value || null)).digest('hex').slice(0, 24);
}

export function createSchemaCache() {
  const byConnection = new Map();

  function get(connectionId) {
    return byConnection.get(String(connectionId || '')) || null;
  }

  function put(connectionId, entry) {
    const id = String(connectionId || '');
    if (!id) return null;
    const tools = selectToolsForCache(entry.tools, MCP_BOUNDS.MAX_TOOLS_CACHED);
    const record = {
      connectionId: id,
      serverName: String(entry.serverName || ''),
      serverVersion: String(entry.serverVersion || ''),
      protocolVersion: String(entry.protocolVersion || ''),
      capabilities: entry.capabilities || {},
      tools,
      resources: Array.isArray(entry.resources) ? entry.resources : [],
      prompts: Array.isArray(entry.prompts) ? entry.prompts : [],
      schemaHash: hashSchema({ tools, version: entry.serverVersion }),
      cachedAt: entry.cachedAt || new Date().toISOString(),
    };
    byConnection.set(id, record);
    return record;
  }

  function invalidate(connectionId) {
    byConnection.delete(String(connectionId || ''));
  }

  function isCurrent(connectionId, { serverVersion, schemaHash } = {}) {
    const hit = get(connectionId);
    if (!hit) return false;
    if (serverVersion && hit.serverVersion && hit.serverVersion !== String(serverVersion)) return false;
    if (schemaHash && hit.schemaHash !== String(schemaHash)) return false;
    return true;
  }

  function clear() {
    byConnection.clear();
  }

  return { get, put, invalidate, isCurrent, clear, hashSchema };
}
