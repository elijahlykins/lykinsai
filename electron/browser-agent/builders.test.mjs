/**
 * Apps that build things — email campaign editors, design tools, page builders —
 * broke the agent in four specific ways, and each of these tests pins one of
 * them shut:
 *
 * 1. The editor lives in an iframe, so the agent could read the content but had
 *    no element to act on and clicked the surrounding chrome forever.
 * 2. Adding content requires dragging, which the agent had no way to express.
 * 3. The page is drawn, not marked up, so the agent worked blind — vision only
 *    arrived after two failures, and once per whole task.
 * 4. A correct action in an editor changes nothing a page scrape can see, and
 *    that was scored as the agent's own failure, spending the round budget on
 *    undoing finished work.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSnapshot, formatSnapshotForModel } = require("./browser/snapshot.cjs");
const { createBrowserController } = require("./browser/controller.cjs");
const visionPolicy = require("./runtime/visionPolicy.cjs");
const verifier = require("./runtime/verifier.cjs");
const executor = require("./runtime/executor.cjs");
const contextRouter = require("./runtime/contextRouter.cjs");
const { createRecoveryTracker } = require("./runtime/recovery.cjs");
const { createMemoryStore } = require("./runtime/memory.cjs");

// ── The editor inside the iframe ────────────────────────────────────────────

test("elements from an embedded editor are usable and marked as embedded", () => {
  const snapshot = buildSnapshot({
    url: "https://us21.admin.mailchimp.com/campaigns/edit?id=9",
    title: "Edit campaign",
    catalog: [
      { id: "el0", tag: "button", label: "Save and Close", clientX: 900, clientY: 40 },
      {
        id: "f7_el0",
        tag: "div",
        role: "textbox",
        label: "Text block",
        selector: "#body-text",
        clientX: 420,
        clientY: 380,
        frameId: 7,
        frameHost: "us21.admin.mailchimp.com",
        frameOffsetKnown: true,
      },
    ],
    text: "Campaign content",
  });

  const embedded = snapshot.elements.find((e) => e.label === "Text block");
  assert.equal(embedded.frameHost, "us21.admin.mailchimp.com");
  assert.equal(embedded.raw.frameId, 7, "the owning frame must survive into the snapshot");

  const rendered = formatSnapshotForModel(snapshot);
  assert.match(rendered, /\[embedded: us21\.admin\.mailchimp\.com\]/);
  assert.match(rendered, /live inside an iframe/i, "the model needs to be told what that marking means");
});

test("acting on an embedded element routes the action to its frame", async () => {
  const calls = [];
  const controller = makeController({
    actuator: {
      runAction: async (_wc, action) => {
        calls.push(action);
        return { ok: true };
      },
    },
    catalog: [
      { id: "el0", tag: "button", label: "Outer button", clientX: 10, clientY: 10 },
      {
        id: "f7_el0",
        tag: "div",
        role: "textbox",
        label: "Body",
        selector: "#body",
        clientX: 400,
        clientY: 300,
        frameId: 7,
        frameHost: "app.example.com",
      },
    ],
  });
  await controller.getPageState();
  await controller.click("e2");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].frameId, 7, "the click must carry the frame that owns the element");
});

test("reading an embedded field's value runs inside that frame, not the main document", async () => {
  const ran = [];
  const controller = makeController({
    actuator: {
      runAction: async () => ({ ok: true }),
      frameByRoutingId: (_wc, id) => ({
        routingId: id,
        executeJavaScript: async () => {
          ran.push(id);
          return { value: "the copy in the editor", checked: false };
        },
      }),
    },
    catalog: [
      {
        id: "f7_el0",
        tag: "div",
        role: "textbox",
        label: "Body",
        selector: "#body",
        frameId: 7,
        frameHost: "app.example.com",
      },
    ],
  });
  await controller.getPageState();
  const out = await controller.extract("e1");

  assert.deepEqual(ran, [7], "the read must happen in frame 7");
  assert.equal(out.value, "the copy in the editor");
});

// ── Dragging ────────────────────────────────────────────────────────────────

test("a drag between two elements reaches the actuator with both ends", async () => {
  const calls = [];
  const controller = makeController({
    actuator: {
      runAction: async (_wc, action) => {
        calls.push(action);
        return { ok: true, type: "drag" };
      },
    },
    catalog: [
      { id: "el0", tag: "div", label: "Text block", selector: "#palette-text", clientX: 900, clientY: 200 },
      { id: "el1", tag: "div", label: "Drop area", selector: "#canvas-slot", clientX: 400, clientY: 300 },
    ],
  });
  await controller.getPageState();
  const res = await controller.drag("e1", "e2");

  assert.equal(res.ok, true);
  assert.equal(calls[0].type, "drag");
  assert.equal(calls[0].selector, "#palette-text");
  assert.equal(calls[0].toSelector, "#canvas-slot");
});

test("a drag can use screenshot coordinates on either end", async () => {
  const calls = [];
  const controller = makeController({
    actuator: {
      runAction: async (_wc, action) => {
        calls.push(action);
        return { ok: true };
      },
    },
    catalog: [
      { id: "el0", tag: "div", label: "Square", selector: "#square", clientX: 900, clientY: 200 },
    ],
  });
  await controller.getPageState();
  await controller.drag("e1", { x: 500, y: 640 });

  assert.equal(calls[0].selector, "#square");
  assert.equal(calls[0].toX, 500);
  assert.equal(calls[0].toY, 640);
});

test("drag is rejected without a destination, and accepted with coordinates", () => {
  const snapshot = buildSnapshot({
    catalog: [{ id: "el0", tag: "div", label: "Block", selector: "#b" }],
  });
  const sourceOnly = executor.normalizeDecision(
    { kind: "act", action: { type: "drag", target: "e1" } },
    snapshot,
  );
  assert.equal(sourceOnly.kind, "invalid");
  assert.match(sourceOnly.invalidReason, /destination/i);

  const withCoords = executor.normalizeDecision(
    { kind: "act", action: { type: "drag", target: "e1", toX: 300, toY: 400 } },
    snapshot,
  );
  assert.equal(withCoords.kind, "act");
});

test("click_coord needs coordinates inside the screenshot's range", () => {
  const bad = executor.normalizeDecision(
    { kind: "act", action: { type: "click_coord", x: 4000, y: 20 } },
    buildSnapshot({}),
  );
  assert.equal(bad.kind, "invalid");

  const good = executor.normalizeDecision(
    { kind: "act", action: { type: "click_coord", x: 400, y: 20 } },
    buildSnapshot({}),
  );
  assert.equal(good.kind, "act");
});

test("dragging is not treated as a consequential action", () => {
  // "Send block" is a real Mailchimp palette item — dragging it into a layout
  // must not read as sending anything.
  const snapshot = buildSnapshot({
    catalog: [{ id: "el0", tag: "div", label: "Send block", selector: "#s" }],
  });
  const risk = executor.classifyActionRisk(
    {
      kind: "act",
      action: { type: "drag", target: "e1", toX: 10, toY: 10 },
      expectedOutcome: "the block sits in the layout",
    },
    snapshot,
  );
  assert.notEqual(risk, "consequential", "rearranging a draft delivers nothing");
});

// ── Seeing the page ─────────────────────────────────────────────────────────

test("a design editor gets pixels immediately, every round", () => {
  const decision = visionPolicy.shouldSeePixels({
    snapshot: { url: "https://www.canva.com/design/DAF123/edit", elements: [] },
    roundsSinceShot: 0,
  });
  assert.equal(decision.see, true);
  assert.equal(decision.everyRound, true);
});

test("a page that draws itself and names almost nothing gets pixels", () => {
  const snapshot = buildSnapshot({
    url: "https://someeditor.example/app",
    catalog: [
      { id: "el0", tag: "canvas", label: "", selector: "canvas" },
      { id: "el1", tag: "button", label: "File", selector: "#file" },
    ],
  });
  assert.equal(visionPolicy.shouldSeePixels({ snapshot }).see, true);
});

test("an ordinary page does not pay for a screenshot", () => {
  const catalog = Array.from({ length: 14 }, (_, i) => ({
    id: `el${i}`,
    tag: "a",
    label: `Story ${i + 1}`,
    selector: `#s${i}`,
    href: "https://example.com",
  }));
  const snapshot = buildSnapshot({ url: "https://news.example.com", catalog, text: "headlines" });
  assert.equal(visionPolicy.shouldSeePixels({ snapshot, roundsSinceShot: 99 }).see, false);
});

test("visual inspection can be used again later in the same task", () => {
  const recovery = createRecoveryTracker();
  const modes = [];
  for (let i = 0; i < 6; i += 1) {
    modes.push(
      recovery.nextRecoveryStep({
        decision: { action: { type: "click", target: "e1" } },
        verification: { reason: "no observable page change" },
      }).mode,
    );
  }
  const visualCount = modes.filter((m) => m === "visual").length;
  assert.ok(
    visualCount >= 2,
    `one screenshot per task was the old behaviour; got ${modes.join(", ")}`,
  );
});

test("builder rules load for design tools, campaign editors and drawn pages", () => {
  assert.ok(
    contextRouter
      .routeBrowserModules({ url: "https://www.canva.com/design/X/edit", goal: "make a flyer" })
      .includes("builders"),
  );
  assert.ok(
    contextRouter
      .routeBrowserModules({ url: "https://us21.admin.mailchimp.com/campaigns", goal: "write the email" })
      .includes("builders"),
  );
  assert.ok(
    contextRouter.routeBrowserModules({ url: "https://x.example", hasEmbeddedFrame: true }).includes("builders"),
  );
  assert.ok(
    !contextRouter
      .routeBrowserModules({ url: "https://news.example.com", goal: "what is the top story" })
      .includes("builders"),
    "ordinary browsing should not carry builder rules",
  );
});

// ── Not calling correct work a failure ──────────────────────────────────────

const NO_CHANGE_DIFF = {
  urlChanged: false,
  titleChanged: false,
  textChanged: false,
  newLabels: [],
  removedLabels: [],
  summary: "No observable page change.",
};

function editorSnapshot(url) {
  const elements = [{ ref: "e1", role: "img", label: "", raw: { tag: "canvas" } }];
  return { url, title: "Editor", elements, visibleText: "toolbars", byRef: new Map(elements.map((e) => [e.ref, e])) };
}

test("a click on a drawn surface is unconfirmed, not failed", async () => {
  const after = editorSnapshot("https://www.canva.com/design/DAF/edit");
  const out = await verifier.verifyOutcome({
    model: { verify: async () => assert.fail("should not need the model") },
    decision: { action: { type: "click", target: "e1" }, expectedOutcome: "the shape is selected" },
    actionResult: { ok: true },
    before: after,
    after,
    diff: NO_CHANGE_DIFF,
  });
  assert.equal(out.success, true);
  assert.equal(out.unverified, true);
  assert.equal(out.next, "continue", "the agent must move on, not start undoing its work");
});

test("a click that changes nothing on an ordinary page is still a failure", async () => {
  const elements = [{ ref: "e1", role: "button", label: "Next", raw: { tag: "button" } }];
  const page = {
    url: "https://forms.example.com/step",
    title: "Form",
    elements,
    visibleText: "a form",
    byRef: new Map(elements.map((e) => [e.ref, e])),
  };
  const out = await verifier.verifyOutcome({
    model: { verify: async () => assert.fail("deterministic path expected") },
    decision: { action: { type: "click", target: "e1" }, expectedOutcome: "the next step" },
    actionResult: { ok: true },
    before: page,
    after: page,
    diff: NO_CHANGE_DIFF,
  });
  assert.equal(out.success, false);
  assert.equal(out.next, "recover");
});

test("typing into an editor that cannot report its contents is not a retype cue", async () => {
  const after = editorSnapshot("https://app.example.com/editor");
  const out = await verifier.verifyOutcome({
    model: { verify: async () => assert.fail("deterministic path expected") },
    decision: { action: { type: "type", target: "e1", text: "Our new AI browser is here." } },
    actionResult: { ok: true, unverified: true, verified: false },
    before: after,
    after,
    diff: NO_CHANGE_DIFF,
    extracted: { ok: true, label: "Body", value: "" },
  });
  assert.equal(out.success, true);
  assert.equal(out.unverified, true);
  assert.match(out.evidence, /does not report its contents/i);
});

test("a keyboard shortcut with no visible effect is not a failure", async () => {
  const elements = [{ ref: "e1", role: "textbox", label: "Body", raw: { tag: "div" } }];
  const page = {
    url: "https://app.example.com/doc",
    title: "Doc",
    elements,
    visibleText: "text",
    byRef: new Map(elements.map((e) => [e.ref, e])),
  };
  const out = await verifier.verifyOutcome({
    model: { verify: async () => assert.fail("deterministic path expected") },
    decision: { action: { type: "press_key", key: "b", modifiers: ["meta"] }, expectedOutcome: "bold" },
    actionResult: { ok: true },
    before: page,
    after: page,
    diff: NO_CHANGE_DIFF,
  });
  assert.equal(out.success, true);
  assert.equal(out.unverified, true);
});

test("a drop that rearranged the layout verifies without asking the model", async () => {
  const after = editorSnapshot("https://us21.admin.mailchimp.com/campaigns/edit");
  const out = await verifier.verifyOutcome({
    model: { verify: async () => assert.fail("deterministic path expected") },
    decision: { action: { type: "drag", target: "e1", to: "e2" }, expectedOutcome: "a text block appears" },
    actionResult: { ok: true },
    before: after,
    after,
    diff: { ...NO_CHANGE_DIFF, newLabels: ["Text block"], summary: 'New elements: "Text block"' },
  });
  assert.equal(out.success, true);
  assert.ok(!out.unverified, "a visible layout change is real confirmation");
});

// ── Scrolling a container ───────────────────────────────────────────────────

test("scrolling with a target scrolls that container, not the window", async () => {
  const calls = [];
  const controller = makeController({
    actuator: {
      runAction: async (_wc, action) => {
        calls.push(action);
        return { ok: true, scrolled: 400 };
      },
    },
    catalog: [{ id: "el0", tag: "div", label: "Blocks panel", selector: "#panel", scrollable: true }],
  });
  await controller.getPageState();
  await controller.scroll("down", 600, "e1");

  assert.equal(calls[0].type, "scroll_element");
  assert.equal(calls[0].selector, "#panel");
});

test("outer page chrome cannot crowd the embedded editor out of the list", () => {
  const catalog = [
    ...Array.from({ length: 120 }, (_, i) => ({
      id: `el${i}`,
      tag: "button",
      label: `Chrome control ${i + 1}`,
      selector: `#c${i}`,
      inView: true,
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `f7_el${i}`,
      tag: "div",
      role: "textbox",
      label: `Editor block ${i + 1}`,
      selector: `#b${i}`,
      inView: true,
      frameId: 7,
      frameHost: "editor.example.com",
    })),
  ];
  const rendered = formatSnapshotForModel(buildSnapshot({ catalog }));
  for (let i = 1; i <= 12; i += 1) {
    assert.match(rendered, new RegExp(`Editor block ${i}"`), `block ${i} was dropped from the list`);
  }
});

test("a scrollable container is pointed out to the model", () => {
  const snapshot = buildSnapshot({
    catalog: [{ id: "el0", tag: "div", role: "button", label: "Blocks panel", scrollable: true }],
  });
  assert.match(formatSnapshotForModel(snapshot), /scrollable/i);
});

test("disabled controls and open dialogs are called out", () => {
  const snapshot = buildSnapshot({
    catalog: [
      { id: "el0", tag: "button", label: "Send", disabled: true },
      { id: "el1", tag: "button", label: "Confirm", inDialog: true },
    ],
  });
  const rendered = formatSnapshotForModel(snapshot);
  assert.match(rendered, /Send".*disabled/i);
  assert.match(rendered, /\[dialog\]/);
  assert.match(rendered, /A dialog is open/i);
});

// ── Site knowledge ──────────────────────────────────────────────────────────

test("a product playbook reaches every one of its regional hosts", async () => {
  const memory = createMemoryStore({});
  const sharded = await memory.getWebsiteMemory("https://us21.admin.mailchimp.com/campaigns/edit?id=9");
  assert.match(sharded, /Mailchimp/i);
  assert.match(sharded, /Replicate/i, "the shortcut past the drag builder must be in there");

  const canva = await memory.getWebsiteMemory("https://www.canva.com/design/DAF/edit");
  assert.match(canva, /Canva/i);

  const unknown = await memory.getWebsiteMemory("https://nothing-known.example.com/x");
  assert.equal(unknown, "");
});

test("a playbook is not truncated mid-sentence by the prompt budget", () => {
  const websiteMemory = "# Known about mailchimp.com\n" + "- a useful note about the editor\n".repeat(90);
  const system = contextRouter.buildDecisionSystem({
    task: { goal: "write a campaign", plan: [], constraints: [], workingMemory: { facts: [] } },
    websiteMemory,
  });
  const kept = system.split("Known about mailchimp.com")[1] || "";
  assert.ok(kept.length > 2500, `site knowledge was cut to ${kept.length} characters`);
});

test("learning writes durable notes once and refuses to duplicate them", async () => {
  const os = require("node:os");
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lykn-agent-memory-"));
  const memory = createMemoryStore({ userDataPath: dir });

  const first = await memory.rememberWebsiteNotes("https://app.example.com/x", [
    "Campaign templates live under Create then Email.",
    "The content editor renders inside an iframe.",
  ]);
  assert.equal(first, 2);

  const again = await memory.rememberWebsiteNotes("https://app.example.com/y", [
    "campaign templates live under create then email",
    "Sending requires an audience to be selected first.",
  ]);
  assert.equal(again, 1, "an already-known note should not be stored twice");

  const recalled = await memory.getWebsiteMemory("app.example.com");
  assert.match(recalled, /audience to be selected/);

  const refused = await memory.rememberWebsiteNotes("app.example.com", [
    "The password for this account is hunter2 and it works.",
  ]);
  assert.equal(refused, 0, "secrets must never be written to memory");

  await fs.rm(dir, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makeController({ actuator = {}, catalog = [], url = "https://app.example.com/edit" } = {}) {
  const webContents = {
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => "App",
    executeJavaScript: async () => ({ value: "", checked: false }),
  };
  return createBrowserController({
    webContents,
    actuator: {
      getDOMCatalog: async () => ({ ok: true, url, items: catalog }),
      getPageContext: async () => ({ ok: true, url, title: "App", text: "content" }),
      waitForLoad: async () => {},
      waitForDomSettle: async () => {},
      runAction: async () => ({ ok: true }),
      screenshotDataUrl: async () => "data:image/jpeg;base64,x",
      ...actuator,
    },
  });
}
