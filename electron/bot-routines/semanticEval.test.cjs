/**
 * Semantic/vision evaluator budgets: cooldown, dedupe, no call when injected
 * model is absent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSemanticEvaluator, SEMANTIC_MAX_INPUT } = require("./semanticEval.cjs");

test("no model seam means zero calls", async () => {
  const ev = createSemanticEvaluator({ callModel: null });
  const out = await ev.evaluateSemantic({
    routineId: "r1",
    condition: "status is Failed",
    observation: { value: "Failed" },
  });
  assert.equal(out.skipped, "no_model");
  assert.equal(ev.counts().semanticCalls, 0);
});

test("a successful classification is tiny and bounded", async () => {
  const calls = [];
  const ev = createSemanticEvaluator({
    callModel: async (opts) => {
      calls.push(opts);
      return { matched: true, summary: "Failed." };
    },
    cooldownMs: 60_000,
    now: () => 1_000,
  });
  const out = await ev.evaluateSemantic({
    routineId: "r1",
    condition: "the deployment failed",
    observation: { url: "https://x.test", value: "Failed" },
    previous: { value: "Building" },
  });
  assert.equal(out.matched, true);
  assert.ok(calls[0].user.length <= SEMANTIC_MAX_INPUT);
  assert.equal(calls[0].stage, "monitor_semantic");
  assert.equal(calls[0].maxTokens, 80);
});

test("cooldown + dedupe prevent a storm", async () => {
  let now = 1_000;
  const ev = createSemanticEvaluator({
    callModel: async () => ({ matched: false, summary: "no" }),
    cooldownMs: 10_000,
    now: () => now,
  });
  await ev.evaluateSemantic({ routineId: "r1", condition: "x", observation: { value: "a" } });
  await ev.evaluateSemantic({ routineId: "r1", condition: "x", observation: { value: "a" } });
  await ev.evaluateSemantic({ routineId: "r1", condition: "y", observation: { value: "b" } });
  assert.equal(ev.counts().semanticCalls, 1);
  assert.ok(ev.counts().suppressedDedupe + ev.counts().suppressedCooldown >= 1);
  now = 20_000;
  await ev.evaluateSemantic({ routineId: "r1", condition: "x", observation: { value: "a" } });
  assert.equal(ev.counts().semanticCalls, 2);
});

test("vision is skipped without an image and uses the vision stage when present", async () => {
  const calls = [];
  const ev = createSemanticEvaluator({
    callModel: async (opts) => {
      calls.push(opts);
      return { matched: true, summary: "done" };
    },
    now: () => 1,
    cooldownMs: 1,
  });
  const missing = await ev.evaluateVision({ routineId: "r1", condition: "done" });
  assert.equal(missing.skipped, "no_image");
  const hit = await ev.evaluateVision({
    routineId: "r1",
    condition: "export finishes",
    imageUrl: "data:image/jpeg;base64,xxx",
  });
  assert.equal(hit.matched, true);
  assert.equal(calls[0].stage, "monitor_vision");
  assert.equal(ev.counts().visionCalls, 1);
});
