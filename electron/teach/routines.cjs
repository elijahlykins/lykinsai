"use strict";

const { validateWorkflowDefinition } = require("./workflow.cjs");

function createWorkflowRoutineReference(definitionInput, { parameterBindings = {} } = {}) {
  const definition = validateWorkflowDefinition(definitionInput);
  const allowed = new Set((definition.parameters || []).map((parameter) => parameter.name));
  const bindings = {};
  for (const [name, reference] of Object.entries(parameterBindings)) {
    if (!allowed.has(name)) continue;
    const value = String(reference || "").trim();
    if (/^(?:trigger|routine|input)\.[a-zA-Z0-9_.-]{1,100}$/.test(value)) bindings[name] = value;
  }
  return Object.freeze({
    type: "workflow_reference",
    workflowId: definition.id,
    workflowVersion: definition.version,
    parameterBindings: bindings,
  });
}

module.exports = { createWorkflowRoutineReference };
