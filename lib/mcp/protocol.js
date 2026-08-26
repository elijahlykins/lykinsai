/**
 * MCP protocol assumptions for LYKN.
 *
 * LYKN is an MCP CLIENT only. It does not expose an inbound MCP server.
 *
 * Spec:
 *   Model Context Protocol revision used by @modelcontextprotocol/sdk@1.30.0
 *   (Streamable HTTP, JSON-RPC 2.0). Authorization follows the MCP OAuth
 *   profile: RFC 9728 protected-resource metadata, RFC 8414 authorization
 *   server metadata, PKCE S256, authorization-code + refresh.
 *
 * Transport:
 *   Remote MCP uses Streamable HTTP (the current recommended remote transport).
 *   Legacy HTTP+SSE is not implemented.
 *   Local stdio is not implemented; the client runtime is transport-pluggable.
 *
 * Auth:
 *   none | bearer (credentialRef) | oauth (MCP authorization-code).
 *   OAuth is standards-compliant. It is not a provider-specific dialect.
 *   Client credentials / JWT bearer grants are not used for user connections.
 *
 * Authority:
 *   The MCP server is never Task authority. TaskRuntime owns objective,
 *   capabilities, approvals, cancellation, and budgets.
 */

export const MCP_CLIENT_NAME = 'LYKN';
export const MCP_CLIENT_VERSION = '1.0.23';

export const MCP_TRANSPORTS = Object.freeze({
  STREAMABLE_HTTP: 'streamable_http',
  STDIO: 'stdio',
});

export const MCP_AUTH_MODES = Object.freeze({
  NONE: 'none',
  BEARER: 'bearer',
  OAUTH: 'oauth',
});

export const MCP_STATUSES = Object.freeze({
  CONNECTED: 'connected',
  AUTHENTICATION_REQUIRED: 'authentication_required',
  AUTHORIZING: 'authorizing',
  REFRESHING: 'refreshing',
  OFFLINE: 'offline',
  ERROR: 'error',
  REVOKED: 'revoked',
  DISCONNECTED: 'disconnected',
});

/**
 * Product trust classification for an MCP server.
 * Never bypasses Task capabilities or consequence approval.
 *
 * User-entered URLs default to CUSTOM. TLS success does not promote trust.
 * local_trusted is an explicit private-network path (fixtures / loopback).
 * Phase 1 `remote` remains as a synonym of custom for URL policy.
 */
export const MCP_TRUST_LEVELS = Object.freeze({
  OFFICIAL: 'official',
  VERIFIED: 'verified',
  COMMUNITY: 'community',
  CUSTOM: 'custom',
  LOCAL_TRUSTED: 'local_trusted',
  ENTERPRISE: 'enterprise',
  REMOTE: 'remote',
});

export const MCP_DEFAULT_TRANSPORT = MCP_TRANSPORTS.STREAMABLE_HTTP;
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const CLASSIFIER_VERSION = 'deterministic_v2';

export const AUTH_REQUIRED_STATUSES = Object.freeze([
  MCP_STATUSES.AUTHENTICATION_REQUIRED,
  MCP_STATUSES.AUTHORIZING,
  MCP_STATUSES.REVOKED,
]);

export function isRemoteNetworkTrust(trustLevel) {
  return trustLevel !== MCP_TRUST_LEVELS.LOCAL_TRUSTED;
}

export function defaultTrustLevelForUserUrl() {
  return MCP_TRUST_LEVELS.CUSTOM;
}
