"use strict";

const crypto = require("node:crypto");
const { scanCredentialKeys, withoutGenerationRefs } = require("./events.cjs");

const WORKFLOW_SCHEMA = "lykn.workflow";
const WORKFLOW_SCHEMA_VERSION = 1;
const KINDS = new Set(["browser", "local", "mcp", "remote", "task"]);
const PARAMETER_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertPlain(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(message);
}

function assertAllowedKeys(value, allowed, context) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${context} contains unsupported fields: ${unknown.join(", ")}`);
}

function validateWorkflowDefinition(input) {
  assertPlain(input, "WorkflowDefinition must be an object");
  assertAllowedKeys(input, new Set([
    "schema", "schemaVersion", "id", "botId", "version", "name", "objective", "parameters",
    "capabilities", "connections", "approvalPolicy", "steps", "createdAt", "updatedAt", "metadata",
  ]), "WorkflowDefinition");
  if (input.schema !== WORKFLOW_SCHEMA || input.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new TypeError("Unsupported WorkflowDefinition schema version");
  }
  if (!String(input.id || "").trim()) throw new TypeError("WorkflowDefinition id is required");
  if (!String(input.botId || "").trim()) throw new TypeError("WorkflowDefinition botId is required");
  if (!Number.isInteger(input.version) || input.version < 1) throw new TypeError("WorkflowDefinition version must be positive");
  if (!String(input.name || "").trim()) throw new TypeError("WorkflowDefinition name is required");
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new TypeError("WorkflowDefinition steps are required");
  if (input.steps.length > 500) throw new TypeError("WorkflowDefinition has too many steps");
  if (!Array.isArray(input.parameters) || !Array.isArray(input.capabilities) || !Array.isArray(input.connections)) {
    throw new TypeError("WorkflowDefinition lists must be arrays");
  }
  if (input.approvalPolicy !== "preserve_executor_security_gates") {
    throw new TypeError("WorkflowDefinition must preserve executor approval gates");
  }
  const parameterNames = new Set();
  for (const parameter of input.parameters || []) {
    assertPlain(parameter, "Workflow parameter must be an object");
    assertAllowedKeys(parameter, new Set(["name", "type", "required", "default", "paths"]), "Workflow parameter");
    if (!PARAMETER_NAME.test(String(parameter?.name || ""))) throw new TypeError("Invalid workflow parameter");
    if (parameterNames.has(parameter.name)) throw new TypeError("Duplicate workflow parameter");
    parameterNames.add(parameter.name);
  }
  const referencedParameters = collectParameters(input.steps);
  for (const referenced of referencedParameters.keys()) {
    if (!parameterNames.has(referenced)) {
      throw new TypeError(`Workflow step references undeclared parameter: ${referenced}`);
    }
  }
  const stepIds = new Set();
  for (const step of input.steps) {
    assertPlain(step, "Workflow step must be an object");
    assertAllowedKeys(step, new Set([
      "id", "kind", "action", "target", "input", "verification", "semanticVerification",
      "approvalRequired", "human_takeover",
    ]), "Workflow step");
    if (!String(step?.id || "").trim() || stepIds.has(step.id)) throw new TypeError("Workflow step ids must be unique");
    stepIds.add(step.id);
    if (!KINDS.has(step.kind)) throw new TypeError(`Unsupported workflow step kind: ${step.kind}`);
    if (!String(step.action || "").trim()) throw new TypeError("Workflow step action is required");
    if (step.kind === "browser" && scanCredentialKeys(step.target)) throw new TypeError("Browser target contains credentials");
    if (JSON.stringify(step.target) !== JSON.stringify(withoutGenerationRefs(step.target))) {
      throw new TypeError("Workflow target contains an ephemeral generation reference");
    }
    assertPlain(step.verification, "Workflow verification must be an object");
    assertAllowedKeys(step.verification, new Set(["type", "expected", "target"]), "Workflow verification");
    if (step.semanticVerification !== undefined) {
      assertPlain(step.semanticVerification, "Semantic verification must be an object");
      assertAllowedKeys(step.semanticVerification, new Set(["type", "claim"]), "Semantic verification");
      if (step.semanticVerification.type !== "semantic" || !String(step.semanticVerification.claim || "").trim()) {
        throw new TypeError("Invalid semantic verification");
      }
    }
  }
  for (const connection of input.connections || []) {
    assertPlain(connection, "Workflow connection must be an object");
    assertAllowedKeys(connection, new Set(["kind", "id"]), "Workflow connection");
    if (!["mcp", "remote"].includes(connection.kind) || !String(connection.id || "").trim()) {
      throw new TypeError("Invalid workflow connection");
    }
  }
  assertPlain(input.metadata, "Workflow metadata must be an object");
  assertAllowedKeys(input.metadata, new Set(["source", "compileAssistant"]), "Workflow metadata");
  assertPlain(input.metadata.compileAssistant, "Compile assistant metadata must be an object");
  assertAllowedKeys(
    input.metadata.compileAssistant,
    new Set(["calls", "model", "inputTokens", "outputTokens", "costUsd"]),
    "Compile assistant metadata",
  );
  if (scanCredentialKeys(input)) throw new TypeError("Credentials are forbidden in WorkflowDefinition");
  return Object.freeze(clone(input));
}

function deriveCapabilities(events) {
  const result = new Set();
  for (const event of events) {
    const write = /(?:click|type|fill|select|upload|download|write|create|update|delete|send|submit|execute|run|install|move|copy|purchase|pay|deploy)/i.test(event.action);
    if (event.kind === "browser") result.add(write ? "browser.interact" : "browser.read");
    if (event.kind === "local") {
      if (event.metadata?.sourceDomain && event.metadata.sourceDomain !== "local") {
        result.add(write || /click|press|choose|select|focus/i.test(event.action)
          ? "local.app.interact"
          : "local.app.read");
      } else {
        result.add(write
          ? (/execute|run|shell/i.test(event.action) ? "local.shell.execute" : "local.files.write")
          : "local.files.read");
      }
    }
    if (event.kind === "mcp") result.add(write ? "mcp.write" : "mcp.read");
    if (event.kind === "remote") result.add(write ? (/execute|run|shell/i.test(event.action) ? "remote.shell.execute" : "remote.files.write") : "remote.files.read");
    if (event.kind === "task") result.add("task.delegate");
  }
  return [...result].sort();
}

function deriveConnections(events) {
  const result = new Map();
  for (const event of events) {
    if (event.kind === "mcp" && event.target?.connectionId) {
      result.set(`mcp:${event.target.connectionId}`, { kind: "mcp", id: event.target.connectionId });
    }
    if (event.kind === "remote" && event.target?.remoteTargetId) {
      result.set(`remote:${event.target.remoteTargetId}`, { kind: "remote", id: event.target.remoteTargetId });
    }
  }
  return [...result.values()];
}

function collectParameters(value, path = "", found = new Map()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/gi)) {
      const name = match[1].toLowerCase();
      if (!found.has(name)) found.set(name, { name, type: "string", required: true, paths: [] });
      found.get(name).paths.push(path);
    }
    return found;
  }
  if (Array.isArray(value)) value.forEach((child, index) => collectParameters(child, `${path}[${index}]`, found));
  else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => collectParameters(child, path ? `${path}.${key}` : key, found));
  }
  return found;
}

function newWorkflowId() {
  return `wf_${crypto.randomBytes(10).toString("hex")}`;
}

module.exports = {
  WORKFLOW_SCHEMA,
  WORKFLOW_SCHEMA_VERSION,
  validateWorkflowDefinition,
  deriveCapabilities,
  deriveConnections,
  collectParameters,
  newWorkflowId,
  withoutGenerationRefs,
};
