/**
 * McpConnectionManager — infrastructure, not model reasoning.
 *
 * connect / disconnect / reconnect / health / refreshMetadata /
 * startAuthorization / finishAuthorization / rename / revoke
 */

import { createMcpClientRuntime } from './mcpClientRuntime.js';
import { createSchemaCache } from './schemaCache.js';
import { TOOL_CACHE_POLICY_VERSION } from './toolCacheSelect.js';
import { classifyToolList } from './toolClassifier.js';
import { createClassificationCache, maybeModelClassifyTools } from './modelClassifier.js';
import { createMcpEvent, MCP_EVENT_TYPES } from './events.js';
import { toPublicConnection } from './mcpStore.js';
import {
  MCP_AUTH_MODES,
  MCP_STATUSES,
  MCP_TRUST_LEVELS,
  MCP_TRANSPORTS,
  AUTH_REQUIRED_STATUSES,
  isManagedToolConnection,
} from './protocol.js';
import { createCredentialRef, CREDENTIAL_REF_TYPES } from './credentialRef.js';
import { parseLocalCommand } from './stdio/parseLocalCommand.js';
import { assertLocalCommandSafe, assertWorkingDirectorySafe } from './stdio/commandPolicy.js';
import { assertNoRawEnvSecrets, publicEnvCredentialRefs } from './stdio/envRefs.js';
import { createLocalMcpProcessManager } from './stdio/processManager.js';
import { groupConnectionCapabilities, publicClassifiedTool } from './capabilityView.js';
import { suggestCatalogForCapabilities } from './catalog/curated.js';
import { createMemoryOAuthSessionStore } from './oauth/oauthSession.js';
import {
  createLyknOAuthProvider,
  decryptOAuthBlob,
  discoverAuthorization,
  persistOAuth,
  runMcpAuth,
} from './oauth/oauthProvider.js';
import { revokeOAuthTokens } from './oauth/revoke.js';
import { mcpOAuthRedirectUri } from './oauth/clientIdentity.js';
import { buildServerIdentity, compareServerIdentity } from './serverIdentity.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

function emit(onEvent, type, detail) {
  try {
    onEvent?.(createMcpEvent(type, detail));
  } catch {
    /* observers must not break infrastructure */
  }
}

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return '';
  }
}

export function createMcpConnectionManager({
  store,
  onEvent,
  sessionStore,
  redirectUri,
  modelClassify,
  processManager,
  resolveCredential,
  // async (userId, row, { fresh }) => { url, headers } for connections whose
  // endpoint is minted live by the LYKN Connection Service (managed OAuth
  // apps). The url/headers are never persisted and never logged.
  resolveManagedEndpoint,
} = {}) {
  if (!store) throw new TypeError('McpConnectionManager requires a store');
  const sessions = new Map();
  const cache = createSchemaCache();
  const classificationCache = createClassificationCache();
  const oauthSessions = sessionStore || createMemoryOAuthSessionStore();
  const defaultRedirect = redirectUri || mcpOAuthRedirectUri();
  const localProcesses = processManager || createLocalMcpProcessManager({ resolveCredential });
  const attention = new Map();
  let liveEpoch = new Map();

  function epoch(connectionId) {
    return liveEpoch.get(connectionId) || 0;
  }

  function bumpEpoch(connectionId) {
    const next = epoch(connectionId) + 1;
    liveEpoch.set(connectionId, next);
    return next;
  }

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

  async function resolveAuth(connection) {
    const full = connection.secretEncrypted || connection.oauthEncrypted
      ? connection
      : await store.get(connection.userId, connection.id);
    if (full?.authMode === MCP_AUTH_MODES.BEARER) {
      const blob = full.secretEncrypted;
      const token = blob && store.decrypt ? store.decrypt(blob) : blob;
      if (!token) return { headers: {}, tokens: null };
      return { headers: { Authorization: `Bearer ${token}` }, tokens: { access_token: token } };
    }
    if (full?.authMode === MCP_AUTH_MODES.OAUTH) {
      const oauth = decryptOAuthBlob(store, full);
      const access = oauth?.tokens?.access_token;
      if (!access) return { headers: {}, tokens: oauth?.tokens || null, oauth };
      return {
        headers: { Authorization: `Bearer ${access}` },
        tokens: oauth.tokens,
        oauth,
      };
    }
    return { headers: {}, tokens: null };
  }

  async function classifyDiscovered(tools, serverInfo) {
    const modelByFingerprint = await maybeModelClassifyTools(tools, {
      modelClassify,
      cache: classificationCache,
    });
    return classifyToolList(tools, serverInfo, { modelByFingerprint });
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
    const classifiedTools = await classifyDiscovered(tools, serverInfo);
    const capabilitySummary = {
      toolCount: classifiedTools.length,
      resourceCount: resources.length,
      promptCount: prompts.length,
      tools: classifiedTools.map((t) => t.semanticCapabilities[0]).filter(Boolean),
      serverCapabilities: runtime.capabilities || {},
      toolCachePolicy: TOOL_CACHE_POLICY_VERSION,
    };
    return { tools, resources, prompts, classifiedTools, capabilitySummary, serverInfo };
  }

  async function markAuthRequired(userId, row, message) {
    const updated = await store.update(userId, row.id, {
      status: MCP_STATUSES.AUTHENTICATION_REQUIRED,
      lastError: String(message || 'authentication_required').slice(0, 300),
    });
    emit(onEvent, MCP_EVENT_TYPES.CONNECTION_AUTH_REQUIRED, {
      connectionId: row.id,
      status: MCP_STATUSES.AUTHENTICATION_REQUIRED,
    });
    return updated;
  }

  async function beginAuthorization(userId, row, { resourceMetadataUrl } = {}) {
    const bundle = createLyknOAuthProvider({
      connection: row,
      store,
      sessionStore: oauthSessions,
      redirectUri: defaultRedirect,
      trustLevel: row.trustLevel,
    });
    await store.update(userId, row.id, {
      status: MCP_STATUSES.AUTHORIZING,
      authMode: MCP_AUTH_MODES.OAUTH,
      lastError: null,
      credentialRef: createCredentialRef({ type: CREDENTIAL_REF_TYPES.MCP_OAUTH, connectionId: row.id }),
    });
    const result = await runMcpAuth(bundle, {
      serverUrl: row.serverUrl,
      resourceMetadataUrl,
    });
    const authorizationUrl = bundle.getAuthorizationUrl();
    emit(onEvent, MCP_EVENT_TYPES.CONNECTION_AUTHORIZING, {
      connectionId: row.id,
      status: MCP_STATUSES.AUTHORIZING,
    });
    return {
      ok: false,
      connection: toPublicConnection(await store.get(userId, row.id)),
      error: 'authorizing',
      authorizationUrl,
      authResult: result,
    };
  }

  function noteAttention(userId, item) {
    const uid = String(userId || '');
    if (!uid || !item) return;
    const list = attention.get(uid) || [];
    const next = [
      {
        type: item.type || 'connection',
        title: String(item.title || '').slice(0, 80),
        connectionId: item.connectionId || null,
        catalogId: item.catalogId || null,
        needs: Array.isArray(item.needs) ? item.needs.slice(0, 6) : [],
        at: new Date().toISOString(),
      },
      ...list.filter((row) => row.connectionId !== item.connectionId || row.catalogId !== item.catalogId),
    ].slice(0, 12);
    attention.set(uid, next);
  }

  function listAttention(userId) {
    return attention.get(String(userId || '')) || [];
  }

  function isStdioInput(input, row) {
    return (
      input.transport === MCP_TRANSPORTS.STDIO ||
      row?.transport === MCP_TRANSPORTS.STDIO ||
      Boolean(input.command || input.commandLine)
    );
  }

  async function startManagedRuntime(userId, row, { fresh = false } = {}) {
    if (typeof resolveManagedEndpoint !== 'function') {
      const err = new Error('managed_endpoint_unavailable');
      err.code = 'managed_endpoint_unavailable';
      throw err;
    }
    const endpoint = await resolveManagedEndpoint(userId, row, { fresh });
    if (!endpoint?.url) {
      const err = new Error('managed_endpoint_unavailable');
      err.code = 'managed_endpoint_unavailable';
      throw err;
    }
    return createMcpClientRuntime({
      serverUrl: endpoint.url,
      trustLevel: row.trustLevel,
      headers: { ...(endpoint.headers || {}) },
    });
  }

  async function startStdioRuntime(row, { confirmInstall = true } = {}) {
    const session = await localProcesses.start(row.id, {
      command: row.command,
      args: row.args,
      workingDirectory: row.workingDirectory,
      envCredentialRefs: row.envCredentialRefs,
      confirmInstall,
      userId: row.userId,
    });
    return createMcpClientRuntime({
      transportKind: MCP_TRANSPORTS.STDIO,
      stdioTransport: session.transport,
      trustLevel: row.trustLevel,
    });
  }

  async function connect(userId, input = {}) {
    const stdio = isStdioInput(input);
    const trustLevel =
      input.trustLevel || (stdio ? MCP_TRUST_LEVELS.LOCAL_TRUSTED : MCP_TRUST_LEVELS.CUSTOM);
    const authMode = input.secret
      ? MCP_AUTH_MODES.BEARER
      : input.authMode || MCP_AUTH_MODES.NONE;

    let stdioSpec = null;
    if (stdio) {
      const parsed = parseLocalCommand(
        input.command
          ? { command: input.command, args: input.args, confirmInstall: input.confirmInstall }
          : input.commandLine || input.command,
      );
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, message: parsed.error };
      }
      const safe = assertLocalCommandSafe({
        command: parsed.command,
        args: parsed.args,
        confirmInstall: input.confirmInstall === true || parsed.confirmInstall,
      });
      if (!safe.ok) {
        return { ok: false, error: safe.error, message: safe.error };
      }
      const cwd = assertWorkingDirectorySafe(input.workingDirectory);
      if (!cwd.ok) return { ok: false, error: cwd.error, message: cwd.error };
      const envCheck = assertNoRawEnvSecrets(input.env || input.environment);
      if (!envCheck.ok) return { ok: false, error: envCheck.error, message: envCheck.error };
      stdioSpec = {
        command: safe.command,
        args: safe.args,
        workingDirectory: cwd.cwd,
        envCredentialRefs: publicEnvCredentialRefs(input.envCredentialRefs),
        confirmInstall: true,
      };
    }

    let row = input.id ? await store.get(userId, input.id) : null;
    if (!row) {
      row = await store.insert(userId, {
        name: input.name,
        serverUrl: stdio ? '' : input.serverUrl,
        transport: stdio ? MCP_TRANSPORTS.STDIO : MCP_TRANSPORTS.STREAMABLE_HTTP,
        trustLevel,
        authMode,
        secretEncrypted: input.secret && store.encrypt ? store.encrypt(input.secret) : input.secret || null,
        status: MCP_STATUSES.REFRESHING,
        accountLabel: input.accountLabel || input.name || null,
        origin: stdio ? 'stdio:local' : originOf(input.serverUrl),
        catalogId: input.catalogId || null,
        catalogSource: input.catalogSource || {},
        providedThrough: input.providedThrough || null,
        ...(stdioSpec || {}),
      });
    } else {
      row = await store.update(userId, row.id, {
        status: MCP_STATUSES.REFRESHING,
        lastError: null,
        ...(input.serverUrl ? { serverUrl: input.serverUrl, origin: originOf(input.serverUrl) } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.accountLabel ? { accountLabel: input.accountLabel } : {}),
        ...(input.accountIdentity ? { accountIdentity: input.accountIdentity } : {}),
        ...(stdioSpec || {}),
        ...(input.secret && store.encrypt
          ? { secretEncrypted: store.encrypt(input.secret), authMode: MCP_AUTH_MODES.BEARER }
          : {}),
      });
    }

    const managed = !stdio && isManagedToolConnection(row);
    try {
      const auth = stdio || managed ? { headers: {} } : await resolveAuth(row);
      let runtime;
      let discovered;
      if (stdio) {
        runtime = await startStdioRuntime({ ...row, ...stdioSpec }, { confirmInstall: true });
        discovered = await discover(runtime);
      } else if (managed) {
        try {
          runtime = await startManagedRuntime(userId, row);
          discovered = await discover(runtime);
        } catch (error) {
          const unauthorized =
            error?.code === 'authentication_required' ||
            error instanceof UnauthorizedError ||
            /401|unauthorized/i.test(String(error?.message || ''));
          if (!unauthorized) throw error;
          // The managed session may have rotated; mint a fresh endpoint once.
          try {
            await runtime?.close();
          } catch {
            /* ignore */
          }
          runtime = await startManagedRuntime(userId, row, { fresh: true });
          discovered = await discover(runtime);
        }
      } else {
        runtime = await createMcpClientRuntime({
          serverUrl: row.serverUrl,
          trustLevel: row.trustLevel,
          headers: auth.headers,
        });
        discovered = await discover(runtime);
      }
      const identity = buildServerIdentity({
        serverUrl: row.serverUrl,
        serverInfo: discovered.serverInfo,
        authorizationServerUrl: auth.oauth?.discovery?.authorizationServerUrl,
      });
      const previous = row.identity;
      const mismatch = compareServerIdentity(previous, identity);
      if (mismatch.mismatch && previous?.origin) {
        await runtime.close();
        if (stdio) await localProcesses.stop(row.id, { reason: 'identity_mismatch' });
        const updated = await store.update(userId, row.id, {
          status: MCP_STATUSES.ERROR,
          lastError: `identity_mismatch:${mismatch.reason}`,
        });
        emit(onEvent, MCP_EVENT_TYPES.CONNECTION_FAILED, {
          connectionId: row.id,
          status: MCP_STATUSES.ERROR,
          reason: 'identity_mismatch',
        });
        return { ok: false, connection: toPublicConnection(updated), error: 'identity_mismatch' };
      }
      sessions.set(row.id, { runtime, userId, epoch: epoch(row.id) });
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
        identity,
        origin: identity.origin,
        name: row.name === 'MCP server' && discovered.serverInfo.name ? discovered.serverInfo.name : row.name,
        credentialRef: createCredentialRef(
          row.authMode === MCP_AUTH_MODES.OAUTH
            ? { type: CREDENTIAL_REF_TYPES.MCP_OAUTH, connectionId: row.id }
            : row.authMode === MCP_AUTH_MODES.BEARER
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
      if (stdio) await localProcesses.stop(row.id, { reason: 'connect_failed' });
      cache.invalidate(row.id);
      const authRequired =
        row.transport !== MCP_TRANSPORTS.STDIO &&
        (error.code === 'authentication_required' ||
          error instanceof UnauthorizedError ||
          /401|unauthorized/i.test(String(error.message || '')));
      if (authRequired) {
        if (managed) {
          // Managed endpoints authenticate via the Connection Service, not
          // MCP OAuth. A persistent 401 means the app connection itself is
          // broken; the fix is Reconnect in Settings.
          const updated = await markAuthRequired(userId, row, 'Reconnect this app in Settings');
          return {
            ok: false,
            connection: toPublicConnection(updated),
            error: 'authentication_required',
            message: updated.lastError,
          };
        }
        if (row.authMode === MCP_AUTH_MODES.BEARER || input.secret) {
          const updated = await markAuthRequired(userId, row, 'Authentication required');
          return {
            ok: false,
            connection: toPublicConnection(updated),
            error: 'authentication_required',
            message: updated.lastError,
          };
        }
        try {
          const discovery = await discoverAuthorization({
            serverUrl: row.serverUrl,
            trustLevel: row.trustLevel,
          });
          if (!discovery?.authorizationServerMetadata) {
            const updated = await markAuthRequired(userId, row, 'Authentication required');
            return {
              ok: false,
              connection: toPublicConnection(updated),
              error: 'authentication_required',
              message: updated.lastError,
            };
          }
          return beginAuthorization(userId, { ...row, authMode: MCP_AUTH_MODES.OAUTH }, {});
        } catch (oauthError) {
          if (oauthError?.code === 'SSRF_BLOCKED' || String(oauthError?.message || '').startsWith('ssrf_blocked')) {
            const updated = await store.update(userId, row.id, {
              status: MCP_STATUSES.ERROR,
              lastError: String(oauthError.reason || oauthError.message).slice(0, 300),
            });
            return { ok: false, connection: toPublicConnection(updated), error: 'ssrf_blocked' };
          }
          const updated = await markAuthRequired(userId, row, 'Authentication required');
          return {
            ok: false,
            connection: toPublicConnection(updated),
            error: 'authentication_required',
            message: updated.lastError,
          };
        }
      }
      const status = error.code === 'ssrf_blocked' ? MCP_STATUSES.ERROR : MCP_STATUSES.ERROR;
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

  async function startAuthorization(userId, connectionId) {
    const row = await store.get(userId, connectionId);
    if (!row) return { ok: false, error: 'not_found' };
    return beginAuthorization(userId, row);
  }

  async function finishAuthorization(userId, { state, code, error: oauthError, errorDescription } = {}) {
    if (oauthError) {
      let row = null;
      try {
        const peeked = await oauthSessions.peek(state);
        if (peeked) row = await store.get(peeked.userId, peeked.connectionId);
      } catch {
        /* ignore */
      }
      const status =
        oauthError === 'access_denied' ? MCP_STATUSES.AUTHENTICATION_REQUIRED : MCP_STATUSES.ERROR;
      if (row) {
        await store.update(row.userId, row.id, {
          status,
          lastError: String(errorDescription || oauthError).slice(0, 300),
        });
      }
      return {
        ok: false,
        error: oauthError === 'access_denied' ? 'authorization_declined' : 'authorization_failed',
        connection: row ? toPublicConnection(await store.get(row.userId, row.id)) : null,
      };
    }
    const session = await oauthSessions.consume({ state, userId });
    const row = await store.get(session.userId, session.connectionId);
    if (!row) return { ok: false, error: 'not_found' };
    const bundle = createLyknOAuthProvider({
      connection: row,
      store,
      sessionStore: oauthSessions,
      redirectUri: session.redirectUri || defaultRedirect,
      trustLevel: row.trustLevel,
    });
    bundle.attachSession(session);
    try {
      await runMcpAuth(bundle, {
        serverUrl: row.serverUrl,
        authorizationCode: String(code || ''),
      });
      await store.update(session.userId, row.id, {
        authMode: MCP_AUTH_MODES.OAUTH,
        credentialRef: createCredentialRef({ type: CREDENTIAL_REF_TYPES.MCP_OAUTH, connectionId: row.id }),
      });
      return connect(session.userId, { id: row.id, serverUrl: row.serverUrl, name: row.name, trustLevel: row.trustLevel });
    } catch (error) {
      const updated = await markAuthRequired(session.userId, row, error.message || 'authorization_failed');
      return {
        ok: false,
        connection: toPublicConnection(updated),
        error: error instanceof InvalidGrantError ? 'invalid_grant' : 'authorization_failed',
      };
    }
  }

  async function refreshTokens(userId, connectionId) {
    const row = await store.get(userId, connectionId);
    if (!row || row.authMode !== MCP_AUTH_MODES.OAUTH) return { ok: false, error: 'not_oauth' };
    await store.update(userId, connectionId, { status: MCP_STATUSES.REFRESHING });
    const bundle = createLyknOAuthProvider({
      connection: row,
      store,
      sessionStore: oauthSessions,
      redirectUri: defaultRedirect,
      trustLevel: row.trustLevel,
    });
    try {
      const result = await runMcpAuth(bundle, { serverUrl: row.serverUrl });
      if (result === 'REDIRECT') {
        const updated = await markAuthRequired(userId, row, 'reauthorization_required');
        return {
          ok: false,
          connection: toPublicConnection(updated),
          error: 'authentication_required',
          authorizationUrl: bundle.getAuthorizationUrl(),
        };
      }
      return { ok: true, connection: toPublicConnection(await store.get(userId, connectionId)) };
    } catch (error) {
      const invalid = error instanceof InvalidGrantError || /invalid_grant/i.test(String(error?.message || ''));
      const updated = await markAuthRequired(userId, row, invalid ? 'reauthorization_required' : error.message);
      return {
        ok: false,
        connection: toPublicConnection(updated),
        error: invalid ? 'invalid_grant' : 'refresh_failed',
      };
    }
  }

  async function disconnect(userId, connectionId) {
    const row = await store.get(userId, connectionId);
    bumpEpoch(connectionId);
    await closeSession(connectionId);
    if (row?.transport === MCP_TRANSPORTS.STDIO) {
      await localProcesses.stop(connectionId, { reason: 'disconnect' });
    }
    cache.invalidate(connectionId);
    let revocation = { ok: true, remote: false, reason: 'no_oauth' };
    if (row?.authMode === MCP_AUTH_MODES.OAUTH) {
      const oauth = decryptOAuthBlob(store, row);
      revocation = await revokeOAuthTokens({
        tokens: oauth?.tokens,
        discovery: oauth?.discovery,
        clientInformation: oauth?.client,
        trustLevel: row.trustLevel,
      });
      await persistOAuth(store, row, { tokens: null, clearTokens: true, oauthClient: null, oauthDiscovery: oauth?.discovery || null });
    }
    const updated = await store.update(userId, connectionId, {
      status: MCP_STATUSES.DISCONNECTED,
      lastError: revocation.remote ? null : revocation.reason === 'revocation_endpoint_unsupported' ? null : row?.lastError,
      secretEncrypted: null,
      oauthEncrypted: row?.authMode === MCP_AUTH_MODES.OAUTH ? (await store.get(userId, connectionId))?.oauthEncrypted : null,
      sessionEpoch: epoch(connectionId),
    });
    emit(onEvent, MCP_EVENT_TYPES.CONNECTION_DISCONNECTED, {
      connectionId,
      status: MCP_STATUSES.DISCONNECTED,
    });
    return {
      ok: true,
      connection: toPublicConnection(updated),
      revocation: {
        remote: !!revocation.remote,
        limitation: revocation.remote ? null : 'remote_revocation_unavailable_local_credentials_deleted',
        reason: revocation.reason || null,
      },
    };
  }

  async function reconnect(userId, connectionId) {
    const row = await store.get(userId, connectionId);
    if (!row) return { ok: false, error: 'not_found' };
    await closeSession(connectionId);
    return connect(userId, {
      id: connectionId,
      serverUrl: row.serverUrl,
      name: row.name,
      trustLevel: row.trustLevel,
      transport: row.transport,
      command: row.command,
      args: row.args,
      workingDirectory: row.workingDirectory,
      envCredentialRefs: row.envCredentialRefs,
      confirmInstall: row.transport === MCP_TRANSPORTS.STDIO,
    });
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

  async function rename(userId, connectionId, { name, accountLabel } = {}) {
    const updated = await store.update(userId, connectionId, {
      ...(name ? { name } : {}),
      ...(accountLabel !== undefined ? { accountLabel } : {}),
    });
    if (!updated) return { ok: false, error: 'not_found' };
    return { ok: true, connection: toPublicConnection(updated) };
  }

  async function ensureRuntime(userId, connectionId) {
    const row = await store.get(userId, connectionId);
    if (!row) {
      const err = new Error('not_found');
      err.code = 'not_found';
      throw err;
    }
    if (row.status === MCP_STATUSES.DISCONNECTED || row.status === MCP_STATUSES.REVOKED) {
      const err = new Error('connection_unavailable');
      err.code = 'connection_unavailable';
      throw err;
    }
    if (AUTH_REQUIRED_STATUSES.includes(row.status) && row.status !== MCP_STATUSES.REFRESHING) {
      const err = new Error('connection_auth_required');
      err.code = 'authentication_required';
      throw err;
    }
    const existing = sessions.get(connectionId);
    if (existing?.runtime) {
      localProcesses.touch?.(connectionId);
      return existing.runtime;
    }
    const result = await reconnect(userId, connectionId);
    if (!result.ok) {
      const err = new Error(result.message || result.error || 'offline');
      err.code = result.error || 'offline';
      throw err;
    }
    return sessions.get(connectionId).runtime;
  }

  async function callTool({ userId, connectionId, toolName, args, signal, taskId, runId, _managedRetry }) {
    const callEpoch = epoch(connectionId);
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
      if (epoch(connectionId) !== callEpoch) {
        const err = new Error('connection_disconnected');
        err.code = 'aborted';
        throw err;
      }
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
      const authError =
        error?.code === 'authentication_required' ||
        error instanceof InvalidGrantError ||
        /401|unauthorized/i.test(String(error?.message || ''));
      if (authError) {
        const row = await store.get(userId, connectionId);
        if (isManagedToolConnection(row) && !_managedRetry) {
          // Managed sessions rotate; a reconnect mints a fresh endpoint.
          await closeSession(connectionId);
          const result = await reconnect(userId, connectionId).catch(() => null);
          if (result?.ok) {
            return callTool({ userId, connectionId, toolName, args, signal, taskId, runId, _managedRetry: true });
          }
          error.code = 'authentication_required';
          throw error;
        }
      }
      if (error?.code === 'authentication_required' || error instanceof InvalidGrantError) {
        await refreshTokens(userId, connectionId).catch(() => null);
        const row = await store.get(userId, connectionId);
        if (AUTH_REQUIRED_STATUSES.includes(row?.status)) {
          error.code = 'authentication_required';
          throw error;
        }
      }
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

  async function detail(userId, connectionId) {
    const row = await store.get(userId, connectionId);
    if (!row) return { ok: false, error: 'not_found' };
    const cached = cache.get(connectionId);
    return {
      ok: true,
      connection: toPublicConnection(row),
      capabilities: groupConnectionCapabilities(row.classifiedTools),
      tools: (row.classifiedTools || []).map(publicClassifiedTool),
      resources: (cached?.resources || []).slice(0, 20).map((item) => ({
        uri: item.uri || item.name,
        name: item.name || item.uri,
      })),
      prompts: (cached?.prompts || []).slice(0, 20).map((item) => ({
        name: item.name,
        description: item.description || '',
      })),
      live: Boolean(sessions.get(connectionId)?.runtime),
    };
  }

  async function remove(userId, connectionId) {
    const result = await disconnect(userId, connectionId);
    await localProcesses.stop(connectionId, { reason: 'delete' });
    await store.remove(userId, connectionId);
    return result;
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
    detail,
    remove,
    ensureRuntime,
    startAuthorization,
    finishAuthorization,
    refreshTokens,
    rename,
    noteAttention,
    listAttention,
    stopAllLocal: () => localProcesses.stopAll(),
    pinLocal: (id) => localProcesses.pin(id),
    unpinLocal: (id) => localProcesses.unpin(id),
    suggestCatalog: suggestCatalogForCapabilities,
    cachedTools,
    cache,
    store,
    oauthSessions,
    localProcesses,
  };
}
