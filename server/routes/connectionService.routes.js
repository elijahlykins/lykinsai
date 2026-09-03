/**
 * Managed connected-account HTTP API (LYKN Connection Service).
 *
 * Gmail-first managed connections backed by Composio. Distinct from:
 *   - /api/mcp/*               Universal MCP connections (unchanged)
 *   - /api/custom-connections  BYO REST keys (unchanged)
 *
 * Every /api/connections/managed route derives the user from requireAuth;
 * renderer-supplied user ids are never trusted. The Composio API key never
 * leaves the server and raw Composio errors are never forwarded to clients.
 */

import { createComposioGateway, ManagedConnectionError } from '../../lib/connections/composioGateway.js';
import {
  createConnectionService,
  createSupabaseConnectStateStore,
  createMemoryConnectStateStore,
} from '../../lib/connections/connectionService.js';
import { createManagedToolBridge } from '../../lib/connections/managedToolBridge.js';
import { getMcpManager } from './mcp.routes.js';
import {
  connectionCallbackHtml,
  connectionVerifyHtml,
} from '../../lib/connections/callbackPage.js';
import { mcpPublicApiBase } from '../../lib/mcp/oauth/clientIdentity.js';
import { invalidateConnectedToolsCache } from '../ai/chatContext.js';

const ERROR_HTTP_STATUS = {
  not_configured: 503,
  provider_unavailable: 502,
  rate_limited: 429,
  link_creation_failed: 502,
  not_connected: 409,
  identity_verification_failed: 403,
  verification_session_expired: 410,
  unknown_provider: 404,
  provider_requires_setup: 503,
  internal: 500,
};

function connectionErr(e, logger = console) {
  if (e instanceof ManagedConnectionError) {
    if (e.detail) {
      logger.warn?.(`[connections] ${e.code}: ${e.detail}`);
    }
    return {
      status: ERROR_HTTP_STATUS[e.code] || 500,
      body: { ok: false, error: e.code, message: e.message },
    };
  }
  logger.error?.('❌ connections:', e?.message || e);
  return { status: 500, body: { ok: false, error: 'internal' } };
}

let singleton;

export function getConnectionService(supabaseAdmin, { port } = {}) {
  if (singleton) return singleton;
  singleton = createConnectionService({
    gateway: createComposioGateway(),
    stateStore: supabaseAdmin
      ? createSupabaseConnectStateStore(supabaseAdmin)
      : createMemoryConnectStateStore(),
    publicApiBase: mcpPublicApiBase(port),
    // Connecting an app also makes its tools callable: the bridge keeps a
    // managed MCP connection row in sync per connected app, which chat,
    // bots, and voice consume through the existing Universal MCP path.
    toolBridge: createManagedToolBridge({
      manager: getMcpManager(supabaseAdmin, { port }),
    }),
  });
  return singleton;
}

export function registerConnectionServiceRoutes(app, { requireAuth, supabaseAdmin, PORT }) {
  const service = getConnectionService(supabaseAdmin, { port: PORT });
  const frontendBase =
    process.env.FRONTEND_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
  let trustedOrigin = null;
  try {
    trustedOrigin = new URL(frontendBase).origin;
  } catch {
    trustedOrigin = null;
  }

  // Public marketing catalog: names + logos only. No auth, no
  // connection state. Cached so a landing-page burst does not re-page
  // Composio.
  app.get('/api/public/toolkits', async (_req, res) => {
    try {
      const result = await service.listPublicCatalog();
      res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      return res.json({ ok: true, ...result });
    } catch (e) {
      const { status, body } = connectionErr(e);
      return res.status(status).json(body);
    }
  });

  app.get('/api/connections/managed', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const connections = await service.listConnections(userId);
      return res.json({ ok: true, connections });
    } catch (e) {
      const { status, body } = connectionErr(e);
      return res.status(status).json(body);
    }
  });

  // Searchable directory of all connectable apps (icons + live per-user
  // state). Registered before /:provider so "directory" is never treated
  // as a provider id.
  app.get('/api/connections/managed/directory', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await service.searchDirectory(userId, {
        query: typeof req.query?.q === 'string' ? req.query.q : '',
        limit: Number(req.query?.limit) || 24,
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      const { status, body } = connectionErr(e);
      return res.status(status).json(body);
    }
  });

  app.get('/api/connections/managed/:provider', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const status = await service.getStatus(userId, String(req.params.provider || ''));
      return res.json({ ok: true, connection: status });
    } catch (e) {
      const { status, body } = connectionErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/connections/managed/:provider/connect', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await service.connect(userId, String(req.params.provider || ''));
      return res.json(result);
    } catch (e) {
      const { status, body } = connectionErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/connections/managed/:provider/disconnect', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const result = await service.disconnect(userId, String(req.params.provider || ''));
      invalidateConnectedToolsCache(userId);
      return res.json(result);
    } catch (e) {
      const { status, body } = connectionErr(e);
      return res.status(status).json(body);
    }
  });

  // Callback identity verification completion. The popup relays Composio's
  // single-use session_uri to the signed-in renderer, which posts it here;
  // requireAuth supplies the user id that complete_auth must match.
  app.post('/api/connections/managed/complete', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const sessionUri = String(req.body?.sessionUri || '').trim();
      const result = await service.completeVerifiedCallback(userId, { sessionUri });
      if (result.ok) invalidateConnectedToolsCache(userId);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      const { status, body } = connectionErr(e);
      return res.status(status).json(body);
    }
  });

  // Browser return leg when Composio project verification is OFF. The
  // one-shot state (issued at connect time, bound to the authenticated
  // user) identifies who initiated; connection state is then re-read from
  // Composio server-side. Query values like status/connected_account_id
  // are never trusted as connection state.
  app.get('/oauth/connections/callback', async (req, res) => {
    try {
      const state = typeof req.query?.state === 'string' ? req.query.state : '';
      const result = await service.completeCallback({ state });
      if (result.ok && result.userId) invalidateConnectedToolsCache(result.userId);
      return res
        .status(result.ok ? 200 : 400)
        .type('html')
        .send(
          connectionCallbackHtml({
            ok: result.ok,
            provider: result.provider || null,
            error: result.error || null,
            trustedOrigin,
          }),
        );
    } catch (e) {
      connectionErr(e);
      return res
        .status(400)
        .type('html')
        .send(connectionCallbackHtml({ ok: false, error: 'connect_failed', trustedOrigin }));
    }
  });

  // Verifier URL for Composio callback identity verification (project
  // setting). Receives only an opaque single-use session_uri and relays it
  // to the trusted frontend origin; completion happens on the
  // authenticated /api/connections/managed/complete route above.
  app.get('/oauth/connections/verify', (req, res) => {
    const sessionUri = typeof req.query?.session_uri === 'string' ? req.query.session_uri : '';
    return res
      .status(200)
      .type('html')
      .send(connectionVerifyHtml({ sessionUri, trustedOrigin }));
  });
}
