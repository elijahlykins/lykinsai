"use strict";

const { normalizeEvents, removeNoise } = require("./events.cjs");
const {
  WORKFLOW_SCHEMA,
  WORKFLOW_SCHEMA_VERSION,
  validateWorkflowDefinition,
  deriveCapabilities,
  deriveConnections,
  collectParameters,
  newWorkflowId,
} = require("./workflow.cjs");

function deterministicVerification(event) {
  if (event.kind === "browser") {
    if (/(?:navigate|goto|open_url)/.test(event.action) && event.target?.url) {
      return { type: "url_matches", expected: event.target.url };
    }
    return { type: "target_present", target: event.target };
  }
  return { type: "executor_success" };
}

function normalizedCost(usage, called) {
  return {
    calls: called ? 1 : 0,
    model: String(usage?.model || ""),
    inputTokens: Math.max(0, Number(usage?.inputTokens) || 0),
    outputTokens: Math.max(0, Number(usage?.outputTokens) || 0),
    costUsd: Math.max(0, Number(usage?.costUsd) || 0),
  };
}

function parameterName(value, fallback = "input") {
  const words = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const name = words
    .join("_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 50);
  return /^[a-z][a-z0-9]*$/i.test(name) ? name : fallback;
}

function inferLikelyParameters(inputSteps) {
  const steps = JSON.parse(JSON.stringify(inputSteps));
  const candidates = [];
  const valueCounts = new Map();

  const visit = (value, path, context, replace) => {
    if (typeof value === "string") {
      if (!value || /\{\{[a-z][a-z0-9_]*\}\}/i.test(value)) return;
      valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
      candidates.push({ value, path, context, replace });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) =>
        visit(child, `${path}[${index}]`, { ...context, key: String(index) }, (next) => {
          value[index] = next;
        }),
      );
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, child]) =>
        visit(child, `${path}.${key}`, { ...context, key }, (next) => {
          value[key] = next;
        }),
      );
    }
  };

  steps.forEach((step, index) => {
    visit(step.input, `[${index}].input`, {
      step,
      key: "",
      label: step.target?.label || step.target?.name || step.target?.placeholder || "",
    });
  });

  const used = new Set();
  const inferred = new Map();
  const uniqueName = (preferred) => {
    const base = parameterName(preferred);
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}${suffix}`;
      suffix += 1;
    }
    used.add(name);
    return name;
  };

  for (const candidate of candidates) {
    if (inferred.size >= 12) break;
    const { step, key, label } = candidate.context;
    const browserEntry =
      step.kind === "browser" && /^(?:fill|type|enter|input|select)$/.test(step.action);
    const dateLike =
      /(?:date|time|start|end|since|until|after|before|deadline|due)/i.test(key) &&
      /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]+)?$/i.test(candidate.value);
    const namedDynamic =
      /^(?:query|search|title|subject|recipient|email|name|project|filename|file|message|date|start|end|since|until|deadline|due)$/i.test(key);
    const repeated = (valueCounts.get(candidate.value) || 0) > 1;
    if (!browserEntry && !dateLike && !namedDynamic && !repeated) continue;
    const existing = [...inferred.values()].find((item) => item.value === candidate.value);
    const name = existing?.name || uniqueName(label || key || (dateLike ? "date" : "input"));
    candidate.replace(`{{${name}}}`);
    if (existing) {
      existing.paths.push(candidate.path);
    } else {
      inferred.set(name, {
        name,
        value: candidate.value,
        type: dateLike ? "date" : "string",
        required: false,
        default: candidate.value,
        paths: [candidate.path],
      });
    }
  }

  steps.forEach((step, index) => {
    if (step.kind !== "local" || typeof step.target?.path !== "string") return;
    const match = step.target.path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(.*)$/);
    if (match) {
      const name = inferred.has("home") ? "home" : uniqueName("home");
      step.target.path = `{{${name}}}${match[2]}`;
      const existing = inferred.get(name);
      if (existing) {
        existing.paths.push(`[${index}].target.path`);
      } else {
        inferred.set(name, {
          name,
          value: match[1],
          type: "path",
          required: false,
          default: match[1],
          paths: [`[${index}].target.path`],
        });
      }
    }
    const filename = step.target.path.match(/([^/\\{}]+\.[A-Za-z0-9]{1,12})$/)?.[1];
    if (
      filename &&
      /(?:open|read|write|save|upload|download|copy|move|rename|create)/i.test(step.action) &&
      inferred.size < 12
    ) {
      const repeatedFile = [...inferred.values()].find((item) => item.value === filename);
      const name = repeatedFile?.name || uniqueName("filename");
      step.target.path = `${step.target.path.slice(0, -filename.length)}{{${name}}}`;
      if (repeatedFile) {
        repeatedFile.paths.push(`[${index}].target.path`);
      } else {
        inferred.set(name, {
          name,
          value: filename,
          type: "string",
          required: false,
          default: filename,
          paths: [`[${index}].target.path`],
        });
      }
    }
  });

  return { steps, inferred };
}

async function compileWorkflow(input = {}, options = {}) {
  const botId = String(input.botId || "").trim().slice(0, 120);
  if (!botId) throw new TypeError("Demonstrated workflow requires a botId");
  const source = Array.isArray(input.events) ? input.events : [];
  const events = removeNoise(normalizeEvents(source, { now: options.now }));
  if (!events.length) throw new TypeError("Cannot compile an empty demonstration");
  const at = (options.now || (() => new Date().toISOString()))();
  const baseSteps = events.map((event, index) => ({
    id: `step_${index + 1}`,
    kind: event.kind,
    action: event.action,
    target: event.target,
    input: event.input,
    verification: deterministicVerification(event),
    approvalRequired: event.approvalRequired === true,
    human_takeover: event.human_takeover === true,
  }));
  const inferredResult = inferLikelyParameters(baseSteps);
  const steps = inferredResult.steps;
  const parameters = [...collectParameters(steps).values()].map((parameter) => {
    const inferred = inferredResult.inferred.get(parameter.name);
    return {
      ...parameter,
      ...(inferred
        ? {
            type: inferred.type,
            required: inferred.required,
            default: inferred.default,
          }
        : {}),
      paths: [...new Set(parameter.paths)],
    };
  });
  let assistantUsage = null;
  let assistantPatch = null;
  if (typeof options.compileAssistant === "function") {
    const response = await options.compileAssistant({
      objective: String(input.objective || ""),
      steps: JSON.parse(JSON.stringify(steps)),
      capabilities: deriveCapabilities(events),
    });
    assistantPatch = response?.workflow || response?.patch || response || {};
    assistantUsage = response?.usage || null;
  }
  if (assistantPatch?.verifications && typeof assistantPatch.verifications === "object") {
    for (const step of steps) {
      const suggested = assistantPatch.verifications[step.id];
      const claim = String(suggested?.claim || "").trim().slice(0, 500);
      if (claim) step.semanticVerification = { type: "semantic", claim };
    }
  }
  const name =
    String(assistantPatch?.name || input.name || input.objective || "Taught workflow").trim().slice(0, 120) ||
    "Taught workflow";
  const definition = {
    schema: WORKFLOW_SCHEMA,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: String(input.id || options.id || newWorkflowId()),
    botId,
    version: 1,
    name,
    objective: String(input.objective || "").trim().slice(0, 1000),
    parameters,
    capabilities: deriveCapabilities(events),
    connections: deriveConnections(events),
    approvalPolicy: "preserve_executor_security_gates",
    steps,
    createdAt: at,
    updatedAt: at,
    metadata: {
      source: "teach_by_demonstration",
      compileAssistant: normalizedCost(assistantUsage, typeof options.compileAssistant === "function"),
    },
  };
  return validateWorkflowDefinition(definition);
}

module.exports = {
  compileWorkflow,
  deterministicVerification,
  normalizedCost,
  inferLikelyParameters,
};
