/**
 * Regression tests for the browser-agent defect audit.
 *
 * Every test here corresponds to a bug that shipped, and each one failed
 * against the code as it was. They are grouped by what the defect did to the
 * user, because that is what makes a reintroduction recognisable:
 *
 *   - false success  — the agent reported work it had not done
 *   - blind          — the runtime held information the model never saw
 *   - false failure  — work that succeeded was scored as failure and redone
 *   - safety gate    — an irreversible action ran unattended, or an ordinary
 *                      one stalled waiting for permission it did not need
 *   - constraints    — the plan boxed the agent in with no way out
 *   - lifecycle      — stop, timeouts, and what happens when the model is down
 *
 * Run: node --test electron/browser-agent/defects.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { runBrowserAgentTask, createBrowserController } = require("./index.cjs");
const { createAgentModel, AgentModelUnavailableError } = require("./runtime/model.cjs");
const { createMemoryStore } = require("./runtime/memory.cjs");
const { createRecoveryTracker } = require("./runtime/recovery.cjs");
const { verifyOutcome } = require("./runtime/verifier.cjs");
const { formatSnapshotForModel, buildSnapshot } = require("./browser/snapshot.cjs");
const { resolveGroundingMode } = require("./runtime/grounding.cjs");
const executor = require("./runtime/executor.cjs");
const planner = require("./runtime/planner.cjs");
const taskState = require("./runtime/taskState.cjs");

const TMP = path.join(os.tmpdir(), "lykn-defects-test");

// ── shared fakes ────────────────────────────────────────────────────────────

function makeElement(o = {}) {
  return {
    id: `el${o.name || Math.floor(Math.random() * 1e6)}`,
    tag: "button", type: "", role: "", selector: `#${o.name || "el"}`,
    label: "", value: "", checked: false, href: "",
    clientX: 100, clientY: 100, inView: true, ...o,
  };
}

/** One page, mutable, recording every action the controller actuates. */
function createFakeBrowser({ url = "https://example.com", title = "Page", text = "", elements = [], onAction = null } = {}) {
  const state = { url, title, text, elements, calls: [] };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => state.url,
    getTitle: () => state.title,
    executeJavaScript: async () => null,
  };
  const actuator = {
    async navigate(_w, to) { state.url = to; return { ok: true, url: to }; },
    async getDOMCatalog() {
      // The real collector mints a uid per element in page context; these
      // fixtures predate it, so number them in catalog order.
      return { ok: true, url: state.url, title: state.title, items: state.elements.map((e, i) => ({ uid: i + 1, ...e })) };
    },
    async getPageContext() { return { ok: true, url: state.url, title: state.title, text: state.text }; },
    async runAction(_w, action) {
      state.calls.push(action);
      const target = state.elements.find((e) => e.selector === action.selector || e.id === action.id);
      if (onAction) {
        const out = onAction({ action, target, state });
        if (out) return out;
      }
      return { ok: true, type: action.type };
    },
    async screenshotDataUrl() { return "data:image/jpeg;base64,ZmFrZQ=="; },
    async waitForLoad() {},
    async waitForDomSettle() {},
  };
  return { state, webContents, actuator };
}

function createScriptedModel({ plan, decisions, verify, onDecide } = {}) {
  let i = 0;
  return {
    async plan() {
      return {
        plan: plan?.plan || ["Do the task"], constraints: plan?.constraints ?? [],
        knownFacts: {}, skills: [], clarification: "",
      };
    },
    async decide(ctx) {
      if (onDecide) onDecide(ctx, i);
      const d = decisions[Math.min(i, decisions.length - 1)];
      i += 1;
      const out = typeof d === "function" ? d(ctx, i - 1) : d;
      return {
        kind: "act", action: null, reason: "", expectedOutcome: "", risk: "low", answer: "",
        question: "", replanReason: "", constraints: null, planStepCompleted: false,
        factsLearned: [], candidateResults: [], ...out,
      };
    },
    async verify() {
      return verify ? verify() : { success: true, evidence: "page changed", reason: "", next: "continue" };
    },
    async learn() { return { notes: [], userNotes: [] }; },
  };
}

/**
 * Read a live element ref off the observation handed to the model. Refs are
 * generation-scoped ("g7:12") and the generation counter is process-global,
 * so a scripted decision can never hardcode one — it has to aim at what the
 * current snapshot actually minted.
 */
function refFrom(ctx) {
  const m = String(ctx?.user || "").match(/\[(g\d+:[^\]]+)\]/);
  return m ? m[1] : "";
}

function runTask(fake, model, opts = {}) {
  return runBrowserAgentTask({
    goal: "do the thing",
    controller: createBrowserController({ webContents: fake.webContents, actuator: fake.actuator }),
    model, maxRounds: 8, userDataPath: TMP, ...opts,
  });
}

const page = (over = {}) => ({
  url: "https://app.example.com/x", title: "App", tabs: [], elements: [], byRef: new Map(),
  visibleText: "", ...over,
});

const NO_CHANGE = {
  urlChanged: false, titleChanged: false, textChanged: false,
  newLabels: [], removedLabels: [], summary: "No observable page change.",
};

// ── false success ───────────────────────────────────────────────────────────

test("a stray canvas or svg does not switch off failure detection for the page", async () => {
  const ctl = (n) => ({ ref: `e${n}`, role: "button", label: `Control ${n}`, raw: { tag: "button" } });
  const drawn = (n, tag) => ({ ref: `e${n}`, role: "img", label: "", raw: { tag } });
  const many = Array.from({ length: 20 }, (_, i) => ctl(i + 1));

  const judge = (els, action, url = "https://shop.example.com/checkout") => {
    const p = page({ url, elements: els, byRef: new Map(els.map((e) => [e.ref, e])) });
    return verifyOutcome({
      model: { verify: async () => ({ success: false, evidence: "", reason: "m", next: "recover" }) },
      decision: { action, expectedOutcome: "the tool is selected" },
      actionResult: { ok: true }, before: p, after: p, diff: NO_CHANGE,
    });
  };

  // The bug: countDrawnSurfaces() scanned the whole catalog, so one decorative
  // icon anywhere made every dead click on the page an unconfirmed success.
  for (const tag of ["svg", "canvas"]) {
    const v = await judge([...many, drawn(21, tag)], { type: "click", target: "e1" });
    assert.equal(v.success, false, `a dead click on a page that merely contains a <${tag}> is a failure`);
  }

  // The escape hatch still has to work where it was meant to.
  const cases = [
    ["clicked the canvas itself", [...many, drawn(21, "canvas")], { type: "click", target: "e21" }, "https://app.example.com/e"],
    ["a known visual editor", many, { type: "click", target: "e1" }, "https://www.canva.com/design/X/edit"],
    ["a coordinate click on a drawn page", [...many, drawn(21, "canvas")], { type: "click_coord", x: 500, y: 500 }, "https://editor.example.com"],
    ["a drag on a drawn page", [...many, drawn(21, "canvas")], { type: "drag", target: "e1", to: "e2" }, "https://editor.example.com"],
    ["a page that is nearly all canvas", [ctl(1), ctl(2), drawn(3, "canvas")], { type: "click", target: "e1" }, "https://editor.example.com"],
  ];
  for (const [name, els, action, url] of cases) {
    const v = await judge(els, action, url);
    assert.equal(v.unverified, true, `${name} must still report done-but-unconfirmed`);
  }
});

test("a page reporting an error never counts as deterministic evidence of success", async () => {
  const v = await verifyOutcome({
    model: { verify: async () => ({ success: false, evidence: "", reason: "asked the model", next: "recover" }) },
    decision: { action: { type: "click", target: "e1" }, expectedOutcome: "the message is sent to Bob" },
    actionResult: { ok: true },
    before: page({ visibleText: "New message to Bob" }),
    after: page({ visibleText: "New message to Bob. Your message to Bob could not be sent. Please try again." }),
    diff: { ...NO_CHANGE, textChanged: true, newLabels: ["error"], summary: 'New elements: "error"' },
  });
  // The failure notice repeats "message", "sent" and "Bob" — the exact words
  // the expectation was written in.
  assert.equal(v.method, "model", "an error page must be judged, not keyword-matched into a success");
  assert.notEqual(v.success, true);
});

test("an expectation is not confirmed by words that were already on the page", async () => {
  const shared = "Mechanical Keyboard — add this item to your cart. Cart (0)";
  const v = await verifyOutcome({
    model: { verify: async () => ({ success: false, evidence: "", reason: "asked the model", next: "recover" }) },
    decision: { action: { type: "click", target: "e1" }, expectedOutcome: "the item is added to the cart" },
    actionResult: { ok: true },
    before: page({ visibleText: `${shared} 12 people viewing.` }),
    after: page({ visibleText: `${shared} 14 people viewing.` }),
    diff: { ...NO_CHANGE, textChanged: true, summary: "Page text changed." },
  });
  assert.notEqual(v.success, true, "a live counter ticking over is not evidence the cart changed");

  // ...and a click that really worked still verifies without a model call.
  const good = await verifyOutcome({
    model: { verify: async () => { throw new Error("model should not be needed"); } },
    decision: { action: { type: "click", target: "e1" }, expectedOutcome: "the item is added to the cart" },
    actionResult: { ok: true },
    before: page({ visibleText: "Mechanical Keyboard. Cart (0)" }),
    after: page({ visibleText: "Mechanical Keyboard. Cart (1). 1 item added to your cart." }),
    diff: { ...NO_CHANGE, textChanged: true, newLabels: ["Cart (1)"], summary: 'New elements: "Cart (1)"' },
  });
  assert.equal(good.success, true);
  assert.equal(good.method, "deterministic");
});

test("a truncated write is not reported as a completed one", async () => {
  const body =
    "Hi Bob, thanks for the update on the Q3 numbers. I've reviewed the deck and have three " +
    "concerns about the forecast methodology I'd like to walk through before Friday.";
  const v = await verifyOutcome({
    model: { verify: async () => ({ success: true, evidence: "", reason: "", next: "continue" }) },
    decision: { action: { type: "type", target: "e1", text: body }, expectedOutcome: "the body is written" },
    actionResult: { ok: true }, before: page(), after: page(),
    diff: { ...NO_CHANGE, textChanged: true, summary: "text changed" },
    // The editor kept the opening clause and dropped the rest. A 40-character
    // prefix check passed on this and the agent went on to send half a message.
    extracted: { ok: true, label: "Message body", value: body.slice(0, 43) },
  });
  assert.equal(v.success, false);
  assert.match(v.reason, /truncated/i);
  assert.match(v.reason, /Do NOT retype/i, "retyping appends — the fix has to say so");
});

test("navigation is verified by host and path, not by substring", async () => {
  const go = (wanted, landed) =>
    verifyOutcome({
      model: { verify: async () => ({ success: true, evidence: "", reason: "", next: "continue" }) },
      decision: { action: { type: "navigate", url: wanted }, expectedOutcome: "the page loads" },
      actionResult: { ok: true }, before: page({ url: "about:blank" }),
      after: page({ url: landed, title: "Sign in" }),
      diff: { ...NO_CHANGE, urlChanged: true, summary: "url changed" },
    });

  for (const [wanted, landed, why] of [
    ["https://example.com/page", "https://consent.example.com/cookie-wall", "a subdomain is not the host"],
    ["https://mail.google.com/mail/u/0/", "https://www.google.com/sorry/index", "a parent domain is not the host"],
    ["https://www.amazon.com/dp/B0XYZ", "https://www.amazon.com/errors/validateCaptcha", "right host, CAPTCHA page"],
    ["https://app.example.com/dash", "https://app.example.com/login?next=/dash", "right host, sign-in wall"],
  ]) {
    const v = await go(wanted, landed);
    assert.equal(v.success, false, why);
  }

  const arrived = await go("https://docs.example.com/d/abc", "https://docs.example.com/d/abc");
  assert.equal(arrived.success, true, "actually arriving is still a success");
  // Asking for a login page and getting one is arrival, not a wall.
  const wanted = await go("https://app.example.com/login", "https://app.example.com/login");
  assert.equal(wanted.success, true);
});

test("a run cannot finish with an invented answer", async () => {
  const fake = createFakeBrowser({
    url: "https://shop.example.com", text: "Nothing useful",
    elements: Array.from({ length: 6 }, (_, i) => makeElement({ name: `b${i}`, label: `Item ${i}` })),
  });
  // Two scrolls "succeed" mechanically and prove nothing; the model then
  // announces a result it never gathered.
  const model = createScriptedModel({
    plan: { plan: ["Search", "Compare", "Report the cheapest"] },
    decisions: [
      { kind: "act", action: { type: "scroll", direction: "down" }, expectedOutcome: "more items" },
      { kind: "act", action: { type: "scroll", direction: "down" }, expectedOutcome: "more items" },
      { kind: "finish", answer: "The cheapest is the Model X at $79." },
    ],
  });
  const r = await runTask(fake, model, { goal: "find the cheapest keyboard" });
  assert.equal(r.status, "failed");
  assert.doesNotMatch(r.answer, /Model X/, "an unevidenced answer must not reach the user");

  // A run that actually learned something still finishes.
  const good = await runTask(
    createFakeBrowser({ url: "https://shop.example.com", text: "Model X $79" }),
    createScriptedModel({
      plan: { plan: ["Look it up"] },
      decisions: [{ kind: "finish", answer: "The cheapest is the Model X at $79.", factsLearned: ["Model X costs $79"] }],
    }),
    { goal: "find the cheapest keyboard" },
  );
  assert.equal(good.status, "completed");
});

// ── blind spots ─────────────────────────────────────────────────────────────

test("link destinations reach the model", () => {
  const snap = buildSnapshot({
    url: "https://lykn.io/blog", title: "Blog", text: "…",
    catalog: [
      { uid: 1, id: "a1", tag: "a", label: "MLPerf results", href: "https://mlcommons.org/benchmarks?utm_source=x" },
      { uid: 2, id: "a2", tag: "a", label: "About us", href: "https://lykn.io/about" },
      { uid: 3, id: "a3", tag: "a", label: "Menu", href: "javascript:void(0)" },
      { uid: 4, id: "b1", tag: "button", label: "Subscribe" },
    ],
  });
  const rendered = formatSnapshotForModel(snap);
  const ref = (label) => snap.elements.find((e) => e.label === label).ref;
  assert.match(rendered, new RegExp(`\\[${ref("MLPerf results")}\\] link "MLPerf results" -> mlcommons\\.org/benchmarks\\?…`),
    "without the destination the agent cannot tell an outbound link from an internal one");
  assert.match(rendered, new RegExp(`\\[${ref("About us")}\\] link "About us" -> lykn\\.io/about`));
  assert.doesNotMatch(rendered, /javascript:/, "javascript: hrefs are noise");
  assert.match(rendered, new RegExp(`\\[${ref("Subscribe")}\\] button "Subscribe"(?! ->)`), "non-links get no destination");
});

test("a screenshot the model asked for comes back to it", async () => {
  const fake = createFakeBrowser({
    url: "https://example.com", text: "text",
    elements: Array.from({ length: 10 }, (_, i) => makeElement({ name: `b${i}`, label: `Button ${i}` })),
  });
  const images = [];
  const model = createScriptedModel({
    plan: { plan: ["Look"] },
    decisions: [
      { kind: "act", action: { type: "screenshot" }, expectedOutcome: "I can see the page" },
      { kind: "finish", answer: "done", factsLearned: ["saw it"] },
    ],
    onDecide: (ctx) => images.push(ctx.imageUrl || null),
  });
  await runTask(fake, model);
  assert.ok(images[1], "the round after a screenshot action must carry the image");
  assert.match(images[1], /^data:image\//);
});

// ── false failure ───────────────────────────────────────────────────────────

test("every action leaves the agent looking at a fresh page", async () => {
  let advanced = 0;
  const fake = createFakeBrowser({ elements: [makeElement({ name: "b", label: "Go" })] });
  const controllerFor = () => createBrowserController({ webContents: fake.webContents, actuator: fake.actuator });

  // getCurrentSnapshot() is what the loop reads before deciding to re-observe.
  // Anything non-null here is the pre-action view of a page that just changed.
  const actions = {
    scroll: (c) => c.scroll("down"),
    wait: (c) => c.wait(100),
    "press ArrowDown": (c) => c.pressKey("ArrowDown"),
    "press Escape": (c) => c.pressKey("Escape"),
    "press Tab": (c) => c.pressKey("Tab"),
    "press Enter": (c) => c.pressKey("Enter"),
    click: (c, snap) => c.click(snap.elements[0].ref),
    type: (c, snap) => c.type(snap.elements[0].ref, "x"),
  };
  for (const [name, run] of Object.entries(actions)) {
    const c = controllerFor();
    const snap = await c.getPageState();
    await run(c, snap);
    advanced += 1;
    assert.equal(c.getCurrentSnapshot(), null, `${name} must force a fresh observation`);
  }
  assert.equal(advanced, Object.keys(actions).length);
});

test("a field that reformats what you type has not failed", async () => {
  const typed = (text, value) =>
    verifyOutcome({
      model: { verify: async () => { throw new Error("model should not be needed"); } },
      decision: { action: { type: "type", target: "e1", text }, expectedOutcome: "the field is filled" },
      actionResult: { ok: true }, before: page(), after: page(),
      diff: { ...NO_CHANGE, textChanged: true, summary: "text changed" },
      extracted: { ok: true, label: "Field", value },
    });

  for (const [text, value, kind] of [
    ["5551234567", "(555) 123-4567", "phone"],
    ["4242424242424242", "4242 4242 4242 4242", "card"],
    ["1200", "$1,200.00", "currency"],
    ["Hello Bob", "Hello Bob", "plain"],
  ]) {
    const v = await typed(text, value);
    assert.equal(v.success, true, `${kind} field: a reformatted value is the text you typed`);
  }
  // The whole point: a false failure here is what triggered the retype loop,
  // and `type` appends, so the retry duplicated the content.
  const reformatted = await typed("5551234567", "(555) 123-4567");
  assert.match(reformatted.evidence, /do not type it again/i);
});

test("elements disappearing is a page change", async () => {
  const v = await verifyOutcome({
    model: { verify: async () => ({ success: true, evidence: "the dialog closed", reason: "", next: "continue" }) },
    decision: { action: { type: "click", target: "e1" }, expectedOutcome: "the cookie banner is dismissed" },
    actionResult: { ok: true },
    before: page({ visibleText: "We use cookies. Got it. Product page" }),
    after: page({ visibleText: "Product page" }),
    diff: {
      urlChanged: false, titleChanged: false, textChanged: true,
      newLabels: [], removedLabels: ["we use cookies", "got it"],
      summary: 'Gone: "We use cookies", "Got it"',
    },
  });
  assert.notEqual(v.reason, "no observable page change after the action");
  assert.notEqual(v.success, false, "dismissing, closing and deleting leave nothing new behind");
});

test("unrelated actions do not share one retry budget", () => {
  const rt = createRecoveryTracker();
  const sig = (a) => rt.signatureOf({ action: a });
  const distinct = [
    [sig({ type: "click_coord", x: 10, y: 10 }), sig({ type: "click_coord", x: 900, y: 700 })],
    [sig({ type: "press_key", key: "Escape" }), sig({ type: "press_key", key: "Enter" })],
    [sig({ type: "select", target: "e5", value: "Blue" }), sig({ type: "select", target: "e5", value: "Red" })],
    [sig({ type: "drag", target: "e1", toX: 10, toY: 10 }), sig({ type: "drag", target: "e1", toX: 800, toY: 600 })],
  ];
  for (const [a, b] of distinct) assert.notEqual(a, b, "different targets are different actions");
  // A genuine retry of the same thing still collides, or the ladder never fires.
  assert.equal(sig({ type: "click_coord", x: 500, y: 500 }), sig({ type: "click_coord", x: 503, y: 498 }));
});

// ── safety gate ─────────────────────────────────────────────────────────────

test("the gate reads the labels products actually ship", () => {
  const snap = (label) => ({ byRef: new Map([["e1", { ref: "e1", label, role: "button" }]]), elements: [] });
  const risk = (label) => executor.classifyActionRisk(
    { kind: "act", action: { type: "click", target: "e1" }, expectedOutcome: "" }, snap(label));

  const mustPause = [
    // money — every one of these ran unattended before
    "Order now", "Confirm & pay", "Submit order", "Buy with 1-Click", "Pre-order",
    "Place bid", "Send money", "Pay with PayPal", "Renew now", "Start free trial",
    "Buy now", "Place your order", "Pay $49.00", "Complete purchase", "Book now", "€120",
    // destruction
    "Move to trash", "Discard draft", "Remove member", "Revoke", "Overwrite",
    "Clear all", "Reset to defaults", "Delete", "Leave workspace", "Cancel subscription",
    // outbound — the second-stage confirm is where a send commits
    "Confirm and send", "Yes, send it", "Send now", "Share", "Publish", "Send invitations",
  ];
  // A committing verb followed by an informational noun is still an action —
  // the exemption that lets "Order history" through must not read these as
  // navigation.
  const mustAlsoPause = [
    "Delete history", "Clear history", "Delete all records", "Remove payment method",
    "Remove all details", "Delete order", "Revoke access", "Reset settings", "Pay invoice",
  ];
  for (const label of mustAlsoPause) {
    assert.equal(risk(label), "consequential", `"${label}" is an action, not a listing`);
  }

  const mustRun = [
    // reaching checkout is encouraged; only the button that charges is gated
    "Checkout", "Proceed to checkout", "Continue to payment",
    // ordinary flow controls
    "Confirm", "Save", "Continue", "Next", "Done", "Allow", "Connect", "Link account",
    // ordinary editing and shopping
    "Add to cart", "Remove from cart", "Remove filter", "Reset filters", "Clear search", "Rename",
    // navigation that merely mentions a committing word
    "Order history", "Purchase history", "Payment methods", "Track order", "Manage subscription",
    "Purchase details", "Order details", "Booking summary", "Delivery options", "Billing settings",
    // composing is not sending — Reply / Forward open a composer
    "New message", "Compose", "Draft", "Drafts", "Sent mail", "Sharing options",
    "Reply", "Reply all", "Forward",
  ];
  for (const label of mustPause) {
    assert.equal(risk(label), "consequential", `"${label}" must not run unattended`);
  }
  for (const label of mustRun) {
    assert.notEqual(risk(label), "consequential", `"${label}" must not stall the task`);
  }
});

test("the gate sees coordinate clicks and action payloads", () => {
  const bare = { byRef: new Map(), elements: [] };
  // A coordinate click has no element ref, so the label regexes had nothing to
  // read — on exactly the canvas surfaces where coordinates are the only option.
  assert.equal(
    executor.classifyActionRisk(
      { kind: "act", action: { type: "click_coord", x: 5, y: 5, label: "Delete forever" }, expectedOutcome: "" }, bare),
    "consequential",
  );
  // Enter in a composer sends with no button involved.
  const to = { byRef: new Map([["e1", { ref: "e1", label: "To", role: "textbox" }]]), elements: [] };
  assert.equal(
    executor.classifyActionRisk(
      { kind: "act", action: { type: "type", target: "e1", text: "all@co.com", pressEnter: true }, expectedOutcome: "" }, to),
    "consequential",
  );
  // The audience can be named by the payload rather than by the button or the
  // stated outcome — the gate never used to look at what the action carried.
  const send = { byRef: new Map([["e1", { ref: "e1", label: "Send", role: "button" }]]), elements: [] };
  const ask = "email our clients about the outage";
  assert.equal(
    executor.goalAuthorizesAction(ask, { action: { type: "click", target: "e1" }, expectedOutcome: "" }, send),
    true,
    "an ordinary send the user asked for still runs",
  );
  assert.equal(
    executor.goalAuthorizesAction(
      ask, { action: { type: "click", target: "e1", value: "All subscribers" }, expectedOutcome: "" }, send),
    false,
    "the same click with a whole-list audience in its payload needs an explicit send instruction",
  );
});

test("a read-only request does not pre-authorize a send", () => {
  const send = { byRef: new Map([["e1", { ref: "e1", label: "Send", role: "button" }]]), elements: [] };
  const decision = { action: { type: "click", target: "e1" }, expectedOutcome: "the email is sent" };
  const authorized = (ask) => executor.goalAuthorizesAction(ask, decision, send);

  // "email" here is a noun. Reading it as intent authorized a real send.
  for (const ask of [
    "find Bob's email address",
    "look up the email address for support",
    "check my inbox for the invoice",
    "read the last message from Sarah",
    "what did their reply say",
  ]) {
    assert.equal(authorized(ask), false, `"${ask}" is a lookup, not an instruction to send`);
  }
  // Verbs still authorize.
  for (const ask of [
    "email Bob the summary",
    "send the reply now",
    "reply to Sarah saying yes",
    "forward me the invoice",
    "share the doc with the team",
  ]) {
    assert.equal(authorized(ask), true, `"${ask}" asks for delivery`);
  }
  // Preparing still stops at the draft.
  assert.equal(authorized("draft an email to Bob"), false);
  assert.equal(authorized("draft and send an email to Bob"), true);
});

// ── constraints ─────────────────────────────────────────────────────────────

test("a constraint the page has overtaken can be dropped", async () => {
  const task = taskState.createTask({ goal: "book a table at Luigi's" });
  taskState.setPlan(task, { plan: ["Open the site"], constraints: ["All work happens on luigis.example.com"] });

  // The replan model returning [] used to be indistinguishable from saying
  // nothing, so the old constraint was written straight back and replanning —
  // the designed escape from a bad plan — could never relax one.
  await planner.replanTask({
    model: { plan: async () => ({ plan: ["Follow the booking partner link"], constraints: [], knownFacts: {}, skills: [] }) },
    task, snapshot: null, reason: "the only booking route is an outbound link",
  });
  assert.deepEqual(task.constraints, [], "an empty array means none still apply");

  // Silence still preserves what we had.
  const task2 = taskState.createTask({ goal: "g" });
  taskState.setPlan(task2, { plan: ["a"], constraints: ["Budget is $200"] });
  await planner.replanTask({
    model: { plan: async () => ({ plan: ["b"], constraints: null, knownFacts: {}, skills: [] }) },
    task: task2, snapshot: null, reason: "r",
  });
  assert.deepEqual(task2.constraints, ["Budget is $200"], "saying nothing must not drop a constraint");

  // And the actor's own view wins over the replanner's.
  const task3 = taskState.createTask({ goal: "g" });
  taskState.setPlan(task3, { plan: ["a"], constraints: ["Stay on example.com", "Budget is $200"] });
  await planner.replanTask({
    model: { plan: async () => ({ plan: ["b"], constraints: ["Stay on example.com", "Budget is $200"], knownFacts: {}, skills: [] }) },
    task: task3, snapshot: null, reason: "r", constraints: ["Budget is $200"],
  });
  assert.deepEqual(task3.constraints, ["Budget is $200"]);
});

test("a hallucinated skill name never enters task state", async () => {
  const task = taskState.createTask({ goal: "g" });
  taskState.setPlan(task, { plan: ["a"] });
  await planner.replanTask({
    model: {
      plan: async () => ({
        plan: ["b"], constraints: null, knownFacts: {},
        skills: ["research", "email-marketing", "../../../etc/passwd"],
      }),
    },
    task, snapshot: null, reason: "r",
  });
  assert.deepEqual(task.skills, ["research"]);
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test("stop prevents the action, not just the next round", async () => {
  const fake = createFakeBrowser({
    url: "https://shop.example.com", text: "Checkout",
    elements: [makeElement({ name: "pay", label: "Place your order" })],
  });
  const ac = new AbortController();
  const model = createScriptedModel({
    plan: { plan: ["Click it"] },
    decisions: [
      // Abort fires while the model is deciding — which is when people press
      // Stop. The round had already passed its abort check at the top.
      (ctx) => { ac.abort(); return { kind: "act", action: { type: "click", target: refFrom(ctx) }, expectedOutcome: "ordered" }; },
      { kind: "finish", answer: "done", factsLearned: ["x"] },
    ],
  });
  const r = await runTask(fake, model, { goal: "buy it", signal: ac.signal, onApprovalNeeded: async () => true });
  assert.equal(r.status, "failed");
  assert.equal(
    fake.state.calls.filter((c) => c.type === "click").length, 0,
    "Stop on a checkout page must not place the order",
  );
});

test("a model outage degrades instead of killing the task", async () => {
  const model = (status) =>
    createAgentModel({
      apiBase: "https://api.test", getAuthToken: async () => "t",
      timeoutMs: 500,
      fetchImpl: async () => ({
        ok: status < 400, status,
        json: async () => ({ ok: true, json: { plan: ["a"] } }),
        text: async () => "err", headers: { get: () => null },
      }),
    });
  // Only 404 used to raise AgentModelUnavailableError; an expired token or a
  // rate limit killed the run with "Could not decide the next step".
  for (const status of [401, 403, 404, 429, 500, 502, 503]) {
    await assert.rejects(
      () => model(status).plan({ system: "s", user: "u" }),
      AgentModelUnavailableError,
      `HTTP ${status} should fall back, not fail the task`,
    );
  }
  // A genuinely malformed request is still a bug worth surfacing.
  await assert.rejects(() => model(400).plan({ system: "s", user: "u" }), (e) => {
    assert.ok(!(e instanceof AgentModelUnavailableError));
    return true;
  });
});

test("an in-flight model call is cancellable and cannot hang forever", async () => {
  let sawSignal = false;
  const m = createAgentModel({
    apiBase: "https://api.test", getAuthToken: async () => "t", timeoutMs: 50,
    fetchImpl: async (_u, init) => {
      sawSignal = !!init?.signal;
      // Never resolves on its own — only the timeout or the caller's abort ends it.
      return new Promise((_res, rej) => init?.signal?.addEventListener?.("abort", () => rej(new Error("aborted")), { once: true }));
    },
  });
  await assert.rejects(() => m.plan({ system: "s", user: "u" }), AgentModelUnavailableError);
  assert.equal(sawSignal, true, "a Stop has to be able to cancel a request already in flight");
});

test("grounding mode comes from the caller, never from the environment", () => {
  const prev = process.env.LYKN_BROWSER_GROUNDING;
  process.env.LYKN_BROWSER_GROUNDING = "holo";
  try {
    // A variable left set in a shell or launch profile used to switch the
    // shipping agent into eval grounding, which hard-fails when the grounding
    // endpoint is unavailable.
    assert.equal(resolveGroundingMode(""), "refs");
    assert.equal(resolveGroundingMode(undefined), "refs");
    assert.equal(resolveGroundingMode("holo"), "holo", "an explicit caller still gets what it asked for");
  } finally {
    if (prev === undefined) delete process.env.LYKN_BROWSER_GROUNDING;
    else process.env.LYKN_BROWSER_GROUNDING = prev;
  }
});

// ── memory ──────────────────────────────────────────────────────────────────

test("what a run learns about the user is written down", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-mem-"));
  const mem = createMemoryStore({ userDataPath: dir });
  assert.equal(typeof mem.rememberUserFacts, "function", "the user half of memory needs a write path");
  await mem.rememberUserFacts(["Refers to the quarterly deck as 'the pack'"]);
  const back = await mem.getUserMemory();
  assert.match(back, /the pack/);
  // Secrets are still refused.
  await mem.rememberUserFacts(["Their password is hunter2"]);
  assert.doesNotMatch(await mem.getUserMemory(), /hunter2/);
});

test("notes are readable back for every host, including single-label ones", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-mem-"));
  const mem = createMemoryStore({ userDataPath: dir });
  for (const host of ["mailchimp.com", "app.mailchimp.com", "localhost", "intranet"]) {
    await mem.rememberWebsiteNotes(host, [`Campaigns live under Create on ${host}`]);
    assert.match(await mem.getWebsiteMemory(host), new RegExp(host.replace(".", "\\.")), `${host} must read back`);
  }
});

test("a run that fails still records what it learned about the site", async () => {
  const learned = [];
  const fake = createFakeBrowser({
    url: "https://tricky.example.com", text: "nothing works here",
    elements: [makeElement({ name: "b", label: "Go" })],
  });
  const model = createScriptedModel({
    plan: { plan: ["Try"] },
    decisions: [(ctx) => ({ kind: "act", action: { type: "click", target: refFrom(ctx) }, expectedOutcome: "something happens" })],
    verify: () => ({ success: false, evidence: "", reason: "nothing moved", next: "recover" }),
  });
  model.learn = async () => ({ notes: ["The Go button on this site does nothing until a plan is chosen"], userNotes: [] });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-mem-"));
  const memory = createMemoryStore({ userDataPath: dir });
  const original = memory.rememberWebsiteNotes;
  memory.rememberWebsiteNotes = async (host, notes) => { learned.push({ host, notes }); return original(host, notes); };

  const r = await runTask(fake, model, { memory, maxRounds: 6 });
  assert.equal(r.ok, false, "this run is meant to fail");
  // Learning runs in the background so the answer is never delayed by it;
  // `learning` is the handle that says the notes are actually on disk.
  await r.learning;
  assert.ok(learned.length > 0, "the run with the most to teach is the one that lost");
  assert.equal(learned[0].host, "tricky.example.com");
});

test("the answer is never delayed by post-run learning", async () => {
  const fake = createFakeBrowser({
    url: "https://slowlearn.example.com", text: "nothing works here",
    elements: [makeElement({ name: "b", label: "Go" })],
  });
  const model = createScriptedModel({
    plan: { plan: ["Try"] },
    decisions: [(ctx) => ({ kind: "act", action: { type: "click", target: refFrom(ctx) }, expectedOutcome: "something happens" })],
    verify: () => ({ success: false, evidence: "", reason: "nothing moved", next: "recover" }),
  });
  let learnSettled = false;
  model.learn = () =>
    new Promise((resolve) =>
      setTimeout(() => {
        learnSettled = true;
        resolve({ notes: ["a durable note about this site"], userNotes: [] });
      }, 150),
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-mem-"));
  const r = await runTask(fake, model, { memory: createMemoryStore({ userDataPath: dir }), maxRounds: 6 });
  assert.equal(learnSettled, false, "the result must land before the learn call finishes");
  await r.learning;
  assert.equal(learnSettled, true, "the learning handle must settle once the notes are written");
});

// ── degradation and budgets ─────────────────────────────────────────────────

test("asking permission is a punt, however it is worded", () => {
  const { runBrowserAgentTask: _r } = require("./index.cjs");
  // requiresHumanInput is internal; exercise it through the loop's behaviour.
  // "Do you want me to sign in?" contains "sign in", so the keyword test alone
  // let the agent end the run by asking to do something it should just do.
  const fake = createFakeBrowser({ url: "https://app.example.com", text: "Sign in page",
    elements: [makeElement({ name: "u", label: "Email", tag: "input", role: "textbox" })] });
  const asked = [];
  const model = createScriptedModel({
    plan: { plan: ["Sign in"] },
    decisions: [
      { kind: "ask_user", question: "Do you want me to sign in with the saved account?" },
      { kind: "finish", answer: "signed in", factsLearned: ["the account was already signed in"] },
    ],
    onDecide: (ctx) => asked.push(ctx.user),
  });
  return runTask(fake, model, { onNeedsUser: async (r) => { asked.push(r.question); return null; } })
    .then((r) => {
      assert.equal(r.status, "completed", "a permission question must be pushed back, not end the run");
      assert.ok(
        // Permission asks now get their own answer: go and do it, and the
        // safety gate will confirm at the committing click if one is coming.
        // (The generic "settle it yourself" pushback still covers the other
        // kinds of punt.)
        asked.some((t) => /asked the user for permission|settle yourself/i.test(String(t))),
        "the agent should be told to proceed rather than ask",
      );
    });
});

test("a website playbook is not evicted by the notes a run wrote itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-mem-"));
  const mem = createMemoryStore({ userDataPath: dir });
  // mailchimp.com ships a hand-written playbook; the run writes its own notes
  // against the regional host it actually visited.
  const host = "us21.admin.mailchimp.com";
  await mem.rememberWebsiteNotes(host, ["The regional host for this account is us21"]);
  const text = await mem.getWebsiteMemory(host);
  const seedAt = text.indexOf("Mailchimp");
  const learnedAt = text.indexOf("regional host for this account");
  assert.ok(learnedAt >= 0, "the run's own notes are there");
  if (seedAt >= 0) {
    assert.ok(seedAt < learnedAt, "the curated playbook comes first, so a cap cannot evict it");
  }
});

test("a page that could not be read is not reported as an empty page", () => {
  const failed = buildSnapshot({ url: "https://x.example", title: "X", catalog: [], text: "" });
  failed.collectorFailed = true;
  assert.match(formatSnapshotForModel(failed), /could not be read this round/i);
  const empty = buildSnapshot({ url: "https://x.example", title: "X", catalog: [], text: "" });
  assert.doesNotMatch(formatSnapshotForModel(empty), /could not be read/i);
});

test("truncated page text says it was truncated", () => {
  const long = buildSnapshot({ url: "u", title: "t", catalog: [], text: "x".repeat(6000) });
  assert.match(formatSnapshotForModel(long, { maxTextChars: 5000 }), /1000 more characters/);
});

test("settle does not throw the run away when the tab is gone", async () => {
  const controller = createBrowserController({
    webContents: { isDestroyed: () => true, getURL: () => "", getTitle: () => "" },
    actuator: { async waitForLoad() {}, async waitForDomSettle() {} },
  });
  await controller.settle(); // must resolve, not reject
});

test("a checkbox reads back as its state, not as an empty field", async () => {
  const v = await verifyOutcome({
    model: { verify: async () => { throw new Error("model should not be needed"); } },
    decision: { action: { type: "extract", target: "e1" }, expectedOutcome: "I can see the setting" },
    actionResult: { ok: true, label: "Email me updates", value: "", checked: true },
    before: page(), after: page(), diff: NO_CHANGE,
  });
  assert.match(v.evidence, /is checked/);
});

test("a controller that cannot screenshot does not throw the run away at the visual rung", async () => {
  // The visual recovery rung was the one capture site with no guard, while the
  // other three all use `.catch(() => null)` and `shot?.ok`. The shipped
  // controller swallows its own capture errors, so this is a contract with the
  // injected dependency rather than a live outage: a controller that rejects
  // (or answers with nothing) threw a plain Error straight out of the loop,
  // which the caller rethrows rather than falling back — losing a task that
  // only wanted a look at the page.
  const named = Array.from({ length: 10 }, (_, i) => makeElement({
    name: `b${i}`, role: "button", label: `Button ${i}`,
  }));
  const fake = createFakeBrowser({ elements: named });
  const controller = createBrowserController({ webContents: fake.webContents, actuator: fake.actuator });
  controller.screenshot = async () => { throw new Error("capture device busy"); };
  // A coordinate click keeps the same recovery signature across rounds
  // (element refs are re-minted under a new generation on every observation),
  // so the ladder genuinely reaches its visual rung.
  const model = createScriptedModel({
    decisions: [{ kind: "act", action: { type: "click_coord", x: 500, y: 500, label: "Button 1" }, expectedOutcome: "something happens" }],
    verify: () => ({ success: false, evidence: "", reason: "nothing moved", next: "recover" }),
  });

  // Recovery escalates to `visual` on the third failure of the same action.
  const result = await runTask(fake, model, { controller, maxRounds: 10 });
  assert.equal(result.ok, false, "the task still fails — it just fails as a task, not as a crash");
  assert.match(result.answer, /repeated attempts failed/i);
});
