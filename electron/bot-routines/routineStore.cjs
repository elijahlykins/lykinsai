"use strict";

/**
 * Durable persistence for Bot Routines — definitions, run history, and
 * minimal monitor state.
 *
 * PERSISTENCE DECISION (documented per the Phase 4 brief): Bots themselves
 * live in renderer localStorage (`lykn_bots_v1`), which cannot fire anything
 * while no window is open. Routines therefore need a MAIN-process durable
 * source of truth. The two existing conventions are (a) JSON files in
 * userData (local-mode.json, overlay-agents.json) and (b) the SQLite
 * localStore, whose lifecycle is coupled to the Vault store being configured.
 * Routines are small structured records (definitions + bounded history), so
 * this store follows convention (a): one JSON file, atomic tmp+rename writes,
 * debounced persistence with an explicit persistNow for pre-fire checkpoints.
 * That is the simplest storage that survives restart, needs no migration
 * machinery, and has no coupling to Local Mode being enabled.
 *
 * What is durable:
 *   - Routine definitions (including a sanitized Bot identity snapshot, so a
 *     routine can run after restart before the renderer re-announces bots)
 *   - enabled state, scheduling info (nextRunAt, lastFiredOccurrence)
 *   - bounded run history (RoutineRun projections; the Task remains runtime
 *     authority and full Task event logs are NOT duplicated here)
 *   - minimal monitor state (fingerprint, cooldown, error count — never raw
 *     page contents or screenshots)
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeTrigger } = require("./triggers.cjs");

const STORE_FILE = "bot-routines.json";
const STORE_VERSION = 1;
const MAX_ROUTINES = 100;
const MAX_RUNS_PER_ROUTINE = 50;
const PERSIST_DEBOUNCE_MS = 500;

const NOTIFICATION_POLICIES = Object.freeze([
  "always",
  "on_success",
  "on_failure",
  "on_change",
  "silent",
]);
const CONCURRENCY_POLICIES = Object.freeze(["skip", "queue_one"]);
const APPROVAL_POLICIES = Object.freeze([
  "standing_authorization",
  "preserve_executor_security_gates",
]);

function newRoutineId() {
  return `routine_${crypto.randomBytes(10).toString("hex")}`;
}

function newRunId() {
  return `rrun_${crypto.randomBytes(10).toString("hex")}`;
}

function sanitizeBotSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const snapshot = {
    id: String(raw.id || "").trim().slice(0, 120),
    name: String(raw.name || "").trim().slice(0, 60),
    role: String(raw.role || "").trim().slice(0, 80),
    persona: String(raw.persona || "").trim().slice(0, 1200),
    face: String(raw.face || "").trim().slice(0, 60),
    eyes: String(raw.eyes || "").trim().slice(0, 60),
    color: String(raw.color || "").trim().slice(0, 60),
    chatId: String(raw.chatId || "").trim().slice(0, 160),
  };
  return snapshot.id || snapshot.name ? snapshot : null;
}

function cleanCapabilities(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((c) => String(c || "").trim()).filter(Boolean))].slice(
    0,
    20,
  );
}

function oneOf(value, allowed, fallback) {
  const v = String(value || "").trim();
  return allowed.includes(v) ? v : fallback;
}

/**
 * @param {object} opts
 * @param {string} opts.userDataPath
 * @param {() => number} [opts.now] injectable clock (ms)
 * @param {(routines: object[]) => void} [opts.onChange] fired after any mutation
 */
function createRoutineStore({ userDataPath, now = () => Date.now(), onChange = () => {} } = {}) {
  if (!userDataPath) throw new TypeError("routineStore requires userDataPath");
  const file = path.join(userDataPath, STORE_FILE);

  /** @type {Map<string, object>} routineId → routine */
  const routines = new Map();
  /** @type {Map<string, object[]>} routineId → runs, newest first */
  const runs = new Map();
  /** @type {Map<string, object>} routineId → monitor state */
  const monitors = new Map();

  let persistTimer = null;
  let persistChain = Promise.resolve();

  function load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { ok: true, loaded: 0 };
    }
    if (!raw || typeof raw !== "object") return { ok: true, loaded: 0 };
    for (const routine of Array.isArray(raw.routines) ? raw.routines : []) {
      if (!routine?.id) continue;
      try {
        // Re-normalize the trigger so a stale on-disk shape cannot smuggle an
        // invalid trigger into a running scheduler.
        routine.trigger = normalizeTrigger(routine.trigger);
      } catch {
        continue;
      }
      routines.set(routine.id, routine);
    }
    const storedRuns = raw.runs && typeof raw.runs === "object" ? raw.runs : {};
    for (const [routineId, list] of Object.entries(storedRuns)) {
      if (!routines.has(routineId)) continue;
      runs.set(
        routineId,
        (Array.isArray(list) ? list : []).filter((r) => r?.id).slice(0, MAX_RUNS_PER_ROUTINE),
      );
    }
    const storedMonitors = raw.monitors && typeof raw.monitors === "object" ? raw.monitors : {};
    for (const [routineId, state] of Object.entries(storedMonitors)) {
      if (!routines.has(routineId) || !state || typeof state !== "object") continue;
      monitors.set(routineId, state);
    }
    return { ok: true, loaded: routines.size };
  }

  function serialize() {
    return JSON.stringify(
      {
        v: STORE_VERSION,
        routines: [...routines.values()],
        runs: Object.fromEntries(runs),
        monitors: Object.fromEntries(monitors),
      },
      null,
      0,
    );
  }

  function persistNowSync() {
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, serialize(), "utf8");
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  function persistNow() {
    persistChain = persistChain.then(async () => {
      const tmp = `${file}.tmp`;
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(tmp, serialize(), "utf8");
        await fsp.rename(tmp, file);
      } catch {
        /* a failed write must never break the runtime; retried on next change */
      }
    });
    return persistChain;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, PERSIST_DEBOUNCE_MS);
    // Never keep the process alive just to flush a debounce.
    persistTimer.unref?.();
  }

  function changed({ immediate = false } = {}) {
    if (immediate) void persistNow();
    else schedulePersist();
    try {
      onChange(list());
    } catch {
      /* observers must not break the store */
    }
  }

  function list() {
    return [...routines.values()].map((r) => ({ ...r }));
  }

  function listForBot(botId) {
    const id = String(botId || "").trim();
    return list().filter((r) => r.botId === id);
  }

  function get(routineId) {
    const r = routines.get(String(routineId || ""));
    return r ? { ...r } : null;
  }

  /**
   * Create a Routine. The trigger is validated, the capability envelope and
   * policies are canonicalized, and the definition is durable before this
   * returns. Throws TypeError on an invalid definition.
   */
  function create(input = {}) {
    if (routines.size >= MAX_ROUTINES) throw new Error("routine_limit_reached");
    const botId = String(input.botId || input.bot?.id || "").trim();
    if (!botId) throw new TypeError("Routine requires a botId");
    const name = String(input.name || "").trim().slice(0, 80);
    const instructions = String(input.instructions || "").trim().slice(0, 4000);
    if (!instructions) throw new TypeError("Routine requires instructions");
    const trigger = normalizeTrigger(input.trigger);
    const at = new Date(now()).toISOString();
    const routine = {
      id: newRoutineId(),
      botId,
      bot: sanitizeBotSnapshot(input.bot) || { id: botId, name: "", role: "", persona: "" },
      name: name || instructions.slice(0, 60),
      instructions,
      trigger,
      capabilities: cleanCapabilities(input.capabilities),
      approvalPolicy: oneOf(input.approvalPolicy, APPROVAL_POLICIES, "standing_authorization"),
      notificationPolicy: oneOf(input.notificationPolicy, NOTIFICATION_POLICIES, "always"),
      concurrencyPolicy: oneOf(input.concurrencyPolicy, CONCURRENCY_POLICIES, "skip"),
      enabled: input.enabled !== false,
      createdAt: at,
      updatedAt: at,
      lastRunAt: null,
      nextRunAt: null,
      lastFiredOccurrence: null,
    };
    routines.set(routine.id, routine);
    changed({ immediate: true });
    return { ...routine };
  }

  /** Patch user-editable fields. Trigger changes are re-validated. */
  function update(routineId, patch = {}) {
    const routine = routines.get(String(routineId || ""));
    if (!routine) return null;
    if (patch.name !== undefined) routine.name = String(patch.name || "").trim().slice(0, 80) || routine.name;
    if (patch.instructions !== undefined) {
      const instructions = String(patch.instructions || "").trim().slice(0, 4000);
      if (instructions) routine.instructions = instructions;
    }
    if (patch.trigger !== undefined) {
      routine.trigger = normalizeTrigger(patch.trigger);
      // A different trigger invalidates armed occurrences and monitor state.
      routine.nextRunAt = null;
      routine.lastFiredOccurrence = null;
      monitors.delete(routine.id);
    }
    if (patch.capabilities !== undefined) routine.capabilities = cleanCapabilities(patch.capabilities);
    if (patch.notificationPolicy !== undefined) {
      routine.notificationPolicy = oneOf(patch.notificationPolicy, NOTIFICATION_POLICIES, routine.notificationPolicy);
    }
    if (patch.approvalPolicy !== undefined) {
      routine.approvalPolicy = oneOf(patch.approvalPolicy, APPROVAL_POLICIES, routine.approvalPolicy);
    }
    if (patch.concurrencyPolicy !== undefined) {
      routine.concurrencyPolicy = oneOf(patch.concurrencyPolicy, CONCURRENCY_POLICIES, routine.concurrencyPolicy);
    }
    if (patch.bot !== undefined) {
      const snapshot = sanitizeBotSnapshot(patch.bot);
      if (snapshot && snapshot.id === routine.botId) routine.bot = snapshot;
    }
    routine.updatedAt = new Date(now()).toISOString();
    changed({ immediate: true });
    return { ...routine };
  }

  function setEnabled(routineId, enabled) {
    const routine = routines.get(String(routineId || ""));
    if (!routine) return null;
    routine.enabled = !!enabled;
    if (!routine.enabled) routine.nextRunAt = null;
    routine.updatedAt = new Date(now()).toISOString();
    changed({ immediate: true });
    return { ...routine };
  }

  function remove(routineId) {
    const id = String(routineId || "");
    const existed = routines.delete(id);
    runs.delete(id);
    monitors.delete(id);
    if (existed) changed({ immediate: true });
    return existed;
  }

  /**
   * Scheduler-owned fields. Written through the store so arming state is
   * durable BEFORE an occurrence fires — the double-fire guard after a crash
   * is `lastFiredOccurrence` being on disk already.
   */
  function setSchedulingState(routineId, { nextRunAt, lastFiredOccurrence, lastRunAt } = {}) {
    const routine = routines.get(String(routineId || ""));
    if (!routine) return null;
    if (nextRunAt !== undefined) routine.nextRunAt = nextRunAt;
    if (lastFiredOccurrence !== undefined) routine.lastFiredOccurrence = lastFiredOccurrence;
    if (lastRunAt !== undefined) routine.lastRunAt = lastRunAt;
    changed({ immediate: true });
    return { ...routine };
  }

  // ── Run history (product projection; Task stays runtime authority) ────────

  function recordRun(routineId, input = {}) {
    const routine = routines.get(String(routineId || ""));
    if (!routine) return null;
    const run = {
      id: newRunId(),
      routineId: routine.id,
      taskId: String(input.taskId || ""),
      triggeredAt: input.triggeredAt || new Date(now()).toISOString(),
      triggerReason: String(input.triggerReason || "manual").slice(0, 200),
      startedAt: input.startedAt || null,
      completedAt: input.completedAt || null,
      status: String(input.status || "running"),
      resultSummary: String(input.resultSummary || "").slice(0, 2000),
      error: String(input.error || "").slice(0, 500),
      notificationStatus: String(input.notificationStatus || "none"),
      modelUsage: input.modelUsage || null,
    };
    const list = runs.get(routine.id) || [];
    list.unshift(run);
    if (list.length > MAX_RUNS_PER_ROUTINE) list.length = MAX_RUNS_PER_ROUTINE;
    runs.set(routine.id, list);
    routine.lastRunAt = run.triggeredAt;
    changed({ immediate: true });
    return { ...run };
  }

  function updateRun(routineId, runId, patch = {}) {
    const list = runs.get(String(routineId || ""));
    const run = list?.find((r) => r.id === String(runId || ""));
    if (!run) return null;
    if (patch.taskId !== undefined) run.taskId = String(patch.taskId || "");
    if (patch.status !== undefined) run.status = String(patch.status || run.status);
    if (patch.startedAt !== undefined) run.startedAt = patch.startedAt;
    if (patch.completedAt !== undefined) run.completedAt = patch.completedAt;
    if (patch.resultSummary !== undefined) run.resultSummary = String(patch.resultSummary || "").slice(0, 2000);
    if (patch.error !== undefined) run.error = String(patch.error || "").slice(0, 500);
    if (patch.notificationStatus !== undefined) run.notificationStatus = String(patch.notificationStatus || "none");
    if (patch.modelUsage !== undefined) run.modelUsage = patch.modelUsage;
    changed({ immediate: true });
    return { ...run };
  }

  function listRuns(routineId, { limit = MAX_RUNS_PER_ROUTINE } = {}) {
    const list = runs.get(String(routineId || "")) || [];
    return list.slice(0, Math.max(1, limit)).map((r) => ({ ...r }));
  }

  function listRecentRuns({ limit = 30 } = {}) {
    const all = [];
    for (const list of runs.values()) all.push(...list);
    all.sort((a, b) => String(b.triggeredAt).localeCompare(String(a.triggeredAt)));
    return all.slice(0, Math.max(1, limit)).map((r) => ({ ...r }));
  }

  // ── Monitor state (minimal, never raw content) ────────────────────────────

  function getMonitorState(routineId) {
    const state = monitors.get(String(routineId || ""));
    return state ? { ...state } : null;
  }

  function setMonitorState(routineId, patch = {}) {
    const id = String(routineId || "");
    if (!routines.has(id)) return null;
    const clean = { ...patch };
    for (const key of ["screenshot", "image", "imageUrl", "dataUrl", "ocr", "pageText", "catalog", "visibleText", "raw", "ref"]) {
      delete clean[key];
    }
    const state = { ...(monitors.get(id) || {}), ...clean };
    monitors.set(id, state);
    // Monitor state changes are frequent (every observation tick can update
    // lastObservedAt) — debounced persistence is enough; the fields that must
    // be durable pre-fire (lastTriggeredAt, cooldownUntil) ride the run
    // record's immediate persist.
    changed();
    return { ...state };
  }

  async function shutdown() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistNow();
  }

  return {
    file,
    load,
    list,
    listForBot,
    get,
    create,
    update,
    setEnabled,
    remove,
    setSchedulingState,
    recordRun,
    updateRun,
    listRuns,
    listRecentRuns,
    getMonitorState,
    setMonitorState,
    persistNow,
    persistNowSync,
    shutdown,
  };
}

module.exports = {
  createRoutineStore,
  sanitizeBotSnapshot,
  NOTIFICATION_POLICIES,
  CONCURRENCY_POLICIES,
  APPROVAL_POLICIES,
  MAX_RUNS_PER_ROUTINE,
  MAX_ROUTINES,
  STORE_FILE,
};
