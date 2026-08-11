/**
 * Browser agent runtime — the full loop:
 *
 *   understand goal → load relevant skills → inspect browser state →
 *   decide next action → execute → observe → verify → update state →
 *   continue / recover / replan / finish
 *
 * The browser state is the source of truth. The plan is guidance. Success is
 * never assumed from a tool returning ok — the verifier checks the resulting
 * browser state.
 *
 * The browser is one environment; planning, memory, skills and verification
 * are environment-agnostic and talk to it only through the controller's
 * action API, so other environments (desktop, terminal, APIs) can be added
 * later without rewriting the brain.
 */

const { createBrowserController } = require("./browser/controller.cjs");
const { createAgentModel, AgentModelUnavailableError } = require("./runtime/model.cjs");
const { createMemoryStore } = require("./runtime/memory.cjs");
const { createDebugLog } = require("./runtime/debugLog.cjs");
const { createRecoveryTracker } = require("./runtime/recovery.cjs");
const taskState = require("./runtime/taskState.cjs");
const planner = require("./runtime/planner.cjs");
const executor = require("./runtime/executor.cjs");
const verifier = require("./runtime/verifier.cjs");

const DEFAULT_MAX_ROUNDS = 24;

/**
 * Run one browser-agent task to completion (or until user input is needed).
 *
 * @param {object} opts
 * @param {string} opts.goal user goal
 * @param {object} opts.controller browser controller (createBrowserController)
 * @param {object} opts.model agent model (createAgentModel)
 * @param {object} [opts.memory] memory store (createMemoryStore)
 * @param {Array}  [opts.conversationHistory] recent chat turns for context
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRounds]
 * @param {string} [opts.userDataPath] for debug logs
 * @param {(p: object) => void} [opts.onProgress] silent-by-default progress events
 * @param {(req: {question: string, decision: object}) => Promise<boolean>} [opts.onApprovalNeeded]
 *   optional interactive approval; when absent the agent stops and asks in chat
 * @returns {Promise<{ok:boolean, status:string, answer:string, task:object, history:Array}>}
 */
async function runBrowserAgentTask({
  goal,
  // The user's raw ask, when `goal` was enriched with extra instructions.
  // Consequential-action pre-approval is judged against THIS text only, so
  // instruction lines that mention "send"/"submit" can never self-approve.
  userAsk = "",
  controller,
  model,
  memory = null,
  conversationHistory = [],
  signal = null,
  maxRounds = DEFAULT_MAX_ROUNDS,
  userDataPath = "",
  onProgress = () => {},
  onApprovalNeeded = null,
  // "auto": the user's explicit ask can pre-approve the final send/share.
  // "ask": ALWAYS pause before any consequential action so the user can
  // review the prepared work and request edits — used for first-run composes;
  // the user's approval reply then runs with "auto".
  sendPolicy = "auto",
}) {
  const task = taskState.createTask({ goal, conversationHistory });
  const debug = createDebugLog({ userDataPath, taskId: task.id });
  const recovery = createRecoveryTracker();
  const userMemory = memory ? await memory.getUserMemory().catch(() => "") : "";

  const finish = (status, answer, extra = {}) => {
    task.status = status;
    task.completionReason = extra.completionReason || answer.slice(0, 200);
    debug.log("task_finished", { status, completionReason: task.completionReason, rounds: task.round });
    debug.close();
    return {
      ok: status !== "failed",
      status,
      answer,
      task,
      history: task.recentActions,
      ...extra,
    };
  };

  const aborted = () => signal?.aborted === true;

  debug.log("task_started", { goal: task.goal });
  onProgress({ phase: "planning", goal: task.goal });

  // --- Plan -----------------------------------------------------------------
  let snapshot = null;
  try {
    snapshot = await controller.getPageState();
  } catch {
    snapshot = null;
  }
  try {
    const { clarification } = await planner.planTask({ model, task, snapshot, userMemory });
    if (clarification) {
      return finish("waiting_for_user", clarification, { needsUser: true });
    }
  } catch (e) {
    if (e instanceof AgentModelUnavailableError) throw e;
    debug.log("plan_failed", { error: e?.message });
    // Planning is guidance — a failed planning call should not kill the task.
    taskState.setPlan(task, { plan: [`Work toward: ${task.goal}`] });
  }
  debug.log("plan_created", { plan: task.plan.map((p) => p.step), skills: task.skills, constraints: task.constraints });
  onProgress({ phase: "working", plan: task.plan.map((p) => p.step), skills: task.skills });

  // --- Loop -----------------------------------------------------------------
  let recovering = false;
  let recoveryHint = "";
  let lastVerification = null;
  let pendingScreenshot = "";
  let invalidDecisions = 0;

  for (task.round = 1; task.round <= maxRounds; task.round += 1) {
    if (aborted()) return finish("failed", "Task aborted.", { error: "aborted" });

    // 1. Observe — always decide from a fresh snapshot when the last action
    //    could have changed the page.
    if (!controller.getCurrentSnapshot()) {
      await controller.settle();
      try {
        snapshot = await controller.getPageState();
      } catch (e) {
        return finish("failed", `Lost access to the browser: ${e?.message || e}`);
      }
    } else {
      snapshot = controller.getCurrentSnapshot();
    }
    debug.log("observed", {
      round: task.round,
      url: snapshot.url,
      title: snapshot.title,
      elements: snapshot.elements.length,
    });

    const websiteMemory = memory
      ? await memory.getWebsiteMemory(snapshot.url).catch(() => "")
      : "";

    // 2. Decide.
    let decision;
    try {
      decision = await executor.decideNext({
        model,
        task,
        snapshot,
        memoryContext: { userMemory, websiteMemory },
        recovering,
        recoveryHint,
        lastVerification,
        screenshotDataUrl: pendingScreenshot,
      });
    } catch (e) {
      if (e instanceof AgentModelUnavailableError) throw e;
      return finish("failed", `Could not decide the next step: ${e?.message || e}`);
    }
    pendingScreenshot = "";
    debug.log("decision", {
      round: task.round,
      kind: decision.kind,
      action: decision.action,
      expectedOutcome: decision.expectedOutcome,
      risk: decision.risk,
      reason: decision.reason,
    });

    // Harvest discoveries regardless of what happens next.
    for (const fact of decision.factsLearned) taskState.addFact(task, fact);
    for (const c of decision.candidateResults) {
      if (!task.workingMemory.candidateResults.includes(c)) {
        task.workingMemory.candidateResults.push(c);
      }
    }

    if (decision.kind === "invalid") {
      invalidDecisions += 1;
      debug.log("invalid_decision", { reason: decision.invalidReason });
      if (invalidDecisions >= 3) {
        return finish("failed", "The agent repeatedly produced invalid actions and could not proceed.");
      }
      // Refresh the view — invalid refs usually mean the model reasoned over
      // a stale snapshot.
      controller.invalidate();
      recovering = true;
      recoveryHint = `Your previous decision was invalid (${decision.invalidReason}). Use only element references from the CURRENT snapshot.`;
      continue;
    }
    invalidDecisions = 0;

    // 3. Terminal decisions.
    if (decision.kind === "finish") {
      // Completion verification: what did the user ask for, and what evidence
      // do we have? The executor's answer must be grounded — require either
      // gathered facts, candidate results, or verified consequential steps.
      const hasEvidence =
        task.workingMemory.facts.length > 0 ||
        task.workingMemory.candidateResults.length > 0 ||
        task.recentActions.some((a) => a.result === "success");
      if (!hasEvidence && task.round <= 2) {
        recovering = true;
        recoveryHint =
          "You tried to finish without any evidence of progress. Either do the work first, or explain what makes the goal already satisfied.";
        debug.log("finish_rejected", { round: task.round });
        continue;
      }
      return finish("completed", decision.answer, { completionReason: decision.reason || "goal achieved" });
    }
    if (decision.kind === "ask_user") {
      return finish("waiting_for_user", decision.question, { needsUser: true });
    }
    if (decision.kind === "replan") {
      debug.log("replanning", { reason: decision.replanReason });
      onProgress({ phase: "replanning", reason: decision.replanReason });
      try {
        await planner.replanTask({ model, task, snapshot, reason: decision.replanReason });
        debug.log("plan_revised", { plan: task.plan.map((p) => p.step) });
      } catch (e) {
        if (e instanceof AgentModelUnavailableError) throw e;
        debug.log("replan_failed", { error: e?.message });
      }
      recovering = false;
      recoveryHint = "";
      lastVerification = null;
      continue;
    }

    // 4. Safety gate for consequential actions.
    const risk = executor.classifyActionRisk(decision, snapshot);
    const approvalText = String(userAsk || "").trim() || task.goal;
    const preApproved =
      sendPolicy !== "ask" && executor.goalPreApprovesAction(approvalText, decision, snapshot);
    if (risk === "consequential" && !preApproved) {
      const el = snapshot.byRef.get(String(decision.action?.target || ""));
      const description =
        sendPolicy === "ask"
          ? `Everything is ready — look it over in the browser and tell me any changes you want. When you're happy, say "send" and I'll ${describeConsequence(decision, el, { brief: true })}.`
          : `I've prepared everything up to the final step. Approve before I ${describeConsequence(decision, el)}?`;
      debug.log("approval_needed", { action: decision.action, label: el?.label });
      let approved = false;
      if (typeof onApprovalNeeded === "function") {
        approved = await onApprovalNeeded({ question: description, decision }).catch(() => false);
      }
      if (!approved) {
        return finish("waiting_for_user", description, {
          needsUser: true,
          needsApproval: true,
          preparedAction: decision.action,
        });
      }
      debug.log("approval_granted", { action: decision.action });
    }

    // 5. Execute.
    const before = snapshot;
    // The decision's reason is the human-readable "next step" — surface it so
    // the UI can narrate one step at a time instead of a pre-baked plan.
    const targetEl = decision.action?.target
      ? snapshot?.byRef?.get?.(String(decision.action.target))
      : null;
    onProgress({
      phase: "acting",
      round: task.round,
      action: decision.action,
      reason: String(decision.reason || "").slice(0, 160),
      targetLabel: targetEl?.label ? String(targetEl.label).slice(0, 60) : "",
      url: snapshot.url,
    });
    const actionResult = await executeAction(controller, decision.action).catch((e) => ({
      ok: false,
      error: e?.message || String(e),
    }));
    debug.log("acted", {
      round: task.round,
      ok: actionResult?.ok !== false,
      error: actionResult?.error || "",
      resolved: actionResult?.resolved || "",
      clickedLabel: actionResult?.clickedLabel || "",
      x: actionResult?.x,
      y: actionResult?.y,
    });
    // Extracted field content must persist across rounds — history lines are
    // truncated, and without this the model re-reads (or worse, retypes) the
    // same field forever.
    if (decision.action?.type === "extract" && actionResult?.ok && actionResult.value != null) {
      taskState.addFact(
        task,
        `field "${actionResult.label || decision.action.target}" contains: ${String(actionResult.value).slice(0, 500)}`,
      );
    }

    // 6. Observe the result.
    await controller.settle();
    let after = null;
    try {
      after = controller.getCurrentSnapshot() || (await controller.getPageState());
    } catch {
      after = before;
    }
    const diff = controller.diffSnapshots(before, after);

    // For typed input, read the actual field value as evidence.
    let extracted = null;
    if (decision.action?.type === "type" && decision.action.target && !diff.urlChanged) {
      // Re-resolve by label in the fresh snapshot (refs are per-snapshot).
      const prevEl = before.byRef.get(decision.action.target);
      const fresh = prevEl
        ? after.elements.find((e) => e.label === prevEl.label && e.role === prevEl.role)
        : null;
      if (fresh) extracted = await controller.extract(fresh.ref).catch(() => null);
    }

    // 7. Verify.
    let verification;
    try {
      verification = await verifier.verifyOutcome({
        model,
        decision,
        actionResult,
        before,
        after,
        diff,
        extracted,
      });
    } catch (e) {
      if (e instanceof AgentModelUnavailableError) throw e;
      verification = { success: false, evidence: "", reason: e?.message || String(e), next: "recover", method: "error" };
    }
    lastVerification = verification;
    debug.log("verified", {
      round: task.round,
      success: verification.success,
      evidence: verification.evidence,
      reason: verification.reason,
      next: verification.next,
      method: verification.method,
      diff: diff.summary,
    });

    // 8. Update task state.
    taskState.recordAction(task, {
      action: decision.action,
      expectedOutcome: decision.expectedOutcome,
      result: verification.success ? "success" : "failure",
      observedOutcome: verification.evidence || verification.reason || diff.summary,
      retries: recovery.retriesFor(decision),
    });

    if (verification.success) {
      recovering = false;
      recoveryHint = "";
      task.retryCount = 0;
      if (decision.planStepCompleted) taskState.markStepDone(task);
      continue;
    }

    // 9. Recover.
    const step = recovery.nextRecoveryStep({ decision, verification });
    task.retryCount = recovery.retriesFor(decision);
    debug.log("recovery", { mode: step.mode, hint: step.hint, retries: task.retryCount, total: recovery.totalCount() });
    onProgress({ phase: "recovering", mode: step.mode, round: task.round });

    if (step.mode === "fail") {
      return finish(
        "failed",
        `I couldn't complete this: repeated attempts failed. Last problem: ${verification.reason || "no progress on the page"}.`,
      );
    }
    if (step.mode === "replan") {
      try {
        await planner.replanTask({ model, task, snapshot: after, reason: step.hint });
        debug.log("plan_revised", { plan: task.plan.map((p) => p.step) });
      } catch (e) {
        if (e instanceof AgentModelUnavailableError) throw e;
      }
      recovering = false;
      recoveryHint = "";
      continue;
    }
    if (step.mode === "visual") {
      const shot = await controller.screenshot();
      if (shot.ok) pendingScreenshot = shot.dataUrl;
    }
    controller.invalidate();
    recovering = true;
    recoveryHint = step.hint;
  }

  return finish(
    "failed",
    "I ran out of steps before completing this task. " +
      `Progress so far: ${task.workingMemory.facts.slice(-3).join("; ") || "see history"}.`,
  );
}

/** Map a structured decision action onto the controller's deterministic API. */
async function executeAction(controller, action) {
  const type = String(action?.type || "");
  switch (type) {
    case "navigate":
      return controller.navigate(action.url);
    case "click":
      return controller.click(action.target);
    case "type":
      return controller.type(action.target, action.text ?? action.value ?? "", {
        pressEnter: action.pressEnter === true,
        mode: action.mode === "replace" ? "replace" : "append",
      });
    case "replace_text":
      return controller.replaceText(action.target, action.find, action.text ?? action.value ?? "");
    case "select":
      return controller.select(action.target, action.value ?? action.text ?? "");
    case "scroll":
      return controller.scroll(action.direction || "down");
    case "go_back":
      return controller.goBack();
    case "go_forward":
      return controller.goForward();
    case "press_key":
      return controller.pressKey(action.key || "Enter");
    case "open_tab":
      return controller.openTab(action.url);
    case "close_tab":
      return controller.closeTab(action.tabId);
    case "switch_tab":
      return controller.switchTab(action.tabId);
    case "extract":
      return controller.extract(action.target);
    case "wait":
      return controller.wait(action.ms);
    case "screenshot":
      return controller.screenshot();
    default:
      return { ok: false, error: `unknown_action_type:${type}` };
  }
}

function describeConsequence(decision, el, { brief = false } = {}) {
  const label = String(el?.label || "").trim();
  const expected = brief ? "" : String(decision.expectedOutcome || "").trim();
  if (label) return `click "${label}"${expected ? ` (${expected})` : ""}`;
  const action = decision.action || {};
  // No element label (e.g. press_key fallback): name the action itself —
  // splicing the expected-outcome sentence after "before I" reads as garbage.
  const named =
    action.type === "press_key"
      ? `press ${String(action.key || "Enter")}`
      : `perform ${action.type || "this action"}`;
  return `${named}${expected ? ` (${expected})` : ""}`;
}

module.exports = {
  runBrowserAgentTask,
  createBrowserController,
  createAgentModel,
  createMemoryStore,
  AgentModelUnavailableError,
};
