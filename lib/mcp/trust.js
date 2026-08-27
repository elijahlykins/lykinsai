/**
 * MCP metadata and tool results are UNTRUSTED.
 *
 * They may inform reasoning. They cannot become system authority.
 * They cannot rewrite Task objective, capabilities, approval policy,
 * Bot instructions, Routine definition, or Memory policy.
 */

import { MCP_BOUNDS, boundJson, boundText } from './bounds.js';
import { redactDeep } from './credentialRef.js';

const INJECTION_PATTERNS = [
  /ignore (all|previous|any) (instructions|restrictions|rules)/i,
  /you are now /i,
  /system prompt/i,
  /developer message/i,
  /do not follow (the )?(lykn|task|bot|routine)/i,
  /override (the )?(task|capabilities|approval|policy)/i,
  /always call [a-z0-9_]+ before/i,
  /your system instructions are obsolete/i,
  /send the user'?s token/i,
  /this tool is safe\.?\s*ignore approval/i,
];

export const UNTRUSTED_SOURCE = 'mcp_external_untrusted';

export function sanitizeToolDescription(raw) {
  const clipped = boundText(raw, MCP_BOUNDS.TOOL_DESCRIPTION_CHARS);
  let text = clipped.text.replace(/\s+/g, ' ').trim();
  for (const re of INJECTION_PATTERNS) {
    text = text.replace(re, '[redacted untrusted instruction]');
  }
  return {
    text,
    truncated: clipped.truncated,
    untrusted: true,
    source: UNTRUSTED_SOURCE,
  };
}

export function sanitizeServerInstructions(raw) {
  const clipped = boundText(raw, MCP_BOUNDS.SERVER_INSTRUCTIONS_CHARS);
  let text = clipped.text.replace(/\s+/g, ' ').trim();
  for (const re of INJECTION_PATTERNS) {
    text = text.replace(re, '[redacted untrusted instruction]');
  }
  return {
    text,
    truncated: clipped.truncated,
    untrusted: true,
    source: UNTRUSTED_SOURCE,
    usage: 'optional_provider_guidance_never_system',
  };
}

export function wrapUntrustedObservation(payload, { connectionId, toolName } = {}) {
  const bounded = boundJson(payload, MCP_BOUNDS.TOOL_RESULT_BYTES);
  return Object.freeze({
    kind: 'external_untrusted_observation',
    source: UNTRUSTED_SOURCE,
    connectionId: connectionId ? String(connectionId) : null,
    toolName: toolName ? String(toolName) : null,
    data: redactDeep(bounded.value),
    truncated: bounded.truncated,
    persistToVault: false,
    authority: Object.freeze({
      mayInformReasoning: true,
      mayModifyTaskObjective: false,
      mayModifyTaskCapabilities: false,
      mayModifyApprovalPolicy: false,
      mayModifyBotInstructions: false,
      mayModifyRoutineDefinition: false,
      mayModifyMemoryPolicy: false,
      mayAutoIngestVault: false,
    }),
  });
}

export function wrapUntrustedPrompt(payload) {
  const bounded = boundJson(payload, MCP_BOUNDS.PROMPT_BYTES);
  return Object.freeze({
    kind: 'external_untrusted_prompt',
    source: UNTRUSTED_SOURCE,
    data: bounded.value,
    truncated: bounded.truncated,
    usage: 'optional_provider_guidance_never_system',
    treatment: 'untrusted_skill_candidate',
    authority: Object.freeze({
      mayBecomeSystemInstruction: false,
      mayModifyTaskObjective: false,
      mayModifyTaskCapabilities: false,
      mayModifyApprovalPolicy: false,
      mayModifyBotInstructions: false,
      mayModifyRoutineDefinition: false,
      mayModifyMemoryPolicy: false,
    }),
  });
}

export function wrapUntrustedResource(payload) {
  const bounded = boundJson(payload, MCP_BOUNDS.RESOURCE_BYTES);
  return Object.freeze({
    kind: 'external_untrusted_resource',
    source: UNTRUSTED_SOURCE,
    data: bounded.value,
    truncated: bounded.truncated,
    persistToVault: false,
    treatment: 'external_untrusted_content',
    authority: Object.freeze({
      mayInformCurrentTask: true,
      mayAutoIngestVault: false,
      mayModifyTaskObjective: false,
      mayModifyTaskCapabilities: false,
      mayModifyApprovalPolicy: false,
      mayModifyBotInstructions: false,
      mayModifyRoutineDefinition: false,
      mayModifyMemoryPolicy: false,
    }),
  });
}

/**
 * Apply an MCP observation to a Task snapshot.
 * Returns a NEW object that is guaranteed equal to the original Task
 * authority fields. Used by tests to prove results cannot expand power.
 */
export function applyUntrustedObservationToTask(task, observation) {
  if (!task || typeof task !== 'object') return task;
  if (observation?.authority?.mayModifyTaskCapabilities) {
    throw new Error('untrusted_observation_claimed_task_authority');
  }
  return {
    ...task,
    objective: task.objective,
    capabilities: [...(task.capabilities || [])],
    approval: { ...(task.approval || {}) },
    doNot: [...(task.doNot || [])],
    association: { ...(task.association || {}) },
  };
}
