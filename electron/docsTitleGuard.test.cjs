/**
 * Google Docs rename vs body-write.
 *
 * From a real run: writing into a new doc, the agent clicked "Untitled
 * document" / Rename and typed the name. The actuator treated title-focus as
 * "typed into the wrong field", retried, and insertText appended the same
 * name again. The loop looked like typing that would not stop.
 *
 * Run: node --test electron/docsTitleGuard.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  looksLikeDocsTitleTarget,
  docsTypeShouldTargetBody,
  docsTitleAfterTypeDecision,
  docsTitleRetypeGuard,
  looksLikeDocBodyPayload,
  rewriteDocsWriteAction,
  TITLE_ALREADY_SET_FACT,
} = require("./docsTitleGuard.cjs");
const { typeWithFocusRetry } = require("./ownedBrowserAct.cjs");

function makeDocsTitleWc({ titleValue = "Untitled document", inserts }) {
  let focused = "title";
  let value = titleValue;
  return {
    isDestroyed: () => false,
    getURL: () => "https://docs.google.com/document/d/abc/edit",
    getZoomFactor: () => 1,
    focus() {},
    sendInputEvent() {},
    async insertText(text) {
      inserts.push(String(text));
      if (focused !== "title") return;
      if (!value || /^untitled /i.test(value)) value = String(text);
      else value += String(text);
    },
    async executeJavaScript(js) {
      const src = String(js);
      if (src.includes("titleish:")) {
        return {
          ok: true,
          activeOk: focused === "title",
          tag: "input",
          role: "textbox",
          label: focused === "title" ? "Rename" : "Document body",
          value: focused === "title" ? value : "",
          valueLen: focused === "title" ? value.length : 0,
          titleish: focused === "title",
        };
      }
      if (src.includes("docs-title-input") && src.includes("contains")) {
        return focused === "title";
      }
      if (src.includes("kix-page") || src.includes("foundEditor")) {
        focused = "body";
        return { x: 400, y: 280, w: 800, h: 600, foundEditor: true };
      }
      return {};
    },
  };
}

test("Rename / Untitled document is the title widget, not the page", () => {
  assert.equal(looksLikeDocsTitleTarget("Rename"), true);
  assert.equal(looksLikeDocsTitleTarget("Untitled document"), true);
  assert.equal(looksLikeDocsTitleTarget("Document title"), true);
  assert.equal(looksLikeDocsTitleTarget("Document filename (short title only)"), true);
  assert.equal(looksLikeDocsTitleTarget("Document body"), false);
  assert.equal(looksLikeDocsTitleTarget("Share"), false);
});

test("a long write aimed at Rename is a body write, not a filename", () => {
  const essay = "The purpose of life is ".repeat(8);
  assert.ok(essay.length > 80);
  assert.equal(
    docsTypeShouldTargetBody({
      fieldHint: "Rename",
      text: essay,
      onCanvasEditor: true,
    }),
    true,
  );
  assert.equal(
    docsTypeShouldTargetBody({
      fieldHint: "Rename",
      text: "Purpose of Life",
      onCanvasEditor: true,
    }),
    false,
  );
});

test("after a rename, title still focused is success, not a retype cue", () => {
  const out = docsTitleAfterTypeDecision({
    preferDocsBody: false,
    hint: "Rename",
    label: "Rename",
    text: "Purpose of Life",
    titleStillFocused: true,
    titleValue: "Purpose of Life",
  });
  assert.equal(out.action, "succeed");
  assert.equal(out.via, "title_rename");
});

test("a rename that the title widget cannot echo back is still done", () => {
  const out = docsTitleAfterTypeDecision({
    preferDocsBody: false,
    hint: "Untitled document",
    text: "Purpose of Life",
    titleStillFocused: true,
    titleValue: "",
  });
  assert.equal(out.action, "succeed");
  assert.equal(out.verified, false);
});

test("a body write that landed in the filename must undo, not type again", () => {
  const essay = "The purpose of life may not be a single answer. ".repeat(4);
  const out = docsTitleAfterTypeDecision({
    preferDocsBody: true,
    hint: "Document body",
    text: essay,
    titleStillFocused: true,
    titleValue: essay.slice(0, 40),
  });
  assert.equal(out.action, "undo_and_retry_body");
});

test("the title already holding the name once is a skip, not another insert", () => {
  const skip = docsTitleRetypeGuard({
    hint: "Rename",
    currentValue: "Purpose of Life",
    typed: "Purpose of Life",
  });
  assert.deepEqual(skip, { skip: true, clear: false });

  const doubled = docsTitleRetypeGuard({
    hint: "Rename",
    currentValue: "Purpose of LifePurpose of Life",
    typed: "Purpose of Life",
  });
  assert.deepEqual(doubled, { skip: false, clear: true });
});

test("typeWithFocusRetry does not retype a Docs rename", async () => {
  const inserts = [];
  const wc = makeDocsTitleWc({ inserts });
  const out = await typeWithFocusRetry(wc, {
    text: "Purpose of Life",
    hint: "Rename",
    preferDocsBody: false,
    clickPoint: { x: 80, y: 20 },
    maxAttempts: 3,
    useInsertText: true,
  });
  assert.equal(out.ok, true);
  assert.equal(inserts.length, 1, "a landed rename must not type the name again");
  assert.equal(inserts[0], "Purpose of Life");
});

test("a body write aimed at Rename is rewritten to paste_text", () => {
  const essay = "The purpose of life is created, not found. It lives in the work we do.\n\nSecond paragraph.";
  assert.equal(looksLikeDocBodyPayload(essay), true);
  const out = rewriteDocsWriteAction(
    { type: "type", target: "g1:2", text: essay },
    { targetLabel: "Rename" },
  );
  assert.equal(out.action.type, "paste_text");
  assert.equal(out.action.text, essay);
  assert.equal(out.reason, "title_held_body");
});

test("a third title type is refused instead of appending again", () => {
  const history = [
    { action: { type: "type", text: "LYKN" }, targetLabel: "Rename" },
    { action: { type: "type", text: "LYKN - Spec" }, targetLabel: "Rename" },
  ];
  const out = rewriteDocsWriteAction(
    { type: "type", target: "g3:2", text: "LYKN - Spec" },
    { targetLabel: "Rename", history },
  );
  assert.equal(out.skip, true);
  assert.match(out.fact, /Do NOT type into it again/);
  assert.equal(out.fact, TITLE_ALREADY_SET_FACT);
});

test("the first short rename is forced to replace so it does not append", () => {
  const out = rewriteDocsWriteAction(
    { type: "type", target: "g1:2", text: "LYKN - Spec" },
    { targetLabel: "Rename" },
  );
  assert.equal(out.action.mode, "replace");
  assert.equal(out.reason, "title_force_replace");
});

test("typeWithFocusRetry skips insert when the title already holds the name", async () => {
  const inserts = [];
  const wc = makeDocsTitleWc({ titleValue: "Purpose of Life", inserts });
  const out = await typeWithFocusRetry(wc, {
    text: "Purpose of Life",
    hint: "Rename",
    preferDocsBody: false,
    clickPoint: { x: 80, y: 20 },
    maxAttempts: 3,
    useInsertText: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.via, "already_present");
  assert.equal(inserts.length, 0);
});
