/**
 * Task persistence and resume.
 *
 * Long-running task state used to be memory-only: an app restart lost the plan
 * position, facts, and history, and the user started over. The loop now hands
 * a restart-safe snapshot to `onTaskState` after planning, every recorded
 * action, and finish — and accepts one back as `resumeTask`, skipping the
 * planner and re-reading the live page before acting.
 *
 * Run: node --test electron/browser-agent/resume.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const taskState = require("./runtime/taskState.cjs");
const { nextGeneration } = require("./browser/snapshot.cjs");
const { runBrowserAgentTask, createBrowserController } = require("./index.cjs");

/**
 * Refs are generation-scoped ("g{generation}:{uid}") and the generation
 * counter is process-global, so a test may never write one down in advance —
 * the only honest source is the decision prompt the loop built, where each
 * element line reads `[g7:12] role "label"`.
 */
function refFor(ctx, uid) {
  const m = String(ctx?.user || "").match(new RegExp(`\\[(g\\d+:${uid})\\]`));
  assert.ok(m, `no element with uid ${uid} in the decision prompt`);
  return m[1];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-resume-"));

// ── serialize / restore ─────────────────────────────────────────────────────

test("a serialized task restores with its plan, facts and history intact", () => {
  const task = taskState.createTask({ goal: "book the flight" });
  taskState.setPlan(task, {
    plan: ["Find the flight", "Fill the form", "Reach checkout"],
    constraints: ["budget $400"],
    knownFacts: { origin: "SLC" },
    skills: ["scheduling"],
  });
  taskState.markStepDone(task);
  taskState.addFact(task, "the Tuesday flight is $312");
  taskState.recordAction(task, {
    // Recorded history is opaque data here — but it still has to look like a
    // real generation-scoped ref, and the generation cannot be hardcoded.
    action: { type: "click", target: `g${nextGeneration()}:4` },
    expectedOutcome: "results load",
    result: "success",
    observedOutcome: "results loaded",
  });
  task.round = 7;

  const snap = taskState.serializeTask(task);
  const back = taskState.restoreTask(JSON.parse(JSON.stringify(snap)));

  assert.equal(back.goal, "book the flight");
  assert.deepEqual(back.plan.map((p) => p.done), [true, false, false]);
  assert.equal(back.currentStep, 1);
  assert.deepEqual(back.constraints, ["budget $400"]);
  assert.deepEqual(back.knownFacts, { origin: "SLC" });
  assert.deepEqual(back.skills, ["scheduling"]);
  assert.match(back.workingMemory.facts[0], /Tuesday flight/);
  assert.equal(back.recentActions.length, 1);
  assert.equal(back.round, 0, "the restart was not the task's doing — the budget renews");
  assert.equal(back.status, "working");
});

test("garbage snapshots restore to null, never to a broken task", () => {
  assert.equal(taskState.restoreTask(null), null);
  assert.equal(taskState.restoreTask({}), null);
  assert.equal(taskState.restoreTask({ goal: "   " }), null);
  const minimal = taskState.restoreTask({ goal: "do it", plan: "not-an-array", workingMemory: 7 });
  assert.equal(minimal.goal, "do it");
  assert.deepEqual(minimal.plan, []);
  assert.deepEqual(minimal.workingMemory.facts, []);
});

// ── the loop ────────────────────────────────────────────────────────────────

function fakeBrowser() {
  const state = { url: "https://app.example.com/x", title: "App", text: "the page" };
  return {
    state,
    webContents: {
      isDestroyed: () => false,
      getURL: () => state.url,
      getTitle: () => state.title,
      executeJavaScript: async () => null,
    },
    actuator: {
      async getDOMCatalog() {
        return {
          ok: true, url: state.url, title: state.title,
          items: [{
            uid: 1, id: "el1", tag: "button", type: "", role: "", selector: "#go",
            label: "Go", value: "", checked: false, href: "",
            clientX: 10, clientY: 10, inView: true,
          }],
        };
      },
      async getPageContext() { return { ok: true, url: state.url, title: state.title, text: state.text }; },
      async runAction() { return { ok: true }; },
      async screenshotDataUrl() { return "data:image/jpeg;base64,ZmFrZQ=="; },
      async waitForLoad() {},
      async waitForDomSettle() {},
    },
  };
}

function model({ onDecide = null, decisions }) {
  let i = 0;
  return {
    async plan() {
      throw new Error("the planner must not run on a resumed task");
    },
    async decide(ctx) {
      if (onDecide) onDecide(ctx, i);
      const d = decisions[Math.min(i, decisions.length - 1)];
      i += 1;
      const out = typeof d === "function" ? d(ctx) : d;
      return {
        kind: "act", action: null, reason: "", narration: "", expectedOutcome: "", risk: "low",
        answer: "", question: "", replanReason: "", constraints: null, steps: null,
        planStepCompleted: false, factsLearned: [], candidateResults: [], ...out,
      };
    },
    async verify() { return { success: true, evidence: "confirmed", reason: "", next: "continue" }; },
    async learn() { return { notes: [], userNotes: [] }; },
  };
}

function interruptedSnapshot() {
  const task = taskState.createTask({ goal: "finish the report" });
  taskState.setPlan(task, { plan: ["Open the doc", "Write the summary"], knownFacts: {}, skills: [] });
  taskState.markStepDone(task);
  taskState.addFact(task, "the doc lives at /reports/q3");
  task.round = 5;
  return taskState.serializeTask(task);
}

test("a resumed run skips planning, keeps its state, and is told to re-read the page", async () => {
  const fake = fakeBrowser();
  const decideContexts = [];
  const r = await runBrowserAgentTask({
    goal: "finish the report",
    resumeTask: interruptedSnapshot(),
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model: model({
      onDecide: (ctx) => decideContexts.push(ctx),
      decisions: [{
        kind: "finish",
        answer: "The summary was already written; the doc is complete.",
        factsLearned: ["the summary section is filled in"],
      }],
    }),
    maxRounds: 4,
    userDataPath: TMP,
  });
  await r.learning;
  assert.equal(r.status, "completed", "plan() throwing proves the planner never ran");
  assert.match(decideContexts[0].user, /resuming after a restart/i, "the first decision must be told to re-read");
  assert.match(decideContexts[0].user, /\/reports\/q3/, "facts gathered before the restart must carry over");
  assert.match(decideContexts[0].user, /\[done\] Open the doc/, "the plan position must carry over");
});

test("onTaskState receives snapshots as the run progresses, ending with a terminal one", async () => {
  const fake = fakeBrowser();
  const snapshots = [];
  const m = model({
    decisions: [
      (ctx) => ({
        kind: "act",
        action: { type: "click", target: refFor(ctx, 1) },
        expectedOutcome: "something",
        factsLearned: ["it worked"],
      }),
      { kind: "finish", answer: "Done." },
    ],
  });
  // A fresh (non-resumed) run needs a real planner.
  m.plan = async () => ({ plan: ["Click the thing"], constraints: [], knownFacts: {}, skills: [], clarification: "" });
  const r = await runBrowserAgentTask({
    goal: "click the thing",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model: m,
    maxRounds: 4,
    userDataPath: TMP,
    onTaskState: (s) => snapshots.push(s),
  });
  await r.learning;
  assert.ok(snapshots.length >= 3, "planning, the action, and finish each persist");
  assert.equal(snapshots[0].status, "working");
  assert.equal(snapshots.at(-1).status, "completed", "the terminal snapshot tells the host to clear stored state");
  const midRun = snapshots.find((s) => s.recentActions.length > 0 && s.status === "working");
  assert.ok(midRun, "a mid-run snapshot carries the action history a resume would need");
  // Round-trip: what was persisted mid-run must be resumable.
  assert.ok(taskState.restoreTask(midRun), "persisted snapshots must restore");
});

test("a hostile onTaskState cannot hurt the run", async () => {
  const fake = fakeBrowser();
  const m = model({ decisions: [{ kind: "finish", answer: "Done.", factsLearned: ["fine"] }] });
  m.plan = async () => ({ plan: ["One step"], constraints: [], knownFacts: {}, skills: [], clarification: "" });
  const r = await runBrowserAgentTask({
    goal: "do the thing",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model: m,
    maxRounds: 3,
    userDataPath: TMP,
    onTaskState: () => {
      throw new Error("disk full");
    },
  });
  await r.learning;
  assert.equal(r.status, "completed", "persistence failures are the host's problem, not the task's");
});
