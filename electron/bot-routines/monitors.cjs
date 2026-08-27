"use strict";

/**
 * Monitor runtime for Bot Routines — cheapest useful signal first, zero model
 * calls, ever.
 *
 * This module observes; it never interprets. Filesystem monitors use native
 * fs.watch (event-driven) with a bounded polling fallback; process monitors
 * poll pgrep at a bounded interval because process exit has no portable
 * event; browser monitors take a compact AXI-style snapshot (no model call);
 * screen monitors fingerprint a targeted window (pixels only when native
 * state cannot answer). Change detection is DETERMINISTIC — name sets,
 * sizes, mtimes, running/not-running, compact DOM fingerprints, perceptual
 * image hashes. When nothing changed, nothing happens: no Task, no
 * notification, no model call. Semantic evaluation is reached only AFTER a
 * meaningful change that is not deterministically decidable.
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
 * lastTriggeredAt / cooldownUntil, errorCount, compact diagnostics.
 * Never file contents, page bytes, screenshots, OCR, or generation refs.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { matchesPattern, isMonitorTrigger } = require("./triggers.cjs");
const {
  evaluateBrowserCondition,
  urlsMatch,
  looksLoggedOut,
  titleMatches,
  isEphemeralRef,
} = require("./browserObservation.cjs");
const {
  evaluateNativeWindowState,
  evaluateScreenFingerprints,
  fingerprintNative,
} = require("./screenObservation.cjs");
const { createSemanticEvaluator } = require("./semanticEval.cjs");

const MAX_MONITORS = 20;
const DEBOUNCE_MS = 1000;
const COOLDOWN_MS = 60 * 1000;
const MIN_POLL_MS = 5 * 1000;
const FS_FALLBACK_POLL_MS = 30 * 1000;
const PROCESS_POLL_MS = 10 * 1000;
const BROWSER_POLL_MS = 10 * 1000;
const SCREEN_POLL_MS = 15 * 1000;
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
  onStatus: onStatusFn = null,
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
  const browserPollMs = Math.max(MIN_POLL_MS, Number(deps.browserPollMs) || BROWSER_POLL_MS);
  const screenPollMs = Math.max(MIN_POLL_MS, Number(deps.screenPollMs) || SCREEN_POLL_MS);
  const observeBrowser = deps.observeBrowser || null;
  const observeScreen = deps.observeScreen || null;
  const captureScreenForVision = deps.captureScreenForVision || null;
  const subscribePageEvents = deps.subscribePageEvents || null;
  const onStatus =
    typeof onStatusFn === "function"
      ? onStatusFn
      : typeof deps.onStatus === "function"
        ? deps.onStatus
        : () => {};
  const semantic = createSemanticEvaluator({
    callModel: deps.callModel || null,
    now,
    cooldownMs: Number.isFinite(deps.semanticCooldownMs) ? deps.semanticCooldownMs : cooldownMs,
  });

  /** @type {Map<string, {kind:string, close:() => void}>} routineId → active monitor */
  const active = new Map();

  function isMonitored(routine) {
    return routine?.enabled === true && isMonitorTrigger(routine?.trigger);
  }

  function bump(routineId, fields) {
    const state = store.getMonitorState(routineId) || {};
    const patch = { ...fields };
    for (const [key, amount] of Object.entries(fields)) {
      if (typeof amount === "number" && /^(pollTicks|observations|changesDetected|semanticEvaluations|visionCalls|tasksTriggered|modelCalls)$/.test(key)) {
        patch[key] = (Number(state[key]) || 0) + amount;
      }
    }
    store.setMonitorState(routineId, patch);
    return store.getMonitorState(routineId);
  }

  function setStatus(routine, status, { notify = false, summary = "" } = {}) {
    const prev = store.getMonitorState(routine.id)?.status;
    store.setMonitorState(routine.id, { status, ...(summary ? { lastStatusSummary: String(summary).slice(0, 200) } : {}) });
    if (notify && prev !== status) {
      const lastAt = Number(store.getMonitorState(routine.id)?.lastStatusNotifiedAt) || 0;
      if (now() - lastAt > cooldownMs) {
        store.setMonitorState(routine.id, { lastStatusNotifiedAt: now() });
        try {
          onStatus(routine, { status, summary, notify: true });
        } catch {
          /* status observers must not break the monitor */
        }
      }
    }
  }

  function pollDelayFor(trigger, fallback) {
    const requested = Number(trigger?.pollMs);
    return Math.max(MIN_POLL_MS, Number.isFinite(requested) && requested > 0 ? requested : fallback);
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

  function startPolledMonitor(routine, kind, evaluateFn, delayMs, { subscribe } = {}) {
    let timer = null;
    let closed = false;
    let inFlight = false;
    let events = null;
    const delay = pollDelayFor(routine.trigger, delayMs);
    const tick = async () => {
      if (closed || inFlight) return;
      inFlight = true;
      bump(routine.id, { pollTicks: 1 });
      let result;
      try {
        result = await evaluateFn(store.get(routine.id) || routine);
      } finally {
        inFlight = false;
      }
      let next = delay;
      if (result?.error) next = noteError(routine.id);
      else clearError(routine.id);
      if (closed) return;
      if (timer) clearTimeoutFn(timer);
      timer = setTimeoutFn(tick, next);
      timer?.unref?.();
    };
    if (typeof subscribe === "function") {
      try {
        events = subscribe(routine.trigger, () => {
          if (closed || inFlight) return;
          void tick();
        });
      } catch {
        events = null;
      }
    }
    void tick();
    return {
      kind,
      close: () => {
        closed = true;
        if (timer) clearTimeoutFn(timer);
        try {
          events?.close?.();
        } catch {
          /* already gone */
        }
      },
    };
  }

  // ── Browser ────────────────────────────────────────────────────────────────

  async function evaluateBrowserRoutine(routine) {
    if (typeof observeBrowser !== "function") {
      setStatus(routine, "waiting_for_target", { notify: false });
      return { error: true, status: "waiting_for_target" };
    }
    bump(routine.id, { observations: 1 });
    let obs;
    try {
      obs = await observeBrowser(routine.trigger);
    } catch {
      return { error: true };
    }
    if (obs && isEphemeralRef(routine.trigger?.target?.loc)) {
      return { error: true };
    }

    const trig = routine.trigger;
    const status = String(obs?.status || (obs?.ok === false ? "target_unavailable" : "ok"));
    const state = store.getMonitorState(routine.id) || {};

    if (status === "stale_ref" || status === "stale_ref_retry") {
      // Re-observe once with a fresh generation. A single stale ref is not a
      // monitor failure.
      try {
        obs = await observeBrowser(trig);
      } catch {
        return { error: true };
      }
    }

    const liveStatus = String(obs?.status || (obs?.ok === false ? "target_unavailable" : "ok"));
    if (liveStatus === "target_unavailable" || liveStatus === "waiting_for_target") {
      setStatus(routine, liveStatus, {
        notify: true,
        summary:
          liveStatus === "waiting_for_target"
            ? "Waiting for the watched page to be available."
            : "The watched page is not open.",
      });
      store.setMonitorState(routine.id, { lastObservedAt: now() });
      return { fired: false, status: liveStatus };
    }

    const liveUrl = String(obs?.url || "");
    if (trig.url || trig.origin) {
      if (!urlsMatch(liveUrl, trig.url, trig.origin)) {
        const loggedOut = looksLoggedOut(liveUrl, obs?.title, trig.origin);
        const nextStatus = loggedOut ? "needs_attention" : "navigated_away";
        setStatus(routine, nextStatus, {
          notify: true,
          summary: loggedOut
            ? "The watched page looks signed out. Open it and sign in — this monitor will not ask again until the page is back."
            : "The watched tab navigated somewhere else. This monitor will not follow a random replacement page.",
        });
        store.setMonitorState(routine.id, { lastObservedAt: now() });
        return { fired: false, status: nextStatus };
      }
    }
    if (trig.titlePattern && !titleMatches(obs?.title, trig.titlePattern)) {
      setStatus(routine, "navigated_away", {
        notify: true,
        summary: "The watched tab no longer matches the expected title.",
      });
      store.setMonitorState(routine.id, { lastObservedAt: now() });
      return { fired: false, status: "navigated_away" };
    }

    setStatus(routine, "watching");
    const fingerprint = String(obs?.fingerprint || "");
    const observed = {
      lastObservedAt: now(),
      lastFingerprint: fingerprint,
      lastValue: String(obs?.target?.text || obs?.target?.name || "").slice(0, 80),
      lastUrl: liveUrl.slice(0, 300),
      lastTitle: String(obs?.title || "").slice(0, 80),
      lastDisabled: obs?.target?.disabled === true,
      lastFound: obs?.target?.found === true,
    };

    if (!state.lastFingerprint) {
      store.setMonitorState(routine.id, observed);
      return { fired: false, baseline: true };
    }
    if (fingerprint && fingerprint === state.lastFingerprint) {
      store.setMonitorState(routine.id, { lastObservedAt: observed.lastObservedAt });
      return { fired: false, unchanged: true };
    }

    bump(routine.id, { changesDetected: 1 });
    store.setMonitorState(routine.id, observed);

    const previous = {
      fingerprint: state.lastFingerprint,
      value: state.lastValue,
      title: state.lastTitle,
      target: {
        found: state.lastFound === true,
        text: state.lastValue,
        name: state.lastValue,
        disabled: state.lastDisabled === true,
      },
    };
    const current = {
      fingerprint,
      value: observed.lastValue,
      title: observed.lastTitle,
      target: obs?.target || { found: false, text: observed.lastValue },
    };

    const verdict = evaluateBrowserCondition({
      previous,
      current,
      condition: trig.condition,
    });
    if (verdict.decidable === false) {
      bump(routine.id, { semanticEvaluations: 1, modelCalls: 1 });
      let evalResult;
      try {
        evalResult = await semantic.evaluateSemantic({
          routineId: routine.id,
          condition: trig.condition?.semanticPrompt || routine.instructions,
          observation: {
            url: liveUrl,
            title: observed.lastTitle,
            value: observed.lastValue,
            summary: `${verdict.from || ""} → ${verdict.to || ""}`.trim(),
          },
          previous: { value: state.lastValue },
        });
      } catch {
        return { fired: false, error: true };
      }
      if (!evalResult.matched) return { fired: false, semantic: true };
      const fired = trigger(routine, "browser:semantic", {
        url: liveUrl,
        title: observed.lastTitle,
        from: verdict.from,
        to: verdict.to,
        summary: evalResult.summary || `${verdict.from} → ${verdict.to}`,
      });
      if (fired) bump(routine.id, { tasksTriggered: 1 });
      return { fired, semantic: true };
    }
    if (!verdict.matched) return { fired: false };
    const fired = trigger(routine, `browser:${trig.condition?.event || "changed"}`, {
      url: liveUrl,
      title: observed.lastTitle,
      from: verdict.from,
      to: verdict.to,
      summary: verdict.summary,
    });
    if (fired) bump(routine.id, { tasksTriggered: 1 });
    return { fired };
  }

  function startBrowserMonitor(routine) {
    return startPolledMonitor(routine, "browser", evaluateBrowserRoutine, browserPollMs, {
      subscribe: subscribePageEvents,
    });
  }

  // ── Screen ─────────────────────────────────────────────────────────────────

  async function evaluateScreenRoutine(routine) {
    if (typeof observeScreen !== "function") {
      setStatus(routine, "waiting_for_target", { notify: false });
      return { error: true, status: "waiting_for_target" };
    }
    bump(routine.id, { observations: 1 });
    let obs;
    try {
      obs = await observeScreen(routine.trigger);
    } catch {
      return { error: true };
    }
    const state = store.getMonitorState(routine.id) || {};
    const native = {
      found: obs?.found === true,
      appName: obs?.appName || routine.trigger.appName || "",
      title: obs?.title || "",
      appRunning: obs?.appRunning !== false,
    };

    if (!native.found) {
      const status = native.appRunning === false ? "target_unavailable" : "waiting_for_target";
      setStatus(routine, status, {
        notify: true,
        summary:
          status === "waiting_for_target"
            ? "Waiting for the watched window."
            : "The watched app is not running.",
      });
      store.setMonitorState(routine.id, { lastObservedAt: now() });
      return { fired: false, status };
    }

    setStatus(routine, "watching");
    const nativeFp = fingerprintNative(native);
    const previousNative = {
      found: state.lastNativeFound === true,
      title: state.lastTitle || "",
      appName: state.lastAppName || "",
    };
    const nativeVerdict = evaluateNativeWindowState({
      previous: state.lastNativeFound === undefined ? null : previousNative,
      current: native,
      condition: routine.trigger.condition,
    });
    store.setMonitorState(routine.id, {
      lastObservedAt: now(),
      lastNativeFound: native.found,
      lastTitle: String(native.title).slice(0, 80),
      lastAppName: String(native.appName).slice(0, 80),
      lastNativeFingerprint: nativeFp,
    });

    if (nativeVerdict && nativeVerdict.decidable && nativeVerdict.matched) {
      bump(routine.id, { changesDetected: 1 });
      const fired = trigger(routine, "screen:native", {
        appName: native.appName,
        title: native.title,
        from: nativeVerdict.from,
        to: nativeVerdict.to,
        summary: nativeVerdict.summary,
      });
      if (fired) bump(routine.id, { tasksTriggered: 1 });
      return { fired, native: true };
    }

    const currentFp = String(obs?.fingerprint || "");
    if (!currentFp) {
      // Native state did not fire and there is no image fingerprint: treat as
      // baseline / unchanged. Never invent a vision call.
      if (!state.lastFingerprint) return { fired: false, baseline: true };
      return { fired: false, unchanged: true };
    }
    if (!state.lastFingerprint) {
      store.setMonitorState(routine.id, { lastFingerprint: currentFp });
      return { fired: false, baseline: true };
    }
    const diff = evaluateScreenFingerprints(state.lastFingerprint, currentFp);
    store.setMonitorState(routine.id, { lastFingerprint: currentFp });
    if (diff.unchanged || diff.baseline) return { fired: false, unchanged: true };
    bump(routine.id, { changesDetected: 1 });
    if (!diff.meaningful) return { fired: false, noisy: true };

    const needsSemantic = routine.trigger.semantic === true || !!routine.trigger.condition?.semantic;
    if (!needsSemantic) {
      const fired = trigger(routine, "screen:changed", {
        appName: native.appName,
        title: native.title,
        summary: "The watched window changed.",
      });
      if (fired) bump(routine.id, { tasksTriggered: 1 });
      return { fired };
    }

    if (typeof captureScreenForVision !== "function") {
      return { fired: false, semantic: true, skipped: "no_vision_seam" };
    }
    bump(routine.id, { semanticEvaluations: 1, visionCalls: 1, modelCalls: 1 });
    let imageUrl = "";
    try {
      const shot = await captureScreenForVision(routine.trigger);
      imageUrl = String(shot?.imageUrl || "");
    } catch {
      return { fired: false, error: true };
    }
    let evalResult;
    try {
      evalResult = await semantic.evaluateVision({
        routineId: routine.id,
        condition: routine.trigger.condition?.semantic || routine.instructions,
        imageUrl,
      });
    } finally {
      imageUrl = "";
    }
    if (!evalResult.matched) return { fired: false, semantic: true };
    const fired = trigger(routine, "screen:semantic", {
      appName: native.appName,
      title: native.title,
      summary: evalResult.summary || "The watched window matches the condition.",
    });
    if (fired) bump(routine.id, { tasksTriggered: 1 });
    return { fired, semantic: true };
  }

  function startScreenMonitor(routine) {
    return startPolledMonitor(routine, "screen", evaluateScreenRoutine, screenPollMs);
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
    if (!isMonitored(routine)) return { ok: true, watching: false };
    if (active.size >= MAX_MONITORS) {
      store.setMonitorState(id, {
        status: "capacity_reached",
        lastError: "monitor_capacity_reached",
        capacity: MAX_MONITORS,
      });
      return { ok: false, error: "monitor_capacity_reached", max: MAX_MONITORS };
    }
    store.setMonitorState(id, { status: "watching", lastError: null, capacity: MAX_MONITORS });
    let monitor;
    if (routine.trigger.type === "filesystem") monitor = startFilesystemMonitor(routine);
    else if (routine.trigger.type === "process") monitor = startProcessMonitor(routine);
    else if (routine.trigger.type === "browser") monitor = startBrowserMonitor(routine);
    else if (routine.trigger.type === "screen") monitor = startScreenMonitor(routine);
    else return { ok: true, watching: false };
    active.set(id, monitor);
    return { ok: true, watching: true };
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
      else if (monitor.kind === "process") await evaluateProcessRoutine(routine);
      else if (monitor.kind === "browser") await evaluateBrowserRoutine(routine);
      else if (monitor.kind === "screen") await evaluateScreenRoutine(routine);
    }
  }

  return {
    start,
    stop,
    syncRoutine,
    reconcile,
    monitorCount: () => active.size,
    isActive: (routineId) => active.has(String(routineId || "")),
    // Exposed for tests: deterministic single evaluations.
    evaluateFilesystem: (routineId) => {
      const routine = store.get(routineId);
      return routine ? evaluateFilesystemRoutine(routine) : Promise.resolve({ error: true });
    },
    evaluateProcess: (routineId) => {
      const routine = store.get(routineId);
      return routine ? evaluateProcessRoutine(routine) : Promise.resolve({ error: true });
    },
    evaluateBrowser: (routineId) => {
      const routine = store.get(routineId);
      return routine ? evaluateBrowserRoutine(routine) : Promise.resolve({ error: true });
    },
    evaluateScreen: (routineId) => {
      const routine = store.get(routineId);
      return routine ? evaluateScreenRoutine(routine) : Promise.resolve({ error: true });
    },
    semanticCounts: () => semantic.counts(),
  };
}

module.exports = {
  createMonitorRuntime,
  MAX_MONITORS,
  COOLDOWN_MS,
  DEBOUNCE_MS,
  MIN_POLL_MS,
  BROWSER_POLL_MS,
  SCREEN_POLL_MS,
};
