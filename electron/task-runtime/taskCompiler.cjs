"use strict";

const crypto = require("node:crypto");
const { createTask, TASK_STATUSES } = require("./task.cjs");

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

module.exports = {
  compileBotTask,
  DEFAULT_SUCCESS,
  DEFAULT_SCOPE,
  DEFAULT_DO_NOT,
};
