"use strict";


/**
 * Tools a Bot may run without a planning round in front of them.
 *
 * The test is not "is this tool cheap" — it is "has the planner got anything
 * left to decide". These four produce one thing from one instruction, none of
 * them spends money or reaches another person, and each one's own pipeline
 * handles its errors. Anything consequential (browser, connected_apps,
 * local_computer), anything that composes with other work
 * (research_report → build_artifact), and anything where choosing IS the work
 * keeps the full harness.
 */
const DIRECT_TOOLS = new Set(["reply", "web_search", "generate_image", "write_document"]);

const DIRECT_NARRATION = {
  reply: "Replying…",
  web_search: "Looking that up…",
  generate_image: "Creating the image…",
  write_document: "Writing it out…",
};

/**
 * Wording that means the ask has more than one part, so a single tool call
 * cannot finish it. Deliberately generous: a false positive costs one decide
 * round (the old behaviour), a false negative silently drops half the user's
 * request, which is the failure this whole fast path must not reintroduce.
 */
const MULTI_PART_RE = new RegExp(
  [
    // "…and then put it in a doc", "…, then email it"
    /\b(?:and\s+then|then\s+(?:also\s+)?(?:put|send|email|save|add|make|build|create|write|share|post|update)|after\s+that|afterwards?|finally)\b/
      .source,
    // "…and save it to", "…and send it to" — a second verb on a second object
    /\band\s+(?:also\s+)?(?:put|send|email|save|share|post|upload|add|attach|file|update|schedule|build|create|make|write|turn)\b/
      .source,
    // Enumerated or sequenced asks: "1. … 2. …", "…. Next, save them".
    // Anchored to a sentence boundary so "what's next in AI" is not a
    // second step.
    /(?:^|\n|[.!?]\s+)\s*(?:[2-9]\s*[.)]|second(?:ly)?\b|next\b[,\s])/.source,
    // An explicit second deliverable
    /\b(?:as\s+well\s+as|plus\s+(?:a|an|the)\b|along\s+with\s+(?:a|an|the)\b)/.source,
  ].join("|"),
  "i",
);

function looksMultiPart(text) {
  return MULTI_PART_RE.test(String(text || ""));
}

/**
 * The tool this task can run immediately, or "" to use the full harness.
 *
 * @param {{primaryTool:string, objective:string, replyOnly?:boolean, executors:object}} args
 */
function resolveDirectTool({ primaryTool, objective, replyOnly, executors }) {
  // Explicit reply-only callers keep their existing contract unconditionally.
  if (replyOnly) return typeof executors?.reply === "function" ? "reply" : "";
  const tool = String(primaryTool || "");
  if (!DIRECT_TOOLS.has(tool)) return "";
  if (typeof executors?.[tool] !== "function") return "";
  // `reply` was always direct regardless of shape — a chatty multi-part
  // message is still one reply. The others produce one artifact each, so a
  // multi-part ask genuinely needs the loop.
  if (tool !== "reply" && looksMultiPart(objective)) return "";
  return tool;
}

class BotExecutor {
  constructor({ runBotTask } = {}) {
    if (typeof runBotTask !== "function") throw new TypeError("runBotTask is required");
    this.runBotTask = runBotTask;
    this.name = "bot";
  }

  async execute(task, runtime = {}) {
    const executors = Object.fromEntries(
      Object.entries(runtime.executors || {}).map(([name, executor]) => [
        name,
        typeof executor === "function" && typeof runtime.runChild === "function"
          ? (input) =>
              runtime.runChild(name, (signal) =>
                executor({
                  ...(input || {}),
                  signal,
                  task,
                  progress: runtime.progress,
                }),
              )
          : executor,
      ]),
    );
    const primaryTool = String(runtime.primaryTool || "");
    const onProgress = (progress) => {
      runtime.progress?.(progress);
      runtime.onProgress?.(progress);
    };

    // ── Direct execution ────────────────────────────────────────────────
    //
    // Casual Bot chat has always taken this branch: one persona-carrying
    // reply, then the runtime closes the Task — no decide round, no verify
    // round. That is why chat felt fast while everything else did not.
    //
    // The same reasoning covers any ask where the planning has nothing left
    // to decide: routing already named the tool, there is one step, and the
    // tool is safe to run unsupervised. "Check the news" does not need a
    // planner to be told it is a search. Those asks used to pay two blocking
    // model round-trips — decide, then deliver — around a single call.
    //
    // Everything else keeps the full harness: multi-part asks, consequential
    // tools, anything where choosing IS the work.
    const directTool = resolveDirectTool({
      primaryTool,
      objective: task.objective,
      replyOnly: runtime.replyOnly,
      executors,
    });
    if (directTool) {
      const run = executors[directTool];
      if (typeof run !== "function") {
        return { ok: false, status: "failed", reason: `${directTool}_executor_unavailable` };
      }
      onProgress({
        phase: "acting",
        tool: directTool,
        narration: DIRECT_NARRATION[directTool] || "On it…",
      });
      const result = await run({ instruction: task.objective, signal: runtime.signal });
      if (runtime.signal?.aborted) return { ok: false, status: "cancelled" };
      if (result?.status === "waiting_for_approval" || result?.status === "waiting_for_user") {
        return {
          ...result,
          status: result.status,
          question: String(result.question || result.output || result.answer || ""),
          executor: directTool,
        };
      }
      const output = String(result?.output || result?.answer || "");
      if (result?.ok === false || !output.trim()) {
        // A direct run that came back empty is not a dead end: fall through to
        // the full harness, which can pick a different tool or ask. Failing
        // here would make the fast path strictly worse than the slow one.
        onProgress({ phase: "recovering", tool: directTool });
      } else {
        if (result?.deliverable && typeof result.deliverable === "object") {
          onProgress({ phase: "deliverable", tool: directTool, deliverable: result.deliverable });
        }
        onProgress({ phase: "delivered", answer: output });
        return {
          ok: true,
          status: "completed",
          output,
          executor: directTool,
          deliverables: result?.deliverable ? [{ tool: directTool, deliverable: result.deliverable }] : [],
        };
      }
    }

    const onApproval = runtime.onApproval
      ? async (request) => {
          runtime.approvalRequired?.(request);
          const approved = await runtime.onApproval(request);
          runtime.approvalResolved?.(approved);
          return approved;
        }
      : null;
    let result;
    try {
      result = await this.runBotTask({
        task,
        goal: task.objective,
        bot: task.origin?.bot || null,
        model: runtime.model,
        executors,
        conversationHistory: runtime.conversationHistory || [],
        attachmentsNote: runtime.attachmentsNote || "",
        localMode: runtime.localMode === true,
        primaryTool,
        onProgress,
        onApproval,
        signal: runtime.signal,
        maxRounds: task.budgets.maxRounds,
      });
    } catch (error) {
      if (runtime.signal?.aborted) throw error;
      // Preserve the existing single-shot degradation inside the Executor
      // boundary so TaskRuntime does not record failure before fallback runs.
      const fallback = executors[primaryTool] || executors.reply;
      if (typeof fallback !== "function") throw error;
      onProgress({
        phase: "acting",
        tool: primaryTool || "reply",
        narration: "Finishing with the direct path…",
      });
      const fallbackResult = await fallback({ instruction: task.objective, signal: runtime.signal });
      if (runtime.signal?.aborted) {
        return { ok: false, status: "cancelled", output: "", executor: `bot-${primaryTool || "reply"}-fallback` };
      }
      if (fallbackResult?.status === "waiting_for_approval") {
        return {
          ...fallbackResult,
          status: "waiting_for_approval",
          question: String(fallbackResult?.question || fallbackResult?.output || ""),
          executor: `bot-${primaryTool || "reply"}-fallback`,
        };
      }
      const output = String(fallbackResult?.output || fallbackResult?.answer || "");
      if (/^\s*\[\[ask\s+[^:\]]+:/i.test(output)) {
        return {
          ...fallbackResult,
          ok: false,
          status: "waiting_for_user",
          waitingKind: "teammate_handoff",
          question: output,
          executor: `bot-${primaryTool || "reply"}-fallback`,
        };
      }
      if (fallbackResult?.status === "waiting_for_user") {
        return {
          ...fallbackResult,
          status: "waiting_for_user",
          question: String(fallbackResult?.question || fallbackResult?.output || ""),
          executor: `bot-${primaryTool || "reply"}-fallback`,
        };
      }
      if (fallbackResult?.ok === false || !output.trim()) throw error;
      return {
        ok: true,
        status: "completed",
        output,
        executor: `bot-${primaryTool || "reply"}-fallback`,
      };
    }
    if (runtime.signal?.aborted || result?.status === "aborted" || result?.status === "cancelled") {
      return { ok: false, status: "cancelled", output: result?.answer || result?.output || "" };
    }
    if (result?.status === "waiting_for_user" || result?.status === "waiting_for_approval") {
      return {
        ...result,
        status: result.status,
        question: String(result.question || result.answer || result.output || ""),
        executor: "bot-harness",
      };
    }
    if (result?.status === "max_rounds") {
      return {
        ...result,
        ok: false,
        status: "failed",
        reason: "round_budget_exhausted",
        output: String(result?.answer || result?.output || ""),
        executor: "bot-harness",
      };
    }
    if (/^\s*\[\[ask\s+[^:\]]+:/i.test(String(result?.answer || ""))) {
      return {
        ...result,
        status: "waiting_for_user",
        question: String(result.answer || ""),
        waitingKind: "teammate_handoff",
        executor: "bot-harness",
      };
    }
    return {
      ...result,
      output: String(result?.answer || result?.output || ""),
      status: result?.status || (result?.ok === false ? "failed" : "completed"),
      executor: "bot-harness",
    };
  }
}

module.exports = { BotExecutor, resolveDirectTool, looksMultiPart, DIRECT_TOOLS};
