/**
 * The scheduler under a fake clock. What matters: an armed occurrence fires
 * exactly once (including across a simulated crash/restart), sleep produces
 * an honest missed record or an honest late run per policy, and pausing a
 * routine stops new occurrences without touching its definition.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRoutineStore } = require("./routineStore.cjs");
const { createScheduler } = require("./scheduler.cjs");

/** Deterministic clock + timer queue the tests advance by hand. */
function makeClock(startMs) {
  let now = startMs;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeoutFn: (fn, delay) => {
      const id = `t${(seq += 1)}`;
      timers.set(id, { fn, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    advanceTo(target) {
      // Run due timers in time order, allowing re-arms to land in the window.
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function localMs(hour, minute = 0, dayOffset = 0) {
  return new Date(2026, 0, 7 + dayOffset, hour, minute, 0, 0).getTime();
}

let dir;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-sched-"));
});

function makeWorld({ startAt = localMs(6, 0), fires = [], missed = [] } = {}) {
  const clock = makeClock(startAt);
  const store = createRoutineStore({ userDataPath: dir, now: clock.now });
  store.load();
  const scheduler = createScheduler({
    store,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    heartbeat: false,
    onFire: (routine, info) => fires.push({ routineId: routine.id, ...info }),
    onMissed: (routine, info) => missed.push({ routineId: routine.id, ...info }),
  });
  return { clock, store, scheduler, fires, missed };
}

function dailyRoutine(store, extra = {}) {
  return store.create({
    botId: "bot-1",
    bot: { id: "bot-1", name: "Scout" },
    instructions: "Morning check.",
    trigger: { type: "schedule", schedule: { kind: "daily", time: "08:00" } },
    ...extra,
  });
}

test("an armed daily routine fires at its local time, exactly once", () => {
  const world = makeWorld();
  const routine = dailyRoutine(world.store);
  world.scheduler.start();
  assert.equal(world.store.get(routine.id).nextRunAt, localMs(8, 0));

  world.clock.advanceTo(localMs(8, 0, 0) + 1000);
  assert.equal(world.fires.length, 1);
  assert.equal(world.fires[0].occurrence, localMs(8, 0));
  assert.equal(world.fires[0].late, false);
  // The next occurrence is armed for tomorrow.
  assert.equal(world.store.get(routine.id).nextRunAt, localMs(8, 0, 1));

  world.clock.advanceTo(localMs(8, 0, 1) + 1000);
  assert.equal(world.fires.length, 2);
});

test("restart mid-day: an occurrence that already fired is not replayed", () => {
  const world = makeWorld();
  const routine = dailyRoutine(world.store);
  world.scheduler.start();
  world.clock.advanceTo(localMs(9, 0));
  assert.equal(world.fires.length, 1);
  world.scheduler.stop();

  // Same store on disk state, fresh scheduler — the app restarted at 09:30.
  const fires2 = [];
  const scheduler2 = createScheduler({
    store: world.store,
    now: () => localMs(9, 30),
    setTimeoutFn: world.clock.setTimeoutFn,
    clearTimeoutFn: world.clock.clearTimeoutFn,
    heartbeat: false,
    onFire: (r, info) => fires2.push(info),
  });
  scheduler2.start();
  assert.equal(fires2.length, 0, "the 8:00 occurrence already fired before the restart");
  assert.equal(world.store.get(routine.id).nextRunAt, localMs(8, 0, 1));
});

test("sleeping through a recurring slot records an honest missed run (default skip)", () => {
  const world = makeWorld();
  const routine = dailyRoutine(world.store);
  world.scheduler.start();
  world.scheduler.stop(); // machine "sleeps": timers dead, clock moves on

  const fires2 = [];
  const missed2 = [];
  const scheduler2 = createScheduler({
    store: world.store,
    now: () => localMs(15, 0),
    setTimeoutFn: world.clock.setTimeoutFn,
    clearTimeoutFn: world.clock.clearTimeoutFn,
    heartbeat: false,
    onFire: (r, info) => fires2.push(info),
    onMissed: (r, info) => missed2.push(info),
  });
  scheduler2.reconcile("wake");
  assert.equal(fires2.length, 0);
  assert.equal(missed2.length, 1);
  assert.equal(missed2[0].occurrence, localMs(8, 0));
  assert.equal(world.store.get(routine.id).nextRunAt, localMs(8, 0, 1));
});

test("run_once policy runs the missed occurrence late on wake", () => {
  const world = makeWorld();
  dailyRoutine(world.store, {
    trigger: {
      type: "schedule",
      schedule: { kind: "daily", time: "08:00" },
      missedRunPolicy: "run_once",
    },
  });
  world.scheduler.start();
  world.scheduler.stop();

  const fires2 = [];
  const scheduler2 = createScheduler({
    store: world.store,
    now: () => localMs(15, 0),
    setTimeoutFn: world.clock.setTimeoutFn,
    clearTimeoutFn: world.clock.clearTimeoutFn,
    heartbeat: false,
    onFire: (r, info) => fires2.push(info),
  });
  scheduler2.reconcile("wake");
  assert.equal(fires2.length, 1);
  assert.equal(fires2[0].late, true);
  assert.equal(fires2[0].occurrence, localMs(8, 0));
});

test("a missed one-time schedule runs late by default and then retires", () => {
  const world = makeWorld();
  const routine = world.store.create({
    botId: "bot-1",
    bot: { id: "bot-1", name: "Scout" },
    instructions: "Send the reminder.",
    trigger: { type: "schedule", schedule: { kind: "once", at: localMs(8, 0) } },
  });
  world.scheduler.start();
  world.scheduler.stop();

  const fires2 = [];
  const scheduler2 = createScheduler({
    store: world.store,
    now: () => localMs(15, 0),
    setTimeoutFn: world.clock.setTimeoutFn,
    clearTimeoutFn: world.clock.clearTimeoutFn,
    heartbeat: false,
    onFire: (r, info) => fires2.push(info),
  });
  scheduler2.reconcile("wake");
  assert.equal(fires2.length, 1);
  assert.equal(fires2[0].late, true);
  assert.equal(world.store.get(routine.id).nextRunAt, null, "one-time schedules retire after firing");

  // A second reconcile must not fire again.
  scheduler2.reconcile("wake");
  assert.equal(fires2.length, 1);
});

test("pausing stops future occurrences; re-enabling arms forward", () => {
  const world = makeWorld();
  const routine = dailyRoutine(world.store);
  world.scheduler.start();

  world.store.setEnabled(routine.id, false);
  world.scheduler.syncRoutine(routine.id);
  world.clock.advanceTo(localMs(10, 0));
  assert.equal(world.fires.length, 0);

  world.store.setEnabled(routine.id, true);
  world.scheduler.syncRoutine(routine.id);
  assert.equal(world.store.get(routine.id).nextRunAt, localMs(8, 0, 1));
  world.clock.advanceTo(localMs(8, 0, 1) + 1000);
  assert.equal(world.fires.length, 1);
});

test("interval schedules re-arm from each firing", () => {
  const world = makeWorld({ startAt: 1_000_000_000 });
  world.store.create({
    botId: "bot-1",
    bot: { id: "bot-1", name: "Scout" },
    instructions: "Poll the queue.",
    trigger: { type: "schedule", schedule: { kind: "interval", everyMs: 15 * 60 * 1000 } },
  });
  world.scheduler.start();
  world.clock.advanceTo(1_000_000_000 + 46 * 60 * 1000);
  assert.equal(world.fires.length, 3);
});
