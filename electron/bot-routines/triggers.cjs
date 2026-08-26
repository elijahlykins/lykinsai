"use strict";

/**
 * The Routine trigger contract — small, explicit, extensible.
 *
 * A trigger describes WHAT makes a Routine fire. It carries only the fields
 * its type needs, is validated at creation time, and never executes work:
 * the scheduler fires "schedule", the monitor runtime fires "filesystem" /
 * "process", and "manual" fires only through Run Now.
 *
 * V1 types:
 *   manual     — Run Now only. {}
 *   schedule   — { schedule: <schedule.cjs spec>, missedRunPolicy? }
 *   filesystem — { path, event: "created"|"changed"|"exists", pattern? }
 *                pattern is a simple glob on the file NAME ("*.pdf").
 *   process    — { name, event: "exited"|"started" }
 *                name matches the process command line (pgrep -f).
 *
 * Deferred (documented, not silently accepted): "browser" page conditions.
 * Rejecting them here keeps a future type from being half-created today.
 */

const { normalizeSchedule } = require("./schedule.cjs");

const TRIGGER_TYPES = Object.freeze(["manual", "schedule", "filesystem", "process"]);
const FILESYSTEM_EVENTS = Object.freeze(["created", "changed", "exists"]);
const PROCESS_EVENTS = Object.freeze(["exited", "started"]);
const MISSED_RUN_POLICIES = Object.freeze(["skip", "run_once"]);

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
    return Object.freeze({ type, path: watchPath, event, ...(pattern ? { pattern } : {}) });
  }
  // type === "process"
  const name = String(input.name || "").trim().slice(0, 200);
  if (!name) throw new TypeError("Process trigger requires a 'name'");
  const event = String(input.event || "exited").trim();
  if (!PROCESS_EVENTS.includes(event)) throw new TypeError(`Unknown process event: ${event}`);
  return Object.freeze({ type, name, event });
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
  return "Unknown trigger";
}

module.exports = {
  TRIGGER_TYPES,
  FILESYSTEM_EVENTS,
  PROCESS_EVENTS,
  MISSED_RUN_POLICIES,
  normalizeTrigger,
  describeTrigger,
  globToRegExp,
  matchesPattern,
};
