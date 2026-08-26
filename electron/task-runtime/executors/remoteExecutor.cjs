"use strict";

/**
 * RemoteExecutor — the ONE canonical way remote (SSH) work executes under
 * TaskRuntime. It is the fourth executor alongside Bot, Browser, and Local, and
 * it represents an ENVIRONMENT LYKN operates inside: an SSH server, dev box,
 * VM, or production host.
 *
 * Like LocalExecutor, it does not own a Task lifecycle and does not duplicate
 * the remote brain (that is electron/remote/remoteAgentTask.cjs). It owns the
 * CONTRACT between that brain and the canonical Task:
 *
 *   - Remote capabilities are enforced in code before anything runs; a Task
 *     with no remote capability never reaches a host.
 *   - Cancellation arrives through the TaskRuntime signal.
 *   - Results map onto truthful Task statuses: completed / waiting_for_user /
 *     waiting_for_approval / failed / cancelled. Host trust prompts and
 *     HOST_KEY_CHANGED surface as structural pauses, never as a success string.
 *   - Lifecycle milestones flow out as Task PROGRESS events.
 *
 * The host injects `runRemoteTask`, which resolves the target, establishes host
 * trust, opens a RemoteSession, and runs the brain. Credential resolution and
 * the host address live entirely in that host code — never here, never in the
 * Task, never in a model prompt.
 */

const { allowedRemoteTools } = require("../../remote/remotePolicy.cjs");

const REMOTE_SAFETY_CEILING = 20;

function remoteMaxRounds(task) {
  const parent = Number(task?.budgets?.maxRounds);
  const budget = Number.isFinite(parent) && parent > 0 ? parent : REMOTE_SAFETY_CEILING;
  return Math.max(1, Math.min(REMOTE_SAFETY_CEILING, budget));
}

class RemoteExecutor {
  /**
   * @param {object} deps
   * @param {(args: {
   *   task: object,
   *   capabilities: string[],
   *   allowedTools: Set<string>,
   *   maxRounds: number,
   *   instruction: string,
   *   context: object,
   * }) => Promise<object>} deps.runRemoteTask
   */
  constructor({ runRemoteTask }) {
    if (typeof runRemoteTask !== "function") {
      throw new TypeError("RemoteExecutor requires a runRemoteTask function");
    }
    this.name = "remote";
    this.runRemoteTask = runRemoteTask;
  }

  async execute(task, runtime = {}) {
    const allowedTools = allowedRemoteTools(task?.capabilities);
    if (!allowedTools || allowedTools.size === 0) {
      return {
        ok: false,
        status: "failed",
        reason: "remote_capability_missing",
        executor: this.name,
        output:
          "This task does not hold a remote capability, so no SSH connection or remote command can run.",
      };
    }

    const instruction = String(runtime.instruction || task.objective || "").trim();
    const maxRounds = remoteMaxRounds(task);
    runtime.progress?.({
      event: "remote.started",
      taskId: task.id,
      runId: task.runId,
      maxRounds,
      allowedTools: [...allowedTools],
    });

    const result =
      (await this.runRemoteTask({
        task,
        capabilities: task.capabilities,
        allowedTools,
        maxRounds,
        instruction,
        context: runtime,
      })) || { ok: false, status: "failed", error: "no_result" };

    const status = String(result.status || (result.ok === false ? "failed" : "completed"));

    if (runtime.signal?.aborted || result.error === "aborted" || status === "cancelled" || status === "aborted") {
      runtime.progress?.({ event: "remote.failed", taskId: task.id, status: "cancelled" });
      return {
        status: "aborted",
        reason: "aborted",
        executor: this.name,
        output: String(result.answer || result.output || ""),
        remoteResult: result,
      };
    }

    if (status === "waiting_for_approval") {
      runtime.progress?.({ event: "remote.approval_required", taskId: task.id });
      return {
        status: "waiting_for_approval",
        executor: this.name,
        question: String(result.answer || result.question || ""),
        needsApproval: true,
        approvalKind: result.approvalKind || "remote-approval",
        remoteResult: result,
      };
    }

    if (status === "waiting_for_user") {
      runtime.progress?.({ event: "remote.progress", taskId: task.id, phase: "waiting_for_user" });
      return {
        status: "waiting_for_user",
        executor: this.name,
        question: String(result.answer || result.question || ""),
        questionOptions: Array.isArray(result.questionOptions) ? result.questionOptions : [],
        needsApproval: result.needsApproval === true,
        waitingKind: result.waitingKind || "",
        remoteResult: result,
      };
    }

    if (status === "failed" || result.ok === false) {
      runtime.progress?.({ event: "remote.failed", taskId: task.id, status: "failed" });
      return {
        ok: false,
        status: "failed",
        reason: String(result.reason || result.error || "remote_task_incomplete"),
        executor: this.name,
        output: String(result.answer || result.output || ""),
        remoteResult: result,
      };
    }

    runtime.progress?.({ event: "remote.completed", taskId: task.id, runId: task.runId });
    const output = String(result.answer || result.output || "");
    return {
      ok: true,
      status: "completed",
      executor: this.name,
      answer: output,
      output,
      summary: String(result.summary || output).slice(0, 500),
      usage: result.usage || undefined,
      remoteResult: result,
    };
  }
}

/**
 * Map a RemoteExecutor result onto the Bot harness child-tool envelope, so a
 * Bot that selects a remote tool treats a pause as a terminal handback, never
 * as completed work. Mirrors localExecutor.toHarnessResult.
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
    return { ok: false, output, summary: String(result?.reason || output).slice(0, 500) };
  }
  return { ok: result?.ok !== false, output, summary: String(result?.summary || output).slice(0, 500) };
}

module.exports = {
  RemoteExecutor,
  REMOTE_SAFETY_CEILING,
  remoteMaxRounds,
  toHarnessResult,
};
