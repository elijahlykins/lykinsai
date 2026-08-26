"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTeachService } = require("../../electron/teach/index.cjs");

function serviceFixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "teach-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const emitted = [];
  const service = createTeachService({
    userDataPath: directory,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    ...overrides,
  });
  return { directory, emitted, service };
}

test("finish returns a Bot-owned review draft and persists nothing until explicit save", async (t) => {
  const { directory, service } = serviceFixture(t);
  service.start({ botId: "bot_1", name: "Demo", objective: "File an issue" });
  service.record({
    kind: "mcp",
    action: "create_issue",
    target: { connectionId: "github_1", toolName: "issues.create" },
    input: { title: "{{title}}", access_token: "must-not-survive" },
  });
  const draft = await service.finish();
  assert.equal(draft.botId, "bot_1");
  assert.equal(draft.parameters[0].name, "title");
  assert.equal(service.listWorkflows("bot_1").length, 0);
  assert.equal(fs.existsSync(path.join(directory, "teach-workflows.json")), false);
  assert.equal(JSON.stringify(draft).includes("must-not-survive"), false);

  const saved = service.createWorkflow(draft);
  assert.equal(saved.id, draft.id);
  assert.equal(service.listWorkflows("bot_1").length, 1);
  assert.equal(service.listWorkflows("bot_2").length, 0);
  assert.equal(fs.readFileSync(path.join(directory, "teach-workflows.json"), "utf8").includes("access_token"), false);
});

test("autonomous task observation requires the explicitly selected source Task", (t) => {
  const { service } = serviceFixture(t);
  service.start({ botId: "bot_1", sourceTaskId: "task_source" });
  assert.equal(service.recordTaskEvent({
    taskId: "other",
    type: "progress",
    association: { botId: "bot_2" },
    detail: { event: "local.read", tool: "read_file", args: { path: "/tmp/no" } },
  }).accepted, false);
  assert.equal(service.recordTaskEvent({
    taskId: "same_bot_but_not_source",
    type: "progress",
    association: { botId: "bot_1" },
    detail: { event: "local.read", tool: "read_file", args: { path: "/tmp/no" } },
  }).accepted, false);
  assert.equal(service.recordTaskEvent({
    taskId: "task_source",
    type: "progress",
    association: { botId: "bot_2" },
    detail: { event: "local.read", tool: "read_file", args: { path: "/tmp/yes" } },
  }).accepted, true);
  assert.equal(service.status().session.eventCount, 1);
});

test("explicit source Task capture normalizes local, MCP, remote, and handoff boundaries", async (t) => {
  const { service } = serviceFixture(t);
  service.start({ botId: "bot_1", sourceTaskId: "task_source" });
  const base = { taskId: "task_source", association: { botId: "bot_1" }, type: "progress" };
  service.recordTaskEvent({
    ...base,
    detail: { event: "local.read", tool: "read_file", args: { path: "/tmp/report" } },
  });
  service.recordTaskEvent({
    ...base,
    detail: {
      event: "mcp.called",
      connectionId: "github",
      toolName: "issues.search",
      args: { query: "bugs", authorization: "Bearer must-not-survive" },
      status: "completed",
    },
  });
  service.recordTaskEvent({
    ...base,
    association: { botId: "bot_1", remoteTargetId: "staging" },
    detail: { event: "remote.command_started", tool: "read", args: { path: "/var/log/app" } },
  });
  service.recordTaskEvent({
    ...base,
    type: "waiting_for_user",
    detail: {},
  });
  service.recordTaskEvent({
    ...base,
    type: "task_completed",
    detail: {},
  });
  const workflow = await service.finish();
  assert.deepEqual(workflow.steps.map((step) => step.kind), ["local", "mcp", "remote", "task"]);
  assert.equal(workflow.steps[1].target.connectionId, "github");
  assert.equal(workflow.steps[2].target.remoteTargetId, "staging");
  assert.equal(workflow.steps[3].human_takeover, true);
  assert.equal(JSON.stringify(workflow).includes("must-not-survive"), false);
});

test("run delegates a saved definition and returns its canonical Task id immediately", async (t) => {
  let observed;
  const { service } = serviceFixture(t, {
    runWorkflow: ({ workflow, parameterValues, onTaskCreated }) => {
      observed = { workflow, parameterValues };
      onTaskCreated("task_workflow_1");
      return Promise.resolve({ result: { status: "completed" } });
    },
  });
  service.start({ botId: "bot_1", name: "Run me" });
  service.record({ kind: "local", action: "read", target: { path: "/tmp/{{file}}" } });
  const draft = await service.finish();
  service.createWorkflow(draft);
  const result = service.run(draft.id, {
    botId: "bot_1",
    parameters: { file: "report.txt" },
  });
  assert.deepEqual(result, { ok: true, taskId: "task_workflow_1", runId: "task_workflow_1" });
  assert.equal(observed.workflow.id, draft.id);
  assert.deepEqual(observed.parameterValues, { file: "report.txt" });
  assert.equal(service.run(draft.id, { botId: "bot_2" }).error, "workflow_bot_mismatch");
});

test("Routine creation stores a workflow reference without duplicating steps", async (t) => {
  let routineInput;
  const { service } = serviceFixture(t, {
    createRoutine: (input) => {
      routineInput = input;
      return { id: "routine_1", ...input };
    },
  });
  service.start({ botId: "bot_1", name: "Repeat" });
  service.record({
    kind: "mcp",
    action: "list",
    target: { connectionId: "github_1", toolName: "issues.list" },
  });
  const draft = await service.finish();
  service.createWorkflow(draft);
  const result = service.createRoutineReference(draft.id, {});
  assert.equal(result.routineId, "routine_1");
  assert.equal(routineInput.workflowId, draft.id);
  assert.equal(routineInput.workflowVersion, 1);
  assert.equal("steps" in routineInput, false);
  assert.deepEqual(routineInput.connectionIds, ["github_1"]);
  service.createRoutineReference(draft.id, { instruction: "Every Monday at 8" });
  assert.deepEqual(routineInput.trigger, {
    type: "schedule",
    schedule: { kind: "weekly", time: "8:00", days: [1] },
  });
});

test("recovered targets require explicit apply and create a new version", async (t) => {
  const { service } = serviceFixture(t);
  service.start({ botId: "bot_1", name: "Recover" });
  service.record({
    kind: "browser",
    action: "click",
    target: { role: "button", name: "Save" },
  });
  const draft = await service.finish();
  service.createWorkflow(draft);
  const proposal = service.proposeRecoveredUpdate(draft.id, [{
    stepId: "step_1",
    target: { strategy: "semantic", confidence: "high", role: "button", name: "Save changes" },
  }]);
  assert.equal(service.getWorkflow(draft.id).version, 1);
  assert.equal(service.listWorkflows("bot_1")[0].recoveredUpdate.id, proposal.id);
  const updated = service.applyRecoveredUpdate(draft.id, proposal.id);
  assert.equal(updated.version, 2);
  assert.equal(updated.steps[0].target.name, "Save changes");
  assert.equal(service.listWorkflows("bot_1")[0].recoveredUpdate, undefined);
});

test("workflow edits rebuild parameter paths and reject stale concurrent saves", async (t) => {
  const { service } = serviceFixture(t);
  service.start({ botId: "bot_1", name: "Edit" });
  service.record({
    kind: "browser",
    action: "fill",
    target: { role: "textbox", name: "Query" },
    input: { value: "{{query}}" },
  });
  service.record({
    kind: "mcp",
    action: "search",
    target: { connectionId: "github", toolName: "search" },
    input: { query: "{{query}}" },
  });
  const draft = await service.finish();
  service.createWorkflow(draft);
  const reordered = service.updateWorkflow(draft.id, {
    steps: [draft.steps[1], draft.steps[0]],
    parameters: draft.parameters.map((parameter) => ({ ...parameter, paths: ["stale"] })),
    expectedVersion: 1,
  });
  assert.deepEqual(reordered.parameters[0].paths, ["[0].input.query", "[1].input.value"]);
  assert.throws(
    () => service.updateWorkflow(draft.id, { name: "stale", expectedVersion: 1 }),
    /version_conflict/,
  );
});
