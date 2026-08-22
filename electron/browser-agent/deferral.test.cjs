/**
 * Deferred verification tests.
 *
 * A model verify call used to run on every action whose outcome determinism
 * could not settle — one paid round-trip per action, to learn what the next
 * decide call re-reads anyway. The loop may now take an inconclusive-but-
 * responsive page on faith, with three hard edges these tests pin: the page
 * must have changed and report no problem, at most two deferrals run back to
 * back (a toggle clicked open/closed changes the page every time), and a
 * deferred "success" can never underwrite a completed-task claim on its own.
 *
 * Run: node --test electron/browser-agent/deferral.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { verifyOutcome } = require("./runtime/verifier.cjs");
const { runBrowserAgentTask, createBrowserController } = require("./index.cjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-deferral-"));

// ── verifier unit behavior ──────────────────────────────────────────────────

function snap(over = {}) {
  return {
    url: "https://app.example.com/x", title: "App", tabs: [], elements: [],
    byRef: new Map(), visibleText: "", ...over,
  };
}

function changedDiff() {
  return {
    urlChanged: false, titleChanged: false, textChanged: true,
    newLabels: [], removedLabels: [], countChanges: [], stateChanges: [],
    summary: "Page text changed.",
  };
}

function modelSpy() {
  const spy = { calls: 0 };
  spy.model = {
    verify: async () => {
      spy.calls += 1;
      return { success: false, evidence: "", reason: "model says no", next: "recover" };
    },
  };
  return spy;
}

const CLICK = {
  action: { type: "click", target: "e1" },
  expectedOutcome: "the quantum flux stabilizes",
};

test("an inconclusive-but-responsive page is deferred instead of model-verified", async () => {
  const spy = modelSpy();
  const v = await verifyOutcome({
    model: spy.model,
    decision: CLICK,
    actionResult: { ok: true },
    before: snap({ visibleText: "before" }),
    after: snap({ visibleText: "something different now" }),
    diff: changedDiff(),
    deferInconclusive: true,
  });
  assert.equal(v.success, true);
  assert.equal(v.deferred, true);
  assert.equal(v.method, "deferred");
  assert.match(v.evidence, /not yet verified/);
  assert.equal(spy.calls, 0, "deferral exists to avoid exactly this call");
});

test("a page reporting a problem is never deferred", async () => {
  const spy = modelSpy();
  const v = await verifyOutcome({
    model: spy.model,
    decision: CLICK,
    actionResult: { ok: true },
    before: snap({ visibleText: "before" }),
    after: snap({ visibleText: "Something went wrong. Try again." }),
    diff: changedDiff(),
    deferInconclusive: true,
  });
  assert.equal(spy.calls, 1, "problem text is what the model verdict is FOR");
  assert.equal(v.success, false);
});

test("without the loop's permission the model is consulted as before", async () => {
  const spy = modelSpy();
  await verifyOutcome({
    model: spy.model,
    decision: CLICK,
    actionResult: { ok: true },
    before: snap({ visibleText: "before" }),
    after: snap({ visibleText: "something different now" }),
    diff: changedDiff(),
    deferInconclusive: false,
  });
  assert.equal(spy.calls, 1);
});

test("a deterministic keyword match still wins ahead of deferral", async () => {
  const spy = modelSpy();
  const v = await verifyOutcome({
    model: spy.model,
    decision: { action: { type: "click", target: "e1" }, expectedOutcome: "the settings panel opens" },
    actionResult: { ok: true },
    before: snap({ visibleText: "home" }),
    after: snap({ visibleText: "Settings panel. Manage your preferences." }),
    diff: { ...changedDiff(), summary: "New elements: \"Settings panel\"" },
    deferInconclusive: true,
  });
  assert.equal(v.method, "deterministic");
  assert.notEqual(v.deferred, true);
  assert.equal(spy.calls, 0);
});

// ── loop policy ─────────────────────────────────────────────────────────────

/** Minimal browser whose page text changes on every action. */
function mutatingBrowser() {
  const state = {
    url: "https://app.example.com/x",
    title: "App",
    text: "step 0 shown",
    n: 0,
  };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => state.url,
    getTitle: () => state.title,
    executeJavaScript: async () => null,
  };
  const actuator = {
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
    async getPageContext() {
      return { ok: true, url: state.url, title: state.title, text: state.text };
    },
    async runAction(_w, action) {
      state.n += 1;
      state.text = `step ${state.n} shown`;
      return { ok: true, type: action.type };
    },
    async screenshotDataUrl() { return "data:image/jpeg;base64,ZmFrZQ=="; },
    async waitForLoad() {},
    async waitForDomSettle() {},
  };
  return { state, webContents, actuator };
}

function scriptedModel({ decisions, verifySpy }) {
  let i = 0;
  return {
    async plan() {
      return { plan: ["Do it"], constraints: [], knownFacts: {}, skills: [], clarification: "" };
    },
    async decide() {
      const d = decisions[Math.min(i, decisions.length - 1)];
      i += 1;
      return {
        kind: "act", action: null, reason: "", narration: "", expectedOutcome: "", risk: "low",
        answer: "", question: "", replanReason: "", constraints: null, steps: null,
        planStepCompleted: false, factsLearned: [], candidateResults: [], ...d,
      };
    },
    async verify() {
      verifySpy.calls += 1;
      return { success: false, evidence: "", reason: "expectation unmet", next: "recover" };
    },
    async learn() { return { notes: [], userNotes: [] }; },
  };
}

test("at most two verifications run on faith before a real verdict", async () => {
  const fake = mutatingBrowser();
  const verifySpy = { calls: 0 };
  const model = scriptedModel({
    verifySpy,
    decisions: [{
      kind: "act",
      action: { type: "click", target: "e1" },
      expectedOutcome: "the quantum flux stabilizes",
    }],
  });
  const r = await runBrowserAgentTask({
    goal: "stabilize the flux",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 5,
    userDataPath: TMP,
  });
  await r.learning;
  const acts = r.task.recentActions.filter((a) => a.action?.type === "click");
  assert.ok(acts.length >= 3, `need three click rounds to see the cap (got ${acts.length})`);
  assert.equal(acts[0].deferred, true, "first inconclusive round is taken on faith");
  assert.equal(acts[1].deferred, true, "second too");
  assert.notEqual(acts[2].deferred, true, "the third gets a real verdict");
  assert.ok(verifySpy.calls >= 1, "the capped round must actually consult the model");
});

test("deferred successes alone cannot underwrite a completed task", async () => {
  const fake = mutatingBrowser();
  const verifySpy = { calls: 0 };
  const model = scriptedModel({
    verifySpy,
    decisions: [
      {
        kind: "act",
        action: { type: "click", target: "e1" },
        expectedOutcome: "the quantum flux stabilizes",
      },
      { kind: "finish", answer: "All done, definitely.", planStepCompleted: false },
    ],
  });
  const r = await runBrowserAgentTask({
    goal: "stabilize the flux",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    maxRounds: 6,
    userDataPath: TMP,
  });
  await r.learning;
  assert.equal(r.status, "failed", "an unverified click plus a confident answer is not a completed task");
  assert.match(r.task.completionReason, /without evidence/);
});
