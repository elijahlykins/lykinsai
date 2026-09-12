"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TaskRuntime } = require("./taskRuntime.cjs");
const { AgentExecutor } = require("./executors/agentExecutor.cjs");

function makeTask(runtime, objective = "hey") {
  return runtime.createAgentTask({
    objective,
    agentId: `agent-${objective}`,
  });
}

test("cheap Reply path skips the multi-round harness", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "hey");
  let harnessCalls = 0;
  let replyCalls = 0;
  const executor = new AgentExecutor({
    runAgentTask: async () => {
      harnessCalls += 1;
      throw new Error("harness should not run");
    },
  });
  const out = await runtime.execute(task.id, executor, {
    executorName: "agent",
    replyOnly: true,
    primaryTool: "reply",
    executors: {
      reply: async ({ instruction }) => {
        replyCalls += 1;
        assert.equal(instruction, "hey");
        return { ok: true, output: "Hey there." };
      },
    },
  });
  assert.equal(out.task.status, "completed");
  assert.equal(out.result.output, "Hey there.");
  assert.equal(replyCalls, 1);
  assert.equal(harnessCalls, 0);
});

test("task-shaped execution passes canonical objective and constraints to runAgentTask", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "check my email");
  let received = null;
  const executor = new AgentExecutor({
    runAgentTask: async (options) => {
      received = options;
      return { ok: true, status: "completed", answer: "Two unread messages.", events: [] };
    },
  });
  const out = await runtime.execute(task.id, executor, {
    executorName: "agent",
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
  const executor = new AgentExecutor({
    runAgentTask: async ({ task: canonical }) => {
      assert.equal(canonical.objective, "check my email");
      assert.doesNotMatch(canonical.objective, /organize|summarize everything/i);
      return { ok: true, status: "completed", answer: "Checked." };
    },
  });
  await runtime.execute(task.id, executor, { model: {}, executors: {}, primaryTool: "browser" });
  assert.equal(runtime.get(task.id).objective, "check my email");
});

test("harness failure degrades within AgentExecutor before TaskRuntime settles", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "research espresso machines");
  const executor = new AgentExecutor({
    runAgentTask: async () => {
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

test("fallback preserves waiting_for_approval instead of collapsing it", async () => {
  const runtime = new TaskRuntime();
  const task = makeTask(runtime, "email Sarah");
  const executor = new AgentExecutor({
    runAgentTask: async () => {
      throw new Error("model unavailable");
    },
  });
  const out = await runtime.execute(task.id, executor, {
    model: {},
    primaryTool: "research_report",
    executors: {
      research_report: async () => ({
        ok: false,
        status: "waiting_for_approval",
        question: "Send the email?",
      }),
    },
  });
  assert.equal(out.task.status, "waiting_for_approval");
  assert.match(out.result.question, /Send the email/);
});
