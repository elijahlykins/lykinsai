/**
 * Writing a document is an action the agent takes, not something done behind
 * its back.
 *
 * Tool work — a page in Notion, a doc in Google Docs — used to run outside the
 * loop entirely: draft the text with one model call, paste it straight at the
 * page, report success. No verification that anything landed, no safety gate,
 * no trace to read afterwards, and a paste that silently did nothing looked
 * exactly like one that worked.
 *
 * `paste_text` puts that inside the loop: the agent clicks into the writing
 * surface and pastes as one action, and the verifier checks the document
 * actually holds the text.
 *
 * Run: node --test electron/browser-agent/pasteAction.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { createBrowserController, executeBatch } = require("./index.cjs");
const { verifyOutcome } = require("./runtime/verifier.cjs");
const { DECISION_SCHEMA } = require("./runtime/model.cjs");

const BODY = "LYKN Ideal Customer Profile\n\nFounders and students who live in their browser.";

function makeEditor({ pasteOk = true } = {}) {
  const state = { url: "https://app.notion.com/p/abc", title: "ICP", text: "Untitled", pasted: null };
  return {
    state,
    webContents: {
      isDestroyed: () => false,
      getURL: () => state.url,
      getTitle: () => state.title,
      executeJavaScript: async () => null,
    },
    actuator: {
      getDOMCatalog: async () => ({ ok: true, url: state.url, items: [] }),
      getPageContext: async () => ({ ok: true, url: state.url, title: state.title, text: state.text }),
      runAction: async () => ({ ok: true }),
      waitForLoad: async () => {},
      pasteTextIntoPage: async (_wc, { text, replaceAll }) => {
        if (!pasteOk) return { ok: false, error: "paste_blocked" };
        state.pasted = { text, replaceAll };
        state.text = text;
        return { ok: true };
      },
    },
  };
}

test("the action is offered to the model", () => {
  assert.ok(
    DECISION_SCHEMA.properties.action.properties.type.enum.includes("paste_text"),
    "an action the model cannot name is an action it cannot take",
  );
});

test("pasting puts the whole body into the editor in one action", async () => {
  const fake = makeEditor();
  const controller = createBrowserController({
    webContents: fake.webContents,
    actuator: fake.actuator,
  });
  const res = await controller.pasteText(BODY, { replaceAll: true });
  assert.equal(res.ok, true);
  assert.equal(fake.state.pasted.text, BODY, "the document arrives whole, not in pieces");
  assert.equal(fake.state.pasted.replaceAll, true);
});

test("an empty paste is refused rather than wiping the document", async () => {
  const fake = makeEditor();
  const controller = createBrowserController({
    webContents: fake.webContents,
    actuator: fake.actuator,
  });
  const res = await controller.pasteText("   ", { replaceAll: true });
  assert.equal(res.ok, false);
  assert.equal(res.error, "empty_text");
  assert.equal(fake.state.pasted, null, "nothing may reach the page");
});

test("the observation is invalidated — the document changed under it", async () => {
  const fake = makeEditor();
  const controller = createBrowserController({
    webContents: fake.webContents,
    actuator: fake.actuator,
  });
  await controller.getPageState();
  await controller.pasteText(BODY);
  assert.equal(controller.getCurrentSnapshot(), null);
});

// ── verification ────────────────────────────────────────────────────────────

const noModel = {
  verify: async () => {
    throw new Error("a paste is settled from the page, not by a model call");
  },
};

async function verifyPaste(after, actionResult = { ok: true }) {
  return verifyOutcome({
    model: noModel,
    decision: { action: { type: "paste_text", text: BODY }, expectedOutcome: "the doc holds the draft" },
    actionResult,
    before: { url: "https://app.notion.com/p/abc", visibleText: "Untitled", elements: [], byRef: new Map() },
    after,
    diff: { urlChanged: false, titleChanged: false, textChanged: true, newLabels: [], removedLabels: [], countChanges: [], stateChanges: [], summary: "Page text changed." },
  });
}

test("a document holding the text is verified from the page", async () => {
  const v = await verifyPaste({
    url: "https://app.notion.com/p/abc",
    visibleText: `${BODY}\n\nmore of the page`,
    elements: [],
    byRef: new Map(),
  });
  assert.equal(v.success, true);
  assert.equal(v.method, "deterministic");
  assert.match(v.evidence, /holds the pasted text/);
});

test("an editor that hides its own body is unconfirmed, not failed", async () => {
  // Canvas-drawn editors never expose their contents. Calling that a failure
  // sends the agent back to redo work it already did.
  const v = await verifyPaste({
    url: "https://docs.google.com/document/d/x/edit",
    visibleText: "",
    elements: [],
    byRef: new Map(),
  });
  assert.equal(v.success, true);
  assert.equal(v.unverified, true);
  assert.match(v.evidence, /confirm it visually/);
});

test("a paste the page refused is a plain failure", async () => {
  const v = await verifyPaste(
    { url: "https://app.notion.com/p/abc", visibleText: "Untitled", elements: [], byRef: new Map() },
    { ok: false, error: "paste_blocked" },
  );
  assert.equal(v.success, false);
  assert.equal(v.next, "recover");
});

test("a paste is never batched — it needs the editor focused first", () => {
  // Batched steps run without looking at the page between them, so a paste
  // planned in advance would land wherever focus happened to be.
  const out = executeBatch;
  assert.equal(typeof out, "function");
  const batch = require("./runtime/batch.cjs");
  assert.equal(batch.BATCHABLE_ACTIONS.has("paste_text"), false);
});

// ── the agent must be able to SEE where it can write ────────────────────────
//
// From a stuck run in Notion: the loop had the draft and the right plan
// ("place the complete drafted ICP into the page in a single paste") and never
// pasted. It spent every round screenshotting and clicking at pixels, hunting
// for a writing surface that appeared in the element list as an anonymous div
// — no label, no placeholder, nothing to aim at. Two things were wrong: the
// surface had no name, and the instructions told it to click before pasting.

const { buildSnapshot, formatSnapshotForModel } = require("./browser/snapshot.cjs");
const contextRouter = require("./runtime/contextRouter.cjs");

test("an empty rich editor is named and marked as writable", () => {
  const rendered = formatSnapshotForModel(
    buildSnapshot({
      url: "https://app.notion.com/p/x",
      catalog: [
        {
          uid: 1, tag: "div", role: "", selector: ".notion-page-content",
          // What the collector now produces for an unnamed contenteditable.
          label: "writing area", editable: true,
          clientX: 300, clientY: 200, inView: true,
        },
      ],
      text: "",
    }),
  );
  assert.match(rendered, /writing area/, "an anonymous div is nothing to aim at");
  assert.match(rendered, /editable — you can write here/);
});

test("an ordinary text input is not re-labelled as a writing area", () => {
  // The marker is for rich surfaces; a normal field already reads clearly.
  const rendered = formatSnapshotForModel(
    buildSnapshot({
      url: "https://x.test",
      catalog: [
        { uid: 1, tag: "input", role: "textbox", selector: "#q", label: "Search", editable: true, clientX: 1, clientY: 1, inView: true },
      ],
      text: "",
    }),
  );
  assert.match(rendered, /textbox "Search"/);
  assert.doesNotMatch(rendered, /you can write here/);
});

test("the agent is told to paste rather than hunt for the surface first", () => {
  // The instruction that caused the stall said to click into the writing area
  // before pasting. Paste focuses the editor itself, so that step is not just
  // unnecessary — on an unnamed surface it is unachievable.
  const system = contextRouter.buildDecisionSystem({
    task: { goal: "write the icp in notion", skills: [] },
    skills: [],
  });
  assert.match(system, /DO NOT hunt for the writing area first/);
  assert.match(system, /Hunting for the writing surface before pasting is the way this goes wrong/);
  assert.match(system, /Do not click Rename or "Untitled document" afterwards/);
});
