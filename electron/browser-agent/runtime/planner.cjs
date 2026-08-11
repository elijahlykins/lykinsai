/**
 * Planner — converts a user goal into an editable high-level plan and revises
 * it when the environment makes the original plan obsolete.
 */

const contextRouter = require("./contextRouter.cjs");
const instructions = require("./instructions.cjs");
const taskState = require("./taskState.cjs");
const { formatSnapshotForModel } = require("../browser/snapshot.cjs");

async function planTask({ model, task, snapshot = null, userMemory = "" }) {
  const heuristicSkills = contextRouter.routeSkills(task.goal);
  const user = [
    `USER GOAL:\n${task.goal}`,
    task.conversationHistory?.length
      ? `RECENT CONVERSATION:\n${formatConversation(task.conversationHistory)}`
      : "",
    userMemory ? `REMEMBERED ABOUT THE USER:\n${userMemory.slice(0, 1200)}` : "",
    `AVAILABLE SKILLS: ${instructions.listSkills().join(", ") || "(none)"}`,
    snapshot ? `CURRENT PAGE:\n${formatSnapshotForModel(snapshot, { maxElements: 25, maxTextChars: 1200 })}` : "",
    `TODAY: ${new Date().toDateString()}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await model.plan({
    system: contextRouter.buildPlanningSystem(),
    user,
  });

  const skills = [...new Set([...heuristicSkills, ...result.skills])].filter((s) =>
    instructions.listSkills().includes(s),
  );
  taskState.setPlan(task, {
    plan: result.plan.length ? result.plan : [`Work toward: ${task.goal}`],
    constraints: result.constraints,
    knownFacts: result.knownFacts,
    skills,
  });
  return { clarification: result.clarification };
}

async function replanTask({ model, task, snapshot, reason = "" }) {
  const user = [
    `USER GOAL:\n${task.goal}`,
    `CURRENT TASK STATE:\n${taskState.formatTaskForModel(task)}`,
    `RECENT ACTIONS:\n${taskState.formatHistoryForModel(task)}`,
    `WHY THE CURRENT PLAN NO LONGER FITS:\n${reason || "(unknown)"}`,
    snapshot ? `CURRENT PAGE:\n${formatSnapshotForModel(snapshot, { maxElements: 30, maxTextChars: 1500 })}` : "",
    "Produce a REVISED plan for the remaining work only. Keep constraints and knownFacts consistent with what was already learned.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await model.plan({
    system: contextRouter.buildPlanningSystem(),
    user,
  });
  if (result.plan.length) {
    taskState.setPlan(task, {
      plan: result.plan,
      constraints: result.constraints.length ? result.constraints : task.constraints,
      knownFacts: result.knownFacts,
      skills: result.skills,
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
