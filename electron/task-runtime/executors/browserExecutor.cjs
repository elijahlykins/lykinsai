"use strict";

/**
 * BrowserExecutor — the ONE canonical way browser work executes.
 *
 * Runs under TaskRuntime.execute for every surface: a normal Agent browsing,
 * a Bot's approved browser errand, and any future caller. It does not own an
 * agent loop of its own — the modular browser-agent runtime
 * (electron/browser-agent) remains the single browser brain — what this class
 * owns is the CONTRACT between that runtime and the canonical Task:
 *
 *   - capabilities are enforced in code before anything runs (a task without
 *     a browser capability cannot execute, and a task's capability strings
 *     bound the action vocabulary its decision model is even offered);
 *   - cancellation arrives through the TaskRuntime signal, and the result is
 *     mapped onto canonical Task statuses (completed / waiting_for_user /
 *     failed / cancelled) so the Task record is always truthful;
 *   - browser lifecycle events flow out as TaskRuntime PROGRESS events;
 *   - approval semantics stay with the browser runtime's own gates
 *     (classifyActionRisk + the interactive Yes/No), which the host wires to
 *     TaskRuntime.requireApproval / resolveApproval — this class never
 *     weakens or duplicates them.
 *
 * The host injects `runBrowserTask`, which resolves the Electron WebContents,
 * builds the session-scoped controller, and drives the modular loop. That
 * keeps LYKN's Electron browser ownership model exactly where it was.
 */

const { allowedActionTypes } = require("../../browser-agent/runtime/capabilities.cjs");
const { browserOptInPrompt } = require("./browserOptInChoice.cjs");

class BrowserExecutor {
  /**
   * @param {object} deps
   * @param {(args: {task: object, allowedActions: Set<string>, context: object}) => Promise<object>} deps.runBrowserTask
   *   Host function that runs one browser task and resolves with the modular
   *   runtime's mapped result ({status, ok, answer, history, url, ...}).
   * @param {(args: {target: object, query?: object}) => Promise<object>} [deps.observePage]
   *   Passive observation seam: compact page state, no model call, no action.
   */
  constructor({ runBrowserTask, observePage = null }) {
    if (typeof runBrowserTask !== "function") {
      throw new TypeError("BrowserExecutor requires a runBrowserTask function");
    }
    this.name = "browser";
    this.runBrowserTask = runBrowserTask;
    this.observePage = observePage;
  }

  /**
   * Observe a page without running the browser-agent decision loop.
   * Used by Bot Routine monitors. Never acts. Never calls a model.
   */
  async observePassive({ target, query } = {}) {
    if (typeof this.observePage !== "function") {
      return { ok: false, status: "unavailable", reason: "observe_seam_missing" };
    }
    return this.observePage({ target, query });
  }

  async execute(task, runtime = {}) {
    const allowedActions = allowedActionTypes(task?.capabilities);
    if (!allowedActions) {
      return {
        ok: false,
        status: "failed",
        reason: "browser_capability_missing",
        executor: this.name,
        output:
          "This task does not hold a browser capability, so no browser operation can run.",
      };
    }

    runtime.progress?.({ event: "browser.execution_started", taskId: task.id });
    const result = await this.runBrowserTask({
      task,
      allowedActions,
      context: runtime,
    });
    const browserResult = result || { ok: false, status: "failed", error: "no_result" };
    const status = String(browserResult.status || (browserResult.ok === false ? "failed" : "completed"));
    runtime.progress?.({ event: "browser.execution_finished", taskId: task.id, status });

    if (browserResult.error === "aborted" || status === "cancelled") {
      // TaskRuntime maps "aborted" onto a cancelled Task; the browserResult
      // still travels so the host shell can render whatever partial history
      // exists.
      return { status: "aborted", reason: "aborted", executor: this.name, browserResult };
    }
    if (status === "waiting_for_user") {
      return {
        status: "waiting_for_user",
        executor: this.name,
        question: String(browserResult.answer || ""),
        questionOptions: Array.isArray(browserResult.answerOptions) ? browserResult.answerOptions : [],
        needsApproval: browserResult.needsApproval === true,
        browserResult,
      };
    }
    if (status === "failed" || browserResult.ok === false) {
      return {
        ok: false,
        status: "failed",
        reason: String(browserResult.reason || browserResult.error || "browser_task_incomplete"),
        executor: this.name,
        output: String(browserResult.answer || ""),
        browserResult,
      };
    }
    return {
      ok: true,
      status: "completed",
      executor: this.name,
      answer: String(browserResult.answer || ""),
      output: String(browserResult.answer || ""),
      browserResult,
    };
  }
}

/**
 * Legacy Bot browser opt-in gate. Interactive bots now start the browser
 * immediately through BrowserExecutor; this class remains so an already-
 * parked question can still be answered, and so unit tests cover the old
 * park-and-ask contract.
 *
 * When the ask names a connectable service (Gmail, Drive, Slack, …) the
 * question offers the plugin as well. This gate parks the ORIGINAL tool
 * instruction against the SAME canonical Task and pauses it as
 * waiting_for_user.
 */
class BrowserOptInGate {
  constructor({ isDeclined = () => false, park } = {}) {
    this.isDeclined = isDeclined;
    this.park = park;
  }

  async execute({ instruction, task }) {
    if (this.isDeclined(task)) {
      return {
        ok: false,
        output: "",
        summary:
          "the user already chose to stay out of the browser for this task; answer another way or stop",
      };
    }
    const parked = String(instruction || task.objective).trim() || task.objective;
    const prompt = browserOptInPrompt(instruction, task?.objective);
    this.park?.({
      taskId: task.id,
      instruction: parked,
      plugin: prompt.plugin,
    });
    return {
      ok: true,
      terminal: "waiting_for_user",
      question: prompt.question,
      questionOptions: prompt.questionOptions,
    };
  }
}

module.exports = { BrowserExecutor, BrowserOptInGate };
