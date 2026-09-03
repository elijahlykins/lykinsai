"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowsePresentation } = require("./browsePresentation.cjs");

function presentation() {
  return createBrowsePresentation({
    sendToAgentChannels() {},
    pauseForUserSignIn() {},
    needsLlmBrowseSummary() {},
  });
}

test("acting-step details join without a missing separator constant", () => {
  const { STEP_DETAIL_SEP, joinStepDetails, sanitizeStepDetail, tidyStepDetail } =
    presentation();
  assert.equal(STEP_DETAIL_SEP, " · ");

  const detail = joinStepDetails([
    tidyStepDetail("open the inbox"),
    `Expecting ${sanitizeStepDetail("Gmail to load")}`,
    `Running in one go: ${sanitizeStepDetail("open mail.google.com")}`,
  ]);

  assert.equal(
    detail,
    "Open the inbox · Expecting Gmail to load · Running in one go: open mail.google.com",
  );
});

test("empty acting-step fragments are dropped", () => {
  const { joinStepDetails } = presentation();
  assert.equal(joinStepDetails(["Open Gmail", "", null, "Expecting the inbox"]), "Open Gmail · Expecting the inbox");
});

test("a newer thinking placeholder replaces the previous one", () => {
  const { setLiveOutputStep, renderStepTranscript } = presentation();
  const agent = { id: "bot-1", liveOutputSteps: [] };
  setLiveOutputStep(agent, {
    label: "Thinking — Find the official public landing page",
    transient: true,
  });
  setLiveOutputStep(agent, {
    label: "Thinking — Inspect each page’s hero",
    transient: true,
  });
  assert.equal(agent.liveOutputSteps.length, 1);
  assert.equal(agent.liveOutputSteps[0].label, "Thinking — Inspect each page’s hero");
  const out = renderStepTranscript(agent);
  assert.match(out, /Thinking — Inspect each page/);
  assert.doesNotMatch(out, /Find the official public landing page/);
});

test("a finished browse report keeps a long markdown write-up", () => {
  const { paintBrowseDone } = presentation();
  const body = [
    "## Inbox",
    "",
    "Three threads need a reply.",
    "",
    "### Needs a reply",
    "",
    "- Dana: launch date",
    "- Sam: invoice",
    "- Priya: interview loop",
    "",
    "### Later",
    "",
    "- Newsletter from Stripe",
  ].join("\n");
  const long = `${body}\n\n${"Finding. ".repeat(400)}`;
  assert.ok(long.length > 1800, "fixture must exceed the old wrap-up cap");
  const text = paintBrowseDone({ id: "bot-1", lastSuggestions: [] }, long, {
    skipSuggestions: true,
  });
  assert.match(text, /## Inbox/);
  assert.match(text, /### Needs a reply/);
  assert.ok(text.includes(long.slice(0, 200)));
  assert.ok(text.length > 1800, "the report must not be sliced to a teaser");
});
