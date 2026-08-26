"use strict";

const TASK_STATUSES = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  WAITING_FOR_USER: "waiting_for_user",
  WAITING_FOR_APPROVAL: "waiting_for_approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const TERMINAL_TASK_STATUSES = new Set([
  TASK_STATUSES.COMPLETED,
  TASK_STATUSES.FAILED,
  TASK_STATUSES.CANCELLED,
]);

function freezeValue(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeValue);
    return Object.freeze(value);
  }
  if (!value || typeof value !== "object") return value;
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  Object.values(value).forEach(freezeValue);
  return Object.freeze(value);
}

function boundedNumber(value, fallback, minimum) {
  const number = Number(value);
  return Math.max(minimum, Number.isFinite(number) ? number : fallback);
}

function createTask(input) {
  const objective = String(input?.objective || "").trim();
  if (!objective) throw new TypeError("Task objective is required");
  const id = String(input?.id || "").trim();
  if (!id) throw new TypeError("Task id is required");
  const createdAt = String(input?.createdAt || new Date().toISOString());
  return freezeValue({
    id,
    runId: String(input?.runId || id),
    objective,
    successCriteria: Array.isArray(input?.successCriteria)
      ? input.successCriteria.map(String).filter(Boolean)
      : [],
    scope: {
      summary: String(input?.scope?.summary || "Only work strictly necessary to satisfy the objective."),
      resources: Array.isArray(input?.scope?.resources)
        ? input.scope.resources.map(String).filter(Boolean)
        : [],
    },
    doNot: Array.isArray(input?.doNot) ? input.doNot.map(String).filter(Boolean) : [],
    capabilities: Array.isArray(input?.capabilities)
      ? input.capabilities.map(String).filter(Boolean)
      : [],
    budgets: {
      maxRounds: boundedNumber(input?.budgets?.maxRounds, 12, 1),
      maxRecoveries: boundedNumber(input?.budgets?.maxRecoveries, 2, 0),
      timeoutMs: boundedNumber(input?.budgets?.timeoutMs, 0, 0),
      maxChildExecutors: boundedNumber(input?.budgets?.maxChildExecutors, 8, 0),
    },
    approval: {
      policy: String(input?.approval?.policy || "preserve_executor_security_gates"),
      state: String(input?.approval?.state || "not_requested"),
      request: input?.approval?.request || null,
    },
    cancellation: {
      state: String(input?.cancellation?.state || "active"),
      reason: String(input?.cancellation?.reason || ""),
      signal: input?.cancellation?.signal || null,
    },
    origin: input?.origin || Object.freeze({ type: "unknown" }),
    association: input?.association || Object.freeze({}),
    collaborators: Array.isArray(input?.collaborators)
      ? input.collaborators
          .map((item) => ({
            id: String(item?.id || ""),
            name: String(item?.name || ""),
            role: String(item?.role || ""),
          }))
          .filter((item) => item.id && item.name)
      : [],
    status: String(input?.status || TASK_STATUSES.CREATED),
    createdAt,
    updatedAt: String(input?.updatedAt || createdAt),
    startedAt: input?.startedAt || null,
    finishedAt: input?.finishedAt || null,
    completion: input?.completion || null,
  });
}

function transitionTask(task, patch) {
  return createTask({
    ...task,
    ...patch,
    scope: patch?.scope || task.scope,
    budgets: patch?.budgets || task.budgets,
    approval: patch?.approval || task.approval,
    cancellation: patch?.cancellation || task.cancellation,
    origin: task.origin,
    association: task.association,
    collaborators: task.collaborators,
  });
}

function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.has(status);
}

module.exports = {
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  createTask,
  transitionTask,
  isTerminalTaskStatus,
};
