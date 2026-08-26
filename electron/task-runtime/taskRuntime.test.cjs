"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TaskRuntime } = require("./taskRuntime.cjs");
const { TASK_STATUSES } = require("./task.cjs");

function runtimeWithEvents() {
  const events = [];
  return {
    events,
    runtime: new TaskRuntime({ onEvent: (event) => events.push(event) }),
  };
}

function botInput(overrides = {}) {
  return {
    objective: "check my email",
    botTaskId: "ui-task-a",
    botId: "bot-a",
    chatId: "chat-a",
    bot: { id: "bot-a", name: "Scout", role: "Researcher", persona: "Be concise." },
    ...overrides,
  };
}

test("compiler creates a unique immutable Task without broadening the objective", () => {
  const { runtime } = runtimeWithEvents();
  const a = runtime.createBotTask(botInput());
  const b = runtime.createBotTask(botInput({ botTaskId: "ui-task-b" }));
  assert.notEqual(a.id, b.id);
  assert.equal(a.runId, a.id);
  assert.equal(a.objective, "check my email");
  assert.deepEqual(a.successCriteria, [
    "The requested work has been performed and the requested result can be returned.",
  ]);
  assert.ok(a.doNot.includes("Continue looking for additional useful work."));
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.budgets), true);
  assert.throws(() => {
    "use strict";
    a.objective = "check and organize every message";
  }, TypeError);
});

test("executor completion is recorded by TaskRuntime and terminal state is immutable", async () => {
  const { runtime, events } = runtimeWithEvents();
  const task = runtime.createBotTask(botInput());
  const out = await runtime.execute(task.id, async (canonical) => {
    assert.equal(canonical.objective, "check my email");
    return { status: "completed", output: "You have two new messages." };
  });
  assert.equal(out.task.status, TASK_STATUSES.COMPLETED);
  assert.equal(out.task.completion.output, "You have two new messages.");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "task_created",
      "task_started",
      "executor_started",
      "executor_completed",
      "task_completed",
    ],
  );
  const again = await runtime.execute(task.id, async () => {
    throw new Error("must not resume");
  });
  assert.equal(again.ignored, true);
  assert.equal(runtime.cancel(task.id).ignored, true);
  assert.equal(runtime.get(task.id).status, TASK_STATUSES.COMPLETED);
});

test("waiting task resumes with the same identity", async () => {
  const { runtime } = runtimeWithEvents();
  const task = runtime.createBotTask(botInput());
  const first = await runtime.execute(task.id, async () => ({
    status: "waiting_for_user",
    question: "Which inbox?",
  }));
  assert.equal(first.task.status, TASK_STATUSES.WAITING_FOR_USER);
  const second = await runtime.execute(task.id, async (resumed) => ({
    status: "completed",
    output: `${resumed.id}: work done`,
  }));
  assert.equal(second.task.id, task.id);
  assert.equal(second.task.status, TASK_STATUSES.COMPLETED);
});

test("cancellation aborts the executor and stale success cannot settle the Task", async () => {
  const { runtime, events } = runtimeWithEvents();
  const task = runtime.createBotTask(botInput());
  let release;
  const run = runtime.execute(task.id, (_canonical, context) =>
    new Promise((resolve) => {
      release = () => resolve({ status: "completed", output: "late success" });
      context.signal.addEventListener("abort", () => {}, { once: true });
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  runtime.cancel(task.id, "user_stop");
  release();
  const result = await run;
  assert.equal(result.stale, true);
  assert.equal(runtime.get(task.id).status, TASK_STATUSES.CANCELLED);
  assert.equal(events.filter((event) => event.type === "task_cancelled").length, 1);
  assert.equal(events.some((event) => event.type === "task_completed"), false);
});

test("approval pause is structured and remains runtime-owned", async () => {
  const { runtime, events } = runtimeWithEvents();
  const task = runtime.createBotTask(botInput());
  const out = await runtime.execute(task.id, async (_canonical, context) => {
    context.approvalRequired({ tool: "send_email", question: "Approve send?" });
    assert.equal(runtime.get(task.id).status, TASK_STATUSES.WAITING_FOR_APPROVAL);
    context.approvalResolved(true);
    return { status: "completed", output: "Sent." };
  });
  assert.equal(out.task.status, TASK_STATUSES.COMPLETED);
  assert.equal(events.some((event) => event.type === "approval_required"), true);
});

test("executor failure and budget exhaustion become failed terminal Tasks", async () => {
  const { runtime } = runtimeWithEvents();
  const thrown = runtime.createBotTask(botInput());
  const thrownOut = await runtime.execute(thrown.id, async () => {
    throw new Error("provider unavailable");
  });
  assert.equal(thrownOut.task.status, TASK_STATUSES.FAILED);
  assert.equal(thrownOut.task.completion.reason, "provider unavailable");

  const exhausted = runtime.createBotTask(botInput({ botTaskId: "ui-task-budget" }));
  const exhaustedOut = await runtime.execute(exhausted.id, async (task) => ({
    status: "failed",
    reason: `round_budget_exhausted:${task.budgets.maxRounds}`,
  }));
  assert.equal(exhaustedOut.task.status, TASK_STATUSES.FAILED);
  assert.match(exhaustedOut.task.completion.reason, /round_budget_exhausted/);
});

test("events are attributable to the exact renderer BotTask", async () => {
  const { runtime, events } = runtimeWithEvents();
  const a = runtime.createBotTask(botInput({ botTaskId: "ui-a" }));
  const b = runtime.createBotTask(botInput({ botTaskId: "ui-b" }));
  await runtime.execute(a.id, async () => ({ status: "completed", output: "A" }));
  await runtime.execute(b.id, async () => ({ status: "completed", output: "B" }));
  const completions = events.filter((event) => event.type === "task_completed");
  assert.deepEqual(
    completions.map((event) => [event.taskId, event.association.botTaskId]),
    [
      [a.id, "ui-a"],
      [b.id, "ui-b"],
    ],
  );
});
