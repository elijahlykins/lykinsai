/**
 * Monitors under injected observation primitives. What matters: "no change"
 * means NOTHING happens (no trigger, and — structurally — no model call,
 * since monitors have no model at all); a real change triggers once with the
 * facts; cooldowns stop storms; errors back off instead of hot-looping.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRoutineStore } = require("./routineStore.cjs");
const { createMonitorRuntime } = require("./monitors.cjs");

let dir;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-mon-"));
});

function makeWorld({ entries = [], processUp = false } = {}) {
  const state = { entries: [...entries], processUp, listCalls: 0, processCalls: 0, failList: false };
  const triggers = [];
  let nowMs = 1_000_000_000;
  const store = createRoutineStore({ userDataPath: dir, now: () => nowMs });
  store.load();
  const monitors = createMonitorRuntime({
    store,
    now: () => nowMs,
    onTrigger: (routine, info) => triggers.push({ routineId: routine.id, ...info }),
    deps: {
      listMatches: async () => {
        state.listCalls += 1;
        if (state.failList) throw new Error("EPERM");
        return [...state.entries];
      },
      processRunning: async () => {
        state.processCalls += 1;
        return state.processUp;
      },
      // No real watchers in tests: evaluations are driven by hand.
      watchDir: () => ({ close: () => {} }),
      cooldownMs: 60 * 1000,
    },
  });
  return {
    state,
    triggers,
    store,
    monitors,
    tick: (ms) => {
      nowMs += ms;
    },
  };
}

function fsRoutine(store, extra = {}) {
  return store.create({
    botId: "bot-1",
    bot: { id: "bot-1", name: "Scout" },
    instructions: "Summarize new PDFs.",
    trigger: { type: "filesystem", path: "~/Downloads", event: "created", pattern: "*.pdf" },
    ...extra,
  });
}

test("first observation is a baseline, not a trigger", async () => {
  const world = makeWorld({ entries: [{ name: "old.pdf", size: 10, mtimeMs: 1 }] });
  const routine = fsRoutine(world.store);
  const result = await world.monitors.evaluateFilesystem(routine.id);
  assert.equal(result.fired, false);
  assert.equal(world.triggers.length, 0);
});

test("nothing changed → nothing happens, at zero interpretation cost", async () => {
  const world = makeWorld({ entries: [{ name: "old.pdf", size: 10, mtimeMs: 1 }] });
  const routine = fsRoutine(world.store);
  await world.monitors.evaluateFilesystem(routine.id);
  for (let i = 0; i < 5; i += 1) {
    const result = await world.monitors.evaluateFilesystem(routine.id);
    assert.equal(result.unchanged, true);
  }
  assert.equal(world.triggers.length, 0);
});

test("a new matching file triggers once, with the file named", async () => {
  const world = makeWorld({ entries: [{ name: "old.pdf", size: 10, mtimeMs: 1 }] });
  const routine = fsRoutine(world.store);
  await world.monitors.evaluateFilesystem(routine.id);

  world.state.entries.push({ name: "invoice.pdf", size: 55, mtimeMs: 2 });
  const result = await world.monitors.evaluateFilesystem(routine.id);
  assert.equal(result.fired, true);
  assert.equal(world.triggers.length, 1);
  assert.equal(world.triggers[0].reason, "filesystem:created");
  assert.deepEqual(world.triggers[0].context.files, ["invoice.pdf"]);
});

test("cooldown suppresses a hot signal; it recovers after the window", async () => {
  const world = makeWorld({ entries: [] });
  const routine = fsRoutine(world.store);
  await world.monitors.evaluateFilesystem(routine.id);

  world.state.entries.push({ name: "a.pdf", size: 1, mtimeMs: 1 });
  await world.monitors.evaluateFilesystem(routine.id);
  world.state.entries.push({ name: "b.pdf", size: 2, mtimeMs: 2 });
  await world.monitors.evaluateFilesystem(routine.id);
  assert.equal(world.triggers.length, 1, "second change inside the cooldown stays quiet");

  world.tick(61 * 1000);
  world.state.entries.push({ name: "c.pdf", size: 3, mtimeMs: 3 });
  await world.monitors.evaluateFilesystem(routine.id);
  assert.equal(world.triggers.length, 2);
  assert.deepEqual(world.triggers[1].context.files, ["c.pdf"]);
});

test("'changed' event fires on any fingerprint difference", async () => {
  const world = makeWorld({ entries: [{ name: "report.csv", size: 10, mtimeMs: 1 }] });
  const routine = fsRoutine(world.store, {
    trigger: { type: "filesystem", path: "~/data", event: "changed", pattern: "*.csv" },
  });
  await world.monitors.evaluateFilesystem(routine.id);
  world.state.entries[0] = { name: "report.csv", size: 12, mtimeMs: 9 };
  const result = await world.monitors.evaluateFilesystem(routine.id);
  assert.equal(result.fired, true);
  assert.equal(world.triggers[0].reason, "filesystem:changed");
});

test("observation errors back off and are counted, never thrown", async () => {
  const world = makeWorld({ entries: [] });
  const routine = fsRoutine(world.store);
  world.state.failList = true;
  const result = await world.monitors.evaluateFilesystem(routine.id);
  assert.equal(result.error, true);
  assert.equal(world.triggers.length, 0);
});

test("process exit fires only on the running → gone transition", async () => {
  const world = makeWorld({ processUp: true });
  const routine = world.store.create({
    botId: "bot-1",
    bot: { id: "bot-1", name: "Scout" },
    instructions: "Report the build result.",
    trigger: { type: "process", name: "npm run build", event: "exited" },
  });
  // Baseline: running.
  assert.equal((await world.monitors.evaluateProcess(routine.id)).fired, false);
  // Still running: nothing.
  assert.equal((await world.monitors.evaluateProcess(routine.id)).unchanged, true);
  // Exited: fires once.
  world.state.processUp = false;
  assert.equal((await world.monitors.evaluateProcess(routine.id)).fired, true);
  assert.equal(world.triggers[0].reason, "process:exited");
  // Stays gone: no re-fire.
  assert.equal((await world.monitors.evaluateProcess(routine.id)).unchanged, true);
  assert.equal(world.triggers.length, 1);
});

test("syncRoutine starts and stops monitors with enabled state", async () => {
  const world = makeWorld({ entries: [] });
  const routine = fsRoutine(world.store);
  world.monitors.syncRoutine(routine.id);
  assert.equal(world.monitors.monitorCount(), 1);

  world.store.setEnabled(routine.id, false);
  world.monitors.syncRoutine(routine.id);
  assert.equal(world.monitors.monitorCount(), 0);

  world.monitors.stop();
});
