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

function setPlan(task, { plan = [], constraints = [], knownFacts = {}, skills = [] } = {}) {
  task.plan = plan.map((step) => ({ step: String(step), done: false }));
  task.currentStep = 0;
  task.constraints = constraints.map(String);
  task.knownFacts = { ...task.knownFacts, ...knownFacts };
  task.skills = [...new Set([...(task.skills || []), ...skills.map(String)])];
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

/** Compact, model-facing rendering of the task state. */
function formatTaskForModel(task) {
  const lines = [`GOAL: ${task.goal}`];
  if (task.constraints.length) {
    lines.push(`CONSTRAINTS: ${task.constraints.join("; ")}`);
  }
  if (task.plan.length) {
    lines.push("PLAN:");
    task.plan.forEach((p, i) => {
      const marker = p.done ? "[done]" : i === task.currentStep ? "[now]" : "[later]";
      lines.push(`  ${marker} ${p.step}`);
    });
  }
  const facts = task.workingMemory.facts;
  if (facts.length) {
    lines.push("FACTS LEARNED:");
    for (const f of facts.slice(-15)) lines.push(`  - ${f}`);
  }
  const candidates = task.workingMemory.candidateResults;
  if (candidates.length) {
    lines.push("CANDIDATE RESULTS:");
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

module.exports = {
  createTask,
  setPlan,
  recordAction,
  addFact,
  markStepDone,
  formatTaskForModel,
  formatHistoryForModel,
};
