"use strict";

/**
 * C1 authority characterization: production Task creation and host files
 * must not keep a second execution architecture beside TaskRuntime.
 *
 * Run: node --test electron/task-runtime/authority.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { TaskRuntime } = require("./taskRuntime.cjs");
const { TASK_STATUSES } = require("./task.cjs");
const {
  compileBrowserTask,
  compileBrowserCapabilities,
  defaultBotCapabilities,
  DEFAULT_BROWSER_CAPABILITIES,
} = require("./taskCompiler.cjs");
const { BrowserExecutor } = require("./executors/browserExecutor.cjs");
const { BotExecutor } = require("./executors/botExecutor.cjs");

const AGENT_RUNTIME = fs.readFileSync(
  path.join(__dirname, "../agentRuntime.cjs"),
  "utf8",
);
const OWNED_BROWSER = fs.readFileSync(
  path.join(__dirname, "../ownedBrowserAct.cjs"),
  "utf8",
);
const MAIN = fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8");
const AGENT_BROWSER_HOST = fs.readFileSync(
  path.join(__dirname, "../agent-browser/host.cjs"),
  "utf8",
);

test("compileBrowserTask is the canonical browse envelope and never grants eval", () => {
  const task = compileBrowserTask({
    objective: "open gmail and read the latest message",
    agentId: "agent-1",
    budgets: { maxRounds: 18 },
  });
  assert.equal(task.origin.type, "agent");
  assert.equal(task.association.agentId, "agent-1");
  assert.deepEqual(task.capabilities, DEFAULT_BROWSER_CAPABILITIES);
  assert.equal(task.capabilities.includes("browser.eval"), false);
  assert.deepEqual(
    compileBrowserCapabilities("anything", { explicit: ["browser.read"] }),
    ["browser.read"],
  );
});

test("production browser execution goes through TaskRuntime then BrowserExecutor", async () => {
  const runtime = new TaskRuntime();
  const compiled = compileBrowserTask({
    objective: "open the pricing page",
    agentId: "agent-1",
  });
  const task = runtime.register(compiled);
  let ran = false;
  const executor = new BrowserExecutor({
    runBrowserTask: async ({ task: canonical, allowedActions }) => {
      ran = true;
      assert.equal(canonical.id, task.id);
      assert.ok(allowedActions.has("navigate"));
      return { ok: true, status: "completed", answer: "Three plans." };
    },
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(ran, true);
  assert.equal(out.task.status, TASK_STATUSES.COMPLETED);
  assert.equal(out.result.executor, "browser");
});

test("production Bot execution goes through TaskRuntime then BotExecutor", async () => {
  const runtime = new TaskRuntime();
  const task = runtime.createBotTask({
    objective: "hey",
    capabilities: defaultBotCapabilities(),
    bot: { id: "bot-1", name: "Scout" },
  });
  const executor = new BotExecutor({
    runBotTask: async () => {
      throw new Error("harness should not run for reply-only");
    },
  });
  const out = await runtime.execute(task.id, executor, {
    executorName: "bot",
    primaryTool: "reply",
    executors: {
      reply: async () => ({ ok: true, output: "Hey from Scout." }),
    },
  });
  assert.equal(out.task.status, TASK_STATUSES.COMPLETED);
  assert.equal(out.result.executor, "reply");
});

test("agentRuntime no longer hosts a second Task settlement architecture", () => {
  assert.doesNotMatch(AGENT_RUNTIME, /browser_legacy_fallback/);
  assert.doesNotMatch(AGENT_RUNTIME, /LYKN_BROWSER_AGENT/);
  assert.doesNotMatch(AGENT_RUNTIME, /LYKN_BOT_HARNESS/);
  assert.doesNotMatch(AGENT_RUNTIME, /botHarnessEnabled/);
  assert.doesNotMatch(AGENT_RUNTIME, /executeOwnedAdaptiveTask/);
  assert.doesNotMatch(
    AGENT_RUNTIME,
    /taskRuntime\.complete\(/,
    "host must not independently complete a Task",
  );
});

test("ensureBrowserTask compiles through TaskCompiler rather than an ad-hoc envelope", () => {
  assert.match(AGENT_RUNTIME, /compileBrowserTask\(/);
  assert.doesNotMatch(
    AGENT_RUNTIME,
    /capabilities:\s*\[\s*"browser\.read"/,
    "ad-hoc browser capability lists must not be authored in the host",
  );
});

test("the owned adaptive decision loop is gone; the actuator remains", () => {
  assert.doesNotMatch(OWNED_BROWSER, /async function executeOwnedAdaptiveTask/);
  assert.doesNotMatch(OWNED_BROWSER, /function formatStuckNeedsHelp/);
  assert.match(OWNED_BROWSER, /async function runAction\(/);
  assert.match(OWNED_BROWSER, /async function getDOMCatalog\(/);
});

test("main.cjs no longer hosts the legacy browse planner", () => {
  assert.doesNotMatch(MAIN, /planOwnedBrowserNext/);
  assert.doesNotMatch(MAIN, /executeOwnedAdaptiveTask/);
  assert.doesNotMatch(AGENT_BROWSER_HOST, /planOwnedBrowserNext/);
  assert.doesNotMatch(AGENT_BROWSER_HOST, /executeOwnedAdaptiveTask/);
});
