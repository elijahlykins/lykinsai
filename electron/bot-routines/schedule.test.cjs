/**
 * Schedule math: the WHEN of every Bot Routine. What matters is that "every
 * weekday at 8" means the user's local 8 AM, that a spent one-time schedule
 * never fires again, and that the restart/wake reconcile applies the
 * missed-run policy honestly instead of replaying stale occurrences.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSchedule,
  nextOccurrence,
  reconcileSchedule,
  defaultMissedRunPolicy,
  describeSchedule,
  MIN_INTERVAL_MS,
} = require("./schedule.cjs");

/** A local-time ms timestamp for a known weekday: Wed 2026-01-07. */
function localMs(hour, minute = 0, dayOffset = 0) {
  return new Date(2026, 0, 7 + dayOffset, hour, minute, 0, 0).getTime();
}

test("daily fires later today when the time is still ahead", () => {
  const schedule = normalizeSchedule({ kind: "daily", time: "08:00" });
  const next = nextOccurrence(schedule, localMs(6, 30));
  assert.equal(next, localMs(8, 0));
});

test("daily rolls to tomorrow once today's slot has passed", () => {
  const schedule = normalizeSchedule({ kind: "daily", time: "08:00" });
  const next = nextOccurrence(schedule, localMs(9, 0));
  assert.equal(next, localMs(8, 0, 1));
});

test("a slot exactly now is not 'next' — strictly after", () => {
  const schedule = normalizeSchedule({ kind: "daily", time: "08:00" });
  const next = nextOccurrence(schedule, localMs(8, 0));
  assert.equal(next, localMs(8, 0, 1));
});

test("weekdays skips the weekend", () => {
  const schedule = normalizeSchedule({ kind: "weekdays", time: "09:00" });
  // From Friday 10:00 (Jan 9, 2026) the next weekday slot is Monday.
  const fridayAfter = localMs(10, 0, 2);
  const next = nextOccurrence(schedule, fridayAfter);
  assert.equal(new Date(next).getDay(), 1);
  assert.equal(next, localMs(9, 0, 5));
});

test("weekly picks the next listed day", () => {
  // Mondays (1) and Fridays (5) at 07:30, from Wednesday.
  const schedule = normalizeSchedule({ kind: "weekly", time: "07:30", days: [1, 5] });
  const next = nextOccurrence(schedule, localMs(12, 0));
  assert.equal(new Date(next).getDay(), 5);
  assert.equal(next, localMs(7, 30, 2));
});

test("once fires exactly once and then reports no future occurrence", () => {
  const at = localMs(15, 0);
  const schedule = normalizeSchedule({ kind: "once", at });
  assert.equal(nextOccurrence(schedule, at - 1000), at);
  assert.equal(nextOccurrence(schedule, at), null);
  assert.equal(nextOccurrence(schedule, at + 1000), null);
});

test("interval enforces the one-minute floor", () => {
  const schedule = normalizeSchedule({ kind: "interval", everyMs: 5 });
  assert.equal(schedule.everyMs, MIN_INTERVAL_MS);
  assert.equal(nextOccurrence(schedule, 1_000_000), 1_000_000 + MIN_INTERVAL_MS);
});

test("invalid specs fail at creation, not at 8 AM", () => {
  assert.throws(() => normalizeSchedule({ kind: "daily", time: "25:00" }), TypeError);
  assert.throws(() => normalizeSchedule({ kind: "weekly", time: "08:00", days: [] }), TypeError);
  assert.throws(() => normalizeSchedule({ kind: "once", at: "not-a-date" }), TypeError);
  assert.throws(() => normalizeSchedule({ kind: "hourly" }), TypeError);
  assert.throws(() => normalizeSchedule({ kind: "interval", everyMs: -5 }), TypeError);
});

test("missed recurring occurrence: default policy records it and arms the next", () => {
  const schedule = normalizeSchedule({ kind: "daily", time: "08:00" });
  assert.equal(defaultMissedRunPolicy(schedule), "skip");
  const missed = localMs(8, 0);
  const wokeAt = localMs(15, 0);
  const decision = reconcileSchedule(schedule, missed, wokeAt);
  assert.equal(decision.action, "missed");
  assert.equal(decision.missedOccurrence, missed);
  assert.equal(decision.nextRunAt, localMs(8, 0, 1));
});

test("missed one-time occurrence: default policy runs it late", () => {
  const at = localMs(8, 0);
  const schedule = normalizeSchedule({ kind: "once", at });
  assert.equal(defaultMissedRunPolicy(schedule), "run_once");
  const decision = reconcileSchedule(schedule, at, localMs(15, 0));
  assert.equal(decision.action, "fire_now");
  assert.equal(decision.missedOccurrence, at);
  assert.equal(decision.nextRunAt, null);
});

test("run_once policy on a recurring schedule fires late then resumes cadence", () => {
  const schedule = normalizeSchedule({ kind: "daily", time: "08:00" });
  const decision = reconcileSchedule(schedule, localMs(8, 0), localMs(15, 0), "run_once");
  assert.equal(decision.action, "fire_now");
  assert.equal(decision.nextRunAt, localMs(8, 0, 1));
});

test("a stored future occurrence is kept as-is", () => {
  const schedule = normalizeSchedule({ kind: "daily", time: "08:00" });
  const stored = localMs(8, 0, 1);
  const decision = reconcileSchedule(schedule, stored, localMs(15, 0));
  assert.equal(decision.action, "keep");
  assert.equal(decision.nextRunAt, stored);
});

test("a never-armed routine arms forward without recording a missed run", () => {
  const schedule = normalizeSchedule({ kind: "daily", time: "08:00" });
  const decision = reconcileSchedule(schedule, null, localMs(15, 0));
  assert.equal(decision.action, "keep");
  assert.equal(decision.missedOccurrence, undefined);
});

test("descriptions are human, not JSON", () => {
  assert.equal(describeSchedule(normalizeSchedule({ kind: "weekdays", time: "08:00" })), "Weekdays at 8:00");
  assert.equal(describeSchedule(normalizeSchedule({ kind: "interval", everyMs: 15 * 60 * 1000 })), "Every 15 min");
  assert.match(
    describeSchedule(normalizeSchedule({ kind: "weekly", time: "07:30", days: [1, 5] })),
    /Mon, Fri at 7:30/,
  );
});
