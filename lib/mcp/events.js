/**
 * Structured MCP events. Never include credentials.
 */

import { redactDeep, assertNoSecretMaterial } from './credentialRef.js';

export const MCP_EVENT_TYPES = Object.freeze({
  CONNECTION_CONNECTED: 'mcp.connection_connected',
  CONNECTION_FAILED: 'mcp.connection_failed',
  CONNECTION_DISCONNECTED: 'mcp.connection_disconnected',
  CONNECTION_AUTHORIZING: 'mcp.connection_authorizing',
  CONNECTION_AUTH_REQUIRED: 'mcp.connection_auth_required',
  TOOL_DISCOVERED: 'mcp.tool_discovered',
  TOOL_CALLED: 'mcp.tool_called',
  TOOL_COMPLETED: 'mcp.tool_completed',
  TOOL_DENIED: 'mcp.tool_denied',
});

export function createMcpEvent(type, detail = {}, at = new Date().toISOString()) {
  const safe = redactDeep({
    type,
    at,
    taskId: detail.taskId || null,
    runId: detail.runId || null,
    connectionId: detail.connectionId || null,
    toolName: detail.toolName || null,
    status: detail.status || null,
    reason: detail.reason || null,
    toolCount: detail.toolCount ?? null,
    semanticCapability: detail.semanticCapability || null,
    consequence: detail.consequence || null,
    approvalDecision: detail.approvalDecision || null,
    latencyMs: detail.latencyMs ?? null,
  });
  assertNoSecretMaterial(safe, type);
  return Object.freeze(safe);
}
