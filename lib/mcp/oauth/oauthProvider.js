/**
 * SDK OAuthClientProvider backed by LYKN credentialRef storage.
 *
 * Model reasoning never participates. Tokens stay in encrypted store.
 */

import {
  auth,
  discoverOAuthServerInfo,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { createGuardedFetch, assertOAuthUrlSafe } from '../urlPolicy.js';
import {
  lyknOAuthClientMetadata,
  mcpOAuthClientMetadataUrl,
  mcpOAuthRedirectUri,
  preRegisteredClientInformation,
} from './clientIdentity.js';
import { newOAuthState } from './oauthSession.js';
import { assertAuthorizationServerSafe, assertProtectedResourceSafe } from './endpointPolicy.js';

function asTokens(blob) {
  if (!blob || typeof blob !== 'object') return undefined;
  if (!blob.access_token) return undefined;
  return {
    access_token: blob.access_token,
    token_type: blob.token_type || 'Bearer',
    refresh_token: blob.refresh_token,
    expires_in: blob.expires_in,
    scope: blob.scope,
  };
}

export function createLyknOAuthProvider({
  connection,
  store,
  sessionStore,
  redirectUri,
  trustLevel,
  onRedirect,
} = {}) {
  const fetchFn = createGuardedFetch({ trustLevel: trustLevel || connection.trustLevel });
  const redirect = String(redirectUri || mcpOAuthRedirectUri());
  const clientMetadataUrl = mcpOAuthClientMetadataUrl();
  const blob = decryptOAuthBlob(store, connection) || {};
  let pendingState = null;
  let capturedRedirect = null;
  let memoryClient = blob.client || connection.oauthClient || preRegisteredClientInformation();
  let memoryDiscovery = blob.discovery || connection.oauthDiscovery || null;
  let memoryVerifier = null;

  const provider = {
    get redirectUrl() {
      return redirect;
    },
    get clientMetadataUrl() {
      return /^https:/i.test(clientMetadataUrl) ? clientMetadataUrl : undefined;
    },
    get clientMetadata() {
      return lyknOAuthClientMetadata({ redirectUri: redirect });
    },
    async state() {
      if (!pendingState) {
        pendingState = newOAuthState();
        await sessionStore.save({
          state: pendingState,
          userId: connection.userId,
          connectionId: connection.id,
          redirectUri: redirect,
          authorizationServerUrl: memoryDiscovery?.authorizationServerUrl,
        });
      }
      return pendingState;
    },
    async clientInformation() {
      return memoryClient || preRegisteredClientInformation() || undefined;
    },
    async saveClientInformation(info) {
      memoryClient = info;
      await persistOAuth(store, connection, { oauthClient: info });
    },
    async tokens() {
      const full = await store.get(connection.userId, connection.id);
      const blob = decryptOAuthBlob(store, full);
      return asTokens(blob?.tokens);
    },
    async saveTokens(tokens) {
      const expiresAt =
        tokens.expires_in != null ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null;
      await persistOAuth(store, connection, {
        tokens: { ...tokens, expires_at: expiresAt },
        oauthClient: memoryClient,
        oauthDiscovery: memoryDiscovery,
      });
    },
    async redirectToAuthorization(authorizationUrl) {
      capturedRedirect = String(authorizationUrl);
      onRedirect?.(capturedRedirect);
    },
    async saveCodeVerifier(codeVerifier) {
      memoryVerifier = codeVerifier;
      if (pendingState) {
        await sessionStore.update(pendingState, { codeVerifier });
      }
    },
    async codeVerifier() {
      if (memoryVerifier) return memoryVerifier;
      if (pendingState) {
        const row = await sessionStore.peek(pendingState);
        if (row?.codeVerifier) return row.codeVerifier;
      }
      throw new Error('missing_pkce_verifier');
    },
    async saveDiscoveryState(state) {
      memoryDiscovery = state;
      await persistOAuth(store, connection, { oauthDiscovery: state });
    },
    async discoveryState() {
      return memoryDiscovery || undefined;
    },
    async invalidateCredentials(scope) {
      if (scope === 'tokens' || scope === 'all') {
        await persistOAuth(store, connection, { tokens: null, clearTokens: true });
      }
      if (scope === 'client' || scope === 'all') {
        memoryClient = preRegisteredClientInformation();
        await persistOAuth(store, connection, { oauthClient: memoryClient });
      }
      if (scope === 'verifier' || scope === 'all') {
        memoryVerifier = null;
      }
      if (scope === 'discovery' || scope === 'all') {
        memoryDiscovery = null;
        await persistOAuth(store, connection, { oauthDiscovery: null });
      }
    },
    async validateResourceURL(serverUrl, resource) {
      try {
        const expected = new URL(String(serverUrl));
        if (!resource) return expected;
        const got = new URL(String(resource));
        if (got.origin !== expected.origin) {
          throw new Error('resource_origin_mismatch');
        }
        return got;
      } catch (error) {
        if (error.message === 'resource_origin_mismatch') throw error;
        return new URL(String(serverUrl));
      }
    },
  };

  return {
    provider,
    fetchFn,
    getAuthorizationUrl() {
      return capturedRedirect;
    },
    attachSession(session) {
      pendingState = session.state;
      memoryVerifier = session.codeVerifier;
    },
  };
}

export function decryptOAuthBlob(store, connection) {
  const blob = connection?.oauthEncrypted;
  if (!blob) return null;
  try {
    const raw = store.decrypt ? store.decrypt(blob) : blob;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function persistOAuth(store, connection, { tokens, oauthClient, oauthDiscovery, clearTokens } = {}) {
  const current = decryptOAuthBlob(store, await store.get(connection.userId, connection.id)) || {};
  const next = {
    tokens: clearTokens ? null : tokens !== undefined ? tokens : current.tokens || null,
    client: oauthClient !== undefined ? oauthClient : current.client || null,
    discovery: oauthDiscovery !== undefined ? oauthDiscovery : current.discovery || null,
  };
  const json = JSON.stringify(next);
  const encrypted = store.encrypt ? store.encrypt(json) : json;
  await store.update(connection.userId, connection.id, { oauthEncrypted: encrypted });
}

export async function discoverAuthorization({ serverUrl, trustLevel, resourceMetadataUrl } = {}) {
  const fetchFn = createGuardedFetch({ trustLevel });
  const info = await discoverOAuthServerInfo(serverUrl, { resourceMetadataUrl, fetchFn });
  if (info?.resourceMetadata) {
    const resourceCheck = await assertProtectedResourceSafe(info.resourceMetadata, { trustLevel });
    if (!resourceCheck.ok) {
      const err = new Error(`ssrf_blocked:${resourceCheck.error}`);
      err.code = 'SSRF_BLOCKED';
      err.reason = resourceCheck.error;
      throw err;
    }
  }
  if (info?.authorizationServerMetadata) {
    const asCheck = await assertAuthorizationServerSafe(info.authorizationServerMetadata, { trustLevel });
    if (!asCheck.ok) {
      const err = new Error(`ssrf_blocked:${asCheck.error}`);
      err.code = 'SSRF_BLOCKED';
      err.reason = asCheck.endpoint ? `${asCheck.endpoint}:${asCheck.error}` : asCheck.error;
      throw err;
    }
  }
  if (info?.authorizationServerUrl) {
    const issuerCheck = await assertOAuthUrlSafe(info.authorizationServerUrl, { trustLevel });
    if (!issuerCheck.ok) {
      const err = new Error(`ssrf_blocked:${issuerCheck.error}`);
      err.code = 'SSRF_BLOCKED';
      err.reason = issuerCheck.error;
      throw err;
    }
  }
  return info;
}

export async function runMcpAuth(providerBundle, options) {
  return auth(providerBundle.provider, {
    serverUrl: options.serverUrl,
    authorizationCode: options.authorizationCode,
    scope: options.scope,
    resourceMetadataUrl: options.resourceMetadataUrl,
    fetchFn: providerBundle.fetchFn,
  });
}
