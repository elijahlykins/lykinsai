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
const { hasObservableChange } = require("./browser/snapshot.cjs");
const { createOwnership } = require("./browser/ownership.cjs");
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
const batchPolicy = require("./runtime/batch.cjs");
const deadEnd = require("./runtime/deadEnd.cjs");

const DEFAULT_MAX_ROUNDS = 24;

/** Extra rounds granted each time the user unblocks the task by hand. */
const RESUME_ROUND_BONUS = 6;

/**
 * Actions whose whole point is to make the page do something, so a page that
 * did nothing means the action needs looking at again.
 */
const SHOULD_CHANGE_SOMETHING = new Set([
  "click",
  "click_coord",
  "press_key",
  "select",
  "drag",
  "submit",
  "type",
  // Grounded typing is still typing — a page that ignored it deserves the
  // same second look before the verifier calls it a dead action.
  "type_coord",
]);

/**
 * How long to give a page that appears to have ignored an action, before
 * agreeing that it did.
 *
 * A debounced search, an animation that has to finish before the result mounts,
 * a render queued behind a timer — none of these are visible as work in
 * progress, so the settle step has nothing to wait for and returns to a page
 * that genuinely has not changed yet. One extra look is far cheaper than the
 * alternative: a false failure costs a recovery step, several thousand tokens
 * of re-deciding, and a retry that clicks the control a second time — which on
 * anything that toggles undoes the action that had in fact worked.
 */
const SECOND_LOOK_MS = 700;

/**
 * Actions that succeed mechanically and prove nothing about the task. They are
 * real work — you have to scroll to read a list — but "it scrolled" is not
 * evidence that the user's goal was met, and treating it as such is how a run
 * ends `completed` with an invented answer.
 */
const EVIDENCE_FREE_ACTIONS = new Set([
  "scroll",
  "wait",
  "screenshot",
  "go_back",
  "go_forward",
  "dismiss_overlay",
]);

/**
 * Things only the user can supply. Any other `ask_user` question is the agent
 * punting work back — asking permission to continue, or which of two obvious
 * options to take — and gets pushed back once before it can end the run.
 */
const HUMAN_ONLY_QUESTION_RE =
  /\b(password|passcode|passphrase|2fa|two[- ]factor|mfa|otp|one[- ]time (?:code|password)|verification code|security code|auth(?:entication)? code|sign[- ]?in|log[- ]?in|credential|captcha|card number|cvv|billing address|payment method|social security|ssn|date of birth|which account)\b/i;

/**
 * Asking what a message should SAY is not punting — it is the one question the
 * page can never answer.
 *
 * The agent writes things that go to other people, and when the request names
 * a recipient but no content ("write an email to sam@example.com"), the
 * substance exists only in the user's head. Without this the ask was pushed
 * back as a question the agent could settle itself, and it settled it by
 * inventing a message — once, memorably, out of whatever page happened to be
 * open.
 */
const CONTENT_QUESTION_RE =
  /\b(?:what|which|how)\b[^?]{0,80}\b(?:say|said|write|written|include|includes?|contain|cover|mention|word(?:ing)?|message|body|content|subject|tone|topic|point across)\b|\bwhat (?:should|shall|do you want|would you like|are we|is this)\b/i;

/**
 * A question the user answers by DOING something in the browser — signing in,
 * entering a code, clearing a wall — as opposed to one they answer by typing
 * back. The first kind is worth watching the tab for; the second has to come
 * back as a question in the chat, because no amount of watching the page will
 * ever produce it.
 */
const ANSWERED_IN_BROWSER_RE =
  /\b(password|passcode|passphrase|2fa|two[- ]factor|mfa|otp|one[- ]time (?:code|password)|verification code|security code|auth(?:entication)? code|sign[- ]?in|log[- ]?in|logged[- ]?in|credential|captcha|paywall|subscribe|unlock|which account)\b/i;

function requiresHumanInput(question) {
  const text = String(question || "");
  if (looksLikePermissionQuestion(text)) return false;
  return HUMAN_ONLY_QUESTION_RE.test(text) || CONTENT_QUESTION_RE.test(text);
}

/** Would watching the tab ever answer this? */
function answeredInBrowser(question) {
  const text = String(question || "");
  if (CONTENT_QUESTION_RE.test(text) && !ANSWERED_IN_BROWSER_RE.test(text)) return false;
  return ANSWERED_IN_BROWSER_RE.test(text);
}

/**
 * Asking permission is a punt however it is phrased. "Do you want me to sign
 * in?" contains "sign in", so the keyword test alone let the agent end the run
 * by asking to do something it should simply have done.
 */
const ASKING_PERMISSION_RE =
  /^\W*(?:do you want|would you like|should i|shall i|may i|can i|is it (?:ok|okay|alright)|are you (?:ok|happy|ready|sure)|ready for me|let me know if|would you prefer|which (?:would|do) you|confirm (?:that|if|whether)|please confirm)\b/i;

/**
 * A question that is really a request for permission to go ahead — however it
 * is phrased, and wherever in the sentence the giveaway sits.
 *
 * These must never reach the free-text question card. Permission is a yes or a
 * no, so it belongs on the approval buttons; asked as an open question the
 * user gets a text box, types "yes", and that answer then has to be
 * interpreted as an instruction — which is how one "yes" re-ran an entire
 * task from the beginning instead of clicking Send.
 */
const PERMISSION_QUESTION_RE =
  /\b(?:want me to|ready (?:for me )?to|shall i|should i|may i|ok(?:ay)? (?:for me )?to|permission to|go ahead and|would you like me to|do you want me to)\b|\b(?:ready|ok(?:ay)?|good) to (?:send|share|post|publish|submit|delete)\b/i;

function looksLikePermissionQuestion(question) {
  const text = String(question || "");
  return ASKING_PERMISSION_RE.test(text) || PERMISSION_QUESTION_RE.test(text);
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
 *
 * When `finish()` did run, it owns the close: learning continues in the
 * background after the result is returned (see `result.learning`), and closing
 * the stream here would cut its trace lines off mid-write.
 */
async function runBrowserAgentTask(opts) {
  const held = {};
  try {
    return await runTask({ ...opts, __holdDebug: held });
  } finally {
    if (!held.finished) held.debug?.close?.();
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
  // Who may authorize a consequential action (a send, a share, a publish).
  //   "auto" / "ask" — nobody yet: prepare everything, then confirm with the
  //     user before the committing click. This is the default and it is what
  //     every first-run task gets, however plainly its wording asked for a
  //     send. Wording is not consent: the words reaching this loop include the
  //     caller's own instruction lines and anything left over from an earlier
  //     turn, and neither is the user speaking now.
  //   "approved" — the user has just approved THIS send in words ("send it",
  //     "go ahead"), so the committing click may proceed without asking twice.
  // Money and data destruction are never authorized by any of these; they
  // always take an interactive yes.
  sendPolicy = "auto",
  // "refs": aim with element references from the snapshot only.
  // "holo": the model describes its target and a grounding model turns that
  // description into a point, for the whole run. Only the eval harness sets this.
  // Unset (production) resolves to "assist" when holoAssist is on.
  groundingMode = "",
  // Production default: refs do the aiming, and when the recovery ladder
  // escalates to pixels the model may describe its target for the grounder
  // instead of reading coordinates off the screenshot itself. Kill switch for
  // the caller; an outage of the grounder degrades rather than failing.
  holoAssist = true,
  // Per-stage span timing. Off in production; the disabled timer is a no-op.
  timing = false,
  // Awaited pre-action hook. onProgress is fired-and-forgotten, so a harness
  // that screenshots there races the click; this is the place to capture the
  // frame the action is about to change.
  onBeforeAct = null,
  // A serialized task snapshot (taskState.serializeTask) to continue instead
  // of starting fresh: planning is skipped, and the plan position, facts and
  // history all carry over. The browser is re-read on round one, so a page
  // that moved while the app was down is handled like any other surprise.
  resumeTask = null,
  // Called with a fresh serialized snapshot after planning, after every
  // recorded action, and at finish (where `status` is terminal) — everything a
  // host needs to offer resume across a restart. Failures are swallowed;
  // persistence must never cost a run.
  onTaskState = null,
  __holdDebug = null,
}) {
  const restored = resumeTask ? taskState.restoreTask(resumeTask, { conversationHistory }) : null;
  const task = restored || taskState.createTask({ goal, conversationHistory });
  const debug = createDebugLog({ userDataPath, taskId: task.id });
  if (__holdDebug) __holdDebug.debug = debug;
  const recovery = createRecoveryTracker();
  const timer = createTimer({ enabled: timing === true, onSpan: (sp) => debug.log("span", sp) });
  // null only when grounding is off entirely — that null is the loop's only
  // grounding-mode check. An explicit mode from the eval harness always wins.
  const grounder = createGrounder({
    mode: groundingMode || (holoAssist ? "assist" : "refs"),
    model,
  });
  // Assist is a rescue, not a method: it is offered for one round at a time,
  // only after element references have already failed on this step.
  let assistAvailable = grounder?.mode === "assist";
  let assistOffered = false;
  const userMemory = memory ? await memory.getUserMemory().catch(() => "") : "";

  let learned = false;
  /**
   * Every exit goes through here, and every exit learns.
   *
   * Learning used to hang off the one clean-finish path, so a run that fought a
   * site for twenty rounds and lost — the run with the most to teach the next
   * one — recorded nothing at all.
   *
   * Learning no longer delays the answer. It is one more model round-trip, and
   * awaiting it here meant the user stared at a finished task for the seconds
   * it took to write notes about the site. The result returns immediately;
   * learning continues in the background and `result.learning` settles when it
   * (and the debug stream it writes to) is done — that is what tests and any
   * caller that genuinely needs the notes on disk should await.
   */
  const finish = (status, answer, extra = {}) => {
    task.status = status;
    task.completionReason = extra.completionReason || answer.slice(0, 200);
    let learning = Promise.resolve();
    if (!learned) {
      learned = true;
      learning = recordWhatWeLearned(currentUrlSafe()).catch(() => {});
    }
    // finish owns the debug stream from here on; the wrapper's safety-net
    // close must not race the learning trace.
    if (__holdDebug) __holdDebug.finished = true;
    // The terminal snapshot — its status tells the host to clear stored state.
    persistState();
    const done = learning.then(() => {
      debug.log("task_finished", { status, completionReason: task.completionReason, rounds: task.round });
      debug.close();
    });
    return {
      ok: status !== "failed",
      status,
      answer,
      task,
      history: task.recentActions,
      learning: done,
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

  /** Hand the host a restart-safe snapshot. Never allowed to hurt the run. */
  const persistState = () => {
    if (typeof onTaskState !== "function") return;
    try {
      onTaskState(taskState.serializeTask(task));
    } catch {
      /* persistence is the host's problem, not the task's */
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

  debug.log("task_started", { goal: task.goal, resumed: !!restored });
  let snapshot = null;
  if (restored) {
    // --- Resume -------------------------------------------------------------
    // The plan, facts and history all survived the restart; what did not is
    // the page, which round one re-reads like any other round.
    debug.log("task_resumed", {
      planSteps: task.plan.length,
      priorActions: task.recentActions.length + task.archivedActionCount,
      facts: task.workingMemory.facts.length,
    });
    onProgress({
      phase: "working",
      plan: task.plan.map((p) => p.step),
      skills: task.skills,
      approach: "Picking this task back up from where it left off.",
    });
  } else {
    onProgress({ phase: "planning", goal: task.goal });

    // --- Plan ---------------------------------------------------------------
    try {
      snapshot = await timer.time("snapshot", () => controller.getPageState());
    } catch {
      snapshot = null;
    }
    const initialWebsiteMemory = memory && snapshot?.url
      ? await memory.getWebsiteMemory(snapshot.url).catch(() => "")
      : "";
    let approach = "";
    try {
      const planned = await timer.time("plan", () =>
        planner.planTask({ model, task, snapshot, userMemory, websiteMemory: initialWebsiteMemory, signal }));
      if (planned.clarification) {
        return finish("waiting_for_user", planned.clarification, {
          needsUser: true,
          // Tappable answers, when the planner proposed any — the host turns
          // these into one-tap chips beside the answer box.
          answerOptions: planned.clarificationOptions || [],
        });
      }
      approach = String(planned.approach || "");
    } catch (e) {
      if (e instanceof AgentModelUnavailableError) throw e;
      debug.log("plan_failed", { error: e?.message });
      // Planning is guidance — a failed planning call should not kill the task.
      taskState.setPlan(task, { plan: [`Work toward: ${task.goal}`] });
    }
    debug.log("plan_created", { plan: task.plan.map((p) => p.step), skills: task.skills, constraints: task.constraints });
    persistState();
    onProgress({
      phase: "working",
      plan: task.plan.map((p) => p.step),
      skills: task.skills,
      // What the user reads while the first page is still loading.
      approach,
    });
  }

  // --- Loop -----------------------------------------------------------------
  let recovering = false;
  let recoveryHint = "";
  if (restored) {
    // The first resumed decision must re-read reality rather than trust the
    // last history line — the page may have moved (or been moved) while the
    // app was down.
    recovering = true;
    recoveryHint =
      "This task was interrupted and is now resuming after a restart. The page in front of you may not " +
      "match the last history entry — re-read it, keep what the history shows as already done, and " +
      "continue the remaining work from where the page actually stands.";
  }
  let lastVerification = null;
  // Back-to-back verifications the loop has taken on faith (see the verifier's
  // deferInconclusive). Two in a row is the ceiling: a toggle clicked open and
  // closed changes the page both times, and without the cap that loop would
  // never meet a real verdict.
  let deferredVerifications = 0;
  let pendingScreenshot = "";
  let lastScreenshotRound = -Infinity;
  let visionHint = "";
  let invalidDecisions = 0;
  let askUserDeferrals = 0;
  // Two separate counters on purpose. These guard different failures — an
  // answer with no evidence behind it, and a finish with plan steps still
  // open — and when they shared one counter, a run that had already been
  // pushed back once for missing evidence could quit half-done without the
  // open-steps question ever being asked.
  let evidencePushbacks = 0;
  let openStepsPushbacks = 0;
  // Times the agent has asked permission instead of acting. Bounded, because
  // refusing without a limit is its own loop: it asks, we say go ahead, it
  // looks at the page, it asks again — for the whole round budget.
  let permissionRefusals = 0;
  const deadUrls = [];
  // Backout targets already offered. Tracked separately from the pages observed
  // to be dead, because a backout can land somewhere other than where it aimed
  // (a redirect, or another 404) — and without this the same candidate is
  // offered again next round and the run ping-pongs between two dead URLs.
  const triedBackouts = [];
  let deadEndRecoveries = 0;

  for (task.round = 1; ; task.round += 1) {
    if (aborted()) return finish("failed", "Task aborted.", { error: "aborted" });

    // Out of rounds. Before giving up, offer the user the wheel — one nudge is
    // usually all a long flow needs, and the work so far is still on screen.
    if (task.round > roundBudget) {
      // The budget has a ceiling, and once we are at it another hand-back buys
      // no further rounds. Asking anyway left the guard true, waitForUser kept
      // resolving, and `continue` spun here forever — with mocked I/O it is a
      // tight microtask loop that starves even a timer. A user who keeps
      // nudging a task that is out of budget is owed an ending, not a loop.
      if (roundBudget >= maxRoundBudget) {
        debug.log("round_budget_ceiling", { round: task.round, roundBudget });
        break;
      }
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
      // What the open dialog actually offers. A run that loops at the end is
      // usually one that cannot find a dialog's commit button, and a trace of
      // element COUNTS can never show whether the button was there to find.
      dialog: snapshot.elements
        .filter((el) => el.inDialog && el.label)
        .slice(0, 14)
        .map((el) => `${el.ref}:${el.role}:${String(el.label).slice(0, 40)}`),
    });
    // A wall cleared between rounds is a change to the page the agent did not
    // make. It reads it in the snapshot either way; recording it keeps the
    // history honest about why the page moved.
    for (const overlay of snapshot.overlaysDismissed || []) {
      const note = `cleared the ${overlay.what || overlay.kind} that was covering ${snapshot.url}`;
      debug.log("overlay_dismissed", { round: task.round, kind: overlay.kind, label: overlay.label });
      taskState.addFact(task, note);
      onProgress({ phase: "clearing_overlay", round: task.round, what: overlay.what || overlay.kind });
    }

    // 1.5 Dead end. A 404 loads successfully, so the URL change reads as
    //     progress and nothing in the retry ladder objects. Route around it
    //     here — backing out to an address that exists and finding the way from
    //     there is the agent's job, not the user's.
    const dead = deadEnd.looksLikeDeadEnd(snapshot);
    if (dead.deadEnd) {
      if (!deadUrls.includes(snapshot.url)) deadUrls.push(snapshot.url);
      taskState.addFact(task, `${snapshot.url} is a dead end — ${dead.reason}`);
      debug.log("dead_end", {
        round: task.round,
        url: snapshot.url,
        reason: dead.reason,
        recoveries: deadEndRecoveries,
      });
      const back =
        deadEndRecoveries < deadEnd.MAX_DEAD_END_RECOVERIES
          ? deadEnd.backoutTarget(snapshot.url, { avoid: [...deadUrls, ...triedBackouts] })
          : null;
      if (back) {
        deadEndRecoveries += 1;
        triedBackouts.push(back.url);
        onProgress({
          phase: "acting",
          round: task.round,
          action: { type: "navigate", url: back.url },
          reason: `${dead.reason} — backing out to ${back.what}`,
          narration:
            `That link is dead — ${dead.reason}. I'm backing out to ${back.what} ` +
            `and finding the route from there.`,
          expectedOutcome: "a page that exists, with navigation I can use",
          planStep: task.plan.find((p) => !p.done)?.step || "",
          url: snapshot.url,
        });
        const nav = await controller.navigate(back.url).catch((e) => ({
          ok: false,
          error: e?.message || String(e),
        }));
        taskState.recordAction(task, {
          action: { type: "navigate", url: back.url },
          expectedOutcome: "a page that exists, with navigation I can use",
          result: nav?.ok ? "success" : "failure",
          observedOutcome: nav?.ok
            ? `backed out of the dead end at ${snapshot.url}`
            : `could not reach ${back.url}: ${nav?.error || "navigation failed"}`,
        });
        recovering = true;
        recoveryHint = nav?.ok
          ? `${snapshot.url} is a dead end (${dead.reason}). Do not go back to it, and do not guess ` +
            `at another address on this site. You are now on ${back.url} — use this page's own ` +
            `navigation, search, or links to reach what the task needs.`
          : `${snapshot.url} is a dead end (${dead.reason}) and ${back.url} could not be reached ` +
            `either (${nav?.error || "navigation failed"}). Reach the target another way — a search ` +
            `engine, or a different entry point to this product.`;
        continue;
      }
      // Everything up the tree is dead too. That is a planning problem: say so
      // and let the next decision pick a different route entirely.
      recovering = true;
      recoveryHint =
        `Every address tried on this route is a dead end (${deadUrls.slice(-3).join(", ")}). ` +
        `Stop editing the URL. Find the target from a page that works — a search engine, or the ` +
        `product's own search — or replan the remaining steps.`;
    }

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

    // 2. Decide. Announce the wait before the call, not after it: the decide
    //    round is the longest pause in the loop, and a UI with nothing to show
    //    for it reads as a stall. The open plan step is the only honest thing
    //    we know about what it is weighing up until the answer lands.
    onProgress({
      phase: "thinking",
      round: task.round,
      planStep: task.plan.find((p) => !p.done)?.step || "",
      url: snapshot.url,
    });
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
        // Only ever true on the round after the ladder reached for pixels, and
        // only while the grounder is actually answering.
        assistGrounding: assistOffered && assistAvailable && !!pendingScreenshot,
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
    assistOffered = false;
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
      if (g.degraded) {
        // Assist is the rescue, not the task. When the grounder cannot answer,
        // the run falls back to what it did before assist existed — the model
        // reads the point off the screenshot itself — and stops paying for a
        // call that is not working.
        assistAvailable = false;
        debug.log("assist_degraded", { error: g.error });
        pendingScreenshot = decideImage;
        lastScreenshotRound = task.round + 1;
        visionHint = "the target locator is unavailable, so read the point off this image yourself";
        decision = {
          ...decision,
          kind: "invalid",
          invalidReason:
            "The target locator is unavailable, so a described target cannot be found. The screenshot is " +
            "still attached: read the position off it yourself and act with click_coord using 0-1000 coordinates.",
        };
      } else {
        decision = g.ok ? g.decision : { ...decision, kind: "invalid", invalidReason: g.invalidReason };
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
      // Scrolling and waiting always "succeed" — they are mechanical, and the
      // verifier confirms them deterministically. Counting them as evidence let
      // two scrolls stand in for doing the task, and the answer that followed
      // was whatever the model felt like writing. Evidence has to be something
      // that changed the world or told us something about it.
      const substantive = task.recentActions.filter(
        (a) =>
          a.result === "success" &&
          // Deferred verdicts were taken on faith — they keep the loop moving
          // but cannot underwrite a "completed" claim on their own.
          a.deferred !== true &&
          !EVIDENCE_FREE_ACTIONS.has(String(a.action?.type || "")),
      );
      const hasEvidence =
        task.workingMemory.facts.length > 0 ||
        task.workingMemory.candidateResults.length > 0 ||
        substantive.length > 0;
      // No round cap on this. The old `round <= 2` meant the requirement simply
      // switched itself off after round 2, which is when an ungrounded finish is
      // most likely, not least.
      if (!hasEvidence && evidencePushbacks < 2) {
        evidencePushbacks += 1;
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
      if (openSteps.length && openStepsPushbacks < 1) {
        openStepsPushbacks += 1;
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
      // Asking permission is not a question, whatever the model called it. It
      // is a yes/no about an action, and it has a surface of its own — the
      // approval buttons the safety gate raises when the committing click
      // actually arrives. Ending the run here instead hands the user a text
      // box asking "ready to send?", and their "yes" then has to be read as an
      // instruction: once, it re-ran the entire task from the top rather than
      // clicking Send. So this never terminates the run; the agent is told to
      // go and do the thing, and the gate will ask properly.
      if (looksLikePermissionQuestion(decision.question)) {
        permissionRefusals += 1;
        debug.log("permission_question_refused", {
          question: String(decision.question || "").slice(0, 200),
          refusals: permissionRefusals,
        });
        // Twice is a preference; a third time is a standoff. An agent that
        // keeps asking instead of clicking usually cannot work out how to
        // press the control — and refusing again just spends the round budget
        // on a conversation the user never sees. Hand them the yes/no they
        // were being asked for, with buttons, and let their answer release it.
        if (permissionRefusals > 2) {
          debug.log("permission_question_escalated", { round: task.round });
          return finish("waiting_for_user", decision.question, {
            needsUser: true,
            needsApproval: true,
          });
        }
        recovering = true;
        recoveryHint =
          `You asked the user for permission: "${String(decision.question || "").slice(0, 200)}". Do not ask that way — ` +
          "you cannot act on the answer, and it stops the task. Perform the action instead. If it genuinely commits " +
          "something (sends, shares, publishes, deletes, spends), you will be asked to confirm at the moment it " +
          "happens, with the details in front of the user — that check is automatic and is not your job.\n" +
          "If you are asking because you cannot work out how to press the control: it is in the element list — click " +
          "it by its reference rather than by eye. A dialog's main button is usually the last one in it, and pressing " +
          "Enter in the dialog's own field commits many of them. Take a screenshot only if you have not already looked.";
        continue;
      }
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
      // A question the user answers by typing — what the message should say,
      // which of several things they meant — comes straight back to the chat.
      // Watching the tab for it would park the run for half an hour on an
      // answer the page was never going to produce.
      if (!answeredInBrowser(decision.question)) {
        debug.log("asked_user", { question: String(decision.question || "").slice(0, 200) });
        return finish("waiting_for_user", decision.question, {
          needsUser: true,
          answerOptions: decision.questionOptions || [],
        });
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
      return finish("waiting_for_user", decision.question, {
        needsUser: true,
        answerOptions: decision.questionOptions || [],
      });
    }
    if (decision.kind === "replan") {
      debug.log("replanning", { reason: decision.replanReason });
      onProgress({
        phase: "replanning",
        reason: decision.replanReason,
        narration: String(decision.narration || "").slice(0, 600),
      });
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
    //
    // Delivering something to other people is now ALWAYS confirmed with the
    // user, whatever the request said and whatever app it happens in. The
    // request's own wording used to count as the yes, which failed in exactly
    // the way that matters: a stale instruction left over from an earlier turn
    // ("Send a Gmail email to …") was folded into a bare "write an email to
    // elijah@lykn.io", and its word "Send" pre-approved a message the user had
    // never seen. Only a real approval authorizes now — the inline Yes/No, or
    // a reply that plainly approves the send the agent just prepared, which
    // the caller signals as sendPolicy "approved".
    //
    // `userAsk` and nothing else: task.goal is enriched by the caller with
    // instruction lines, and reading those as the user's words is how an
    // instruction talks the gate into standing down.
    const risk = executor.classifyActionRisk(decision, snapshot);
    const approvalText = String(userAsk || "").trim();
    const authorized =
      sendPolicy === "approved" &&
      !!approvalText &&
      executor.goalAuthorizesAction(approvalText, decision, snapshot);
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
    // A batch runs the whole planned sequence; everything else is one action.
    // `decision.steps` is only ever populated when normalizeDecision admitted
    // it, so this branch never needs to re-check what is in it. Declared here,
    // above onProgress, because the progress event reads it too.
    const batched = Array.isArray(decision.steps) && decision.steps.length > 1;
    onProgress({
      phase: "acting",
      round: task.round,
      action: decision.action,
      // Not truncated to a label's width any more. The reason is the agent's
      // account of why this action is the right one, and the UI keeps it as the
      // step's expandable detail rather than squeezing it into the title.
      reason: String(decision.reason || "").slice(0, 400),
      // The commentary the user actually reads between steps.
      narration: String(decision.narration || "").slice(0, 600),
      expectedOutcome: String(decision.expectedOutcome || "").slice(0, 200),
      planStep: task.plan.find((p) => !p.done)?.step || "",
      targetLabel: targetEl?.label ? String(targetEl.label).slice(0, 60) : "",
      url: snapshot.url,
      batch: batched ? batchPolicy.describeBatch(decision.steps) : "",
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
      batched
        ? executeBatch(controller, decision.steps)
        : executeAction(controller, decision.action)).catch((e) => ({
      ok: false,
      error: e?.message || String(e),
    }));
    if (batched) {
      debug.log("batch_ran", {
        round: task.round,
        steps: batchPolicy.describeBatch(decision.steps),
        ran: actionResult?.ran,
        total: actionResult?.total,
        ok: actionResult?.ok !== false,
      });
      // The batch spent one round for several actions; say so in history or the
      // model reads the transcript as though only the first step happened.
      taskState.addFact(
        task,
        `ran ${actionResult?.ran ?? 0}/${actionResult?.total ?? 0} steps in one round: ` +
          batchPolicy.describeBatch(decision.steps),
      );
    }
    // The user has the browser. This is not an obstacle to route around: they
    // took it deliberately, usually because this run is going wrong. Retrying,
    // recovering or replanning would all be the agent fighting them for the
    // page. The only correct move is to ask and wait.
    if (actionResult?.error === "user_controlling") {
      debug.log("user_controlling", { round: task.round, reason: actionResult.reason || "" });
      const question =
        "You've taken over the browser — I've stopped so we're not both driving. " +
        "Tell me when you'd like me to pick it back up and I'll carry on from where you leave it.";
      const resumed = await waitForUser("handover", question);
      // A resume is not enough on its own: control comes back only when the
      // ownership store says so. Anything else would let a stray callback hand
      // the agent a browser the user is still using.
      if (resumed && controller.ownership?.()?.mayAct?.()) {
        recovering = true;
        recoveryHint =
          `You stopped because the user took over the browser. They have handed it back (${resumed}). ` +
          `Read the page before doing anything — they may have moved it on, or done the step ` +
          `themselves. Do not repeat work that is already on screen.`;
        continue;
      }
      return finish("waiting_for_user", question, { needsUser: true, handover: true });
    }
    debug.log("acted", {
      round: task.round,
      ok: actionResult?.ok !== false,
      error: actionResult?.error || "",
      resolved: actionResult?.resolved || "",
      clickedLabel: actionResult?.clickedLabel || "",
      x: actionResult?.x,
      y: actionResult?.y,
      // WHICH route actually ran, and whether the page confirmed it. Without
      // these a trace shows "typed, ok:true" for four different mechanisms and
      // gives no way to tell which one was used — or that the text never
      // landed anywhere at all.
      via: actionResult?.via || "",
      verified: actionResult?.verified === true,
      unverified: actionResult?.unverified === true,
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
    let diff = controller.diffSnapshots(before, after);

    // A page that answered slowly has not refused. Look once more before the
    // verifier gets a chance to call this a dead click and start recovering
    // from an action that actually worked.
    if (
      actionResult?.ok !== false &&
      SHOULD_CHANGE_SOMETHING.has(String(decision.action?.type || "")) &&
      !hasObservableChange(diff)
    ) {
      const later = await timer.time("second_look", async () => {
        await new Promise((r) => setTimeout(r, SECOND_LOOK_MS));
        controller.invalidate();
        await controller.settle(2000);
        return controller.getPageState().catch(() => null);
      });
      const laterDiff = later ? controller.diffSnapshots(before, later) : null;
      if (laterDiff && hasObservableChange(laterDiff)) {
        debug.log("second_look_caught_change", { round: task.round, diff: laterDiff.summary });
        after = later;
        diff = laterDiff;
      }
    }

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

    // 7. Verify. Ordinary actions may take an inconclusive-but-responsive page
    // on faith (the next decide re-reads it anyway); anything consequential,
    // anything claiming to complete a plan step, and the round after two
    // straight deferrals all get a real verdict.
    const deferInconclusive =
      deferredVerifications < 2 &&
      risk !== "consequential" &&
      decision.planStepCompleted !== true;
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
        deferInconclusive,
      }));
    } catch (e) {
      if (e instanceof AgentModelUnavailableError) throw e;
      verification = { success: false, evidence: "", reason: e?.message || String(e), next: "recover", method: "error" };
    }
    lastVerification = verification;
    deferredVerifications = verification.deferred === true ? deferredVerifications + 1 : 0;
    // What the page actually did is the other half of the step's story: the
    // reason says why it acted, this says whether the page agreed.
    onProgress({
      phase: "verified",
      round: task.round,
      success: verification.success === true,
      evidence: String(verification.evidence || "").slice(0, 200),
      reason: String(verification.reason || "").slice(0, 200),
      url: after?.url || snapshot.url,
    });
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
      // A deferred verdict was taken on faith, not shown — it must not later
      // stand in as proof the work happened (see the finish evidence check).
      ...(verification.deferred === true ? { deferred: true } : {}),
      observedOutcome: verification.evidence || verification.reason || diff.summary,
      retries: recovery.retriesFor(decision),
    });
    persistState();

    const rollup = timer.roundRollup(task.round);
    if (rollup) debug.log("round_timing", rollup);

    if (verification.success) {
      recovering = false;
      recoveryHint = "";
      task.retryCount = 0;
      // Progress buys back recovery budget: a long run that got PAST its
      // earlier snags must not die at the finish line on a cap those snags
      // spent (see recovery.noteProgress).
      recovery.noteProgress();
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
    onProgress({
      phase: "recovering",
      mode: step.mode,
      round: task.round,
      reason: String(verification.reason || "").slice(0, 200),
      hint: String(step.hint || "").slice(0, 200),
    });

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
      // The ladder has decided element references are not working on this step.
      // The screenshot below is what the grounder will read, so this is exactly
      // the round on which describing a target is worth its round-trip.
      assistOffered = assistAvailable;
      // Guarded like every other capture site. The shipped controller swallows
      // its own capture errors, so this is a contract with the injected
      // dependency rather than a live outage: a controller that rejects, or
      // answers with nothing, threw a plain Error straight out of the loop —
      // and the caller rethrows that instead of falling back, losing a task
      // that only wanted a look at the page. Without an image the run simply
      // continues on the recovery hint.
      const shot = await controller.screenshot().catch(() => null);
      if (shot?.ok) {
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
    case "paste_text":
      return controller.pasteText(action.text ?? action.value ?? "", {
        replaceAll: action.mode === "replace",
      });
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
    case "dismiss_overlay":
      return typeof controller.dismissOverlays === "function"
        ? controller.dismissOverlays({ allowGeneric: true })
        : { ok: true, dismissed: [], remaining: [] };
    default:
      return { ok: false, error: `unknown_action_type:${type}` };
  }
}

/**
 * Run an admitted batch as one unit.
 *
 * Steps are ordered and the page settles between them, because a scroll that
 * has not painted yet extracts the previous screen. The first failure ends the
 * batch: the sequence was planned against a page that has now behaved
 * unexpectedly, so everything after it was planned on a false premise.
 *
 * Nothing here re-validates the steps — `normalizeDecision` has already
 * guaranteed they are ref-free and non-committing, and duplicating that rule
 * is how the two copies drift apart.
 */
async function executeBatch(controller, steps) {
  const list = Array.isArray(steps) ? steps : [];
  const results = [];
  let lastType = "";
  for (let i = 0; i < list.length; i += 1) {
    const step = list[i];
    lastType = String(step?.type || "");
    let res;
    try {
      res = await executeAction(controller, step);
    } catch (e) {
      res = { ok: false, error: e?.message || String(e) };
    }
    results.push(res);
    if (!res || res.ok === false) {
      return {
        ok: false,
        error: res?.error || "batch_step_failed",
        ran: i + 1,
        total: list.length,
        results,
        lastType,
      };
    }
    // Let the page catch up before the next step reads or scrolls it. How long
    // that takes depends on what just ran: a navigation loads a document and
    // deserves the full budget, while a scroll only needs a paint — giving
    // every scroll 2.5s made a six-scroll batch spend most of its saved round
    // waiting on pages that had already settled.
    if (i < list.length - 1) {
      const loadsADocument = ["navigate", "go_back", "go_forward", "open_tab", "switch_tab"].includes(lastType);
      try {
        await controller.settle(loadsADocument ? 2500 : 400);
      } catch {
        /* settling is best-effort */
      }
    }
  }
  return { ok: true, error: "", ran: list.length, total: list.length, results, lastType };
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
  createOwnership,
  createAgentModel,
  createMemoryStore,
  AgentModelUnavailableError,
  executeBatch,
};
