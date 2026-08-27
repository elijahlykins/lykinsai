/**
 * Execute an MCP tool under TaskRuntime authority.
 * Capability check → resolver membership → allowlist → consequence gate → call.
 *
 * MCP responses cannot expand Task authority.
 */

import { CONSEQUENCE, parseCapability, taskHoldsCapability, writeRequiresExplicitConnection } from './capabilityRegistry.js';
import { wrapUntrustedObservation, applyUntrustedObservationToTask } from './trust.js';
import { createMcpEvent, MCP_EVENT_TYPES } from './events.js';
import { mcpCallRequiresApproval } from './consequencePolicy.js';
import { summarizeMcpApproval } from './approvalSummary.js';
import { assertNotConfusedDeputyArgs } from './sensitiveArgs.js';
import { AUTH_REQUIRED_STATUSES, MCP_STATUSES } from './protocol.js';
import { classificationIsStale } from './toolClassifier.js';
import { consumeMcpApprovalToken, mintMcpApprovalToken } from './mcpApprovalTokens.js';

export { mcpCallRequiresApproval };

function taskRestrictsConnections(task) {
  return Boolean(
    task?.origin?.type === 'bot' ||
    task?.origin?.routine ||
    task?.origin?.workflow ||
    task?.association?.botId ||
    task?.association?.routineId ||
    task?.association?.workflowId,
  );
}

function connectionAllowed(task, connectionId) {
  const ids = task?.association?.connectionIds;
  if (Array.isArray(ids)) return ids.map(String).includes(String(connectionId));
  if (taskRestrictsConnections(task)) return false;
  return true;
}

/**
 * HTTP callers cannot attest standing authorization or expand a Bot allowlist.
 * Desktop TaskCompiler remains the only path that copies a persisted Routine
 * approval policy onto a Task.
 */
export function resolveHttpMcpCallAuthority({ incoming = {}, connectionId, body = {} } = {}) {
  const associated = taskRestrictsConnections(incoming);
  const requested = Array.isArray(incoming?.association?.connectionIds)
    ? incoming.association.connectionIds.map(String)
    : null;
  const connectionIds = requested !== null
    ? requested
    : associated
      ? []
      : [String(connectionId || '')].filter(Boolean);
  const capabilities = Array.isArray(incoming?.capabilities)
    ? incoming.capabilities
    : associated
      ? []
      : (Array.isArray(body?.capabilities) ? body.capabilities : []);
  return {
    approval: {
      policy: 'preserve_executor_security_gates',
      state: 'not_requested',
    },
    association: {
      ...(incoming?.association && typeof incoming.association === 'object' ? incoming.association : {}),
      connectionIds,
    },
    capabilities,
    botConnectionIds: connectionIds,
  };
}

export async function executeMcpTool({
  task,
  resolution,
  connectionId,
  toolName,
  args,
  callTool,
  onEvent,
  connection,
  currentTool,
  userId,
  approvalToken,
} = {}) {
  const started = Date.now();
  if (!task) return { ok: false, status: 'failed', reason: 'missing_task' };
  if (task.cancellation?.state === 'cancelled' || task.status === 'cancelled' || task.cancellation?.signal?.aborted) {
    return { ok: false, status: 'cancelled', reason: 'task_cancelled' };
  }

  if (!connectionAllowed(task, connectionId)) {
    onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_DENIED, {
      taskId: task.id, runId: task.runId, connectionId, toolName, reason: 'bot_connection_restricted',
    }));
    return { ok: false, status: 'failed', reason: 'bot_connection_restricted' };
  }

  if (connection?.status && connection.status !== MCP_STATUSES.CONNECTED) {
    if (AUTH_REQUIRED_STATUSES.includes(connection.status)) {
      return {
        ok: false,
        status: 'waiting_for_user',
        reason: 'connection_auth_required',
        condition: 'connection_auth_required',
        connectionId,
      };
    }
    if (connection.status === MCP_STATUSES.DISCONNECTED || connection.status === MCP_STATUSES.REVOKED) {
      return {
        ok: false,
        status: 'failed',
        reason: 'connection_unavailable',
        condition: 'connection_unavailable',
        connectionId,
      };
    }
    if (connection.status === MCP_STATUSES.OFFLINE || connection.status === MCP_STATUSES.ERROR) {
      return {
        ok: false,
        status: 'failed',
        reason: 'connection_unavailable',
        condition: 'connection_unavailable',
        connectionId,
      };
    }
  }

  const selected = (resolution?.tools || []).find(
    (tool) => tool.connectionId === connectionId && tool.toolName === toolName,
  );
  if (!selected) {
    onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_DENIED, { taskId: task.id, runId: task.runId, connectionId, toolName, reason: 'not_in_resolution' }));
    return { ok: false, status: 'failed', reason: 'tool_not_in_resolution' };
  }

  const writeAttempt = writeRequiresExplicitConnection(selected.consequenceHint || selected.consequence);
  if (writeAttempt && currentTool && classificationIsStale(selected, currentTool)) {
    onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_DENIED, {
      taskId: task.id, runId: task.runId, connectionId, toolName, reason: 'schema_changed',
    }));
    return { ok: false, status: 'failed', reason: 'schema_changed', condition: 'classification_stale' };
  }

  try {
    assertNotConfusedDeputyArgs(args);
  } catch (error) {
    onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_DENIED, {
      taskId: task.id, runId: task.runId, connectionId, toolName, reason: error.code,
    }));
    return { ok: false, status: 'failed', reason: error.code };
  }

  const needed = selected.semanticCapabilities?.[0] || selected.capabilities?.[0];
  const hasSemantic = (task.capabilities || []).some((cap) => parseCapability(cap)?.domain && parseCapability(cap).domain !== 'generic');
  if (needed && !taskHoldsCapability(task.capabilities, needed)) {
    if (writeAttempt) {
      onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_DENIED, { taskId: task.id, runId: task.runId, connectionId, toolName, reason: 'capability_missing' }));
      return { ok: false, status: 'failed', reason: 'capability_missing' };
    }
    if (hasSemantic && !taskHoldsCapability(task.capabilities, needed.replace(/\.(write|send|create|update|delete)$/, '.read'))) {
      onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_DENIED, { taskId: task.id, runId: task.runId, connectionId, toolName, reason: 'capability_missing' }));
      return { ok: false, status: 'failed', reason: 'capability_missing' };
    }
  }

  const consequence = selected.consequenceHint || selected.consequence || CONSEQUENCE.READ;
  if (mcpCallRequiresApproval(consequence, task.approval?.policy, { confidence: selected.confidence })) {
    const ownerId = userId || task.userId || connection?.userId;
    const tokenOk = consumeMcpApprovalToken(approvalToken, {
      userId: ownerId,
      connectionId,
      toolName,
      args,
      taskId: task.id,
    });
    if (!tokenOk) {
      const summary = summarizeMcpApproval({ connection, classified: selected, args });
      const minted = mintMcpApprovalToken({
        userId: ownerId,
        connectionId,
        toolName,
        args,
        consequence,
        taskId: task.id,
      });
      onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_DENIED, {
        taskId: task.id,
        runId: task.runId,
        connectionId,
        toolName,
        reason: 'approval_required',
        consequence,
        semanticCapability: needed,
        approvalDecision: 'required',
      }));
      return {
        ok: false,
        status: 'waiting_for_approval',
        reason: 'approval_required',
        consequence,
        approvalToken: minted,
        request: summary,
      };
    }
  }

  const signal = task.cancellation?.signal;
  try {
    const result = await callTool({
      connectionId,
      toolName,
      args,
      signal,
      taskId: task.id,
      runId: task.runId,
    });
    if (signal?.aborted) {
      return { ok: false, status: 'cancelled', reason: 'task_cancelled', ignored: true };
    }
    if (connection?.status === MCP_STATUSES.DISCONNECTED || connection?.sessionEpoch !== undefined && result?.sessionEpoch != null && result.sessionEpoch !== connection.sessionEpoch) {
      return { ok: false, status: 'cancelled', reason: 'connection_disconnected', ignored: true };
    }
    const observation = result?.kind === 'external_untrusted_observation' ? result : wrapUntrustedObservation(result, { connectionId, toolName });
    applyUntrustedObservationToTask(task, observation);
    onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_COMPLETED, {
      taskId: task.id,
      runId: task.runId,
      connectionId,
      toolName,
      status: 'ok',
      consequence,
      semanticCapability: needed,
      approvalDecision: task.approval?.state || 'not_required',
      latencyMs: Date.now() - started,
    }));
    return {
      ok: true,
      status: 'completed',
      observation,
      output: observation,
    };
  } catch (error) {
    if (signal?.aborted || error?.code === 'aborted') {
      return { ok: false, status: 'cancelled', reason: 'task_cancelled', ignored: true };
    }
    if (error?.code === 'authentication_required' || error?.code === 'invalid_grant') {
      return {
        ok: false,
        status: 'waiting_for_user',
        reason: 'connection_auth_required',
        condition: 'connection_auth_required',
        connectionId,
      };
    }
    onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_COMPLETED, {
      taskId: task.id,
      runId: task.runId,
      connectionId,
      toolName,
      status: 'error',
      reason: error.code || 'tool_failed',
      latencyMs: Date.now() - started,
    }));
    return { ok: false, status: 'failed', reason: String(error?.code || error?.message || error) };
  }
}
