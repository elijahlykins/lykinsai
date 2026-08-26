"use strict";

/**
 * Compatibility bridge for this phase.
 *
 * The Bot Harness still parks browser work and the approved continuation
 * re-enters agentRuntime's established browser pipeline. This adapter keeps
 * the parent Task identity attached to that pause without introducing a
 * second browser implementation. The next architecture phase can replace
 * this class with a real BrowserExecutor.
 */
class BrowserExecutorAdapter {
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
    const question =
      "This looks like something I'd need the browser for - want me to open it up and take care of it?";
    this.park?.({
      taskId: task.id,
      instruction: String(instruction || task.objective).trim() || task.objective,
    });
    return {
      ok: true,
      terminal: "waiting_for_user",
      question,
      questionOptions: ["Yes, use the browser", "No, just answer here"],
    };
  }
}

module.exports = { BrowserExecutorAdapter };
