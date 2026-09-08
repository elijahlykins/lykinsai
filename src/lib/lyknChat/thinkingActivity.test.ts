import test from "node:test";
import assert from "node:assert/strict";
import {
  activityKindFromLine,
  collapseThinkingSteps,
  formatWorkingFor,
  thinkingHeaderLabel,
  trailFamilyKey,
} from "./thinkingActivity.ts";

test("kind mapping covers chat, research, build, and imagine lines", () => {
  assert.equal(activityKindFromLine("Searching: 2026 side hustle trends"), "search");
  assert.equal(activityKindFromLine("Reading nytimes.com…"), "read");
  assert.equal(activityKindFromLine("Reading sources (2/5)…"), "read");
  assert.equal(activityKindFromLine("Planning research…"), "research");
  assert.equal(activityKindFromLine("Researching 2026 side hustle trends"), "research");
  assert.equal(activityKindFromLine("Writing report…"), "research");
  assert.equal(activityKindFromLine("Building Landing page…"), "build");
  assert.equal(activityKindFromLine("Writing the code… (12k)"), "code");
  assert.equal(activityKindFromLine("Creating the image…"), "image");
  assert.equal(activityKindFromLine("Searching your files: LYKN"), "files");
});

test("progress ticks share a family so the trail updates in place", () => {
  assert.equal(trailFamilyKey("Reading sources (1/5)…"), trailFamilyKey("Reading sources (2/5)…"));
  assert.equal(trailFamilyKey("Writing the code… (12k)"), trailFamilyKey("Writing the code… (40k)"));
  assert.notEqual(trailFamilyKey("Searching: a"), trailFamilyKey("Searching: b"));
});

test("search bursts collapse the way the activity log reads", () => {
  const steps = collapseThinkingSteps(
    [
      "Searching: one",
      "Searching: two",
      "Searching: three",
      "Researching 2026 side hustle trends",
      "Searching: four",
    ],
    "",
  );
  assert.deepEqual(
    steps.map((s) => s.label),
    ["Ran 3 searches", "Researching 2026 side hustle trends", "Ran 1 search"],
  );
});

test("live specific work stays present-tense under completed bursts", () => {
  const steps = collapseThinkingSteps(
    ["Searching: one", "Searching: two"],
    "Searching: latest query…",
  );
  assert.equal(steps[0].label, "Ran 2 searches");
  assert.equal(steps[1].label, "Searching: latest query");
  assert.equal(steps[1].live, true);
});

test("header is a timer once the thread has steps, a wait line when parked", () => {
  assert.equal(
    thinkingHeaderLabel({ stepCount: 0, fallback: "Thinking…" }),
    "Thinking…",
  );
  assert.equal(
    thinkingHeaderLabel({ stepCount: 3, elapsedSeconds: 6 }),
    "Working for 6s",
  );
  assert.equal(
    thinkingHeaderLabel({ paused: true, stepCount: 3, elapsedSeconds: 6 }),
    "Waiting for you…",
  );
  assert.equal(formatWorkingFor(75), "Working for 1m 15s");
});
