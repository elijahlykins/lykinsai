/**
 * Nothing internal may reach the "## What I did" list.
 *
 * These come from a real run. Asked for BYU's term dates, the agent did the
 * work correctly and then reported it like this:
 *
 *     - Clicked: e4
 *     - Opened
 *     - Clicked: e11
 *
 * "e4" is an element reference — the agent's private addressing scheme for a
 * page, minted fresh on every snapshot. It reached the user because the adapter
 * that maps modular-runtime history onto the legacy shape wrote the reference
 * into the `label` field, which this formatter renders. "Opened" was bare
 * because the fallback chain never looked at the action's URL.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatBrowseWorkLog,
  humanLabel,
  verbFor,
} = require("./browseWorkLog.cjs");

const ok = (action) => ({ action, result: { ok: true } });

test("an element reference never appears in the work log", () => {
  const log = formatBrowseWorkLog([
    ok({ type: "click", label: "e4" }),
    ok({ type: "click", label: "e11" }),
  ]);
  assert.doesNotMatch(log, /\be\d+\b/, `element ref leaked: ${log}`);
});

test("a click with only a reference degrades to the bare verb, not to jargon", () => {
  const log = formatBrowseWorkLog([ok({ type: "click", label: "e4" })]);
  assert.equal(log, "- Clicked");
});

test("a real label is shown, and is not mistaken for a reference", () => {
  const log = formatBrowseWorkLog([
    ok({ type: "click", label: "2026 Calendar List View" }),
  ]);
  assert.equal(log, "- Clicked: 2026 Calendar List View");
});

test("labels that merely start with e survive the reference filter", () => {
  // The guard is anchored for exactly this reason.
  for (const label of ["email", "e2e tests", "Export", "e-mail Bob"]) {
    assert.equal(humanLabel({ action: { label } }), label, `dropped "${label}"`);
  }
});

test("a navigation names where it went instead of reading as a fragment", () => {
  const log = formatBrowseWorkLog([
    ok({ type: "navigate", url: "https://www.academiccalendar.byu.edu/2026-calendar-list-view" }),
  ]);
  assert.equal(log, "- Opened: academiccalendar.byu.edu");
});

test("a navigation with no usable URL still reads as a sentence", () => {
  assert.equal(formatBrowseWorkLog([ok({ type: "navigate", url: "not a url" })]), "- Opened a page");
  assert.equal(formatBrowseWorkLog([ok({ type: "navigate" })]), "- Opened a page");
});

test("the whole BYU run reads as work, not as internals", () => {
  const log = formatBrowseWorkLog([
    ok({ type: "click", label: "e4" }),
    ok({ type: "navigate", url: "https://academiccalendar.byu.edu/2026-calendar-list-view" }),
    ok({ type: "click", label: "e11" }),
  ]);
  assert.doesNotMatch(log, /\be\d+\b/);
  assert.match(log, /academiccalendar\.byu\.edu/);
});

test("the legacy loop's own labels are unaffected", () => {
  // ownedBrowserAct has always written real labels here; this module must be a
  // no-op for that history rather than a second opinion about it.
  const log = formatBrowseWorkLog([
    ok({ type: "click", label: "Cancel" }),
    ok({ type: "paste", label: "Document body" }),
  ]);
  assert.equal(log, "- Clicked: Cancel\n- Typed: Document body");
});

test("failed actions are left out of a summary of what got done", () => {
  const log = formatBrowseWorkLog([
    { action: { type: "click", label: "Submit" }, result: { ok: false } },
    ok({ type: "click", label: "Continue" }),
  ]);
  assert.equal(log, "- Clicked: Continue");
});

test("repeated identical steps collapse, and the list stays capped", () => {
  const repeated = Array.from({ length: 20 }, () => ok({ type: "scroll" }));
  assert.equal(formatBrowseWorkLog(repeated), "- Scrolled");

  const many = Array.from({ length: 20 }, (_, i) =>
    ok({ type: "click", label: `Item ${i}` }),
  );
  assert.equal(formatBrowseWorkLog(many).split("\n").length, 8);
});

test("the actuator's reported label is used when the action carried none", () => {
  const line = humanLabel({ action: { type: "click" }, result: { label: "Send" } });
  assert.equal(line, "Send");
});

test("a reference in the result label is filtered too, not just in the action", () => {
  assert.equal(humanLabel({ action: { type: "click" }, result: { label: "e9" } }), "");
});

test("typed values are shown, since they are the user's own words", () => {
  const log = formatBrowseWorkLog([ok({ type: "type", value: "fall 2026 calendar" })]);
  assert.equal(log, "- Typed: fall 2026 calendar");
});

test("verbs cover the action vocabulary the runtime can emit", () => {
  assert.equal(verbFor("click_coord"), "Clicked");
  assert.equal(verbFor("replace_text"), "Edited");
  assert.equal(verbFor("open_tab"), "Opened");
  assert.equal(verbFor("press_key"), "Pressed a key");
  assert.equal(verbFor("select"), "Chose");
  assert.equal(verbFor("extract"), "Read the page");
});

test("empty and malformed history produce nothing rather than throwing", () => {
  assert.equal(formatBrowseWorkLog([]), "");
  assert.equal(formatBrowseWorkLog(null), "");
  assert.equal(formatBrowseWorkLog([{}, { result: { ok: true } }]), "- Act");
});
