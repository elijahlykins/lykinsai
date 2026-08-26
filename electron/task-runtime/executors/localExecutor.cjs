"use strict";

/**
 * LocalExecutor — the ONE canonical way local-computer work executes.
 *
 * Runs under TaskRuntime.execute for a normal Agent's Local Mode skill, and as
 * a child executor (via TaskRuntime.runChild) when a Bot selects
 * `local_computer`. It does not own a Task lifecycle of its own — the loop in
 * electron/localAgentTask.cjs remains the local brain — what this class owns
 * is the CONTRACT between that loop and the canonical Task:
 *
 *   - capabilities are enforced in code before anything runs;
 *   - cancellation arrives through the TaskRuntime signal;
 *   - parent budgets bound the inner loop (an internal safety ceiling is
 *     subordinate, never a second Task budget);
 *   - results map onto canonical Task statuses so waiting/approval are
 *     structural, never a successful string;
 *   - local lifecycle events flow out as TaskRuntime PROGRESS events;
 *   - approval semantics stay with localAgentTask/localSystem gates, which
 *     the host wires to TaskRuntime.requireApproval / resolveApproval.
 *
 * The host injects `runLocalTask`, which performs the Electron-side work
 * (localSystem tools, approval UI, agent status). That keeps filesystem
 * authority exactly where it was.
 */

const {
  allowedToolNames,
  compileLocalCapabilities,
} = require("./localCapabilities.cjs");

/** Absolute inner-loop ceiling. Never exceeds the parent Task budget. */
const LOCAL_SAFETY_CEILING = 20;

function localMaxRounds(task) {
  const parent = Number(task?.budgets?.maxRounds);
  const budget = Number.isFinite(parent) && parent > 0 ? parent : LOCAL_SAFETY_CEILING;
  return Math.max(1, Math.min(LOCAL_SAFETY_CEILING, budget));
}

class LocalExecutor {
  /**
   * @param {object} deps
   * @param {(args: {
   *   task: object,
   *   allowedTools: Set<string>,
   *   maxRounds: number,
   *   instruction: string,
   *   context: object,
   * }) => Promise<object>} deps.runLocalTask
   */
  constructor({ runLocalTask }) {
    if (typeof runLocalTask !== "function") {
      throw new TypeError("LocalExecutor requires a runLocalTask function");
    }
    this.name = "local";
    this.runLocalTask = runLocalTask;
  }

  async execute(task, runtime = {}) {
    const allowedTools = allowedToolNames(task?.capabilities);
    if (!allowedTools || allowedTools.size === 0) {
      return {
        ok: false,
        status: "failed",
        reason: "local_capability_missing",
        executor: this.name,
        output:
          "This task does not hold a local-computer capability, so no filesystem or shell operation can run.",
      };
    }

    const instruction = String(runtime.instruction || task.objective || "").trim();
    const maxRounds = localMaxRounds(task);
    runtime.progress?.({
      event: "local.started",
      taskId: task.id,
      runId: task.runId,
      maxRounds,
      parentMaxRounds: task.budgets?.maxRounds,
      allowedTools: [...allowedTools],
    });

    const result = await this.runLocalTask({
      task,
      allowedTools,
      maxRounds,
      instruction,
      context: runtime,
    });
    const localResult = result || { ok: false, status: "failed", error: "no_result" };
    const status = String(
      localResult.status || (localResult.ok === false ? "failed" : "completed"),
    );

    if (runtime.signal?.aborted || localResult.error === "aborted" || status === "cancelled") {
      runtime.progress?.({
        event: "local.failed",
        taskId: task.id,
        runId: task.runId,
        status: "cancelled",
      });
      return {
        status: "aborted",
        reason: "aborted",
        executor: this.name,
        output: String(localResult.answer || localResult.output || ""),
        localResult,
      };
    }

    if (status === "waiting_for_approval") {
      runtime.progress?.({
        event: "local.approval_required",
        taskId: task.id,
        runId: task.runId,
      });
      return {
        status: "waiting_for_approval",
        executor: this.name,
        question: String(localResult.answer || localResult.question || ""),
        needsApproval: true,
        localResult,
      };
    }

    if (status === "waiting_for_user") {
      runtime.progress?.({
        event: "local.progress",
        taskId: task.id,
        runId: task.runId,
        phase: "waiting_for_user",
      });
      return {
        status: "waiting_for_user",
        executor: this.name,
        question: String(localResult.answer || localResult.question || ""),
        questionOptions: Array.isArray(localResult.answerOptions)
          ? localResult.answerOptions
          : [],
        needsApproval: localResult.needsApproval === true,
        localResult,
      };
    }

    if (status === "failed" || localResult.ok === false) {
      runtime.progress?.({
        event: "local.failed",
        taskId: task.id,
        runId: task.runId,
        status: "failed",
      });
      return {
        ok: false,
        status: "failed",
        reason: String(localResult.reason || localResult.error || "local_task_incomplete"),
        executor: this.name,
        output: String(localResult.answer || localResult.output || ""),
        localResult,
      };
    }

    runtime.progress?.({
      event: "local.completed",
      taskId: task.id,
      runId: task.runId,
    });
    const output = String(localResult.answer || localResult.output || "");
    return {
      ok: true,
      status: "completed",
      executor: this.name,
      answer: output,
      output,
      summary: String(localResult.summary || output).slice(0, 500),
      artifacts: localResult.artifacts || undefined,
      changedFiles: localResult.changedFiles || undefined,
      processResult: localResult.processResult || undefined,
      usage: localResult.usage || undefined,
      localResult,
    };
  }
}

/**
 * Map a LocalExecutor result onto the Bot harness child-tool envelope.
 * Waiting is a terminal pause, never a successful string the harness could
 * treat as completed work.
 */
function toHarnessResult(result) {
  const status = String(result?.status || "");
  const output = String(result?.output || result?.answer || result?.question || "");
  if (status === "waiting_for_user" || status === "waiting_for_approval") {
    return {
      ok: true,
      terminal: status,
      output,
      question: String(result?.question || output),
      questionOptions: Array.isArray(result?.questionOptions) ? result.questionOptions : [],
      summary: "handed back to the user",
    };
  }
  if (status === "cancelled" || status === "aborted") {
    return { ok: false, output, summary: "cancelled" };
  }
  if (status === "failed" || result?.ok === false) {
    return {
      ok: false,
      output,
      summary: String(result?.reason || result?.error || output).slice(0, 500),
    };
  }
  return {
    ok: result?.ok !== false,
    output,
    summary: String(result?.summary || output).slice(0, 500),
    artifacts: result?.artifacts,
    changedFiles: result?.changedFiles,
    processResult: result?.processResult,
  };
}

module.exports = {
  LocalExecutor,
  LOCAL_SAFETY_CEILING,
  localMaxRounds,
  compileLocalCapabilities,
  toHarnessResult,
};
