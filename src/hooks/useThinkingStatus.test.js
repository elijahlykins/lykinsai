import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyStatusLine,
  isLiveBuildStatus,
  resolveThinkingLane,
  nextPhaseIndex,
  BUILD_PHASE_LOOP_FROM,
} from "./useThinkingStatus.js";

test("running tools is thinking, not a build", () => {
  assert.equal(classifyStatusLine("Running tools…"), "generic-think");
  assert.equal(isLiveBuildStatus("Running tools…"), false);
});

test("plan-echo thinking stays on the rotation", () => {
  assert.equal(
    classifyStatusLine("Thinking — Find the official public landing page for each named"),
    "generic-think",
  );
  assert.equal(classifyStatusLine("Thinking – Inspect each page’s hero"), "generic-think");
  assert.equal(classifyStatusLine("Thinking - Opening the first result"), "generic-think");
});

test("file work is a specific activity, not a build", () => {
  assert.equal(classifyStatusLine("Searching your files: LYKN"), "specific");
  assert.equal(classifyStatusLine("Looking through your files…"), "specific");
  assert.equal(classifyStatusLine("Reading the file…"), "specific");
  assert.equal(isLiveBuildStatus("Searching your files: LYKN"), false);
});

test("real build lines stay on the build lane", () => {
  assert.equal(classifyStatusLine("Designing the build…"), "generic-build");
  assert.equal(classifyStatusLine("Writing the code… (12k)"), "live-build");
  assert.equal(classifyStatusLine("Building Landing page…"), "live-build");
  assert.equal(isLiveBuildStatus("Designing the build…"), true);
});

test("a folder search does not snap back to designing the build", () => {
  assert.equal(
    resolveThinkingLane({
      preferBuild: true,
      lane: "build",
      classification: "specific",
      didNonBuildWork: true,
    }),
    "think",
  );
  assert.equal(
    resolveThinkingLane({
      preferBuild: true,
      lane: "think",
      classification: "generic-think",
      didNonBuildWork: true,
    }),
    "think",
  );
});

test("preferBuild keeps the build lane through a Thinking heartbeat", () => {
  assert.equal(
    resolveThinkingLane({
      preferBuild: true,
      lane: "build",
      classification: "generic-think",
      didNonBuildWork: false,
    }),
    "build",
  );
});

test("build rotation loops the working phrases instead of freezing", () => {
  assert.equal(nextPhaseIndex(0, 8), 1);
  assert.equal(nextPhaseIndex(7, 8), BUILD_PHASE_LOOP_FROM);
  assert.equal(nextPhaseIndex(2, 8), 3);
  assert.equal(classifyStatusLine("Writing the components…"), "generic-build");
  assert.equal(classifyStatusLine("Checking the layout…"), "generic-build");
  assert.equal(classifyStatusLine("Updating App.jsx…"), "live-build");
  assert.equal(classifyStatusLine("Patching the existing app…"), "live-build");
});
