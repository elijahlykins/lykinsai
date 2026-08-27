/**
 * Consequence policy at the MCP boundary.
 *
 * Classification describes the tool. Task capabilities remain authority.
 *
 * READ            → execute
 * WRITE           → execute when Task capability explicitly permits
 *                   (low-confidence unknown writes escalate to CONSEQUENTIAL)
 * CONSEQUENTIAL   → live approval unless standing_authorization
 * DESTRUCTIVE     → live approval always
 * SENSITIVE       → live approval / human takeover hint
 */

import { CONSEQUENCE } from './capabilityRegistry.js';

export function mcpCallRequiresApproval(consequence, approvalPolicy, { confidence = 1 } = {}) {
  if (consequence === CONSEQUENCE.READ) return false;
  if (consequence === CONSEQUENCE.WRITE) {
    if (confidence < 0.5) return approvalPolicy !== 'standing_authorization';
    return false;
  }
  if (consequence === CONSEQUENCE.CONSEQUENTIAL) {
    return approvalPolicy !== 'standing_authorization';
  }
  return consequence === CONSEQUENCE.DESTRUCTIVE || consequence === CONSEQUENCE.SENSITIVE;
}

export function approvalKindForConsequence(consequence) {
  if (consequence === CONSEQUENCE.DESTRUCTIVE) return 'live_approval';
  if (consequence === CONSEQUENCE.SENSITIVE) return 'human_takeover';
  if (consequence === CONSEQUENCE.CONSEQUENTIAL) return 'live_approval';
  if (consequence === CONSEQUENCE.WRITE) return 'capability_gated';
  return 'none';
}
