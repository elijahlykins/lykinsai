/**
 * Working memory for one Bot task: what was asked, what has run, what came
 * back, and which tool docs have been read. Formatted for the model every
 * round in the user message so the system prompt stays byte-stable.
 */

function createTaskState({
  goal,
  primaryTool = "",
  successCondition = "",
  doNot = [],
  collaborators = [],
  authoritativeBrief = false,
} = {}) {
  return {
    goal: String(goal || "").trim(),
    round: 0,
    /** Tool docs read so far — the progressive-disclosure ledger. */
    docsLoaded: new Set(primaryTool ? [primaryTool] : []),
    /** Every event this task, in order: doc reads, tool runs, verifications. */
    events: [],
    /** How many tools actually executed (doc reads don't count). */
    executed: 0,
    /** Recovery budget: verification failures + tool errors we retried. */
    recoveries: 0,
    /** Standing guidance from the last failed verification / tool error. */
    guidance: "",
    /** Set once the loop pushed back on an empty-handed delivery. */
    deliverPushbackUsed: false,
    /** Verified tool deliverables (report documents, artifacts, images) —
     * carried on every finish so the chat can render persistent cards even
     * when the deliver answer is a short close or the round budget ran out. */
    deliverables: [],
    /** Canonical Task constraints outrank any planning suggestion the model
     * returns. Legacy direct callers can still let the first decision fill
     * these fields until they migrate behind TaskRuntime. */
    successCondition: String(successCondition || "").trim().slice(0, 600),
    doNot: (Array.isArray(doNot) ? doNot : [])
      .map((d) => String(d || "").trim())
      .filter(Boolean)
      .slice(0, 12),
    authoritativeBrief: authoritativeBrief === true,
    collaborators: Array.isArray(collaborators) ? collaborators : [],
  };
}

/** First non-empty definition wins — the brief never changes mid-task. */
function setTaskBrief(state, { successCondition, doNot } = {}) {
  if (state.authoritativeBrief) return;
  if (!state.successCondition && String(successCondition || "").trim()) {
    state.successCondition = String(successCondition).trim().slice(0, 300);
  }
  if (!state.doNot.length && Array.isArray(doNot) && doNot.length) {
    state.doNot = doNot
      .map((d) => String(d || "").trim())
      .filter(Boolean)
      .slice(0, 6);
  }
}

function recordDocRead(state, toolName) {
  state.docsLoaded.add(toolName);
  state.events.push({ kind: "doc", tool: toolName });
}

function recordToolRun(state, { tool, instruction, ok, summary }) {
  state.executed += 1;
  state.events.push({
    kind: "tool",
    tool,
    instruction: String(instruction || "").slice(0, 600),
    ok: ok !== false,
    summary: String(summary || "").slice(0, 800),
  });
}

function recordVerification(state, { tool, success, evidence, reason }) {
  state.events.push({
    kind: "verify",
    tool,
    success: success === true,
    detail: String((success === true ? evidence : reason) || "").slice(0, 400),
  });
}

/**
 * Keep a verified tool deliverable for the finish payload. One card per tool
 * per task: a verify-retry that rewrote the same report replaces the earlier
 * copy instead of stacking two cards.
 */
function recordDeliverable(state, { tool, deliverable }) {
  if (!deliverable || typeof deliverable !== "object") return;
  const entry = { ...deliverable, tool: String(tool || "") };
  const existing = state.deliverables.findIndex((d) => d.tool === entry.tool);
  if (existing >= 0) state.deliverables[existing] = entry;
  else state.deliverables.push(entry);
}

function recordNote(state, note) {
  state.events.push({ kind: "note", note: String(note || "").slice(0, 300) });
}

/** Approval outcomes are part of the record — a declined send must never be
 * retried or reported as done. */
function recordApproval(state, { tool, approved }) {
  state.events.push({ kind: "approval", tool, approved: approved === true });
}

function formatEventsForModel(state) {
  if (!state.events.length) return "(nothing has run yet)";
  return state.events
    .map((e, i) => {
      const n = i + 1;
      if (e.kind === "doc") return `${n}. read the instructions for \`${e.tool}\``;
      if (e.kind === "tool") {
        return `${n}. ${e.tool}("${e.instruction}") → ${e.ok ? "ok" : "FAILED"}: ${e.summary || "(no output)"}`;
      }
      if (e.kind === "verify") {
        return `${n}. verification of ${e.tool} → ${e.success ? "confirmed" : "NOT confirmed"}: ${e.detail}`;
      }
      if (e.kind === "approval") {
        return `${n}. user ${e.approved ? "APPROVED" : "DECLINED"} the ${e.tool} action`;
      }
      return `${n}. note: ${e.note}`;
    })
    .join("\n");
}

module.exports = {
  createTaskState,
  setTaskBrief,
  recordDocRead,
  recordToolRun,
  recordVerification,
  recordDeliverable,
  recordNote,
  recordApproval,
  formatEventsForModel,
};
