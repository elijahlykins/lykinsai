/**
 * The orchestrator: trigger → RoutineRun → ONE canonical Task through the
 * injected execution seam. What matters: every occurrence is a fresh task
 * under the owning Bot, concurrency policies stop trigger storms, pause
 * means no new work, outcomes land in history, and notification policies are
 * honored — including the "needs you" ping for blocked unattended runs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRoutineRuntime } = require("./routineRuntime.cjs");

let dir;
const openWorlds = [];
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-rrt-"));
});
test.afterEach(async () => {
  while (openWorlds.length) await openWorlds.pop().runtime.shutdown();
});

const BOT = { id: "bot-1", name: "Scout", persona: "Diligent researcher." };

function makeWorld({ executeTask } = {}) {
  const executions = [];
  const emitted = [];
  let resolveGate = null;
  const world = {
    executions,
    emitted,
    entries: [],
    openGate: () => resolveGate?.(),
  };
  const runtime = createRoutineRuntime({
    userDataPath: dir,
    heartbeat: false,
    // No real watchers or process polls in tests — evaluation is not under
    // test here; the trigger→run→task seam is.
    monitorDeps: {
      watchDir: () => ({ close: () => {} }),
      listMatches: async () => world.entries || [],
      processRunning: async () => false,
    },
    emit: (channel, payload) => emitted.push({ channel, payload }),
    executeTask:
      executeTask ||
      (async (args) => {
        executions.push(args);
        args.onTaskCreated?.(`task_${executions.length}`);
        return { taskId: `task_${executions.length}`, status: "completed", output: "All good." };
      }),
  });
  runtime.start();
  world.runtime = runtime;
  openWorlds.push(world);
  return world;
}

function manualRoutine(runtime, extra = {}) {
  return runtime.createRoutine({
    botId: BOT.id,
    bot: BOT,
    name: "Pricing check",
    instructions: "Check competitor pricing and summarize changes.",
    trigger: { type: "manual" },
    ...extra,
  });
}

test("run-now spawns one task and records the run's outcome", async () => {
  const world = makeWorld();
  const routine = manualRoutine(world.runtime);
  const result = await world.runtime.runNow(routine.id);

  assert.equal(result.ok, true);
  assert.equal(world.executions.length, 1);
  assert.equal(world.executions[0].routine.id, routine.id);
  assert.equal(world.executions[0].triggerContext.reason, "manual");

  const [run] = world.runtime.listRuns(routine.id);
  assert.equal(run.status, "completed");
  assert.equal(run.taskId, "task_1");
  assert.equal(run.resultSummary, "All good.");
  assert.equal(run.notificationStatus, "sent");
});

test("default concurrency SKIP: a storm cannot fan out into parallel tasks", async () => {
  let inFlight = 0;
  let peak = 0;
  const world = makeWorld({
    executeTask: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return { taskId: "t", status: "completed", output: "ok" };
    },
  });
  const routine = manualRoutine(world.runtime);
  const results = await Promise.all([
    world.runtime.runNow(routine.id),
    world.runtime.runNow(routine.id),
    world.runtime.runNow(routine.id),
  ]);
  assert.equal(peak, 1);
  assert.equal(results.filter((r) => r.skipped).length, 2);
  const runs = world.runtime.listRuns(routine.id);
  assert.equal(runs.filter((r) => r.status === "skipped").length, 2);
  assert.equal(runs.filter((r) => r.status === "completed").length, 1);
});

test("queue_one: exactly one occurrence waits, extra ones coalesce", async () => {
  const gates = [];
  const world = makeWorld({
    executeTask: async () => {
      await new Promise((resolve) => gates.push(resolve));
      return { taskId: "t", status: "completed", output: "ok" };
    },
  });
  const routine = manualRoutine(world.runtime, { concurrencyPolicy: "queue_one" });
  const first = world.runtime.runNow(routine.id);
  const second = await world.runtime.runNow(routine.id);
  const third = await world.runtime.runNow(routine.id);
  assert.equal(second.queued, true);
  assert.equal(third.queued, true);

  gates.shift()(); // finish the active run → the single queued one starts
  await first;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gates.length, 1, "only ONE queued occurrence started");
  gates.shift()();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const completed = world.runtime.listRuns(routine.id).filter((r) => r.status === "completed");
  assert.equal(completed.length, 2);
});

test("a disabled routine refuses trigger occurrences (manual run-now still works)", async () => {
  const world = makeWorld();
  const routine = manualRoutine(world.runtime);
  world.runtime.setEnabled(routine.id, false);

  // Manual is the user's explicit hand — allowed on a paused routine.
  const manual = await world.runtime.runNow(routine.id);
  assert.equal(manual.ok, true);
  assert.equal(world.executions.length, 1);
});

test("failed runs record the error and notify at high urgency", async () => {
  const world = makeWorld({
    executeTask: async () => ({ taskId: "t9", status: "failed", error: "network down", output: "" }),
  });
  const routine = manualRoutine(world.runtime);
  await world.runtime.runNow(routine.id);

  const [run] = world.runtime.listRuns(routine.id);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "network down");
  const note = world.emitted.find((e) => e.channel === "lykn:activity-notification");
  assert.ok(note);
  assert.match(note.payload.title, /failed/);
  assert.equal(note.payload.urgency, "high");
});

test("on_failure policy stays silent on success and speaks on failure", async () => {
  let outcome = { taskId: "t", status: "completed", output: "fine" };
  const world = makeWorld({ executeTask: async () => outcome });
  const routine = manualRoutine(world.runtime, { notificationPolicy: "on_failure" });

  await world.runtime.runNow(routine.id);
  assert.equal(
    world.emitted.filter((e) => e.channel === "lykn:activity-notification").length,
    0,
    "success under on_failure is silent",
  );
  const [successRun] = world.runtime.listRuns(routine.id);
  assert.equal(successRun.notificationStatus, "suppressed");

  outcome = { taskId: "t", status: "failed", error: "boom", output: "" };
  await world.runtime.runNow(routine.id);
  assert.equal(world.emitted.filter((e) => e.channel === "lykn:activity-notification").length, 1);
});

test("a run blocked on the user notifies urgently even under on_success", async () => {
  const world = makeWorld({
    executeTask: async () => ({
      taskId: "t",
      status: "waiting_for_approval",
      output: "I need approval to push the fix.",
    }),
  });
  const routine = manualRoutine(world.runtime, { notificationPolicy: "on_success" });
  await world.runtime.runNow(routine.id);
  const note = world.emitted.find((e) => e.channel === "lykn:activity-notification");
  assert.ok(note, "blocked unattended runs must reach the user");
  assert.match(note.payload.title, /needs you/);
  assert.equal(note.payload.urgency, "high");
});

test("natural-language creation: schedule phrasing becomes a validated trigger", () => {
  const world = makeWorld();
  const result = world.runtime.createRoutineFromInstruction(
    "Every weekday at 8am, check competitor pricing and summarize any changes.",
    { bot: BOT },
  );
  assert.equal(result.ok, true);
  assert.equal(result.routine.trigger.type, "schedule");
  assert.equal(result.routine.trigger.schedule.kind, "weekdays");
  assert.equal(result.routine.trigger.schedule.time, "8:00");
  assert.ok(result.routine.capabilities.includes("research_report"));
  assert.match(result.routine.instructions, /competitor pricing/);
});

test("natural-language creation: watch-folder phrasing becomes a filesystem trigger", () => {
  const world = makeWorld();
  const result = world.runtime.createRoutineFromInstruction(
    "When a new PDF appears in my Downloads folder, summarize it into the vault.",
    { bot: BOT },
  );
  assert.equal(result.ok, true);
  assert.equal(result.routine.trigger.type, "filesystem");
  assert.equal(result.routine.trigger.path, "~/Downloads");
  assert.equal(result.routine.trigger.pattern, "*.pdf");
  assert.ok(result.routine.capabilities.includes("files.read"));
});

test("ambiguous natural language refuses instead of guessing a trigger", () => {
  const world = makeWorld();
  const result = world.runtime.createRoutineFromInstruction("keep an eye on things for me", {
    bot: BOT,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could_not_parse_trigger/);
  assert.equal(world.runtime.listRoutines({}).length, 0);
});

test("monitored external content cannot expand what the task may do", async () => {
  const world = makeWorld();
  const routine = world.runtime.createRoutine({
    botId: BOT.id,
    bot: BOT,
    name: "PDF watch",
    instructions: "Summarize new PDFs.",
    trigger: { type: "filesystem", path: "~/Downloads", event: "created", pattern: "*.pdf" },
    capabilities: ["reply", "files.read"],
  });
  // A hostile file name that reads like an instruction reaches the execution
  // seam as DATA (trigger context), while the capability envelope and
  // instructions come from the durable definition only.
  await world.runtime.runNow(routine.id);
  const call = world.executions[0];
  assert.deepEqual(call.routine.capabilities, ["reply", "files.read"]);
  assert.equal(call.routine.instructions, "Summarize new PDFs.");
});

test("a hostile page observation cannot expand capabilities or rewrite the objective", async () => {
  const world = makeWorld();
  const routine = world.runtime.createRoutine({
    botId: BOT.id,
    bot: BOT,
    name: "Deployment monitor",
    instructions: "Watch this deployment. If it fails, inspect it.",
    trigger: {
      type: "browser",
      url: "https://render.com/deploy/123",
      condition: { event: "equals", value: "Failed" },
      target: { kind: "text", text: "Failed" },
    },
    capabilities: ["reply", "browser.read", "browser.interact"],
  });
  await world.runtime.runNow(routine.id);
  const call = world.executions[0];
  assert.deepEqual(call.routine.capabilities, ["reply", "browser.read", "browser.interact"]);
  assert.equal(call.routine.instructions, "Watch this deployment. If it fails, inspect it.");
  assert.ok(!call.routine.capabilities.includes("local.shell.execute"));
});

test("browser monitor watching vs running is projected separately", async () => {
  const world = makeWorld();
  const routine = world.runtime.createRoutine({
    botId: BOT.id,
    bot: BOT,
    name: "Deployment status",
    instructions: "Tell me when the status changes.",
    trigger: {
      type: "browser",
      url: "https://render.com/deploy/123",
      condition: { event: "changed" },
      notifyOnly: true,
    },
  });
  const listed = world.runtime.listRoutines({})[0];
  assert.equal(listed.watching, true);
  assert.equal(listed.running, false);
  assert.match(listed.watchingTarget, /render\.com/);
  const run = world.runtime.runNow(routine.id);
  const during = world.runtime.listRoutines({})[0];
  assert.equal(during.running, true);
  await run;
  const after = world.runtime.listRoutines({})[0];
  assert.equal(after.running, false);
});

test("natural-language browser creation binds the current tab", () => {
  const world = makeWorld();
  const result = world.runtime.createRoutineFromInstruction(
    "Watch this page and tell me when the status changes from Building.",
    { bot: BOT, browserContext: { url: "https://render.com/deploy/123", title: "Deploy" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.routine.trigger.type, "browser");
  assert.equal(result.routine.trigger.url, "https://render.com/deploy/123");
  assert.equal(result.routine.watching, true);
  assert.ok(result.routine.capabilities.includes("browser.read"));
});

test("routine definitions survive a runtime restart with history intact", async () => {
  const world = makeWorld();
  const routine = manualRoutine(world.runtime);
  await world.runtime.runNow(routine.id);
  await world.runtime.shutdown();

  const world2 = makeWorld();
  const loaded = world2.runtime.listRoutines({ botId: BOT.id });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, routine.id);
  assert.equal(world2.runtime.listRuns(routine.id).length, 1);
  await world2.runtime.shutdown();
});

test("notify-only monitor trigger does not present as a running Task", async () => {
  const world = makeWorld();
  const routine = world.runtime.createRoutine({
    botId: BOT.id,
    bot: BOT,
    name: "Downloads ping",
    instructions: "Tell me when a new PDF appears.",
    trigger: {
      type: "filesystem",
      path: "~/Downloads",
      event: "created",
      pattern: "*.pdf",
      notifyOnly: true,
    },
  });
  world.entries = [{ name: "old.pdf", size: 10, mtimeMs: 1 }];
  await world.runtime.evaluateFilesystem(routine.id);
  world.entries = [
    { name: "old.pdf", size: 10, mtimeMs: 1 },
    { name: "new.pdf", size: 20, mtimeMs: 2 },
  ];
  await world.runtime.evaluateFilesystem(routine.id);
  assert.equal(world.executions.length, 0);
  const listed = world.runtime.listRoutines({})[0];
  assert.equal(listed.running, false);
  assert.equal(listed.watching, true);
});
