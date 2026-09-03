/**
 * LYKN Connection Service — the product-owned seam for managed
 * connected accounts (Gmail first).
 *
 * Callers (routes, Settings, later chat) speak LYKN vocabulary:
 *   listConnections / getStatus / connect / disconnect / completeCallback
 * and receive provider-neutral status objects. The Composio backend is an
 * implementation detail supplied by lib/connections/composioGateway.js.
 *
 * This service does NOT replace Universal MCP (lib/mcp). Advanced and
 * user-added MCP servers keep their existing connection stack. A provider
 * here declares which backend owns it; Phase 1 registers only
 * gmail -> composio.
 *
 * Connection state is authoritative at the backend (Composio persists
 * connected accounts against the stable LYKN user id). LYKN deliberately
 * stores no provider OAuth tokens and no duplicate connection rows —
 * the only persistence is the short-lived one-shot OAuth state that binds
 * a connect attempt to the initiating user.
 */

import crypto from 'node:crypto';

import {
  ManagedConnectionError,
  MANAGED_CONNECTION_ERROR_CODES,
} from './composioGateway.js';

export const MANAGED_CONNECTION_BACKENDS = Object.freeze({
  COMPOSIO: 'composio',
});

/**
 * Providers managed through this service. Phase 1: Gmail only.
 * `toolkit` is the Composio toolkit slug; UI copy always uses `label`.
 */
export const MANAGED_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'gmail',
    label: 'Gmail',
    description: 'Read and act on your Gmail through a managed, revocable connection.',
    backend: MANAGED_CONNECTION_BACKENDS.COMPOSIO,
    toolkit: 'gmail',
  }),
]);

export function managedProviderById(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  return MANAGED_PROVIDERS.find((p) => p.id === id) || null;
}

export function managedProviderByToolkit(toolkitSlug) {
  const slug = String(toolkitSlug || '').trim().toLowerCase();
  return MANAGED_PROVIDERS.find((p) => p.toolkit === slug) || null;
}

const CONNECT_STATE_PURPOSE_PREFIX = 'managed_connect:';
const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

// Catalog-only Composio identity for the public marketing ticker. Sessions
// are created with manageConnections: false and never execute tools.
export const PUBLIC_CATALOG_USER_ID = 'lykn-public-catalog';
const COMPOSIO_LOGO_PREFIX = 'https://logos.composio.dev/';
const PUBLIC_CATALOG_SKIP = new Set([
  'composio',
  'composio_search',
  'slackbot',
  'discordbot',
]);

function toPublicToolkit(entry) {
  const slug = String(entry?.slug || '').toLowerCase();
  if (!PROVIDER_SLUG_RE.test(slug) || PUBLIC_CATALOG_SKIP.has(slug)) return null;
  const name = String(entry.name || slug).trim().slice(0, 80) || slug;
  const rawLogo = String(entry.logoUrl || '').trim();
  const logoUrl = rawLogo.startsWith(COMPOSIO_LOGO_PREFIX)
    ? rawLogo
    : `${COMPOSIO_LOGO_PREFIX}api/${encodeURIComponent(slug)}`;
  return { slug, name, logoUrl };
}

/**
 * One-shot connect state on lykn_external_auth_states (the same table the
 * calendar OAuth CSRF states use). Binds { state -> userId, providerId } so
 * the unauthenticated browser callback can be tied back to the initiating
 * authenticated user. Rows are single-use: consume() deletes atomically.
 */
export function createSupabaseConnectStateStore(client) {
  return {
    async issue({ userId, providerId, ttlMs = CONNECT_STATE_TTL_MS }) {
      const state = crypto.randomBytes(24).toString('base64url');
      const { error } = await client.from('lykn_external_auth_states').insert({
        state,
        user_id: userId,
        purpose: `${CONNECT_STATE_PURPOSE_PREFIX}${providerId}`,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
      });
      if (error) throw error;
      return state;
    },
    async consume(state) {
      const value = String(state || '').trim();
      if (!value) return null;
      const { data, error } = await client
        .from('lykn_external_auth_states')
        .delete()
        .eq('state', value)
        .like('purpose', `${CONNECT_STATE_PURPOSE_PREFIX}%`)
        .select('*')
        .maybeSingle();
      if (error || !data) return null;
      if (new Date(data.expires_at).getTime() <= Date.now()) return null;
      return {
        userId: data.user_id,
        providerId: String(data.purpose).slice(CONNECT_STATE_PURPOSE_PREFIX.length),
      };
    },
  };
}

/** In-memory store for tests and supabase-less development. */
export function createMemoryConnectStateStore({ now = Date.now } = {}) {
  const rows = new Map();
  return {
    async issue({ userId, providerId, ttlMs = CONNECT_STATE_TTL_MS }) {
      const state = crypto.randomBytes(24).toString('base64url');
      rows.set(state, { userId, providerId, expiresAt: now() + ttlMs });
      return state;
    },
    async consume(state) {
      const row = rows.get(state);
      if (!row) return null;
      rows.delete(state);
      if (row.expiresAt <= now()) return null;
      return { userId: row.userId, providerId: row.providerId };
    },
  };
}

function requireUserId(userId) {
  const uid = String(userId || '').trim();
  if (!uid) {
    throw new ManagedConnectionError(
      MANAGED_CONNECTION_ERROR_CODES.INTERNAL,
      'An authenticated LYKN user is required.',
    );
  }
  return uid;
}

const PROVIDER_SLUG_RE = /^[a-z0-9_-]{1,64}$/;

function unknownProviderError() {
  return new ManagedConnectionError(
    MANAGED_CONNECTION_ERROR_CODES.UNKNOWN_PROVIDER,
    'That app is not available for managed connections yet.',
  );
}

/**
 * @param {object} deps
 * @param {object} deps.gateway    Composio gateway (createComposioGateway)
 * @param {object} deps.stateStore One-shot connect state store
 * @param {string} deps.publicApiBase e.g. https://api.lykn.io (no trailing slash)
 * @param {object} [deps.logger]
 */
export function createConnectionService({
  gateway,
  stateStore,
  publicApiBase,
  logger = console,
  // Composio can still report the account as pending for a moment after
  // the OAuth redirect lands on our callback; re-check briefly before
  // telling the user it failed.
  callbackGrace = { attempts: 3, delayMs: 1500 },
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Optional managed tool bridge (lib/connections/managedToolBridge.js).
  // Keeps the user's MCP tool rows aligned with their connected apps so
  // chat/bots/voice can call the app's tools. Bridge work is fire-and-
  // forget: connection UX never waits on tool discovery.
  toolBridge = null,
}) {
  const apiBase = String(publicApiBase || '').replace(/\/$/, '');

  function syncToolsAfterConnect(userId, provider) {
    if (!toolBridge) return;
    toolBridge
      .ensureToolConnection(userId, provider, { refresh: true })
      .then((result) => {
        if (!result?.ok) {
          logger.warn?.(
            `[connections] tool sync failed user=${userId} provider=${provider.id} error=${result?.error || 'unknown'}`,
          );
        }
      })
      .catch((e) => {
        logger.warn?.(
          `[connections] tool sync failed user=${userId} provider=${provider.id} error=${e?.code || e?.message || 'unknown'}`,
        );
      });
  }

  function syncToolsAfterDisconnect(userId, provider) {
    if (!toolBridge) return;
    toolBridge.removeToolConnection(userId, provider).catch((e) => {
      logger.warn?.(
        `[connections] tool removal failed user=${userId} provider=${provider.id} error=${e?.code || e?.message || 'unknown'}`,
      );
    });
  }

  function publicStatus(provider, backendState) {
    return {
      provider: provider.id,
      label: provider.label,
      description: provider.description,
      backend: provider.backend,
      iconUrl: provider.iconUrl || null,
      status: backendState.status,
      connected: backendState.connected,
      // Composio connected-account id: a safe identifier, kept so later
      // phases can support multiple accounts per provider. Never a token.
      connectionId: backendState.connectedAccountId || null,
    };
  }

  /**
   * Resolve a provider id to its descriptor. Curated LYKN providers win
   * (product copy); any other Composio-managed auth toolkit in the catalog
   * resolves dynamically, so the whole directory is connectable. Unknown
   * or auth-less slugs are rejected.
   */
  async function resolveProvider(userId, providerId) {
    const curated = managedProviderById(providerId);
    if (curated) return curated;
    const slug = String(providerId || '').trim().toLowerCase();
    if (!PROVIDER_SLUG_RE.test(slug) || !gateway.isConfigured()) throw unknownProviderError();
    const catalog = await gateway.listToolkitCatalog(userId);
    const entry = catalog.find((t) => t.slug === slug && !t.isNoAuth);
    if (!entry) throw unknownProviderError();
    return {
      id: entry.slug,
      label: entry.name,
      description: `Connect ${entry.name} through a managed, revocable connection.`,
      backend: MANAGED_CONNECTION_BACKENDS.COMPOSIO,
      toolkit: entry.slug,
      iconUrl: entry.logoUrl || null,
    };
  }

  async function backendStatus(userId, provider) {
    if (!gateway.isConfigured()) {
      return { connected: false, status: 'unconfigured', connectedAccountId: null };
    }
    return gateway.getToolkitConnection(userId, provider.toolkit);
  }

  return {
    providers: MANAGED_PROVIDERS,

    async listConnections(userId) {
      const uid = requireUserId(userId);
      const results = [];
      for (const provider of MANAGED_PROVIDERS) {
        try {
          results.push(publicStatus(provider, await backendStatus(uid, provider)));
        } catch (e) {
          logger.warn?.(
            `[connections] status check failed user=${uid} provider=${provider.id} code=${e?.code || 'unknown'}`,
          );
          results.push(
            publicStatus(provider, { connected: false, status: 'error', connectedAccountId: null }),
          );
        }
      }
      return results;
    },

    async getStatus(userId, providerId) {
      const uid = requireUserId(userId);
      const provider = await resolveProvider(uid, providerId);
      return publicStatus(provider, await backendStatus(uid, provider));
    },

    /**
     * Searchable directory of every connectable app (Composio-managed auth
     * toolkits), with icons and this user's live connection state merged
     * in. Connected apps sort first; the rest keep catalog popularity
     * order. No credentials, ever.
     */
    async searchDirectory(userId, { query = '', limit = 24 } = {}) {
      const uid = requireUserId(userId);
      if (!gateway.isConfigured()) {
        return { unconfigured: true, entries: [], hasMore: false };
      }
      const q = String(query || '').trim().toLowerCase();
      const max = Math.min(Math.max(Number(limit) || 24, 1), 96);

      const connectedBySlug = await gateway.listConnectedToolkits(uid);

      // Self-heal tool rows for apps connected before the bridge existed
      // (or lost to a failed sync). Fire-and-forget: never delays the UI.
      if (toolBridge) {
        toolBridge
          .reconcileToolConnections(
            uid,
            Object.entries(connectedBySlug)
              .filter(([, state]) => state.connected)
              .map(([slug, state]) => ({ toolkit: slug, label: state.name || slug })),
          )
          .catch(() => {});
      }

      // Default view (no query, first page-worth of results): one popularity
      // page paints immediately while the full catalog warms in the
      // background for searches and See-more. Connected apps are always
      // included, even when they fall outside the top page.
      let matches;
      let totalMatches;
      const fastPath =
        !q && max <= 40 && typeof gateway.listToolkitFirstPage === 'function';
      if (fastPath) {
        const page = await gateway.listToolkitFirstPage(uid, { limit: 50 });
        gateway.warmToolkitCatalog?.(uid);
        const bySlug = new Map(page.map((t) => [t.slug, t]));
        for (const [slug, state] of Object.entries(connectedBySlug)) {
          if (!bySlug.has(slug)) {
            bySlug.set(slug, {
              slug,
              name: state.name || slug,
              logoUrl: state.logoUrl || null,
              isNoAuth: false,
            });
          }
        }
        matches = [...bySlug.values()].filter((t) => !t.isNoAuth);
        // The catalog is far larger than one page.
        totalMatches = Infinity;
      } else {
        const catalog = await gateway.listToolkitCatalog(uid);
        matches = catalog.filter(
          (t) =>
            !t.isNoAuth &&
            (!q || t.name.toLowerCase().includes(q) || t.slug.includes(q)),
        );
        totalMatches = matches.length;
      }

      const entries = matches.map((t) => {
        const curated = managedProviderById(t.slug);
        const state = connectedBySlug[t.slug] || {
          connected: false,
          status: 'disconnected',
          connectedAccountId: null,
        };
        return publicStatus(
          {
            id: t.slug,
            label: curated?.label || t.name,
            description:
              curated?.description ||
              `Connect ${t.name} through a managed, revocable connection.`,
            backend: MANAGED_CONNECTION_BACKENDS.COMPOSIO,
            iconUrl: t.logoUrl || null,
          },
          state,
        );
      });
      entries.sort((a, b) => Number(b.connected) - Number(a.connected));
      return {
        unconfigured: false,
        entries: entries.slice(0, max),
        hasMore: totalMatches > max,
      };
    },

    /**
     * Popular connectable apps for the public landing ticker. No user,
     * no connection state, no credentials. Logo URLs are restricted to
     * the Composio logo host.
     */
    async listPublicCatalog({ limit = 48 } = {}) {
      if (!gateway.isConfigured()) {
        return { unconfigured: true, tools: [] };
      }
      const max = Math.min(Math.max(Number(limit) || 48, 1), 50);
      try {
        const page = await gateway.listToolkitFirstPage(PUBLIC_CATALOG_USER_ID, {
          limit: 50,
        });
        return {
          unconfigured: false,
          tools: page.map(toPublicToolkit).filter(Boolean).slice(0, max),
        };
      } catch (e) {
        logger.warn?.(
          `[connections] public catalog failed code=${e?.code || 'unknown'}`,
        );
        return { unconfigured: true, tools: [] };
      }
    },

    /**
     * Start a managed connect. Returns { ok, provider, url } where url is
     * the Composio Connect Link the client should open in the OAuth popup.
     */
    async connect(userId, providerId) {
      const uid = requireUserId(userId);
      const provider = await resolveProvider(uid, providerId);
      const state = await stateStore.issue({ userId: uid, providerId: provider.id });
      const callbackUrl = `${apiBase}/oauth/connections/callback?state=${encodeURIComponent(state)}`;
      const { redirectUrl } = await gateway.createConnectLink(uid, provider.toolkit, {
        callbackUrl,
      });
      logger.log?.(
        `[connections] connect initiated user=${uid} provider=${provider.id} backend=${provider.backend}`,
      );
      return { ok: true, provider: provider.id, url: redirectUrl };
    },

    /**
     * Browser returned to the LYKN callback (project verification OFF).
     * The one-shot state identifies the initiating user; callback query
     * values are hints only — the backend is re-queried for the
     * authoritative connection state.
     */
    async completeCallback({ state }) {
      const bound = await stateStore.consume(state);
      if (!bound) {
        return { ok: false, error: 'invalid_or_expired_state' };
      }
      let provider;
      try {
        provider = await resolveProvider(bound.userId, bound.providerId);
      } catch {
        return { ok: false, error: 'unknown_provider' };
      }
      let status;
      try {
        status = publicStatus(provider, await backendStatus(bound.userId, provider));
        for (let i = 0; i < callbackGrace.attempts && status.status === 'pending'; i++) {
          await sleep(callbackGrace.delayMs);
          status = publicStatus(provider, await backendStatus(bound.userId, provider));
        }
      } catch (e) {
        logger.warn?.(
          `[connections] callback verification failed user=${bound.userId} provider=${provider.id} code=${e?.code || 'unknown'}`,
        );
        return { ok: false, error: 'verification_unavailable', provider: provider.id };
      }
      logger.log?.(
        `[connections] connect callback user=${bound.userId} provider=${provider.id} status=${status.status} account=${status.connectionId || 'none'}`,
      );
      if (!status.connected) {
        return { ok: false, error: 'not_connected', provider: provider.id, status };
      }
      syncToolsAfterConnect(bound.userId, provider);
      return { ok: true, provider: provider.id, userId: bound.userId, status };
    },

    /**
     * Callback identity verification (project verifier URL enabled at
     * Composio). The signed-in renderer posts the single-use session_uri
     * through an authenticated route; completion is bound to the
     * server-derived LYKN user id.
     */
    async completeVerifiedCallback(userId, { sessionUri }) {
      const uid = requireUserId(userId);
      const completed = await gateway.completeAuth(uid, sessionUri);
      let provider;
      try {
        provider =
          managedProviderByToolkit(completed.toolkitSlug) ||
          (await resolveProvider(uid, completed.toolkitSlug));
      } catch {
        logger.warn?.(
          `[connections] verified callback for unknown toolkit user=${uid} toolkit=${completed.toolkitSlug}`,
        );
        return { ok: false, error: 'unknown_provider' };
      }
      const status = publicStatus(provider, await backendStatus(uid, provider));
      logger.log?.(
        `[connections] connect verified user=${uid} provider=${provider.id} status=${status.status} account=${status.connectionId || 'none'}`,
      );
      if (status.connected) syncToolsAfterConnect(uid, provider);
      return { ok: status.connected, provider: provider.id, status };
    },

    /**
     * Disconnect: best-effort revocation of the grant at the provider,
     * then permanent deletion of the connected account at Composio (which
     * drops the tokens Composio holds). The account id comes from this
     * user's own session state, so ownership is guaranteed.
     */
    async disconnect(userId, providerId) {
      const uid = requireUserId(userId);
      const provider = await resolveProvider(uid, providerId);
      const current = await backendStatus(uid, provider);
      if (!current.connectedAccountId) {
        return {
          ok: true,
          provider: provider.id,
          alreadyDisconnected: true,
          status: publicStatus(provider, {
            connected: false,
            status: 'disconnected',
            connectedAccountId: null,
          }),
        };
      }
      const revocation = await gateway.revokeAtProvider(current.connectedAccountId);
      await gateway.deleteConnectedAccount(current.connectedAccountId);
      syncToolsAfterDisconnect(uid, provider);
      logger.log?.(
        `[connections] disconnected user=${uid} provider=${provider.id} account=${current.connectedAccountId} providerRevoked=${revocation.revoked}`,
      );
      return {
        ok: true,
        provider: provider.id,
        providerRevoked: revocation.revoked,
        status: publicStatus(provider, {
          connected: false,
          status: 'disconnected',
          connectedAccountId: null,
        }),
      };
    },
  };
}
