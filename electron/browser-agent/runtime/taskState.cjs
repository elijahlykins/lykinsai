/**
 * Explicit task state for a browser-agent run.
 *
 * Kept in memory for the duration of the task (the agent runtime persists
 * chat history separately); the debug log gives a durable trace.
 */

const crypto = require("node:crypto");

const MAX_RECENT_ACTIONS = 40;

function createTask({ goal, conversationHistory = [] } = {}) {
  return {
    id: `task-${crypto.randomUUID()}`,
    goal: String(goal || "").trim(),
    status: "planning", // planning | working | waiting_for_user | completed | failed
    plan: [], // [{ step, done }]
    currentStep: 0,
    skills: [],
    knownFacts: {},
    constraints: [],
    // The task brief beyond the goal: when the work is DONE (observable, page-
    // checkable) and the adjacent actions the literal request does not license.
    // Written by the planner; rendered around the goal every decide round.
    successCondition: "",
    doNot: [],
    workingMemory: {
      facts: [],
      candidateResults: [],
      openQuestions: [],
      completedSteps: [],
    },
    recentActions: [],
    archivedActionCount: 0,
    retryCount: 0,
    round: 0,
    conversationHistory,
    startedAt: new Date().toISOString(),
    completionReason: "",
  };
}

function setPlan(
  task,
  { plan = [], constraints = [], knownFacts = {}, skills = [], successCondition, doNot } = {},
) {
  task.plan = plan.map((step) => ({ step: String(step), done: false }));
  task.currentStep = 0;
  task.constraints = constraints.map(String);
  task.knownFacts = { ...task.knownFacts, ...knownFacts };
  task.skills = [...new Set([...(task.skills || []), ...skills.map(String)])];
  // The brief survives replans unless the replanner explicitly rewrote it —
  // a mid-task route change does not change what "done" means.
  if (String(successCondition || "").trim()) {
    task.successCondition = String(successCondition).trim();
  }
  if (Array.isArray(doNot) && doNot.length) {
    task.doNot = doNot.map(String).filter(Boolean);
  }
  task.status = "working";
}

function recordAction(task, entry) {
  task.recentActions.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  // Compact old history instead of growing forever: fold the oldest entries
  // into one-line summaries in working memory.
  while (task.recentActions.length > MAX_RECENT_ACTIONS) {
    const old = task.recentActions.shift();
    task.archivedActionCount += 1;
    task.workingMemory.completedSteps.push(summarizeAction(old));
    if (task.workingMemory.completedSteps.length > 60) {
      task.workingMemory.completedSteps.splice(
        0,
        task.workingMemory.completedSteps.length - 60,
      );
    }
  }
}

function summarizeAction(entry) {
  const action = entry?.action || {};
  const bits = [action.type || "action"];
  if (action.target) bits.push(action.target);
  if (action.url) bits.push(String(action.url).slice(0, 60));
  if (action.text) bits.push(`"${String(action.text).slice(0, 30)}"`);
  bits.push(entry?.result === "success" ? "ok" : entry?.result || "?");
  return bits.join(" ");
}

function addFact(task, fact) {
  const text = String(fact || "").trim();
  if (!text) return;
  if (!task.workingMemory.facts.includes(text)) {
    task.workingMemory.facts.push(text);
    if (task.workingMemory.facts.length > 40) task.workingMemory.facts.shift();
  }
}

function markStepDone(task) {
  if (task.plan[task.currentStep]) {
    task.plan[task.currentStep].done = true;
    task.currentStep = Math.min(task.currentStep + 1, task.plan.length);
  }
}

/** The outcome already happened — leftover plan rows are history, not work. */
function markRemainingStepsDone(task) {
  if (!Array.isArray(task.plan)) return;
  for (const step of task.plan) step.done = true;
  task.currentStep = task.plan.length;
}

function hasCommittedDelivery(task) {
  return (task.recentActions || []).some(
    (a) => a.result === "success" && a.committed === true && a.deferred !== true,
  );
}

/**
 * Compact, model-facing rendering of the task state.
 *
 * The task is a full brief, not a bare goal line: what done looks like, the
 * scope wall, the adjacent actions this request does not license, and the
 * order to stop the moment the success condition holds. Agents given only a
 * goal drift into "useful" extra work — organizing the inbox they were asked
 * to check — and browse past the end of the task.
 */
function formatTaskForModel(task) {
  const doNot = [
    ...(task.doNot || []),
    "Continue looking for additional useful work.",
  ];
  const lines = [
    "TASK:",
    task.goal,
    "",
    "SUCCESS CONDITION:",
    task.successCondition ||
      "The user's literal request has been satisfied, with the outcome visible on the page.",
    "",
    "SCOPE:",
    "Perform only actions strictly necessary to satisfy the user's literal request.",
    "",
    "DO NOT:",
    ...doNot.map((d) => `- ${d}`),
    "",
    "STOP RULE:",
    "As soon as the success condition is satisfied, finish. Do not perform optional follow-up work.",
  ];
  if (task.constraints.length) {
    lines.push("", `CONSTRAINTS: ${task.constraints.join("; ")}`);
  }
  if (task.plan.length) {
    lines.push("", "PLAN:");
    task.plan.forEach((p, i) => {
      const marker = p.done ? "[done]" : i === task.currentStep ? "[now]" : "[later]";
      lines.push(`  ${marker} ${p.step}`);
    });
  }
  const facts = task.workingMemory.facts;
  if (facts.length) {
    lines.push("", "FACTS LEARNED:");
    for (const f of facts.slice(-15)) lines.push(`  - ${f}`);
  }
  const candidates = task.workingMemory.candidateResults;
  if (candidates.length) {
    lines.push("", "CANDIDATE RESULTS:");
    for (const c of candidates.slice(-8)) {
      lines.push(`  - ${typeof c === "string" ? c : JSON.stringify(c).slice(0, 200)}`);
    }
  }
  return lines.join("\n");
}

/** Compact recent-action history for the model. */
function formatHistoryForModel(task, { max = 12 } = {}) {
  const lines = [];
  if (task.archivedActionCount > 0) {
    lines.push(`(${task.archivedActionCount} earlier actions summarized in working memory)`);
  }
  for (const entry of task.recentActions.slice(-max)) {
    const a = entry.action || {};
    let line = `${a.type || "action"}`;
    if (a.target) line += ` ${a.target}`;
    if (a.url) line += ` ${String(a.url).slice(0, 80)}`;
    if (a.text) line += ` text="${String(a.text).slice(0, 40)}"`;
    line += ` -> ${entry.result || "?"}`;
    if (entry.observedOutcome) line += ` (${String(entry.observedOutcome).slice(0, 120)})`;
    lines.push(line);
  }
  return lines.length ? lines.join("\n") : "(no actions yet)";
}

/**
 * A restart-safe snapshot of everything the loop needs to continue a task.
 *
 * Long-running task state used to be memory-only: an app restart lost the plan
 * position, gathered facts, and action history, and the user started the whole
 * task again. This is the shape the loop hands to its `onTaskState` hook after
 * every recorded action, and the shape `resumeTask` accepts back. Plain JSON
 * throughout — the caller can write it to disk as-is.
 */
function serializeTask(task) {
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    plan: task.plan.map((p) => ({ step: p.step, done: !!p.done })),
    currentStep: task.currentStep,
    skills: [...task.skills],
    knownFacts: { ...task.knownFacts },
    constraints: [...task.constraints],
    successCondition: task.successCondition,
    doNot: [...(task.doNot || [])],
    workingMemory: {
      facts: [...task.workingMemory.facts],
      candidateResults: [...task.workingMemory.candidateResults],
      openQuestions: [...task.workingMemory.openQuestions],
      completedSteps: [...task.workingMemory.completedSteps],
    },
    recentActions: task.recentActions.slice(-MAX_RECENT_ACTIONS),
    archivedActionCount: task.archivedActionCount,
    round: task.round,
    startedAt: task.startedAt,
    completionReason: task.completionReason,
  };
}

/**
 * Rebuild a task from a serialized snapshot, defensively — the data comes off
 * disk and may be from an older build.
 *
 * @returns {object|null} null when the snapshot is unusable (no goal), in
 *   which case the caller should start a fresh task instead.
 */
function restoreTask(data, { conversationHistory = [] } = {}) {
  if (!data || typeof data !== "object" || !String(data.goal || "").trim()) return null;
  const task = createTask({ goal: data.goal, conversationHistory });
  if (data.id) task.id = String(data.id);
  task.plan = Array.isArray(data.plan)
    ? data.plan
        .map((p) => ({ step: String(p?.step || ""), done: p?.done === true }))
        .filter((p) => p.step)
    : [];
  task.currentStep = Math.min(Math.max(Number(data.currentStep) || 0, 0), task.plan.length);
  task.skills = Array.isArray(data.skills) ? data.skills.map(String) : [];
  task.knownFacts = data.knownFacts && typeof data.knownFacts === "object" ? { ...data.knownFacts } : {};
  task.constraints = Array.isArray(data.constraints) ? data.constraints.map(String) : [];
  task.successCondition = String(data.successCondition || "").trim();
  task.doNot = Array.isArray(data.doNot) ? data.doNot.map(String).filter(Boolean) : [];
  const wm = data.workingMemory && typeof data.workingMemory === "object" ? data.workingMemory : {};
  for (const key of ["facts", "candidateResults", "openQuestions", "completedSteps"]) {
    task.workingMemory[key] = Array.isArray(wm[key]) ? wm[key].map(String) : [];
  }
  task.recentActions = Array.isArray(data.recentActions)
    ? data.recentActions.filter((a) => a && typeof a === "object").slice(-MAX_RECENT_ACTIONS)
    : [];
  task.archivedActionCount = Math.max(0, Number(data.archivedActionCount) || 0);
  task.startedAt = String(data.startedAt || task.startedAt);
  // Rounds spent before the interruption stay visible in the history; the
  // resumed run gets a fresh budget — the restart was not the task's doing.
  task.round = 0;
  task.status = "working";
  task.completionReason = "";
  return task;
}

module.exports = {
  createTask,
  setPlan,
  recordAction,
  addFact,
  markStepDone,
  markRemainingStepsDone,
  hasCommittedDelivery,
  formatTaskForModel,
  formatHistoryForModel,
  serializeTask,
  restoreTask,
};
