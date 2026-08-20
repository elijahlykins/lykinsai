/**
 * Who holds the browser: the agent, or the person watching it.
 *
 * Only one of them at a time. This used to be a paragraph in AGENTS.md asking
 * the model to notice when the user had stepped in, which meant it was advice
 * rather than a rule: nothing stopped the agent carrying on clicking while the
 * user was typing into the same tab, and the two of them fought over the page.
 *
 * Three states:
 *   agent      — the agent may act. The starting state.
 *   delegated  — the agent handed off and is waiting. It may take control back,
 *                because it is the one that gave it up.
 *   user       — the user took control. The agent may NOT take it back. Only an
 *                explicit release, driven by the user answering in the UI,
 *                returns control.
 *
 * That asymmetry is the whole design. A hand-off is the agent's own decision
 * and reversing it is safe. A seizure is the user overruling the agent, usually
 * because it is going wrong, and an agent that can undo it has not been stopped
 * at all.
 *
 * The suppression window exists because Electron raises `input-event` for
 * synthetic input too, so every click the agent makes looks exactly like the
 * user grabbing the wheel. Without it the first click of every run would seize
 * the browser away from the agent and the task would deadlock immediately. The
 * depth counter handles actions that actuate more than once, and the grace
 * window covers events that arrive after `sendInputEvent` has returned.
 */

/** How long after an agent action its input events may still arrive. */
const DEFAULT_GRACE_MS = 250;

function createOwnership({ now = () => Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  let state = "agent";
  let why = "";
  /** Nesting depth of in-flight agent actions. */
  let agentDepth = 0;
  /** When the last agent action finished, for the trailing grace window. */
  let agentInputEndedAt = -Infinity;

  function agentIsActuating() {
    return agentDepth > 0 || now() - agentInputEndedAt < graceMs;
  }

  return {
    state: () => state,
    reason: () => why,
    mayAct: () => state === "agent",

    handOff(reason = "") {
      state = "delegated";
      why = String(reason || "waiting for the user");
      return { ok: true, state };
    },

    /** Reclaim after our own hand-off. Never valid against a user seizure. */
    takeOver() {
      if (state === "user") return { ok: false, state, error: "user_controlling" };
      state = "agent";
      why = "";
      return { ok: true, state };
    },

    seize(reason = "") {
      state = "user";
      why = String(reason || "the user took control of the browser");
      return { ok: true, state };
    },

    /** The user has finished and handed the browser back, in so many words. */
    release() {
      state = "agent";
      why = "";
      // A release ends any in-flight suppression: whatever the agent thought it
      // was doing happened before the user intervened.
      agentDepth = 0;
      agentInputEndedAt = -Infinity;
      return { ok: true, state };
    },

    /**
     * Real input landed in the agent's tab.
     * @returns {boolean} true when this input took control away from the agent.
     */
    noteInput(source = "user") {
      if (source === "agent" || agentIsActuating()) return false;
      if (state === "user") return false;
      this.seize("the user acted in the browser");
      return true;
    },

    beginAgentInput() {
      agentDepth += 1;
    },

    endAgentInput() {
      agentDepth = Math.max(0, agentDepth - 1);
      if (agentDepth === 0) agentInputEndedAt = now();
    },
  };
}

module.exports = { createOwnership, DEFAULT_GRACE_MS };
