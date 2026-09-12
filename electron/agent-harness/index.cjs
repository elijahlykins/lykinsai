/**
 * The Agent harness - one loop for every task-shaped run LYKN performs in the
 * background, with or without the browser (routine occurrences, headless
 * delegated work).
 *
 * Shape:
 *   decide (structured JSON against AGENT_DECISION_SCHEMA)
 *     → use_tool: progressive disclosure - first selection of a tool loads
 *       its full doc instead of running; with the doc in context the call
 *       executes, gated by approval when consequential
 *     → verify the output actually advanced the goal; recover with guidance
 *       when it did not
 *     → deliver: the terminal summary of what was done
 *     → ask_user: hand the task back with one bundled question
 *
 * The system prompt (rules + tool index + contract) is byte-stable;
 * everything volatile travels in the user message.
 * Reasoning goes through the same server structured endpoint the browser
 * agent uses, so the Electron process holds no API keys.
 *
 * The harness owns the loop and the prompts; it does NOT own capability.
 * Callers inject `executors` - one async function per tool name - so the
 * same loop runs in production (executors bound to streamChat, the local
 * runner, the browser pipeline) and in tests (fakes).
 */

const { normalizeAnswerOptions } = require("../browser-agent/runtime/model.cjs");
const contextRouter = require("./runtime/contextRouter.cjs");
const registry = require("./runtime/toolRegistry.cjs");
const taskState = require("./runtime/taskState.cjs");
const { createTurnTimings } = require("./runtime/turnTimings.cjs");

const DEFAULT_MAX_ROUNDS = 12;
const MAX_RECOVERIES = 2;

/**
 * A deliver answer that is itself a multi-section markdown document. A short
 * close quoting one heading stays under the length gate; only a genuine
 * re-write of the report trips both conditions.
 */
/**
 * "Done.", "All set!", "I've completed that." — a close that adds nothing to a
 * write-up the user has already read, so it is dropped rather than appended.
 */
function looksLikeGenericClose(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (t.length > 120) return false;
  return /^(?:done|all set|finished|complete[d]?|that'?s (?:it|done)|i(?:'ve| have) (?:done|completed|finished)\b[^.]*)[.!]?$/i.test(t);
}

function looksLikeFullReport(text) {
  const t = String(text || "");
  if (t.length < 1200) return false;
  return (t.match(/^#{1,3}\s+\S/gm) || []).length >= 2;
}

function normalizeDecision(raw) {
  const out = raw && typeof raw === "object" ? raw : {};
  const kind = ["use_tool", "deliver", "ask_user"].includes(out.kind) ? out.kind : "use_tool";
  return {
    kind,
    tool: String(out.tool || "").trim(),
    instruction: String(out.instruction || "").trim(),
    reason: String(out.reason || "").slice(0, 300),
    narration: String(out.narration || "").trim().slice(0, 500),
    risk: ["read", "low", "consequential"].includes(out.risk) ? out.risk : "low",
    answer: String(out.answer || "").trim(),
    question: String(out.question || "").trim(),
    questionOptions: normalizeAnswerOptions(out.questionOptions),
    // The task brief the model defines on its first decision (see the output
    // contract) - pinned into every later round's user message.
    successCondition: String(out.successCondition || "").trim(),
    doNot: Array.isArray(out.doNot) ? out.doNot.map(String).filter(Boolean) : [],
  };
}

/**
 * Run one task to completion, a question, or the round budget.
 *
 * @param {object} opts
 * @param {object} [opts.task] - canonical Task supplied by TaskRuntime
 * @param {string} opts.goal - the user's ask, unwrapped of any dispatch brief
 * @param {object} opts.model - `{ structured(stage, {system,user,schema,maxTokens,signal}), verify({system,user,signal}) }`
 * @param {Record<string, Function>} opts.executors - per-tool `async ({instruction, signal}) => { ok, output, summary?, terminal?, question?, questionOptions? }`
 * @param {Array<{role:string, content:string}>} [opts.conversationHistory]
 * @param {string} [opts.attachmentsNote]
 * @param {Array<{id?:string,name?:string}|string>} [opts.connectedApps]
 * @param {boolean} [opts.localMode]
 * @param {string} [opts.primaryTool] - routing's verdict; its doc is pre-loaded so the common single-tool task decides once and runs
 * @param {Function} [opts.onProgress]
 * @param {Function} [opts.onApproval] - `async ({tool, instruction, narration, question}) => boolean`
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRounds]
 * @returns {Promise<{ok:boolean, status:string, answer:string, question?:string, questionOptions?:string[], events:Array}>}
 */
async function runAgentTask({
  task = null,
  goal,
  model,
  executors = {},
  conversationHistory = [],
  attachmentsNote = "",
  /** Apps the user already has connected, so the model can prefer them over
   *  the browser instead of guessing. `[{ id, name }]` or bare names. */
  connectedApps = [],
  localMode = false,
  primaryTool = "",
  onProgress = () => {},
  onApproval = null,
  signal = null,
  maxRounds = DEFAULT_MAX_ROUNDS,
} = {}) {
  const canonicalGoal = String(task?.objective || goal || "").trim();
  const canonicalSuccess = Array.isArray(task?.successCriteria)
    ? task.successCriteria.join(" ")
    : "";
  const state = taskState.createTaskState({
    goal: canonicalGoal,
    // Pre-load only docs for tools that exist in this configuration.
    primaryTool: registry.getTool(primaryTool, { localMode }) ? primaryTool : "",
    successCondition: canonicalSuccess,
    doNot: Array.isArray(task?.doNot) ? task.doNot : [],
    authoritativeBrief: !!task,
  });
  const system = contextRouter.buildDecisionSystem({ localMode });
  const aborted = () => signal?.aborted === true;
  const timings = createTurnTimings({ taskId: String(task?.id || "") });

  const finish = (status, answer, extra = {}) => ({
    ok: status !== "error",
    status,
    answer: String(answer || "").trim(),
    events: state.events,
    // Even a failed or parked finish keeps the verified work: a report that
    // ran before the round budget died still reaches the user as a card.
    deliverables: state.deliverables,
    // Wall-clock breakdown of the turn. The caller pairs this with its token
    // and upstream accounting to separate provider latency from our own.
    timings: timings.summary(),
    ...extra,
  });

  let extraNote = "";
  // Output from a tool whose own text is what the user reads (the browser).
  // Kept so a later deliver closes over it instead of overwriting it with a
  // teaser — the reason that tool used to end the task outright.
  let preservedAnswer = "";
  let preservedAnswerTool = "";

  for (state.round = 1; state.round <= maxRounds; state.round += 1) {
    if (aborted()) return finish("aborted", "Task aborted.");

    const user = contextRouter.buildTaskUser({
      state,
      conversationHistory,
      attachmentsNote,
      connectedApps,
      extraNote,
    });
    extraNote = "";

    // Announce before the call, not after it. The decide round is a single
    // non-streaming POST, so emitting the phase afterwards left the user
    // watching an idle animation for the whole of it.
    onProgress({ phase: "deciding", round: state.round });
    const decision = normalizeDecision(
      await timings.span("decide", `r${state.round}`, () =>
        model.structured("decide", {
          system,
          user,
          // A next-step decision is a tool name, an instruction and a
          // narration. The 4,000-token budget belongs to the deliver call,
          // which is now its own round — see AGENT_DELIVER_SCHEMA.
          schema: contextRouter.AGENT_STEP_SCHEMA,
          maxTokens: contextRouter.STEP_MAX_TOKENS,
          signal,
        }),
      ),
    );
    if (aborted()) return finish("aborted", "Task aborted.");
    // Legacy direct callers may still accept a first-round planning brief.
    // Behind AgentExecutor, canonical Task constraints make this a no-op.
    taskState.setTaskBrief(state, decision);
    if (decision.narration) {
      // The narration is the first thing the user reads: that is
      // time-to-first-output, the number that decides whether a turn
      // "feels" slow independent of how long it actually takes.
      timings.markFirstOutput();
      onProgress({ phase: "thinking", narration: decision.narration });
    }

    if (decision.kind === "deliver") {
      // Empty-handed delivery gets one pushback: the record shows nothing
      // ran, and routing already judged this ask task-shaped. The model may
      // still deliver next round (a refusal, an impossibility) - but it has
      // to do so knowingly. A record that already shows engagement - a
      // declined approval, a park, a noted dead end - is NOT empty-handed:
      // delivering honestly after the user said no is exactly right.
      const engaged = state.events.some((e) => e.kind !== "doc");
      const routedWork = registry.getTool(primaryTool, { localMode }) && primaryTool !== "reply"
        ? primaryTool
        : "";
      if (state.executed === 0 && !engaged && !state.deliverPushbackUsed) {
        state.deliverPushbackUsed = true;
        taskState.recordNote(state, "delivery attempted before any tool ran - pushed back");
        extraNote = routedWork
          ? `NOTE: You are delivering but no tool has run this task. Routing already chose \`${routedWork}\`. A prior conversation result is not this task's work - run that tool now. Deliver without it only for a genuine refusal.`
          : "NOTE: You are delivering but no tool has run this task. If the goal needs work, do the work first. Deliver now only if the task genuinely requires no tool (or must be declined), and say why in the answer.";
        continue;
      }
      // The step schema carries no `answer` — writing the final message is its
      // own call with its own budget. Only the round that actually delivers
      // pays for it, instead of every round reserving room just in case.
      onProgress({ phase: "delivering" });
      let answer = "";
      try {
        const written = await timings.span("deliver", () =>
          model.structured("deliver", {
            system,
            user: contextRouter.buildDeliverUser({
              state,
              conversationHistory,
              attachmentsNote,
              connectedApps,
            }),
            schema: contextRouter.AGENT_DELIVER_SCHEMA,
            maxTokens: contextRouter.DELIVER_MAX_TOKENS,
            signal,
          }),
        );
        answer = String(written?.answer || "").trim();
      } catch (e) {
        // The work is done; failing the task because the closing sentence
        // could not be written would throw away everything that ran.
        answer = "";
      }
      if (!answer) answer = String(decision.answer || "").trim() || "Done.";
      // A deliver that re-writes a report the user already has as a document
      // card is the "second report" bug: in chat the close replaces the
      // streamed text, so a full re-write reads as a brand-new report being
      // written out. Swap it for a short close that points at the card.
      const reportCard = state.deliverables.find(
        (d) => d.kind === "html" && (d.tool === "research_report" || d.tool === "edit_report"),
      );
      if (reportCard && looksLikeFullReport(answer)) {
        answer = reportCard.title
          ? `Your report "${reportCard.title}" is ready - it's in the document above.`
          : "Your report is ready - it's in the document above.";
      }
      // The browser already showed its write-up. A deliver that is shorter
      // than what they read would replace it with a teaser, so keep the real
      // text and let the close ride behind it.
      if (preservedAnswer && answer.trim().length < preservedAnswer.length) {
        const close = answer.trim();
        answer =
          close && !looksLikeGenericClose(close)
            ? `${preservedAnswer}\n\n${close}`
            : preservedAnswer;
      }
      onProgress({ phase: "delivered", answer });
      return finish("completed", answer);
    }

    if (decision.kind === "ask_user") {
      const question = decision.question || "I need one more detail from you to continue.";
      onProgress({ phase: "waiting_for_user", question });
      return finish("waiting_for_user", question, {
        question,
        questionOptions: decision.questionOptions,
        needsUser: true,
      });
    }

    // kind === "use_tool"
    const tool = registry.getTool(decision.tool, { localMode });
    if (!tool) {
      taskState.recordNote(
        state,
        `selected unknown tool "${decision.tool || "(none)"}" - pick a name from the Tool Index exactly as written`,
      );
      continue;
    }
    const executor = executors[tool.name];
    if (typeof executor !== "function") {
      taskState.recordNote(state, `tool \`${tool.name}\` is not available in this run`);
      continue;
    }

    // Progressive disclosure: first selection reads the doc, never runs.
    if (!state.docsLoaded.has(tool.name)) {
      taskState.recordDocRead(state, tool.name);
      onProgress({ phase: "reading", tool: tool.name });
      extraNote = `You just read the full instructions for \`${tool.name}\` (above). Issue the call properly now, or pick a different tool if the instructions changed your mind.`;
      continue;
    }

    if (!decision.instruction) {
      taskState.recordNote(state, `called \`${tool.name}\` with an empty instruction - nothing ran`);
      continue;
    }

    // Safety gate: the registry risk is the floor, the decision can only
    // raise it. Consequential actions never run without the user's yes.
    const consequential = tool.risk === "consequential" || decision.risk === "consequential";
    if (consequential) {
      if (typeof onApproval !== "function") {
        taskState.recordApproval(state, { tool: tool.name, approved: false });
        extraNote =
          "That action needs the user's approval and no approval channel is available. Deliver honestly with what is done, or ask_user.";
        continue;
      }
      onProgress({ phase: "awaiting_approval", tool: tool.name, narration: decision.narration });
      const approved = await onApproval({
        tool: tool.name,
        instruction: decision.instruction,
        narration: decision.narration,
        question: `Approve before I go ahead? ${decision.narration || decision.instruction.slice(0, 140)}`,
      }).catch(() => false);
      taskState.recordApproval(state, { tool: tool.name, approved });
      if (!approved) {
        extraNote =
          "The user declined that action. Never retry it. Deliver honestly with what is done so far, or ask what they would prefer instead.";
        continue;
      }
    }

    onProgress({ phase: "acting", tool: tool.name, narration: decision.narration });

    let result;
    try {
      result = await timings.span("tool", tool.name, () =>
        executor({ instruction: decision.instruction, signal, goal: state.goal }),
      );
    } catch (e) {
      result = { ok: false, output: "", summary: `error: ${e?.message || e}` };
    }
    result = result && typeof result === "object" ? result : { ok: false, output: "" };

    // An executor can end the whole turn itself - the browser run needing
    // a mid-task answer, the local runner waiting on a file approval.
    if (result.terminal === "waiting_for_user" || result.terminal === "waiting_for_approval") {
      taskState.recordToolRun(state, {
        tool: tool.name,
        instruction: decision.instruction,
        ok: true,
        summary: "handed back to the user",
      });
      onProgress({ phase: "waiting_for_user", question: result.question || "" });
      return finish(
        result.terminal === "waiting_for_approval" ? "waiting_for_approval" : "waiting_for_user",
        result.question || result.output || "",
        {
          question: result.question || "",
          questionOptions: normalizeAnswerOptions(result.questionOptions),
          needsUser: true,
          needsApproval: result.terminal === "waiting_for_approval",
          parked: true,
        },
      );
    }

    const output = String(result.output || "");
    taskState.recordToolRun(state, {
      tool: tool.name,
      instruction: decision.instruction,
      ok: result.ok !== false,
      summary: String(result.summary || output).slice(0, 800),
    });

    if (result.ok === false) {
      state.recoveries += 1;
      state.guidance =
        state.recoveries <= MAX_RECOVERIES
          ? `\`${tool.name}\` failed: ${String(result.summary || output || "no output").slice(0, 300)}. Adjust the instruction or approach and try once more - or deliver honestly.`
          : "You are out of retries. Deliver honestly with what is done and what failed.";
      onProgress({ phase: "recovering", tool: tool.name });
      continue;
    }

    // Verify substantive outputs against the goal. The browser and local
    // tools verify themselves; reply's text already reached the user.
    //
    // A tool that hands back a DELIVERABLE has already produced the thing and
    // the user can usually see it — the report card, the image, the built
    // artifact are all on screen by now. Asking a model for a second opinion
    // on something already in front of them is a full round-trip the user
    // waits through for no decision. So a structured success with a
    // deliverable skips verification; anything ambiguous still gets checked.
    // A two-phase tool's discovery round is a STEP, not an attempt at the
    // goal. connected_apps has to search the catalog before it can call
    // anything, and verifying that search against "check my email" always
    // failed — so an agent spent its whole recovery budget on searches and
    // delivered "I couldn't complete a fresh inbox check" without ever
    // calling a tool it could see listed.
    if (result.needsFollowUp === true) {
      taskState.recordNote(
        state,
        `\`${tool.name}\` returned discovery results - the actual call still has to be made`,
      );
      extraNote =
        `\`${tool.name}\` gave you what is available, not the answer. Call it again now with the ` +
        `specific target from that output. Do NOT deliver, do not switch tools, and do not tell ` +
        `the user it could not be done - nothing has actually been attempted yet.`;
      continue;
    }

    // Self-evident: the run produced the thing, so a second opinion on it is
    // a round-trip the user waits through for no decision. Either it handed
    // back a deliverable the user can already see, or the tool itself knows
    // it fetched real data (`verified`) rather than a description of how to.
    const selfEvident =
      result.ok === true &&
      (result.verified === true ||
        (!!result.deliverable && typeof result.deliverable === "object"));
    if (selfEvident && tool.verify) {
      taskState.recordNote(
        state,
        `\`${tool.name}\` returned a finished deliverable - accepted without a separate verification round`,
      );
    }
    if (tool.verify && !selfEvident && typeof model.verify === "function") {
      onProgress({ phase: "verifying", tool: tool.name });
      let v = null;
      try {
        v = await timings.span("verify", tool.name, () => model.verify({
          system: contextRouter.buildVerificationSystem(),
          user: contextRouter.buildVerificationUser({
            goal: state.goal,
            successCondition: state.successCondition,
            tool: tool.name,
            instruction: decision.instruction,
            output,
          }),
          signal,
        }));
      } catch {
        v = null; // verification must never kill a run - the record shows the raw output
      }
      if (v) {
        taskState.recordVerification(state, {
          tool: tool.name,
          success: v.success === true,
          evidence: v.evidence,
          reason: v.reason,
        });
        if (v.success !== true) {
          state.recoveries += 1;
          state.guidance =
            state.recoveries <= MAX_RECOVERIES
              ? `The last ${tool.name} output did not accomplish the instruction: ${String(v.reason || "unverified").slice(0, 300)}. ${v.next === "replan" ? "Try a different tool or approach." : "Improve the instruction and run it again."}`
              : "You are out of retries. Deliver honestly with what is done and what could not be confirmed.";
          onProgress({ phase: "recovering", tool: tool.name });
          continue;
        }
      }
    }

    state.guidance = "";

    // The run held up (or was unverifiable) — keep its deliverable so the
    // final chat message carries the work as a card, whatever the model
    // writes in its deliver answer. Replaces an earlier copy from the same
    // tool, so a verify-retry rewrite yields one card, not two.
    if (result.deliverable && typeof result.deliverable === "object") {
      taskState.recordDeliverable(state, { tool: tool.name, deliverable: result.deliverable });
    }

    // Tools whose own output is the user-facing write-up (the browser's
    // finish answer). The user has already read it, so a later deliver must
    // close rather than re-summarise — but the task can still continue to its
    // remaining parts, which ending here used to make impossible.
    if (tool.preserveAnswer && String(output || "").trim()) {
      preservedAnswer = String(output).trim();
      preservedAnswerTool = tool.name;
      extraNote =
        `The \`${tool.name}\` write-up above already reached the user in full — do NOT repeat or ` +
        `re-summarise it. If the task has remaining parts, do them now. If it is finished, ` +
        `deliver a one-line close that points at what they just read.`;
    }

    // A successful terminal tool is the delivery. A verify-retry that
    // rewrote the same report used to leave executed > 1 and keep looping
    // into the browser and Google Docs.
    if (tool.terminal) {
      onProgress({ phase: "delivered", answer: output });
      return finish("completed", output);
    }
  }

  const done = state.events
    .filter((e) => e.kind === "tool" && e.ok)
    .map((e) => e.tool)
    .join(", ");
  return finish(
    "failed",
    done
      ? `I ran out of working room before finishing. Completed so far: ${done}. Ask me to continue and I'll pick it up from there.`
      : "I couldn't get this done. I ran out of working room before completing any of it. Try rephrasing, or break the task into smaller pieces.",
  );
}

module.exports = {
  runAgentTask,
  DEFAULT_MAX_ROUNDS,
  // Exported for tests and the eval harness - they must drive the exact
  // contracts production uses.
  AGENT_DECISION_SCHEMA: contextRouter.AGENT_DECISION_SCHEMA,
  buildDecisionSystem: contextRouter.buildDecisionSystem,
  buildTaskUser: contextRouter.buildTaskUser,
  toolRegistry: registry,
};
