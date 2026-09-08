import test from "node:test";
import assert from "node:assert/strict";
import { activityKindFromLine } from "./thinkingActivity.js";
import { createThinkingTimeline, isTrailWorthyStatus } from "./thinkingTimeline.js";
import { isRotationPhrase } from "./statusRotation.js";

test("voice tool lines map to the same kinds as Studio chat", () => {
  assert.equal(activityKindFromLine("Searching the web…"), "search");
  assert.equal(activityKindFromLine("Reading the page…"), "read");
  assert.equal(activityKindFromLine("Looking through your files…"), "files");
  assert.equal(activityKindFromLine("Creating the image…"), "image");
  assert.equal(activityKindFromLine("Writing it out…"), "write");
});

test("rotation and generic think lines are not trail steps", () => {
  assert.equal(isTrailWorthyStatus("Thinking…", isRotationPhrase), false);
  assert.equal(isTrailWorthyStatus("Reading what you said…", isRotationPhrase), false);
  assert.equal(isTrailWorthyStatus("Working on it…", isRotationPhrase), false);
  assert.equal(isTrailWorthyStatus("Searching the web…", isRotationPhrase), true);
  assert.equal(isTrailWorthyStatus("Creating the image…", isRotationPhrase), true);
});

test("timeline stacks tool hops and keeps the live line present-tense", () => {
  const timeline = createThinkingTimeline();
  try {
    timeline.ingest("Thinking…");
    assert.equal(timeline.hasSteps(), false);

    timeline.ingest("Searching the web…");
    timeline.ingest("Reading the page…");
    const steps = timeline.snapshot();
    assert.equal(steps[0].label, "Ran 1 search");
    assert.equal(steps[1].label, "Reading the page");
    assert.equal(steps[1].live, true);
  } finally {
    timeline.reset();
  }
  assert.equal(timeline.hasSteps(), false);
});
