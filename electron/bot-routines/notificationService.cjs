"use strict";

/**
 * The ONE notification service — every Bot / Routine / Task notification
 * flows through here. Executors and bots do not build their own.
 *
 * V1 destinations:
 *   - native desktop notification (Electron Notification, injected so this
 *     module never imports electron and stays unit-testable)
 *   - in-app activity event, pushed over one IPC channel the renderer
 *     subscribes to, and kept in a bounded recent list for late subscribers
 *
 * The destination set is a list so mobile/other sinks can be added later
 * without touching callers.
 *
 * Policy filtering happens here (shouldNotify): a monitor's "no change this
 * check" NEVER notifies, and a routine set to on_failure stays silent on
 * success. Dedupe: identical routine+outcome bursts inside DEDUPE_MS collapse
 * to one notification, so a trigger storm cannot become a notification storm.
 *
 * Bodies are previews, not payloads: long results are truncated and the deep
 * link carries identity (botId / routineId / taskId / runId), never content.
 */

const MAX_RECENT = 100;
const DEDUPE_MS = 30 * 1000;
const MAX_BODY = 240;

const URGENCIES = Object.freeze(["low", "normal", "high"]);

/**
 * Does this outcome pass the routine's notification policy?
 *
 * @param {string} policy always | on_success | on_failure | on_change | silent
 * @param {object} outcome { status, changed? } — status is a run/task status,
 *   changed marks a monitor trigger (the condition occurred).
 */
function shouldNotify(policy, outcome = {}) {
  const p = String(policy || "always");
  const status = String(outcome.status || "");
  if (p === "silent") return false;
  if (p === "always") return true;
  if (p === "on_success") return status === "completed";
  if (p === "on_failure") return status === "failed" || status === "cancelled" || status === "timeout";
  if (p === "on_change") return outcome.changed === true;
  return true;
}

/**
 * @param {object} opts
 * @param {(payload: object) => void} [opts.emitToRenderer] in-app sink
 * @param {{ isSupported: () => boolean, create: (opts: object) => {show: Function, on: Function} }} [opts.native]
 *   native sink; absent in tests / headless
 * @param {(deepLink: object) => void} [opts.onOpen] click handler (focus + navigate)
 * @param {() => number} [opts.now]
 */
function createNotificationService({
  emitToRenderer = () => {},
  native = null,
  onOpen = () => {},
  now = () => Date.now(),
} = {}) {
  /** @type {object[]} newest first */
  const recent = [];
  /** @type {Map<string, number>} dedupe key → last sent at */
  const lastSent = new Map();
  let counter = 0;

  function dedupeKey(input) {
    return [input.routineId || "", input.taskId || "", input.title || "", input.urgency || ""].join("|");
  }

  /**
   * Send one notification. Returns { sent, suppressed?, id? }.
   *
   * @param {object} input
   *   { botId, routineId?, runId?, taskId?, title, body, urgency?, policy?,
   *     outcome?, deepLink?, actions? }
   * policy+outcome are evaluated here so callers cannot forget the filter.
   */
  function notify(input = {}) {
    const title = String(input.title || "").trim().slice(0, 120);
    if (!title) return { sent: false, suppressed: "empty" };
    if (input.policy !== undefined && !shouldNotify(input.policy, input.outcome || {})) {
      return { sent: false, suppressed: "policy" };
    }
    const key = dedupeKey(input);
    const t = now();
    if (t - (lastSent.get(key) || 0) < DEDUPE_MS) {
      return { sent: false, suppressed: "dedupe" };
    }
    lastSent.set(key, t);

    counter += 1;
    const record = {
      id: `ntf_${t.toString(36)}_${counter}`,
      at: new Date(t).toISOString(),
      botId: String(input.botId || ""),
      routineId: String(input.routineId || ""),
      runId: String(input.runId || ""),
      taskId: String(input.taskId || ""),
      title,
      body: String(input.body || "").trim().slice(0, MAX_BODY),
      urgency: URGENCIES.includes(input.urgency) ? input.urgency : "normal",
      deepLink: {
        botId: String(input.botId || ""),
        routineId: String(input.routineId || ""),
        runId: String(input.runId || ""),
        taskId: String(input.taskId || ""),
        ...(input.deepLink && typeof input.deepLink === "object" ? input.deepLink : {}),
      },
      actions: Array.isArray(input.actions) ? input.actions.slice(0, 3) : [],
      read: false,
    };
    recent.unshift(record);
    if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;

    try {
      emitToRenderer({ ...record });
    } catch {
      /* the renderer may be gone; native still fires */
    }
    if (native && typeof native.isSupported === "function") {
      try {
        if (native.isSupported()) {
          const n = native.create({
            title: record.title,
            body: record.body,
            silent: record.urgency === "low",
          });
          n.on?.("click", () => {
            try {
              onOpen({ ...record.deepLink });
            } catch {
              /* navigation is best-effort */
            }
          });
          n.show?.();
        }
      } catch {
        /* native notification failures must never break a run */
      }
    }
    return { sent: true, id: record.id };
  }

  function listRecent({ limit = 30 } = {}) {
    return recent.slice(0, Math.max(1, limit)).map((r) => ({ ...r }));
  }

  function markRead(id) {
    const record = recent.find((r) => r.id === String(id || ""));
    if (record) record.read = true;
    return !!record;
  }

  return { notify, shouldNotify, listRecent, markRead };
}

module.exports = { createNotificationService, shouldNotify, DEDUPE_MS, MAX_RECENT };
