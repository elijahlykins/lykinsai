"use strict";

const crypto = require("node:crypto");
const { createTask } = require("../task-runtime/task.cjs");
const { validateWorkflowDefinition } = require("./workflow.cjs");

function interpolate(value, parameters) {
  if (typeof value === "string") {
    return value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gi, (_, name) => String(parameters[name] ?? ""));
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, parameters));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, interpolate(child, parameters)]));
  }
  return value;
}

function defaultVerify(step, result) {
  const verification = step.verification || { type: "executor_success" };
  if (result?.ok === false || ["failed", "cancelled", "aborted"].includes(result?.status)) {
    return { ok: false, reason: result?.reason || result?.error || "executor_failed" };
  }
  if (verification.type === "executor_success") return { ok: true };
  if (verification.type === "url_matches") {
    const actual = result?.url || result?.browserResult?.url;
    return { ok: actual === verification.expected, reason: "url_mismatch", actual };
  }
  if (verification.type === "target_present") {
    const present = result?.targetPresent ?? result?.browserResult?.targetPresent;
    const executorVerified =
      result?.verifiedComplete === true || result?.browserResult?.verifiedComplete === true;
    return present === true || executorVerified
      ? { ok: true }
      : { ok: false, reason: "target_missing" };
  }
  if (verification.type === "output_equals") {
    const actual = result?.observation ?? result?.output ?? result?.answer;
    return {
      ok: JSON.stringify(actual) === JSON.stringify(verification.expected),
      reason: "output_mismatch",
      actual,
    };
  }
  return { ok: false, reason: "unknown_verification" };
}

function validateParameters(definition, supplied = {}) {
  const result = {};
  for (const parameter of definition.parameters || []) {
    const value = supplied[parameter.name] ?? parameter.default;
    if (parameter.required && (value === undefined || value === null || value === "")) {
      throw new TypeError(`Missing required workflow parameter: ${parameter.name}`);
    }
    if (value !== undefined) result[parameter.name] = value;
  }
  return result;
}

class WorkflowExecutor {
  constructor({
    taskRuntime,
    adapters,
    verifyDeterministic = defaultVerify,
    semanticRecovery = null,
    maxRecoveries = 2,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!taskRuntime || typeof taskRuntime.register !== "function" || typeof taskRuntime.execute !== "function") {
      throw new TypeError("WorkflowExecutor requires the canonical TaskRuntime");
    }
    this.taskRuntime = taskRuntime;
    this.adapters = adapters || {};
    this.verifyDeterministic = verifyDeterministic;
    this.semanticRecovery = semanticRecovery;
    this.maxRecoveries = Math.max(0, Math.min(5, Number(maxRecoveries) || 0));
    this.now = now;
  }

  async execute(definitionInput, suppliedParameters = {}, options = {}) {
    const definition = validateWorkflowDefinition(definitionInput);
    const parameters = validateParameters(definition, suppliedParameters);
    const taskId = String(options.taskId || `task_workflow_${crypto.randomBytes(8).toString("hex")}`);
    const task = createTask({
      id: taskId,
      runId: String(options.runId || ""),
      objective: definition.objective || `Run workflow: ${definition.name}`,
      successCriteria: ["Every workflow step passes deterministic verification."],
      capabilities: definition.capabilities,
      budgets: {
        maxRounds: definition.steps.length,
        maxRecoveries: this.maxRecoveries,
        maxChildExecutors: definition.steps.length + this.maxRecoveries,
        timeoutMs: options.timeoutMs || 0,
      },
      approval: { policy: "preserve_executor_security_gates", state: "not_requested" },
      cancellation: { state: "active" },
      origin:
        options.origin ||
        { type: "taught_workflow", workflowId: definition.id, workflowVersion: definition.version },
      association: {
        botId: definition.botId,
        workflowId: definition.id,
        workflowVersion: definition.version,
        connectionIds: definition.connections.filter((item) => item.kind === "mcp").map((item) => item.id),
        ...(options.association || {}),
      },
      createdAt: this.now(),
    });
    this.taskRuntime.register(task);
    try {
      options.onTaskCreated?.(task.id);
    } catch {
      /* observer only */
    }
    const abort = () => this.taskRuntime.cancel(taskId, options.signal?.reason || "cancelled");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener?.("abort", abort, { once: true });
    try {
      return await this.taskRuntime.execute(taskId, {
        name: "taught_workflow",
        execute: (canonicalTask, runtime) =>
          this.runSteps(definition, parameters, canonicalTask, runtime, options),
      });
    } finally {
      options.signal?.removeEventListener?.("abort", abort);
    }
  }

  async runSteps(definition, parameters, task, runtime, options) {
    const completed = [];
    const proposedUpdates = [];
    let recoveries = 0;
    for (const sourceStep of definition.steps) {
      if (runtime.signal?.aborted) return { status: "cancelled", reason: "task_cancelled", completed };
      let step = interpolate(sourceStep, parameters);
      if (step.human_takeover) {
        return {
          status: "waiting_for_user",
          question: `Step ${step.id} requires you to complete a sensitive action.`,
          waitingKind: "human_takeover",
          completed,
        };
      }
      if (step.target?.confidence === "low") {
        const recovered = await this.recover(step, { reason: "low_confidence_target" }, task, runtime, recoveries);
        if (!recovered.ok) return { ...recovered, completed };
        recoveries += 1;
        proposedUpdates.push({ stepId: step.id, target: recovered.target, reason: recovered.reason });
        step = { ...step, target: recovered.target };
      }
      const adapter = this.adapters[step.kind];
      if (!adapter || (typeof adapter !== "function" && typeof adapter.execute !== "function")) {
        return { ok: false, status: "failed", reason: `executor_adapter_missing:${step.kind}`, completed };
      }
      let result;
      let verification;
      const verbAlreadyGates = /(?:create|update|delete|send|submit|purchase|pay|transfer|publish|deploy|write|execute|install)/i.test(step.action);
      if (
        step.approvalRequired &&
        step.kind !== "mcp" &&
        !verbAlreadyGates &&
        task.approval?.policy !== "standing_authorization"
      ) {
        return {
          ok: false,
          status: "waiting_for_approval",
          reason: "approval_required",
          question: `Approve ${step.action} (${step.target?.name || step.target?.label || step.target?.text || "this action"})?`,
          completed,
        };
      }
      while (true) {
        const childTask = {
          ...task,
          objective: [
            step.action,
            `target=${JSON.stringify(step.target)}`,
            step.input !== null && step.input !== undefined
              ? `input=${JSON.stringify(step.input)}`
              : "",
          ].filter(Boolean).join(" "),
          approval: { ...task.approval, state: "not_requested" },
          association: {
            ...task.association,
            ...(step.kind === "remote" && step.target?.remoteTargetId
              ? { remoteTargetId: step.target.remoteTargetId }
              : {}),
          },
        };
        result = await runtime.runChild(step.kind, () => {
          const run = typeof adapter === "function" ? adapter : adapter.execute.bind(adapter);
          return run(childTask, {
            ...runtime,
            instruction: childTask.objective,
            step,
            connectionId: step.target?.connectionId,
            toolName: step.target?.toolName,
            args: step.input || {},
          });
        });
        if (
          step.kind === "mcp" &&
          ["connection_required", "connection_unavailable", "connection_disconnected", "connection_auth_required"]
            .includes(result?.reason)
        ) {
          return {
            ...result,
            ok: false,
            status: "waiting_for_user",
            waitingKind: "connection_required",
            connectionReason: result.reason,
            reason: "connection_required",
            completed,
          };
        }
        if (["waiting_for_user", "waiting_for_approval"].includes(result?.status)) {
          return { ...result, completed };
        }
        verification = await this.verifyDeterministic(step, result, { task, runtime });
        if (verification?.ok) break;
        const recovered = await this.recover(step, verification, task, runtime, recoveries);
        if (!recovered.ok) return { ...recovered, completed };
        recoveries += 1;
        proposedUpdates.push({ stepId: step.id, target: recovered.target, reason: recovered.reason });
        step = { ...step, target: recovered.target };
      }
      completed.push({ stepId: step.id, result, verification });
    }
    return {
      ok: true,
      status: "completed",
      output: `Completed ${completed.length} workflow steps.`,
      completed,
      proposedUpdates,
      workflowUpdated: false,
    };
  }

  async recover(step, divergence, task, runtime, used) {
    if (used >= this.maxRecoveries || typeof this.semanticRecovery !== "function") {
      return {
        status: "waiting_for_user",
        question: `Workflow diverged at ${step.id}: ${divergence.reason || "verification failed"}.`,
        waitingKind: "workflow_divergence",
      };
    }
    const candidate = await this.semanticRecovery({ step, divergence, task, signal: runtime.signal });
    if (!candidate || candidate.confidence !== "high" || !candidate.target) {
      return {
        status: "waiting_for_user",
        question: `I could not confidently recover step ${step.id}.`,
        waitingKind: "low_confidence_recovery",
      };
    }
    return { ok: true, target: candidate.target, reason: divergence.reason || "semantic_recovery" };
  }

  updateWorkflow(store, workflowId, patch, { expectedVersion } = {}) {
    if (!store || typeof store.get !== "function" || typeof store.update !== "function") {
      throw new TypeError("Explicit workflow update requires a WorkflowStore");
    }
    const current = store.get(workflowId);
    if (!current) throw new Error("workflow_not_found");
    const steps = current.steps.map((step) => {
      const update = (patch.steps || []).find((item) => item.stepId === step.id || item.id === step.id);
      return update ? { ...step, ...(update.target ? { target: update.target } : {}) } : step;
    });
    return store.update(workflowId, { ...current, ...patch, steps }, { expectedVersion });
  }
}

module.exports = { WorkflowExecutor, defaultVerify, interpolate, validateParameters };
