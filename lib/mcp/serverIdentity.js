/**
 * Persist enough MCP server identity to detect unexpected endpoint changes.
 *
 * Origin + authorization-server issuer changes are mismatches.
 * Server version upgrades are NOT mismatches.
 */

import { createHash } from 'node:crypto';

function originOf(raw) {
  try {
    return new URL(String(raw || '')).origin;
  } catch {
    return '';
  }
}

export function buildServerIdentity({
  serverUrl,
  serverInfo = {},
  authorizationServerUrl = '',
  resource = '',
} = {}) {
  const origin = originOf(serverUrl);
  const issuer = originOf(authorizationServerUrl) || String(authorizationServerUrl || '');
  const name = String(serverInfo?.name || '');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ origin, issuer, name }))
    .digest('hex')
    .slice(0, 24);
  return Object.freeze({
    origin,
    serverName: name,
    serverVersion: String(serverInfo?.version || ''),
    authorizationServer: issuer,
    resource: String(resource || ''),
    fingerprint,
  });
}

export function compareServerIdentity(previous, next) {
  if (!previous || !next) return { mismatch: false, reason: null };
  if (previous.origin && next.origin && previous.origin !== next.origin) {
    return { mismatch: true, reason: 'origin_changed' };
  }
  if (
    previous.authorizationServer &&
    next.authorizationServer &&
    previous.authorizationServer !== next.authorizationServer
  ) {
    return { mismatch: true, reason: 'authorization_server_changed' };
  }
  return { mismatch: false, reason: null };
}

export function publicIdentity(identity) {
  if (!identity || typeof identity !== 'object') return {};
  return {
    origin: identity.origin || null,
    serverName: identity.serverName || null,
    serverVersion: identity.serverVersion || null,
    authorizationServer: identity.authorizationServer || null,
  };
}
