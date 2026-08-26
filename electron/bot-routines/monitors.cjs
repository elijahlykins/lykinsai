"use strict";

/**
 * Monitor runtime for Bot Routines — cheapest useful signal first, zero model
 * calls, ever.
 *
 * This module observes; it never interprets. Filesystem monitors use native
 * fs.watch (event-driven) with a bounded polling fallback; process monitors
 * poll pgrep at a bounded interval because process exit has no portable
 * event. Change detection is DETERMINISTIC — name sets, sizes, mtimes,
 * running/not-running — hashed into a fingerprint. When nothing changed,
 * nothing happens: no Task, no notification, no model call. Semantic
 * evaluation ("did something IMPORTANT change?") belongs to the Task a
 * trigger spawns, so the model runs only AFTER a meaningful change.
 *
 * Resource control:
 *   - max concurrent monitors (MAX_MONITORS)
 *   - watch events debounced (DEBOUNCE_MS) so an unzip of 100 files is one
 *     trigger, not 100
 *   - cooldown after each trigger (COOLDOWN_MS) so a hot signal cannot storm
 *   - exponential error backoff, capped, with the count persisted
 *   - polling never below MIN_POLL_MS
 *
 * Persisted monitor state is minimal (routineStore.setMonitorState):
 * fingerprint, a capped name list for "created" detection, condition state,
 * lastTriggeredAt / cooldownUntil, errorCount. Never file contents, page
 * bytes, or screenshots.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { matchesPattern } = require("./triggers.cjs");

const MAX_MONITORS = 20;
const DEBOUNCE_MS = 1000;
const COOLDOWN_MS = 60 * 1000;
const MIN_POLL_MS = 5 * 1000;
const FS_FALLBACK_POLL_MS = 30 * 1000;
const PROCESS_POLL_MS = 10 * 1000;
const ERROR_BACKOFF_BASE_MS = 15 * 1000;
const ERROR_BACKOFF_MAX_MS = 5 * 60 * 1000;
/** Above this many matching entries we keep only the fingerprint, not names. */
const MAX_TRACKED_NAMES = 2000;

function resolveUserPath(p) {
  let raw = String(p || "").trim();
  if (!raw) return "";
  if (raw === "~") raw = os.homedir();
  else if (raw.startsWith("~/")) raw = path.join(os.homedir(), raw.slice(2));
  if (!path.isAbsolute(raw)) raw = path.join(os.homedir(), raw);
  return path.resolve(raw);
}

function fingerprintOf(entries) {
  const canonical = entries
    .map((e) => `${e.name}\t${e.size}\t${e.mtimeMs}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha1").update(canonical).digest("hex");
}

/** Default: list entries in a watched dir that match the trigger pattern. */
async function defaultListMatches(trigger) {
  const dir = resolveUserPath(trigger.path);
  const stat = await fsp.stat(dir).catch(() => null);
  if (stat && stat.isFile()) {
    // Watching a single file: the entry is the file itself.
    return [{ name: path.basename(dir), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }];
  }
  if (!stat) return [];
  const names = await fsp.readdir(dir).catch(() => []);
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (!matchesPattern(name, trigger.pattern)) continue;
    const st = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!st || !st.isFile()) continue;
    out.push({ name, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    if (out.length >= 5000) break;
  }
  return out;
}

/** Default: native fs.watch on the dir (or the file's parent). */
function defaultWatchDir(watchPath, onEvent) {
  const target = resolveUserPath(watchPath);
  let dir = target;
  try {
    if (!fs.statSync(target).isDirectory()) dir = path.dirname(target);
  } catch {
    dir = path.dirname(target);
  }
  const watcher = fs.watch(dir, { persistent: false }, () => onEvent());
  return { close: () => watcher.close() };
}

/** Default: is a process whose command line matches `name` running? */
function defaultProcessRunning(name) {
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", String(name)], (error) => resolve(!error));
  });
}

/**
 * @param {object} opts
 * @param {object} opts.store routineStore
 * @param {(routine: object, info: {reason: string, context: object}) => void} opts.onTrigger
 * @param {() => number} [opts.now]
 * @param {object} [opts.deps] injectable observation primitives (tests)
 */
function createMonitorRuntime({
  store,
  onTrigger,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  deps = {},
} = {}) {
  if (!store) throw new TypeError("monitor runtime requires a routine store");
  if (typeof onTrigger !== "function") throw new TypeError("monitor runtime requires onTrigger");

  const listMatches = deps.listMatches || defaultListMatches;
  const watchDir = deps.watchDir || defaultWatchDir;
  const processRunning = deps.processRunning || defaultProcessRunning;
  const cooldownMs = Number.isFinite(deps.cooldownMs) ? deps.cooldownMs : COOLDOWN_MS;
  const debounceMs = Number.isFinite(deps.debounceMs) ? deps.debounceMs : DEBOUNCE_MS;
  const processPollMs = Math.max(MIN_POLL_MS, Number(deps.processPollMs) || PROCESS_POLL_MS);
  const fsFallbackPollMs = Math.max(MIN_POLL_MS, Number(deps.fsFallbackPollMs) || FS_FALLBACK_POLL_MS);

  /** @type {Map<string, {kind:string, close:() => void}>} routineId → active monitor */
  const active = new Map();

  function isMonitored(routine) {
    return (
      routine?.enabled === true &&
      (routine?.trigger?.type === "filesystem" || routine?.trigger?.type === "process")
    );
  }

  function inCooldown(routineId) {
    const state = store.getMonitorState(routineId);
    return Number(state?.cooldownUntil) > now();
  }

  function trigger(routine, reason, context) {
    if (inCooldown(routine.id)) return false;
    store.setMonitorState(routine.id, {
      lastTriggeredAt: now(),
      cooldownUntil: now() + cooldownMs,
    });
    try {
      onTrigger(routine, { reason, context });
    } catch {
      /* the monitor must survive a failing handler */
    }
    return true;
  }

  function noteError(routineId) {
    const state = store.getMonitorState(routineId) || {};
    const errorCount = (Number(state.errorCount) || 0) + 1;
    store.setMonitorState(routineId, { errorCount });
    return Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_BASE_MS * 2 ** Math.min(errorCount, 6));
  }

  function clearError(routineId) {
    const state = store.getMonitorState(routineId);
    if (state && Number(state.errorCount) > 0) store.setMonitorState(routineId, { errorCount: 0 });
  }

  // ── Filesystem ─────────────────────────────────────────────────────────────

  /**
   * Evaluate one filesystem observation deterministically. Exported (via
   * evaluateFilesystem below) so tests can drive it without real watchers.
   */
  async function evaluateFilesystemRoutine(routine) {
    const trig = routine.trigger;
    let entries;
    try {
      entries = await listMatches(trig);
    } catch {
      return { error: true };
    }
    const state = store.getMonitorState(routine.id) || {};
    const fingerprint = fingerprintOf(entries);
    const names = entries.map((e) => e.name);
    const observed = {
      lastObservedAt: now(),
      lastFingerprint: fingerprint,
      ...(names.length <= MAX_TRACKED_NAMES ? { knownNames: names } : { knownNames: null }),
    };

    if (state.lastFingerprint === undefined || state.lastFingerprint === null) {
      // First observation is a baseline, never a trigger — except "exists",
      // whose whole point is the current condition.
      store.setMonitorState(routine.id, observed);
      if (trig.event === "exists" && entries.length > 0) {
        return { fired: trigger(routine, "filesystem:exists", { path: trig.path, files: names.slice(0, 20) }) };
      }
      return { fired: false };
    }

    if (fingerprint === state.lastFingerprint) {
      store.setMonitorState(routine.id, { lastObservedAt: observed.lastObservedAt });
      return { fired: false, unchanged: true };
    }
    store.setMonitorState(routine.id, observed);

    if (trig.event === "created") {
      const known = new Set(Array.isArray(state.knownNames) ? state.knownNames : []);
      const created = Array.isArray(state.knownNames)
        ? names.filter((n) => !known.has(n))
        : names; // name list overflowed: any change reports the current set
      if (!created.length) return { fired: false };
      return {
        fired: trigger(routine, "filesystem:created", {
          path: trig.path,
          files: created.slice(0, 20),
        }),
      };
    }
    if (trig.event === "exists") {
      if (!entries.length) return { fired: false };
      return { fired: trigger(routine, "filesystem:exists", { path: trig.path, files: names.slice(0, 20) }) };
    }
    // "changed": any fingerprint difference counts.
    return {
      fired: trigger(routine, "filesystem:changed", { path: trig.path, files: names.slice(0, 20) }),
    };
  }

  function startFilesystemMonitor(routine) {
    let debounceTimer = null;
    let pollTimer = null;
    let closed = false;
    let watcher = null;

    const evaluate = async () => {
      if (closed) return;
      const result = await evaluateFilesystemRoutine(store.get(routine.id) || routine);
      if (result?.error) {
        const backoff = noteError(routine.id);
        schedulePoll(backoff);
      } else {
        clearError(routine.id);
      }
    };

    const onEvent = () => {
      if (closed || debounceTimer) return;
      debounceTimer = setTimeoutFn(() => {
        debounceTimer = null;
        void evaluate();
      }, debounceMs);
      debounceTimer?.unref?.();
    };

    function schedulePoll(delay) {
      if (closed || pollTimer) return;
      pollTimer = setTimeoutFn(() => {
        pollTimer = null;
        void evaluate().then(() => {
          if (!watcher) schedulePoll(fsFallbackPollMs); // polling mode: keep going
        });
      }, Math.max(MIN_POLL_MS, delay));
      pollTimer?.unref?.();
    }

    try {
      watcher = watchDir(routine.trigger.path, onEvent);
    } catch {
      watcher = null; // fs.watch unavailable (network volume, missing dir): poll
      schedulePoll(fsFallbackPollMs);
    }
    // Baseline observation immediately, so "unchanged" has a reference.
    void evaluate();

    return {
      kind: "filesystem",
      close: () => {
        closed = true;
        if (debounceTimer) clearTimeoutFn(debounceTimer);
        if (pollTimer) clearTimeoutFn(pollTimer);
        try {
          watcher?.close?.();
        } catch {
          /* already gone */
        }
      },
    };
  }

  // ── Process ────────────────────────────────────────────────────────────────

  async function evaluateProcessRoutine(routine) {
    const trig = routine.trigger;
    let running;
    try {
      running = await processRunning(trig.name);
    } catch {
      return { error: true };
    }
    const state = store.getMonitorState(routine.id) || {};
    const previous = state.lastConditionState;
    store.setMonitorState(routine.id, { lastObservedAt: now(), lastConditionState: running });
    if (previous === undefined || previous === null) return { fired: false }; // baseline
    if (previous === running) return { fired: false, unchanged: true };
    if (trig.event === "exited" && previous === true && running === false) {
      return { fired: trigger(routine, "process:exited", { name: trig.name }) };
    }
    if (trig.event === "started" && previous === false && running === true) {
      return { fired: trigger(routine, "process:started", { name: trig.name }) };
    }
    return { fired: false };
  }

  function startProcessMonitor(routine) {
    let timer = null;
    let closed = false;
    const tick = async () => {
      if (closed) return;
      const result = await evaluateProcessRoutine(store.get(routine.id) || routine);
      let delay = processPollMs;
      if (result?.error) delay = noteError(routine.id);
      else clearError(routine.id);
      if (closed) return;
      timer = setTimeoutFn(tick, delay);
      timer?.unref?.();
    };
    void tick();
    return {
      kind: "process",
      close: () => {
        closed = true;
        if (timer) clearTimeoutFn(timer);
      },
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start/stop the monitor for one routine to match its current definition. */
  function syncRoutine(routineId) {
    const id = String(routineId || "");
    const routine = store.get(id);
    const existing = active.get(id);
    if (existing) {
      existing.close();
      active.delete(id);
    }
    if (!isMonitored(routine)) return;
    if (active.size >= MAX_MONITORS) return; // bounded; surfaced via monitorCount
    const monitor =
      routine.trigger.type === "filesystem"
        ? startFilesystemMonitor(routine)
        : startProcessMonitor(routine);
    active.set(id, monitor);
  }

  function start() {
    for (const routine of store.list()) syncRoutine(routine.id);
  }

  function stop() {
    for (const [, monitor] of active) monitor.close();
    active.clear();
  }

  /**
   * Wake reconciliation: one bounded observation per active monitor, now.
   * Nothing simulated continuous monitoring while asleep — this is the honest
   * "look once, then resume the normal cadence".
   */
  async function reconcile() {
    for (const [routineId, monitor] of active) {
      const routine = store.get(routineId);
      if (!routine) continue;
      if (monitor.kind === "filesystem") await evaluateFilesystemRoutine(routine);
      else await evaluateProcessRoutine(routine);
    }
  }

  return {
    start,
    stop,
    syncRoutine,
    reconcile,
    monitorCount: () => active.size,
    // Exposed for tests: deterministic single evaluations.
    evaluateFilesystem: (routineId) => {
      const routine = store.get(routineId);
      return routine ? evaluateFilesystemRoutine(routine) : Promise.resolve({ error: true });
    },
    evaluateProcess: (routineId) => {
      const routine = store.get(routineId);
      return routine ? evaluateProcessRoutine(routine) : Promise.resolve({ error: true });
    },
  };
}

module.exports = {
  createMonitorRuntime,
  MAX_MONITORS,
  COOLDOWN_MS,
  DEBOUNCE_MS,
  MIN_POLL_MS,
};
