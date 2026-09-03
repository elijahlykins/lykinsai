/**
 * Managed tool bridge — connects the LYKN Connection Service to the
 * Universal MCP stack.
 *
 * When a user connects an app through the Connection Service (Composio
 * managed OAuth), this bridge materializes one `lykn_mcp_connections` row
 * per connected app, marked providedThrough='composio'. From there every
 * existing MCP consumer — chat turn disclosure, /api/mcp for bots, voice —
 * sees the app's tools with the standard approval, classification, and
 * trust gates. There is deliberately no second execution lane.
 *
 * The row's serverUrl is a stable placeholder (RFC 2606 .invalid) used only
 * for identity/display. The real session MCP endpoint and its auth headers
 * are capability credentials minted live by the Composio gateway inside the
 * MCP connection manager (resolveManagedEndpoint); they are never persisted
 * and never logged.
 */

import { MANAGED_TOOL_PROVIDER, MCP_TRUST_LEVELS, MCP_STATUSES } from '../mcp/protocol.js';

export function managedToolCatalogId(toolkit) {
  return `composio:${String(toolkit || '').trim().toLowerCase()}`;
}

export function managedToolServerUrl(toolkit) {
  // Never dialed: the manager resolves the live endpoint for managed rows.
  return `https://managed-tools.lykn.invalid/${String(toolkit || '').trim().toLowerCase()}`;
}

/**
 * @param {object} deps
 * @param {object} deps.manager McpConnectionManager
 * @param {object} [deps.logger]
 */
export function createManagedToolBridge({ manager, logger = console }) {
  // Managed-row mutations are serialized per user+toolkit. The connect
  // callback and the Settings-page reconcile both ensure rows fire-and-
  // forget; unserialized they raced findRow (both saw no row, both created
  // one) and left duplicate app rows that disclosed every tool twice.
  const chains = new Map();
  function serialize(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => {});
    chains.set(key, settled);
    settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return run;
  }

  /** Healthiest row first: connected beats not, newest breaks ties. */
  function bestRowFirst(a, b) {
    const aConn = a.status === MCP_STATUSES.CONNECTED ? 1 : 0;
    const bConn = b.status === MCP_STATUSES.CONNECTED ? 1 : 0;
    if (aConn !== bConn) return bConn - aConn;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  }

  async function findRow(userId, toolkit) {
    const rows = await manager.store.list(userId);
    const catalogId = managedToolCatalogId(toolkit);
    const matches = rows
      .filter((r) => r.providedThrough === MANAGED_TOOL_PROVIDER && r.catalogId === catalogId)
      .sort(bestRowFirst);
    return matches[0] || null;
  }

  /**
   * Make the app's tools available: create the managed MCP row if missing,
   * or re-discover if it exists (refresh=true forces re-discovery, used
   * right after a connect/reconnect completes so tools reflect the new
   * grant).
   */
  function ensureToolConnection(userId, provider, opts = {}) {
    const toolkit = provider.toolkit || provider.id;
    return serialize(`${userId}::${toolkit}`, () =>
      ensureToolConnectionUnsafe(userId, provider, opts),
    );
  }

  async function ensureToolConnectionUnsafe(userId, provider, { refresh = false } = {}) {
    const toolkit = provider.toolkit || provider.id;
    const existing = await findRow(userId, toolkit);
    if (existing && !refresh && existing.status === MCP_STATUSES.CONNECTED) {
      return { ok: true, connectionId: existing.id, created: false };
    }
    if (existing) {
      const result = await manager.reconnect(userId, existing.id);
      return { ok: result.ok, connectionId: existing.id, created: false, error: result.error };
    }
    const result = await manager.connect(userId, {
      name: provider.label || toolkit,
      serverUrl: managedToolServerUrl(toolkit),
      trustLevel: MCP_TRUST_LEVELS.OFFICIAL,
      providedThrough: MANAGED_TOOL_PROVIDER,
      catalogId: managedToolCatalogId(toolkit),
      catalogSource: { kind: 'managed', toolkit },
      accountLabel: provider.label || toolkit,
    });
    return {
      ok: result.ok,
      connectionId: result.connection?.id || null,
      created: true,
      error: result.error,
    };
  }

  /** Remove the app's tool access after a Connection Service disconnect. */
  function removeToolConnection(userId, provider) {
    const toolkit = provider.toolkit || provider.id;
    return serialize(`${userId}::${toolkit}`, async () => {
      // Remove ALL rows for the toolkit — historical races may have left more
      // than one, and a disconnect must not leave a live tool lane behind.
      const rows = await manager.store.list(userId);
      const catalogId = managedToolCatalogId(toolkit);
      const matches = rows.filter(
        (r) => r.providedThrough === MANAGED_TOOL_PROVIDER && r.catalogId === catalogId,
      );
      for (const row of matches) {
        await manager.remove(userId, row.id);
      }
      return { ok: true, removed: matches.length > 0 };
    });
  }

  /**
   * Align managed MCP rows with the authoritative connected-toolkit set:
   * create rows for connected apps that lack one (e.g. connected before
   * this bridge existed), remove rows whose app is no longer connected.
   * Existing healthy rows are left alone.
   */
  async function reconcileToolConnections(userId, connectedToolkits) {
    const wanted = new Map();
    for (const item of connectedToolkits || []) {
      const toolkit = String(item.toolkit || item.slug || '').trim().toLowerCase();
      if (toolkit) wanted.set(toolkit, item);
    }
    const rows = await manager.store.list(userId);
    const managedRows = rows.filter((r) => r.providedThrough === MANAGED_TOOL_PROVIDER);
    const results = { created: 0, removed: 0 };

    // Heal duplicates from historical races: one row per app, keeping the
    // healthiest. Duplicate rows disclose every tool twice and can trip the
    // multi-account write gate for what is really a single account.
    const byCatalogId = new Map();
    for (const row of managedRows) {
      const list = byCatalogId.get(row.catalogId) || [];
      list.push(row);
      byCatalogId.set(row.catalogId, list);
    }
    const keptRows = new Map();
    for (const [catalogId, list] of byCatalogId) {
      const sorted = [...list].sort(bestRowFirst);
      keptRows.set(catalogId, sorted[0]);
      for (const extra of sorted.slice(1)) {
        try {
          await manager.remove(userId, extra.id);
          results.removed += 1;
        } catch (e) {
          logger.warn?.(
            `[managed-tools] reconcile dedupe failed user=${userId} connection=${extra.id} error=${e?.code || e?.message || 'unknown'}`,
          );
        }
      }
    }

    for (const [toolkit, item] of wanted) {
      if (keptRows.has(managedToolCatalogId(toolkit))) continue;
      try {
        const ensured = await ensureToolConnection(userId, {
          toolkit,
          label: item.label || item.name || toolkit,
        });
        if (ensured.ok) results.created += 1;
      } catch (e) {
        logger.warn?.(
          `[managed-tools] reconcile ensure failed user=${userId} toolkit=${toolkit} error=${e?.code || e?.message || 'unknown'}`,
        );
      }
    }
    for (const [catalogId, row] of keptRows) {
      const toolkit = String(catalogId || '').replace(/^composio:/, '');
      if (wanted.has(toolkit)) continue;
      try {
        await manager.remove(userId, row.id);
        results.removed += 1;
      } catch (e) {
        logger.warn?.(
          `[managed-tools] reconcile remove failed user=${userId} connection=${row.id} error=${e?.code || e?.message || 'unknown'}`,
        );
      }
    }
    return results;
  }

  return { ensureToolConnection, removeToolConnection, reconcileToolConnections };
}
