// ============================================================================
// server/routes/connections.routes.js — custom connections
// ============================================================================
// Extracted verbatim from server.js (Wave 2 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.

import {
  listCustomConnections,
  createCustomConnection,
  updateCustomConnection,
  deleteCustomConnection,
  callApp,
  CustomConnectionError,
} from '../../lib/customConnections/customConnections.js';

// --- Custom connections (universal bring-your-own-API-key) ----------------
// The user attaches ANY app (base URL + API key + how to send it); the LYKN
// agent then acts on it via lykn_call_app, with the secret injected
// server-side. The secret is write-only from the client's POV — it is never
// returned by these routes (the service strips it).
function _customConnErr(e) {
  if (e instanceof CustomConnectionError || e?.isValidation) {
    return { status: 400, body: { error: 'validation', message: e.message } };
  }
  console.error('❌ custom-connections:', e?.message || e);
  return { status: 500, body: { error: 'internal' } };
}

/**
 * Custom connections (universal bring-your-own-API-key) — 5 routes.
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons: requireAuth middleware,
 *   supabaseAdmin client, and the shared connected-tools cache invalidator.
 */
export function registerCustomConnectionsRoutes(app, { requireAuth, supabaseAdmin, invalidateConnectedToolsCache }) {
  app.get('/api/custom-connections', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const connections = await listCustomConnections(supabaseAdmin, userId);
      return res.json({ ok: true, connections });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });

  app.post('/api/custom-connections', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const connection = await createCustomConnection(supabaseAdmin, userId, req.body || {});
      invalidateConnectedToolsCache(userId);
      return res.json({ ok: true, connection });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });

  app.patch('/api/custom-connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const connection = await updateCustomConnection(supabaseAdmin, userId, String(req.params.id || ''), req.body || {});
      if (!connection) return res.status(404).json({ error: 'not_found' });
      invalidateConnectedToolsCache(userId);
      return res.json({ ok: true, connection });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });

  app.delete('/api/custom-connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      await deleteCustomConnection(supabaseAdmin, userId, String(req.params.id || ''));
      invalidateConnectedToolsCache(userId);
      return res.json({ ok: true });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });

  // One-shot test call so the user can verify the credential + base URL work
  // before relying on the agent. Always a GET against the given path (default
  // the base URL itself), so it never triggers a write.
  app.post('/api/custom-connections/:id/test', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });
      const result = await callApp({
        client: supabaseAdmin,
        userId,
        connection: String(req.params.id || ''),
        method: 'GET',
        path: typeof req.body?.path === 'string' ? req.body.path : '',
      });
      return res.json({ ok: true, result });
    } catch (e) {
      const { status, body } = _customConnErr(e);
      return res.status(status).json(body);
    }
  });
}
