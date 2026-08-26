"use strict";

const TASK_EVENT_TYPES = Object.freeze({
  CREATED: "task_created",
  STARTED: "task_started",
  EXECUTOR_STARTED: "executor_started",
  PROGRESS: "progress",
  APPROVAL_REQUIRED: "approval_required",
  WAITING_FOR_USER: "waiting_for_user",
  EXECUTOR_COMPLETED: "executor_completed",
  COMPLETED: "task_completed",
  FAILED: "task_failed",
  CANCELLED: "task_cancelled",
});

function createTaskEvent(task, type, detail = {}, at = new Date().toISOString()) {
  return Object.freeze({
    type,
    taskId: task.id,
    runId: task.runId,
    status: task.status,
    at,
    origin: task.origin,
    association: task.association,
    detail: Object.freeze({ ...(detail || {}) }),
  });
}

module.exports = { TASK_EVENT_TYPES, createTaskEvent };
