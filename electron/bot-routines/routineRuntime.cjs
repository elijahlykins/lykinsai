"use strict";

/**
 * Routine runtime — the orchestrator that owns the store, the scheduler, the
 * monitor runtime, and the notification service, and turns a firing trigger
 * into ONE fresh canonical Task per occurrence.
 *
 * The boundary that matters: NO work executes here. When a trigger fires,
 * this module records a RoutineRun (the product/history projection), then
 * hands { routine, runId, triggerContext } to the injected `executeTask`,
 * which the host wires to compileRoutineTask → TaskRuntime.execute →
 * BotExecutor (electron/agentRuntime.cjs runRoutineOccurrence). TaskRuntime
 * remains the sole execution authority; the RoutineRun only references the
 * Task it spawned.
 *
 * Concurrency (per routine, while its previous Task still runs):
 *   "skip"      — default: the occurrence is recorded as skipped, no Task.
 *   "queue_one" — at most ONE occurrence waits and starts when the active
 *                 run finishes; further occurrences collapse into it.
 * Either way a trigger storm cannot fan out into N concurrent Tasks.
 *
 * Pause semantics (explicit product policy): disabling a Routine prevents
 * NEW occurrences immediately; an already-running Task keeps running unless
 * the user stops it — stopping work someone may be watching mid-flight is
 * more surprising than letting it finish.
 */

const { createRoutineStore } = require("./routineStore.cjs");
const { createScheduler } = require("./scheduler.cjs");
const { createMonitorRuntime } = require("./monitors.cjs");
const { createNotificationService } = require("./notificationService.cjs");
const { compileRoutineCapabilities, resolveRoutineSpec } = require("./nlRoutine.cjs");
const { describeTrigger } = require("./triggers.cjs");

/**
 * @param {object} opts
 * @param {string} opts.userDataPath
 * @param {(args: {routine: object, runId: string, triggerContext: object}) =>
 *   Promise<{taskId?: string, status: string, output?: string, error?: string, usage?: object}>}
 *   opts.executeTask host execution seam (TaskRuntime authority lives there)
 * @param {(channel: string, payload: object) => void} [opts.emit] renderer push
 * @param {object} [opts.native] Electron Notification adapter for the service
 * @param {(deepLink: object) => void} [opts.onOpenNotification]
 * @param {() => number} [opts.now]
 * @param {object} [opts.monitorDeps] injectable observation primitives (tests)
 * @param {boolean} [opts.heartbeat]
 */
function createRoutineRuntime({
  userDataPath,
  executeTask,
  emit = () => {},
  native = null,
  onOpenNotification = () => {},
  now = () => Date.now(),
  monitorDeps = {},
  heartbeat = true,
  store: injectedStore = null,
} = {}) {
  if (typeof executeTask !== "function") throw new TypeError("routineRuntime requires executeTask");

  const store =
    injectedStore ||
    createRoutineStore({
      userDataPath,
      now,
      onChange: (routines) => emit("lykn:routines-changed", { routines: routines.map(publicRoutine) }),
    });

  const notifications = createNotificationService({
    native,
    now,
    emitToRenderer: (record) => emit("lykn:activity-notification", record),
    onOpen: onOpenNotification,
  });

  /** @type {Map<string, {runId: string, taskId: string}>} routineId → active run */
  const activeRuns = new Map();
  /** @type {Map<string, {triggerContext: object}>} routineId → queued occurrence */
  const queued = new Map();

  function publicRoutine(routine) {
    if (!routine) return null;
    return {
      ...routine,
      triggerLabel: describeTrigger(routine.trigger),
      running: activeRuns.has(routine.id),
    };
  }

  // ── Occurrence → RoutineRun → canonical Task ───────────────────────────────

  async function startOccurrence(routine, triggerContext = {}) {
    const current = store.get(routine.id);
    if (!current) return { ok: false, error: "routine_gone" };
    const manual = triggerContext.reason === "manual";
    if (!current.enabled && !manual) return { ok: false, error: "routine_disabled" };

    if (activeRuns.has(current.id)) {
      if (current.concurrencyPolicy === "queue_one") {
        // Newer occurrence replaces the older queued one (coalesce); the run
        // record is created when it actually starts.
        queued.set(current.id, { triggerContext });
        return { ok: true, queued: true };
      }
      store.recordRun(current.id, {
        status: "skipped",
        triggerReason: String(triggerContext.reason || "trigger"),
        resultSummary: "Skipped: the previous run of this routine was still working.",
      });
      return { ok: true, skipped: true };
    }

    const run = store.recordRun(current.id, {
      status: "running",
      startedAt: new Date(now()).toISOString(),
      triggerReason: String(triggerContext.reason || "trigger"),
    });
    activeRuns.set(current.id, { runId: run.id, taskId: "" });
    emit("lykn:routines-changed", { routines: store.list().map(publicRoutine) });

    let outcome;
    try {
      outcome = await executeTask({
        routine: current,
        runId: run.id,
        triggerContext,
        onTaskCreated: (taskId) => {
          const active = activeRuns.get(current.id);
          if (active) active.taskId = String(taskId || "");
          store.updateRun(current.id, run.id, { taskId });
        },
      });
    } catch (e) {
      outcome = { status: "failed", error: e?.message || String(e) };
    }
    activeRuns.delete(current.id);

    const status = String(outcome?.status || "failed");
    const summary = String(outcome?.output || "").trim();
    store.updateRun(current.id, run.id, {
      taskId: outcome?.taskId || undefined,
      status,
      completedAt: new Date(now()).toISOString(),
      resultSummary: summary.slice(0, 2000),
      error: String(outcome?.error || ""),
      modelUsage: outcome?.usage || undefined,
    });

    notifyOutcome(current, run.id, outcome, triggerContext);
    emit("lykn:routines-changed", { routines: store.list().map(publicRoutine) });

    // A queued occurrence starts only now, so QUEUE_ONE can never overlap.
    const next = queued.get(current.id);
    if (next) {
      queued.delete(current.id);
      void startOccurrence(store.get(current.id) || current, next.triggerContext);
    }
    return { ok: true, runId: run.id, taskId: outcome?.taskId || "", status };
  }

  function notifyOutcome(routine, runId, outcome, triggerContext) {
    const status = String(outcome?.status || "failed");
    const waiting = status === "waiting_for_user" || status === "waiting_for_approval";
    const botName = routine.bot?.name || "Bot";
    // A monitor occurrence IS the change: policy on_change means "tell me
    // when the condition fires", which is exactly this notification.
    const changed = triggerContext?.reason ? triggerContext.reason !== "manual" && routine.trigger?.type !== "schedule" : false;

    let result;
    if (waiting) {
      // A blocked unattended run is useless until the user acts — this
      // bypasses success/failure policies (silent still wins).
      result =
        routine.notificationPolicy === "silent"
          ? { sent: false, suppressed: "policy" }
          : notifications.notify({
              botId: routine.botId,
              routineId: routine.id,
              runId,
              taskId: outcome?.taskId || "",
              title: `${botName} needs you: ${routine.name}`,
              body: String(outcome?.output || "The routine is waiting for your input or approval.").slice(0, 240),
              urgency: "high",
            });
    } else {
      const failed = status === "failed" || status === "cancelled";
      result = notifications.notify({
        botId: routine.botId,
        routineId: routine.id,
        runId,
        taskId: outcome?.taskId || "",
        policy: routine.notificationPolicy,
        outcome: { status, changed },
        title: failed ? `${botName}: ${routine.name} failed` : `${botName}: ${routine.name}`,
        body: String(outcome?.output || outcome?.error || (failed ? "The run did not complete." : "Done.")),
        urgency: failed ? "high" : "normal",
      });
    }
    store.updateRun(routine.id, runId, {
      notificationStatus: result.sent ? "sent" : result.suppressed === "policy" ? "suppressed" : "none",
    });
  }

  // ── Trigger sources ────────────────────────────────────────────────────────

  const scheduler = createScheduler({
    store,
    now,
    heartbeat,
    onFire: (routine, { occurrence, late, reason }) => {
      void startOccurrence(routine, {
        reason: reason === "schedule" ? "schedule" : reason,
        occurredAt: new Date(occurrence).toISOString(),
        late,
      });
    },
    onMissed: (routine, { occurrence }) => {
      store.recordRun(routine.id, {
        status: "missed",
        triggerReason: "missed_schedule",
        resultSummary: `Missed the ${new Date(occurrence).toLocaleString()} occurrence (the machine was off or asleep).`,
        notificationStatus: "suppressed",
      });
    },
  });

  const monitors = createMonitorRuntime({
    store,
    now,
    deps: monitorDeps,
    onTrigger: (routine, { reason, context }) => {
      void startOccurrence(routine, {
        reason,
        occurredAt: new Date(now()).toISOString(),
        path: context?.path,
        files: context?.files,
        processName: context?.name,
      });
    },
  });

  function syncRoutine(routineId) {
    scheduler.syncRoutine(routineId);
    monitors.syncRoutine(routineId);
  }

  // ── Public API (IPC-facing) ────────────────────────────────────────────────

  function createRoutine(input = {}) {
    const trigger = input.trigger;
    const capabilities = compileRoutineCapabilities(input.instructions, trigger, {
      explicit: input.capabilities,
    });
    const routine = store.create({ ...input, capabilities });
    syncRoutine(routine.id);
    return publicRoutine(store.get(routine.id));
  }

  /**
   * Natural-language creation ("every weekday at 8 check competitor pricing").
   * Deterministic; returns { ok:false, error } when the trigger is ambiguous
   * so the Bot can ask instead of guessing.
   */
  function createRoutineFromInstruction(instruction, { bot, botId, notificationPolicy } = {}) {
    const resolved = resolveRoutineSpec(instruction);
    if (!resolved.ok) return resolved;
    const spec = resolved.spec;
    try {
      const routine = createRoutine({
        botId: botId || bot?.id,
        bot,
        name: spec.name,
        instructions: spec.instructions || String(instruction || "").trim(),
        trigger: spec.trigger,
        capabilities: spec.capabilities,
        notificationPolicy: spec.notificationPolicy || notificationPolicy,
        concurrencyPolicy: spec.concurrencyPolicy,
      });
      return { ok: true, routine };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  function updateRoutine(routineId, patch) {
    const routine = store.update(routineId, patch);
    if (routine) syncRoutine(routine.id);
    return publicRoutine(routine);
  }

  function setEnabled(routineId, enabled) {
    const routine = store.setEnabled(routineId, enabled);
    if (routine) syncRoutine(routine.id);
    return publicRoutine(routine);
  }

  function removeRoutine(routineId) {
    const removed = store.remove(routineId);
    if (removed) syncRoutine(routineId);
    queued.delete(String(routineId || ""));
    return removed;
  }

  function runNow(routineId) {
    const routine = store.get(routineId);
    if (!routine) return Promise.resolve({ ok: false, error: "not_found" });
    return startOccurrence(routine, {
      reason: "manual",
      occurredAt: new Date(now()).toISOString(),
    });
  }

  function listRoutines({ botId } = {}) {
    const routines = botId ? store.listForBot(botId) : store.list();
    return routines.map(publicRoutine);
  }

  function activeRunFor(routineId) {
    const active = activeRuns.get(String(routineId || ""));
    return active ? { ...active } : null;
  }

  function start() {
    store.load();
    scheduler.start();
    monitors.start();
  }

  /** Sleep/wake and clock-jump reconciliation, wired by the host. */
  function reconcile(cause = "wake") {
    scheduler.reconcile(cause);
    void monitors.reconcile();
  }

  async function shutdown() {
    scheduler.stop();
    monitors.stop();
    await store.shutdown();
  }

  return {
    store,
    notifications,
    createRoutine,
    createRoutineFromInstruction,
    updateRoutine,
    setEnabled,
    removeRoutine,
    runNow,
    listRoutines,
    listRuns: (routineId, opts) => store.listRuns(routineId, opts),
    listRecentRuns: (opts) => store.listRecentRuns(opts),
    activeRunFor,
    start,
    reconcile,
    shutdown,
    monitorCount: () => monitors.monitorCount(),
  };
}

module.exports = { createRoutineRuntime };
