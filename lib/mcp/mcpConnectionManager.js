/**
 * McpConnectionManager — infrastructure, not model reasoning.
 *
 * connect / disconnect / reconnect / health / refreshMetadata
 */

import { createMcpClientRuntime } from './mcpClientRuntime.js';
import { createSchemaCache } from './schemaCache.js';
import { classifyToolList } from './toolClassifier.js';
import { createMcpEvent, MCP_EVENT_TYPES } from './events.js';
import { toPublicConnection } from './mcpStore.js';
import { MCP_AUTH_MODES, MCP_STATUSES, MCP_TRUST_LEVELS } from './protocol.js';
import { createCredentialRef, CREDENTIAL_REF_TYPES } from './credentialRef.js';

function emit(onEvent, type, detail) {
  try {
    onEvent?.(createMcpEvent(type, detail));
  } catch {
    /* observers must not break infrastructure */
  }
}

async function resolveBearer(store, connection) {
  if (connection.authMode !== MCP_AUTH_MODES.BEARER) return {};
  const full = connection.secretEncrypted
    ? connection
    : await store.get(connection.userId, connection.id);
  const blob = full?.secretEncrypted;
  if (!blob) return {};
  const token = store.decrypt ? store.decrypt(blob) : blob;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function createMcpConnectionManager({ store, onEvent } = {}) {
  if (!store) throw new TypeError('McpConnectionManager requires a store');
  const sessions = new Map();
  const cache = createSchemaCache();

  async function closeSession(connectionId) {
    const session = sessions.get(connectionId);
    sessions.delete(connectionId);
    if (session?.runtime) {
      try {
        await session.runtime.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function discover(runtime) {
    const tools = await runtime.listTools();
    let resources = [];
    let prompts = [];
    try {
      resources = (await runtime.listResources()).resources || [];
    } catch {
      resources = [];
    }
    try {
      prompts = (await runtime.listPrompts()).prompts || [];
    } catch {
      prompts = [];
    }
    const serverInfo = {
      name: runtime.serverInfo?.name || '',
      version: runtime.serverInfo?.version || '',
      protocolVersion: runtime.protocolVersion,
    };
    const classifiedTools = classifyToolList(tools, serverInfo);
    const capabilitySummary = {
      toolCount: classifiedTools.length,
      resourceCount: resources.length,
      promptCount: prompts.length,
      tools: classifiedTools.map((t) => t.semanticCapabilities[0]).filter(Boolean),
      serverCapabilities: runtime.capabilities || {},
    };
    return { tools, resources, prompts, classifiedTools, capabilitySummary, serverInfo };
  }

  async function connect(userId, input = {}) {
    const trustLevel = input.trustLevel || MCP_TRUST_LEVELS.REMOTE;
    const authMode = input.secret ? MCP_AUTH_MODES.BEARER : input.authMode || MCP_AUTH_MODES.NONE;
    let row = input.id ? await store.get(userId, input.id) : null;
    if (!row) {
      row = await store.insert(userId, {
        name: input.name,
        serverUrl: input.serverUrl,
        trustLevel,
        authMode,
        secretEncrypted: input.secret && store.encrypt ? store.encrypt(input.secret) : input.secret || null,
        status: MCP_STATUSES.REFRESHING,
      });
    } else {
      row = await store.update(userId, row.id, {
        status: MCP_STATUSES.REFRESHING,
        lastError: null,
        ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.secret && store.encrypt
          ? { secretEncrypted: store.encrypt(input.secret), authMode: MCP_AUTH_MODES.BEARER }
          : {}),
      });
    }

    const headers = await resolveBearer(store, row);
    try {
      const runtime = await createMcpClientRuntime({
        serverUrl: row.serverUrl,
        trustLevel: row.trustLevel,
        headers,
      });
      const discovered = await discover(runtime);
      sessions.set(row.id, { runtime, userId });
      const cached = cache.put(row.id, {
        ...discovered,
        serverName: discovered.serverInfo.name,
        serverVersion: discovered.serverInfo.version,
        protocolVersion: discovered.serverInfo.protocolVersion,
        capabilities: runtime.capabilities,
      });
      const updated = await store.update(userId, row.id, {
        status: MCP_STATUSES.CONNECTED,
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
        serverInfo: discovered.serverInfo,
        capabilitySummary: discovered.capabilitySummary,
        classifiedTools: discovered.classifiedTools,
        schemaHash: cached.schemaHash,
        name: row.name === 'MCP server' && discovered.serverInfo.name ? discovered.serverInfo.name : row.name,
        credentialRef: createCredentialRef(
          row.authMode === MCP_AUTH_MODES.BEARER
            ? { type: CREDENTIAL_REF_TYPES.MCP_SECRET, connectionId: row.id }
            : { type: CREDENTIAL_REF_TYPES.NONE },
        ),
      });
      emit(onEvent, MCP_EVENT_TYPES.CONNECTION_CONNECTED, {
        connectionId: row.id,
        status: MCP_STATUSES.CONNECTED,
        toolCount: discovered.classifiedTools.length,
      });
      emit(onEvent, MCP_EVENT_TYPES.TOOL_DISCOVERED, {
        connectionId: row.id,
        toolCount: discovered.classifiedTools.length,
      });
      return { ok: true, connection: toPublicConnection(updated) };
    } catch (error) {
      await closeSession(row.id);
      cache.invalidate(row.id);
      const status =
        error.code === 'authentication_required'
          ? MCP_STATUSES.AUTHENTICATION_REQUIRED
          : error.code === 'ssrf_blocked'
            ? MCP_STATUSES.ERROR
            : MCP_STATUSES.ERROR;
      const updated = await store.update(userId, row.id, {
        status,
        lastError: String(error.message || error.code || error).slice(0, 300),
      });
      emit(onEvent, MCP_EVENT_TYPES.CONNECTION_FAILED, {
        connectionId: row.id,
        status,
        reason: error.code || 'connect_failed',
      });
      return {
        ok: false,
        connection: toPublicConnection(updated),
        error: error.code || 'connect_failed',
        message: updated.lastError,
      };
    }
  }

  async function disconnect(userId, connectionId) {
    await closeSession(connectionId);
    cache.invalidate(connectionId);
    const updated = await store.update(userId, connectionId, {
      status: MCP_STATUSES.DISCONNECTED,
      lastError: null,
    });
    emit(onEvent, MCP_EVENT_TYPES.CONNECTION_DISCONNECTED, {
      connectionId,
      status: MCP_STATUSES.DISCONNECTED,
    });
    return { ok: true, connection: toPublicConnection(updated) };
  }

  async function reconnect(userId, connectionId) {
    const row = await store.get(userId, connectionId);
    if (!row) return { ok: false, error: 'not_found' };
    await closeSession(connectionId);
    return connect(userId, { id: connectionId, serverUrl: row.serverUrl, name: row.name, trustLevel: row.trustLevel });
  }

  async function refreshMetadata(userId, connectionId) {
    const session = sessions.get(connectionId);
    const row = await store.get(userId, connectionId);
    if (!row) return { ok: false, error: 'not_found' };
    await store.update(userId, connectionId, { status: MCP_STATUSES.REFRESHING });
    try {
      let runtime = session?.runtime;
      if (!runtime) {
        const result = await reconnect(userId, connectionId);
        return result;
      }
      cache.invalidate(connectionId);
      const discovered = await discover(runtime);
      const cached = cache.put(connectionId, {
        ...discovered,
        serverName: discovered.serverInfo.name,
        serverVersion: discovered.serverInfo.version,
        protocolVersion: discovered.serverInfo.protocolVersion,
        capabilities: runtime.capabilities,
      });
      const updated = await store.update(userId, connectionId, {
        status: MCP_STATUSES.CONNECTED,
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
        serverInfo: discovered.serverInfo,
        capabilitySummary: discovered.capabilitySummary,
        classifiedTools: discovered.classifiedTools,
        schemaHash: cached.schemaHash,
      });
      return { ok: true, connection: toPublicConnection(updated) };
    } catch (error) {
      const updated = await store.update(userId, connectionId, {
        status: MCP_STATUSES.OFFLINE,
        lastError: String(error.message || error).slice(0, 300),
      });
      return { ok: false, connection: toPublicConnection(updated), error: 'offline' };
    }
  }

  async function health(userId, connectionId) {
    const row = await store.get(userId, connectionId);
    if (!row) return { ok: false, error: 'not_found' };
    const session = sessions.get(connectionId);
    if (!session?.runtime) {
      return { ok: true, status: row.status, live: false };
    }
    try {
      await session.runtime.client.ping({ timeout: 4000 });
      if (row.status !== MCP_STATUSES.CONNECTED) {
        await store.update(userId, connectionId, { status: MCP_STATUSES.CONNECTED, lastError: null });
      }
      return { ok: true, status: MCP_STATUSES.CONNECTED, live: true };
    } catch {
      await store.update(userId, connectionId, { status: MCP_STATUSES.OFFLINE, lastError: 'ping_failed' });
      return { ok: true, status: MCP_STATUSES.OFFLINE, live: false };
    }
  }

  async function ensureRuntime(userId, connectionId) {
    const existing = sessions.get(connectionId);
    if (existing?.runtime) return existing.runtime;
    const result = await reconnect(userId, connectionId);
    if (!result.ok) {
      const err = new Error(result.message || result.error || 'offline');
      err.code = result.error || 'offline';
      throw err;
    }
    return sessions.get(connectionId).runtime;
  }

  async function callTool({ userId, connectionId, toolName, args, signal, taskId, runId }) {
    emit(onEvent, MCP_EVENT_TYPES.TOOL_CALLED, { userId, connectionId, toolName, taskId, runId });
    const runtime = await ensureRuntime(userId, connectionId);
    try {
      const result = await runtime.callTool({
        name: toolName,
        arguments: args,
        signal,
        taskId,
        runId,
        connectionId,
      });
      emit(onEvent, MCP_EVENT_TYPES.TOOL_COMPLETED, {
        connectionId,
        toolName,
        taskId,
        runId,
        status: 'ok',
      });
      return result;
    } catch (error) {
      if (error?.code === 'aborted') throw error;
      const message = String(error?.message || error);
      if (/unknown tool|not found|invalid tool/i.test(message)) {
        cache.invalidate(connectionId);
        await refreshMetadata(userId, connectionId);
      }
      emit(onEvent, MCP_EVENT_TYPES.TOOL_COMPLETED, {
        connectionId,
        toolName,
        taskId,
        runId,
        status: 'error',
        reason: error.code || 'tool_failed',
      });
      throw error;
    }
  }

  async function list(userId) {
    const rows = await store.list(userId);
    return rows.map(toPublicConnection);
  }

  async function get(userId, connectionId) {
    return toPublicConnection(await store.get(userId, connectionId));
  }

  function cachedTools(connectionId) {
    return cache.get(connectionId);
  }

  return {
    connect,
    disconnect,
    reconnect,
    refreshMetadata,
    health,
    callTool,
    list,
    get,
    ensureRuntime,
    cachedTools,
    cache,
    store,
  };
}
