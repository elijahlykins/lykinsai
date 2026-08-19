// Tests for the harness safety guard. Offline: the guard is a pure wrapper, so
// a fake controller is enough and no Electron is involved.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createEvalGuard, DEFAULT_MAX_HOSTS } = require("./guard.cjs");

/** A controller that records what actually reached it. */
function fakeController({ elements = {}, url = "https://example.com/" } = {}) {
  const calls = [];
  const byRef = new Map(Object.entries(elements));
  const record = (name) => async (...args) => {
    calls.push({ name, args });
    return { ok: true };
  };
  return {
    calls,
    getCurrentSnapshot: () => ({ byRef }),
    getPageState: async () => ({ ok: true, url }),
    navigate: record("navigate"),
    click: record("click"),
    clickCoord: record("clickCoord"),
    type: record("type"),
    typeAtCoord: record("typeAtCoord"),
    replaceText: record("replaceText"),
    select: record("select"),
    scroll: record("scroll"),
    extract: record("extract"),
    screenshot: record("screenshot"),
  };
}

const el = (label, extra = {}) => ({ label, raw: {}, ...extra });

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test("non-http schemes are blocked", async () => {
  const inner = fakeController();
  const { controller, blocks } = createEvalGuard({ controller: inner });
  for (const url of ["file:///etc/passwd", "data:text/html,x", "javascript:alert(1)"]) {
    const r = await controller.navigate(url);
    assert.equal(r.ok, false);
    assert.equal(r.error, "blocked_by_harness:scheme");
  }
  assert.equal(inner.calls.length, 0, "nothing reached the real controller");
  assert.equal(blocks.length, 3);
});

test("payment and auth hosts are blocked", async () => {
  const inner = fakeController();
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.navigate("https://www.paypal.com/checkout")).rule, "payment_host");
  assert.equal((await controller.navigate("https://checkout.stripe.com/pay")).rule, "payment_host");
  assert.equal((await controller.navigate("https://login.acme.com/")).rule, "auth_host");
  assert.equal((await controller.navigate("https://acme.com/signup")).rule, "auth_host");
  assert.equal(inner.calls.length, 0);
});

test("ordinary navigation passes through", async () => {
  const inner = fakeController();
  const { controller, blocks } = createEvalGuard({ controller: inner });
  const r = await controller.navigate("https://www.gamestop.com/stores");
  assert.equal(r.ok, true);
  assert.equal(blocks.length, 0);
  assert.equal(inner.calls[0].name, "navigate");
});

test("the distinct-host budget is enforced", async () => {
  const inner = fakeController();
  const { controller } = createEvalGuard({ controller: inner, maxHosts: 3 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await controller.navigate(`https://site${i}.com/`)).ok, true);
  }
  const r = await controller.navigate("https://site9.com/");
  assert.equal(r.rule, "host_budget");
});

test("hosts reached by link-following still count against the budget", async () => {
  // getPageState is how the guard sees a navigation it did not perform.
  const inner = fakeController({ url: "https://drifted-a.com/" });
  const guard = createEvalGuard({ controller: inner, maxHosts: 1 });
  await guard.controller.getPageState();
  const r = await guard.controller.navigate("https://drifted-b.com/");
  assert.equal(r.rule, "host_budget");
  assert.deepEqual(guard.hosts.sort(), ["drifted-a.com", "drifted-b.com"]);
});

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

test("money, destructive, and outbound clicks are blocked by label", async () => {
  const inner = fakeController({
    elements: {
      e1: el("Place your order"),
      e2: el("Delete account"),
      e3: el("Send message"),
      e4: el("Add to cart"),
      e5: el("Show more results"),
    },
  });
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.click("e1")).rule, "spends_money");
  assert.equal((await controller.click("e2")).rule, "destroys_data");
  assert.equal((await controller.click("e3")).rule, "outbound");
  assert.equal((await controller.click("e4")).ok, true, "add to cart is the task, not a purchase");
  assert.equal((await controller.click("e5")).ok, true);
  assert.equal(inner.calls.filter((c) => c.name === "click").length, 2);
});

test("the guard ignores whether the goal authorised the action", async () => {
  // The whole divergence from production: many benchmark goals say "message the
  // owner" or "share this", and production would let that click through. Here
  // there is no goal in scope at all — only the label.
  const inner = fakeController({ elements: { e1: el("Send") } });
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.click("e1")).rule, "outbound");
});

test("coordinate clicks are judged on the description the grounder used", async () => {
  const inner = fakeController();
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.clickCoord(10, 20, "Publish post")).rule, "outbound");
  assert.equal((await controller.clickCoord(10, 20, "the blue Search button")).ok, true);
});

test("an outbound word later in a label does not fire", async () => {
  // Anchored, like production: "Reply" is outbound, "Show replies" is not.
  const inner = fakeController({ elements: { e1: el("Show 12 replies") } });
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.click("e1")).ok, true);
});

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

test("typing into a password or card field is blocked", async () => {
  const inner = fakeController({
    elements: {
      e1: el("Password", { raw: { type: "password" } }),
      e2: el("Card number"),
      e3: el("CVV"),
      e4: el("Search"),
    },
  });
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.type("e1", "hunter2")).rule, "sensitive_field");
  assert.equal((await controller.type("e2", "1111")).rule, "sensitive_field");
  assert.equal((await controller.type("e3", "123")).rule, "sensitive_field");
  assert.equal((await controller.type("e4", "wireless headphones")).ok, true);
});

test("a card number or SSN is blocked whatever field it is going into", async () => {
  const inner = fakeController({ elements: { e1: el("Notes") } });
  const { controller, blocks } = createEvalGuard({ controller: inner });
  assert.equal((await controller.type("e1", "4111 1111 1111 1111")).rule, "sensitive_value");
  assert.equal((await controller.type("e1", "123-45-6789")).rule, "sensitive_value");
  assert.equal((await controller.type("e1", "90210")).ok, true);
  for (const b of blocks) {
    assert.ok(!/4111|6789/.test(b.detail), "the blocked value must never be recorded");
  }
});

test("replaceText and typeAtCoord are guarded too", async () => {
  const inner = fakeController({ elements: { e1: el("Password", { raw: { type: "password" } }) } });
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.replaceText("e1", "a", "b")).rule, "sensitive_field");
  assert.equal((await controller.typeAtCoord(1, 2, "x", { label: "CVV code" })).rule, "sensitive_field");
  assert.equal((await controller.typeAtCoord(1, 2, "boots", { label: "search box" })).ok, true);
});

// ---------------------------------------------------------------------------
// Shape and reporting
// ---------------------------------------------------------------------------

test("blocks look like failed actions so recovery handles them", async () => {
  const inner = fakeController({ elements: { e1: el("Buy now") } });
  const { controller } = createEvalGuard({ controller: inner });
  const r = await controller.click("e1");
  assert.deepEqual(Object.keys(r).sort(), ["blocked", "error", "ok", "rule"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /^blocked_by_harness:/);
});

test("unguarded methods pass through untouched", async () => {
  const inner = fakeController();
  const { controller } = createEvalGuard({ controller: inner });
  for (const m of ["select", "scroll", "extract", "screenshot"]) {
    assert.equal((await controller[m]("e1")).ok, true);
  }
  assert.deepEqual(inner.calls.map((c) => c.name), ["select", "scroll", "extract", "screenshot"]);
});

test("the guard exposes the full controller API", () => {
  const inner = fakeController();
  const { controller } = createEvalGuard({ controller: inner });
  for (const k of Object.keys(inner)) {
    if (k === "calls") continue;
    assert.ok(k in controller, `missing ${k}`);
  }
});

test("summary counts blocks by rule", async () => {
  const inner = fakeController({ elements: { e1: el("Send"), e2: el("Buy now") } });
  const guard = createEvalGuard({ controller: inner });
  await guard.controller.click("e1");
  await guard.controller.click("e2");
  await guard.controller.navigate("file:///x");
  assert.deepEqual(guard.summary().byRule, { outbound: 1, spends_money: 1, scheme: 1 });
  assert.equal(guard.summary().blocked, 3);
});

test("a throwing onBlock cannot turn into an action failure", async () => {
  const inner = fakeController({ elements: { e1: el("Send") } });
  const { controller, blocks } = createEvalGuard({
    controller: inner,
    onBlock: () => { throw new Error("reporting is down"); },
  });
  const r = await controller.click("e1");
  assert.equal(r.rule, "outbound");
  assert.equal(blocks.length, 1);
});

test("the default host budget is the documented one", () => {
  assert.equal(DEFAULT_MAX_HOSTS, 25);
});

// ---------------------------------------------------------------------------
// Descriptions, not labels — the holo-mode path
// ---------------------------------------------------------------------------

const { looksOutbound, stripLeadingFiller } = require("./guard.cjs");

test("outbound detection survives a grounder's description", () => {
  // Regression: an end-to-end run had refs blocking this click three times and
  // holo blocking it zero times, because holo aims with "the Send message
  // button" and the anchored pattern cannot match a string starting with "the".
  for (const desc of [
    "the Send message button",
    "the blue Send button",
    "a button labelled Send",
    "the small orange Share icon",
    "that Publish control",
    "the primary Submit button at the bottom",
  ]) {
    assert.ok(looksOutbound(desc), `should be outbound: ${desc}`);
  }
});

test("stripping filler does not turn read-only descriptions into outbound ones", () => {
  for (const desc of [
    "the Show replies link",
    "the blue Search button",
    "the first result in the list",
    "the Add to cart button",
    "the store hours section",
    "the Sort by price dropdown",
    "the post title at the top of the page",
  ]) {
    assert.ok(!looksOutbound(desc), `should NOT be outbound: ${desc}`);
  }
});

test("stripLeadingFiller is bounded and leaves the head word", () => {
  assert.equal(stripLeadingFiller("the small blue primary Send button"), "Send button");
  assert.equal(stripLeadingFiller("Send"), "Send");
  assert.equal(stripLeadingFiller(""), "");
  assert.equal(stripLeadingFiller(null), "");
});

test("a described outbound click is blocked at the coordinate path", async () => {
  const inner = fakeController();
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.clickCoord(1, 2, "the Send message button")).rule, "outbound");
  assert.equal((await controller.clickCoord(1, 2, "the blue Search button")).ok, true);
  assert.equal(inner.calls.length, 1);
});

test("money and destructive patterns already match inside a description", () => {
  // These are unanchored in production, so they need no filler stripping —
  // asserted so a future tightening cannot silently break the holo arms.
  const inner = fakeController();
  const { controller } = createEvalGuard({ controller: inner });
  return Promise.all([
    controller.clickCoord(1, 2, "the Place your order button").then((r) => assert.equal(r.rule, "spends_money")),
    controller.clickCoord(1, 2, "the Delete account link").then((r) => assert.equal(r.rule, "destroys_data")),
  ]);
});

test("an outbound verb buried in a description still fires when it names a control", () => {
  assert.ok(looksOutbound("the icon that sends the message"));
  assert.ok(looksOutbound("the button to reply to this thread"));
  assert.ok(!looksOutbound("a paragraph about sending parcels"), "prose is not a control");
});

test("ambiguous plurals stay nouns", () => {
  // These are real Online-Mind2Web task phrasings; blocking them would fail
  // read-only tasks and quietly shrink the sample.
  for (const d of [
    "the link showing the most replies",
    "the list of latest posts",
    "the comments section",
    "the number of shares displayed",
  ]) {
    assert.ok(!looksOutbound(d), `should NOT be outbound: ${d}`);
  }
});

test('a bare Submit button is ordinary form submission, not an outbound send', async () => {
  // Regression from the first live run: this blocked the search button on a
  // DMV information page. Production uses "submit for review" for this reason.
  const inner = fakeController({ elements: { e1: el("Submit"), e2: el("Submit for review"), e3: el("Submit comment") } });
  const { controller } = createEvalGuard({ controller: inner });
  assert.equal((await controller.click("e1")).ok, true, "bare Submit must pass");
  assert.equal((await controller.click("e2")).rule, "outbound");
  assert.equal((await controller.click("e3")).rule, "outbound");
});
