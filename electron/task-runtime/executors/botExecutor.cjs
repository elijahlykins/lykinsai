"use strict";

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
          ? (input) => runtime.runChild(name, (signal) => executor({ ...(input || {}), signal }))
          : executor,
      ]),
    );
    const primaryTool = String(runtime.primaryTool || "");
    const onProgress = (progress) => {
      runtime.progress?.(progress);
      runtime.onProgress?.(progress);
    };

    // Casual Bot chat is still a Task, but it has deterministic completion:
    // one persona-carrying reply is produced, then the runtime closes the Task.
    if (runtime.replyOnly || primaryTool === "reply") {
      const reply = executors.reply;
      if (typeof reply !== "function") {
        return { ok: false, status: "failed", reason: "reply_executor_unavailable" };
      }
      onProgress({ phase: "acting", tool: "reply", narration: "Replying…" });
      const result = await reply({ instruction: task.objective, signal: runtime.signal });
      if (runtime.signal?.aborted) return { ok: false, status: "cancelled" };
      const output = String(result?.output || result?.answer || "");
      if (result?.ok === false || !output.trim()) {
        return {
          ok: false,
          status: "failed",
          reason: String(result?.summary || result?.error || "empty_reply"),
          output,
        };
      }
      onProgress({ phase: "delivered", answer: output });
      return { ok: true, status: "completed", output, executor: "reply" };
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
      if (fallbackResult?.status === "waiting_for_user") {
        return {
          ...fallbackResult,
          status: "waiting_for_user",
          question: String(fallbackResult?.question || fallbackResult?.output || ""),
          executor: `bot-${primaryTool || "reply"}-fallback`,
        };
      }
      const output = String(fallbackResult?.output || fallbackResult?.answer || "");
      if (fallbackResult?.ok === false || !output.trim()) throw error;
      return {
        ok: true,
        status: "completed",
        output,
        executor: `bot-${primaryTool || "reply"}-fallback`,
      };
    }
    if (runtime.signal?.aborted || result?.status === "aborted") {
      return { ok: false, status: "cancelled", output: result?.answer || "" };
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

module.exports = { BotExecutor };
