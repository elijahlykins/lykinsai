/**
 * Decide whether the agent rail should offer choice buttons, and with what.
 *
 * The runtime asks a question by emitting "lykn:agent-choice" with
 * `{ agentId, choiceId, type, message, buttons: [{ id, label, primary }] }`,
 * and accepts the answer through resolveChoice(agentId, { choiceId, buttonId }).
 *
 * Two rules do all the work here, and both come from the runtime's own shape:
 *
 * 1. **Live events only.** `agent.pendingChoice` is held in memory and is
 *    deliberately not persisted, so it does not survive a restart. A button
 *    rebuilt from restored agent state would resolve to "no_pending_choice" —
 *    it would look answerable and do nothing. So this never derives a row from
 *    agent status; it only shapes an event the caller actually received.
 *
 * 2. **Ids pass through untouched.** resolveChoice matches exact ids per type
 *    (approve/decline, send/keep, use-artifact/stop). Normalising or renaming
 *    one silently turns an approval into a decline.
 *
 * Note that status is NOT a usable gate: browse-, local- and complex-tool
 * choices set status "waiting", but `offerSendApprovalChoice` does not. Gating
 * on "waiting" would hide the send-approval buttons entirely.
 */
export function agentChoiceRow(choice, activeAgentId) {
  if (!choice || !activeAgentId) return null;
  // The rail shows one agent; a choice raised by a background agent belongs to
  // that agent's own thread, not to whatever the user is looking at now.
  if (choice.agentId && choice.agentId !== activeAgentId) return null;

  const buttons = (Array.isArray(choice.buttons) ? choice.buttons : [])
    .filter((b) => b && String(b.id || "").trim())
    .map((b) => ({
      id: String(b.id).trim(),
      label: String(b.label || "").trim() || String(b.id).trim(),
      primary: !!b.primary,
    }));
  if (!buttons.length) return null;

  return {
    agentId: choice.agentId || activeAgentId,
    choiceId: String(choice.choiceId || ""),
    type: String(choice.type || ""),
    message: String(choice.message || ""),
    buttons,
  };
}
