"use strict";

const crypto = require("node:crypto");
const { scrubSensitive } = require("./scrubber.cjs");

const EVENT_KINDS = new Set(["browser", "local", "mcp", "remote", "task"]);
const GENERATION_KEYS = /^(?:ref|refs|generationRef|generation_ref|nodeId|backendNodeId|frameId|elementId)$/i;
const CREDENTIAL_KEYS = /^(?:password|passcode|passphrase|pwd|pin|otp|totp|2fa|mfa|passkey|secret|clientsecret|accesstoken|refreshtoken|idtoken|cookie|setcookie|authorization|proxyauthorization|credential|privatekey|sshkey|apikey|cvv|cvc|cardnumber|bankaccount|payment|billing)$/;
const SENSITIVE_TARGET = /(?:password|passcode|pin|otp|one[- ]time|verification code|2fa|mfa|passkey|security key|api key|access token|oauth|private key|card number|cvv|cvc|bank account|payment)/i;

function cleanString(value, limit = 500) {
  return String(value ?? "").trim().slice(0, limit);
}

function boundValue(value, depth = 0) {
  if (depth > 10) return null;
  if (typeof value === "string") return value.slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).slice(0, 100).map(([key, child]) => [key.slice(0, 120), boundValue(child, depth + 1)]),
  );
}

function withoutGenerationRefs(value) {
  if (Array.isArray(value)) return value.map(withoutGenerationRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !GENERATION_KEYS.test(key))
      .map(([key, child]) => [key, withoutGenerationRefs(child)]),
  );
}

function normalizeBrowserTarget(raw = {}) {
  const target = withoutGenerationRefs(raw);
  const semantic = {};
  for (const key of ["role", "name", "ariaLabel", "label", "text", "placeholder", "href", "testId"]) {
    const value = cleanString(target[key], key === "text" ? 240 : 160);
    if (value) semantic[key] = value;
  }
  if (target.url) semantic.url = cleanString(target.url, 1000);
  if (target.path) semantic.path = cleanString(target.path, 500);
  if (Object.keys(semantic).length) return { strategy: "semantic", confidence: "high", ...semantic };
  const anchor = target.visual_anchor || target.visualAnchor;
  if (anchor && typeof anchor === "object") {
    const clean = withoutGenerationRefs(anchor);
    return { strategy: "visual_anchor", confidence: "low", visual_anchor: clean };
  }
  return { strategy: "unresolved", confidence: "low" };
}

function normalizeTarget(kind, raw = {}) {
  if (kind === "browser") return normalizeBrowserTarget(raw);
  if (kind === "local") {
    return {
      ...(raw.path ? { path: cleanString(raw.path, 1000) } : {}),
      ...(raw.app ? { app: cleanString(raw.app, 120) } : {}),
      ...(raw.role ? { role: cleanString(raw.role, 80) } : {}),
      ...(raw.name ? { name: cleanString(raw.name, 160) } : {}),
      ...(raw.label ? { label: cleanString(raw.label, 160) } : {}),
      ...(raw.identifier ? { identifier: cleanString(raw.identifier, 240) } : {}),
      ...(raw.windowTitle ? { windowTitle: cleanString(raw.windowTitle, 240) } : {}),
    };
  }
  if (kind === "mcp") {
    return {
      connectionId: cleanString(raw.connectionId, 80),
      toolName: cleanString(raw.toolName || raw.tool, 160),
    };
  }
  if (kind === "remote") return { remoteTargetId: cleanString(raw.remoteTargetId || raw.targetId, 120) };
  return {};
}

function consequentialClick(action, target = {}) {
  if (!/^(?:click|press|tap)$/i.test(String(action || ""))) return false;
  const blob = [
    target.name,
    target.label,
    target.text,
    target.ariaLabel,
    target.role,
  ].filter(Boolean).join(" ");
  return /(?:send|submit|publish|pay|purchase|transfer|deploy|delete|confirm)/i.test(blob);
}

function normalizeCommandInput(kind, action, input) {
  if (
    !["local", "remote"].includes(kind) ||
    !/(?:shell|command|execute|terminal|run)/i.test(action) ||
    !input ||
    typeof input !== "object"
  ) return { input, humanTakeover: false };
  const command = cleanString(input.command || input.cmd, 2000);
  if (!command) return { input, humanTakeover: false };
  const simple =
    !/[;&|><`]|[$][(]/.test(command) &&
    /^(?:pwd|ls(?:\s|$)|rg(?:\s|$)|git\s+(?:status|log|diff|show)(?:\s|$)|(?:node|python3?|npm)\s+--version(?:\s|$))/i.test(command);
  if (simple) return { input: { ...input, command }, humanTakeover: false };
  return {
    input: {
      commandCategory: command.split(/\s+/)[0].replace(/[^a-z0-9_.-]/gi, "").slice(0, 60) || "terminal",
      summary: "Run the demonstrated terminal operation with current values.",
    },
    humanTakeover: true,
  };
}

function normalizeRawEvent(raw, { now = () => new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== "object") throw new TypeError("Teach event must be an object");
  const reportedKind = cleanString(raw.kind || raw.source || raw.domain).toLowerCase();
  const kind = ["app", "application", "accessibility", "native_app"].includes(reportedKind)
    ? "local"
    : reportedKind;
  if (!EVENT_KINDS.has(kind)) throw new TypeError(`Unsupported teach event kind: ${kind || "missing"}`);
  const action = cleanString(raw.action || raw.type, 120).toLowerCase();
  if (!action) throw new TypeError("Teach event action is required");
  const scrubbed = scrubSensitive({
    target: raw.target || {},
    input: raw.input ?? raw.args ?? raw.payload ?? null,
    output: raw.output ?? null,
    metadata: raw.metadata || {},
  });
  const clean = scrubbed.value || {};
  const sensitiveInteraction =
    /(?:fill|type|enter|input|submit|authenticate|login|pay)/i.test(action) &&
    SENSITIVE_TARGET.test(JSON.stringify(raw.target || {}));
  const command = normalizeCommandInput(kind, action, boundValue(clean.input ?? null));
  return Object.freeze({
    id: cleanString(raw.id, 120) || `te_${crypto.randomBytes(8).toString("hex")}`,
    kind,
    action,
    target: normalizeTarget(kind, clean.target),
    input: sensitiveInteraction ? null : command.input,
    output: boundValue(clean.output ?? null),
    metadata: boundValue(withoutGenerationRefs({
      ...(clean.metadata || {}),
      ...(kind === "local" && reportedKind !== "local" ? { sourceDomain: reportedKind } : {}),
    })),
    timestamp: cleanString(raw.timestamp, 50) || now(),
    human_takeover:
      raw.human_takeover === true ||
      scrubbed.humanTakeover ||
      sensitiveInteraction ||
      command.humanTakeover,
    approvalRequired:
      raw.approvalRequired === true ||
      /(?:create|update|delete|send|submit|purchase|pay|transfer|publish|deploy|write|execute|install)/i.test(action) ||
      consequentialClick(action, raw.target || clean.target),
  });
}

function signature(event) {
  return JSON.stringify([event.kind, event.action, event.target, event.input]);
}

function navigationLocation(event) {
  if (!event || event.kind !== "browser" || !/(?:navigate|goto|open_url|back|forward)/.test(event.action)) return "";
  return cleanString(event.target?.url || event.input?.url || event.input, 1000);
}

function removeNoise(events) {
  const output = [];
  for (const event of events) {
    if (!event || /^(?:noop|no_op|wait|observe|hover)$/.test(event.action)) continue;
    if (event.kind === "task" && event.human_takeover !== true) continue;
    const previous = output[output.length - 1];
    if (previous && signature(previous) === signature(event)) continue;
    const location = navigationLocation(event);
    if (location && location === navigationLocation(previous)) continue;
    const beforePrevious = output[output.length - 2];
    if (location && beforePrevious && location === navigationLocation(beforePrevious)) {
      output.pop();
      continue;
    }
    output.push(event);
  }
  return output;
}

function normalizeEvents(rawEvents, options) {
  return removeNoise((Array.isArray(rawEvents) ? rawEvents : []).map((event) => normalizeRawEvent(event, options)));
}

function scanCredentialKeys(value) {
  if (typeof value === "string") return scrubSensitive(value).droppedPaths.length > 0;
  if (Array.isArray(value)) return value.some(scanCredentialKeys);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return CREDENTIAL_KEYS.test(normalizedKey) || scanCredentialKeys(child);
  });
}

module.exports = {
  EVENT_KINDS,
  normalizeRawEvent,
  normalizeEvents,
  normalizeBrowserTarget,
  removeNoise,
  withoutGenerationRefs,
  scanCredentialKeys,
  boundValue,
  normalizeCommandInput,
};
