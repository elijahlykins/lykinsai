/**
 * Universal MCP connection HTTP API.
 * Additive. Does not replace /api/connections (Vault-sync connectors).
 */

import { encryptToken, decryptToken } from '../../connectors-service.js';
import {
  createMcpConnectionManager,
  createSupabaseMcpStore,
  createMemoryMcpStore,
  resolveExternalTools,
  executeMcpTool,
  MCP_TRUST_LEVELS,
  MCP_STATUSES,
} from '../../lib/mcp/index.js';
import { assertMcpUrlSafe } from '../../lib/mcp/urlPolicy.js';
import { createSupabaseOAuthSessionStore, createMemoryOAuthSessionStore } from '../../lib/mcp/oauth/oauthSession.js';
import { mcpOAuthRedirectUri, publicClientMetadataDocument } from '../../lib/mcp/oauth/clientIdentity.js';
import { mcpOAuthCallbackHtml, callbackCopy } from '../../lib/mcp/oauth/callbackPage.js';

function mcpErr(e) {
  const code = e?.code || e?.error || 'internal';
  if (code === 'SSRF_BLOCKED' || String(e?.message || '').startsWith('ssrf_blocked')) {
    return { status: 400, body: { error: 'ssrf_blocked', message: e.reason || e.message } };
  }
  if (code === 'not_found') return { status: 404, body: { error: 'not_found' } };
  if (e?.isValidation || e instanceof TypeError) {
    return { status: 400, body: { error: 'validation', message: e.message } };
  }
  console.error('❌ mcp:', e?.message || e);
  return { status: 500, body: { error: 'internal' } };
}

let singleton;

export function getMcpManager(supabaseAdmin, { port } = {}) {
  if (singleton) return singleton;
  const store = supabaseAdmin
    ? createSupabaseMcpStore(supabaseAdmin, { encrypt: encryptToken, decrypt: decryptToken })
    : createMemoryMcpStore();
  if (supabaseAdmin) {
    store.encrypt = encryptToken;
    store.decrypt = decryptToken;
  }
  singleton = createMcpConnectionManager({
    store,
    sessionStore: supabaseAdmin
      ? createSupabaseOAuthSessionStore(supabaseAdmin)
      : createMemoryOAuthSessionStore(),
    redirectUri: mcpOAuthRedirectUri(port),
  });
  return singleton;
}

export function registerMcpRoutes(app, { requireAuth, supabaseAdmin, PORT }) {
  const manager = getMcpManager(supabaseAdmin, { port: PORT });
  const frontendBase =
    process.env.FRONTEND_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
  let trustedOrigin = null;
  try {
    trustedOrigin = new URL(frontendBase).origin;
  } catch {
    trustedOrigin = null;
  }

  app.get('/oauth/mcp/client-metadata', (_req, res) => {
    res.json(publicClientMetadataDocument({ redirectUri: mcpOAuthRedirectUri(PORT) }));
  });

  app.get('/oauth/mcp/callback', async (req, res) => {
    const state = typeof req.query?.state === 'string' ? req.query.state : '';
    const code = typeof req.query?.code === 'string' ? req.query.code : '';
    const oauthError = typeof req.query?.error === 'string' ? req.query.error : '';
    const errorDescription =
      typeof req.query?.error_description === 'string' ? req.query.error_description.slice(0, 180) : '';
    try {
      const result = await manager.finishAuthorization(undefined, {
        state,
        code,
        error: oauthError,
        errorDescription,
      });
      const kind = result.ok
        ? 'connected'
        : result.error || 'invalid_callback';
      const copy = callbackCopy(kind);
      return res
        .status(result.ok ? 200 : 400)
        .type('html')
        .send(mcpOAuthCallbackHtml({ ...copy, ok: !!result.ok, trustedOrigin }));
    } catch (e) {
      const copy = callbackCopy(e?.code || 'invalid_callback');
      return res.status(400).type('html').send(mcpOAuthCallbackHtml({ ...copy, ok: false, trustedOrigin }));
    }
  });

  app.get('/api/mcp/connections', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const connections = await manager.list(userId);
      return res.json({ ok: true, connections });
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/mcp/connections', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const serverUrl = String(req.body?.serverUrl || req.body?.url || '').trim();
      const trustLevel =
        req.body?.trustLevel === MCP_TRUST_LEVELS.LOCAL_TRUSTED
          ? MCP_TRUST_LEVELS.LOCAL_TRUSTED
          : req.body?.trustLevel === MCP_TRUST_LEVELS.ENTERPRISE
            ? MCP_TRUST_LEVELS.ENTERPRISE
            : MCP_TRUST_LEVELS.CUSTOM;
      const urlCheck = await assertMcpUrlSafe(serverUrl, { trustLevel });
      if (!urlCheck.ok) {
        return res.status(400).json({ error: urlCheck.error, message: urlCheck.error });
      }
      const result = await manager.connect(userId, {
        name: req.body?.name,
        serverUrl,
        secret: req.body?.secret || req.body?.token || null,
        trustLevel,
        accountLabel: req.body?.accountLabel || req.body?.name,
        accountIdentity: req.body?.accountIdentity,
      });
      const httpStatus = result.ok
        ? 200
        : result.error === 'authentication_required' || result.error === 'authorizing'
          ? 401
          : 400;
      return res.status(httpStatus).json(result);
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/mcp/connections/:id/authorize', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await manager.startAuthorization(userId, String(req.params.id || ''));
      return res.status(result.authorizationUrl ? 200 : 400).json(result);
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.patch('/api/mcp/connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await manager.rename(userId, String(req.params.id || ''), {
        name: req.body?.name,
        accountLabel: req.body?.accountLabel,
      });
      return res.status(result.ok ? 200 : 404).json(result);
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/mcp/connections/:id/refresh', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await manager.refreshMetadata(userId, String(req.params.id || ''));
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/mcp/connections/:id/reconnect', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await manager.reconnect(userId, String(req.params.id || ''));
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.get('/api/mcp/connections/:id/health', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await manager.health(userId, String(req.params.id || ''));
      return res.json(result);
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/mcp/connections/:id/disconnect', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await manager.disconnect(userId, String(req.params.id || ''));
      return res.json(result);
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.delete('/api/mcp/connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await manager.disconnect(userId, String(req.params.id || ''));
      await manager.store.remove(userId, String(req.params.id || ''));
      return res.json({ ok: true, connection: result.connection, revocation: result.revocation });
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/mcp/connections/:id/tools/call', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const connectionId = String(req.params.id || '');
      const toolName = String(req.body?.toolName || req.body?.name || '');
      const task = req.body?.task || null;
      const connections = await manager.store.list(userId);
      const owned = connections.find((row) => row.id === connectionId);
      if (!owned) return res.status(404).json({ error: 'not_found' });
      const classifiedByConnectionId = Object.fromEntries(
        connections.map((row) => [row.id, row.classifiedTools || []]),
      );
      const resolution = resolveExternalTools({
        task: task || { objective: toolName, capabilities: req.body?.capabilities || [] },
        connections,
        classifiedByConnectionId,
        botConnectionIds: req.body?.botConnectionIds,
      });
      if (task) {
        const executed = await executeMcpTool({
          task: {
            ...task,
            cancellation: {
              ...(task.cancellation || {}),
              signal: req.abortSignal || null,
            },
          },
          resolution,
          connectionId,
          toolName,
          args: req.body?.arguments || req.body?.args || {},
          connection: owned,
          currentTool: (owned.classifiedTools || []).find((t) => t.toolName === toolName),
          callTool: (opts) =>
            manager.callTool({
              userId,
              connectionId: opts.connectionId,
              toolName: opts.toolName,
              args: opts.args,
              signal: opts.signal,
              taskId: opts.taskId,
              runId: opts.runId,
            }),
        });
        return res.json(executed);
      }
      const result = await manager.callTool({
        userId,
        connectionId,
        toolName,
        args: req.body?.arguments || req.body?.args || {},
        taskId: req.body?.taskId,
        runId: req.body?.runId,
      });
      return res.json({ ok: true, observation: result });
    } catch (e) {
      const { status, body } = mcpErr(e);
      return res.status(status).json(body);
    }
  });
}

export { MCP_STATUSES };
