"use strict";

const crypto = require("node:crypto");
const { createTask, TASK_STATUSES } = require("./task.cjs");
const { compileLocalCapabilities } = require("./executors/localCapabilities.cjs");
const { compileRemoteCapabilities } = require("../remote/remotePolicy.cjs");

const DEFAULT_SUCCESS =
  "The requested work has been performed and the requested result can be returned.";
const DEFAULT_SCOPE = "Perform only work strictly necessary to satisfy the user's literal request.";
const DEFAULT_DO_NOT = "Continue looking for additional useful work.";

/** Default envelope for a dedicated browse Task. Never includes browser.eval. */
const DEFAULT_BROWSER_CAPABILITIES = [
  "browser.read",
  "browser.navigate",
  "browser.interact",
];

/**
 * Default Bot capability envelope at the compiler boundary.
 * Local computer is added only when Local Mode is on; browser.eval is never granted.
 */
function defaultBotCapabilities({ localMode = false } = {}) {
  return [
    "reply",
    "research_report",
    "edit_report",
    "build_artifact",
    "generate_image",
    ...(localMode ? ["local_computer"] : []),
    "browser",
  ];
}

/**
 * Browser capability strings for a dedicated browse Task.
 * This compiler does no model call and does not infer extra capabilities from prose.
 */
function compileBrowserCapabilities(_objective, { explicit } = {}) {
  const listed = cleanList(explicit, 20);
  if (listed.some((cap) => cap === "browser" || cap.startsWith("browser."))) {
    return listed;
  }
  return DEFAULT_BROWSER_CAPABILITIES.slice();
}

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
  const connectionIds = cleanConnectionIds(bot.connectionIds);
  const out = {
    id: String(bot.id || "").trim().slice(0, 120),
    name: String(bot.name || "").trim().slice(0, 60),
    role: String(bot.role || "").trim().slice(0, 80),
    persona: String(bot.persona || "").trim().slice(0, 1200),
    face: String(bot.face || "").trim().slice(0, 60),
    eyes: String(bot.eyes || "").trim().slice(0, 60),
    color: String(bot.color || "").trim().slice(0, 60),
  };
  if (connectionIds !== undefined) out.connectionIds = connectionIds;
  return out.id || out.name || out.persona ? out : null;
}

function cleanConnectionIds(value) {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      list
        .map((item) => String(item || "").trim())
        .filter((id) => {
          if (!id || id.length > 80) return false;
          if (/token|secret|bearer|password/i.test(id)) return false;
          if (id.includes(".")) return false;
          return /^[a-zA-Z0-9_-]+$/.test(id);
        }),
    ),
  ].slice(0, 20);
}

/**
 * Trusted Bot/Routine allowlists are the authority.
 * Request-supplied ids may only narrow; they cannot expand.
 */
function intersectConnectionIds(trusted, requested) {
  const trustedIds = cleanConnectionIds(trusted);
  const requestedIds = cleanConnectionIds(requested);
  if (trustedIds === undefined) return requestedIds;
  if (requestedIds === undefined) return trustedIds;
  const allowed = new Set(trustedIds);
  return requestedIds.filter((id) => allowed.has(id));
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
      ...(intersectConnectionIds(bot?.connectionIds, input.connectionIds) !== undefined
        ? { connectionIds: intersectConnectionIds(bot?.connectionIds, input.connectionIds) }
        : {}),
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

/**
 * Compile a dedicated browser Task for a normal Agent (or a Bot continuation
 * that needs a fresh browse envelope). Capabilities are the default browse
 * set unless the caller supplies an explicit browser.* list.
 * This compiler does no model call and does not grant browser.eval.
 */
function compileBrowserTask(input = {}, options = {}) {
  const objective = String(input.objective || input.text || "").trim();
  if (!objective) throw new TypeError("Browser task objective is required");
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
    capabilities: compileBrowserCapabilities(objective, {
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

/**
 * Compile a remote (SSH) Task. The target is referenced by ID in association —
 * never by address, and never with credentials: the RemoteExecutor's host seam
 * resolves the address and authRef from the RemoteTarget store in trusted host
 * code. Capabilities are derived conservatively from the objective unless the
 * caller (a routine record, a saved-target default) supplies them.
 *
 * This compiler does no model call and does not broaden diagnostic asks.
 */
function compileRemoteTask(input = {}, options = {}) {
  const objective = String(input.objective || input.text || "").trim();
  if (!objective) throw new TypeError("Remote task objective is required");
  const remoteTargetId = String(input.remoteTargetId || "").trim();
  if (!remoteTargetId) throw new TypeError("Remote task requires remoteTargetId");
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
    capabilities: compileRemoteCapabilities(objective, {
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
      remoteTargetId,
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
  const directWorkflowRun =
    String(routine.kind || "") === "learned_workflow" && String(routine.workflowId || "").trim();
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
  if (context.url) contextLines.push(`Watched URL: ${String(context.url).slice(0, 300)}`);
  if (context.title) contextLines.push(`Page title: ${String(context.title).slice(0, 120)}`);
  if (context.appName) contextLines.push(`App: ${String(context.appName).slice(0, 80)}`);
  if (context.from) contextLines.push(`From: ${String(context.from).slice(0, 80)}`);
  if (context.to) contextLines.push(`To: ${String(context.to).slice(0, 80)}`);
  if (context.summary) contextLines.push(`Observed: ${String(context.summary).slice(0, 240)}`);

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
      ...(routine.workflowId ? ["Modify the learned workflow definition while executing it."] : []),
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
      ...(directWorkflowRun
        ? {
            workflow: {
              id: String(routine.workflowId).trim().slice(0, 120),
              name: String(routine.name || "").slice(0, 80),
              version: Math.max(1, Number(routine.workflowVersion) || 1),
            },
          }
        : {
            routine: {
              id: String(routine.id),
              name: String(routine.name || "").slice(0, 80),
              triggerType: String(routine.trigger?.type || ""),
              ...(routine.workflowId
                ? { workflowId: String(routine.workflowId).trim().slice(0, 120) }
                : {}),
            },
          }),
    },
    association: {
      botId: String(routine.botId || bot?.id || "").trim(),
      ...(!directWorkflowRun
        ? {
            routineId: String(routine.id),
            routineRunId: String(input.runId || "").trim(),
          }
        : {}),
      ...(routine.workflowId
        ? { workflowId: String(routine.workflowId).trim().slice(0, 120) }
        : {}),
      chatId: String(routine.bot?.chatId || "").trim(),
      agentId: String(input.agentId || "").trim(),
      ...(intersectConnectionIds(
        routine.connectionIds ?? bot?.connectionIds,
        input.connectionIds,
      ) !== undefined
        ? {
            connectionIds: intersectConnectionIds(
              routine.connectionIds ?? bot?.connectionIds,
              input.connectionIds,
            ),
          }
        : {}),
    },
    status: TASK_STATUSES.CREATED,
    createdAt: now,
    updatedAt: now,
  });
}

module.exports = {
  compileBotTask,
  compileLocalTask,
  compileBrowserTask,
  compileRemoteTask,
  compileRoutineTask,
  compileLocalCapabilities,
  compileRemoteCapabilities,
  compileBrowserCapabilities,
  defaultBotCapabilities,
  DEFAULT_BROWSER_CAPABILITIES,
  DEFAULT_SUCCESS,
  DEFAULT_SCOPE,
  DEFAULT_DO_NOT,
  ROUTINE_DEFAULT_TIMEOUT_MS,
};
