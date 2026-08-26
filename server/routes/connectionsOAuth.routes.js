// CONNECTIONS OAUTH FRAMEWORK ROUTES — extracted verbatim from server.js (Wave 5).
//
// 8 routes: OAuth start, GET /oauth/callback/:provider (popup HTML +
// postMessage), connect-info, token-mode connect, connections list, sync,
// patch (pause/resume), delete.
//
// SECURITY-SENSITIVE — moved byte-for-byte, no behavior changes:
// - OAuth state is created/consumed via connectors-service (DB-backed rows,
//   no in-process state Maps) — nothing stateful lives in this module.
// - The /oauth/callback path keeps its exact literal path; the relaxed
//   popup CSP in the bootstrap security-header middleware is path-based
//   (HTML_OAUTH_PATH_RE) and therefore unaffected by the move.
// - The callback postMessage target origin stays pinned to
//   CONNECTOR_FRONTEND_BASE (fail closed on malformed URL).
// - These 8 routes remain the LAST routes registered before the global
//   error handler, at the same registration position.
//
// Dependency notes:
// - requireAuth / supabaseAdmin / PORT are bootstrap-owned, passed via deps.
// - invalidateConnectedToolsCache is a shared server.js prompt-cache
//   invalidator (also passed to the custom-connections router), passed.
// - connectors-service exports are stateless module singletons (ESM cache);
//   server.js keeps importing makeConnectorPoller from the same module for
//   the bootstrap poller.
// - CONNECTOR_FRONTEND_BASE / connectorRedirectUri moved here: this module
//   is their only consumer.
import {
  CONNECTOR_REGISTRY,
  PROVIDER_CREDENTIALS,
  isProviderConfigured,
  envPrefixFor,
  createOAuthState,
  consumeOAuthState,
  saveConnection,
  runSync,
  encryptToken,
} from '../../connectors-service.js';
import { z, validate, validateParams } from '../../validation.js';

export function registerConnectionsOAuthRoutes(app, deps) {
  const { requireAuth, supabaseAdmin, PORT, invalidateConnectedToolsCache } = deps;

  // ============================================
  // CONNECTOR FRAMEWORK (OAuth providers — GitHub, Reddit, Notion, ...)
  // ============================================
  // Generic OAuth start + callback + management routes. Each provider lives
  // in connectors/<id>.js and is registered in connectors-service.js.

  // Where the user's browser is sent after OAuth completes. The popup posts
  // a message to its opener and closes itself; this URL is just the fallback.
  const CONNECTOR_FRONTEND_BASE =
    process.env.FRONTEND_BASE_URL ||
    process.env.FRONTEND_URL ||
    'http://localhost:5173';

  function connectorRedirectUri(provider) {
    // GitHub (and most providers) require the redirect_uri to exactly match
    // what's registered in their developer console. We always send users to
    // the API origin so the server can do the secret-bearing token swap.
    const apiBase =
      process.env.PUBLIC_API_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      `http://localhost:${PORT}`;
    return `${apiBase.replace(/\/$/, '')}/oauth/callback/${provider}`;
  }

  // ── Start OAuth flow ─────────────────────────────────────────────────────────
  // Frontend calls this with auth, we mint a state row and return the URL the
  // browser should be sent to. Frontend opens it in a popup window.
  app.post('/api/connections/:provider/start', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { provider } = req.params;
      const adapter = CONNECTOR_REGISTRY[provider];
      if (!adapter) return res.status(404).json({ error: `Unknown provider "${provider}"` });
      if (!isProviderConfigured(provider)) {
        const prefix = envPrefixFor(provider);
        return res.status(503).json({
          error: `${provider} is not configured. Set ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET on the server.`,
        });
      }

      const redirectAfter = typeof req.body?.redirectAfter === 'string'
        ? req.body.redirectAfter
        : null;

      // Anything else on the body is treated as adapter prefields (e.g.
      // Mastodon's instance URL). Adapters may use them to dynamically
      // register an app on the user's chosen instance before the auth URL
      // is built.
      const prefields = req.body && typeof req.body === 'object'
        ? Object.fromEntries(
            Object.entries(req.body).filter(([k]) => k !== 'redirectAfter'),
          )
        : {};

      // We need the state row created BEFORE we can stash adapter-specific
      // metadata on it, but the adapter might want to influence the
      // metadata (e.g. dynamically-registered per-instance creds). Two-pass:
      //   1. Adapter optionally prepares per-flow context.
      //   2. Persist state row with that context.
      //   3. Adapter builds the auth URL using the persisted state.
      let prepared = null;
      if (typeof adapter.prepareAuth === 'function') {
        prepared = await adapter.prepareAuth({
          prefields,
          env: process.env,
          redirectUri: connectorRedirectUri(provider),
        });
      }

      const { state, codeVerifier } = await createOAuthState({
        supabaseAdmin,
        userId,
        provider,
        redirectAfter,
        pkce: !!adapter.needsPkce,
        metadata: prepared?.stateMetadata || null,
      });

      const creds = PROVIDER_CREDENTIALS[provider] || {};
      // For per-instance providers, prepareAuth supplies clientId/clientSecret
      // dynamically; for static providers those come from PROVIDER_CREDENTIALS.
      const clientId = prepared?.clientId || (creds.clientId ? creds.clientId() : undefined);
      const clientSecret = prepared?.clientSecret || (creds.clientSecret ? creds.clientSecret() : undefined);

      const built = await Promise.resolve(
        adapter.buildAuthUrl({
          clientId,
          clientSecret,
          redirectUri: connectorRedirectUri(provider),
          state,
          codeVerifier,
          prefields,
          stateMetadata: prepared?.stateMetadata || {},
        }),
      );
      const url = typeof built === 'string' ? built : built?.url;
      if (!url) throw new Error('Adapter did not return an auth URL');

      return res.json({ url });
    } catch (err) {
      return res.status(500).json({ error: 'OAuth start failed' });
    }
  });

  // ── OAuth callback ──────────────────────────────────────────────────────────
  // Provider redirects here with ?code=...&state=... . We validate state,
  // exchange the code for tokens, persist the connection, then return a tiny
  // HTML page that messages the opener and closes the popup.
  app.get('/oauth/callback/:provider', async (req, res) => {
    const { provider } = req.params;
    const { code, state, error: oauthError, error_description } = req.query || {};

    // Pin the postMessage target origin to the trusted frontend. Any other
    // origin that opens this popup (a malicious page that calls
    // window.open('https://lykn-ideation.onrender.com/oauth/callback/x'))
    // would otherwise still receive the {type:'lykn:oauth', provider, ok}
    // notification — no secrets in the payload, but a confirmation signal
    // an attacker can use to fingerprint connected providers. Fail closed
    // (skip postMessage) when CONNECTOR_FRONTEND_BASE is malformed rather
    // than broadcasting to '*'.
    let trustedOrigin = null;
    try {
      trustedOrigin = new URL(CONNECTOR_FRONTEND_BASE).origin;
    } catch {
      console.warn(`[connectors] CONNECTOR_FRONTEND_BASE is not a valid URL ("${CONNECTOR_FRONTEND_BASE}") — skipping postMessage (fail closed)`);
    }

    const finishHtml = (title, body, ok = true) => {
      const msgScript = trustedOrigin
        ? `(function(){
    try {
      if (window.opener) {
        window.opener.postMessage(${JSON.stringify({ type: 'lykn:oauth', provider, ok })}, ${JSON.stringify(trustedOrigin)});
      }
    } catch (e) {}
    setTimeout(function(){ try { window.close(); } catch(e){} }, ${ok ? 600 : 2500});
  })();`
        : `(function(){
    setTimeout(function(){ try { window.close(); } catch(e){} }, ${ok ? 600 : 2500});
  })();`;
      return `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;color:#111}
    .card{max-width:380px;padding:24px;border:1px solid #e5e7eb;border-radius:14px;background:white;text-align:center}
    h1{font-size:16px;margin:0 0 6px;font-weight:600}
    p{font-size:13px;color:#555;margin:0;line-height:1.5}
    .ok{color:#059669}.err{color:#b91c1c}
  </style></head><body>
  <div class="card">
    <h1 class="${ok ? 'ok' : 'err'}">${title}</h1>
    <p>${body}</p>
  </div>
  <script>
  ${msgScript}
  </script>
  </body></html>`;
    };

    try {
      if (oauthError) {
        return res
          .status(400)
          .type('html')
          .send(finishHtml('Connection cancelled', String(error_description || oauthError), false));
      }

      const adapter = CONNECTOR_REGISTRY[provider];
      if (!adapter) {
        return res.status(404).type('html').send(finishHtml('Unknown provider', `No adapter for "${provider}".`, false));
      }
      if (!supabaseAdmin) {
        return res.status(503).type('html').send(finishHtml('Database unavailable', 'Try again in a moment.', false));
      }

      // Validate + consume state. If this throws, the request is fraudulent
      // or stale — no token swap happens.
      const stateRow = await consumeOAuthState({ supabaseAdmin, state, provider });
      const stateMetadata = stateRow.metadata || {};

      const creds = PROVIDER_CREDENTIALS[provider] || {};
      // For per-instance providers (Mastodon, etc.) the clientId/secret were
      // registered dynamically during /start and stashed in stateMetadata.
      // Otherwise, fall back to the static PROVIDER_CREDENTIALS table.
      const clientId = stateMetadata.clientId || (creds.clientId ? creds.clientId() : undefined);
      const clientSecret = stateMetadata.clientSecret || (creds.clientSecret ? creds.clientSecret() : undefined);

      const exchanged = await adapter.exchangeCode({
        code: String(code || ''),
        clientId,
        clientSecret,
        redirectUri: connectorRedirectUri(provider),
        codeVerifier: stateRow.code_verifier,
        query: req.query,
        stateMetadata,
      });

      const connection = await saveConnection({
        supabaseAdmin,
        userId: stateRow.user_id,
        provider,
        exchanged,
      });

      // New OAuth means the [CONNECTED_TOOLS] section the chat AI sees
      // is now stale — drop the cache so the user's next chat turn picks
      // up the freshly connected tool.
      invalidateConnectedToolsCache(stateRow.user_id);

      // Kick off the first sync immediately. Don't block the popup close
      // waiting for it — the user can refresh manually if they're impatient.
      // Synthesize a runSync-shaped row using the already-encrypted blobs
      // saveConnection just wrote, so we don't pay an extra DB round trip.
      runSync({
        supabaseAdmin,
        connection: {
          ...connection,
          user_id: stateRow.user_id,
          access_token: encryptToken(exchanged.accessToken),
          refresh_token: exchanged.refreshToken
            ? encryptToken(exchanged.refreshToken)
            : null,
          metadata: exchanged.metadata || {},
        },
      }).catch((e) =>
        console.error(`[connectors] initial sync failed for ${provider}:`, e.message),
      );

      return res
        .type('html')
        .send(finishHtml(`Connected to ${provider}`, 'You can close this window.', true));
    } catch (err) {
      console.error(`[connectors] callback error (${provider}):`, err.message);
      return res
        .status(400)
        .type('html')
        .send(finishHtml('Connection failed', err.message || 'Unknown error', false));
    }
  });

  // ── Per-provider dynamic connect info (e.g. Trello's pre-filled authorize URL)
  // Some token-paste providers need a help URL that embeds a server-side
  // credential the frontend can't see (Trello's API key, etc.). Adapters
  // expose this via an optional `connectInfo({ env })` method that returns
  // `{ tokenHelpUrl?, tokenHelpLabel?, message? }`.
  app.get('/api/connections/:provider/connect-info', requireAuth, async (req, res) => {
    try {
      const { provider } = req.params;
      const adapter = CONNECTOR_REGISTRY[provider];
      if (!adapter) return res.status(404).json({ error: `Unknown provider "${provider}"` });
      if (typeof adapter.connectInfo !== 'function') {
        return res.json({}); // Nothing extra; the catalog already has everything
      }
      const info = await adapter.connectInfo({ env: process.env });
      return res.json(info || {});
    } catch (err) {
      return res.status(500).json({ error: 'connect-info failed' });
    }
  });

  // ── Token-mode connect (Readwise, Matter, Bluesky app-password, etc.) ──────
  // Some providers don't do OAuth at all — the user pastes a long-lived API
  // token (or handle + app password). The frontend POSTs the field values
  // here; the adapter validates them, returns a connection-ready object, and
  // we persist it through the same saveConnection path the OAuth flow uses.
  //
  // SECURITY (Agent 04):
  //   • req.params.provider is validated against the CONNECTOR_REGISTRY key
  //     allowlist BEFORE the handler runs. The previous code allowed any
  //     string into the registry lookup; while a non-key returns 404, the
  //     allowlist forces the rejection at the perimeter (one less surface
  //     for path-traversal-style abuse if a future adapter dispatcher adds
  //     filesystem or shell behavior to the lookup path).
  //   • The body is loosely typed — different adapters accept different
  //     credential shapes (Bluesky wants handle+appPassword, Readwise wants
  //     a token, etc.) — but the value-coercion happens inside each adapter.
  //     We cap the JSON body at 4kb here as DiD against an oversized paste.
  const connectorProviderParamSchema = z.object({
    provider: z.enum(Object.keys(CONNECTOR_REGISTRY)),
  });
  // Field shape varies by adapter — accept a flat object of strings and
  // length-cap each value. Unknown adapter-specific keys are intentionally
  // allowed (different adapters consume different field names) but each
  // value is capped to 4096 chars (a realistic ceiling for any pasted
  // token / app-password / instance URL combo we'd ever see).
  const connectorTokenBodySchema = z.record(
    z.string().max(4096),
  ).refine((v) => Object.keys(v).length <= 16, {
    message: 'Too many fields',
  });

  app.post(
    '/api/connections/:provider/connect-token',
    requireAuth,
    validateParams(connectorProviderParamSchema),
    validate(connectorTokenBodySchema),
    async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { provider } = req.params;
      const adapter = CONNECTOR_REGISTRY[provider];
      // adapter is guaranteed non-null by validateParams above, but keep the
      // mode check — it's adapter-shape, not provider-existence.
      if (adapter.authMode !== 'token' || typeof adapter.connectWithToken !== 'function') {
        return res.status(400).json({ error: `${provider} does not support token-paste connection.` });
      }

      const fields = req.body;
      const exchanged = await adapter.connectWithToken({ fields });
      if (!exchanged?.accessToken) {
        return res.status(400).json({ error: 'Adapter did not return a credential.' });
      }

      const connection = await saveConnection({
        supabaseAdmin,
        userId,
        provider,
        exchanged,
      });

      // Same reason as the OAuth callback — drop the connected-tools
      // section cache so chat picks it up on the next turn.
      invalidateConnectedToolsCache(userId);

      // Kick off the first sync immediately, same as the OAuth callback path.
      runSync({
        supabaseAdmin,
        connection: {
          ...connection,
          user_id: userId,
          access_token: encryptToken(exchanged.accessToken),
          refresh_token: exchanged.refreshToken
            ? encryptToken(exchanged.refreshToken)
            : null,
          metadata: exchanged.metadata || {},
        },
      }).catch((e) =>
        console.error(`[connectors] initial sync failed for ${provider}:`, e.message),
      );

      return res.json({ connection });
    } catch (err) {
      // Log the real cause server-side (this block previously swallowed it,
      // making token-connect failures impossible to diagnose). Surface the
      // adapter's own message to the client when it's a short, user-facing
      // string (e.g. "Cursor rejected this API key…") so the dialog can show
      // something actionable instead of a generic "trouble connecting".
      console.error(
        `[connectors] connect-token failed for ${req.params?.provider}:`,
        err?.stack || err?.message || err,
      );
      // Only surface messages the adapter explicitly marked user-facing
      // (ConnectorAuthError / isUserFacing) — e.g. "Cursor rejected this API
      // key…". Anything else (DB/Postgres internals, unexpected throws) stays
      // generic so we don't leak internals into the UI.
      const raw = typeof err?.message === 'string' ? err.message.trim() : '';
      const userFacing = Boolean(err?.isAuthError || err?.isUserFacing);
      const safe = userFacing && raw && raw.length <= 300 ? raw : 'Connect failed';
      return res.status(400).json({ error: safe });
    }
    },
  );

  // ── List user's connections ─────────────────────────────────────────────────
  app.get('/api/connections', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { data, error } = await supabaseAdmin
        .from('social_connections')
        .select(
          'id, provider, provider_user_id, account_handle, account_display_name, ' +
          'account_email, account_avatar_url, scopes, status, ' +
          'last_synced_at, last_sync_count, total_synced_count, ' +
          'consecutive_errors, last_error, sync_interval_minutes, ' +
          'metadata, created_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) { console.error('[supabase]', req.method, req.path, error); return res.status(500).json({ error: 'database_error' }); }

      // Annotate with provider configuration so the UI can show "set up
      // pending" for providers without env vars.
      const providerConfig = {};
      for (const id of Object.keys(CONNECTOR_REGISTRY)) {
        providerConfig[id] = isProviderConfigured(id);
      }

      return res.json({ connections: data || [], providerConfig });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to list connections' });
    }
  });

  // ── Trigger a sync now ──────────────────────────────────────────────────────
  app.post('/api/connections/:id/sync', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { id } = req.params;
      const { data: connection, error } = await supabaseAdmin
        .from('social_connections')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();
      if (error || !connection) return res.status(404).json({ error: 'Connection not found' });

      const result = await runSync({ supabaseAdmin, connection });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Sync failed' });
    }
  });

  // ── Update (pause / resume) ─────────────────────────────────────────────────
  // SECURITY (Agent 04): Zod schema with unknown-field stripping. Same
  // shape pattern as /api/feeds/:id PATCH for consistency.
  const patchConnectionSchema = z.object({
    status: z.enum(['active', 'paused']).optional(),
    sync_interval_minutes: z.number().int().min(5).max(1440).optional(),
  }).refine(
    (v) => v.status !== undefined || v.sync_interval_minutes !== undefined,
    { message: 'Nothing to update' },
  );

  app.patch('/api/connections/:id', requireAuth, validate(patchConnectionSchema), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { id } = req.params;
      const allowed = {};
      if (req.body.status !== undefined) allowed.status = req.body.status;
      if (req.body.sync_interval_minutes !== undefined) {
        allowed.sync_interval_minutes = req.body.sync_interval_minutes;
      }

      const { data, error } = await supabaseAdmin
        .from('social_connections')
        .update(allowed)
        .eq('id', id)
        .eq('user_id', userId)
        .select(
          'id, provider, provider_user_id, account_handle, account_display_name, ' +
          'account_avatar_url, scopes, status, last_synced_at, last_sync_count, ' +
          'total_synced_count, sync_interval_minutes, created_at',
        )
        .single();
      if (error) { console.error('[supabase]', req.method, req.path, error); return res.status(500).json({ error: 'database_error' }); }
      if (!data) return res.status(404).json({ error: 'Connection not found' });
      // Status flips between active/paused change whether the tool
      // shows the "[paused]" tag in [CONNECTED_TOOLS]. Drop the cache.
      invalidateConnectedToolsCache(userId);
      return res.json({ connection: data });
    } catch (err) {
      return res.status(500).json({ error: 'Update failed' });
    }
  });

  // ── Disconnect ──────────────────────────────────────────────────────────────
  app.delete('/api/connections/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { id } = req.params;
      // We don't bother revoking the token at the provider here; the user
      // can do that from the provider's own UI if they want. Most providers
      // don't even offer a clean revoke endpoint without re-auth.
      const { error } = await supabaseAdmin
        .from('social_connections')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);
      if (error) { console.error('[supabase]', req.method, req.path, error); return res.status(500).json({ error: 'database_error' }); }
      // Tool removed — drop the cache so the chat AI stops suggesting it.
      invalidateConnectedToolsCache(userId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Delete failed' });
    }
  });
}
