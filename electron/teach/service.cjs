"use strict";

const crypto = require("node:crypto");
const { TeachSession } = require("./session.cjs");
const { compileWorkflow } = require("./compiler.cjs");
const { createWorkflowStore } = require("./store.cjs");
const { validateWorkflowDefinition, collectParameters } = require("./workflow.cjs");
const { validateParameters } = require("./executor.cjs");
const { attachBrowserTeachingCapture } = require("./browserCapture.cjs");
const { resolveRoutineSpec } = require("../bot-routines/nlRoutine.cjs");

function taskEventToTeachEvent(event) {
  const detail = event?.detail && typeof event.detail === "object" ? event.detail : {};
  const marker = String(detail.event || detail.type || "");
  if (marker.startsWith("local.")) {
    return {
      kind: "local",
      action: String(detail.tool || marker.slice(6) || "action"),
      target: { path: detail.args?.path || detail.path, app: detail.args?.app || detail.app },
      input: detail.args || null,
      metadata: { actor: "demonstration_task" },
      approvalRequired: marker.includes("approval_required"),
    };
  }
  if (marker.startsWith("remote.")) {
    return {
      kind: "remote",
      action: String(detail.tool || marker.slice(7) || "action"),
      target: { remoteTargetId: event?.association?.remoteTargetId },
      input: detail.args || null,
      metadata: { actor: "demonstration_task" },
      approvalRequired: marker.includes("approval_required"),
    };
  }
  if (marker.startsWith("mcp.")) {
    return {
      kind: "mcp",
      action: String(detail.semanticCapability || detail.toolName || marker.slice(4) || "call"),
      target: { connectionId: detail.connectionId, toolName: detail.toolName },
      input: detail.arguments || detail.args || null,
      metadata: {
        actor: "demonstration_task",
        status: detail.status || null,
        consequence: detail.consequence || null,
        latencyMs: detail.latencyMs ?? null,
      },
      approvalRequired:
        detail.approvalDecision === "required" || detail.reason === "approval_required",
    };
  }
  if (event?.type === "approval_required") {
    return {
      kind: "task",
      action: "approval_boundary",
      target: { taskId: event.taskId },
      metadata: { actor: "demonstration_task" },
      approvalRequired: true,
    };
  }
  if (event?.type === "waiting_for_user") {
    return {
      kind: "task",
      action: "human_handoff",
      target: { taskId: event.taskId },
      metadata: { actor: "demonstration_task" },
      human_takeover: true,
    };
  }
  if (event?.type === "task_completed") {
    return {
      kind: "task",
      action: "completion",
      target: { taskId: event.taskId },
      metadata: { actor: "demonstration_task" },
    };
  }
  if (event?.type === "task_failed" || event?.type === "task_cancelled") {
    return {
      kind: "task",
      action: event.type === "task_failed" ? "error" : "cancel",
      target: { taskId: event.taskId },
      metadata: {
        actor: "demonstration_task",
        reason: String(detail.reason || "").slice(0, 300),
      },
    };
  }
  return null;
}

function createTeachService({
  userDataPath,
  emit = () => {},
  getBrowserWebContents = () => null,
  runWorkflow = null,
  createRoutine = null,
  compileAssistant = null,
  now = () => new Date().toISOString(),
} = {}) {
  const session = new TeachSession({ now });
  const store = createWorkflowStore({ userDataPath, maxPreviousVersions: 20 });
  const drafts = new Map();
  const recoveredUpdates = new Map();
  let detachBrowser = null;
  store.load();

  const publishTeaching = () =>
    emit("lykn:teaching-changed", { active: session.active, session: session.snapshot() });
  const publishWorkflows = () =>
    emit("lykn:workflows-changed", { workflows: listWorkflows() });

  function stopBrowserCapture() {
    try {
      detachBrowser?.();
    } finally {
      detachBrowser = null;
    }
  }

  function start(input = {}) {
    const botId = String(input.botId || "").trim();
    if (!botId) throw new TypeError("Teaching requires a botId");
    const snapshot = session.start({ ...input, botId });
    const wc = getBrowserWebContents(input) || null;
    if (wc) {
      detachBrowser = attachBrowserTeachingCapture({
        webContents: wc,
        onEvent: (event) => {
          const result = session.record(event);
          if (result.accepted) publishTeaching();
        },
      });
    }
    publishTeaching();
    return snapshot;
  }

  function record(event) {
    const result = session.record(event);
    if (result.accepted) publishTeaching();
    return result;
  }

  function recordTaskEvent(event) {
    if (!session.active) return { accepted: false, reason: "no_active_teach_session" };
    const current = session.snapshot();
    const sameSource =
      current?.sourceTaskId && current.sourceTaskId === String(event?.taskId || "");
    if (!sameSource) return { accepted: false, reason: "outside_teach_scope" };
    const normalized = taskEventToTeachEvent(event);
    return normalized ? record(normalized) : { accepted: false, reason: "irrelevant_task_event" };
  }

  async function finish(input = {}) {
    stopBrowserCapture();
    const capture = session.finish();
    publishTeaching();
    const workflow = await compileWorkflow(
      {
        botId: capture.botId,
        name: input.name || capture.name,
        objective: capture.objective,
        events: capture.events,
      },
      { compileAssistant, now },
    );
    drafts.set(workflow.id, workflow);
    return workflow;
  }

  function cancel(reason) {
    stopBrowserCapture();
    const result = session.cancel(reason);
    publishTeaching();
    return result;
  }

  function createWorkflow(definition) {
    const validated = validateWorkflowDefinition(rebuildParameterPaths(definition));
    const saved = store.put(validated);
    drafts.delete(saved.id);
    publishWorkflows();
    return saved;
  }

  function updateWorkflow(id, patch = {}) {
    const current = store.get(id);
    if (!current) throw new Error("workflow_not_found");
    const allowed = {};
    for (const key of ["name", "objective", "parameters", "steps"]) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    const updated = store.update(
      id,
      rebuildParameterPaths({ ...current, ...allowed }),
      { expectedVersion: patch.expectedVersion },
    );
    publishWorkflows();
    return updated;
  }

  function removeWorkflow(id) {
    const removed = store.remove(id);
    recoveredUpdates.delete(String(id || ""));
    if (removed) publishWorkflows();
    return removed;
  }

  function listWorkflows(botId) {
    const id = String(botId || "").trim();
    return store.list()
      .filter((workflow) => !id || workflow.botId === id)
      .map((workflow) => {
        const proposal = [...recoveredUpdates.values()]
          .reverse()
          .find((item) => item.workflowId === workflow.id);
        return proposal
          ? {
              ...workflow,
              recoveredUpdate: {
                id: proposal.id,
                summary: `Update ${proposal.steps.length} recovered target${proposal.steps.length === 1 ? "" : "s"}.`,
                createdAt: proposal.createdAt,
              },
            }
          : workflow;
      });
  }

  function run(id, input = {}) {
    const workflow = store.get(id);
    if (!workflow) return { ok: false, error: "workflow_not_found" };
    if (input.botId && String(input.botId) !== workflow.botId) {
      return { ok: false, error: "workflow_bot_mismatch" };
    }
    if (typeof runWorkflow !== "function") return { ok: false, error: "workflow_executor_unavailable" };
    try {
      validateParameters(workflow, input.parameters || {});
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
    let taskId = "";
    const pending = Promise.resolve(
      runWorkflow({
        workflow,
        parameterValues: input.parameters || {},
        bot: input.bot || null,
        onTaskCreated: (idValue) => {
          taskId = String(idValue || "");
        },
      }),
    );
    void pending
      .then((outcome) => {
        const proposed = outcome?.result?.proposedUpdates || outcome?.proposedUpdates;
        if (Array.isArray(proposed) && proposed.length) proposeRecoveredUpdate(workflow.id, proposed);
      })
      .catch(() => {});
    return taskId
      ? { ok: true, taskId, runId: taskId }
      : { ok: false, error: "workflow_execution_did_not_create_task" };
  }

  function createRoutineReference(id, input = {}) {
    const workflow = store.get(id);
    if (!workflow) return { ok: false, error: "workflow_not_found" };
    if (typeof createRoutine !== "function") return { ok: false, error: "routine_runtime_unavailable" };
    const botId = String(input.botId || workflow.botId);
    if (botId !== workflow.botId) return { ok: false, error: "workflow_bot_mismatch" };
    let trigger = input.trigger || { type: "manual" };
    if (String(input.instruction || "").trim()) {
      const resolved = resolveRoutineSpec(String(input.instruction).trim(), {
        browserContext: input.browserContext,
        windowContext: input.windowContext,
      });
      if (!resolved.ok) return resolved;
      trigger = resolved.spec.trigger;
    }
    const routine = createRoutine({
      botId,
      bot: input.bot,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      name: String(input.name || workflow.name).slice(0, 80),
      instructions: `Run learned workflow "${workflow.name}".`,
      trigger,
      capabilities: workflow.capabilities,
      connectionIds: workflow.connections
        .filter((connection) => connection.kind === "mcp")
        .map((connection) => connection.id),
      approvalPolicy: "preserve_executor_security_gates",
      notificationPolicy: input.notificationPolicy || "always",
      concurrencyPolicy: input.concurrencyPolicy || "skip",
      enabled: input.enabled !== false,
    });
    return { ok: true, routine, routineId: routine.id };
  }

  function proposeRecoveredUpdate(workflowId, steps) {
    const id = `wupdate_${crypto.randomBytes(8).toString("hex")}`;
    const proposal = { id, workflowId: String(workflowId), steps, createdAt: now() };
    recoveredUpdates.set(id, proposal);
    publishWorkflows();
    return proposal;
  }

  function applyRecoveredUpdate(workflowId, updateId) {
    const proposal = recoveredUpdates.get(String(updateId || ""));
    const current = store.get(workflowId);
    if (!proposal || proposal.workflowId !== String(workflowId) || !current) {
      throw new Error("workflow_update_not_found");
    }
    const replacements = new Map(
      proposal.steps.map((item) => [String(item.stepId || item.id || ""), item]),
    );
    const steps = current.steps.map((step) => {
      const replacement = replacements.get(step.id);
      return replacement?.target ? { ...step, target: replacement.target } : step;
    });
    const updated = store.update(workflowId, { ...current, steps }, { expectedVersion: current.version });
    recoveredUpdates.delete(proposal.id);
    publishWorkflows();
    return updated;
  }

  return {
    session,
    store,
    start,
    record,
    recordTaskEvent,
    finish,
    cancel,
    status: () => ({ active: session.active, session: session.snapshot() }),
    listWorkflows,
    getWorkflow: (id, options) =>
      store.get(id, options) || (options?.version ? null : drafts.get(String(id || ""))) || null,
    createWorkflow,
    updateWorkflow,
    removeWorkflow,
    run,
    createRoutineReference,
    proposeRecoveredUpdate,
    applyRecoveredUpdate,
    shutdown: () => {
      stopBrowserCapture();
      cancel("shutdown");
    },
  };
}

function rebuildParameterPaths(definition) {
  const referenced = collectParameters(definition?.steps || []);
  return {
    ...definition,
    parameters: (Array.isArray(definition?.parameters) ? definition.parameters : [])
      .filter((parameter) => referenced.has(String(parameter?.name || "").toLowerCase()))
      .map((parameter) => ({
        ...parameter,
        paths: [...new Set(referenced.get(String(parameter.name).toLowerCase())?.paths || [])],
      })),
  };
}

module.exports = { createTeachService, taskEventToTeachEvent, rebuildParameterPaths };
