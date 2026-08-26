"use strict";

/**
 * Compatibility adapter around the existing local-computer loop.
 * Security classification and approval remain inside localAgentTask/localSystem.
 */
class LocalExecutorAdapter {
  constructor({ runLocalTask } = {}) {
    if (typeof runLocalTask !== "function") throw new TypeError("runLocalTask is required");
    this.runLocalTask = runLocalTask;
  }

  async execute({ instruction, signal }) {
    const result = await this.runLocalTask({ instruction, signal });
    const output = String(result?.answer || result?.output || "");
    if (signal?.aborted || result?.status === "cancelled" || result?.status === "aborted") {
      return { ok: false, terminal: "cancelled", output, summary: output };
    }
    if (result?.status === "waiting_for_user") {
      return {
        ok: true,
        terminal: result.needsApproval ? "waiting_for_approval" : "waiting_for_user",
        output,
        question: output,
      };
    }
    return {
      ok: result?.ok !== false,
      output,
      summary: output.slice(0, 500),
    };
  }
}

module.exports = { LocalExecutorAdapter };
