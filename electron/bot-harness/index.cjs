/**
 * The Bot harness — one loop for every task a LYKN Bot runs, with or without
 * the browser.
 *
 * Shape:
 *   decide (structured JSON against BOT_DECISION_SCHEMA)
 *     → use_tool: progressive disclosure — first selection of a tool loads
 *       its full doc instead of running; with the doc in context the call
 *       executes, gated by approval when consequential
 *     → verify the output actually advanced the goal; recover with guidance
 *       when it did not
 *     → deliver: the terminal summary of what was done
 *     → ask_user: hand the task back with one bundled question
 *
 * The system prompt (rules + tool index + bot identity + contract) is
 * byte-stable per bot; everything volatile travels in the user message.
 * Reasoning goes through the same server structured endpoint the browser
 * agent uses, so the Electron process holds no API keys.
 *
 * The harness owns the loop and the prompts; it does NOT own capability.
 * Callers inject `executors` — one async function per tool name — so the
 * same loop runs in production (executors bound to streamChat, the local
 * runner, the browser pipeline) and in tests (fakes).
 */

const { normalizeAnswerOptions } = require("../browser-agent/runtime/model.cjs");
const contextRouter = require("./runtime/contextRouter.cjs");
const registry = require("./runtime/toolRegistry.cjs");
const taskState = require("./runtime/taskState.cjs");

const DEFAULT_MAX_ROUNDS = 12;
const MAX_RECOVERIES = 2;

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
    // contract) — pinned into every later round's user message.
    successCondition: String(out.successCondition || "").trim(),
    doNot: Array.isArray(out.doNot) ? out.doNot.map(String).filter(Boolean) : [],
  };
}

/**
 * Run one Bot task to completion, a question, or the round budget.
 *
 * @param {object} opts
 * @param {object} [opts.task] - canonical Task supplied by TaskRuntime
 * @param {string} opts.goal - the user's ask, unwrapped of any dispatch brief
 * @param {{name?:string, role?:string, persona?:string}|null} opts.bot
 * @param {object} opts.model - `{ structured(stage, {system,user,schema,maxTokens,signal}), verify({system,user,signal}) }`
 * @param {Record<string, Function>} opts.executors - per-tool `async ({instruction, signal}) => { ok, output, summary?, terminal?, question?, questionOptions? }`
 * @param {Array<{role:string, content:string}>} [opts.conversationHistory]
 * @param {string} [opts.attachmentsNote]
 * @param {boolean} [opts.localMode]
 * @param {string} [opts.primaryTool] - routing's verdict; its doc is pre-loaded so the common single-tool task decides once and runs
 * @param {Function} [opts.onProgress]
 * @param {Function} [opts.onApproval] - `async ({tool, instruction, narration, question}) => boolean`
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRounds]
 * @returns {Promise<{ok:boolean, status:string, answer:string, question?:string, questionOptions?:string[], events:Array}>}
 */
async function runBotTask({
  task = null,
  goal,
  bot = null,
  model,
  executors = {},
  conversationHistory = [],
  attachmentsNote = "",
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
    collaborators: Array.isArray(task?.collaborators) ? task.collaborators : [],
    authoritativeBrief: !!task,
  });
  const system = contextRouter.buildDecisionSystem({ bot, localMode });
  const aborted = () => signal?.aborted === true;
  const finish = (status, answer, extra = {}) => ({
    ok: status !== "error",
    status,
    answer: String(answer || "").trim(),
    events: state.events,
    ...extra,
  });

  let extraNote = "";

  for (state.round = 1; state.round <= maxRounds; state.round += 1) {
    if (aborted()) return finish("aborted", "Task aborted.");

    const user = contextRouter.buildTaskUser({
      state,
      conversationHistory,
      attachmentsNote,
      extraNote,
    });
    extraNote = "";

    const decision = normalizeDecision(
      await model.structured("decide", {
        system,
        user,
        schema: contextRouter.BOT_DECISION_SCHEMA,
        // The deliver answer — the whole final message the user reads — is
        // written inside this same decision JSON. 700 tokens was enough for
        // tool rounds but cut real deliveries off mid-sentence; the budget
        // has to fit the longest honest summary, not just a tool call.
        maxTokens: 1800,
        signal,
      }),
    );
    if (aborted()) return finish("aborted", "Task aborted.");
    // Legacy direct callers may still accept a first-round planning brief.
    // Behind BotExecutor, canonical Task constraints make this a no-op.
    taskState.setTaskBrief(state, decision);
    if (decision.narration) onProgress({ phase: "thinking", narration: decision.narration });

    if (decision.kind === "deliver") {
      // Empty-handed delivery gets one pushback: the record shows nothing
      // ran, and routing already judged this ask task-shaped. The model may
      // still deliver next round (a refusal, an impossibility) — but it has
      // to do so knowingly. A record that already shows engagement — a
      // declined approval, a park, a noted dead end — is NOT empty-handed:
      // delivering honestly after the user said no is exactly right.
      const engaged = state.events.some((e) => e.kind !== "doc");
      if (state.executed === 0 && !engaged && !state.deliverPushbackUsed) {
        state.deliverPushbackUsed = true;
        taskState.recordNote(state, "delivery attempted before any tool ran — pushed back");
        extraNote =
          "NOTE: You are delivering but no tool has run this task. If the goal needs work, do the work first. Deliver now only if the task genuinely requires no tool (or must be declined), and say why in the answer.";
        continue;
      }
      const answer = decision.answer || "Done.";
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
        `selected unknown tool "${decision.tool || "(none)"}" — pick a name from the Tool Index exactly as written`,
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
      taskState.recordNote(state, `called \`${tool.name}\` with an empty instruction — nothing ran`);
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
      result = await executor({ instruction: decision.instruction, signal });
    } catch (e) {
      result = { ok: false, output: "", summary: `error: ${e?.message || e}` };
    }
    result = result && typeof result === "object" ? result : { ok: false, output: "" };

    // An executor can end the whole turn itself — the browser tool parking
    // its opt-in question, the local runner waiting on a file approval.
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
          ? `\`${tool.name}\` failed: ${String(result.summary || output || "no output").slice(0, 300)}. Adjust the instruction or approach and try once more — or deliver honestly.`
          : "You are out of retries. Deliver honestly with what is done and what failed.";
      onProgress({ phase: "recovering", tool: tool.name });
      continue;
    }

    // Verify substantive outputs against the goal. The browser and local
    // tools verify themselves; reply's text already reached the user.
    if (tool.verify && typeof model.verify === "function") {
      onProgress({ phase: "verifying", tool: tool.name });
      let v = null;
      try {
        v = await model.verify({
          system: contextRouter.buildVerificationSystem(),
          user: contextRouter.buildVerificationUser({
            goal: state.goal,
            successCondition: state.successCondition,
            tool: tool.name,
            instruction: decision.instruction,
            output,
          }),
          signal,
        });
      } catch {
        v = null; // verification must never kill a run — the record shows the raw output
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

    // A terminal tool that was the whole task ends it — the reply text
    // already reached the user, and a delivery on top of it would repeat it.
    if (tool.terminal && state.executed === 1) {
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
      : "I couldn't get this done — I ran out of working room before completing any of it. Try rephrasing, or break the task into smaller pieces.",
  );
}

module.exports = {
  runBotTask,
  DEFAULT_MAX_ROUNDS,
  // Exported for tests and the eval harness — they must drive the exact
  // contracts production uses.
  BOT_DECISION_SCHEMA: contextRouter.BOT_DECISION_SCHEMA,
  buildDecisionSystem: contextRouter.buildDecisionSystem,
  buildTaskUser: contextRouter.buildTaskUser,
  toolRegistry: registry,
};
