"use strict";

/**
 * Schedule math for Bot Routines — pure functions over millisecond clocks.
 *
 * A schedule describes WHEN a Routine's next occurrence is due; it never
 * executes anything. The scheduler (scheduler.cjs) owns timers and firing,
 * the runtime (routineRuntime.cjs) owns turning an occurrence into a
 * canonical Task. Keeping the math pure means every timezone / DST /
 * missed-run behavior is unit-testable with a fake clock.
 *
 * Times are LOCAL times: "every weekday at 8" means 8 AM on the user's
 * machine, computed through the system Date so DST shifts follow the OS.
 *
 * Kinds:
 *   once      — { at }               one occurrence at an absolute time
 *   daily     — { time }             every day at HH:MM local
 *   weekdays  — { time }             Mon–Fri at HH:MM local
 *   weekly    — { time, days }       listed weekdays (0=Sun … 6=Sat) at HH:MM
 *   interval  — { everyMs }          every N ms, minimum 1 minute
 *
 * Missed-run policy (applied by the scheduler on restart / wake):
 *   "skip"     — record the missed occurrence honestly, arm the next one.
 *                Default for recurring schedules: a "check dashboards at 8"
 *                routine firing at 3 PM because the laptop just woke is more
 *                surprising than an honest "missed" entry in the history.
 *   "run_once" — run one late occurrence immediately, then resume the normal
 *                cadence. Default for one-time schedules: the user asked for
 *                this exact run, late is better than never.
 */

const MIN_INTERVAL_MS = 60 * 1000;
const SCHEDULE_KINDS = Object.freeze(["once", "daily", "weekdays", "weekly", "interval"]);
const WEEKDAY_DAYS = Object.freeze([1, 2, 3, 4, 5]);
const DAY_NAMES = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

/** "08:00" / "8:5" → { hour, minute } or null. */
function parseTimeOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Absolute time input (ISO string or ms number) → ms, or NaN. */
function parseAbsoluteTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Validate + canonicalize a schedule spec. Throws TypeError on a spec that
 * cannot describe a real occurrence, so a bad Routine fails at creation, not
 * silently at 8 AM.
 */
function normalizeSchedule(spec) {
  const input = spec && typeof spec === "object" ? spec : {};
  const kind = String(input.kind || "").trim();
  if (!SCHEDULE_KINDS.includes(kind)) {
    throw new TypeError(`Unknown schedule kind: ${kind || "(none)"}`);
  }
  if (kind === "once") {
    const at = parseAbsoluteTime(input.at);
    if (!Number.isFinite(at)) throw new TypeError("Schedule kind 'once' requires a valid 'at' time");
    return Object.freeze({ kind, at });
  }
  if (kind === "interval") {
    const everyMs = Math.floor(Number(input.everyMs));
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new TypeError("Schedule kind 'interval' requires a positive 'everyMs'");
    }
    return Object.freeze({ kind, everyMs: Math.max(MIN_INTERVAL_MS, everyMs) });
  }
  const time = parseTimeOfDay(input.time);
  if (!time) throw new TypeError(`Schedule kind '${kind}' requires 'time' as HH:MM`);
  if (kind === "weekly") {
    const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    if (!days.length) throw new TypeError("Schedule kind 'weekly' requires at least one day (0–6)");
    return Object.freeze({ kind, time: `${time.hour}:${String(time.minute).padStart(2, "0")}`, days });
  }
  return Object.freeze({ kind, time: `${time.hour}:${String(time.minute).padStart(2, "0")}` });
}

function daysFor(schedule) {
  if (schedule.kind === "daily") return [0, 1, 2, 3, 4, 5, 6];
  if (schedule.kind === "weekdays") return WEEKDAY_DAYS;
  return schedule.days;
}

/**
 * The next occurrence strictly after `afterMs`, or null when the schedule has
 * no future occurrence (a 'once' already past).
 */
function nextOccurrence(schedule, afterMs) {
  const after = Number(afterMs);
  if (!Number.isFinite(after)) throw new TypeError("nextOccurrence requires a numeric clock");
  if (schedule.kind === "once") {
    return schedule.at > after ? schedule.at : null;
  }
  if (schedule.kind === "interval") {
    return after + schedule.everyMs;
  }
  const { hour, minute } = parseTimeOfDay(schedule.time);
  const days = new Set(daysFor(schedule));
  // Walk day by day from `after`; 8 iterations always reaches the next listed
  // weekday, and constructing each candidate through local Date keeps DST
  // handling with the OS instead of hand-rolled offset math.
  const cursor = new Date(after);
  for (let i = 0; i <= 7; i += 1) {
    const candidate = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + i,
      hour,
      minute,
      0,
      0,
    );
    if (candidate.getTime() > after && days.has(candidate.getDay())) {
      return candidate.getTime();
    }
  }
  return null;
}

/** Default missed-run policy per kind (see module header). */
function defaultMissedRunPolicy(schedule) {
  return schedule.kind === "once" ? "run_once" : "skip";
}

/**
 * Reconcile a stored nextRunAt against the current clock (restart / wake).
 *
 * Returns { action, nextRunAt } where action is:
 *   "keep"     — stored occurrence is still in the future; keep it armed
 *   "fire_now" — the occurrence was missed and policy runs it late
 *   "missed"   — the occurrence was missed and policy skips it (record it)
 *   "done"     — no future occurrence exists (a spent 'once')
 */
function reconcileSchedule(schedule, storedNextRunAt, nowMs, missedRunPolicy) {
  const policy = missedRunPolicy || defaultMissedRunPolicy(schedule);
  const stored = Number(storedNextRunAt);
  if (Number.isFinite(stored) && stored > nowMs) {
    return { action: "keep", nextRunAt: stored };
  }
  const upcoming = nextOccurrence(schedule, nowMs);
  if (!Number.isFinite(stored) || stored <= 0) {
    // Never armed (new routine, or corrupted state): arm forward, no missed run.
    return upcoming == null ? { action: "done", nextRunAt: null } : { action: "keep", nextRunAt: upcoming };
  }
  if (policy === "run_once") {
    return { action: "fire_now", nextRunAt: upcoming, missedOccurrence: stored };
  }
  return upcoming == null
    ? { action: "done", nextRunAt: null, missedOccurrence: stored }
    : { action: "missed", nextRunAt: upcoming, missedOccurrence: stored };
}

/** Human-readable one-liner for the UI ("Weekdays at 8:00", "Every 15 min"). */
function describeSchedule(schedule) {
  if (schedule.kind === "once") return `Once at ${new Date(schedule.at).toLocaleString()}`;
  if (schedule.kind === "interval") {
    const minutes = Math.round(schedule.everyMs / 60000);
    if (minutes < 60) return `Every ${minutes} min`;
    const hours = minutes / 60;
    return `Every ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  }
  if (schedule.kind === "daily") return `Daily at ${schedule.time}`;
  if (schedule.kind === "weekdays") return `Weekdays at ${schedule.time}`;
  const names = schedule.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${names} at ${schedule.time}`;
}

module.exports = {
  MIN_INTERVAL_MS,
  SCHEDULE_KINDS,
  normalizeSchedule,
  nextOccurrence,
  defaultMissedRunPolicy,
  reconcileSchedule,
  describeSchedule,
  parseTimeOfDay,
};
