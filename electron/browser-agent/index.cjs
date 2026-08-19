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
const { createTimer } = require("./runtime/timing.cjs");
const { createGrounder } = require("./runtime/grounding.cjs");
const taskState = require("./runtime/taskState.cjs");
const planner = require("./runtime/planner.cjs");
const executor = require("./runtime/executor.cjs");
const verifier = require("./runtime/verifier.cjs");
const visionPolicy = require("./runtime/visionPolicy.cjs");
const contextRouter = require("./runtime/contextRouter.cjs");

const DEFAULT_MAX_ROUNDS = 24;

/** Extra rounds granted each time the user unblocks the task by hand. */
const RESUME_ROUND_BONUS = 6;

/**
 * Actions that succeed mechanically and prove nothing about the task. They are
 * real work — you have to scroll to read a list — but "it scrolled" is not
 * evidence that the user's goal was met, and treating it as such is how a run
 * ends `completed` with an invented answer.
 */
const EVIDENCE_FREE_ACTIONS = new Set(["scroll", "wait", "screenshot", "go_back", "go_forward"]);

/**
 * Things only the user can supply. Any other `ask_user` question is the agent
 * punting work back — asking permission to continue, or which of two obvious
 * options to take — and gets pushed back once before it can end the run.
 */
const HUMAN_ONLY_QUESTION_RE =
  /\b(password|passcode|passphrase|2fa|two[- ]factor|mfa|otp|one[- ]time (?:code|password)|verification code|security code|auth(?:entication)? code|sign[- ]?in|log[- ]?in|credential|captcha|card number|cvv|billing address|payment method|social security|ssn|date of birth|which account)\b/i;

/**
 * Asking permission is a punt however it is phrased. "Do you want me to sign
 * in?" contains "sign in", so the keyword test alone let the agent end the run
 * by asking to do something it should simply have done.
 */
const ASKING_PERMISSION_RE =
  /^\W*(?:do you want|would you like|should i|shall i|may i|can i|is it (?:ok|okay|alright)|are you (?:ok|happy)|let me know if|would you prefer|which (?:would|do) you)\b/i;

function requiresHumanInput(question) {
  const text = String(question || "");
  if (ASKING_PERMISSION_RE.test(text)) return false;
  return HUMAN_ONLY_QUESTION_RE.test(text);
}

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
 * @param {(req: {kind: "input"|"approval"|"stuck"|"exhausted", question: string, decision?: object}) => Promise<{resumed: boolean, note?: string}|null>} [opts.onNeedsUser]
 *   Called instead of ending the run when the agent needs the user to act in
 *   the browser (sign in, click something, clear a wall). Should watch the tab
 *   and resolve `{resumed:true}` once they have, so the task continues rather
 *   than being handed back. Absent → the run ends as before.
 * @returns {Promise<{ok:boolean, status:string, answer:string, task:object, history:Array}>}
 */
/**
 * Thin wrapper so the debug stream is always closed.
 *
 * A model outage rethrows AgentModelUnavailableError straight out of the loop
 * for the caller to fall back on, which skipped `finish()` — and with it the
 * only `debug.close()`. Every such run leaked a write stream.
 */
async function runBrowserAgentTask(opts) {
  const held = {};
  try {
    return await runTask({ ...opts, __holdDebug: held });
  } finally {
    held.debug?.close?.();
  }
}

async function runTask({
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
  onNeedsUser = null,
  // "auto": the user's explicit ask can pre-approve the final send/share.
  // "ask": ALWAYS pause before any consequential action so the user can
  // review the prepared work and request edits — used for first-run composes;
  // the user's approval reply then runs with "auto".
  sendPolicy = "auto",
  // "refs": aim with element references from the snapshot (production).
  // "holo": the model describes its target and a grounding model turns that
  // description into a point. Only the eval harness sets this.
  groundingMode = "",
  // Per-stage span timing. Off in production; the disabled timer is a no-op.
  timing = false,
  // Awaited pre-action hook. onProgress is fired-and-forgotten, so a harness
  // that screenshots there races the click; this is the place to capture the
  // frame the action is about to change.
  onBeforeAct = null,
  __holdDebug = null,
}) {
  const task = taskState.createTask({ goal, conversationHistory });
  const debug = createDebugLog({ userDataPath, taskId: task.id });
  if (__holdDebug) __holdDebug.debug = debug;
  const recovery = createRecoveryTracker();
  const timer = createTimer({ enabled: timing === true, onSpan: (sp) => debug.log("span", sp) });
  // null in refs mode — that null is the loop's only grounding-mode check.
  const grounder = createGrounder({ mode: groundingMode, model });
  const userMemory = memory ? await memory.getUserMemory().catch(() => "") : "";

  let learned = false;
  /**
   * Every exit goes through here, and every exit learns.
   *
   * Learning used to hang off the one clean-finish path, so a run that fought a
   * site for twenty rounds and lost — the run with the most to teach the next
   * one — recorded nothing at all. `finish` is async now; the call sites are
   * all `return finish(...)` inside an async function, so they adopt the
   * promise unchanged.
   */
  const finish = async (status, answer, extra = {}) => {
    task.status = status;
    task.completionReason = extra.completionReason || answer.slice(0, 200);
    if (!learned) {
      learned = true;
      await recordWhatWeLearned(currentUrlSafe()).catch(() => {});
    }
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

  const currentUrlSafe = () => {
    try {
      return controller.getCurrentSnapshot()?.url || controller.currentUrl() || "";
    } catch {
      return "";
    }
  };

  const aborted = () => signal?.aborted === true;

  /**
   * Keep what this run figured out about the site.
   *
   * The hardest part of driving an unfamiliar app is working out how it is put
   * together, and that understanding was being discarded the moment a task
   * ended — every visit to the same product started from nothing. One cheap call
   * at the end turns a slow first run into a fast second one.
   */
  const recordWhatWeLearned = async (finalUrl) => {
    if (!memory?.rememberWebsiteNotes) return;
    const host = memory.hostFromUrl?.(finalUrl) || "";
    // Nothing durable is learned from a run that barely touched the page.
    if (!host || task.round < 3) return;
    try {
      const existing = await memory.getWebsiteMemory(host).catch(() => "");
      const { notes, userNotes } = await timer.time("learn", () => model.learn({
        system: contextRouter.buildLearningSystem(),
        signal,
        user: [
          `WEBSITE: ${host}`,
          `TASK JUST ATTEMPTED: ${task.goal}`,
          existing ? `ALREADY KNOWN (do not repeat any of this):\n${existing.slice(0, 1500)}` : "",
          `WHAT HAPPENED:\n${taskState.formatHistoryForModel(task)}`,
          task.workingMemory.facts.length
            ? `FACTS NOTED ALONG THE WAY:\n${task.workingMemory.facts.slice(-15).map((f) => `- ${f}`).join("\n")}`
            : "",
          "Write the notes worth keeping about this website.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      }));
      const saved = await memory.rememberWebsiteNotes(host, notes);
      // The user half of memory had a write function nothing ever called, so
      // the seed file could be read forever and never grow.
      const savedUser = userNotes?.length && memory.rememberUserFacts
        ? await memory.rememberUserFacts(userNotes)
        : 0;
      debug.log("learned", { host, offered: notes.length, saved, savedUser });
    } catch (e) {
      // Learning is a bonus; never let it turn a finished task into a failure.
      debug.log("learn_failed", { host, error: String(e?.message || e).slice(0, 200) });
    }
  };

  // Rounds are a budget, not a deadline: every time the user steps in to
  // unblock us, the task earns more of them so the wait itself can't be what
  // kills the run.
  const baseBudget = Math.max(1, Number(maxRounds) || DEFAULT_MAX_ROUNDS);
  let roundBudget = baseBudget;
  // Generous, but finite. Each hand-back used to add rounds with no ceiling, so
  // a page that kept needing a nudge could keep a run alive indefinitely.
  const maxRoundBudget = baseBudget + RESUME_ROUND_BONUS * 5;

  /**
   * Hand the browser to the user for one step, watch until they've taken it,
   * and report what changed. Waiting beats ending the run — they are right
   * there with the tab open, and everything already done stays done.
   *
   * Returns a note describing what the user did, or null when nobody is
   * watching / they never acted, in which case the caller stops as before.
   */
  const waitForUser = async (kind, question, decision = null) => {
    if (typeof onNeedsUser !== "function") return null;
    debug.log("needs_user", { kind, question: String(question || "").slice(0, 200) });
    onProgress({ phase: "waiting_for_user", kind, question: String(question || "") });
    const assist = await onNeedsUser({ kind, question, decision }).catch(() => null);
    if (!assist?.resumed) {
      debug.log("needs_user_unresolved", { kind });
      return null;
    }
    const note = String(assist.note || "the user acted in the browser").slice(0, 300);
    debug.log("resumed_after_user", { kind, note });
    // The page they left us is not the page we paused on.
    controller.invalidate();
    recovery.reset();
    roundBudget = Math.min(maxRoundBudget, roundBudget + RESUME_ROUND_BONUS);
    taskState.addFact(task, note);
    onProgress({ phase: "working", resumedAfterUser: true });
    return note;
  };

  debug.log("task_started", { goal: task.goal });
  onProgress({ phase: "planning", goal: task.goal });

  // --- Plan -----------------------------------------------------------------
  let snapshot = null;
  try {
    snapshot = await timer.time("snapshot", () => controller.getPageState());
  } catch {
    snapshot = null;
  }
  const initialWebsiteMemory = memory && snapshot?.url
    ? await memory.getWebsiteMemory(snapshot.url).catch(() => "")
    : "";
  try {
    const { clarification } = await timer.time("plan", () =>
      planner.planTask({ model, task, snapshot, userMemory, websiteMemory: initialWebsiteMemory, signal }));
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
  let lastScreenshotRound = -Infinity;
  let visionHint = "";
  let invalidDecisions = 0;
  let askUserDeferrals = 0;
  let finishPushbacks = 0;

  for (task.round = 1; ; task.round += 1) {
    if (aborted()) return finish("failed", "Task aborted.", { error: "aborted" });

    // Out of rounds. Before giving up, offer the user the wheel — one nudge is
    // usually all a long flow needs, and the work so far is still on screen.
    if (task.round > roundBudget) {
      const resumeNote = await waitForUser(
        "exhausted",
        "I've taken this as far as I can in one go. Move it forward a step in the browser and I'll carry on from there.",
      );
      if (!resumeNote) break;
      recovering = true;
      recoveryHint = `You had run out of steps. The user moved the page along (${resumeNote}). Re-read the page and continue the remaining work.`;
      continue;
    }

    // 1. Observe — always decide from a fresh snapshot when the last action
    //    could have changed the page.
    if (!controller.getCurrentSnapshot()) {
      await timer.time("settle", () => controller.settle());
      try {
        snapshot = await timer.time("snapshot", () => controller.getPageState());
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

    // On pages that draw themselves rather than describing themselves, the
    // element list is not a usable view — attach pixels before the agent
    // wastes rounds proving that.
    if (!pendingScreenshot) {
      const vision = visionPolicy.shouldSeePixels({
        snapshot,
        roundsSinceShot: task.round - lastScreenshotRound,
        always: grounder?.needsPixelsEveryRound === true,
      });
      if (vision.see) {
        const shot = await timer.time("screenshot", () => controller.screenshot()).catch(() => null);
        if (shot?.ok) {
          pendingScreenshot = shot.dataUrl;
          lastScreenshotRound = task.round;
          visionHint = vision.reason;
          debug.log("vision_attached", { round: task.round, reason: vision.reason });
        }
      }
    }

    // 2. Decide.
    let decision;
    try {
      decision = await timer.time("decide", () => executor.decideNext({
        model,
        task,
        snapshot,
        signal,
        memoryContext: { userMemory, websiteMemory },
        recovering,
        recoveryHint,
        lastVerification,
        screenshotDataUrl: pendingScreenshot,
        visionHint,
        groundingMode: grounder ? grounder.mode : "refs",
      }));
    } catch (e) {
      if (e instanceof AgentModelUnavailableError) throw e;
      return finish("failed", `Could not decide the next step: ${e?.message || e}`);
    }
    // Hold the exact frame the decide model saw: the grounder must reason over
    // the same pixels, and mapNormCoordToClient can only map against the most
    // recent capture. One screenshot per round keeps all three in agreement.
    const decideImage = pendingScreenshot;
    pendingScreenshot = "";
    visionHint = "";
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

    // 3.5 Ground — turn a described target into a point BEFORE the safety gate
    //     or the actuator sees this action. classifyActionRisk reads an
    //     element's label out of snapshot.byRef, and a description has no ref,
    //     so grounding later would let an outbound action past the gate.
    if (grounder?.needsGrounding(decision)) {
      const g = await timer.time("ground", () =>
        grounder.ground({ decision, snapshot, imageUrl: decideImage }));
      debug.log("grounded", g.log);
      if (g.fatal) {
        // Never silently continue on element refs: a "holo" run that was
        // secretly a refs run makes the comparison worthless.
        return finish("failed", `Grounding is unavailable: ${g.error}`);
      }
      decision = g.ok ? g.decision : { ...decision, kind: "invalid", invalidReason: g.invalidReason };
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
      // Scrolling and waiting always "succeed" — they are mechanical, and the
      // verifier confirms them deterministically. Counting them as evidence let
      // two scrolls stand in for doing the task, and the answer that followed
      // was whatever the model felt like writing. Evidence has to be something
      // that changed the world or told us something about it.
      const substantive = task.recentActions.filter(
        (a) => a.result === "success" && !EVIDENCE_FREE_ACTIONS.has(String(a.action?.type || "")),
      );
      const hasEvidence =
        task.workingMemory.facts.length > 0 ||
        task.workingMemory.candidateResults.length > 0 ||
        substantive.length > 0;
      // No round cap on this. The old `round <= 2` meant the requirement simply
      // switched itself off after round 2, which is when an ungrounded finish is
      // most likely, not least.
      if (!hasEvidence && finishPushbacks < 2) {
        finishPushbacks += 1;
        recovering = true;
        recoveryHint =
          "You tried to finish without any evidence of progress: nothing has been learned, nothing has been changed, " +
          "and scrolling and waiting do not count. Either do the work, or state plainly in `answer` what makes the " +
          "goal already satisfied and record it in `factsLearned`.";
        debug.log("finish_rejected", { round: task.round });
        continue;
      }
      if (!hasEvidence) {
        // It has been asked twice and still has nothing. Reporting an invented
        // answer as a completed task is worse than reporting the failure.
        return finish(
          "failed",
          "I couldn't complete this: I have no evidence that any of the work actually happened, " +
            "so I won't report a result I can't stand behind.",
          { completionReason: "finished without evidence" },
        );
      }
      // Quitting with plan steps still open is the most common way a task ends
      // half-done. Make the agent account for them once before accepting it.
      const openSteps = task.plan.filter((p) => !p.done).map((p) => p.step);
      if (openSteps.length && finishPushbacks < 1) {
        finishPushbacks += 1;
        recovering = true;
        recoveryHint =
          `These planned steps are not marked done yet: ${openSteps.join("; ")}. ` +
          "If any of them still needs doing, do it now — the user asked for the whole task, not the first part of it. " +
          "Only finish if every step is genuinely complete or no longer applies, and say so in your answer.";
        debug.log("finish_pushback", { round: task.round, openSteps });
        continue;
      }
      return finish("completed", decision.answer, { completionReason: decision.reason || "goal achieved" });
    }
    if (decision.kind === "ask_user") {
      // Only stop for something the user alone can supply. Asking permission
      // to proceed, or which obvious option to pick, abandons the task.
      if (!requiresHumanInput(decision.question) && askUserDeferrals < 1) {
        askUserDeferrals += 1;
        debug.log("ask_user_deferred", { question: decision.question });
        recovering = true;
        recoveryHint =
          `You asked the user: "${String(decision.question || "").slice(0, 240)}" — but this is something you can settle yourself ` +
          "from the page and the original request. Do not ask permission to continue, and do not ask the user to click something you " +
          "can click. Choose the option that best serves the goal and carry on. Stop only for a credential, a verification code, " +
          "payment details, or a fact that exists nowhere except in the user's head.";
        continue;
      }
      // Something only they can do (sign in, supply a code). Hand over the tab
      // and watch — don't end the task and make them start again.
      const resumed = await waitForUser("input", decision.question, decision);
      if (resumed) {
        recovering = true;
        recoveryHint =
          `You asked the user: "${String(decision.question || "").slice(0, 200)}". They have now acted in the browser ` +
          `(${resumed}). Re-read the page and continue the task from where it actually stands — do not ask again.`;
        continue;
      }
      return finish("waiting_for_user", decision.question, { needsUser: true });
    }
    if (decision.kind === "replan") {
      debug.log("replanning", { reason: decision.replanReason });
      onProgress({ phase: "replanning", reason: decision.replanReason });
      try {
        await planner.replanTask({
          model,
          task,
          snapshot,
          reason: decision.replanReason,
          signal,
          // null when the model said nothing about constraints; an array (even
          // an empty one) is the actor telling us which still apply. Without
          // this distinction there was no way to drop a constraint at all.
          constraints: decision.constraints,
        });
        debug.log("plan_revised", { plan: task.plan.map((p) => p.step), constraints: task.constraints });
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
    const authorized =
      sendPolicy !== "ask" && executor.goalAuthorizesAction(approvalText, decision, snapshot);
    if (risk === "consequential" && !authorized) {
      const el = snapshot.byRef.get(String(decision.action?.target || ""));
      // One short question, because the user answers it with a Yes/No button.
      const description = `Everything's ready — want me to ${describeConsequence(decision, el, { brief: true })}?`;
      debug.log("approval_needed", { action: decision.action, label: el?.label });
      let approved = false;
      let declined = false;
      if (typeof onApprovalNeeded === "function") {
        approved = await onApprovalNeeded({ question: description, decision }).catch(() => false);
        declined = !approved;
      }
      if (!approved) {
        // A "no" is an answer — respect it. Only when nothing can ask inline do
        // we fall back to watching the tab in case they click it themselves.
        const resumed = declined ? null : await waitForUser("approval", description, decision);
        if (resumed) {
          recovering = true;
          recoveryHint =
            `You paused for approval before ${describeConsequence(decision, el, { brief: true })}. The user then acted in the ` +
            `browser (${resumed}) — they may have done it themselves. Check the page first and do NOT repeat that action if it ` +
            `already happened; continue with whatever is left.`;
          continue;
        }
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
    if (typeof onBeforeAct === "function") {
      // Awaited on purpose — a screenshot taken here must land before the click.
      await onBeforeAct({ round: task.round, decision, snapshot }).catch(() => {});
    }
    // Last gate before the world changes. Abort was only checked at the top of
    // the round, so a Stop pressed while the model was deciding — which is when
    // people press it — still let this round's action land. On a checkout page
    // that meant Stop placed the order.
    if (aborted()) {
      debug.log("aborted_before_act", { round: task.round, action: decision.action });
      return finish("failed", "Stopped before the next action ran.", { error: "aborted" });
    }
    const actionResult = await timer.time("actuate", () =>
      executeAction(controller, decision.action)).catch((e) => ({
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
    // A screenshot the model asked for has to come back to it. The image was
    // captured, handed to the verifier as "screenshot completed", and dropped —
    // so the one deliberate way the agent has of looking at a page returned
    // nothing but a spent round.
    if (decision.action?.type === "screenshot" && actionResult?.ok && actionResult.dataUrl) {
      pendingScreenshot = actionResult.dataUrl;
      lastScreenshotRound = task.round + 1;
      visionHint = "you asked to look at the page";
    }

    // Extracted field content must persist across rounds — history lines are
    // truncated, and without this the model re-reads (or worse, retypes) the
    // same field forever.
    if (decision.action?.type === "extract" && actionResult?.ok) {
      const name = actionResult.label || decision.action.target;
      if (actionResult.checked !== undefined && !String(actionResult.value || "").trim()) {
        taskState.addFact(task, `"${name}" is ${actionResult.checked ? "checked" : "unchecked"}`);
      } else if (actionResult.value != null) {
        taskState.addFact(task, `field "${name}" contains: ${String(actionResult.value).slice(0, 500)}`);
      }
    }

    // 6. Observe the result.
    await timer.time("settle_after", () => controller.settle());
    let after = null;
    try {
      after = controller.getCurrentSnapshot()
        || (await timer.time("observe_after", () => controller.getPageState()));
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
        ? after.elements.find(
            (e) =>
              e.label === prevEl.label &&
              e.role === prevEl.role &&
              // An embedded editor and the page around it can hold identically
              // labeled fields; reading the wrong one reports empty.
              e.frameHost === prevEl.frameHost,
          )
        : null;
      if (fresh) extracted = await controller.extract(fresh.ref).catch(() => null);
    }

    // 7. Verify.
    let verification;
    try {
      verification = await timer.time("verify", () => verifier.verifyOutcome({
        model,
        decision,
        signal,
        actionResult,
        before,
        after,
        diff,
        extracted,
      }));
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

    const rollup = timer.roundRollup(task.round);
    if (rollup) debug.log("round_timing", rollup);

    if (verification.success) {
      recovering = false;
      recoveryHint = "";
      task.retryCount = 0;
      if (decision.planStepCompleted) taskState.markStepDone(task);
      // The action ran but the page could not confirm it. Show the agent the
      // screen next round so it verifies by looking instead of by assuming.
      if (verification.unverified) {
        const shot = await controller.screenshot().catch(() => null);
        if (shot?.ok) {
          pendingScreenshot = shot.dataUrl;
          lastScreenshotRound = task.round + 1;
          visionHint =
            "the last action could not be confirmed from the page structure — check here whether it worked";
        }
      }
      continue;
    }

    // 9. Recover.
    const step = recovery.nextRecoveryStep({ decision, verification });
    task.retryCount = recovery.retriesFor(decision);
    debug.log("recovery", { mode: step.mode, hint: step.hint, retries: task.retryCount, total: recovery.totalCount() });
    onProgress({ phase: "recovering", mode: step.mode, round: task.round });

    if (step.mode === "fail") {
      const blocker = verification.reason || "no progress on the page";
      const resumed = await waitForUser(
        "stuck",
        `I'm stuck on this step — ${String(blocker).slice(0, 160)}. Take it forward one step in the browser and I'll pick it back up.`,
        decision,
      );
      if (resumed) {
        recovering = true;
        recoveryHint =
          `Your attempts kept failing (${String(blocker).slice(0, 160)}), and the user has since moved the page along ` +
          `(${resumed}). Re-read the page and continue the remaining work from there.`;
        continue;
      }
      return finish(
        "failed",
        `I couldn't complete this: repeated attempts failed. Last problem: ${blocker}.`,
      );
    }
    if (step.mode === "replan") {
      try {
        await planner.replanTask({ model, task, snapshot: after, reason: step.hint, signal });
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
      if (shot.ok) {
        pendingScreenshot = shot.dataUrl;
        lastScreenshotRound = task.round;
      }
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
    case "click_coord":
      return controller.clickCoord(action.x, action.y, action.label, { snap: action.snap });
    case "type_coord":
      return controller.typeAtCoord(action.x, action.y, action.text ?? action.value ?? "", {
        pressEnter: action.pressEnter === true,
        label: action.label,
        snap: action.snap,
      });
    case "drag":
      return controller.drag(
        action.target || { x: action.x, y: action.y },
        action.to || { x: action.toX, y: action.toY },
      );
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
      return controller.scroll(action.direction || "down", 600, action.target || "");
    case "go_back":
      return controller.goBack();
    case "go_forward":
      return controller.goForward();
    case "press_key":
      return controller.pressKey(action.key || "Enter", action.modifiers);
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
