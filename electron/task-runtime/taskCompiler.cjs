"use strict";

const crypto = require("node:crypto");
const { createTask, TASK_STATUSES } = require("./task.cjs");
const { compileLocalCapabilities } = require("./executors/localCapabilities.cjs");

const DEFAULT_SUCCESS =
  "The requested work has been performed and the requested result can be returned.";
const DEFAULT_SCOPE = "Perform only work strictly necessary to satisfy the user's literal request.";
const DEFAULT_DO_NOT = "Continue looking for additional useful work.";

function newTaskId() {
  return `task_${crypto.randomBytes(12).toString("hex")}`;
}

function cleanList(value, limit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function sanitizeBot(bot) {
  if (!bot || typeof bot !== "object") return null;
  const out = {
    id: String(bot.id || "").trim().slice(0, 120),
    name: String(bot.name || "").trim().slice(0, 60),
    role: String(bot.role || "").trim().slice(0, 80),
    persona: String(bot.persona || "").trim().slice(0, 1200),
    face: String(bot.face || "").trim().slice(0, 60),
    eyes: String(bot.eyes || "").trim().slice(0, 60),
    color: String(bot.color || "").trim().slice(0, 60),
  };
  return out.id || out.name || out.persona ? out : null;
}

/**
 * Compile facts already known at the Bot invocation boundary.
 * This compiler does no model call and performs no semantic expansion.
 */
function compileBotTask(input = {}, options = {}) {
  const objective = String(input.objective || input.text || "").trim();
  if (!objective) throw new TypeError("Bot task objective is required");
  const now = String(options.now || new Date().toISOString());
  const id = String(options.id || newTaskId());
  const explicitDoNot = cleanList(input.doNot, 12);
  const doNot = explicitDoNot.includes(DEFAULT_DO_NOT)
    ? explicitDoNot
    : [...explicitDoNot, DEFAULT_DO_NOT];
  const bot = sanitizeBot(input.bot);
  return createTask({
    id,
    runId: id,
    objective,
    successCriteria: cleanList(input.successCriteria, 8).length
      ? cleanList(input.successCriteria, 8)
      : [DEFAULT_SUCCESS],
    scope: {
      summary: String(input.scope?.summary || input.scope || DEFAULT_SCOPE).trim() || DEFAULT_SCOPE,
      resources: cleanList(input.scope?.resources, 20),
    },
    doNot,
    capabilities: cleanList(input.capabilities, 20),
    budgets: {
      maxRounds: input.budgets?.maxRounds,
      maxRecoveries: input.budgets?.maxRecoveries,
      timeoutMs: input.budgets?.timeoutMs,
      maxChildExecutors: input.budgets?.maxChildExecutors,
    },
    approval: {
      policy: "preserve_executor_security_gates",
      state: "not_requested",
    },
    cancellation: {
      state: "active",
      signal: options.signal || null,
    },
    origin: {
      type: "bot",
      bot,
    },
    association: {
      botId: String(input.botId || bot?.id || "").trim(),
      botTaskId: String(input.botTaskId || "").trim(),
      chatId: String(input.chatId || "").trim(),
      agentId: String(input.agentId || "").trim(),
      parentTaskId: String(input.parentTaskId || "").trim(),
    },
    collaborators: (Array.isArray(input.teammates) ? input.teammates : [])
      .map((teammate) => ({
        id: String(teammate?.id || "").trim().slice(0, 120),
        name: String(teammate?.name || "").trim().slice(0, 60),
        role: String(teammate?.role || "").trim().slice(0, 80),
      }))
      .filter((teammate) => teammate.id && teammate.name),
    status: TASK_STATUSES.CREATED,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Compile a dedicated local-computer Task for a normal Agent.
 * Capabilities are derived from the objective unless the caller supplies them.
 * This compiler does no model call and does not broaden read-only asks.
 */
function compileLocalTask(input = {}, options = {}) {
  const objective = String(input.objective || input.text || "").trim();
  if (!objective) throw new TypeError("Local task objective is required");
  const now = String(options.now || new Date().toISOString());
  const id = String(options.id || newTaskId());
  const explicitDoNot = cleanList(input.doNot, 12);
  const doNot = explicitDoNot.includes(DEFAULT_DO_NOT)
    ? explicitDoNot
    : [...explicitDoNot, DEFAULT_DO_NOT];
  return createTask({
    id,
    runId: id,
    objective,
    successCriteria: cleanList(input.successCriteria, 8).length
      ? cleanList(input.successCriteria, 8)
      : [DEFAULT_SUCCESS],
    scope: {
      summary: String(input.scope?.summary || input.scope || DEFAULT_SCOPE).trim() || DEFAULT_SCOPE,
      resources: cleanList(input.scope?.resources, 20),
    },
    doNot,
    capabilities: compileLocalCapabilities(objective, {
      explicit: cleanList(input.capabilities, 20),
    }),
    budgets: {
      maxRounds: input.budgets?.maxRounds,
      maxRecoveries: input.budgets?.maxRecoveries,
      timeoutMs: input.budgets?.timeoutMs,
      maxChildExecutors: input.budgets?.maxChildExecutors,
    },
    approval: {
      policy: "preserve_executor_security_gates",
      state: "not_requested",
    },
    cancellation: {
      state: "active",
      signal: options.signal || null,
    },
    origin: input.origin || { type: "agent" },
    association: {
      agentId: String(input.agentId || input.association?.agentId || "").trim(),
      chatId: String(input.chatId || input.association?.chatId || "").trim(),
      parentTaskId: String(input.parentTaskId || input.association?.parentTaskId || "").trim(),
    },
    status: TASK_STATUSES.CREATED,
    createdAt: now,
    updatedAt: now,
  });
}

/** Default wall-clock ceiling for an unattended routine occurrence. */
const ROUTINE_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Compile one Routine occurrence into a canonical Task.
 *
 * The DURABLE Routine definition is the authority: the objective is built
 * from the stored instructions every time, so accumulated model reasoning
 * from past runs can never rewrite what the Routine does. The current
 * occurrence's trigger context (which file appeared, which process exited)
 * travels as a clearly-labeled factual context block — data for this run,
 * never a new instruction.
 *
 * Capabilities and approval policy come from the Routine record verbatim.
 * Monitored external content has no path into this compiler, so it cannot
 * expand capabilities, change the approval policy, or alter the objective.
 */
function compileRoutineTask(input = {}, options = {}) {
  const routine = input.routine && typeof input.routine === "object" ? input.routine : {};
  const instructions = String(routine.instructions || "").trim();
  if (!instructions) throw new TypeError("Routine task requires routine.instructions");
  if (!String(routine.id || "").trim()) throw new TypeError("Routine task requires routine.id");
  const now = String(options.now || new Date().toISOString());
  const id = String(options.id || newTaskId());

  // Whitelisted, bounded trigger facts. Anything else in the context object
  // is dropped — the trigger cannot smuggle prose into the objective.
  const context = input.triggerContext && typeof input.triggerContext === "object" ? input.triggerContext : {};
  const contextLines = [];
  if (context.reason) contextLines.push(`Trigger: ${String(context.reason).slice(0, 120)}`);
  if (context.occurredAt) contextLines.push(`Occurred at: ${String(context.occurredAt).slice(0, 40)}`);
  if (context.late === true) contextLines.push("This occurrence ran late (the machine was asleep at the scheduled time).");
  if (context.path) contextLines.push(`Watched path: ${String(context.path).slice(0, 300)}`);
  if (Array.isArray(context.files) && context.files.length) {
    contextLines.push(`Files: ${context.files.map((f) => String(f).slice(0, 120)).slice(0, 20).join(", ")}`);
  }
  if (context.processName) contextLines.push(`Process: ${String(context.processName).slice(0, 120)}`);

  const objective = contextLines.length
    ? `${instructions}\n\n[Current occurrence]\n${contextLines.join("\n")}`
    : instructions;

  const bot = sanitizeBot(routine.bot || input.bot);
  return createTask({
    id,
    runId: String(input.runId || id),
    objective,
    successCriteria: [DEFAULT_SUCCESS],
    scope: {
      summary: DEFAULT_SCOPE,
      resources: [],
    },
    doNot: [
      "Modify this routine's own definition, schedule, or permissions.",
      DEFAULT_DO_NOT,
    ],
    capabilities: cleanList(routine.capabilities, 20),
    budgets: {
      maxRounds: input.budgets?.maxRounds,
      maxRecoveries: input.budgets?.maxRecoveries,
      timeoutMs: Number.isFinite(input.budgets?.timeoutMs)
        ? input.budgets.timeoutMs
        : ROUTINE_DEFAULT_TIMEOUT_MS,
      maxChildExecutors: input.budgets?.maxChildExecutors,
    },
    approval: {
      policy:
        String(routine.approvalPolicy || "") === "standing_authorization"
          ? "standing_authorization"
          : "preserve_executor_security_gates",
      state: "not_requested",
    },
    cancellation: {
      state: "active",
      signal: options.signal || null,
    },
    origin: {
      type: "bot",
      bot,
      routine: {
        id: String(routine.id),
        name: String(routine.name || "").slice(0, 80),
        triggerType: String(routine.trigger?.type || ""),
      },
    },
    association: {
      botId: String(routine.botId || bot?.id || "").trim(),
      routineId: String(routine.id),
      routineRunId: String(input.runId || "").trim(),
      chatId: String(routine.bot?.chatId || "").trim(),
      agentId: String(input.agentId || "").trim(),
    },
    status: TASK_STATUSES.CREATED,
    createdAt: now,
    updatedAt: now,
  });
}

module.exports = {
  compileBotTask,
  compileLocalTask,
  compileRoutineTask,
  compileLocalCapabilities,
  DEFAULT_SUCCESS,
  DEFAULT_SCOPE,
  DEFAULT_DO_NOT,
  ROUTINE_DEFAULT_TIMEOUT_MS,
};
