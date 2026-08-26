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
          { uid: 1, id: "1", role: "button", label: "Checkout", selector: "#checkout", clientX: 700, clientY: 300, inView: true },
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

/**
 * Placeholder target a scripted decision uses to mean "the element on the
 * page". Refs are generation-scoped (`g{gen}:{uid}`) and re-minted on every
 * snapshot, so the model resolves this from the observation text each round —
 * a hardcoded ref would classify as malformed or stale.
 */
const CURRENT_REF = "<current-ref>";

function refFromObservation(user) {
  const m = /\[(g\d+:[^\]\s]+)\]/.exec(String(user || ""));
  assert.ok(m, "the observation must list at least one element ref");
  return m[1];
}

/** Swap the CURRENT_REF placeholder for the ref this round's snapshot minted. */
function resolveTarget(d, user) {
  if (d?.action?.target !== CURRENT_REF) return d;
  return { ...d, action: { ...d.action, target: refFromObservation(user) } };
}

function makeModel({ decisions, groundImpl }) {
  let i = 0;
  const groundCalls = [];
  return {
    groundCalls,
    async plan() {
      return { plan: ["Check out"], constraints: [], knownFacts: {}, skills: [], clarification: "" };
    },
    async decide(ctx) {
      const d = resolveTarget(decisions[Math.min(i, decisions.length - 1)], ctx.user);
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
      { action: { type: "click", target: CURRENT_REF } },
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
    decisions: [{ action: { type: "click", target: CURRENT_REF } }, { kind: "finish", answer: "done", factsLearned: ["the cart holds 1 item"] }],
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

// ── assist: refs first, Holo as the rescue ──────────────────────────────────
//
// Production no longer runs with the grounder switched off. It runs in "assist":
// element references do the aiming, and only once the recovery ladder has given
// up on them does the model get to describe what it can see. These pin down the
// two ways that could go wrong — grounding on a round nobody asked for, and
// failing to ground on the round that did.

/** A page whose only control never responds, so the ladder has to escalate. */
function createStubbornBrowser() {
  const actuated = [];
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://design.example.com/edit",
    getTitle: () => "Editor",
  };
  const actuator = {
    async runAction(_wc, action) {
      actuated.push(action);
      return { ok: true, resolved: action.type, x: action.x, y: action.y, clickedLabel: action.label || "" };
    },
    async getDOMCatalog() {
      return {
        items: [
          { uid: 1, id: "1", role: "button", label: "Zoom", selector: "#zoom", clientX: 700, clientY: 60, inView: true },
        ],
      };
    },
    async getPageContext() {
      return { text: "Untitled design.", url: "https://design.example.com/edit", title: "Editor" };
    },
    async settle() {},
    async waitForDomSettle() {},
    async screenshotDataUrl() { return "data:image/jpeg;base64,ZmFrZQ=="; },
  };
  return { webContents, actuator, actuated };
}

/** Model that clicks a ref until the loop invites a description, then describes. */
function makeAssistModel({ description = "the zoom control in the top toolbar", groundImpl, onDecide = null }) {
  const groundCalls = [];
  const prompts = [];
  return {
    groundCalls,
    prompts,
    async plan() {
      return { plan: ["Zoom in"], constraints: [], knownFacts: {}, skills: [], clarification: "" };
    },
    async decide(ctx) {
      prompts.push(ctx.user);
      const invited = /TARGETING RESCUE/.test(String(ctx.user || ""));
      if (onDecide) onDecide({ invited, ctx });
      return {
        kind: "act",
        action: invited
          ? { type: "click", targetDescription: description }
          : { type: "click", target: refFromObservation(ctx.user) },
        reason: "", expectedOutcome: "the canvas zooms in", risk: "low",
        answer: "", question: "", replanReason: "", planStepCompleted: false,
        factsLearned: [], candidateResults: [],
      };
    },
    async verify() {
      return { success: false, evidence: "", reason: "nothing moved", next: "recover" };
    },
    async ground(args) {
      groundCalls.push(args);
      return groundImpl(args, groundCalls.length);
    },
    async learn() { return { notes: [], userNotes: [] }; },
  };
}

test("production defaults to assist: references are never grounded while they work", async () => {
  const fake = createFakeBrowser();
  const model = makeModel({
    decisions: [
      { action: { type: "click", target: CURRENT_REF } },
      { kind: "finish", answer: "done", factsLearned: ["the cart holds 1 item"] },
    ],
    groundImpl: null, // throws if the loop ever reaches it
  });

  // No groundingMode at all — exactly how agentRuntime calls the loop.
  const result = await runTask({ fake, model, groundingMode: undefined });

  assert.equal(model.groundCalls.length, 0, "a working element ref must never cost a grounding call");
  const click = fake.actuated.find((a) => a.type === "click" || a.type === "click_coord");
  assert.equal(click.type, "click", "assist must not turn an ordinary click into coordinates");
  assert.equal(result.ok, true);
});

test("a described target on a round that did not invite one is refused, not grounded", async () => {
  const fake = createFakeBrowser();
  const model = makeModel({
    decisions: [
      { action: { type: "click", targetDescription: "the Checkout button" } },
      { action: { type: "click", target: CURRENT_REF } },
      { kind: "finish", answer: "done", factsLearned: ["the cart holds 1 item"] },
    ],
    groundImpl: null,
  });

  await runTask({ fake, model, groundingMode: undefined });

  assert.equal(
    model.groundCalls.length, 0,
    "a description the loop did not ask for must not open a grounding call",
  );
  assert.equal(
    fake.actuated.filter((a) => a.type === "click_coord").length, 0,
    "and must never reach the actuator as a blind coordinate click",
  );
});

test("once references have failed, the model may describe the target and it is grounded", async () => {
  const fake = createStubbornBrowser();
  const model = makeAssistModel({
    groundImpl: () => ({ found: true, x: 742, y: 58, confidence: "high", note: "zoom control" }),
  });

  await runTask({ fake, model, groundingMode: undefined });

  assert.ok(model.groundCalls.length >= 1, "the rescue round should reach the grounder");
  assert.equal(model.groundCalls[0].description, "the zoom control in the top toolbar");
  assert.ok(
    String(model.groundCalls[0].imageUrl || "").startsWith("data:image/"),
    "the grounder must read the same frame the decide model saw",
  );

  const coordClick = fake.actuated.find((a) => a.type === "click_coord");
  assert.ok(coordClick, "the grounded point should have been actuated");
  assert.equal(coordClick.x, 742);
  assert.equal(coordClick.y, 58);
  assert.equal(coordClick.label, "the zoom control in the top toolbar",
    "the description rides along for the safety gate and the narration");

  // The rescue is offered, not latched: the first rounds are plain ref clicks.
  const refClicks = fake.actuated.filter((a) => a.type === "click");
  assert.ok(refClicks.length >= 2, "references are tried first, repeatedly, before pixels");
});

test("a locator outage degrades to the agent's own eyes instead of ending the run", async () => {
  const fake = createStubbornBrowser();
  const model = makeAssistModel({
    groundImpl: () => { throw new Error("grounding endpoint unavailable"); },
  });

  const result = await runTask({ fake, model, groundingMode: undefined });

  // Unlike a holo arm, an assist outage is survivable: the run continues and
  // ends on its own terms rather than on "Grounding is unavailable".
  assert.doesNotMatch(String(result.answer), /grounding is unavailable/i);
  assert.ok(model.groundCalls.length > 0, "it should have tried");
  assert.ok(
    model.groundCalls.length <= 3,
    `assist must stop paying for a locator that is down (called ${model.groundCalls.length} times)`,
  );
});
