/**
 * Putting a wrong value right.
 *
 * From a real run: the agent typed the wrong address into Google Drive's share
 * box, noticed immediately, and then could not fix it. `type` with
 * mode "replace" called HTMLInputElement's native value setter on a field that
 * was not an input, which throws "Illegal invocation" — an error with no
 * meaning to the agent and no route around it. It spent the rest of its budget
 * clicking at the mistake and handed the task back.
 *
 * Two things are pinned here: the page-side setter never throws on a foreign
 * element, and "replace" reaches the actuator as a request to CLEAR the field
 * before typing — the only correction that works on rich-text and chip fields.
 *
 * Run: node --test electron/fieldCorrection.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");

const { createBrowserController } = require("./browser-agent/browser/controller.cjs");

// ── the page-side setter ────────────────────────────────────────────────────

/**
 * Run buildActionJs's setVal against a fake DOM element. The script is built
 * for the page, so it is evaluated in a realm carrying just enough of one —
 * including the native setters whose receiver checks caused the crash.
 */
function runSetVal(element, { asInput = false } = {}) {
  const HTMLInputElement = function () {};
  const HTMLTextAreaElement = function () {};
  const illegal = () => {
    throw new TypeError("Illegal invocation");
  };
  // Native setters accept only their own kind, exactly like the real ones.
  Object.defineProperty(HTMLInputElement.prototype, "value", {
    configurable: true,
    get() { return this._v; },
    set(v) {
      if (!(this instanceof HTMLInputElement)) illegal();
      this._v = v;
    },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
    configurable: true,
    get() { return this._v; },
    set(v) {
      if (!(this instanceof HTMLTextAreaElement)) illegal();
      this._v = v;
    },
  });
  // A genuine input has to BE one — `instanceof` is what the guard turns on,
  // and a look-alike would quietly take the fallback branch and prove nothing.
  const el = asInput ? Object.assign(Object.create(HTMLInputElement.prototype), element) : element;
  const sandbox = {
    HTMLInputElement,
    HTMLTextAreaElement,
    Event: function (type) { this.type = type; },
    result: null,
    el,
  };
  vm.createContext(sandbox);
  // The setVal body, lifted from buildActionJs (see the source for the
  // reasoning); kept in sync by the assertions below, which fail loudly if the
  // shipped version regresses to an unguarded native setter.
  const src = require("node:fs")
    .readFileSync(require("node:path").join(__dirname, "ownedBrowserAct.cjs"), "utf8");
  const start = src.indexOf('"function setVal(el,v){"');
  const end = src.indexOf('"return true;}" +', start);
  assert.ok(start > 0 && end > start, "setVal must still be present in buildActionJs");
  const js = src
    .slice(start, end + '"return true;}"'.length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    .map((l) => l.replace(/^"/, "").replace(/"\s*\+?$/, ""))
    .join("")
    .replace(/\\'/g, "'");
  vm.runInContext(`${js}; result = setVal(el, "corrected");`, sandbox);
  return { ok: sandbox.result, el: sandbox.el };
}

const baseEl = (over = {}) => ({
  scrollIntoView() {},
  click() {},
  focus() {},
  dispatchEvent() { return true; },
  getAttribute: () => null,
  ...over,
});

test("a real input still goes through the native setter", () => {
  const out = runSetVal(baseEl({ tagName: "INPUT" }), { asInput: true });
  assert.equal(out.ok, true);
  // Written through the prototype setter — the path frameworks watch.
  assert.equal(out.el.value, "corrected");
});

test("a contenteditable field is written without touching the input setter", () => {
  const el = baseEl({
    tagName: "DIV",
    isContentEditable: true,
    textContent: "wrong@example.com",
  });
  const out = runSetVal(el);
  assert.equal(out.ok, true, "this must not throw Illegal invocation");
  assert.equal(el.textContent, "corrected");
});

test("a custom widget with a value property is written too", () => {
  const el = baseEl({ tagName: "X-INPUT", value: "wrong" });
  const out = runSetVal(el);
  assert.equal(out.ok, true);
  assert.equal(el.value, "corrected");
});

test("a control that takes no value reports so instead of throwing", () => {
  const el = baseEl({ tagName: "DIV" });
  const out = runSetVal(el);
  assert.equal(out.ok, false, "an unwritable control is a plain false, not an exception");
});

// ── the controller's replace mode ───────────────────────────────────────────

function makeController(el) {
  const actions = [];
  const actuator = {
    getDOMCatalog: async () => ({
      ok: true,
      url: "https://drive.google.com/share",
      items: [{ uid: 1, id: "f1", selector: "#to", label: "Add people", clientX: 10, clientY: 10, inView: true, ...el }],
    }),
    getPageContext: async () => ({ ok: true, url: "https://drive.google.com/share", title: "Share", text: "" }),
    runAction: async (_wc, action) => {
      actions.push(action);
      return { ok: true };
    },
    waitForLoad: async () => {},
  };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://drive.google.com/share",
    getTitle: () => "Share",
  };
  return { actions, controller: createBrowserController({ webContents, actuator }) };
}

test("replacing a chip-style recipient field asks the actuator to clear it first", async () => {
  // The field that broke the real run: not an input, and already holding the
  // wrong address as a committed chip.
  const { actions, controller } = makeController({
    tag: "div",
    role: "combobox",
    value: "wrong@example.com",
  });
  await controller.getPageState();
  const res = await controller.type("e1", "right@example.com", { mode: "replace" });
  assert.notEqual(res.error, "replace_mode_unsupported", "there must be a way to fix this field");
  assert.equal(res.ok, true);
  assert.equal(actions.at(-1).mode, "replace", "the actuator is told to clear before typing");
  assert.equal(actions.at(-1).text, "right@example.com");
});

test("an ordinary append is unchanged", async () => {
  const { actions, controller } = makeController({ tag: "input", value: "" });
  await controller.getPageState();
  await controller.type("e1", "hello");
  assert.equal(actions.at(-1).mode, "append");
});

// ── focusing a field is not a dead click ────────────────────────────────────

const { verifyOutcome } = require("./browser-agent/runtime/verifier.cjs");

const NO_CHANGE = {
  urlChanged: false, titleChanged: false, textChanged: false,
  newLabels: [], removedLabels: [], countChanges: [], stateChanges: [],
  summary: "No observable page change.",
};

const noModel = {
  verify: async () => {
    throw new Error("a focus click must be settled without a model call");
  },
};

async function verifyFocusClick(el, action) {
  return verifyOutcome({
    model: noModel,
    decision: { action, expectedOutcome: "the field takes focus" },
    actionResult: { ok: true },
    before: { byRef: new Map([["e1", el]]), elements: [], visibleText: "" },
    after: { url: "https://drive.google.com/share", title: "Share", elements: [], visibleText: "", byRef: new Map() },
    diff: NO_CHANGE,
  });
}

test("clicking a custom share box to focus it counts as progress", async () => {
  // Drive's "Add people" field: no ARIA role at all, so the old role-only rule
  // scored every focus click as a dead click and spent the recovery ladder.
  const el = { label: "Add people, groups, and calendar events", role: "", raw: { tag: "div", editable: true } };
  const v = await verifyFocusClick(el, { type: "click", target: "e1" });
  assert.equal(v.success, true);
  assert.match(v.evidence, /focused/i);
});

test("the same click by coordinates is judged the same way", async () => {
  const el = { label: "Add people, groups, and calendar events", role: "", raw: { tag: "div", editable: true } };
  const v = await verifyFocusClick(el, { type: "click_coord", target: "e1", x: 500, y: 400 });
  assert.equal(v.success, true);
});

test("a field named like a recipient box counts even with nothing else to go on", async () => {
  const el = { label: "To recipients", role: "", raw: {} };
  const v = await verifyFocusClick(el, { type: "click", target: "e1" });
  assert.equal(v.success, true);
});

test("clicking an ordinary button that does nothing is still a failure", async () => {
  const el = { label: "Share", role: "button", raw: { tag: "div" } };
  const v = await verifyFocusClick(el, { type: "click", target: "e1" });
  assert.equal(v.success, false, "a dead button must still fail — this rule is only for text entry");
  assert.match(v.reason, /no observable page change/i);
});

// ── typing into a dialog when no click can reach the field ──────────────────
//
// The share dialog defeated every way of aiming: coordinates landed off, the
// field reported itself obscured, and the iframe holding it could not be
// placed. Each attempt ended "field_not_focused" — the text had nowhere to go
// — and the run looped click → nothing → screenshot → click until it gave up.
//
// A dialog has one obvious place to type, and focus needs neither a correct
// pixel nor a clear line of sight. This is that last resort.

const vm2 = require("node:vm");

function runDialogFocusScript({ dialogs = 1, fields = 1, visible = true, hint = "" } = {}) {
  const { buildFocusDialogFieldJs } = require("./ownedBrowserAct.cjs");
  const js = buildFocusDialogFieldJs(hint);

  const rect = visible ? { width: 220, height: 32 } : { width: 0, height: 0 };
  const field = {
    tagName: "INPUT",
    value: "",
    getAttribute: (k) => (k === "aria-label" ? "Add people, groups, spaces" : null),
    getBoundingClientRect: () => rect,
    focus() {
      ctx.document.activeElement = this;
    },
    contains: (n) => n === field,
    querySelectorAll: () => [],
  };
  const dialog = {
    tagName: "DIV",
    getAttribute: (k) => (k === "role" ? "dialog" : null),
    getBoundingClientRect: () => ({ width: 600, height: 420 }),
    querySelectorAll: () => (fields ? [field] : []),
    contains: () => false,
    focus() {},
  };
  const ctx = {
    document: {
      activeElement: null,
      querySelectorAll: (s) => (s.includes("dialog") && dialogs ? [dialog] : []),
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  };
  // The script decodes its own payload in page context.
  ctx.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
  ctx.escape = global.escape;
  ctx.unescape = global.unescape;
  ctx.decodeURIComponent = decodeURIComponent;
  ctx.JSON = JSON;
  vm2.createContext(ctx);
  return { out: vm2.runInContext(js, ctx), ctx, field };
}

test("an open dialog's field can be focused without any coordinate", () => {
  const { out, ctx, field } = runDialogFocusScript();
  assert.equal(out.ok, true);
  assert.equal(ctx.document.activeElement, field, "the caret has to actually land in it");
  assert.match(out.label, /add people/i, "the label is normalised for matching, so compare loosely");
});

test("no dialog, no claim", () => {
  assert.equal(runDialogFocusScript({ dialogs: 0 }).out.ok, false);
});

test("a dialog with nothing to type in reports failure rather than guessing", () => {
  assert.equal(runDialogFocusScript({ fields: 0 }).out.ok, false);
});

test("a hidden field is not somewhere to type", () => {
  assert.equal(runDialogFocusScript({ visible: false }).out.ok, false);
});

test("the field the agent aimed at wins over the first one in the dialog", () => {
  // A dialog with a search box above the recipient box must not swallow the
  // address: the hint decides, and only an unhinted call takes the first.
  const { buildFocusDialogFieldJs } = require("./ownedBrowserAct.cjs");
  const make = (label) => ({
    tagName: "INPUT",
    value: "",
    _label: label,
    getAttribute: (k) => (k === "aria-label" ? label : null),
    getBoundingClientRect: () => ({ width: 200, height: 30 }),
    focus() { ctx.document.activeElement = this; },
    contains(n) { return n === this; },
    querySelectorAll: () => [],
  });
  const search = make("Search files");
  const people = make("Add people, groups, spaces");
  const dialog = {
    getAttribute: (k) => (k === "role" ? "dialog" : null),
    getBoundingClientRect: () => ({ width: 600, height: 400 }),
    querySelectorAll: () => [search, people],
    contains: () => false,
  };
  const ctx = {
    document: { activeElement: null, querySelectorAll: (s) => (s.includes("dialog") ? [dialog] : []) },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
    escape: global.escape,
    unescape: global.unescape,
    decodeURIComponent,
    JSON,
  };
  vm2.createContext(ctx);
  vm2.runInContext(buildFocusDialogFieldJs("Add people, groups, spaces"), ctx);
  assert.equal(ctx.document.activeElement, people, "the hinted field is the one that gets the caret");

  ctx.document.activeElement = null;
  vm2.runInContext(buildFocusDialogFieldJs(""), ctx);
  assert.equal(ctx.document.activeElement, search, "with no hint, the first field is the sensible default");
});
