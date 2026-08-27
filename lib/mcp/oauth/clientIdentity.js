/**
 * LYKN OAuth client identity for MCP authorization.
 *
 * Supported mechanisms (MCP 2025-06-18 / SDK 1.30.0):
 *   1. RFC 9728 protected-resource metadata
 *   2. RFC 8414 authorization-server metadata
 *   3. Authorization-code + PKCE S256
 *   4. SEP-991 URL-based client IDs when the AS advertises support
 *   5. RFC 7591 dynamic client registration as fallback
 *   6. Pre-registered public client when MCP_OAUTH_CLIENT_ID is set
 *
 * Not implemented: client_credentials, JWT bearer, device code, implicit.
 */

import { MCP_CLIENT_NAME, MCP_CLIENT_VERSION } from '../protocol.js';

export const MCP_OAUTH_CALLBACK_PATH = '/oauth/mcp/callback';
export const MCP_OAUTH_CLIENT_METADATA_PATH = '/oauth/mcp/client-metadata';

export function mcpPublicApiBase(port = process.env.PORT || 3001) {
  const raw =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${port}`;
  return String(raw).replace(/\/$/, '');
}

export function mcpOAuthRedirectUri(port) {
  return `${mcpPublicApiBase(port)}${MCP_OAUTH_CALLBACK_PATH}`;
}

export function mcpOAuthClientMetadataUrl(port) {
  return `${mcpPublicApiBase(port)}${MCP_OAUTH_CLIENT_METADATA_PATH}`;
}

export function lyknOAuthClientMetadata({ redirectUri, clientMetadataUrl } = {}) {
  const redirect = String(redirectUri || mcpOAuthRedirectUri());
  return {
    client_name: MCP_CLIENT_NAME,
    client_uri: 'https://lykn.io',
    redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    software_id: 'lykn-mcp-client',
    software_version: MCP_CLIENT_VERSION,
    ...(clientMetadataUrl ? { client_id: clientMetadataUrl } : {}),
  };
}

export function publicClientMetadataDocument({ redirectUri } = {}) {
  return lyknOAuthClientMetadata({ redirectUri });
}

export function preRegisteredClientInformation() {
  const clientId = String(process.env.MCP_OAUTH_CLIENT_ID || '').trim();
  if (!clientId) return null;
  const clientSecret = String(process.env.MCP_OAUTH_CLIENT_SECRET || '').trim() || undefined;
  return {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  };
}
