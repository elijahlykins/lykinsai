/**
 * Layout-change safety tests.
 *
 * The UI can resize the browser while the agent is mid-round — the agent rail
 * opening beside the docked browser shrinks the view by ~20% in one step — and
 * everything positional in the current observation (screenshot coordinates,
 * element geometry, inView flags) then describes a layout that no longer
 * exists. These tests pin the two defenses: the controller refuses
 * coordinate-aimed actions when the viewport has drifted since the observe,
 * and the screenshot mapper reports a capture as stale instead of blending it
 * into a systematic miss.
 *
 * Run: node --test electron/browser-agent/layout.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { createBrowserController } = require("./browser/controller.cjs");
const { mapNormCoordToClient } = require("../ownedBrowserAct.cjs");
const verifier = require("./runtime/verifier.cjs");

// ── controller: the layout guard ────────────────────────────────────────────

function item(overrides = {}) {
  return {
    uid: 1,
    tag: "button",
    type: "",
    role: "",
    selector: "#go",
    label: "Go",
    clientX: 10,
    clientY: 10,
    inView: true,
    ...overrides,
  };
}

/**
 * Harness whose catalog reports the viewport it was measured under, and whose
 * live viewport can be changed between calls — the shape of a rail opening.
 */
function makeHarness({ snapshotViewport = { w: 1400, h: 900 }, withMetrics = true } = {}) {
  const calls = [];
  let liveViewport = { ...snapshotViewport };
  const actuator = {
    getDOMCatalog: async () => ({
      ok: true,
      items: [item()],
      url: "https://shop.test/",
      viewport: snapshotViewport,
    }),
    getPageContext: async () => ({ ok: true, url: "https://shop.test/", title: "Shop", text: "hi" }),
    runAction: async (_wc, action) => {
      calls.push(action);
      return { ok: true };
    },
    waitForLoad: async () => {},
  };
  if (withMetrics) {
    actuator.getViewportMetrics = async () => ({ ...liveViewport, dpr: 1, ox: 0, oy: 0 });
  }
  const webContents = { isDestroyed: () => false, getURL: () => "https://shop.test/", getTitle: () => "Shop" };
  const controller = createBrowserController({ webContents, actuator });
  return {
    calls,
    controller,
    resizeTo: (w, h) => {
      liveViewport = { w, h };
    },
  };
}

test("a coordinate click after a resize is refused, not fired at the old layout", async () => {
  const { calls, controller, resizeTo } = makeHarness();
  await controller.getPageState();
  resizeTo(1120, 900); // the rail opened: 280px gone from the width
  const res = await controller.clickCoord(500, 500, "the blue button");
  assert.equal(res.ok, false);
  assert.equal(res.error, "layout_changed");
  assert.match(res.hint, /1400x900 -> 1120x900/, "the hint must say what changed");
  assert.equal(calls.length, 0, "nothing may reach the actuator on a stale layout");
  assert.equal(controller.getCurrentSnapshot(), null, "the stale observation must be invalidated");
});

test("typing at a point after a resize is refused the same way", async () => {
  const { calls, controller, resizeTo } = makeHarness();
  await controller.getPageState();
  resizeTo(1120, 900);
  const res = await controller.typeAtCoord(500, 500, "hello");
  assert.equal(res.error, "layout_changed");
  assert.equal(calls.length, 0);
});

test("a coordinate drag after a resize is refused; a ref-to-ref drag is not", async () => {
  const { calls, controller, resizeTo } = makeHarness();
  await controller.getPageState();
  resizeTo(1120, 900);
  const coordDrag = await controller.drag({ x: 100, y: 100 }, { x: 300, y: 300 });
  assert.equal(coordDrag.error, "layout_changed");
  assert.equal(calls.length, 0);
  // Refs re-resolve by selector at act time, so geometry drift does not
  // invalidate them — but the observation was invalidated above, so re-observe
  // first, exactly as the loop would.
  await controller.getPageState();
  const refDrag = await controller.drag("e1", "e1");
  assert.equal(refDrag.ok, true, "ref-aimed actions must not pay the layout toll");
  assert.equal(calls.length, 1);
});

test("ordinary drift-free coordinate clicks pass through untouched", async () => {
  const { calls, controller, resizeTo } = makeHarness();
  await controller.getPageState();
  resizeTo(1408, 900); // sub-1% jitter: scrollbars, rounding
  const res = await controller.clickCoord(500, 500);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
});

test("ref clicks are never blocked by viewport drift", async () => {
  const { calls, controller, resizeTo } = makeHarness();
  await controller.getPageState();
  resizeTo(1120, 900);
  const res = await controller.click("e1");
  assert.equal(res.ok, true, "selector re-resolution makes ref clicks resize-tolerant");
  assert.equal(calls.length, 1);
});

test("a peek-scroll between observe and act refuses the coordinate aim", async () => {
  const { calls, controller } = makeHarness();
  await controller.getPageState();
  // The user's wheel input invalidates the observation (see agentRuntime's
  // input listener) instead of seizing the browser — the run keeps going, but
  // a point read off the pre-scroll view must not be clicked.
  controller.invalidate();
  const res = await controller.clickCoord(500, 500);
  assert.equal(res.ok, false);
  assert.equal(res.error, "stale_view");
  assert.equal(calls.length, 0, "nothing may reach the actuator from a stale view");
});

test("an actuator without viewport reporting keeps the old behavior", async () => {
  const { calls, controller, resizeTo } = makeHarness({ withMetrics: false });
  await controller.getPageState();
  resizeTo(1120, 900);
  const res = await controller.clickCoord(500, 500);
  assert.equal(res.ok, true, "the guard must degrade to a no-op, not a block");
  assert.equal(calls.length, 1);
});

test("a catalog that never measured its viewport keeps the old behavior", async () => {
  const calls = [];
  const actuator = {
    getDOMCatalog: async () => ({ ok: true, items: [item()], url: "https://shop.test/" }),
    getPageContext: async () => ({ ok: true, url: "https://shop.test/", title: "Shop", text: "hi" }),
    getViewportMetrics: async () => ({ w: 1120, h: 900 }),
    runAction: async (_wc, action) => {
      calls.push(action);
      return { ok: true };
    },
    waitForLoad: async () => {},
  };
  const webContents = { isDestroyed: () => false, getURL: () => "https://shop.test/", getTitle: () => "Shop" };
  const controller = createBrowserController({ webContents, actuator });
  await controller.getPageState();
  const res = await controller.clickCoord(500, 500);
  assert.equal(res.ok, true, "no recorded baseline means nothing to compare against");
  assert.equal(calls.length, 1);
});

// ── mapper: stale captures are reported, not blended ────────────────────────

test("a capture from before a real resize is reported stale", () => {
  const mapped = mapNormCoordToClient(
    500,
    500,
    { w: 1120, h: 900 },
    { captureCssW: 1400, captureCssH: 900 },
  );
  assert.equal(mapped.stale, true, "a 20% width change is a reflow, not jitter");
});

test("capture-vs-viewport rounding jitter is not stale", () => {
  const mapped = mapNormCoordToClient(
    500,
    500,
    { w: 1210, h: 800 },
    { captureCssW: 1200, captureCssH: 800 },
  );
  assert.equal(mapped.stale, false);
  assert.equal(mapped.x, 600, "a near-match still trusts the capture the model saw");
});

test("no capture metadata means nothing can be stale", () => {
  const mapped = mapNormCoordToClient(500, 500, { w: 1200, h: 800 }, null);
  assert.equal(mapped.stale, false);
});

// ── verifier: same-site navigation ──────────────────────────────────────────

/** verifyOutcome for a navigate whose deterministic path must never call a model. */
async function verifyNavigate(wantedUrl, landedUrl) {
  return verifier.verifyOutcome({
    model: {
      verify: async () => {
        throw new Error("the deterministic navigate path must not consult the model");
      },
    },
    decision: { action: { type: "navigate", url: wantedUrl }, expectedOutcome: "" },
    actionResult: { ok: true },
    before: null,
    after: { url: landedUrl, title: "t", elements: [], visibleText: "" },
    diff: null,
  });
}

test("landing on a regional or admin subdomain of the requested site is arrival", async () => {
  const v = await verifyNavigate("https://mailchimp.com/campaigns", "https://us21.admin.mailchimp.com/campaigns/");
  assert.equal(v.success, true, "products shard across subdomains; that is not a failed navigation");
});

test("two-part country TLDs compare by registrable domain, not by suffix", async () => {
  const same = await verifyNavigate("https://example.co.uk/", "https://shop.example.co.uk/");
  assert.equal(same.success, true);
  const cross = await verifyNavigate("https://example.co.uk/", "https://other.co.uk/");
  assert.equal(cross.success, false, "sharing .co.uk does not make two sites the same site");
});

test("landing on a different site is still a miss", async () => {
  const v = await verifyNavigate("https://mailchimp.com/", "https://evil.example/");
  assert.equal(v.success, false);
});

test("a sign-in subdomain on the right site is a wall, not arrival", async () => {
  const v = await verifyNavigate("https://mailchimp.com/campaigns", "https://login.mailchimp.com/");
  assert.equal(v.success, false);
  assert.match(v.reason, /sign-in/i, "the reason must say what kind of page was served");
});

test("a consent subdomain is caught even though it is the same registrable domain", async () => {
  const v = await verifyNavigate("https://example.com/pricing", "https://consent.example.com/gate");
  assert.equal(v.success, false, "the old consent.example.com regression must stay closed");
});

test("deliberately navigating to a sign-in page is arrival, not a wall", async () => {
  const v = await verifyNavigate("https://login.mailchimp.com/", "https://login.mailchimp.com/");
  assert.equal(v.success, true, "asking for the wall and reaching it is success");
});
