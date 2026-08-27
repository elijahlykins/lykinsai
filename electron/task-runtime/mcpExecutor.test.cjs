"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TaskRuntime } = require("./taskRuntime.cjs");
const { McpExecutor } = require("./executors/mcpExecutor.cjs");
const { compileBotTask, compileRoutineTask } = require("./taskCompiler.cjs");

test("Bot connectionIds are copied onto the Task association and secrets are dropped", () => {
  const task = compileBotTask({
    objective: "Find Sarah's email",
    bot: { id: "bot-1", name: "Scout", connectionIds: ["conn_work", "Bearer supersecret-token-value"] },
    connectionIds: ["conn_work", "sk-this-is-not-allowed."],
    capabilities: ["reply", "communication.email.search"],
  });
  assert.deepEqual(task.association.connectionIds, ["conn_work"]);
  assert.ok(!JSON.stringify(task).includes("supersecret"));
});

test("Routine occurrence keeps connectionIds and never stores a token", () => {
  const task = compileRoutineTask({
    routine: {
      id: "routine-1",
      botId: "bot-1",
      bot: { id: "bot-1", name: "Scout" },
      name: "Morning mail",
      instructions: "Every morning check Work Gmail for messages from Sarah.",
      capabilities: ["reply", "communication.email.search"],
      connectionIds: ["conn_work"],
      approvalPolicy: "standing_authorization",
    },
  });
  assert.deepEqual(task.association.connectionIds, ["conn_work"]);
  assert.equal(task.association.routineId, "routine-1");
  assert.ok(!JSON.stringify(task).includes("token"));
});

test("McpExecutor honors cancellation and ignores a late result", async () => {
  const runtime = new TaskRuntime();
  const task = runtime.createBotTask({
    objective: "Read mail",
    capabilities: ["communication.email.read"],
    connectionIds: ["c1"],
  });
  let finished = false;
  const executor = new McpExecutor({
    callTool: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          finished = true;
          resolve({ kind: "external_untrusted_observation", data: { late: true } });
        }, 200);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { code: "aborted" }));
        });
      });
    },
    resolveTools: () => ({
      tools: [
        {
          connectionId: "c1",
          toolName: "search_messages",
          semanticCapabilities: ["communication.email.search"],
          consequenceHint: "READ",
        },
      ],
    }),
    execute: async ({ task: current, callTool }) => {
      try {
        const observation = await callTool({
          connectionId: "c1",
          toolName: "search_messages",
          args: {},
          signal: current.cancellation.signal,
        });
        if (current.cancellation.signal.aborted) {
          return { ok: false, status: "cancelled", ignored: true };
        }
        return { ok: true, observation };
      } catch (error) {
        if (error.code === "aborted") return { ok: false, status: "cancelled", ignored: true };
        throw error;
      }
    },
  });
  const running = runtime.execute(task.id, executor, {
    connectionId: "c1",
    toolName: "search_messages",
  });
  runtime.cancel(task.id, "user_stop");
  const result = await running;
  assert.equal(result.task.status, "cancelled");
  assert.equal(finished, false);
});
