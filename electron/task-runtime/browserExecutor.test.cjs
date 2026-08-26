"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TaskRuntime } = require("./taskRuntime.cjs");
const { TASK_STATUSES } = require("./task.cjs");
const { BrowserExecutor, BrowserOptInGate } = require("./executors/browserExecutor.cjs");

let taskCounter = 0;
function browserTask(runtime, overrides = {}) {
  taskCounter += 1;
  return runtime.register({
    id: `task_test_${taskCounter}`,
    objective: "open the pricing page and read the plans",
    capabilities: ["browser.read", "browser.navigate", "browser.interact"],
    ...overrides,
  });
}

test("a task without a browser capability never reaches the browser", async () => {
  const runtime = new TaskRuntime();
  const task = browserTask(runtime, { capabilities: ["reply"] });
  let ran = false;
  const executor = new BrowserExecutor({
    runBrowserTask: async () => {
      ran = true;
      return { ok: true, status: "completed", answer: "should not happen" };
    },
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(ran, false);
  assert.equal(out.task.status, TASK_STATUSES.FAILED);
  assert.equal(out.task.completion.reason, "browser_capability_missing");
});

test("a completed browser run completes the Task with its answer", async () => {
  const runtime = new TaskRuntime();
  const task = browserTask(runtime);
  const executor = new BrowserExecutor({
    runBrowserTask: async ({ task: canonical, allowedActions }) => {
      assert.equal(canonical.objective, "open the pricing page and read the plans");
      // The capability strings must arrive translated into an action set.
      assert.ok(allowedActions.has("navigate"));
      assert.ok(allowedActions.has("click"));
      return {
        ok: true,
        status: "completed",
        answer: "Three plans: Free, Pro, Team.",
        history: [{ action: { type: "navigate" }, result: { ok: true } }],
      };
    },
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(out.task.status, TASK_STATUSES.COMPLETED);
  assert.equal(out.task.completion.output, "Three plans: Free, Pro, Team.");
  // The full mapped browser result travels for the host shell to render.
  assert.equal(out.result.browserResult.history.length, 1);
});

test("a parked browser run pauses the SAME Task and resumes under the same identity", async () => {
  const runtime = new TaskRuntime();
  const task = browserTask(runtime);
  const executor = new BrowserExecutor({
    runBrowserTask: async () => ({
      ok: true,
      status: "waiting_for_user",
      stuck: true,
      needsHelp: true,
      answer: "I need you to sign in first.",
      answerOptions: ["Done — continue", "Skip it"],
    }),
  });
  const first = await runtime.execute(task.id, executor);
  assert.equal(first.task.status, TASK_STATUSES.WAITING_FOR_USER);
  assert.equal(first.result.question, "I need you to sign in first.");
  assert.deepEqual(first.result.questionOptions, ["Done — continue", "Skip it"]);

  const resumed = new BrowserExecutor({
    runBrowserTask: async ({ task: canonical }) => {
      assert.equal(canonical.id, task.id);
      return { ok: true, status: "completed", answer: "Signed in and done." };
    },
  });
  const second = await runtime.execute(task.id, resumed);
  assert.equal(second.task.id, task.id);
  assert.equal(second.task.status, TASK_STATUSES.COMPLETED);
});

test("a run the browser gave up on is filed as a failure, never a completion", async () => {
  const runtime = new TaskRuntime();
  const task = browserTask(runtime);
  const executor = new BrowserExecutor({
    runBrowserTask: async () => ({
      ok: true,
      status: "failed",
      reason: "max_rounds",
      stuck: true,
      answer: "I couldn't complete this task.",
    }),
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(out.task.status, TASK_STATUSES.FAILED);
  assert.equal(out.task.completion.reason, "max_rounds");
  // The user-facing answer still travels with the result.
  assert.equal(out.result.browserResult.answer, "I couldn't complete this task.");
});

test("an aborted browser run cancels the Task", async () => {
  const runtime = new TaskRuntime();
  const task = browserTask(runtime);
  const executor = new BrowserExecutor({
    runBrowserTask: async () => ({ ok: false, status: "cancelled", error: "aborted" }),
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(out.task.status, TASK_STATUSES.CANCELLED);
});

test("runtime cancellation reaches the browser run through the Task signal", async () => {
  const runtime = new TaskRuntime();
  const task = browserTask(runtime);
  const executor = new BrowserExecutor({
    runBrowserTask: async ({ context }) =>
      new Promise((resolve) => {
        context.signal.addEventListener("abort", () =>
          resolve({ ok: false, status: "cancelled", error: "aborted" }),
        );
        runtime.cancel(task.id, "user_stop");
      }),
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(runtime.get(task.id).status, TASK_STATUSES.CANCELLED);
  assert.equal(runtime.get(task.id).cancellation.reason, "user_stop");
  assert.equal(out.task.status, TASK_STATUSES.CANCELLED);
});

test("the opt-in gate parks the original instruction against the Task and asks once", async () => {
  const parked = [];
  const gate = new BrowserOptInGate({ park: (p) => parked.push(p) });
  const task = { id: "task_gate", objective: "check the store's return policy" };
  const out = await gate.execute({ instruction: "  look up the return policy  ", task });
  assert.equal(out.terminal, "waiting_for_user");
  assert.ok(out.question.includes("browser"));
  assert.deepEqual(out.questionOptions, ["Yes, use the browser", "No, just answer here"]);
  assert.deepEqual(parked, [{ taskId: "task_gate", instruction: "look up the return policy" }]);
});

test("a declined gate refuses without parking a second ask", async () => {
  const parked = [];
  const gate = new BrowserOptInGate({ isDeclined: () => true, park: (p) => parked.push(p) });
  const out = await gate.execute({
    instruction: "look it up",
    task: { id: "task_gate2", objective: "look it up" },
  });
  assert.equal(out.ok, false);
  assert.match(out.summary, /stay out of the browser/);
  assert.equal(parked.length, 0);
});

test("observePassive never runs the browser-agent loop", async () => {
  let ran = false;
  const seen = [];
  const executor = new BrowserExecutor({
    runBrowserTask: async () => {
      ran = true;
      return { ok: true, status: "completed", answer: "nope" };
    },
    observePage: async ({ target }) => {
      seen.push(target.url);
      return { ok: true, status: "ok", fingerprint: "fp", url: target.url, target: { found: true, text: "Building" } };
    },
  });
  const obs = await executor.observePassive({
    target: { url: "https://render.com/deploy/123", target: { kind: "text", text: "Building" } },
  });
  assert.equal(ran, false);
  assert.equal(obs.fingerprint, "fp");
  assert.deepEqual(seen, ["https://render.com/deploy/123"]);
});
