/**
 * Validate every advertised OAuth endpoint independently.
 * MCP-returned metadata is not implicitly trusted.
 */

import { assertOAuthUrlSafe } from '../urlPolicy.js';

const ENDPOINT_KEYS = [
  'authorization_endpoint',
  'token_endpoint',
  'registration_endpoint',
  'revocation_endpoint',
  'introspection_endpoint',
  'jwks_uri',
];

export async function assertAuthorizationServerSafe(metadata, { trustLevel } = {}) {
  if (!metadata || typeof metadata !== 'object') {
    return { ok: false, error: 'missing_authorization_server_metadata' };
  }
  if (metadata.issuer) {
    const issuer = await assertOAuthUrlSafe(metadata.issuer, { trustLevel });
    if (!issuer.ok) return { ok: false, error: `issuer_${issuer.error}`, endpoint: 'issuer' };
  }
  for (const key of ENDPOINT_KEYS) {
    if (!metadata[key]) continue;
    const check = await assertOAuthUrlSafe(metadata[key], { trustLevel });
    if (!check.ok) {
      return { ok: false, error: check.error, endpoint: key };
    }
  }
  return { ok: true };
}

export async function assertProtectedResourceSafe(resourceMetadata, { trustLevel } = {}) {
  if (!resourceMetadata) return { ok: true };
  if (resourceMetadata.resource) {
    const check = await assertOAuthUrlSafe(resourceMetadata.resource, { trustLevel });
    if (!check.ok) return { ok: false, error: check.error, endpoint: 'resource' };
  }
  for (const url of resourceMetadata.authorization_servers || []) {
    const check = await assertOAuthUrlSafe(url, { trustLevel });
    if (!check.ok) return { ok: false, error: check.error, endpoint: 'authorization_servers' };
  }
  return { ok: true };
}
