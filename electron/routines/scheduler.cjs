"use strict";

/**
 * The Routine scheduler — owns timers, never work.
 *
 * One instance schedules every enabled schedule-trigger Routine. When an
 * occurrence is due it: (1) writes the occurrence key + the NEXT occurrence
 * durably through the store, then (2) calls `onFire`. Persisting BEFORE
 * firing is the double-fire guard: after a crash mid-run the stored
 * `lastFiredOccurrence` shows this occurrence already fired, so a restart
 * arms the next one instead of repeating it.
 *
 * Sleep/wake honesty: when the machine sleeps, timers do not run — nothing
 * pretends otherwise. On wake (the host wires powerMonitor "resume" to
 * `reconcile`) and on a detected clock jump (heartbeat below, for platforms
 * where the resume event is unreliable), each routine's stored nextRunAt is
 * reconciled against the real clock with its missed-run policy
 * (schedule.cjs): recurring schedules record an honest "missed" run and arm
 * the next occurrence; one-time schedules run once, late.
 *
 * All timers and the clock are injectable so every behavior is testable
 * without waiting for wall time.
 */

const { nextOccurrence, reconcileSchedule } = require("./schedule.cjs");

/** Never sleep a JS timer longer than this; re-arm in chunks instead. */
const MAX_TIMER_CHUNK_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
/** A heartbeat gap larger than this means the process was suspended. */
const CLOCK_JUMP_THRESHOLD_MS = 3 * HEARTBEAT_MS;

/**
 * @param {object} opts
 * @param {object} opts.store routineStore
 * @param {(routine: object, info: {occurrence:number, late:boolean, reason:string}) => void} opts.onFire
 * @param {(routine: object, info: {occurrence:number}) => void} [opts.onMissed]
 * @param {() => number} [opts.now]
 * @param {Function} [opts.setTimeoutFn] / [opts.clearTimeoutFn] injectable timers
 * @param {boolean} [opts.heartbeat] default true; off in tests that drive reconcile directly
 */
function createScheduler({
  store,
  onFire,
  onMissed = () => {},
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  heartbeat = true,
} = {}) {
  if (!store) throw new TypeError("scheduler requires a routine store");
  if (typeof onFire !== "function") throw new TypeError("scheduler requires onFire");

  /** @type {Map<string, any>} routineId → timer handle */
  const timers = new Map();
  let heartbeatTimer = null;
  let lastHeartbeatAt = 0;
  let started = false;

  function clearTimer(routineId) {
    const handle = timers.get(routineId);
    if (handle) {
      clearTimeoutFn(handle);
      timers.delete(routineId);
    }
  }

  function isScheduled(routine) {
    return routine?.enabled === true && routine?.trigger?.type === "schedule";
  }

  /** Arm (or re-arm) the timer toward a routine's stored nextRunAt. */
  function arm(routineId) {
    clearTimer(routineId);
    const routine = store.get(routineId);
    if (!isScheduled(routine)) return;
    const dueAt = Number(routine.nextRunAt);
    if (!Number.isFinite(dueAt) || dueAt <= 0) return;
    const delay = Math.max(0, dueAt - now());
    const chunk = Math.min(delay, MAX_TIMER_CHUNK_MS);
    const handle = setTimeoutFn(() => {
      timers.delete(routineId);
      const current = store.get(routineId);
      if (!isScheduled(current)) return;
      if (now() < Number(current.nextRunAt)) {
        arm(routineId); // long-delay chunk elapsed; keep counting down
        return;
      }
      fire(current, { late: false, reason: "schedule" });
    }, chunk);
    handle?.unref?.();
    timers.set(routineId, handle);
  }

  /**
   * Fire one occurrence: durably record the occurrence + arm the next one,
   * THEN hand off to onFire. `occurrence` is the scheduled time it fired for.
   */
  function fire(routine, { late, reason, occurrence } = {}) {
    const occ = Number.isFinite(occurrence) ? occurrence : Number(routine.nextRunAt) || now();
    if (routine.lastFiredOccurrence === occ) return; // already fired for this slot
    const upcoming = nextOccurrence(routine.trigger.schedule, Math.max(now(), occ));
    store.setSchedulingState(routine.id, {
      lastFiredOccurrence: occ,
      nextRunAt: upcoming,
    });
    if (upcoming != null) arm(routine.id);
    try {
      onFire(store.get(routine.id) || routine, { occurrence: occ, late: !!late, reason: String(reason || "schedule") });
    } catch {
      /* the scheduler must survive a failing handler; the run record shows the failure */
    }
  }

  /**
   * Reconcile every schedule routine against the real clock. Called on start,
   * on wake, and on detected clock jumps. Applies each routine's missed-run
   * policy and re-arms timers from durable state.
   */
  function reconcile(cause = "start") {
    for (const routine of store.list()) {
      if (!isScheduled(routine)) {
        clearTimer(routine.id);
        continue;
      }
      const decision = reconcileSchedule(
        routine.trigger.schedule,
        routine.nextRunAt,
        now(),
        routine.trigger.missedRunPolicy,
      );
      if (decision.action === "keep") {
        if (routine.nextRunAt !== decision.nextRunAt) {
          store.setSchedulingState(routine.id, { nextRunAt: decision.nextRunAt });
        }
        arm(routine.id);
        continue;
      }
      if (decision.action === "fire_now") {
        // Guard against replaying an occurrence that already fired before the
        // restart — the durable lastFiredOccurrence is the authority.
        if (routine.lastFiredOccurrence === decision.missedOccurrence) {
          store.setSchedulingState(routine.id, { nextRunAt: decision.nextRunAt });
          arm(routine.id);
          continue;
        }
        store.setSchedulingState(routine.id, { nextRunAt: decision.nextRunAt });
        fire(store.get(routine.id), {
          late: true,
          reason: `missed_${cause}`,
          occurrence: decision.missedOccurrence,
        });
        continue;
      }
      if (decision.action === "missed") {
        if (routine.lastFiredOccurrence !== decision.missedOccurrence) {
          store.setSchedulingState(routine.id, {
            lastFiredOccurrence: decision.missedOccurrence,
            nextRunAt: decision.nextRunAt,
          });
          try {
            onMissed(store.get(routine.id), { occurrence: decision.missedOccurrence });
          } catch {
            /* history is best-effort */
          }
        } else {
          store.setSchedulingState(routine.id, { nextRunAt: decision.nextRunAt });
        }
        arm(routine.id);
        continue;
      }
      // "done": a spent one-time schedule keeps its definition but arms nothing.
      if (decision.missedOccurrence && routine.lastFiredOccurrence !== decision.missedOccurrence) {
        store.setSchedulingState(routine.id, {
          lastFiredOccurrence: decision.missedOccurrence,
          nextRunAt: null,
        });
        try {
          onMissed(store.get(routine.id), { occurrence: decision.missedOccurrence });
        } catch {
          /* history is best-effort */
        }
      } else if (routine.nextRunAt != null) {
        store.setSchedulingState(routine.id, { nextRunAt: null });
      }
      clearTimer(routine.id);
    }
  }

  /** Re-evaluate one routine after create/update/enable/disable/delete. */
  function syncRoutine(routineId) {
    const routine = store.get(routineId);
    if (!isScheduled(routine)) {
      clearTimer(String(routineId || ""));
      if (routine && routine.nextRunAt != null && (!routine.enabled || routine.trigger?.type !== "schedule")) {
        store.setSchedulingState(routine.id, { nextRunAt: null });
      }
      return;
    }
    if (!Number.isFinite(Number(routine.nextRunAt)) || Number(routine.nextRunAt) <= now()) {
      const upcoming = nextOccurrence(routine.trigger.schedule, now());
      store.setSchedulingState(routine.id, { nextRunAt: upcoming });
    }
    arm(routine.id);
  }

  function start() {
    if (started) return;
    started = true;
    reconcile("start");
    if (heartbeat) {
      lastHeartbeatAt = now();
      heartbeatTimer = setTimeoutFn(function beat() {
        const t = now();
        if (t - lastHeartbeatAt > CLOCK_JUMP_THRESHOLD_MS) {
          // The process was suspended without a resume event we saw.
          reconcile("wake");
        }
        lastHeartbeatAt = t;
        heartbeatTimer = setTimeoutFn(beat, HEARTBEAT_MS);
        heartbeatTimer?.unref?.();
      }, HEARTBEAT_MS);
      heartbeatTimer?.unref?.();
    }
  }

  function stop() {
    started = false;
    for (const routineId of [...timers.keys()]) clearTimer(routineId);
    if (heartbeatTimer) {
      clearTimeoutFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return {
    start,
    stop,
    reconcile,
    syncRoutine,
    armedCount: () => timers.size,
  };
}

module.exports = { createScheduler, MAX_TIMER_CHUNK_MS, HEARTBEAT_MS };
