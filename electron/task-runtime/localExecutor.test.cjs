"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TaskRuntime } = require("./taskRuntime.cjs");
const { TASK_STATUSES } = require("./task.cjs");
const { BotExecutor } = require("./executors/botExecutor.cjs");
const { LocalExecutor, toHarnessResult, LOCAL_SAFETY_CEILING } = require("./executors/localExecutor.cjs");
const {
  allowedToolNames,
  commandPermitted,
  compileLocalCapabilities,
} = require("./executors/localCapabilities.cjs");
const { compileLocalTask } = require("./taskCompiler.cjs");
const { runLocalAgentTask, tryDeterministicLocalAction } = require("../localAgentTask.cjs");
const localSystem = require("../localSystem.cjs");

let taskCounter = 0;
function localTask(runtime, overrides = {}) {
  taskCounter += 1;
  return runtime.register({
    id: `task_local_${taskCounter}`,
    objective: "read the notes in the approved folder",
    capabilities: ["files.read"],
    budgets: { maxRounds: 12 },
    ...overrides,
  });
}

test("read-only compilation does not grant write, delete, or shell", () => {
  const caps = compileLocalCapabilities(
    "Read the latest PDF in my approved Documents folder and summarize it.",
  );
  assert.deepEqual(caps, ["files.read"]);
  const tools = allowedToolNames(caps);
  assert.ok(tools.has("local_read_file"));
  assert.equal(tools.has("local_write_file"), false);
  assert.equal(tools.has("local_run_command"), false);
});

test("a move ask licenses move, not delete or general shell", () => {
  const caps = compileLocalCapabilities("Move these files into the project folder.");
  assert.ok(caps.includes("files.read"));
  assert.ok(caps.includes("files.move"));
  assert.equal(caps.includes("files.delete"), false);
  assert.equal(caps.includes("local.shell.execute"), false);
  assert.equal(commandPermitted("mv a.txt project/", caps, { risky: true }), true);
  assert.equal(commandPermitted("rm a.txt", caps, { risky: true }), false);
  assert.equal(commandPermitted("npm install", caps, { risky: true }), false);
});

test("a delete ask licenses delete commands only", () => {
  const caps = compileLocalCapabilities("Delete this file from the folder.");
  assert.ok(caps.includes("files.delete"));
  assert.equal(commandPermitted("rm notes.txt", caps, { risky: true }), true);
  assert.equal(commandPermitted("mv notes.txt /tmp/", caps, { risky: true }), false);
});

test("a task without a local capability never reaches local tools", async () => {
  const runtime = new TaskRuntime();
  const task = localTask(runtime, { capabilities: ["reply"] });
  let ran = false;
  const executor = new LocalExecutor({
    runLocalTask: async () => {
      ran = true;
      return { ok: true, status: "completed", answer: "should not happen" };
    },
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(ran, false);
  assert.equal(out.task.status, TASK_STATUSES.FAILED);
  assert.equal(out.task.completion.reason, "local_capability_missing");
});

test("normal Agent local work keeps the same Task identity through completion", async () => {
  const runtime = new TaskRuntime();
  const task = runtime.register(
    compileLocalTask({
      objective: "read ~/Documents/report.pdf",
      agentId: "agent-1",
      capabilities: ["files.read"],
    }),
  );
  const executor = new LocalExecutor({
    runLocalTask: async ({ task: canonical, allowedTools }) => {
      assert.equal(canonical.id, task.id);
      assert.ok(allowedTools.has("local_read_file"));
      assert.equal(allowedTools.has("local_write_file"), false);
      return { ok: true, status: "completed", answer: "Report covers Q3 pipeline." };
    },
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(out.task.id, task.id);
  assert.equal(out.task.status, TASK_STATUSES.COMPLETED);
  assert.equal(out.task.completion.output, "Report covers Q3 pipeline.");
});

test("Bot local work uses LocalExecutor on the SAME Task", async () => {
  const runtime = new TaskRuntime();
  const task = runtime.createBotTask({
    objective: "Look through the files in this folder and tell me which proposal is newest.",
    botTaskId: "ui-local-1",
    bot: { id: "bot-1", name: "Scout" },
    capabilities: ["reply", "local_computer"],
  });
  const seen = { localTaskId: null, child: 0 };
  const local = new LocalExecutor({
    runLocalTask: async ({ task: canonical }) => {
      seen.localTaskId = canonical.id;
      return { ok: true, status: "completed", answer: "proposal-v3.pdf is newest." };
    },
  });
  const bot = new BotExecutor({
    runBotTask: async ({ task: canonical, executors }) => {
      seen.child += 1;
      const child = await executors.local_computer({
        instruction: "list the folder and pick the newest proposal",
      });
      assert.equal(canonical.id, task.id);
      return {
        ok: true,
        status: "completed",
        answer: child.output,
      };
    },
  });
  const out = await runtime.execute(task.id, bot, {
    executorName: "bot",
    executors: {
      local_computer: async (args) =>
        toHarnessResult(await local.execute(args.task || task, args)),
    },
  });
  assert.equal(out.task.id, task.id);
  assert.equal(out.task.status, TASK_STATUSES.COMPLETED);
  assert.equal(seen.localTaskId, task.id);
  assert.equal(seen.child, 1);
  assert.match(out.result.output, /proposal-v3/);
});

test("a read-only task cannot write even if the model asks", async () => {
  const calls = [];
  const out = await runLocalAgentTask({
    goal: "read notes.txt",
    apiBase: "https://example.test",
    getAuthToken: async () => "token",
    capabilities: ["files.read"],
    allowedTools: allowedToolNames(["files.read"]),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        json: {
          kind: "act",
          tool: "local_write_file",
          args: { path: "notes.txt", content: "hacked" },
        },
      }),
    }),
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true };
    },
    maxRounds: 2,
  });
  assert.equal(calls.length, 0);
  assert.match(out.history[0].summary, /not permitted/);
});

test("a write task cannot delete unless granted", async () => {
  const calls = [];
  await runLocalAgentTask({
    goal: "write notes.txt",
    apiBase: "https://example.test",
    getAuthToken: async () => "token",
    capabilities: ["files.read", "files.write"],
    allowedTools: allowedToolNames(["files.read", "files.write"]),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        json: { kind: "act", tool: "local_run_command", args: { command: "rm notes.txt" } },
      }),
    }),
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true };
    },
    maxRounds: 2,
  });
  assert.equal(calls.length, 0);
});

test("no shell capability means no shell execution", async () => {
  const calls = [];
  await runLocalAgentTask({
    goal: "read the folder",
    apiBase: "https://example.test",
    getAuthToken: async () => "token",
    capabilities: ["files.read"],
    allowedTools: allowedToolNames(["files.read"]),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        json: { kind: "act", tool: "local_run_command", args: { command: "ls" } },
      }),
    }),
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, output: "should not run" };
    },
    maxRounds: 2,
  });
  assert.equal(calls.length, 0);
});

test("a risky action pauses; decline does not retry endlessly", async () => {
  const runtime = new TaskRuntime();
  const task = localTask(runtime, {
    capabilities: ["files.read", "files.write"],
    objective: "write hello.txt",
  });
  let approvals = 0;
  const executor = new LocalExecutor({
    runLocalTask: async ({ context }) => {
      context.approvalRequired?.({ tool: "local_write_file", question: "Approve write?" });
      approvals += 1;
      return {
        ok: true,
        status: "waiting_for_user",
        needsApproval: true,
        answer: "I've prepared the next step but need your approval first: write hello.txt.",
      };
    },
  });
  const first = await runtime.execute(task.id, executor);
  assert.equal(first.task.status, TASK_STATUSES.WAITING_FOR_USER);
  assert.match(first.result.question, /approval/i);
  const declined = await runtime.execute(task.id, async () => ({
    ok: true,
    status: "waiting_for_user",
    needsApproval: true,
    answer: "Write was declined.",
  }));
  assert.equal(declined.task.id, task.id);
  assert.equal(declined.task.status, TASK_STATUSES.WAITING_FOR_USER);
  assert.equal(approvals, 1);
});

test("approval can resume the SAME Task", async () => {
  const runtime = new TaskRuntime();
  const task = localTask(runtime, {
    capabilities: ["files.read", "files.write"],
    objective: "write hello.txt",
  });
  const first = await runtime.execute(
    task.id,
    new LocalExecutor({
      runLocalTask: async () => ({
        ok: true,
        status: "waiting_for_approval",
        answer: "Approve write hello.txt?",
      }),
    }),
  );
  assert.equal(first.task.status, TASK_STATUSES.WAITING_FOR_APPROVAL);
  runtime.resolveApproval(task.id, true);
  const second = await runtime.execute(
    task.id,
    new LocalExecutor({
      runLocalTask: async ({ task: canonical }) => {
        assert.equal(canonical.id, task.id);
        return { ok: true, status: "completed", answer: "Wrote hello.txt." };
      },
    }),
  );
  assert.equal(second.task.id, task.id);
  assert.equal(second.task.status, TASK_STATUSES.COMPLETED);
});

test("LocalExecutor passes the Task cancellation signal into its model fetch", async () => {
  const runtime = new TaskRuntime();
  const task = localTask(runtime, { capabilities: ["files.read"] });
  let receivedSignal = null;
  const executor = new LocalExecutor({
    runLocalTask: ({ instruction, context }) =>
      runLocalAgentTask({
        goal: instruction,
        apiBase: "https://example.test",
        getAuthToken: async () => "token",
        signal: context.signal,
        capabilities: ["files.read"],
        fetchImpl: async (_url, options) => {
          receivedSignal = options.signal;
          return {
            ok: true,
            json: async () => ({
              ok: true,
              json: { kind: "finish", answer: "Checked." },
              usage: { inputTokens: 11, outputTokens: 4 },
              model: "gpt-test",
              provider: "openai",
              upstreamMs: 12,
            }),
          };
        },
      }),
  });
  const out = await runtime.execute(task.id, executor);
  assert.equal(receivedSignal, runtime.get(task.id).cancellation.signal || receivedSignal);
  assert.ok(receivedSignal);
  assert.equal(out.task.status, TASK_STATUSES.COMPLETED);
  assert.equal(out.result.usage.calls, 1);
  assert.equal(out.result.usage.inputTokens, 11);
});

test("runtime cancellation reaches the local run and cannot complete later", async () => {
  const { runtime, events } = (() => {
    const events = [];
    return { events, runtime: new TaskRuntime({ onEvent: (event) => events.push(event) }) };
  })();
  const task = localTask(runtime, { capabilities: ["files.read"] });
  let release;
  const run = runtime.execute(
    task.id,
    new LocalExecutor({
      runLocalTask: async ({ context }) =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, status: "completed", answer: "late success" });
          context.signal.addEventListener("abort", () =>
            resolve({ ok: false, status: "cancelled", answer: "Task cancelled." }),
          );
        }),
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  runtime.cancel(task.id, "user_stop");
  release?.();
  const result = await run;
  assert.ok(result.stale || result.task.status === TASK_STATUSES.CANCELLED);
  assert.equal(runtime.get(task.id).status, TASK_STATUSES.CANCELLED);
  assert.equal(events.filter((event) => event.type === "task_cancelled").length, 1);
  assert.equal(events.some((event) => event.type === "task_completed"), false);
});

test("a local question pauses the Task and is not treated as success", async () => {
  const runtime = new TaskRuntime();
  const task = localTask(runtime, { capabilities: ["files.read"] });
  const first = await runtime.execute(
    task.id,
    new LocalExecutor({
      runLocalTask: async () => ({
        ok: true,
        status: "waiting_for_user",
        answer: "Which folder should I look in?",
      }),
    }),
  );
  assert.equal(first.task.status, TASK_STATUSES.WAITING_FOR_USER);
  assert.equal(first.result.question, "Which folder should I look in?");
  const harness = toHarnessResult(first.result);
  assert.equal(harness.terminal, "waiting_for_user");
  assert.notEqual(harness.summary, first.result.question);
  const second = await runtime.execute(
    task.id,
    new LocalExecutor({
      runLocalTask: async ({ task: canonical }) => {
        assert.equal(canonical.id, task.id);
        return { ok: true, status: "completed", answer: "Looked in Documents." };
      },
    }),
  );
  assert.equal(second.task.id, task.id);
  assert.equal(second.task.status, TASK_STATUSES.COMPLETED);
});

test("local child cannot silently exceed the parent round budget", async () => {
  const runtime = new TaskRuntime();
  const task = localTask(runtime, {
    capabilities: ["files.read"],
    budgets: { maxRounds: 3 },
  });
  let seenRounds = null;
  await runtime.execute(
    task.id,
    new LocalExecutor({
      runLocalTask: async ({ maxRounds }) => {
        seenRounds = maxRounds;
        return { ok: false, status: "failed", reason: "round_budget_exhausted", answer: "stopped" };
      },
    }),
  );
  assert.equal(seenRounds, 3);
  assert.ok(seenRounds <= LOCAL_SAFETY_CEILING);
  assert.equal(runtime.get(task.id).status, TASK_STATUSES.FAILED);
  assert.equal(runtime.get(task.id).completion.reason, "round_budget_exhausted");
});

test("local events carry task and run identity and complete once", async () => {
  const events = [];
  const runtime = new TaskRuntime({ onEvent: (event) => events.push(event) });
  const task = localTask(runtime, { capabilities: ["files.read"] });
  await runtime.execute(
    task.id,
    new LocalExecutor({
      runLocalTask: async ({ context }) => {
        context.progress?.({ event: "local.file_read", path: "~/Documents/a.pdf" });
        return { ok: true, status: "completed", answer: "Done." };
      },
    }),
  );
  const progress = events.filter((event) => event.type === "progress");
  assert.ok(progress.some((event) => event.detail.event === "local.started"));
  assert.ok(progress.some((event) => event.detail.event === "local.file_read"));
  assert.ok(progress.some((event) => event.detail.event === "local.completed"));
  for (const event of events) {
    assert.equal(event.taskId, task.id);
    assert.equal(event.runId, task.runId);
  }
  assert.equal(events.filter((event) => event.type === "task_completed").length, 1);
});

test("an explicit file read skips the planner loop", async () => {
  const action = tryDeterministicLocalAction("read ~/Documents/report.pdf", new Set(["local_read_file"]));
  assert.deepEqual(action, { tool: "local_read_file", args: { path: "~/Documents/report.pdf" } });
  const calls = [];
  let modelCalls = 0;
  const out = await runLocalAgentTask({
    goal: "read ~/Documents/report.pdf",
    apiBase: "https://example.test",
    getAuthToken: async () => "token",
    capabilities: ["files.read"],
    allowedTools: allowedToolNames(["files.read"]),
    fetchImpl: async () => {
      modelCalls += 1;
      throw new Error("model should not run");
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, content: "Q3 pipeline notes" };
    },
    onApprovalNeeded: async () => true,
  });
  assert.equal(modelCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "local_read_file");
  assert.equal(out.status, "completed");
  assert.match(out.answer, /Q3 pipeline/);
});

test("approved-root reads work and traversal outside the root is rejected", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-local-exec-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-local-root-"));
  const file = path.join(root, "notes.txt");
  fs.writeFileSync(file, "hello from root\n");
  const outside = path.join(path.dirname(root), "secret.txt");
  fs.writeFileSync(outside, "nope\n");
  fs.writeFileSync(
    path.join(userData, "local-mode.json"),
    JSON.stringify({ enabled: true, syncAll: false, syncedFolders: [root], excludedFolders: [] }),
  );

  const allowed = await localSystem.run(
    "local_read_file",
    { path: file },
    { userDataPath: userData },
  );
  assert.equal(allowed.ok, true);
  assert.match(String(allowed.content || ""), /hello from root/);

  const traversal = await localSystem.run(
    "local_read_file",
    { path: path.join(root, "..", "secret.txt") },
    { userDataPath: userData },
  );
  assert.equal(traversal.ok, false);
  assert.match(String(traversal.error || ""), /not synced/i);

  const escaped = await localSystem.run(
    "local_read_file",
    { path: outside },
    { userDataPath: userData },
  );
  assert.equal(escaped.ok, false);
});

test("a write is not auto-approved", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-local-write-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-local-wroot-"));
  fs.writeFileSync(
    path.join(userData, "local-mode.json"),
    JSON.stringify({ enabled: true, syncAll: false, syncedFolders: [root], excludedFolders: [] }),
  );
  const pending = await localSystem.run(
    "local_write_file",
    { path: path.join(root, "new.txt"), content: "x" },
    { userDataPath: userData },
  );
  assert.equal(pending.needsApproval, true);
  const done = await localSystem.run(
    "local_write_file",
    { path: path.join(root, "new.txt"), content: "x" },
    { userDataPath: userData, approved: true },
  );
  assert.equal(done.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "x");
});
