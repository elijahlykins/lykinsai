"use strict";

/**
 * The Routine trigger contract — small, explicit, extensible.
 *
 * A trigger describes WHAT makes a Routine fire. It carries only the fields
 * its type needs, is validated at creation time, and never executes work:
 * the scheduler fires "schedule", the monitor runtime fires "filesystem" /
 * "process" / "browser" / "screen", and "manual" fires only through Run Now.
 *
 * Types:
 *   manual     — Run Now only. {}
 *   schedule   — { schedule: <schedule.cjs spec>, missedRunPolicy? }
 *   filesystem — { path, event: "created"|"changed"|"exists", pattern? }
 *   process    — { name, event: "exited"|"started" }
 *   browser    — durable page/tab identity + observation target + condition
 *                Generation-scoped refs (g42:17) are refused.
 *   screen     — durable app/title/region identity. Pixels are a fallback.
 */

const { normalizeSchedule } = require("./schedule.cjs");
const {
  BROWSER_EVENTS,
  sanitizeDurableTarget,
  describeBrowserTarget,
  describeBrowserCondition,
  originOf,
  isEphemeralRef,
} = require("./browserObservation.cjs");
const {
  SCREEN_EVENTS,
  describeScreenTarget,
  describeScreenCondition,
} = require("./screenObservation.cjs");

const TRIGGER_TYPES = Object.freeze([
  "manual",
  "schedule",
  "filesystem",
  "process",
  "browser",
  "screen",
]);
const FILESYSTEM_EVENTS = Object.freeze(["created", "changed", "exists"]);
const PROCESS_EVENTS = Object.freeze(["exited", "started"]);
const MISSED_RUN_POLICIES = Object.freeze(["skip", "run_once"]);
const MONITOR_TYPES = Object.freeze(["filesystem", "process", "browser", "screen"]);

/** "*.pdf" → /^[^/]*\.pdf$/i — name-only glob, * and ? only. */
function globToRegExp(pattern) {
  const escaped = String(pattern || "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(fileName, pattern) {
  if (!pattern) return true;
  try {
    return globToRegExp(pattern).test(String(fileName || ""));
  } catch {
    return false;
  }
}

function optionalBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

function normalizeBrowserTrigger(input) {
  const url = String(input.url || "").trim().slice(0, 500);
  const origin = String(input.origin || originOf(url) || "").trim().slice(0, 200);
  const titlePattern = String(input.titlePattern || "").trim().slice(0, 120);
  const appName = String(input.appName || "").trim().slice(0, 80);
  const sessionId = String(input.sessionId || "").trim().slice(0, 120);
  // tabId is a hint only — it does not survive restart and is never the
  // identity we match against after a re-resolution miss.
  const tabIdHint = String(input.tabId || "").trim().slice(0, 80);
  if (isEphemeralRef(url) || isEphemeralRef(input.ref)) {
    throw new TypeError("Browser targets cannot store generation-scoped element refs");
  }
  const target = sanitizeDurableTarget(input.target || input.observation || {});
  const condIn = input.condition && typeof input.condition === "object" ? input.condition : {};
  const event = String(condIn.event || input.event || "changed").trim();
  if (!BROWSER_EVENTS.includes(event)) throw new TypeError(`Unknown browser event: ${event}`);
  const value = String(condIn.value || "").trim().slice(0, 120);
  const semantic = condIn.semantic === true || input.semantic === true;
  const semanticPrompt = String(condIn.semanticPrompt || input.semanticPrompt || "").trim().slice(0, 200);
  const notifyOnly = optionalBool(input.notifyOnly);
  const pollMs = Number(input.pollMs);
  if (!url && !origin && !titlePattern && !sessionId) {
    throw new TypeError("Browser trigger requires a url, origin, titlePattern, or sessionId");
  }
  return Object.freeze({
    type: "browser",
    ...(url ? { url } : {}),
    ...(origin ? { origin } : {}),
    ...(titlePattern ? { titlePattern } : {}),
    ...(appName ? { appName } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(tabIdHint ? { tabIdHint } : {}),
    target,
    condition: Object.freeze({
      event,
      ...(value ? { value } : {}),
      ...(semantic ? { semantic: true } : {}),
      ...(semanticPrompt ? { semanticPrompt } : {}),
    }),
    ...(semantic ? { semantic: true } : {}),
    ...(notifyOnly !== undefined ? { notifyOnly } : {}),
    ...(Number.isFinite(pollMs) && pollMs > 0 ? { pollMs: Math.round(pollMs) } : {}),
  });
}

function normalizeScreenTrigger(input) {
  const appName = String(input.appName || "").trim().slice(0, 80);
  const titlePattern = String(input.titlePattern || "").trim().slice(0, 120);
  const bundleId = String(input.bundleId || "").trim().slice(0, 120);
  const windowIdHint = String(input.windowId || "").trim().slice(0, 80);
  const condIn = input.condition && typeof input.condition === "object" ? input.condition : {};
  const event = String(condIn.event || input.event || "changed").trim();
  if (!SCREEN_EVENTS.includes(event)) throw new TypeError(`Unknown screen event: ${event}`);
  const semanticPrompt = String(condIn.semantic || condIn.semanticPrompt || input.semanticPrompt || "").trim().slice(
    0,
    200,
  );
  const semantic = condIn.semantic === true || input.semantic === true || !!semanticPrompt;
  const notifyOnly = optionalBool(input.notifyOnly);
  const pollMs = Number(input.pollMs);
  let region = null;
  if (input.region && typeof input.region === "object") {
    const x = Number(input.region.x);
    const y = Number(input.region.y);
    const w = Number(input.region.w ?? input.region.width);
    const h = Number(input.region.h ?? input.region.height);
    if ([x, y, w, h].every((n) => Number.isFinite(n)) && w > 0 && h > 0) {
      region = Object.freeze({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    }
  }
  if (!appName && !titlePattern && !bundleId && !region) {
    throw new TypeError("Screen trigger requires an appName, titlePattern, bundleId, or region");
  }
  return Object.freeze({
    type: "screen",
    ...(appName ? { appName } : {}),
    ...(titlePattern ? { titlePattern } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(windowIdHint ? { windowIdHint } : {}),
    ...(region ? { region } : {}),
    condition: Object.freeze({
      event,
      ...(semanticPrompt ? { semantic: semanticPrompt } : {}),
    }),
    ...(semantic ? { semantic: true } : {}),
    ...(notifyOnly !== undefined ? { notifyOnly } : {}),
    ...(Number.isFinite(pollMs) && pollMs > 0 ? { pollMs: Math.round(pollMs) } : {}),
  });
}

/**
 * Validate + canonicalize a trigger. Throws TypeError on anything that could
 * not actually fire, so a broken Routine is impossible to persist.
 */
function normalizeTrigger(spec) {
  const input = spec && typeof spec === "object" ? spec : {};
  const type = String(input.type || "").trim();
  if (!TRIGGER_TYPES.includes(type)) {
    throw new TypeError(`Unknown trigger type: ${type || "(none)"}`);
  }
  if (type === "manual") return Object.freeze({ type });
  if (type === "schedule") {
    const schedule = normalizeSchedule(input.schedule);
    const missedRunPolicy = String(input.missedRunPolicy || "").trim();
    if (missedRunPolicy && !MISSED_RUN_POLICIES.includes(missedRunPolicy)) {
      throw new TypeError(`Unknown missedRunPolicy: ${missedRunPolicy}`);
    }
    return Object.freeze({
      type,
      schedule,
      ...(missedRunPolicy ? { missedRunPolicy } : {}),
    });
  }
  if (type === "filesystem") {
    const watchPath = String(input.path || "").trim();
    if (!watchPath) throw new TypeError("Filesystem trigger requires a 'path'");
    const event = String(input.event || "created").trim();
    if (!FILESYSTEM_EVENTS.includes(event)) {
      throw new TypeError(`Unknown filesystem event: ${event}`);
    }
    const pattern = String(input.pattern || "").trim();
    if (pattern) globToRegExp(pattern); // validate now, not at watch time
    const notifyOnly = optionalBool(input.notifyOnly);
    return Object.freeze({
      type,
      path: watchPath,
      event,
      ...(pattern ? { pattern } : {}),
      ...(notifyOnly !== undefined ? { notifyOnly } : {}),
    });
  }
  if (type === "process") {
    const name = String(input.name || "").trim().slice(0, 200);
    if (!name) throw new TypeError("Process trigger requires a 'name'");
    const event = String(input.event || "exited").trim();
    if (!PROCESS_EVENTS.includes(event)) throw new TypeError(`Unknown process event: ${event}`);
    const notifyOnly = optionalBool(input.notifyOnly);
    return Object.freeze({
      type,
      name,
      event,
      ...(notifyOnly !== undefined ? { notifyOnly } : {}),
    });
  }
  if (type === "browser") return normalizeBrowserTrigger(input);
  return normalizeScreenTrigger(input);
}

function isMonitorTrigger(trigger) {
  return MONITOR_TYPES.includes(String(trigger?.type || ""));
}

/** Human-readable one-liner for the UI. */
function describeTrigger(trigger, { describeScheduleFn } = {}) {
  if (!trigger || trigger.type === "manual") return "Run manually";
  if (trigger.type === "schedule") {
    const describe = describeScheduleFn || require("./schedule.cjs").describeSchedule;
    return describe(trigger.schedule);
  }
  if (trigger.type === "filesystem") {
    const what = trigger.pattern ? `${trigger.pattern} ` : "";
    const verb =
      trigger.event === "created" ? "appears in" : trigger.event === "changed" ? "changes in" : "exists in";
    return `When ${what || "a file "}${verb} ${trigger.path}`;
  }
  if (trigger.type === "process") {
    return `When "${trigger.name}" ${trigger.event === "exited" ? "exits" : "starts"}`;
  }
  if (trigger.type === "browser") {
    return `Watch ${describeBrowserTarget(trigger)}: ${describeBrowserCondition(trigger)}`;
  }
  if (trigger.type === "screen") {
    return `Watch ${describeScreenTarget(trigger)}: ${describeScreenCondition(trigger)}`;
  }
  return "Unknown trigger";
}

module.exports = {
  TRIGGER_TYPES,
  FILESYSTEM_EVENTS,
  PROCESS_EVENTS,
  MISSED_RUN_POLICIES,
  MONITOR_TYPES,
  BROWSER_EVENTS,
  SCREEN_EVENTS,
  normalizeTrigger,
  describeTrigger,
  isMonitorTrigger,
  globToRegExp,
  matchesPattern,
};
