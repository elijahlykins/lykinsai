/**
 * The "I'm waiting on you" row beside an agent's conversation.
 *
 * A parked run — sign-in wall, SMS code, a captcha, an approval — ends its turn
 * like any other, so the working spinner goes away. Something has to stay on
 * screen with a live pulse, or a run that is still waiting looks like a run that
 * finished, and the user reads "Waiting for you" as a closing remark instead of
 * a request.
 *
 * The runtime announces the pause twice, on purpose:
 *
 * 1. `lykn:agent-waiting`, a one-shot event with the best label and the exact
 *    ask ("Enter the code sent to the number ending 4094").
 * 2. `waiting` on the agent itself, which rides along on every list, progress,
 *    and switch payload.
 *
 * Only the second survives. A rail that mounted after the pause, reloaded, or
 * was looking at another tab when the event fired never receives the first one,
 * and that is exactly when a paused run is most likely to be mistaken for a
 * finished one. So state decides whether the row shows and the event only
 * improves what it says.
 */

/**
 * @param {{ waiting?: boolean, step?: string, waitingKind?: string,
 *   waitingDetail?: string, waitingHost?: string } | null} agent the active
 *   agent as published by the runtime
 * @param {{ label?: string, detail?: string } | null} [fromEvent] the row built
 *   from the last `lykn:agent-waiting` for this agent, when we caught one
 * @returns {{ label: string, detail: string } | null} null when nothing is
 *   waiting on the user
 */
export function agentWaitingRow(agent, fromEvent = null) {
  if (fromEvent && String(fromEvent.label || "").trim()) {
    return {
      label: String(fromEvent.label).trim(),
      detail: String(fromEvent.detail || "").trim(),
      // "question" gets its own answer card over the chat bar; everything
      // else renders as the plain waiting row.
      kind: String(fromEvent.kind || "").trim(),
      options: answerOptions(fromEvent.options),
    };
  }
  if (!agent?.waiting) return null;
  const host = String(agent.waitingHost || "").trim();
  // `step` is already written for a person ("Waiting for you: enter the code"),
  // so prefer it and only describe the pause generically as a last resort.
  const label =
    String(agent.step || "").trim() ||
    (String(agent.waitingKind || "") === "signin"
      ? `Waiting for you to sign in${host ? ` to ${host}` : ""}`
      : "Waiting for you");
  return {
    label,
    detail: String(agent.waitingDetail || "").trim(),
    kind: String(agent.waitingKind || "").trim(),
    options: answerOptions(agent.waitingOptions),
  };
}

/**
 * One-tap answers a question pause may carry. Buttons, so: trimmed, capped,
 * and never more than the four the runtime allows — a rail that renders a
 * malformed payload as chips is worse than one that renders none.
 */
function answerOptions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((o) => String(o || "").replace(/\s+/g, " ").trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 4);
}

export default agentWaitingRow;
