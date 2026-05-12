// ============================================
// LYKN OAuth 2.1 Authorization Server
// ============================================
// LYKN exposed as an OAuth identity provider so external apps can run
// "Connect LYKN" flows instead of asking users to paste a personal-
// access token. The endpoints implemented here let ChatGPT Connectors,
// Cursor's "Custom MCP via OAuth", a future LYKN GPT in the GPT Store,
// and a browser extension all light up with a single hosted login.
//
// Spec scope (v1):
//   • OAuth 2.1 (RFC 6749 + the 2.1 consolidated draft) with PKCE-only
//   • RFC 7591   — Dynamic Client Registration
//   • RFC 8414   — Authorization Server Metadata (.well-known)
//   • RFC 9728   — Protected Resource Metadata (.well-known)
//   • RFC 7009   — Token Revocation
//   • RFC 7662   — Token Introspection
//
// Out of scope for v1 (deliberately, to ship faster):
//   • OIDC `id_token` (no RS256 key management yet — ChatGPT's
//     Connectors / Cursor's MCP-OAuth flow don't require it).
//   • Token exchange (RFC 8693), device flow (RFC 8628), JAR/PAR.
//   • client_secret_post / client_secret_jwt / private_key_jwt auth.
//
// The access token issued at the end of the flow IS a row in
// lykn_mcp_tokens — same hash-only storage, same `lkn_live_<…>` shape,
// same /mcp middleware. The only difference vs. a personal-access
// token is that oauth_client_id + oauth_consent_id are populated.
// This means /mcp doesn't have to learn anything new — the token
// validates exactly as today.
//
// Mount with:
//   import { mountOauthServer } from './oauth-server.js';
//   mountOauthServer(app, { supabaseAdmin, requireAuth, getPublicBaseUrl, getFrontendBaseUrl });
//
// `getPublicBaseUrl()` should return the externally-visible HTTPS
// origin of the LYKN API (e.g. https://lykn.io). `getFrontendBaseUrl()`
// returns the SPA origin (e.g. https://lykn.io if same-origin, else
// http://localhost:5173 in dev). Used to build the /oauth/consent
// redirect that hands the user from the API to the consent UI.

import crypto from 'crypto';
import express from 'express';
import { createMcpToken } from './mcp-service.js';

// OAuth spec endpoints accept application/x-www-form-urlencoded bodies
// (RFC 6749 §3.2 / §4.1.3 / RFC 7009 §2.1 / RFC 7662 §2.1). server.js
// only mounts express.json() globally, so we install a per-route
// urlencoded parser on the OAuth endpoints that need it. extended:false
// keeps it standards-compliant — OAuth bodies are flat key=value pairs,
// no nested objects.
//
// We accept BOTH JSON and urlencoded on these routes (some clients —
// our own probe script being one — sometimes pick JSON). The urlencoded
// parser is a no-op when the Content-Type is application/json (Express
// already populated req.body via the global JSON parser).
const oauthBodyParser = express.urlencoded({ extended: false, limit: '64kb' });

// ---------------------------------------------------------------------------
// Constants — surfaced via /.well-known/oauth-authorization-server
// ---------------------------------------------------------------------------
// These mirror the schema choices encoded in
// supabase-migrations/050_lykn_oauth_provider.sql. Change one, update the
// other.

const SUPPORTED_SCOPES = ['lykn:read', 'lykn:write', 'offline_access'];
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const SUPPORTED_RESPONSE_TYPES = ['code'];
const SUPPORTED_CODE_CHALLENGE_METHODS = ['S256'];
const SUPPORTED_TOKEN_AUTH_METHODS = ['none', 'client_secret_basic'];

// Token lifetimes
const ACCESS_TOKEN_TTL_SEC = 60 * 60;          // 1h — refreshable
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30d
const AUTH_CODE_TTL_SEC = 60;                   // 60s

// Limits — keep DCR cheap to host. Anonymous registration is open by
// design (consumer onboarding) but obvious abuse needs a ceiling.
const MAX_REDIRECT_URIS = 16;
const MAX_REDIRECT_URI_LEN = 2048;
const MAX_CLIENT_NAME_LEN = 200;
const MAX_REGISTRATIONS_PER_IP_PER_HOUR = 30;

// In-memory IP rate limit for /oauth/register. Tiny and per-process —
// fine for DCR which is a low-volume endpoint. If we ever scale to
// many instances we'd swap this for a Redis token bucket.
const _registerIpHits = new Map();

// ---------------------------------------------------------------------------
// mountOauthServer — wire all OAuth routes onto an Express app
// ---------------------------------------------------------------------------
/**
 * @param {import('express').Express} app
 * @param {{
 *   supabaseAdmin: import('@supabase/supabase-js').SupabaseClient,
 *   requireAuth: import('express').RequestHandler,
 *   getPublicBaseUrl: () => string,
 *   getFrontendBaseUrl: () => string,
 * }} deps
 */
export function mountOauthServer(app, deps) {
  const { supabaseAdmin, requireAuth, getPublicBaseUrl, getFrontendBaseUrl } = deps;

  // ── Discovery: Authorization Server Metadata (RFC 8414) ─────────────────
  //
  // The single document ChatGPT Connectors / Cursor / Claude / any
  // future MCP-OAuth client fetch FIRST. They use it to learn:
  //   1. Where to register a client (registration_endpoint)
  //   2. Where to send the user for consent (authorization_endpoint)
  //   3. Where to exchange the code for a token (token_endpoint)
  //   4. What grant types / PKCE methods / scopes we support
  //
  // The key insight: nothing in the client's config knows our route
  // shape. They derive it all from this doc. So adding this one route
  // first lets us iterate the rest of the routes without re-coordinating
  // with every client.
  //
  // Cached at the edge for 5 min — these values are quasi-static and a
  // client refetching every 5 min is fine.
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const issuer = getPublicBaseUrl().replace(/\/$/, '');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(buildAuthServerMetadata(issuer));
  });

  // ── Discovery: Protected Resource Metadata (RFC 9728) ───────────────────
  //
  // Mounted at the resource path's well-known sibling. The MCP spec
  // (2025-06-18 draft) tells clients that hit a 401 from /mcp to look
  // here to learn which authorization servers can issue tokens for it.
  //
  // The pattern per RFC 9728 §3.1 is:
  //   /.well-known/oauth-protected-resource[/<resource-path>]
  //
  // We expose one for the bare /mcp endpoint. The doc points back at
  // ourselves (issuer) so a 401 → discovery → register → authorize
  // dance can complete with zero out-of-band coordination.
  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const base = getPublicBaseUrl().replace(/\/$/, '');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(buildProtectedResourceMetadata({ base, resourcePath: '/mcp' }));
  });

  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    const base = getPublicBaseUrl().replace(/\/$/, '');
    res.set('Cache-Control', 'public, max-age=300');
    res.json(buildProtectedResourceMetadata({ base, resourcePath: '/mcp' }));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /oauth/register — Dynamic Client Registration (RFC 7591)
  // ─────────────────────────────────────────────────────────────────────────
  //
  // ChatGPT Connectors, Cursor's MCP-OAuth flow, and any other RFC 7591
  // client POST a JSON body here describing themselves. We mint a
  // client_id (and a client_secret if they ask to be confidential),
  // persist the registration, and echo the full client metadata back per
  // the spec.
  //
  // This endpoint is INTENTIONALLY UNAUTHENTICATED. The whole point of
  // DCR is that a brand-new client app, with no prior coordination,
  // can self-register before its user ever sees a consent screen. The
  // attack surface is mitigated by:
  //   • Per-IP rate limiting (30/hr) — stops registration floods.
  //   • Strict redirect_uri validation — only https:// URIs (or
  //     http://localhost for dev), max 16 per client.
  //   • The client_id alone grants nothing; the user still has to
  //     log in and approve at /oauth/authorize.
  app.post('/oauth/register', oauthBodyParser, async (req, res) => {
    // Capture caller fingerprint up front so every rejection path can log
    // a consistent line. Perplexity (and any other DCR client) only
    // surfaces "no client_id returned" — it never tells the user which
    // validation we tripped. Without these logs the failure is opaque.
    const reqUA = String(req.headers['user-agent'] || '').slice(0, 200);
    const reqIp = req.ip || '';
    const safeBodyForLog = redactDcrBodyForLog(req.body);
    const logReject = (status, errCode, desc) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[oauth/register] reject ${status} ${errCode}: ${desc} ` +
          `ip=${reqIp} ua="${reqUA}" body=${JSON.stringify(safeBodyForLog)}`,
      );
    };

    try {
      // Rate limit by client IP. Express puts the resolved IP in req.ip
      // when trust-proxy is set on the app (server.js does that).
      if (!checkRegisterRateLimit(req.ip)) {
        logReject(429, 'too_many_requests', 'per-IP DCR cap hit');
        return res.status(429).json({
          error: 'too_many_requests',
          error_description: 'Registration rate limit exceeded — try again in an hour.',
        });
      }

      if (!supabaseAdmin) {
        logReject(503, 'temporarily_unavailable', 'supabaseAdmin not configured');
        return res.status(503).json({
          error: 'temporarily_unavailable',
          error_description: 'OAuth provider not configured on the server.',
        });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};

      // ── redirect_uris — required by spec, validated strictly ─────────
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      const redirectErr = validateRedirectUris(redirectUris);
      if (redirectErr) {
        logReject(400, 'invalid_redirect_uri', redirectErr);
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: redirectErr });
      }

      // ── client metadata — sanitised, capped, otherwise pass-through ──
      const clientName = sanitizeText(body.client_name, MAX_CLIENT_NAME_LEN) || 'Unnamed OAuth client';
      const clientUri = sanitizeUri(body.client_uri);
      const logoUri = sanitizeUri(body.logo_uri);
      const tosUri = sanitizeUri(body.tos_uri);
      const policyUri = sanitizeUri(body.policy_uri);
      const softwareId = sanitizeText(body.software_id, 200);
      const softwareVersion = sanitizeText(body.software_version, 80);

      // ── grant/response types — must be subset of what we support ─────
      const grantTypes = pickSubset(
        body.grant_types,
        SUPPORTED_GRANT_TYPES,
        ['authorization_code'],
      );
      const responseTypes = pickSubset(
        body.response_types,
        SUPPORTED_RESPONSE_TYPES,
        ['code'],
      );
      // authorization_code grant is required to start a flow; refresh
      // is optional but ALL major clients ask for it.
      if (!grantTypes.includes('authorization_code')) {
        logReject(400, 'invalid_client_metadata', 'authorization_code grant missing');
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'authorization_code grant is required.',
        });
      }

      // ── scope — intersect requested with supported ───────────────────
      const requestedScopeStr = typeof body.scope === 'string' ? body.scope : 'lykn:read offline_access';
      const scope = filterScopes(requestedScopeStr).join(' ') || 'lykn:read';

      // ── auth method — default 'none' (public client + PKCE) ──────────
      const authMethodRaw = String(body.token_endpoint_auth_method || 'none').toLowerCase();
      const tokenEndpointAuthMethod = SUPPORTED_TOKEN_AUTH_METHODS.includes(authMethodRaw)
        ? authMethodRaw
        : 'none';

      // ── mint client_id (+ secret if confidential) ────────────────────
      const clientIdPlain = `lkn_client_${randomToken(18)}`;
      let clientSecretPlain = null;
      let clientSecretHash = null;
      if (tokenEndpointAuthMethod === 'client_secret_basic') {
        clientSecretPlain = `lkn_csec_${randomToken(32)}`;
        clientSecretHash = sha256(clientSecretPlain);
      }

      const insertRow = {
        client_id: clientIdPlain,
        client_secret_hash: clientSecretHash,
        client_name: clientName,
        client_uri: clientUri,
        logo_uri: logoUri,
        tos_uri: tosUri,
        policy_uri: policyUri,
        software_id: softwareId,
        software_version: softwareVersion,
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        response_types: responseTypes,
        token_endpoint_auth_method: tokenEndpointAuthMethod,
        scope,
        status: 'active',
        registration_ip: req.ip || null,
        registration_user_agent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
      };

      const { data, error } = await supabaseAdmin
        .from('lykn_oauth_clients')
        .insert(insertRow)
        .select('client_id, created_at')
        .single();
      if (error) {
        console.error(
          `[oauth/register] insert failed: ${error.message} ` +
            `ip=${reqIp} ua="${reqUA}" body=${JSON.stringify(safeBodyForLog)}`,
        );
        return res.status(500).json({ error: 'server_error', error_description: 'Could not register client.' });
      }

      // Success — surface a single line per registered client so we can
      // correlate later /authorize / /token failures back to a DCR row.
      // eslint-disable-next-line no-console
      console.log(
        `[oauth/register] ok client_id=${data.client_id} name="${clientName}" ` +
          `auth=${tokenEndpointAuthMethod} scope="${scope}" ` +
          `redirects=${JSON.stringify(redirectUris)} ip=${reqIp} ua="${reqUA}"`,
      );

      // RFC 7591 §3.2.1 response. `client_secret_expires_at: 0` means
      // never expires (we don't rotate secrets in v1). `client_id_issued_at`
      // is unix seconds.
      return res.status(201).json({
        client_id: data.client_id,
        client_secret: clientSecretPlain || undefined,
        client_id_issued_at: Math.floor(new Date(data.created_at).getTime() / 1000),
        client_secret_expires_at: clientSecretPlain ? 0 : undefined,
        // Echo back the registered metadata so the client can confirm
        // we accepted what it sent (and see any defaults we filled in).
        client_name: clientName,
        client_uri: clientUri || undefined,
        logo_uri: logoUri || undefined,
        tos_uri: tosUri || undefined,
        policy_uri: policyUri || undefined,
        software_id: softwareId || undefined,
        software_version: softwareVersion || undefined,
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        response_types: responseTypes,
        token_endpoint_auth_method: tokenEndpointAuthMethod,
        scope,
      });
    } catch (err) {
      console.error('[oauth/register] threw:', err?.message || err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /oauth/authorize — start of the user-facing flow
  // ─────────────────────────────────────────────────────────────────────────
  //
  // The client redirects the user's browser here with the standard
  // OAuth params + PKCE challenge. Instead of trying to render an HTML
  // consent screen from this Node process (the SPA lives at a separate
  // origin and uses Supabase auth), we VALIDATE EVERYTHING SYNCHRONOUSLY
  // and then 302 to the SPA route /oauth/consent with the params packed
  // into the URL. The SPA reads them, resolves the user via Supabase
  // (already-logged-in path), shows the approve/deny UI, and POSTs the
  // user's decision back to /oauth/authorize/decide.
  //
  // This split is essential for two reasons:
  //   1. We can't read the Supabase session from the API process — it
  //      lives in browser localStorage and only the SPA can decrypt it.
  //   2. The SPA's design system (dialogs, buttons, brand) is reused,
  //      so the consent screen feels like the rest of LYKN, not a 1998
  //      server-rendered Express page.
  //
  // If validation fails BEFORE we know the redirect_uri is trusted,
  // we render a plain error page (per RFC 6749 §3.1.2.4 — never bounce
  // the user to an unverified redirect). Once the redirect_uri is
  // confirmed to match the registered client, errors get redirected
  // back per spec.
  app.get('/oauth/authorize', async (req, res) => {
    try {
      if (!supabaseAdmin) {
        return res.status(503).type('text/plain').send('OAuth provider not configured.');
      }

      const params = req.query || {};
      const clientId = String(params.client_id || '');
      const redirectUri = String(params.redirect_uri || '');
      const responseType = String(params.response_type || '');
      const scope = String(params.scope || 'lykn:read');
      const state = typeof params.state === 'string' ? params.state : '';
      const codeChallenge = String(params.code_challenge || '');
      const codeChallengeMethod = String(params.code_challenge_method || '').toUpperCase();

      // ── Bare-minimum param presence ──────────────────────────────────
      if (!clientId || !redirectUri) {
        return renderAuthError(res, 'invalid_request', 'client_id and redirect_uri are required.');
      }

      // ── Look up the client ──────────────────────────────────────────
      const { data: client, error: clientErr } = await supabaseAdmin
        .from('lykn_oauth_clients')
        .select('client_id, client_name, redirect_uris, scope, status, grant_types, response_types')
        .eq('client_id', clientId)
        .maybeSingle();
      if (clientErr || !client) {
        return renderAuthError(res, 'invalid_client', 'Unknown client_id.');
      }
      if (client.status !== 'active') {
        return renderAuthError(res, 'unauthorized_client', `Client is ${client.status}.`);
      }

      // ── redirect_uri must EXACTLY match a registered URI (RFC 6749 §3.1.2) ──
      const registeredRedirects = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
      if (!registeredRedirects.includes(redirectUri)) {
        return renderAuthError(res, 'invalid_redirect_uri', 'redirect_uri does not match a registered URI.');
      }

      // From here on the redirect_uri is trusted, so spec errors get
      // bounced back via 302 (per RFC 6749 §4.1.2.1).
      const bounce = (errCode, desc) => {
        const url = appendQuery(redirectUri, {
          error: errCode,
          error_description: desc,
          state: state || undefined,
        });
        return res.redirect(302, url);
      };

      // ── response_type — code only ────────────────────────────────────
      if (responseType !== 'code') {
        return bounce('unsupported_response_type', 'Only response_type=code is supported.');
      }
      if (!Array.isArray(client.response_types) || !client.response_types.includes('code')) {
        return bounce('unauthorized_client', 'Client is not authorized for response_type=code.');
      }

      // ── PKCE — required, S256 only ──────────────────────────────────
      if (!codeChallenge || !codeChallengeMethod) {
        return bounce('invalid_request', 'PKCE code_challenge + code_challenge_method are required.');
      }
      if (codeChallengeMethod !== 'S256') {
        return bounce('invalid_request', 'Only code_challenge_method=S256 is supported.');
      }
      if (codeChallenge.length < 43 || codeChallenge.length > 128) {
        return bounce('invalid_request', 'code_challenge must be 43–128 chars (base64url SHA-256 of verifier).');
      }

      // ── scope — intersect requested with client's registered scope ──
      const allowedScopes = String(client.scope || '').split(/\s+/).filter(Boolean);
      const requestedScopes = filterScopes(scope);
      const grantableScopes = requestedScopes.filter((s) => allowedScopes.includes(s));
      if (grantableScopes.length === 0) {
        return bounce('invalid_scope', 'No requested scope is registered to this client.');
      }

      // ── Hand off to the SPA consent page ─────────────────────────────
      // We pack everything the SPA needs into the URL — including the
      // PKCE challenge, which doesn't need to be hidden (it's a hash).
      // The SPA POSTs back to /oauth/authorize/decide with the user's
      // decision; that endpoint re-validates everything from scratch
      // (no trust in the URL round-trip).
      const consentUrl = appendQuery(`${getFrontendBaseUrl().replace(/\/$/, '')}/oauth/consent`, {
        client_id: clientId,
        client_name: client.client_name,
        redirect_uri: redirectUri,
        scope: grantableScopes.join(' '),
        state: state || undefined,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
      });
      return res.redirect(302, consentUrl);
    } catch (err) {
      console.error('[oauth/authorize] threw:', err?.message || err);
      return renderAuthError(res, 'server_error', 'Authorization request failed.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /oauth/authorize/decide — the consent UI's submit target
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Called by the SPA's /oauth/consent page. The user is authenticated
  // via the standard requireAuth (Supabase JWT in the Authorization
  // header). Body shape:
  //   {
  //     client_id, redirect_uri, scope, state, code_challenge,
  //     code_challenge_method,
  //     decision: 'approve' | 'deny',
  //   }
  //
  // On approve: UPSERT the consent row, mint a single-use auth code,
  // return { ok: true, redirect_to } with the code+state appended to
  // the redirect_uri. The SPA then `window.location = redirect_to`.
  // On deny: return { ok: true, redirect_to } pointing at redirect_uri
  // with `error=access_denied`. The flow ends cleanly.
  //
  // We DO NOT issue the code via a 302 from this endpoint because the
  // SPA needs to read JSON to handle errors and show feedback. The
  // browser navigation happens on the SPA side after this returns.
  app.post('/oauth/authorize/decide', oauthBodyParser, requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'temporarily_unavailable' });

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const clientId = String(body.client_id || '');
      const redirectUri = String(body.redirect_uri || '');
      const scopeStr = String(body.scope || 'lykn:read');
      const state = typeof body.state === 'string' ? body.state : '';
      const codeChallenge = String(body.code_challenge || '');
      const codeChallengeMethod = String(body.code_challenge_method || '').toUpperCase();
      const decision = String(body.decision || '').toLowerCase();

      if (!clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
        return res.status(400).json({ error: 'invalid_request' });
      }
      if (!['approve', 'deny'].includes(decision)) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'decision must be approve or deny.' });
      }

      // Re-validate client + redirect_uri (don't trust the URL round-trip).
      const { data: client, error: clientErr } = await supabaseAdmin
        .from('lykn_oauth_clients')
        .select('client_id, client_name, redirect_uris, scope, status')
        .eq('client_id', clientId)
        .maybeSingle();
      if (clientErr || !client || client.status !== 'active') {
        return res.status(400).json({ error: 'invalid_client' });
      }
      const registered = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
      if (!registered.includes(redirectUri)) {
        return res.status(400).json({ error: 'invalid_redirect_uri' });
      }

      // Filter scopes against the client's registered set.
      const allowedScopes = String(client.scope || '').split(/\s+/).filter(Boolean);
      const grantedScopes = filterScopes(scopeStr).filter((s) => allowedScopes.includes(s));
      if (grantedScopes.length === 0) {
        return res.status(400).json({ error: 'invalid_scope' });
      }

      // Deny path: don't write any state, just bounce the user back with
      // access_denied. The client treats this as a clean cancel.
      if (decision === 'deny') {
        const redirectTo = appendQuery(redirectUri, {
          error: 'access_denied',
          error_description: 'User denied the request.',
          state: state || undefined,
        });
        return res.json({ ok: true, redirect_to: redirectTo });
      }

      // Approve path. UPSERT the consent (so re-grants update scopes /
      // un-revoke), then mint a single-use code bound to (user, client,
      // consent, redirect_uri, PKCE challenge).
      const { data: consent, error: consentErr } = await supabaseAdmin
        .from('lykn_oauth_consents')
        .upsert(
          {
            user_id: userId,
            client_id: clientId,
            scopes: grantedScopes,
            label: client.client_name || 'Connected app',
            granted_at: new Date().toISOString(),
            revoked_at: null,
          },
          { onConflict: 'user_id,client_id' },
        )
        .select('id, scopes')
        .single();
      if (consentErr || !consent) {
        console.error('[oauth/decide] consent upsert failed:', consentErr?.message);
        return res.status(500).json({ error: 'server_error' });
      }

      const codePlain = `lkn_code_${randomToken(32)}`;
      const codeHash = sha256(codePlain);
      const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000).toISOString();

      const { error: codeErr } = await supabaseAdmin
        .from('lykn_oauth_authorization_codes')
        .insert({
          code_hash: codeHash,
          client_id: clientId,
          user_id: userId,
          consent_id: consent.id,
          redirect_uri: redirectUri,
          scope: grantedScopes.join(' '),
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          state: state || null,
          expires_at: expiresAt,
        });
      if (codeErr) {
        console.error('[oauth/decide] code insert failed:', codeErr.message);
        return res.status(500).json({ error: 'server_error' });
      }

      const redirectTo = appendQuery(redirectUri, {
        code: codePlain,
        state: state || undefined,
      });
      return res.json({ ok: true, redirect_to: redirectTo });
    } catch (err) {
      console.error('[oauth/decide] threw:', err?.message || err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /oauth/token — the only token-minting endpoint
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Two grant types:
  //   • authorization_code — exchange the single-use code from
  //     /oauth/authorize for an access+refresh token pair. PKCE
  //     verifier required. Mints a row in lykn_mcp_tokens with
  //     oauth_client_id + oauth_consent_id populated, plus a sibling
  //     row in lykn_oauth_refresh_tokens.
  //   • refresh_token — exchange a non-consumed refresh token for a
  //     fresh pair. Rotates the refresh token (consumed_at + replaced_by);
  //     redemption of an already-consumed token revokes the whole
  //     family per RFC 6749 §10.4.
  //
  // Form-encoded body per OAuth 2.1; we read either application/x-www-
  // form-urlencoded (default) or JSON (some clients prefer it).
  app.post('/oauth/token', oauthBodyParser, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'temporarily_unavailable' });

      // Spec: "no-store" on token responses. Belt-and-suspenders against
      // a misconfigured CDN caching access tokens.
      res.set('Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const grantType = String(body.grant_type || '');

      // Resolve client identity (from Authorization: Basic OR from body).
      const clientAuth = await resolveClientAuth(supabaseAdmin, req, body);
      if (!clientAuth.ok) {
        return res.status(401).json({ error: clientAuth.error, error_description: clientAuth.error_description });
      }
      const client = clientAuth.client;

      if (grantType === 'authorization_code') {
        return await handleAuthorizationCodeGrant({
          req, res, body, client, supabaseAdmin, getPublicBaseUrl,
        });
      }
      if (grantType === 'refresh_token') {
        return await handleRefreshTokenGrant({
          req, res, body, client, supabaseAdmin,
        });
      }
      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: `grant_type must be one of: ${SUPPORTED_GRANT_TYPES.join(', ')}.`,
      });
    } catch (err) {
      console.error('[oauth/token] threw:', err?.message || err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /oauth/revoke — RFC 7009 token revocation
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Clients call this when the user disconnects from their side. We
  // accept either an access token or a refresh token; both make the
  // pair unusable. Spec says: ALWAYS return 200 even if the token
  // doesn't exist, to avoid leaking which tokens are valid (timing /
  // existence side-channel).
  app.post('/oauth/revoke', oauthBodyParser, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(200).end();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const tokenStr = String(body.token || '');
      if (!tokenStr) return res.status(200).end();

      // Optional client auth — if the client claims an identity we
      // verify it (so a malicious party can't revoke another app's
      // tokens). If they don't claim, we still revoke (the token
      // itself is the proof).
      const clientAuth = await resolveClientAuth(supabaseAdmin, req, body);
      const expectedClientId = clientAuth.ok ? clientAuth.client.client_id : null;

      const tokenHash = sha256(tokenStr);

      // Try as access token first. lykn_mcp_tokens stores the hash.
      const { data: accessRow } = await supabaseAdmin
        .from('lykn_mcp_tokens')
        .select('id, oauth_client_id')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (accessRow) {
        if (expectedClientId && accessRow.oauth_client_id && accessRow.oauth_client_id !== expectedClientId) {
          return res.status(200).end();
        }
        await supabaseAdmin
          .from('lykn_mcp_tokens')
          .update({ status: 'revoked', revoked_at: new Date().toISOString() })
          .eq('id', accessRow.id);
        return res.status(200).end();
      }

      // Try as refresh token. Revoking a refresh also nukes the
      // associated access token via FK ON DELETE CASCADE.
      const { data: refreshRow } = await supabaseAdmin
        .from('lykn_oauth_refresh_tokens')
        .select('id, client_id, access_token_id')
        .eq('refresh_hash', tokenHash)
        .maybeSingle();
      if (refreshRow) {
        if (expectedClientId && refreshRow.client_id && refreshRow.client_id !== expectedClientId) {
          return res.status(200).end();
        }
        // Mark the refresh token consumed and nuke the access token (if
        // any). Using two updates keeps it correct even if access_token_id
        // is null (corner case: refresh issued but access already revoked).
        await supabaseAdmin
          .from('lykn_oauth_refresh_tokens')
          .update({ consumed_at: new Date().toISOString() })
          .eq('id', refreshRow.id);
        if (refreshRow.access_token_id) {
          await supabaseAdmin
            .from('lykn_mcp_tokens')
            .update({ status: 'revoked', revoked_at: new Date().toISOString() })
            .eq('id', refreshRow.access_token_id);
        }
        return res.status(200).end();
      }

      // Not found → still 200 per spec.
      return res.status(200).end();
    } catch (err) {
      console.error('[oauth/revoke] threw:', err?.message || err);
      return res.status(200).end();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /oauth/introspect — RFC 7662 token introspection
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Lets a confidential client (or our own resource server, in a future
  // multi-process deploy) check whether a token is currently valid and
  // what scope/user it's bound to. Public clients can't call this — we
  // don't want random callers brute-forcing token validity.
  app.post('/oauth/introspect', oauthBodyParser, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'temporarily_unavailable' });
      res.set('Cache-Control', 'no-store');

      const body = req.body && typeof req.body === 'object' ? req.body : {};

      // Spec: introspection MUST require client auth. We accept Basic
      // (confidential clients) — public clients (auth_method=none) are
      // explicitly rejected with 401 to avoid token-fishing.
      const clientAuth = await resolveClientAuth(supabaseAdmin, req, body);
      if (!clientAuth.ok || clientAuth.client.token_endpoint_auth_method === 'none') {
        return res.status(401).json({ error: 'invalid_client' });
      }

      const tokenStr = String(body.token || '');
      if (!tokenStr) return res.json({ active: false });

      const tokenHash = sha256(tokenStr);
      const { data: row } = await supabaseAdmin
        .from('lykn_mcp_tokens')
        .select('user_id, status, scopes, expires_at, oauth_client_id, created_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();

      if (!row || row.status !== 'active') return res.json({ active: false });
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        return res.json({ active: false });
      }
      // Only the issuing client can introspect its own tokens.
      if (row.oauth_client_id && row.oauth_client_id !== clientAuth.client.client_id) {
        return res.json({ active: false });
      }

      return res.json({
        active: true,
        scope: (row.scopes || []).map(scopeToOauth).join(' '),
        client_id: row.oauth_client_id || undefined,
        sub: row.user_id,
        exp: row.expires_at ? Math.floor(Date.parse(row.expires_at) / 1000) : undefined,
        iat: Math.floor(Date.parse(row.created_at) / 1000),
        token_type: 'Bearer',
      });
    } catch (err) {
      console.error('[oauth/introspect] threw:', err?.message || err);
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /oauth/userinfo — minimal profile lookup (NOT full OIDC)
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Some clients (Cursor's MCP-OAuth probe in particular) hit
  // userinfo_endpoint to learn "who is this token for?". We don't issue
  // id_tokens (no OIDC in v1), but a cheap profile endpoint is enough
  // for that use-case. Returns the Supabase user's id + email iff the
  // token is valid + active. Bearer-authenticated; no client auth.
  app.get('/oauth/userinfo', async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: 'temporarily_unavailable' });
      const authHeader = String(req.headers.authorization || '');
      if (!authHeader.startsWith('Bearer ')) {
        res.set('WWW-Authenticate', 'Bearer realm="lykn"');
        return res.status(401).json({ error: 'invalid_token' });
      }
      const tokenStr = authHeader.slice(7).trim();
      const tokenHash = sha256(tokenStr);
      const { data: row } = await supabaseAdmin
        .from('lykn_mcp_tokens')
        .select('user_id, status, expires_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (!row || row.status !== 'active') {
        res.set('WWW-Authenticate', 'Bearer realm="lykn", error="invalid_token"');
        return res.status(401).json({ error: 'invalid_token' });
      }
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        res.set('WWW-Authenticate', 'Bearer realm="lykn", error="invalid_token"');
        return res.status(401).json({ error: 'invalid_token' });
      }

      // Pull email from auth.users via the admin API — keeps us off
      // the public.users mirror which may not be populated for every
      // user. Only `sub` is required; email is nice-to-have.
      let email;
      try {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(row.user_id);
        email = u?.user?.email;
      } catch {
        /* swallow — userinfo without email is still valid */
      }

      return res.json({
        sub: row.user_id,
        email: email || undefined,
        email_verified: email ? true : undefined,
      });
    } catch (err) {
      console.error('[oauth/userinfo] threw:', err?.message || err);
      return res.status(500).json({ error: 'server_error' });
    }
  });
}

// ===========================================================================
// Grant handlers — pulled out of the route to keep /oauth/token readable
// ===========================================================================

async function handleAuthorizationCodeGrant({
  req, res, body, client, supabaseAdmin, getPublicBaseUrl,
}) {
  const code = String(body.code || '');
  const redirectUri = String(body.redirect_uri || '');
  const codeVerifier = String(body.code_verifier || '');

  if (!code || !redirectUri || !codeVerifier) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'code, redirect_uri, code_verifier required.' });
  }

  // Atomic single-use redemption: select-then-update would race two
  // concurrent /token calls into both succeeding. We instead UPDATE
  // with a WHERE consumed_at IS NULL guard and check that the row
  // came back. Postgres + Supabase doesn't expose a single-shot
  // returning-update through PostgREST without an RPC, so we do it
  // in two steps and accept the small race window — the second
  // request observes consumed_at and bails out.
  const codeHash = sha256(code);
  const { data: codeRow } = await supabaseAdmin
    .from('lykn_oauth_authorization_codes')
    .select('id, client_id, user_id, consent_id, redirect_uri, scope, code_challenge, expires_at, consumed_at')
    .eq('code_hash', codeHash)
    .maybeSingle();
  if (!codeRow) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired code.' });
  }

  // Exhaustive validation BEFORE consuming the code. If any of these
  // fail, the code stays usable for legitimate retries (we don't
  // burn it on a malformed retry).
  if (codeRow.consumed_at) {
    // Already redeemed once. Per spec we MUST treat this as suspected
    // theft and revoke any tokens minted from it. We don't keep the
    // FK from access tokens back to the auth code (saves a column),
    // so the closest we can do is: nuke any tokens created in the
    // ~5s window after the original redemption. In practice "first
    // request wins, second request is rejected" is the dominant
    // outcome here; a true replay would be very unusual.
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code already used.' });
  }
  if (Date.parse(codeRow.expires_at) <= Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired.' });
  }
  if (codeRow.client_id !== client.client_id) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code was not issued to this client.' });
  }
  if (codeRow.redirect_uri !== redirectUri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match.' });
  }

  // PKCE verify: SHA-256 of verifier (base64url) MUST equal the stored
  // challenge. Per RFC 7636 §4.6.
  const computedChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  if (!timingSafeEqualStr(computedChallenge, codeRow.code_challenge)) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verifier does not match challenge.' });
  }

  // Consent must still be live.
  const { data: consent } = await supabaseAdmin
    .from('lykn_oauth_consents')
    .select('id, user_id, scopes, revoked_at')
    .eq('id', codeRow.consent_id)
    .maybeSingle();
  if (!consent || consent.revoked_at) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'User consent has been revoked.' });
  }

  // ── Mint the access token (row in lykn_mcp_tokens) ─────────────────
  const grantedScopes = codeRow.scope.split(/\s+/).filter(Boolean);
  const internalScopes = grantedScopes
    .map(scopeToInternal)
    .filter(Boolean);
  // Always at least 'read' so the token can do something useful.
  if (!internalScopes.length) internalScopes.push('read');

  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);
  const mintRes = await createMcpToken(supabaseAdmin, codeRow.user_id, {
    label: client.client_name || 'OAuth client',
    clientKind: classifyClientKind({
      name: client.client_name,
      redirect_uris: client.redirect_uris,
    }),
    scopes: internalScopes,
    oauthClientId: client.client_id,
    oauthConsentId: consent.id,
    expiresAt,
  });
  if (!mintRes.ok || !mintRes.token) {
    return res.status(500).json({ error: 'server_error', error_description: 'Could not mint access token.' });
  }

  // ── Mint the refresh token (if scope includes offline_access) ──────
  let refreshPlain = null;
  if (grantedScopes.includes('offline_access')) {
    refreshPlain = `lkn_refresh_${randomToken(32)}`;
    const { error: refErr } = await supabaseAdmin
      .from('lykn_oauth_refresh_tokens')
      .insert({
        refresh_hash: sha256(refreshPlain),
        client_id: client.client_id,
        user_id: codeRow.user_id,
        consent_id: consent.id,
        access_token_id: mintRes.token.id,
        scope: codeRow.scope,
        expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000).toISOString(),
      });
    if (refErr) {
      console.warn('[oauth/token] refresh insert failed:', refErr.message);
      // Non-fatal — access token is already valid; user just won't get
      // silent renewal. They'll re-auth when it expires.
      refreshPlain = null;
    }
  }

  // ── Mark the auth code consumed (single-use) ───────────────────────
  await supabaseAdmin
    .from('lykn_oauth_authorization_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', codeRow.id);

  return res.json({
    access_token: mintRes.token.plaintext,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshPlain || undefined,
    scope: codeRow.scope,
  });
}

async function handleRefreshTokenGrant({ req, res, body, client, supabaseAdmin }) {
  const refreshToken = String(body.refresh_token || '');
  if (!refreshToken) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required.' });
  }

  const refreshHash = sha256(refreshToken);
  const { data: refreshRow } = await supabaseAdmin
    .from('lykn_oauth_refresh_tokens')
    .select('id, client_id, user_id, consent_id, scope, expires_at, consumed_at, replaced_by, access_token_id')
    .eq('refresh_hash', refreshHash)
    .maybeSingle();
  if (!refreshRow) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown refresh_token.' });
  }
  if (refreshRow.client_id !== client.client_id) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh_token was not issued to this client.' });
  }

  // Replay detection (RFC 6749 §10.4): if this refresh has already been
  // used (consumed_at set) OR it was replaced, the legitimate holder
  // would never see it again. Someone else has it → revoke the whole
  // family and refuse.
  if (refreshRow.consumed_at || refreshRow.replaced_by) {
    await revokeRefreshFamily(supabaseAdmin, refreshRow.consent_id);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh_token replay detected — family revoked.' });
  }
  if (Date.parse(refreshRow.expires_at) <= Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh_token expired.' });
  }

  // Verify consent is still live.
  const { data: consent } = await supabaseAdmin
    .from('lykn_oauth_consents')
    .select('id, revoked_at')
    .eq('id', refreshRow.consent_id)
    .maybeSingle();
  if (!consent || consent.revoked_at) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Consent revoked.' });
  }

  const grantedScopes = refreshRow.scope.split(/\s+/).filter(Boolean);
  const internalScopes = grantedScopes.map(scopeToInternal).filter(Boolean);
  if (!internalScopes.length) internalScopes.push('read');

  // Mint the new access token.
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);
  const mintRes = await createMcpToken(supabaseAdmin, refreshRow.user_id, {
    label: client.client_name || 'OAuth client',
    clientKind: classifyClientKind({
      name: client.client_name,
      redirect_uris: client.redirect_uris,
    }),
    scopes: internalScopes,
    oauthClientId: client.client_id,
    oauthConsentId: consent.id,
    expiresAt,
  });
  if (!mintRes.ok || !mintRes.token) {
    return res.status(500).json({ error: 'server_error' });
  }

  // Mint the new refresh token, chained.
  const newRefreshPlain = `lkn_refresh_${randomToken(32)}`;
  const { data: newRefresh, error: newRefErr } = await supabaseAdmin
    .from('lykn_oauth_refresh_tokens')
    .insert({
      refresh_hash: sha256(newRefreshPlain),
      client_id: client.client_id,
      user_id: refreshRow.user_id,
      consent_id: consent.id,
      access_token_id: mintRes.token.id,
      scope: refreshRow.scope,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000).toISOString(),
    })
    .select('id')
    .single();
  if (newRefErr) {
    console.warn('[oauth/token] refresh rotate failed:', newRefErr.message);
    // Access token is fine; just no rotation. Caller must re-auth on
    // next refresh, which is acceptable degradation.
  }

  // Consume the old refresh and link to the new one. Revoke the old
  // access token so it can't double-up with the new one.
  await supabaseAdmin
    .from('lykn_oauth_refresh_tokens')
    .update({
      consumed_at: new Date().toISOString(),
      replaced_by: newRefresh?.id || null,
    })
    .eq('id', refreshRow.id);
  if (refreshRow.access_token_id) {
    await supabaseAdmin
      .from('lykn_mcp_tokens')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('id', refreshRow.access_token_id);
  }

  return res.json({
    access_token: mintRes.token.plaintext,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: newRefresh ? newRefreshPlain : undefined,
    scope: refreshRow.scope,
  });
}

// Revoke every active access + refresh token under a consent. Used for
// refresh-replay detection per RFC 6749 §10.4.
async function revokeRefreshFamily(supabaseAdmin, consentId) {
  if (!consentId) return;
  await Promise.all([
    supabaseAdmin
      .from('lykn_oauth_refresh_tokens')
      .update({ consumed_at: new Date().toISOString() })
      .eq('consent_id', consentId)
      .is('consumed_at', null),
    supabaseAdmin
      .from('lykn_mcp_tokens')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('oauth_consent_id', consentId)
      .eq('status', 'active'),
  ]);
}

// ===========================================================================
// Client auth — Basic header OR client_id-only (public + PKCE)
// ===========================================================================

async function resolveClientAuth(supabaseAdmin, req, body) {
  // Try HTTP Basic first (confidential clients).
  const authHeader = String(req.headers.authorization || '');
  let bodyClientId = String(body.client_id || '') || null;
  let bodyClientSecret = String(body.client_secret || '') || null;
  let basicClientId = null;
  let basicClientSecret = null;
  if (authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx >= 0) {
        basicClientId = decodeURIComponent(decoded.slice(0, idx));
        basicClientSecret = decodeURIComponent(decoded.slice(idx + 1));
      }
    } catch {
      /* fallthrough — bad header */
    }
  }

  const clientId = basicClientId || bodyClientId;
  const presentedSecret = basicClientSecret || bodyClientSecret;
  if (!clientId) {
    return { ok: false, error: 'invalid_client', error_description: 'client_id required.' };
  }

  const { data: client } = await supabaseAdmin
    .from('lykn_oauth_clients')
    .select('client_id, client_name, client_secret_hash, redirect_uris, scope, status, token_endpoint_auth_method')
    .eq('client_id', clientId)
    .maybeSingle();
  if (!client || client.status !== 'active') {
    return { ok: false, error: 'invalid_client', error_description: 'Unknown client.' };
  }

  if (client.token_endpoint_auth_method === 'client_secret_basic') {
    if (!presentedSecret || !client.client_secret_hash) {
      return { ok: false, error: 'invalid_client', error_description: 'client_secret required.' };
    }
    const expected = Buffer.from(client.client_secret_hash, 'utf8');
    const got = Buffer.from(sha256(presentedSecret), 'utf8');
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
      return { ok: false, error: 'invalid_client', error_description: 'Bad client_secret.' };
    }
  }
  // Public clients (auth_method='none') skip secret checking — PKCE is
  // their proof. They MUST present client_id (which we've already
  // validated above) but no secret.

  return { ok: true, client };
}

// ---------------------------------------------------------------------------
// Metadata builders — pure, unit-testable
// ---------------------------------------------------------------------------

/**
 * Build the RFC 8414 authorization-server metadata document. Pure
 * function — takes the issuer URL, returns the JSON the client gets.
 *
 * Notes on choices:
 *   • `issuer` MUST be the exact origin the client will see in tokens'
 *     `iss` claim (we don't issue id_tokens yet, but introspection and
 *     future OIDC will use it). No trailing slash, https in prod.
 *   • `code_challenge_methods_supported` is `S256` only. Plain PKCE is
 *     deprecated in OAuth 2.1 and we reject it at /authorize.
 *   • `grant_types_supported` excludes `client_credentials` because
 *     LYKN is a per-user product — there is no "machine-only" identity
 *     a client could bind to. Same reasoning excludes `password`.
 *   • `service_documentation` points at the human-readable connection
 *     guide so client developers (the integration engineer at
 *     ChatGPT, Cursor, etc.) can find onboarding instructions from
 *     just the metadata doc.
 */
export function buildAuthServerMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: SUPPORTED_RESPONSE_TYPES,
    grant_types_supported: SUPPORTED_GRANT_TYPES,
    token_endpoint_auth_methods_supported: SUPPORTED_TOKEN_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: SUPPORTED_TOKEN_AUTH_METHODS,
    introspection_endpoint_auth_methods_supported: SUPPORTED_TOKEN_AUTH_METHODS,
    code_challenge_methods_supported: SUPPORTED_CODE_CHALLENGE_METHODS,
    require_signed_request_object: false,
    dpop_signing_alg_values_supported: [],
    service_documentation: `${issuer}/connections`,
    op_policy_uri: `${issuer}/legal/privacy`,
    op_tos_uri: `${issuer}/legal/terms`,
  };
}

/**
 * Build the RFC 9728 protected-resource metadata. The MCP spec uses
 * this as the "if you got a 401 from /mcp, here's where to authenticate"
 * pointer. Returning a self-referential doc (resource = ourselves,
 * authorization_servers = ourselves) is normal for a single-tenant
 * setup.
 */
export function buildProtectedResourceMetadata({ base, resourcePath }) {
  return {
    resource: `${base}${resourcePath}`,
    authorization_servers: [base],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/.well-known/mcp.json`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkRegisterRateLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const list = (_registerIpHits.get(ip) || []).filter((t) => t > hourAgo);
  if (list.length >= MAX_REGISTRATIONS_PER_IP_PER_HOUR) {
    _registerIpHits.set(ip, list);
    return false;
  }
  list.push(now);
  _registerIpHits.set(ip, list);
  // Cheap garbage collection: when the map gets big, drop entries
  // whose newest hit is > 1h old. Keeps memory bounded without a timer.
  if (_registerIpHits.size > 5000) {
    for (const [k, v] of _registerIpHits) {
      if (!v.length || v[v.length - 1] < hourAgo) _registerIpHits.delete(k);
    }
  }
  return true;
}

// Schemes we explicitly disallow even as native-app redirects — these
// can punch out of the browser and trigger code execution / nav we don't
// want a malicious DCR client to reach. Anything else that looks like a
// claimed custom URL scheme (cursor://, vscode://, com.example.app://)
// is allowed per RFC 8252 §7.1.
const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  'javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:',
  'ftp:', 'gopher:', 'mailto:', 'ws:', 'wss:',
]);

// Minimum characters a custom scheme must have to look intentional —
// blocks single-letter / empty schemes that some parsers misinterpret.
const MIN_CUSTOM_SCHEME_LEN = 3;

function validateRedirectUris(uris) {
  if (!Array.isArray(uris) || uris.length === 0) {
    return 'redirect_uris is required and must be a non-empty array.';
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return `redirect_uris cannot exceed ${MAX_REDIRECT_URIS} entries.`;
  }
  for (const raw of uris) {
    if (typeof raw !== 'string') return 'redirect_uris must be strings.';
    const u = raw.trim();
    if (!u || u.length > MAX_REDIRECT_URI_LEN) {
      return `redirect_uri is empty or exceeds ${MAX_REDIRECT_URI_LEN} chars.`;
    }
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      return `redirect_uri is not a valid URL: ${u}`;
    }

    const proto = parsed.protocol; // includes trailing ':'
    if (FORBIDDEN_REDIRECT_SCHEMES.has(proto)) {
      return `redirect_uri scheme is not allowed: ${proto}`;
    }

    // Spec: redirect_uri MUST NOT include a fragment (RFC 6749 §3.1.2).
    if (parsed.hash) {
      return `redirect_uri must not contain a fragment: ${u}`;
    }

    // Three accepted shapes:
    //   1. https://...                              — web-hosted clients
    //   2. http://(localhost|127.0.0.1|::1)/...     — dev / loopback
    //   3. <custom-scheme>://...                    — RFC 8252 §7.1 native apps
    //      (e.g. cursor://, vscode://, claude-desktop://, com.example.app://)
    //
    // Native MCP clients (Cursor's Custom MCP via OAuth, ChatGPT Apps when
    // installed locally, etc.) ship a private-use URI scheme registered
    // with the OS; that's how the OAuth callback lands back inside the
    // app. Refusing those would block every native client.
    if (proto === 'https:') {
      // OK
    } else if (proto === 'http:') {
      const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      if (!isLocal) {
        return `redirect_uri must use https (http allowed only for localhost): ${u}`;
      }
    } else {
      // Custom URL scheme. Require at minimum a scheme of reasonable
      // length so we don't accept weird single-letter parser quirks.
      const schemeName = proto.slice(0, -1); // strip trailing ':'
      if (schemeName.length < MIN_CUSTOM_SCHEME_LEN) {
        return `redirect_uri uses too short a custom scheme: ${u}`;
      }
      if (!/^[a-z][a-z0-9+.\-]*$/i.test(schemeName)) {
        return `redirect_uri uses an invalid scheme name: ${u}`;
      }
      // Custom-scheme URIs CAN omit a host (e.g. `myapp:/callback`); URL
      // parsing puts the path-only form into parsed.pathname with an
      // empty hostname. That's fine per RFC 8252 — we don't enforce a
      // host on private-use schemes.
    }
  }
  return null;
}

function pickSubset(value, supported, fallback) {
  if (!Array.isArray(value)) return fallback;
  const filtered = value
    .map((v) => String(v || '').toLowerCase())
    .filter((v) => supported.includes(v));
  return filtered.length ? filtered : fallback;
}

function filterScopes(scopeStr) {
  return String(scopeStr || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => SUPPORTED_SCOPES.includes(s));
}

// Bridge between OAuth scopes (`lykn:read`, `lykn:write`, `offline_access`)
// and the internal coarse scope set on lykn_mcp_tokens (`read`, `write`).
// `offline_access` doesn't map to a token scope — it just opts into a
// refresh token, which is handled separately.
function scopeToInternal(oauthScope) {
  switch (oauthScope) {
    case 'lykn:read': return 'read';
    case 'lykn:write': return 'write';
    default: return null;
  }
}
function scopeToOauth(internalScope) {
  switch (internalScope) {
    case 'read': return 'lykn:read';
    case 'write': return 'lykn:write';
    default: return internalScope;
  }
}

// Best-effort kind classification so the Connections "Connected clients"
// table shows the right icon and the OauthMcpSection polling can route
// post-connect telemetry. DCR doesn't give us a stable identifier —
// every ChatGPT / Claude.ai instance is a fresh client_id — so we
// fingerprint on:
//   1. redirect_uris (most reliable: Claude.ai sends users to
//      claude.ai/api/mcp/auth_callback; ChatGPT to chatgpt.com)
//   2. client_name (fallback for anything bespoke)
//
// Pass either a string (legacy single-arg callers) or
// { name, redirect_uris } for the redirect-aware path.
function classifyClientKind(input) {
  // Back-compat: callers that pass a bare string only get the
  // name-based path. Internal callers should pass the object form.
  const name = typeof input === 'string' ? input : input?.name;
  const redirectUris = typeof input === 'string' ? [] : (input?.redirect_uris || []);

  // ── Redirect-URI fingerprint (highest confidence) ─────────────────
  for (const uri of redirectUris) {
    let host = '';
    try { host = new URL(uri).hostname.toLowerCase(); } catch { continue; }
    if (host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude-web';
    if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) return 'chatgpt';
    if (host === 'openai.com' || host.endsWith('.openai.com')) return 'chatgpt';
    if (host === 'cursor.com' || host.endsWith('.cursor.com')) return 'cursor';
    if (host === 'perplexity.ai' || host.endsWith('.perplexity.ai')) return 'perplexity';
    if (host === 'zapier.com' || host.endsWith('.zapier.com')) return 'zapier';
    if (host === 'grok.com' || host.endsWith('.grok.com')) return 'grok';
    if (host === 'x.ai' || host.endsWith('.x.ai')) return 'grok';
    // Replit Agent's DCR registration uses replit.com (web Integrations
    // page) for the redirect URI per their MCP docs — replit-com or
    // *.replit.com both safe. Also catch replit.app for any Replit-
    // hosted MCP install link that proxies through their CDN.
    if (host === 'replit.com' || host.endsWith('.replit.com')) return 'replit';
    if (host === 'replit.app' || host.endsWith('.replit.app')) return 'replit';
    // Notion Custom Agents use either notion.com or notion.so for the
    // OAuth redirect (both serve the workspace; notion.com is the
    // canonical marketing/help host, notion.so the legacy app host).
    // Their MCP server runs at mcp.notion.com per the makenotion/
    // notion-mcp-server repo, but that's outbound from us → them, not
    // their callback URL. Cover both root hosts.
    if (host === 'notion.com' || host.endsWith('.notion.com')) return 'notion-ai';
    if (host === 'notion.so' || host.endsWith('.notion.so')) return 'notion-ai';
    // VS Code Copilot's two redirect URIs per github docs:
    // http://127.0.0.1:33418 (native loopback) and
    // https://vscode.dev/redirect (web bridge). The loopback host
    // collides with every other CLI client (Gemini CLI, mcp-remote)
    // so we ONLY trust vscode.dev here — the loopback path falls
    // through to client_name matching below.
    if (host === 'vscode.dev' || host.endsWith('.vscode.dev')) return 'github-copilot';
  }

  // ── client_name fallback ──────────────────────────────────────────
  // Gemini CLI uses http://localhost:7777/oauth/callback as its
  // redirect URI (per google-gemini-cli docs) so the redirect-host
  // fingerprint above can't identify it — every CLI-based client uses
  // localhost. Fall through to client_name matching. Gemini CLI's DCR
  // registration self-reports as "Gemini CLI" / "gemini-cli" so the
  // substring match is reliable. Same pattern as Claude Code below.
  const n = String(name || '').toLowerCase();
  if (n.includes('chatgpt') || n.includes('openai')) return 'chatgpt';
  if (n.includes('claude') && n.includes('code')) return 'claude-code';
  if (n.includes('claude.ai') || n.includes('claude-web')) return 'claude-web';
  if (n.includes('claude')) return 'claude-desktop';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('perplexity')) return 'perplexity';
  if (n.includes('zapier')) return 'zapier';
  if (n.includes('grok') || n.includes('xai')) return 'grok';
  if (n.includes('replit')) return 'replit';
  if (n.includes('notion')) return 'notion-ai';
  // Windsurf goes through the mcp-remote stdio bridge (Windsurf can't
  // do native OAuth on HTTP MCP yet) — we pin client_name="Windsurf"
  // in the install snippet via --static-oauth-client-metadata so this
  // catches the bearer regardless of whether mcp-remote runs from
  // Windsurf, a future native bridge, or a user-edited config.
  if (n.includes('windsurf') || n.includes('codeium')) return 'windsurf';
  // GitHub Copilot in VS Code registers itself with a name like
  // "GitHub Copilot Chat" / "VS Code (GitHub Copilot)" depending on
  // the install path. Match either signal. Don't match bare "github"
  // — that's too loose and would shadow other legitimate GitHub-named
  // clients (Octokit, the github-mcp-server, etc.).
  if (n.includes('copilot') || n.includes('vscode') || n.includes('vs code'))
    return 'github-copilot';
  return 'other';
}

// Pull a compact, log-safe snapshot of an incoming DCR body. Keeps the
// fields we need for debugging client failures (Perplexity et al. only
// surface "no client_id returned"; the only way to see WHY we said no
// is to log what they sent), drops anything secret-shaped so we don't
// leak credentials into the application log.
function redactDcrBodyForLog(body) {
  if (!body || typeof body !== 'object') return {};
  const safe = {};
  const KEEP = [
    'client_name',
    'client_uri',
    'logo_uri',
    'tos_uri',
    'policy_uri',
    'software_id',
    'software_version',
    'redirect_uris',
    'grant_types',
    'response_types',
    'token_endpoint_auth_method',
    'scope',
    'application_type',
    'subject_type',
    'contacts',
  ];
  for (const k of KEEP) {
    if (body[k] !== undefined) safe[k] = body[k];
  }
  // Surface the full set of incoming keys so we can spot weird ones
  // (e.g. an extra `actor` field) without dumping their values.
  safe._unknown_keys = Object.keys(body).filter((k) => !KEEP.includes(k));
  return safe;
}

function sanitizeText(s, maxLen) {
  if (typeof s !== 'string') return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

function sanitizeUri(s) {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function appendQuery(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function renderAuthError(res, errCode, description) {
  const safe = String(description || '').replace(/[<>]/g, '');
  return res
    .status(400)
    .type('text/html')
    .send(`<!doctype html><html><head><meta charset="utf-8"><title>LYKN — OAuth error</title></head>
<body style="font:14px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#111">
  <h1 style="font-size:18px;margin:0 0 8px">Couldn't start the connection</h1>
  <p style="margin:0 0 16px;color:#555">${safe}</p>
  <p style="margin:0;font-family:ui-monospace,monospace;font-size:12px;color:#888">error: ${errCode}</p>
</body></html>`);
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Re-exports for tests / future modules
// ---------------------------------------------------------------------------
export const OAUTH_SUPPORTED_SCOPES = SUPPORTED_SCOPES;
export const OAUTH_SUPPORTED_GRANT_TYPES = SUPPORTED_GRANT_TYPES;
export const OAUTH_SUPPORTED_RESPONSE_TYPES = SUPPORTED_RESPONSE_TYPES;
export const OAUTH_SUPPORTED_CODE_CHALLENGE_METHODS = SUPPORTED_CODE_CHALLENGE_METHODS;
export const OAUTH_SUPPORTED_TOKEN_AUTH_METHODS = SUPPORTED_TOKEN_AUTH_METHODS;
export const OAUTH_ACCESS_TOKEN_TTL_SEC = ACCESS_TOKEN_TTL_SEC;
export const OAUTH_REFRESH_TOKEN_TTL_SEC = REFRESH_TOKEN_TTL_SEC;
