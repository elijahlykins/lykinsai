"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskRuntime } = require("../../electron/task-runtime/taskRuntime.cjs");
const {
  compileWorkflow,
  WorkflowExecutor,
  createWorkflowStore,
} = require("../../electron/teach/index.cjs");
const OWNER = { botId: "bot_1" };

test("replay runs under injected TaskRuntime and delegates every step to its adapter", async () => {
  const workflow = await compileWorkflow({
    ...OWNER,
    id: "wf_replay",
    name: "Replay",
    events: [
      { kind: "browser", action: "navigate", target: { url: "https://example.test" } },
      { kind: "local", action: "read", target: { path: "/tmp/report" } },
      { kind: "mcp", action: "list", target: { connectionId: "github", toolName: "issues.list" } },
      { kind: "remote", action: "read", target: { remoteTargetId: "box" } },
      { kind: "task", action: "delegate", target: { taskId: "child" } },
    ],
  });
  const calls = [];
  const adapters = Object.fromEntries(["browser", "local", "mcp", "remote", "task"].map((kind) => [
    kind,
    async (_task, context) => {
      calls.push({ kind, step: context.step, signal: context.signal });
      return kind === "browser"
        ? { ok: true, status: "completed", url: "https://example.test" }
        : { ok: true, status: "completed", output: "ok" };
    },
  ]));
  const runtime = new TaskRuntime();
  let registers = 0;
  let executions = 0;
  const register = runtime.register.bind(runtime);
  const execute = runtime.execute.bind(runtime);
  runtime.register = (...args) => { registers += 1; return register(...args); };
  runtime.execute = (...args) => { executions += 1; return execute(...args); };
  const executor = new WorkflowExecutor({ taskRuntime: runtime, adapters });
  const outcome = await executor.execute(workflow);
  assert.equal(registers, 1);
  assert.equal(executions, 1);
  assert.equal(outcome.task.status, "completed");
  assert.equal(outcome.result.completed.length, 5);
  assert.deepEqual(calls.map((call) => call.kind), ["browser", "local", "mcp", "remote", "task"]);
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  assert.equal(calls[2].step.target.connectionId, "github");
});

test("declared parameters inject at runtime but undeclared values do not", async () => {
  const workflow = await compileWorkflow({
    ...OWNER,
    name: "Parameterized",
    events: [{
      kind: "mcp",
      action: "list",
      target: { connectionId: "github", toolName: "search" },
      input: { query: "{{query}}" },
    }],
  });
  let args;
  const executor = new WorkflowExecutor({
    taskRuntime: new TaskRuntime(),
    adapters: { mcp: async (_task, context) => { args = context.args; return { ok: true }; } },
  });
  await assert.rejects(() => executor.execute(workflow), /Missing required/);
  await executor.execute(workflow, { query: "bugs", undeclared: "not injected" });
  assert.deepEqual(args, { query: "bugs" });
});

test("approval-required steps pause structurally before adapter execution", async () => {
  const workflow = await compileWorkflow({
    ...OWNER,
    name: "Approval",
    events: [
      { kind: "mcp", action: "list_channels", target: { connectionId: "slack", toolName: "channels.list" } },
      { kind: "mcp", action: "send_message", target: { connectionId: "slack", toolName: "chat.send" } },
    ],
  });
  let calls = 0;
  const executor = new WorkflowExecutor({
    taskRuntime: new TaskRuntime(),
    adapters: { mcp: async () => { calls += 1; return { ok: true }; } },
  });
  const outcome = await executor.execute(workflow);
  assert.equal(outcome.task.status, "waiting_for_approval");
  assert.equal(outcome.result.status, "waiting_for_approval");
  assert.equal(calls, 1);
  assert.deepEqual(outcome.result.completed.map((item) => item.stepId), ["step_1"]);

  const approved = await executor.execute(workflow, {}, { approvedSteps: ["step_2"] });
  assert.equal(approved.task.status, "completed");
  assert.equal(calls, 3);
});

test("browser, local, and remote consequences keep their native executor approval gates", async () => {
  for (const kind of ["browser", "local", "remote"]) {
    const workflow = await compileWorkflow({
      ...OWNER,
      name: `Native ${kind} gate`,
      events: [{
        kind,
        action: "submit",
        target:
          kind === "browser"
            ? { role: "button", name: "Send" }
            : kind === "remote"
              ? { remoteTargetId: "box" }
              : { path: "/tmp/out" },
      }],
    });
    let calls = 0;
    const executor = new WorkflowExecutor({
      taskRuntime: new TaskRuntime(),
      adapters: {
        [kind]: async () => {
          calls += 1;
          return { status: "waiting_for_approval", question: "Native executor asks" };
        },
      },
    });
    const outcome = await executor.execute(workflow);
    assert.equal(calls, 1);
    assert.equal(outcome.task.status, "waiting_for_approval");
    assert.equal(outcome.result.question, "Native executor asks");
  }
});

test("human takeover pauses before replaying sensitive actions", async () => {
  const workflow = await compileWorkflow({
    ...OWNER,
    name: "Takeover",
    events: [{
      kind: "browser",
      action: "fill",
      target: { role: "textbox", name: "Verification code" },
      input: { otp: "123456" },
    }],
  });
  let calls = 0;
  const executor = new WorkflowExecutor({
    taskRuntime: new TaskRuntime(),
    adapters: { browser: async () => { calls += 1; return { ok: true }; } },
  });
  const outcome = await executor.execute(workflow);
  assert.equal(outcome.task.status, "waiting_for_user");
  assert.equal(outcome.result.waitingKind, "human_takeover");
  assert.equal(calls, 0);
});

test("deterministic verification runs before bounded semantic recovery and retries adapter", async () => {
  const workflow = await compileWorkflow({
    ...OWNER,
    name: "Recover",
    events: [{ kind: "browser", action: "click", target: { role: "button", name: "Save" } }],
  });
  const order = [];
  let adapterCalls = 0;
  let recoveryCalls = 0;
  const executor = new WorkflowExecutor({
    taskRuntime: new TaskRuntime(),
    maxRecoveries: 1,
    adapters: {
      browser: async () => {
        order.push("adapter");
        adapterCalls += 1;
        return { ok: true, targetPresent: adapterCalls > 1 };
      },
    },
    verifyDeterministic: async (_step, result) => {
      order.push("verify");
      return { ok: result.targetPresent, reason: "target_missing" };
    },
    semanticRecovery: async () => {
      order.push("recover");
      recoveryCalls += 1;
      return { confidence: "high", target: { strategy: "semantic", confidence: "high", role: "button", name: "Save changes" } };
    },
  });
  const outcome = await executor.execute(workflow);
  assert.equal(outcome.task.status, "completed");
  assert.deepEqual(order, ["adapter", "verify", "recover", "adapter", "verify"]);
  assert.equal(recoveryCalls, 1);
  assert.equal(outcome.result.workflowUpdated, false);
  assert.equal(outcome.result.proposedUpdates.length, 1);
});

test("low-confidence recovery returns waiting_for_user and never silently mutates workflow", async () => {
  const workflow = await compileWorkflow({
    ...OWNER,
    id: "wf_visual",
    name: "Visual",
    events: [{ kind: "browser", action: "click", target: { visual_anchor: { x: 10, y: 20 } } }],
  });
  const before = JSON.stringify(workflow);
  let adapterCalls = 0;
  const executor = new WorkflowExecutor({
    taskRuntime: new TaskRuntime(),
    adapters: { browser: async () => { adapterCalls += 1; return { ok: true }; } },
    semanticRecovery: async () => ({ confidence: "low", target: { role: "button" } }),
  });
  const outcome = await executor.execute(workflow);
  assert.equal(outcome.task.status, "waiting_for_user");
  assert.equal(outcome.result.waitingKind, "low_confidence_recovery");
  assert.equal(adapterCalls, 0);
  assert.equal(JSON.stringify(workflow), before);
});

test("high-confidence recovery is run-local until explicit version update", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "teach-update-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workflow = await compileWorkflow({
    ...OWNER,
    id: "wf_update",
    name: "Update",
    events: [{ kind: "browser", action: "click", target: { visual_anchor: { x: 1, y: 2 } } }],
  });
  const store = createWorkflowStore({ userDataPath: directory, maxPreviousVersions: 2 });
  store.put(workflow);
  const executor = new WorkflowExecutor({
    taskRuntime: new TaskRuntime(),
    adapters: { browser: async () => ({ ok: true, targetPresent: true }) },
    semanticRecovery: async () => ({
      confidence: "high",
      target: { strategy: "semantic", confidence: "high", role: "button", name: "Continue" },
    }),
  });
  const outcome = await executor.execute(workflow);
  assert.equal(store.get(workflow.id).version, 1);
  assert.equal(store.get(workflow.id).steps[0].target.strategy, "visual_anchor");
  const updated = executor.updateWorkflow(store, workflow.id, {
    steps: outcome.result.proposedUpdates,
  }, { expectedVersion: 1 });
  assert.equal(updated.version, 2);
  assert.equal(updated.steps[0].target.name, "Continue");
  assert.equal(store.get(workflow.id, { version: 1 }).steps[0].target.strategy, "visual_anchor");
});

test("cancellation propagates through TaskRuntime into the injected adapter", async () => {
  const workflow = await compileWorkflow({
    ...OWNER,
    name: "Cancel",
    events: [{ kind: "local", action: "read", target: { path: "/tmp/a" } }],
  });
  const controller = new AbortController();
  let observedAbort = false;
  const executor = new WorkflowExecutor({
    taskRuntime: new TaskRuntime(),
    adapters: {
      local: async (_task, context) => new Promise((resolve) => {
        context.signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve({ status: "cancelled", reason: "aborted" });
        }, { once: true });
      }),
    },
  });
  const pending = executor.execute(workflow, {}, { signal: controller.signal });
  controller.abort("user_cancelled");
  const outcome = await pending;
  assert.equal(observedAbort, true);
  assert.equal(outcome.task.status, "cancelled");
});
