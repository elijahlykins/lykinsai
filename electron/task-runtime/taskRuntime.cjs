"use strict";

const { compileBotTask } = require("./taskCompiler.cjs");
const {
  TASK_STATUSES,
  createTask,
  transitionTask,
  isTerminalTaskStatus,
} = require("./task.cjs");
const { TASK_EVENT_TYPES, createTaskEvent } = require("./taskEvents.cjs");

class TaskRuntime {
  constructor({ onEvent = () => {}, now = () => new Date().toISOString() } = {}) {
    this.onEvent = onEvent;
    this.now = now;
    this.records = new Map();
    this.botTaskIndex = new Map();
  }

  createBotTask(input = {}) {
    const existing = input.botTaskId ? this.getByBotTaskId(input.botTaskId) : null;
    if (existing && !isTerminalTaskStatus(existing.status)) return existing;
    const controller = new AbortController();
    const task = compileBotTask(input, {
      signal: controller.signal,
      now: this.now(),
    });
    this.records.set(task.id, {
      task,
      controller,
      version: 0,
      started: false,
      result: null,
      timeout: null,
    });
    if (task.association.botTaskId) {
      this.botTaskIndex.set(task.association.botTaskId, task.id);
    }
    this.emit(task, TASK_EVENT_TYPES.CREATED);
    return task;
  }

  register(task) {
    if (!task?.id) throw new TypeError("Task id is required");
    if (this.records.has(task.id)) return this.records.get(task.id).task;
    const controller = new AbortController();
    const canonical = createTask({
      ...task,
      cancellation: {
        ...task.cancellation,
        signal: controller.signal,
      },
    });
    this.records.set(canonical.id, {
      task: canonical,
      controller,
      version: 0,
      started: canonical.status !== TASK_STATUSES.CREATED,
      result: null,
      timeout: null,
    });
    this.emit(canonical, TASK_EVENT_TYPES.CREATED);
    return canonical;
  }

  get(taskId) {
    return this.records.get(String(taskId || ""))?.task || null;
  }

  getByBotTaskId(botTaskId) {
    const taskId = this.botTaskIndex.get(String(botTaskId || ""));
    return taskId ? this.get(taskId) : null;
  }

  waitForUser(taskId, detail = {}) {
    const record = this.records.get(String(taskId || ""));
    if (!record || isTerminalTaskStatus(record.task.status)) return record?.task || null;
    record.version += 1;
    this.update(record, { status: TASK_STATUSES.WAITING_FOR_USER });
    this.emit(record.task, TASK_EVENT_TYPES.WAITING_FOR_USER, detail);
    return record.task;
  }

  requireApproval(taskId, request = {}) {
    const record = this.records.get(String(taskId || ""));
    if (!record || isTerminalTaskStatus(record.task.status)) return record?.task || null;
    this.update(record, {
      status: TASK_STATUSES.WAITING_FOR_APPROVAL,
      approval: { ...record.task.approval, state: "required", request },
    });
    this.emit(record.task, TASK_EVENT_TYPES.APPROVAL_REQUIRED, request);
    return record.task;
  }

  resolveApproval(taskId, approved) {
    const record = this.records.get(String(taskId || ""));
    if (!record || isTerminalTaskStatus(record.task.status)) return record?.task || null;
    this.update(record, {
      status: TASK_STATUSES.RUNNING,
      approval: {
        ...record.task.approval,
        state: approved ? "approved" : "declined",
        request: null,
      },
    });
    return record.task;
  }

  emit(task, type, detail = {}) {
    const event = createTaskEvent(task, type, detail, this.now());
    try {
      this.onEvent(event);
    } catch {
      // Runtime state must not depend on an observer.
    }
    return event;
  }

  update(record, patch) {
    record.task = transitionTask(record.task, {
      ...patch,
      updatedAt: this.now(),
    });
    return record.task;
  }

  async execute(taskOrId, executor, context = {}) {
    const taskId = typeof taskOrId === "string" ? taskOrId : taskOrId?.id;
    const record = this.records.get(String(taskId || ""));
    if (!record) throw new Error("unknown_task");
    if (isTerminalTaskStatus(record.task.status)) {
      return { task: record.task, result: record.result, ignored: true };
    }
    if (!executor || (typeof executor !== "function" && typeof executor.execute !== "function")) {
      return this.fail(record.task.id, "executor_unavailable");
    }

    const version = ++record.version;
    const startedAt = record.task.startedAt || this.now();
    this.update(record, {
      status: TASK_STATUSES.RUNNING,
      startedAt,
      approval: { ...record.task.approval, state: "not_requested", request: null },
    });
    if (!record.started) {
      record.started = true;
      this.emit(record.task, TASK_EVENT_TYPES.STARTED);
    }
    const executorName = String(context.executorName || executor.name || "executor");
    this.emit(record.task, TASK_EVENT_TYPES.EXECUTOR_STARTED, { executor: executorName });

    let timedOut = false;
    if (record.task.budgets.timeoutMs > 0) {
      clearTimeout(record.timeout);
      record.timeout = setTimeout(() => {
        timedOut = true;
        try {
          record.controller.abort("timeout");
        } catch {
          record.controller.abort();
        }
      }, record.task.budgets.timeoutMs);
    }

    let childExecutions = 0;
    const runtimeContext = {
      ...context,
      signal: record.controller.signal,
      runChild: async (executorName, operation) => {
        if (version !== record.version || record.controller.signal.aborted) {
          const error = new Error("task_cancelled");
          error.code = "task_cancelled";
          throw error;
        }
        if (childExecutions >= record.task.budgets.maxChildExecutors) {
          const error = new Error("child_executor_budget_exhausted");
          error.code = "child_executor_budget_exhausted";
          throw error;
        }
        childExecutions += 1;
        this.emit(record.task, TASK_EVENT_TYPES.EXECUTOR_STARTED, {
          executor: String(executorName || "child_executor"),
          child: true,
          invocation: childExecutions,
        });
        const output = await operation(record.controller.signal);
        if (version !== record.version || record.controller.signal.aborted) {
          const error = new Error("task_cancelled");
          error.code = "task_cancelled";
          throw error;
        }
        return output;
      },
      progress: (detail = {}) => {
        if (version !== record.version || isTerminalTaskStatus(record.task.status)) return;
        this.emit(record.task, TASK_EVENT_TYPES.PROGRESS, detail);
      },
      approvalRequired: (request = {}) => {
        if (version !== record.version || isTerminalTaskStatus(record.task.status)) return;
        this.update(record, {
          status: TASK_STATUSES.WAITING_FOR_APPROVAL,
          approval: { ...record.task.approval, state: "required", request },
        });
        this.emit(record.task, TASK_EVENT_TYPES.APPROVAL_REQUIRED, request);
      },
      approvalResolved: (approved) => {
        if (version !== record.version || isTerminalTaskStatus(record.task.status)) return;
        this.update(record, {
          status: TASK_STATUSES.RUNNING,
          approval: {
            ...record.task.approval,
            state: approved ? "approved" : "declined",
            request: null,
          },
        });
      },
    };

    let result;
    try {
      const run = typeof executor === "function" ? executor : executor.execute.bind(executor);
      result = await run(record.task, runtimeContext);
    } catch (error) {
      if (version !== record.version) return { task: record.task, result: record.result, stale: true };
      if (record.controller.signal.aborted) {
        return timedOut
          ? this.fail(record.task.id, "timeout", { error })
          : this.cancel(record.task.id, record.task.cancellation.reason || "cancelled");
      }
      return this.fail(record.task.id, error?.message || "executor_failed", { error });
    } finally {
      if (record.timeout) clearTimeout(record.timeout);
      record.timeout = null;
    }

    if (version !== record.version) return { task: record.task, result: record.result, stale: true };
    if (record.controller.signal.aborted) {
      return timedOut
        ? this.fail(record.task.id, "timeout")
        : this.cancel(record.task.id, record.task.cancellation.reason || "cancelled");
    }

    const status = String(result?.status || (result?.ok === false ? "failed" : "completed"));
    if (status === TASK_STATUSES.WAITING_FOR_USER || status === "waiting_for_user") {
      this.update(record, { status: TASK_STATUSES.WAITING_FOR_USER });
      record.result = result;
      this.emit(record.task, TASK_EVENT_TYPES.WAITING_FOR_USER, {
        question: String(result?.question || result?.output || ""),
        questionOptions: result?.questionOptions || [],
      });
      return { task: record.task, result };
    }
    if (status === TASK_STATUSES.WAITING_FOR_APPROVAL || status === "waiting_for_approval") {
      this.update(record, { status: TASK_STATUSES.WAITING_FOR_APPROVAL });
      record.result = result;
      return { task: record.task, result };
    }
    if (status === TASK_STATUSES.CANCELLED || status === "aborted") {
      return this.cancel(record.task.id, String(result?.reason || "cancelled"));
    }
    if (status === TASK_STATUSES.FAILED || result?.ok === false) {
      return this.fail(record.task.id, String(result?.reason || result?.error || "executor_failed"), {
        result,
      });
    }
    return this.complete(record.task.id, result);
  }

  complete(taskId, result = {}) {
    const record = this.records.get(String(taskId || ""));
    if (!record || isTerminalTaskStatus(record.task.status)) {
      return { task: record?.task || null, result: record?.result || null, ignored: true };
    }
    record.version += 1;
    record.result = result;
    this.emit(record.task, TASK_EVENT_TYPES.EXECUTOR_COMPLETED, {
      executor: String(result?.executor || ""),
      output: String(result?.output || result?.answer || ""),
    });
    this.update(record, {
      status: TASK_STATUSES.COMPLETED,
      finishedAt: this.now(),
      completion: {
        kind: "executor_completed",
        output: String(result?.output || result?.answer || ""),
      },
    });
    this.emit(record.task, TASK_EVENT_TYPES.COMPLETED, {
      output: String(result?.output || result?.answer || ""),
    });
    return { task: record.task, result };
  }

  fail(taskId, reason = "failed", extra = {}) {
    const record = this.records.get(String(taskId || ""));
    if (!record || isTerminalTaskStatus(record.task.status)) {
      return { task: record?.task || null, result: record?.result || null, ignored: true };
    }
    record.version += 1;
    record.result = extra.result || { status: "failed", reason };
    this.update(record, {
      status: TASK_STATUSES.FAILED,
      finishedAt: this.now(),
      completion: { kind: "failed", reason: String(reason) },
    });
    this.emit(record.task, TASK_EVENT_TYPES.FAILED, {
      reason: String(reason),
      output: String(extra.result?.output || extra.result?.answer || ""),
    });
    return { task: record.task, result: record.result, error: extra.error };
  }

  cancel(taskId, reason = "cancelled") {
    const record = this.records.get(String(taskId || ""));
    if (!record || isTerminalTaskStatus(record.task.status)) {
      return { task: record?.task || null, result: record?.result || null, ignored: true };
    }
    record.version += 1;
    if (record.timeout) clearTimeout(record.timeout);
    record.timeout = null;
    try {
      record.controller.abort(reason);
    } catch {
      record.controller.abort();
    }
    record.result = { status: "cancelled", reason };
    this.update(record, {
      status: TASK_STATUSES.CANCELLED,
      finishedAt: this.now(),
      cancellation: {
        ...record.task.cancellation,
        state: "cancelled",
        reason: String(reason),
      },
      completion: { kind: "cancelled", reason: String(reason) },
    });
    this.emit(record.task, TASK_EVENT_TYPES.CANCELLED, { reason: String(reason) });
    return { task: record.task, result: record.result };
  }
}

module.exports = { TaskRuntime };
