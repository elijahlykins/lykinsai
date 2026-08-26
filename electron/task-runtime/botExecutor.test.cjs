"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TaskRuntime } = require("./taskRuntime.cjs");
const { BotExecutor } = require("./executors/botExecutor.cjs");

function makeTask(runtime, objective = "hey") {
  return runtime.createBotTask({
    objective,
    botTaskId: `ui-${objective}`,
    bot: { id: "bot-1", name: "Scout", persona: "Warm and concise." },
  });
}

test("cheap Reply path preserves Bot identity and skips the multi-round harness", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "hey");
  let harnessCalls = 0;
  let replyCalls = 0;
  const executor = new BotExecutor({
    runBotTask: async () => {
      harnessCalls += 1;
      throw new Error("harness should not run");
    },
  });
  const out = await runtime.execute(task.id, executor, {
    executorName: "bot",
    replyOnly: true,
    primaryTool: "reply",
    executors: {
      reply: async ({ instruction }) => {
        replyCalls += 1;
        assert.equal(instruction, "hey");
        assert.equal(task.origin.bot.name, "Scout");
        return { ok: true, output: "Hey - Scout here." };
      },
    },
  });
  assert.equal(out.task.status, "completed");
  assert.equal(out.result.output, "Hey - Scout here.");
  assert.equal(replyCalls, 1);
  assert.equal(harnessCalls, 0);
});

test("task-shaped execution passes canonical objective and constraints to runBotTask", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "check my email");
  let received = null;
  const executor = new BotExecutor({
    runBotTask: async (options) => {
      received = options;
      return { ok: true, status: "completed", answer: "Two unread messages.", events: [] };
    },
  });
  const out = await runtime.execute(task.id, executor, {
    executorName: "bot",
    model: {},
    executors: {},
    primaryTool: "browser",
  });
  assert.equal(out.task.status, "completed");
  assert.equal(received.goal, "check my email");
  assert.equal(received.task.objective, "check my email");
  assert.ok(received.task.doNot.includes("Continue looking for additional useful work."));
  assert.equal(received.maxRounds, task.budgets.maxRounds);
});

test("model-authored successCondition cannot replace the canonical Task objective", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "check my email");
  const executor = new BotExecutor({
    runBotTask: async ({ task: canonical }) => {
      assert.equal(canonical.objective, "check my email");
      assert.doesNotMatch(canonical.objective, /organize|summarize everything/i);
      return { ok: true, status: "completed", answer: "Checked." };
    },
  });
  await runtime.execute(task.id, executor, { model: {}, executors: {}, primaryTool: "browser" });
  assert.equal(runtime.get(task.id).objective, "check my email");
});

test("a teammate handoff pauses the canonical Task instead of completing it", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "compare launch plans");
  const executor = new BotExecutor({
    runBotTask: async () => ({
      ok: true,
      status: "completed",
      answer: "[[ask Pepper: Which launch window works?]]",
    }),
  });
  const out = await runtime.execute(task.id, executor, {
    model: {},
    executors: {},
    primaryTool: "research_report",
  });
  assert.equal(out.task.status, "waiting_for_user");
  assert.match(out.result.question, /ask Pepper/);
});

test("harness failure degrades within BotExecutor before TaskRuntime settles", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "research espresso machines");
  const executor = new BotExecutor({
    runBotTask: async () => {
      throw new Error("model unavailable");
    },
  });
  const out = await runtime.execute(task.id, executor, {
    model: {},
    primaryTool: "research_report",
    executors: {
      research_report: async ({ instruction }) => ({
        ok: true,
        output: `Direct result for ${instruction}`,
      }),
    },
  });
  assert.equal(out.task.status, "completed");
  assert.match(out.result.output, /espresso/);
});
