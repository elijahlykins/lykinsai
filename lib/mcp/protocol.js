/**
 * MCP protocol assumptions for LYKN Phase 1.
 *
 * LYKN is an MCP CLIENT only. It does not expose an inbound MCP server.
 *
 * Spec:
 *   Model Context Protocol revision used by @modelcontextprotocol/sdk@1.30.0
 *   (Streamable HTTP, JSON-RPC 2.0).
 *
 * Transport:
 *   Remote MCP uses Streamable HTTP (the current recommended remote transport).
 *   Legacy HTTP+SSE is not implemented.
 *   Local stdio is not implemented in Phase 1; the client runtime is transport-
 *   pluggable so stdio can be added later without changing TaskRuntime.
 *
 * Auth (Phase 1):
 *   none | bearer token referenced by credentialRef.
 *   Full MCP OAuth (protected-resource metadata, DCR, refresh/revoke) is Phase 2.
 *   We do not fake OAuth. A 401 without a usable credentialRef becomes
 *   status=authentication_required.
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
});

export const MCP_STATUSES = Object.freeze({
  CONNECTED: 'connected',
  AUTHENTICATION_REQUIRED: 'authentication_required',
  OFFLINE: 'offline',
  ERROR: 'error',
  REFRESHING: 'refreshing',
  DISCONNECTED: 'disconnected',
});

export const MCP_TRUST_LEVELS = Object.freeze({
  REMOTE: 'remote',
  LOCAL_TRUSTED: 'local_trusted',
});

export const MCP_DEFAULT_TRANSPORT = MCP_TRANSPORTS.STREAMABLE_HTTP;
export const MCP_PROTOCOL_VERSION = '2025-06-18';
