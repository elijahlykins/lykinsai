/**
 * Stable element reference tests.
 *
 * Run: node --test electron/browser-agent/refs.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");

const { REF_STORE_JS } = require("../ownedBrowserAct.cjs");

/** Run REF_STORE_JS in a throwaway realm and return its __lyknUid. */
function makeUidRealm() {
  const sandbox = { window: {}, WeakMap };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(REF_STORE_JS, sandbox);
  return {
    uid: (el) => vm.runInContext("__lyknUid", sandbox)(el),
    sandbox,
  };
}

test("the same element keeps the same uid across calls", () => {
  const { uid } = makeUidRealm();
  const a = { tag: "a" };
  const b = { tag: "b" };
  const first = uid(a);
  uid(b);
  assert.equal(uid(a), first, "re-reading an element must return its original uid");
});

test("a new element inserted before an existing one does not renumber it", () => {
  const { uid } = makeUidRealm();
  const checkout = {};
  const checkoutUid = uid(checkout);
  const banner = {};
  const bannerUid = uid(banner);
  assert.notEqual(bannerUid, checkoutUid);
  assert.equal(uid(checkout), checkoutUid, "the pre-existing element must not be renumbered");
});

test("uids are never reused after an element is dropped", () => {
  const { uid } = makeUidRealm();
  const first = uid({});
  const second = uid({});
  const third = uid({});
  assert.deepEqual([second - first, third - second], [1, 1], "uids increase monotonically");
});

test("the store survives being re-declared, as a second executeJavaScript call would", () => {
  const { uid, sandbox } = makeUidRealm();
  const el = {};
  const before = uid(el);
  vm.runInContext(REF_STORE_JS, sandbox);
  const after = vm.runInContext("__lyknUid", sandbox)(el);
  assert.equal(after, before, "re-running the preamble must not reset the store");
});

const { buildSnapshot, formatSnapshotForModel } = require("./browser/snapshot.cjs");

function item(overrides = {}) {
  return {
    uid: 1,
    tag: "button",
    type: "",
    role: "",
    selector: "body > button",
    label: "Checkout",
    value: "",
    checked: false,
    href: "",
    clientX: 10,
    clientY: 10,
    inView: true,
    ...overrides,
  };
}

test("refs come from uid, not array position", () => {
  const snap = buildSnapshot({
    catalog: [item({ uid: 7, label: "Checkout" }), item({ uid: 4, label: "Help" })],
  });
  assert.equal(snap.elements[0].ref, "e7");
  assert.equal(snap.elements[1].ref, "e4");
});

test("an element keeps its ref when something is inserted above it", () => {
  const checkout = item({ uid: 7, label: "Checkout" });
  const before = buildSnapshot({ catalog: [checkout] });
  const after = buildSnapshot({ catalog: [item({ uid: 9, label: "Cookie banner" }), checkout] });
  assert.equal(before.byRef.get("e7").label, "Checkout");
  assert.equal(after.byRef.get("e7").label, "Checkout", "the ref must still name the same control");
});

test("sub-frame refs are namespaced by frame", () => {
  const snap = buildSnapshot({
    catalog: [item({ uid: 3, label: "Outer" }), item({ uid: "7_3", label: "Inner", frameHost: "embed.example" })],
  });
  assert.equal(snap.elements[0].ref, "e3");
  assert.equal(snap.elements[1].ref, "e7_3");
});

test("catalog items with no uid still get a usable positional ref", () => {
  const snap = buildSnapshot({ catalog: [item({ uid: undefined, label: "Legacy" })] });
  assert.match(snap.elements[0].ref, /^e/);
  assert.equal(snap.byRef.get(snap.elements[0].ref).label, "Legacy");
});

test("locators prefer a real DOM id, then href, then role+label", () => {
  const snap = buildSnapshot({
    catalog: [
      item({ uid: 1, selector: "#pay-now", label: "Pay" }),
      item({ uid: 2, tag: "a", selector: "div > a", href: "https://x.test/cart", label: "Cart" }),
      item({ uid: 3, selector: "div > button:nth-of-type(2)", label: "Apply" }),
    ],
  });
  assert.equal(snap.elements[0].loc, "css:#pay-now");
  assert.equal(snap.elements[1].loc, "href:/cart");
  assert.equal(snap.elements[2].loc, "role:button|Apply");
});

test("byLoc indexes elements by their locator", () => {
  const snap = buildSnapshot({ catalog: [item({ uid: 1, selector: "#pay-now", label: "Pay" })] });
  assert.equal(snap.byLoc.get("css:#pay-now").ref, "e1");
});

test("the rendered element line carries the locator", () => {
  const snap = buildSnapshot({ catalog: [item({ uid: 7, selector: "#pay-now", label: "Pay" })] });
  assert.match(formatSnapshotForModel(snap), /\[e7\] button "Pay".*loc=css:#pay-now/);
});

const { createBrowserController } = require("./browser/controller.cjs");

/** Minimal actuator: records the action it was handed and reports success. */
function makeHarness(catalog) {
  const calls = [];
  let items = catalog;
  const actuator = {
    getDOMCatalog: async () => ({ ok: true, items, url: "https://shop.test/" }),
    getPageContext: async () => ({ ok: true, url: "https://shop.test/", title: "Shop", text: "hi" }),
    runAction: async (_wc, action) => {
      calls.push(action);
      return { ok: true };
    },
    waitForLoad: async () => {},
  };
  const webContents = { isDestroyed: () => false, getURL: () => "https://shop.test/", getTitle: () => "Shop" };
  const controller = createBrowserController({ webContents, actuator });
  controller.__setCatalog = (next) => {
    items = next;
  };
  return { calls, controller };
}

test("a loc= target resolves to the element carrying that locator", async () => {
  const { calls, controller } = makeHarness([item({ uid: 7, selector: "#pay-now", label: "Pay" })]);
  await controller.getPageState();
  const res = await controller.click("loc=css:#pay-now");
  assert.equal(res.ok, true);
  assert.equal(calls[0].label, "Pay");
});

test("a uid ref still resolves normally", async () => {
  const { calls, controller } = makeHarness([item({ uid: 7, selector: "#pay-now", label: "Pay" })]);
  await controller.getPageState();
  const res = await controller.click("e7");
  assert.equal(res.ok, true);
  assert.equal(calls[0].label, "Pay");
});

test("an unknown ref that was on a previous page says so", async () => {
  const { controller } = makeHarness([item({ uid: 7, selector: "#pay-now", label: "Pay" })]);
  await controller.getPageState();
  controller.__setCatalog([item({ uid: 9, selector: "#help", label: "Help" })]);
  await controller.getPageState();
  const res = await controller.click("e7");
  assert.equal(res.ok, false);
  assert.equal(res.error, "unknown_reference");
  assert.match(res.hint, /Pay/, "the hint must name what the ref used to be");
});

test("an unknown ref never seen before does not invent history", async () => {
  const { controller } = makeHarness([item({ uid: 7, selector: "#pay-now", label: "Pay" })]);
  await controller.getPageState();
  const res = await controller.click("e999");
  assert.equal(res.error, "unknown_reference");
  assert.doesNotMatch(String(res.hint || ""), /Pay/);
});
