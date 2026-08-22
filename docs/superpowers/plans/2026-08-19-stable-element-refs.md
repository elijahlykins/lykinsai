# Stable Element Refs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every catalogued element a document-stable identity so a ref means the same element across snapshots, and give the model a `loc=` locator that survives a full re-render.

**Architecture:** Today `buildSnapshot` mints `ref = "e" + (i + 1)` — a position in the merged catalog array. Any DOM mutation renumbers every element after it, so `e12` can silently become a different control between rounds. We replace the positional index with a uid minted in page context and held in a `WeakMap` that lives for the document's lifetime, so the same element keeps the same number. On top of that we emit a `loc=` locator per element and teach `resolveRef` to accept it, giving the model a handle that outlives even a navigation.

**Tech Stack:** Node.js CommonJS, Electron `webContents.executeJavaScript`, `node:test` + `node:assert`, `node:vm` for testing the injected page script.

**Spec:** This plan is self-contained; it implements finding #1 from the ego-lite comparison (LYKN refs are positional, ego's derive from CDP `backendNodeId`).

## Global Constraints

- Runtime is CommonJS (`.cjs`) under `electron/`. No ESM `import` in these files.
- The injected collector string `COLLECT_INTERACTABLES_JS` must stay a single-quoted-concatenated JS string, ES5-compatible, with no template literals — it runs in arbitrary third-party pages.
- Never break the existing catalog item contract: `{id, tag, type, role, selector, label, value, checked, href, clientX, clientY, inView, disabled, scrollable, inDialog}` must all keep working. `uid` is additive.
- Ref format: main frame `e<uid>`; sub-frame `e<frameId>_<uid>`. Both match `/^e\d+(_\d+)?$/`.
- `buildSnapshot` must remain a pure function of its arguments — no Electron imports.
- Tests run with `node --test`. The new test lives at `electron/browser-agent/refs.test.cjs`, which the
  existing `test:agent` glob `electron/browser-agent/*.test.cjs` already matches — **do not edit `package.json`**.
- **File ownership:** this plan writes ONLY `electron/ownedBrowserAct.cjs`, `electron/browser-agent/browser/snapshot.cjs`, `electron/browser-agent/browser/controller.cjs`, `electron/browser-agent/refs.test.cjs`, and the four fixture files listed under C1 below:
  `electron/browser-agent/defects.test.cjs`, `electron/browser-agent/builders.test.mjs`,
  `electron/browser-agent/groundingLoop.test.cjs`, `electron/browser-agent/browserAgent.test.cjs`.
  Do not edit any other file — in particular, **not `package.json`**.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `electron/ownedBrowserAct.cjs` | Page-context collection | Add `REF_STORE_JS` preamble minting stable uids; emit `uid` per item; namespace frame uids |
| `electron/browser-agent/browser/snapshot.cjs` | Snapshot shape + model rendering | Build refs from `uid`; compute + emit `loc=`; index `byLoc` |
| `electron/browser-agent/browser/controller.cjs` | Ref resolution | Accept `loc=` targets; richer `unknown_reference` hint via a seen-ref ledger |
| `electron/browser-agent/refs.test.cjs` | Tests | New |
| `defects.test.cjs`, `builders.test.mjs`, `groundingLoop.test.cjs`, `browserAgent.test.cjs` | Existing fixtures | Add `uid` to catalog items; relax one over-tight assertion |

---

### Task 1: Mint document-stable uids in page context

**Files:**
- Modify: `electron/ownedBrowserAct.cjs:14-46` (the `COLLECT_INTERACTABLES_JS` constant) and `electron/ownedBrowserAct.cjs:1608-1620` (the item spread inside `collectFrameInteractables`)
- Modify: `electron/ownedBrowserAct.cjs` exports block (~line 11687)
- Test: `electron/browser-agent/refs.test.cjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `REF_STORE_JS` (exported string constant) — an ES5 IIFE-safe preamble defining `function __lyknUid(el)` returning a stable positive integer per element. Catalog items gain `uid: <number>` (main frame) or `uid: "<frameId>_<number>"` (sub-frame).

- [ ] **Step 1: Write the failing test**

Create `electron/browser-agent/refs.test.cjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/refs.test.cjs`
Expected: FAIL — `REF_STORE_JS` is `undefined`, so `vm.runInContext(undefined, ...)` throws `TypeError`.

- [ ] **Step 3: Add the ref store preamble**

In `electron/ownedBrowserAct.cjs`, immediately **above** the existing `const COLLECT_INTERACTABLES_JS =` declaration (currently line 14), insert:

```js
/**
 * Document-lifetime element identity, injected ahead of every catalog scan.
 *
 * Refs used to be the element's index in the scan, so anything that inserted a
 * node — a cookie banner, a lazy-loaded row, a re-render — renumbered every
 * element after it. The model would read "[e12] button Checkout", the page
 * would shift by one, and e12 would resolve to something else entirely with
 * nothing in the system able to notice.
 *
 * The WeakMap hangs off `window`, so it survives across executeJavaScript
 * calls for as long as the document lives and is collected with it. Numbers
 * are handed out monotonically and never reused, so a stale ref is always
 * unknown rather than quietly wrong. Guarded with `||` so re-injection on a
 * later scan reuses the existing store instead of resetting it.
 */
const REF_STORE_JS =
  "var __lyknRefStore=window.__lyknRefStore||(window.__lyknRefStore={m:new WeakMap(),n:0});" +
  "function __lyknUid(el){try{var v=__lyknRefStore.m.get(el);" +
  "if(!v){v=++__lyknRefStore.n;__lyknRefStore.m.set(el,v);}return v;}catch(e){return 0;}}";
```

- [ ] **Step 4: Run the uid tests to verify they pass**

Run: `node --test electron/browser-agent/refs.test.cjs`
Expected: FAIL — `REF_STORE_JS` is defined but not exported. Add it to the `module.exports` object in `electron/ownedBrowserAct.cjs` (the block beginning near line 11687, which already contains `getDOMCatalog,`) by inserting a line:

```js
  REF_STORE_JS,
```

Then re-run. Expected: PASS (4/4).

- [ ] **Step 5: Emit `uid` on every collected item**

In `COLLECT_INTERACTABLES_JS`, prepend the store to the IIFE body. Change the opening line from:

```js
  "(function(){function p(el){if(!el||el.nodeType!==1)return'';if(el.id)return '#'+CSS.escape(el.id);" +
```

to:

```js
  "(function(){" + REF_STORE_JS +
  "function p(el){if(!el||el.nodeType!==1)return'';if(el.id)return '#'+CSS.escape(el.id);" +
```

Then, in the `items.push({...})` call inside `add()`, add `uid` as the first property. Change:

```js
  "seen.add(el);items.push({id:'el'+items.length,tag:tag,type:type,role:role,selector:p(el),label:lab," +
```

to:

```js
  "seen.add(el);items.push({uid:__lyknUid(el),id:'el'+items.length,tag:tag,type:type,role:role,selector:p(el),label:lab," +
```

- [ ] **Step 6: Namespace sub-frame uids**

Each frame has its own `window`, so its own counter — uid `3` in two frames means two different elements. In `collectFrameInteractables` (`electron/ownedBrowserAct.cjs`, inside the `for (const it of items.slice(0, budget))` loop), the item spread currently starts:

```js
        out.push({
          ...it,
          id: `f${fr.routingId}_${it.id}`,
```

Change it to:

```js
        out.push({
          ...it,
          // Each frame counts from 1 in its own window — namespace by routing
          // id or frame uid 3 and main-frame uid 3 collide into one ref.
          uid: `${fr.routingId}_${it.uid}`,
          id: `f${fr.routingId}_${it.id}`,
```

- [ ] **Step 7: Run the full agent suite for regressions**

Run: `npm run test:agent`
Expected: PASS. `uid` is purely additive at this point — nothing reads it yet.

- [ ] **Step 8: Commit**

```bash
git add electron/ownedBrowserAct.cjs electron/browser-agent/refs.test.cjs
git commit -m "feat(browser-agent): mint document-stable element uids in page context"
```

---

### Task 2: Build refs from uid and emit a durable `loc=` locator

**Files:**
- Modify: `electron/browser-agent/browser/snapshot.cjs:17-58` (`buildSnapshot`) and `:126-143` (the element line in `formatSnapshotForModel`)
- Test: `electron/browser-agent/refs.test.cjs`

**Interfaces:**
- Consumes: catalog items carrying `uid` (Task 1).
- Produces:
  - `buildSnapshot` returns snapshots whose `elements[].ref` is `e<uid>` / `e<frameId>_<uid>`, whose `elements[].loc` is a locator string, and which carry a `byLoc: Map<string, element>` alongside `byRef`.
  - Exported `elementLocator(item, role, label)` → string.
  - Model-facing element lines gain a trailing ` loc=<locator>`.

- [ ] **Step 1: Write the failing test**

Append to `electron/browser-agent/refs.test.cjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/refs.test.cjs`
Expected: FAIL — first failure is `refs come from uid, not array position`, asserting `"e1" === "e7"`.

- [ ] **Step 3: Add the locator builder**

In `electron/browser-agent/browser/snapshot.cjs`, add below `normalizeRole` (after line 76):

```js
/**
 * A locator that outlives the snapshot that produced it.
 *
 * A uid dies with its document, so after a navigation or a framework remount
 * the model has nothing durable to aim at and has to re-read the page. These
 * are ordered by how well each survives a re-render: an author-written DOM id
 * essentially always does, a link's path nearly always does, and role+label
 * survives anything short of a copy change. The generated `nth-of-type` chain
 * is last because it is the one that breaks the moment the DOM shifts —
 * exactly the failure the uid already fixed.
 */
function elementLocator(item, role, label) {
  const selector = String(item?.selector || "").trim();
  if (/^#[^ >]+$/.test(selector)) return `css:${selector}`;
  const href = String(item?.href || "").trim();
  if (href && !/^(?:javascript:|#)/i.test(href)) {
    try {
      const u = new URL(href);
      if (/^https?:$/i.test(u.protocol)) return `href:${u.pathname}${u.search}`.slice(0, 120);
    } catch {
      /* relative or malformed — fall through */
    }
  }
  const text = String(label || "").trim().slice(0, 60);
  if (role && text) return `role:${role}|${text}`;
  return selector ? `css:${selector}`.slice(0, 120) : "";
}
```

- [ ] **Step 4: Build refs from uid and index by locator**

Replace the body of the `for` loop in `buildSnapshot` (lines 22-47). The full replacement loop:

```js
  for (let i = 0; i < catalog.length; i += 1) {
    const item = catalog[i];
    if (!item) continue;
    // The uid is minted in page context and pinned to the element for the
    // document's lifetime. A catalog from an older collector has none, so fall
    // back to position — a stale ref is better than a crash.
    const uid = item.uid === undefined || item.uid === null || item.uid === "" ? `p${i + 1}` : item.uid;
    const ref = `e${uid}`;
    const role = normalizeRole(item);
    const label = String(item.label || "").slice(0, 120);
    const el = {
      ref,
      loc: elementLocator(item, role, label),
      role,
      label,
      value: item.value ? String(item.value).slice(0, 80) : "",
      checked: item.checked === true,
      href: item.href ? String(item.href).slice(0, 200) : "",
      inView: item.inView !== false,
      // State the model has to know or it wastes rounds: clicking a disabled
      // control looks like a failed click, and not knowing a dialog is open
      // means not knowing why the page underneath ignores everything.
      disabled: item.disabled === true,
      inDialog: item.inDialog === true,
      scrollable: item.scrollable === true,
      // Elements inside an embedded editor's iframe — the model should know
      // it is working in a nested document.
      frameHost: item.frameHost ? String(item.frameHost).slice(0, 60) : "",
      raw: item,
    };
    elements.push(el);
    // Two elements can collide on a ref only if the collector handed out a
    // duplicate uid. First writer wins so the earlier (usually in-view) element
    // keeps the handle the model was given.
    if (!byRef.has(ref)) byRef.set(ref, el);
    if (el.loc && !byLoc.has(el.loc)) byLoc.set(el.loc, el);
  }
```

Declare `byLoc` alongside `byRef` near the top of `buildSnapshot`:

```js
  const byRef = new Map();
  const byLoc = new Map();
```

and add it to the returned object, after `byRef,`:

```js
    byLoc,
```

- [ ] **Step 5: Render the locator in the model-facing line**

In `formatSnapshotForModel`, inside the `for (const el of chosen)` loop, add as the **last** append before `lines.push(line)` (i.e. after the `if (!el.inView)` line):

```js
    // The durable handle. Refs die with the document; this survives a reload,
    // so the model can re-aim after a navigation without another observe round.
    if (el.loc) line += ` loc=${el.loc}`;
```

- [ ] **Step 6: Export the locator builder**

Change the last line of `snapshot.cjs` to:

```js
module.exports = { buildSnapshot, formatSnapshotForModel, diffSnapshots, elementLocator };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test electron/browser-agent/refs.test.cjs`
Expected: PASS (11/11).

- [ ] **Step 8: See the fixtures break, before repairing them**

Run: `npm run test:agent`
Expected: **FAIL — roughly 21 failures** across `browserAgent.test.cjs`, `builders.test.cjs`, `groundingLoop.test.cjs`
and `defects.test.cjs`. This is expected and is the whole point of this step: no fixture catalog in the
repo carries a `uid`, so every ref falls back to the positional `ep1`/`ep2` form and every `[eN]`
assertion misses. Read the failures before changing anything — they are the inventory for Step 9.

- [ ] **Step 9: Repair the fixtures**

The production collector now mints a `uid` for every element (Task 1). The test fixtures are
hand-written catalogs that predate it, so they must be given uids too. **Number them so refs come out
exactly as they do today** — the first item `uid: 1`, the second `uid: 2`, and so on — so no `[eN]`
assertion text anywhere needs to change.

Add `uid: <n>` to every catalog item in:

- `electron/browser-agent/defects.test.cjs` — `makeElement` (~lines 40-47) and `createFakeBrowser` (~50-61)
- `electron/browser-agent/builders.test.mjs` — `makeController` (~509-528) and the inline
  `buildSnapshot({catalog: […]})` fixtures (~173-218)
- `electron/browser-agent/groundingLoop.test.cjs` — ~line 39
- `electron/browser-agent/browserAgent.test.cjs` — `makeElement` (~22-38) and the fake actuator (~105-110)

Where a helper builds items from an array, derive the uid from the index rather than hard-coding it:

```js
const catalog = specs.map((spec, i) => makeElement({ uid: i + 1, ...spec }));
```

One assertion breaks a **second, independent** time — from the appended ` loc=` token, not from uids —
so it stays red even after the uid repair. In `electron/browser-agent/defects.test.cjs` (~line 295),
change:

```js
  assert.match(rendered, /\[e4\] button "Subscribe"$/m, "non-links are unchanged");
```

to:

```js
  assert.match(rendered, /\[e4\] button "Subscribe"(?! ->)/, "non-links get no destination");
```

That element has neither a selector nor an href, so `elementLocator` returns `role:button|Subscribe`
and its line can never end at the label. The assertion's real intent — that a non-link gets no `->`
destination — is what the replacement checks.

- [ ] **Step 10: Run the full agent suite**

Run: `npm run test:agent`
Expected: PASS. Also run `npm run test:eval` — `groundingLoop.test.cjs` is in both scripts.

- [ ] **Step 11: Commit**

```bash
git add electron/browser-agent/browser/snapshot.cjs electron/browser-agent/refs.test.cjs electron/browser-agent/defects.test.cjs electron/browser-agent/builders.test.mjs electron/browser-agent/groundingLoop.test.cjs electron/browser-agent/browserAgent.test.cjs
git commit -m "feat(browser-agent): build refs from stable uids and emit loc= locators"
```

---

### Task 3: Resolve `loc=` targets and explain unknown refs

**Files:**
- Modify: `electron/browser-agent/browser/controller.cjs:20-40` (the closure header and `resolveRef`) and `:67-86` (`getPageState`)
- Test: `electron/browser-agent/refs.test.cjs`

**Interfaces:**
- Consumes: `snapshot.byRef`, `snapshot.byLoc`, `element.loc` (Task 2).
- Produces: `resolveRef` accepts either an `e…` ref or a `loc=…` string. `{error: "unknown_reference"}` results gain a `hint` string. No change to any controller action signature.

- [ ] **Step 1: Write the failing test**

Append to `electron/browser-agent/refs.test.cjs`:

```js
const { createBrowserController } = require("./browser/controller.cjs");

/** Minimal actuator: records the action it was handed and reports success. */
function makeHarness(catalog) {
  const calls = [];
  const actuator = {
    getDOMCatalog: async () => ({ ok: true, items: catalog, url: "https://shop.test/" }),
    getPageContext: async () => ({ ok: true, url: "https://shop.test/", title: "Shop", text: "hi" }),
    runAction: async (_wc, action) => {
      calls.push(action);
      return { ok: true };
    },
    waitForLoad: async () => {},
  };
  const webContents = { isDestroyed: () => false, getURL: () => "https://shop.test/", getTitle: () => "Shop" };
  return { calls, controller: createBrowserController({ webContents, actuator }) };
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
```

Add a `__setCatalog` hook to the harness so a second `getPageState` returns a different page. Replace `makeHarness`'s `getDOMCatalog` with a mutable holder:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/refs.test.cjs`
Expected: FAIL — `a loc= target resolves…` fails with `res.ok === false` and `res.error === "unknown_reference"`.

- [ ] **Step 3: Add the seen-ref ledger**

In `createBrowserController`, alongside `let currentSnapshot = null;` and `let snapshotStale = true;`, add:

```js
  /**
   * ref -> label, for every ref this run has ever minted.
   *
   * "unknown_reference" alone tells the model its ref is gone but not whether
   * the control is gone too, so it re-observes and guesses. Naming what the
   * ref used to be turns a wasted round into a retarget.
   */
  const seenRefs = new Map();
```

- [ ] **Step 4: Record refs as snapshots are built**

In `getPageState`, immediately after `currentSnapshot.collectorFailed = ...` and before `snapshotStale = false;`, add:

```js
    for (const el of currentSnapshot.elements) {
      if (el.label) seenRefs.set(el.ref, el.label);
    }
    // A long run on a big app can mint thousands of refs; the ledger only
    // exists to explain the last few, so keep it bounded.
    if (seenRefs.size > 4000) {
      for (const key of [...seenRefs.keys()].slice(0, seenRefs.size - 4000)) seenRefs.delete(key);
    }
```

- [ ] **Step 5: Teach resolveRef about locators and hints**

Replace `resolveRef` (lines 33-40) with:

```js
  function resolveRef(ref) {
    const wanted = String(ref || "").trim();
    if (!wanted) return { error: "missing_target" };
    if (!currentSnapshot || snapshotStale) return { error: "stale_reference" };
    // A durable locator from a previous snapshot. Refs die with the document;
    // this is how the model re-aims after a reload without another observe.
    if (wanted.startsWith("loc=")) {
      const loc = wanted.slice(4).trim();
      const hit = currentSnapshot.byLoc?.get(loc);
      if (hit) return { el: hit };
      return { error: "unknown_reference", hint: `No element on this page matches ${wanted}.` };
    }
    const el = currentSnapshot.byRef.get(wanted);
    if (!el) {
      const was = seenRefs.get(wanted);
      return {
        error: "unknown_reference",
        hint: was
          ? `${wanted} was "${was}" earlier in this run and is not on the page now. ` +
            `Re-read the element list and aim at what is there.`
          : `${wanted} is not on this page. Re-read the element list.`,
      };
    }
    return { el };
  }
```

- [ ] **Step 6: Surface the hint on every action that resolves a ref**

Each ref-taking action currently does `if (error) return { ok: false, error };`. That drops the hint. Replace **every** occurrence of that exact line in `controller.cjs` with:

```js
    if (error) return { ok: false, error, ...(hint ? { hint } : {}) };
```

and change each destructure from `const { el, error } = resolveRef(...)` to `const { el, error, hint } = resolveRef(...)`. The affected functions are `click`, `type`, `replaceText`, `select`, `scroll`, `extract`, and both endpoints of `drag`.

Run this to confirm you found them all — it must print nothing:

```bash
grep -n "return { ok: false, error };" electron/browser-agent/browser/controller.cjs
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test electron/browser-agent/refs.test.cjs`
Expected: PASS (15/15).

- [ ] **Step 8: Run the full agent suite**

Run: `npm run test:agent`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add electron/browser-agent/browser/controller.cjs electron/browser-agent/refs.test.cjs
git commit -m "feat(browser-agent): resolve loc= targets and explain unknown refs"
```

---

## Verification

- [ ] `npm run test:agent` passes.
- [ ] `npm run test:eval` passes (the eval harness builds snapshots through the same path).
- [ ] `npm run lint` reports no new errors in the touched files.
