/**
 * Execute an MCP tool under TaskRuntime authority.
 * Capability check → resolver membership → consequence gate → call → untrusted wrap.
 */

import { CONSEQUENCE, parseCapability, taskHoldsCapability, writeRequiresExplicitConnection } from './capabilityRegistry.js';
import { wrapUntrustedObservation } from './trust.js';
import { createMcpEvent, MCP_EVENT_TYPES } from './events.js';

export function mcpCallRequiresApproval(consequence, approvalPolicy) {
  if (approvalPolicy === 'standing_authorization' && consequence !== CONSEQUENCE.DESTRUCTIVE) {
    return false;
  }
  return (
    consequence === CONSEQUENCE.WRITE ||
    consequence === CONSEQUENCE.CONSEQUENTIAL ||
    consequence === CONSEQUENCE.DESTRUCTIVE ||
    consequence === CONSEQUENCE.SENSITIVE
  );
}

export async function executeMcpTool({
  task,
  resolution,
  connectionId,
  toolName,
  args,
  callTool,
  onEvent,
} = {}) {
  if (!task) return { ok: false, status: 'failed', reason: 'missing_task' };
  if (task.cancellation?.state === 'cancelled' || task.status === 'cancelled' || task.cancellation?.signal?.aborted) {
    return { ok: false, status: 'cancelled', reason: 'task_cancelled' };
  }

  const selected = (resolution?.tools || []).find(
    (tool) => tool.connectionId === connectionId && tool.toolName === toolName,
  );
  if (!selected) {
    onEvent?.(createMcpEvent(MCP_EVENT_TYPES.TOOL_DENIED, { taskId: task.id, runId: task.runId, connectionId, toolName, reason: 'not_in_resolution' }));
    return { ok: false, status: 'failed', reason: 'tool_not_in_resolution' };
  }

  const needed = selected.semanticCapabilities?.[0];
  const writeAttempt = writeRequiresExplicitConnection(selected.consequenceHint);
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

  if (mcpCallRequiresApproval(selected.consequenceHint, task.approval?.policy)) {
    if (task.approval?.state !== 'approved') {
      return {
        ok: false,
        status: 'waiting_for_approval',
        reason: 'approval_required',
        consequence: selected.consequenceHint,
        request: {
          kind: 'mcp_tool',
          connectionId,
          toolName,
          consequence: selected.consequenceHint,
        },
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
    const observation = result?.kind === 'external_untrusted_observation' ? result : wrapUntrustedObservation(result, { connectionId, toolName });
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
    return { ok: false, status: 'failed', reason: String(error?.code || error?.message || error) };
  }
}
