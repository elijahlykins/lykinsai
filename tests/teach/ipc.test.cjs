"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerWorkflowsIpc } = require("../../electron/ipc/workflows.cjs");

test("workflow IPC exposes the explicit lifecycle and durable workflow operations", async () => {
  const handlers = new Map();
  const calls = [];
  const service = {
    start: (input) => ({ id: "teach_1", status: "active", ...input }),
    finish: async () => ({ id: "wf_1", botId: "bot_1" }),
    cancel: () => ({ status: "cancelled" }),
    status: () => ({ active: false, session: null }),
    record: (event) => ({ accepted: true, event }),
    listWorkflows: (botId) => [{ id: "wf_1", botId }],
    createWorkflow: (workflow) => workflow,
    updateWorkflow: (id, patch) => ({ id, ...patch }),
    removeWorkflow: () => true,
    run: (id, input) => ({ ok: true, taskId: `${id}:${input.parameters.query}` }),
    createRoutineReference: (id) => ({ ok: true, routineId: `routine:${id}` }),
    applyRecoveredUpdate: (id, updateId) => ({ id, updateId, version: 2 }),
  };
  registerWorkflowsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
        calls.push(channel);
      },
    },
    getTeachService: () => service,
  });
  assert.deepEqual(calls, [
    "lykn:teach-start",
    "lykn:teach-finish",
    "lykn:teach-cancel",
    "lykn:teach-status",
    "lykn:teach-record-event",
    "lykn:workflows-list",
    "lykn:workflow-create",
    "lykn:workflow-update",
    "lykn:workflow-delete",
    "lykn:workflow-run",
    "lykn:workflow-create-routine",
    "lykn:workflow-apply-recovered-update",
  ]);
  assert.equal((await handlers.get("lykn:teach-start")({}, { botId: "bot_1" })).session.botId, "bot_1");
  assert.equal((await handlers.get("lykn:teach-finish")({}, {})).workflow.id, "wf_1");
  assert.equal(
    (await handlers.get("lykn:workflow-run")({}, {
      workflowId: "wf_1",
      input: { parameters: { query: "bugs" } },
    })).taskId,
    "wf_1:bugs",
  );
});

test("workflow IPC converts validation failures into bounded error results", async () => {
  const handlers = new Map();
  registerWorkflowsIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getTeachService: () => ({
      start: () => {
        throw new TypeError("Teaching requires a botId");
      },
    }),
  });
  assert.deepEqual(await handlers.get("lykn:teach-start")({}, {}), {
    ok: false,
    error: "Teaching requires a botId",
  });
});
