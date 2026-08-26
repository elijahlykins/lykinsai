/**
 * The durable Routine store. What matters: a routine written today is still
 * there — trigger validated, history bounded — after the app restarts; and a
 * definition that could never fire is impossible to persist.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRoutineStore, MAX_RUNS_PER_ROUTINE } = require("./routineStore.cjs");

let dir;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-routines-"));
});

function makeStore() {
  const store = createRoutineStore({ userDataPath: dir });
  store.load();
  return store;
}

const BOT = { id: "bot-1", name: "Scout", persona: "Diligent research assistant." };

function sampleRoutine(store, extra = {}) {
  return store.create({
    botId: "bot-1",
    bot: BOT,
    name: "Morning pricing",
    instructions: "Check competitor pricing and summarize changes.",
    trigger: { type: "schedule", schedule: { kind: "weekdays", time: "08:00" } },
    capabilities: ["reply", "research_report"],
    ...extra,
  });
}

test("create → restart → the routine is still there, trigger intact", async () => {
  const store = makeStore();
  const routine = sampleRoutine(store);
  await store.persistNow();

  const reopened = makeStore();
  const loaded = reopened.get(routine.id);
  assert.ok(loaded);
  assert.equal(loaded.name, "Morning pricing");
  assert.equal(loaded.trigger.type, "schedule");
  assert.equal(loaded.trigger.schedule.kind, "weekdays");
  assert.equal(loaded.bot.persona, BOT.persona);
  assert.deepEqual(loaded.capabilities, ["reply", "research_report"]);
  assert.equal(loaded.enabled, true);
});

test("an invalid trigger cannot be persisted", () => {
  const store = makeStore();
  assert.throws(() => sampleRoutine(store, { trigger: { type: "telepathy" } }), TypeError);
  assert.throws(
    () => sampleRoutine(store, { trigger: { type: "filesystem" } }), // no path
    TypeError,
  );
  assert.throws(() => store.create({ botId: "bot-1", trigger: { type: "manual" } }), TypeError); // no instructions
  assert.equal(store.list().length, 0);
});

test("run history records honestly and stays bounded", () => {
  const store = makeStore();
  const routine = sampleRoutine(store);
  for (let i = 0; i < MAX_RUNS_PER_ROUTINE + 10; i += 1) {
    store.recordRun(routine.id, { status: "completed", triggerReason: "schedule" });
  }
  const runs = store.listRuns(routine.id, { limit: 1000 });
  assert.equal(runs.length, MAX_RUNS_PER_ROUTINE);

  const run = store.recordRun(routine.id, { status: "running", triggerReason: "manual" });
  store.updateRun(routine.id, run.id, { status: "failed", error: "boom" });
  const [latest] = store.listRuns(routine.id, { limit: 1 });
  assert.equal(latest.id, run.id);
  assert.equal(latest.status, "failed");
  assert.equal(latest.error, "boom");
});

test("scheduling state is durable — the crash-safe double-fire guard", async () => {
  const store = makeStore();
  const routine = sampleRoutine(store);
  store.setSchedulingState(routine.id, { lastFiredOccurrence: 12345, nextRunAt: 99999 });
  await store.persistNow();

  const reopened = makeStore();
  const loaded = reopened.get(routine.id);
  assert.equal(loaded.lastFiredOccurrence, 12345);
  assert.equal(loaded.nextRunAt, 99999);
});

test("monitor state stores fingerprints, never content, and survives restart", async () => {
  const store = makeStore();
  const routine = sampleRoutine(store, {
    trigger: { type: "filesystem", path: "~/Downloads", event: "created", pattern: "*.pdf" },
  });
  store.setMonitorState(routine.id, {
    lastFingerprint: "abc123",
    knownNames: ["a.pdf"],
    cooldownUntil: 555,
  });
  await store.persistNow();

  const reopened = makeStore();
  const state = reopened.getMonitorState(routine.id);
  assert.equal(state.lastFingerprint, "abc123");
  assert.deepEqual(state.knownNames, ["a.pdf"]);
  assert.equal(state.cooldownUntil, 555);
});

test("changing the trigger resets armed occurrences and monitor state", () => {
  const store = makeStore();
  const routine = sampleRoutine(store);
  store.setSchedulingState(routine.id, { nextRunAt: 42, lastFiredOccurrence: 41 });
  store.setMonitorState(routine.id, { lastFingerprint: "old" });

  store.update(routine.id, {
    trigger: { type: "filesystem", path: "~/Desktop", event: "changed" },
  });
  const updated = store.get(routine.id);
  assert.equal(updated.nextRunAt, null);
  assert.equal(updated.lastFiredOccurrence, null);
  assert.equal(store.getMonitorState(routine.id), null);
});

test("disable clears the armed occurrence; delete removes everything", () => {
  const store = makeStore();
  const routine = sampleRoutine(store);
  store.setSchedulingState(routine.id, { nextRunAt: 42 });
  store.setEnabled(routine.id, false);
  assert.equal(store.get(routine.id).nextRunAt, null);
  assert.equal(store.get(routine.id).enabled, false);

  store.recordRun(routine.id, { status: "completed" });
  assert.equal(store.remove(routine.id), true);
  assert.equal(store.get(routine.id), null);
  assert.deepEqual(store.listRuns(routine.id), []);
});

test("listForBot scopes by owner", () => {
  const store = makeStore();
  sampleRoutine(store);
  store.create({
    botId: "bot-2",
    bot: { id: "bot-2", name: "Fixer" },
    instructions: "Watch the tests.",
    trigger: { type: "manual" },
  });
  assert.equal(store.listForBot("bot-1").length, 1);
  assert.equal(store.listForBot("bot-2").length, 1);
  assert.equal(store.list().length, 2);
});

test("a browser trigger survives restart without ephemeral refs", async () => {
  const store = makeStore();
  const routine = store.create({
    botId: "bot-1",
    bot: BOT,
    name: "Price watch",
    instructions: "Tell me when the price changes.",
    trigger: {
      type: "browser",
      url: "https://shop.test/sku/1",
      target: { kind: "role", role: "status", name: "Price" },
      condition: { event: "changed" },
      notifyOnly: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(routine.trigger), /g\d+:/);
  await store.persistNow();
  const reopened = makeStore();
  const loaded = reopened.get(routine.id);
  assert.equal(loaded.trigger.type, "browser");
  assert.equal(loaded.trigger.url, "https://shop.test/sku/1");
  assert.equal(loaded.trigger.target.role, "status");
  assert.doesNotMatch(JSON.stringify(loaded), /g\d+:/);
});
