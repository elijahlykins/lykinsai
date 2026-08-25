/**
 * Planner — converts a user goal into an editable high-level plan and revises
 * it when the environment makes the original plan obsolete.
 */

const contextRouter = require("./contextRouter.cjs");
const instructions = require("./instructions.cjs");
const taskState = require("./taskState.cjs");
const { formatSnapshotForModel } = require("../browser/snapshot.cjs");

async function planTask({ model, task, snapshot = null, userMemory = "", websiteMemory = "", signal = null }) {
  const heuristicSkills = contextRouter.routeSkills(task.goal);
  const user = [
    `USER GOAL:\n${task.goal}`,
    task.conversationHistory?.length
      ? `RECENT CONVERSATION:\n${formatConversation(task.conversationHistory)}`
      : "",
    userMemory ? `REMEMBERED ABOUT THE USER:\n${userMemory.slice(0, 1200)}` : "",
    // What we already know about this product shapes the plan far more than it
    // shapes any single click — "templates are under Create > Email" is a step,
    // not a tactic. The planner was the one stage never shown it.
    websiteMemory ? `ALREADY KNOWN ABOUT THIS SITE:\n${websiteMemory.slice(0, 1500)}` : "",
    `AVAILABLE SKILLS: ${instructions.listSkills().join(", ") || "(none)"}`,
    snapshot ? `CURRENT PAGE:\n${formatSnapshotForModel(snapshot, { maxElements: 25, maxTextChars: 1200 })}` : "",
    `TODAY: ${new Date().toDateString()}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await model.plan({
    system: contextRouter.buildPlanningSystem(),
    user,
    signal,
  });

  const skills = knownSkills(result.skills, heuristicSkills);
  taskState.setPlan(task, {
    plan: result.plan.length ? result.plan : [`Work toward: ${task.goal}`],
    constraints: result.constraints || [],
    knownFacts: result.knownFacts,
    skills,
    // The rest of the task brief: what done looks like, and the adjacent
    // actions the literal request does not license.
    successCondition: result.successCondition,
    doNot: result.doNot,
  });
  return {
    clarification: result.clarification,
    // Tappable answers for the clarification, when the model proposed any.
    clarificationOptions: result.clarificationOptions || [],
    approach: result.approach || "",
  };
}

/** Only skills that actually exist. A hallucinated name loads nothing and
 * accumulates in task state forever. */
function knownSkills(...lists) {
  const available = instructions.listSkills();
  return [...new Set(lists.flat().filter(Boolean).map(String))].filter((s) => available.includes(s));
}

/**
 * @param {Array<string>|null} [constraints] the constraints the ACTOR says still
 *   apply. null means it said nothing. An empty array means none of them do —
 *   which is the only way a constraint can ever be retired, and used to be
 *   indistinguishable from silence.
 */
async function replanTask({ model, task, snapshot, reason = "", constraints = null, signal = null }) {
  const user = [
    `USER GOAL:\n${task.goal}`,
    `CURRENT TASK STATE:\n${taskState.formatTaskForModel(task)}`,
    `RECENT ACTIONS:\n${taskState.formatHistoryForModel(task)}`,
    `WHY THE CURRENT PLAN NO LONGER FITS:\n${reason || "(unknown)"}`,
    Array.isArray(constraints)
      ? `THE AGENT REPORTS THESE CONSTRAINTS STILL APPLY: ${constraints.join("; ") || "(none — the rest have been overtaken by what it found on the page)"}`
      : "",
    snapshot ? `CURRENT PAGE:\n${formatSnapshotForModel(snapshot, { maxElements: 30, maxTextChars: 1500 })}` : "",
    "Produce a REVISED plan for the remaining work only. Keep knownFacts consistent with what was already learned.",
    "Constraints bind the finished outcome, never the route. If one is now blocking the only route to the outcome, drop it: return the constraints that still apply, or an empty array if none do.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await model.plan({
    system: contextRouter.buildPlanningSystem(),
    user,
    signal,
  });
  if (result.plan.length) {
    // Precedence: what the actor said on the page, then what the replanner
    // said, then what we already had. Each level can return an empty array to
    // mean "none of them still apply" — the old code read empty as silence, so
    // a constraint recorded at plan time could never be retired for the life
    // of the task, which disabled replanning as an escape from a bad one.
    const revised = Array.isArray(constraints)
      ? constraints
      : Array.isArray(result.constraints)
        ? result.constraints
        : task.constraints;
    taskState.setPlan(task, {
      plan: result.plan,
      constraints: revised,
      knownFacts: result.knownFacts,
      skills: knownSkills(result.skills),
      // setPlan keeps the existing brief when these come back empty — a route
      // change mid-task does not change what "done" means.
      successCondition: result.successCondition,
      doNot: result.doNot,
    });
  }
  return { clarification: result.clarification };
}

function formatConversation(history) {
  return history
    .slice(-6)
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${String(m.content || "").slice(0, 300)}`)
    .join("\n");
}

module.exports = { planTask, replanTask };
