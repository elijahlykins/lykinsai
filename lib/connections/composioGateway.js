/**
 * Server-side Composio gateway for LYKN managed connections.
 *
 * This is the only module that talks to the Composio SDK / REST API.
 * Product code goes through lib/connections/connectionService.js and
 * receives normalized LYKN-shaped results — Composio SDK objects,
 * provider OAuth tokens, and raw Composio response bodies must not
 * leak past this boundary.
 *
 * Current Composio architecture (v3 / SDK @composio/core 0.18):
 *   composio.create(userId)            -> per-user Session
 *   session.authorize(toolkit)         -> Connect Link (redirectUrl)
 *   session.toolkits({ toolkits })     -> authoritative connection state
 *   session.mcp (direct_tools preset)  -> per-user MCP endpoint for tool execution
 *   composio.connectedAccounts.delete  -> delete a connected account
 *   REST v3.1 /toolkits                -> global catalog (managed-auth flags)
 *   REST v3.1 /auth_configs            -> project-owned custom OAuth apps
 *   REST v3.1 /connected_accounts/{id}/revoke      -> provider revocation
 *   REST v3.1 /connected_accounts/complete_auth    -> callback identity verification
 *
 * The deprecated connectedAccounts.initiate() managed-OAuth flow and the
 * standalone Composio MCP-server API are intentionally not used.
 *
 * Security invariants:
 *   - COMPOSIO_API_KEY stays in this process; it is never logged and never
 *     included in errors returned to callers.
 *   - The Composio userId is always the stable authenticated LYKN user id,
 *     supplied by the server-side caller (never renderer input).
 */

const COMPOSIO_REST_BASE = 'https://backend.composio.dev/api/v3.1';
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;

export const MANAGED_CONNECTION_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  UNAVAILABLE: 'provider_unavailable',
  RATE_LIMITED: 'rate_limited',
  LINK_FAILED: 'link_creation_failed',
  NOT_CONNECTED: 'not_connected',
  VERIFICATION_FAILED: 'identity_verification_failed',
  VERIFICATION_EXPIRED: 'verification_session_expired',
  UNKNOWN_PROVIDER: 'unknown_provider',
  // The toolkit has no managed OAuth app and Composio cannot auto-create one
  // (e.g. Twitter/X requires every product to bring its own developer app).
  // Connecting it requires a LYKN-owned auth config in the Composio dashboard.
  REQUIRES_SETUP: 'provider_requires_setup',
  INTERNAL: 'internal',
});

export class ManagedConnectionError extends Error {
  constructor(code, message, { detail, cause } = {}) {
    super(message);
    this.name = 'ManagedConnectionError';
    this.code = code;
    // detail is for structured server logs only; routes must not send it
    // to clients verbatim.
    this.detail = detail || null;
    if (cause) this.cause = cause;
  }
}

/** Composio connected-account statuses -> LYKN connection statuses. */
export function normalizeAccountStatus(rawStatus) {
  const status = String(rawStatus || '').toUpperCase();
  if (status === 'ACTIVE') return 'connected';
  if (status === 'INITIATED' || status === 'INITIALIZING') return 'pending';
  if (status === 'FAILED' || status === 'EXPIRED' || status === 'REVOKED') return 'broken';
  return 'disconnected';
}

function sanitizeDetail(value, apiKey) {
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = String(text || '').slice(0, 400);
  if (apiKey) text = text.split(apiKey).join('[redacted]');
  // Defensively drop anything that looks like a bearer credential.
  return text.replace(/(access|refresh)_?token"?\s*[:=]\s*"?[^",\s}]+/gi, '$1_token:[redacted]');
}

async function defaultLoadComposio() {
  const mod = await import('@composio/core');
  return mod.Composio;
}

export function createComposioGateway({
  apiKey = process.env.COMPOSIO_API_KEY,
  loadComposio = defaultLoadComposio,
  fetchImpl = fetch,
  restBaseUrl = COMPOSIO_REST_BASE,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  now = Date.now,
  logger = console,
} = {}) {
  const key = String(apiKey || '').trim();
  let clientPromise = null;
  // Per-user session cache. Composio sessions are lightweight server-side
  // objects; caching avoids creating a new one for every status poll.
  const sessions = new Map();
  // The global toolkit catalog (slug/name/logo) changes rarely; cache it
  // process-wide so the Settings directory search does not re-page Composio.
  const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
  let catalogCache = null;
  // The cold page-through takes ~15s; concurrent first requests must share
  // one in-flight fetch instead of each re-paging Composio.
  let catalogInflight = null;
  // First popularity page only — the fast path that lets the directory paint
  // in one round-trip while the full catalog warms in the background.
  const FIRST_PAGE_TTL_MS = 5 * 60 * 1000;
  let firstPageCache = null;

  // Auth schemes that need a pre-registered developer app or org-level
  // configuration before anyone can connect (verified live 2026-09-02:
  // authorize() on unmanaged OAUTH2/S2S_OAUTH2 fails with "create an auth
  // config"). Everything else — API_KEY, BASIC, BEARER_TOKEN, DCR_OAUTH,
  // service-account uploads — collects the user's own credentials in the
  // Connect Link form, and Composio auto-creates the auth config.
  const SETUP_REQUIRED_SCHEMES = new Set(['OAUTH1', 'OAUTH2', 'S2S_OAUTH2', 'SAML']);

  /**
   * Normalize a REST /toolkits list item into a directory entry, or null
   * when the toolkit cannot actually be connected.
   *
   * A toolkit is connectable when it needs no auth, when Composio provides
   * a shared managed OAuth app for it, when any of its auth schemes is
   * self-service (user-supplied credentials), or when this project carries
   * its own auth config (e.g. a LYKN-registered Twitter/X developer app).
   * Anything else would only ever reach the "developer credentials not set
   * up" error, so it is hidden from the directory instead of offered.
   */
  function normalizeToolkitItem(item, authConfigSlugs) {
    if (!item?.slug) return null;
    const slug = String(item.slug).toLowerCase();
    const isNoAuth = Boolean(item.no_auth);
    const hasManagedAuth = Array.isArray(item.composio_managed_auth_schemes)
      ? item.composio_managed_auth_schemes.length > 0
      : false;
    const hasSelfServiceScheme = (item.auth_schemes || []).some(
      (scheme) => !SETUP_REQUIRED_SCHEMES.has(String(scheme).toUpperCase()),
    );
    if (!isNoAuth && !hasManagedAuth && !hasSelfServiceScheme && !authConfigSlugs.has(slug)) {
      return null;
    }
    return {
      slug,
      name: item.name || item.slug,
      logoUrl: item.meta?.logo || null,
      isNoAuth,
    };
  }

  /**
   * Toolkit slugs with a project-owned auth config (custom OAuth apps we
   * registered in the Composio dashboard). Cached alongside the catalog.
   */
  let authConfigSlugsCache = null;
  async function getAuthConfigSlugs() {
    if (authConfigSlugsCache && authConfigSlugsCache.expiresAt > now()) {
      return authConfigSlugsCache.slugs;
    }
    const slugs = new Set();
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const query = `limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { status, data } = await restRequest(`/auth_configs?${query}`, { method: 'GET' });
      if (status !== 200) {
        throw new ManagedConnectionError(
          MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
          'Could not load the connections directory.',
          { detail: `auth_configs status=${status}` },
        );
      }
      for (const item of data?.items || []) {
        const slug = String(item?.toolkit?.slug || '').toLowerCase();
        if (slug && String(item?.status || 'ENABLED').toUpperCase() === 'ENABLED') {
          slugs.add(slug);
        }
      }
      cursor = data?.next_cursor || null;
      if (!cursor) break;
    }
    authConfigSlugsCache = { slugs, expiresAt: now() + CATALOG_TTL_MS };
    return slugs;
  }

  /** One popularity-sorted page of the global REST toolkit list. */
  async function fetchToolkitPage(cursor) {
    const query = `limit=50&sort_by=usage${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { status, data } = await restRequest(`/toolkits?${query}`, { method: 'GET' });
    if (status !== 200) {
      throw new ManagedConnectionError(
        MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
        'Could not load the connections directory.',
        { detail: `toolkits status=${status}` },
      );
    }
    return { items: data?.items || [], cursor: data?.next_cursor || null };
  }

  function assertConfigured() {
    if (!key) {
      throw new ManagedConnectionError(
        MANAGED_CONNECTION_ERROR_CODES.NOT_CONFIGURED,
        'Managed connections are not configured on this server.',
      );
    }
  }

  function toGatewayError(e, fallbackCode, message) {
    if (e instanceof ManagedConnectionError) return e;
    const status = e?.status || e?.statusCode || e?.response?.status;
    if (status === 429) {
      return new ManagedConnectionError(
        MANAGED_CONNECTION_ERROR_CODES.RATE_LIMITED,
        'The connection provider is rate limiting requests. Try again shortly.',
        { detail: sanitizeDetail(e?.message, key), cause: e },
      );
    }
    // Composio 400 code 4300: the toolkit has no auth config and one cannot
    // be auto-created. This is a setup gap on our side, not an outage — the
    // generic "could not reach the provider" message would be a lie.
    // Composio phrases this two ways depending on where it fails: session
    // creation says "require auth configs … cannot be auto-created", while
    // authorize() says "does not manage auth for toolkit … create an auth
    // config".
    const errorText = String(e?.message || '');
    if (
      /require auth configs?\b[\s\S]*cannot be auto-?created/i.test(errorText) ||
      /does not manage auth for toolkit/i.test(errorText)
    ) {
      return new ManagedConnectionError(
        MANAGED_CONNECTION_ERROR_CODES.REQUIRES_SETUP,
        'This app needs developer credentials that LYKN has not set up yet, so it cannot be connected for now.',
        { detail: sanitizeDetail(errorText, key), cause: e },
      );
    }
    return new ManagedConnectionError(fallbackCode, message, {
      detail: sanitizeDetail(e?.message || e, key),
      cause: e,
    });
  }

  async function getClient() {
    assertConfigured();
    if (!clientPromise) {
      clientPromise = (async () => {
        const Composio = await loadComposio();
        return new Composio({ apiKey: key });
      })().catch((e) => {
        clientPromise = null;
        throw toGatewayError(
          e,
          MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
          'Could not initialize the managed connection provider.',
        );
      });
    }
    return clientPromise;
  }

  /**
   * @param {string} userId
   * @param {string[]|null} toolkits Restrict the session to these toolkit
   *   slugs, or null for an unrestricted session (full catalog access, used
   *   for the connections directory).
   */
  async function getSession(userId, toolkits) {
    const uid = String(userId || '').trim();
    if (!uid) {
      throw new ManagedConnectionError(
        MANAGED_CONNECTION_ERROR_CODES.INTERNAL,
        'A stable LYKN user id is required for managed connections.',
      );
    }
    const cacheKey = `${uid}::${toolkits ? [...toolkits].sort().join(',') : '*'}`;
    const cached = sessions.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.session;
    const client = await getClient();
    let session;
    try {
      session = await client.create(uid, {
        ...(toolkits ? { toolkits: [...toolkits] } : {}),
        // Auth is owned by the LYKN Connection Service UI, and these
        // sessions never execute tools, so in-chat auth meta-tools and
        // the remote sandbox are both unnecessary.
        manageConnections: false,
        sandbox: { enable: false },
      });
    } catch (e) {
      throw toGatewayError(
        e,
        MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
        'Could not reach the managed connection provider.',
      );
    }
    sessions.set(cacheKey, { session, expiresAt: now() + sessionTtlMs });
    return session;
  }

  // Tool-execution sessions are cached apart from status sessions: they use
  // the direct-tools preset (real toolkit tools on the MCP endpoint, no
  // meta-tools) and carry endpoint auth headers that must stay server-side.
  const mcpEndpoints = new Map();

  async function restRequest(path, { method = 'POST', body } = {}) {
    assertConfigured();
    let res;
    try {
      res = await fetchImpl(`${restBaseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': key,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw toGatewayError(
        e,
        MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
        'Could not reach the managed connection provider.',
      );
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }

  return {
    isConfigured() {
      return Boolean(key);
    },

    /**
     * Authoritative per-user connection state for one toolkit.
     * Returns { connected, status, connectedAccountId } — never credentials.
     */
    async getToolkitConnection(userId, toolkitSlug) {
      const session = await getSession(userId, [toolkitSlug]);
      let result;
      try {
        result = await session.toolkits({ toolkits: [toolkitSlug] });
      } catch (e) {
        throw toGatewayError(
          e,
          MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
          'Could not check the connection status.',
        );
      }
      const item = (result?.items || []).find(
        (t) => String(t?.slug || '').toLowerCase() === String(toolkitSlug).toLowerCase(),
      );
      const account = item?.connection?.connectedAccount || null;
      const status = item?.connection?.isActive
        ? 'connected'
        : normalizeAccountStatus(account?.status);
      return {
        connected: status === 'connected',
        status: account ? status : 'disconnected',
        connectedAccountId: account?.id || null,
      };
    },

    /**
     * Per-user MCP endpoint for executing one toolkit's tools.
     *
     * Creates a Composio session scoped to the toolkit with the
     * direct-tools preset, so the session's MCP endpoint lists the real
     * app tools (no meta-tools, no in-chat auth, no sandbox). Returns
     * { url, headers, type } for LYKN's Universal MCP client.
     *
     * The url and headers are capability credentials: callers must never
     * persist or log them. Cached per user+toolkit for sessionTtlMs;
     * pass { fresh: true } to force a new session after a 401.
     */
    async getMcpEndpoint(userId, toolkitSlug, { fresh = false } = {}) {
      const uid = String(userId || '').trim();
      const slug = String(toolkitSlug || '').trim().toLowerCase();
      if (!uid || !slug) {
        throw new ManagedConnectionError(
          MANAGED_CONNECTION_ERROR_CODES.INTERNAL,
          'A user id and toolkit are required for managed tool access.',
        );
      }
      const cacheKey = `${uid}::${slug}`;
      if (!fresh) {
        const cached = mcpEndpoints.get(cacheKey);
        if (cached && cached.expiresAt > now()) return cached.endpoint;
      }
      const client = await getClient();
      let session;
      try {
        session = await client.create(uid, {
          toolkits: [slug],
          sessionPreset: 'direct_tools',
          manageConnections: false,
          sandbox: { enable: false },
          mcp: true,
        });
      } catch (e) {
        throw toGatewayError(
          e,
          MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
          'Could not prepare tool access for this connection.',
        );
      }
      const url = session?.mcp?.url || null;
      if (!url) {
        throw new ManagedConnectionError(
          MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
          'Could not prepare tool access for this connection.',
          { detail: 'session.mcp.url missing' },
        );
      }
      const endpoint = {
        url,
        headers: { ...(session.mcp.headers || {}) },
        type: session.mcp.type || 'http',
      };
      mcpEndpoints.set(cacheKey, { endpoint, expiresAt: now() + sessionTtlMs });
      return endpoint;
    },

    /**
     * The global toolkit catalog: every connectable app with its display
     * name and logo, sorted by popularity. Connection state is deliberately
     * stripped — use listConnectedToolkits for the per-user overlay.
     *
     * Sourced from the REST toolkit list rather than a session listing:
     * only the REST shape carries composio_managed_auth_schemes, which is
     * what lets us hide setup-required apps (see normalizeToolkitItem).
     */
    async listToolkitCatalog() {
      assertConfigured();
      if (catalogCache && catalogCache.expiresAt > now()) return catalogCache.entries;
      if (catalogInflight) return catalogInflight;
      catalogInflight = (async () => {
        const authConfigSlugs = await getAuthConfigSlugs();
        const entries = [];
        let cursor = null;
        // Composio caps toolkit pages at 50; the page cap bounds a runaway
        // cursor loop while still covering the full ~1,500-toolkit catalog.
        for (let page = 0; page < 40; page++) {
          const result = await fetchToolkitPage(cursor);
          for (const item of result.items) {
            const entry = normalizeToolkitItem(item, authConfigSlugs);
            if (entry) entries.push(entry);
          }
          cursor = result.cursor;
          if (!cursor) break;
        }
        catalogCache = { entries, expiresAt: now() + CATALOG_TTL_MS };
        return entries;
      })();
      try {
        return await catalogInflight;
      } finally {
        catalogInflight = null;
      }
    },

    /**
     * First page of the catalog (top ~50 apps by popularity) in minimal
     * round-trips. The directory's default view uses this so it can paint
     * immediately instead of waiting for the full page-through.
     */
    async listToolkitFirstPage(userId, { limit = 50 } = {}) {
      assertConfigured();
      const n = Math.min(Math.max(Number(limit) || 50, 1), 50);
      if (catalogCache && catalogCache.expiresAt > now()) {
        return catalogCache.entries.slice(0, n);
      }
      if (firstPageCache && firstPageCache.expiresAt > now()) {
        return firstPageCache.entries.slice(0, n);
      }
      const [authConfigSlugs, result] = await Promise.all([
        getAuthConfigSlugs(),
        fetchToolkitPage(null),
      ]);
      const entries = result.items
        .map((item) => normalizeToolkitItem(item, authConfigSlugs))
        .filter(Boolean);
      firstPageCache = { entries, expiresAt: now() + FIRST_PAGE_TTL_MS };
      return entries.slice(0, n);
    },

    /**
     * Kick off the full catalog fetch without waiting for it — the fast
     * first-page path calls this so a later search finds a warm cache.
     */
    warmToolkitCatalog(userId) {
      if (catalogCache && catalogCache.expiresAt > now()) return;
      this.listToolkitCatalog(userId).catch(() => {});
    },

    /**
     * The user's currently connected (or broken) toolkits as a map of
     * slug -> { connected, status, connectedAccountId }. Fresh per call:
     * connection state must never be served stale from the catalog cache.
     */
    async listConnectedToolkits(userId) {
      const session = await getSession(userId, null);
      let result;
      try {
        result = await session.toolkits({ isConnected: true, limit: 50 });
      } catch (e) {
        throw toGatewayError(
          e,
          MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
          'Could not check connection status.',
        );
      }
      const bySlug = {};
      for (const item of result?.items || []) {
        const account = item?.connection?.connectedAccount;
        if (!item?.slug || !account) continue;
        const status = item.connection.isActive
          ? 'connected'
          : normalizeAccountStatus(account.status);
        bySlug[String(item.slug).toLowerCase()] = {
          connected: status === 'connected',
          status,
          connectedAccountId: account.id || null,
          // Display metadata so a connected app can render even before the
          // page/catalog that would normally carry its name and icon.
          name: item.name || item.slug,
          logoUrl: item.logo || null,
        };
      }
      return bySlug;
    },

    /**
     * Create a Composio-managed Connect Link for the toolkit.
     * Returns { redirectUrl } only.
     */
    async createConnectLink(userId, toolkitSlug, { callbackUrl } = {}) {
      const session = await getSession(userId, [toolkitSlug]);
      let request;
      try {
        request = await session.authorize(
          toolkitSlug,
          callbackUrl ? { callbackUrl } : undefined,
        );
      } catch (e) {
        throw toGatewayError(
          e,
          MANAGED_CONNECTION_ERROR_CODES.LINK_FAILED,
          'Could not start the connection. Try again.',
        );
      }
      const redirectUrl = request?.redirectUrl || request?.redirect_url || null;
      if (!redirectUrl) {
        throw new ManagedConnectionError(
          MANAGED_CONNECTION_ERROR_CODES.LINK_FAILED,
          'Could not start the connection. Try again.',
          { detail: 'authorize() returned no redirectUrl' },
        );
      }
      return { redirectUrl };
    },

    /**
     * Callback identity verification: redeem the single-use session_uri that
     * Composio handed to the project's verifier URL, binding completion to
     * the authenticated LYKN user. 400 = identity mismatch (connection moves
     * to FAILED at Composio); 404 = expired/consumed session.
     */
    async completeAuth(userId, sessionUri) {
      const uid = String(userId || '').trim();
      const uri = String(sessionUri || '').trim();
      if (!uid || !uri) {
        throw new ManagedConnectionError(
          MANAGED_CONNECTION_ERROR_CODES.VERIFICATION_FAILED,
          'Connection verification is missing required information.',
        );
      }
      const { status, data } = await restRequest('/connected_accounts/complete_auth', {
        body: { session_uri: uri, user_id: uid },
      });
      if (status === 200) {
        return {
          connectedAccountId: data?.connected_account_id || null,
          toolkitSlug: String(data?.toolkit_slug || '').toLowerCase() || null,
        };
      }
      if (status === 400) {
        throw new ManagedConnectionError(
          MANAGED_CONNECTION_ERROR_CODES.VERIFICATION_FAILED,
          'This connection was started by a different user, so it was not completed.',
          { detail: sanitizeDetail(data, key) },
        );
      }
      if (status === 404) {
        throw new ManagedConnectionError(
          MANAGED_CONNECTION_ERROR_CODES.VERIFICATION_EXPIRED,
          'This connection attempt expired. Start Connect again.',
          { detail: sanitizeDetail(data, key) },
        );
      }
      throw new ManagedConnectionError(
        MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
        'Could not verify the connection. Try again.',
        { detail: sanitizeDetail(data, key) },
      );
    },

    /**
     * Best-effort revocation of the grant at the provider (e.g. Google).
     * Never throws for "toolkit does not support revocation" — deletion
     * still proceeds and Composio drops the tokens.
     */
    async revokeAtProvider(connectedAccountId) {
      const id = encodeURIComponent(String(connectedAccountId || '').trim());
      if (!id) {
        return { revoked: false, reason: 'missing_account_id' };
      }
      const { status, data } = await restRequest(`/connected_accounts/${id}/revoke`);
      if (status === 200) return { revoked: true };
      if (status === 400) return { revoked: false, reason: 'unsupported' };
      if (status === 409) return { revoked: false, reason: 'not_revokable' };
      if (status === 404) return { revoked: false, reason: 'not_found' };
      logger.warn?.(
        `[connections] provider revoke failed status=${status} detail=${sanitizeDetail(data, key)}`,
      );
      return { revoked: false, reason: 'error' };
    },

    /**
     * Permanently delete the connected account at Composio.
     * Composio revokes the tokens it holds for the account.
     */
    async deleteConnectedAccount(connectedAccountId) {
      const id = String(connectedAccountId || '').trim();
      if (!id) {
        throw new ManagedConnectionError(
          MANAGED_CONNECTION_ERROR_CODES.NOT_CONNECTED,
          'There is no connected account to disconnect.',
        );
      }
      const client = await getClient();
      try {
        await client.connectedAccounts.delete(id);
      } catch (e) {
        throw toGatewayError(
          e,
          MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
          'Could not disconnect the account. Try again.',
        );
      }
      return { deleted: true };
    },
  };
}
