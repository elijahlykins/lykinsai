"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { runLocalAgentTask } = require("../localAgentTask.cjs");
const { LocalExecutorAdapter } = require("./executors/localExecutorAdapter.cjs");

test("LocalExecutor passes the Task cancellation signal into its model fetch", async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const adapter = new LocalExecutorAdapter({
    runLocalTask: ({ instruction, signal }) =>
      runLocalAgentTask({
        goal: instruction,
        apiBase: "https://example.test",
        getAuthToken: async () => "token",
        signal,
        fetchImpl: async (_url, options) => {
          receivedSignal = options.signal;
          return {
            ok: true,
            json: async () => ({
              ok: true,
              json: { kind: "finish", answer: "Checked." },
            }),
          };
        },
      }),
  });

  const out = await adapter.execute({ instruction: "check this file", signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
  assert.equal(out.ok, true);
  assert.equal(out.output, "Checked.");
});
