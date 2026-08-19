// Usage: node --test electron/browser-agent/groundingLoop.test.cjs
//
// Integration-level: drives the real runBrowserAgentTask loop and checks the
// grounding seam from the outside. The unit tests cover the grounder in
// isolation; these two pin down the thing that would quietly ruin a run —
// refs mode reaching the grounder, or holo mode failing to.
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { runBrowserAgentTask, createBrowserController } = require("./index.cjs");

/** Minimal fake browser: one page, one button, records what was actuated. */
function createFakeBrowser() {
  const actuated = [];
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://shop.example.com/cart",
    getTitle: () => "Cart",
  };
  const actuator = {
    async runAction(_wc, action) {
      actuated.push(action);
      return { ok: true, resolved: action.type, x: action.x, y: action.y, clickedLabel: action.label || "" };
    },
    async getDOMCatalog() {
      return {
        items: [
          { id: "1", role: "button", label: "Checkout", selector: "#checkout", clientX: 700, clientY: 300, inView: true },
        ],
      };
    },
    async getPageContext() {
      return { text: "Your cart has 1 item.", url: "https://shop.example.com/cart", title: "Cart" };
    },
    async settle() {},
    async waitForDomSettle() {},
    // The real actuator returns a bare data-URL string, not a wrapper.
    async screenshotDataUrl() {
      return "data:image/jpeg;base64,ZmFrZQ==";
    },
  };
  return { webContents, actuator, actuated };
}

function makeModel({ decisions, groundImpl }) {
  let i = 0;
  const groundCalls = [];
  return {
    groundCalls,
    async plan() {
      return { plan: ["Check out"], constraints: [], knownFacts: {}, skills: [], clarification: "" };
    },
    async decide() {
      const d = decisions[Math.min(i, decisions.length - 1)];
      i += 1;
      return {
        kind: "act", action: null, reason: "", expectedOutcome: "", risk: "low",
        answer: "", question: "", replanReason: "", planStepCompleted: false,
        factsLearned: [], candidateResults: [], ...d,
      };
    },
    async verify() {
      return { success: true, evidence: "page changed", reason: "", next: "continue" };
    },
    async ground(args) {
      groundCalls.push(args);
      if (!groundImpl) throw new Error("ground() should not have been called");
      return groundImpl(args, groundCalls.length);
    },
  };
}

function runTask({ fake, model, groundingMode, onBeforeAct = null, timing = false }) {
  return runBrowserAgentTask({
    goal: "Complete the checkout",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model,
    // Headroom for the finish-pushback round the loop inserts when plan steps
    // are still open; 3 rounds runs out before the task can legitimately end.
    maxRounds: 10,
    userDataPath: path.join(os.tmpdir(), "lykn-grounding-test"),
    groundingMode,
    timing,
    onBeforeAct,
  });
}

test("refs mode never reaches the grounder and actuates an element ref", async () => {
  const fake = createFakeBrowser();
  // ground() throws if called at all, so any contact fails the test loudly.
  const model = makeModel({
    decisions: [
      { action: { type: "click", target: "e1" } },
      { kind: "finish", answer: "done", factsLearned: ["the cart holds 1 item"] },
    ],
    groundImpl: null,
  });

  const result = await runTask({ fake, model, groundingMode: "refs" });

  assert.equal(model.groundCalls.length, 0, "refs mode must not call the grounding model");
  const click = fake.actuated.find((a) => a.type === "click" || a.type === "click_coord");
  assert.ok(click, "a click should have been actuated");
  assert.notEqual(click.type, "click_coord", "refs mode should not degrade to coordinates");
  assert.equal(result.ok, true);
});

test("holo mode grounds the description and actuates the returned point", async () => {
  const fake = createFakeBrowser();
  const model = makeModel({
    decisions: [
      { action: { type: "click", target: "the blue Checkout button on the right" } },
      { kind: "finish", answer: "done", factsLearned: ["the cart holds 1 item"] },
    ],
    groundImpl: () => ({ found: true, x: 742, y: 318, confidence: "high", note: "Checkout button" }),
  });

  const result = await runTask({ fake, model, groundingMode: "holo" });

  assert.equal(model.groundCalls.length, 1, "holo mode should ground exactly once for one click");
  assert.equal(model.groundCalls[0].description, "the blue Checkout button on the right");
  assert.ok(
    String(model.groundCalls[0].imageUrl || "").startsWith("data:image/"),
    "the grounder must be handed the screenshot the decide model saw",
  );

  const click = fake.actuated.find((a) => a.type === "click_coord");
  assert.ok(click, "holo mode should actuate a coordinate click");
  assert.equal(click.x, 742);
  assert.equal(click.y, 318);
  assert.equal(click.label, "the blue Checkout button on the right",
    "the description rides along so the safety gate and narration can read it");
  assert.equal(result.ok, true);
});

test("a grounding miss does not actuate anything", async () => {
  const fake = createFakeBrowser();
  const model = makeModel({
    decisions: [{ action: { type: "click", target: "a button that is not there" } }],
    groundImpl: () => ({ found: false, confidence: "low", note: "not visible" }),
  });

  await runTask({ fake, model, groundingMode: "holo" });

  assert.equal(
    fake.actuated.filter((a) => a.type === "click_coord").length, 0,
    "a miss must never fall through to a blind click",
  );
});

test("a grounding outage ends the run instead of reverting to element refs", async () => {
  const fake = createFakeBrowser();
  const model = makeModel({
    decisions: [{ action: { type: "click", target: "the Checkout button" } }],
    groundImpl: () => { throw new Error("grounding endpoint unavailable"); },
  });

  const result = await runTask({ fake, model, groundingMode: "holo" });

  assert.equal(result.ok, false);
  assert.match(result.answer, /grounding is unavailable/i);
  assert.equal(fake.actuated.filter((a) => a.type === "click_coord").length, 0);
});

test("onBeforeAct is awaited before the action lands", async () => {
  const fake = createFakeBrowser();
  const order = [];
  const model = makeModel({
    decisions: [{ action: { type: "click", target: "e1" } }, { kind: "finish", answer: "done", factsLearned: ["the cart holds 1 item"] }],
  });
  const origRun = fake.actuator.runAction.bind(fake.actuator);
  fake.actuator.runAction = async (wc, action) => { order.push(`act:${action.type}`); return origRun(wc, action); };

  await runTask({
    fake, model, groundingMode: "refs",
    onBeforeAct: async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("hook");
    },
  });

  const hookAt = order.indexOf("hook");
  const clickAt = order.findIndex((o) => o === "act:click");
  assert.ok(hookAt >= 0, "the hook should have fired");
  assert.ok(hookAt < clickAt, `the hook must complete before the click (${order.join(" -> ")})`);
});
