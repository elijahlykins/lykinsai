/**
 * Action batching tests.
 *
 * Run: node --test electron/browser-agent/batching.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const batch = require("./runtime/batch.cjs");
const { nextGeneration } = require("./browser/snapshot.cjs");

test("a ref-free read-only sequence is admitted", () => {
  const out = batch.admitBatch([
    { type: "scroll", direction: "down" },
    { type: "wait", ms: 400 },
    { type: "scroll", direction: "down" },
  ]);
  assert.equal(out.admitted, true);
  assert.equal(out.steps.length, 3);
});

test("a step carrying an element ref is refused", () => {
  // Refs are generation-scoped and the counter is process-global, so even a
  // ref that only exists to be refused is minted, never written down.
  const out = batch.admitBatch([
    { type: "scroll", direction: "down" },
    { type: "screenshot", target: `g${nextGeneration()}:12` },
  ]);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /reference/i);
});

test("extract is refused — reading a named field is inherently targeted", () => {
  const out = batch.admitBatch([{ type: "scroll" }, { type: "extract" }]);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /extract/);
});

test("a click is refused even without a ref", () => {
  const out = batch.admitBatch([{ type: "scroll" }, { type: "click_coord", x: 10, y: 10, label: "Buy" }]);
  assert.equal(out.admitted, false);
});

test("press_key is refused — Enter submits forms", () => {
  const out = batch.admitBatch([{ type: "scroll" }, { type: "press_key", key: "Enter" }]);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /press_key/);
});

test("a sequence longer than the cap is refused", () => {
  const steps = Array.from({ length: 7 }, () => ({ type: "scroll" }));
  const out = batch.admitBatch(steps);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /6/);
});

test("a single step is not a batch", () => {
  const out = batch.admitBatch([{ type: "scroll" }]);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /single/i);
});

test("an empty or non-array input is refused without throwing", () => {
  assert.equal(batch.admitBatch([]).admitted, false);
  assert.equal(batch.admitBatch(null).admitted, false);
  assert.equal(batch.admitBatch(undefined).admitted, false);
});

test("a step with no type is refused", () => {
  assert.equal(batch.admitBatch([{ type: "scroll" }, {}]).admitted, false);
});

test("describeBatch names each step in order", () => {
  const line = batch.describeBatch([
    { type: "scroll", direction: "down" },
    { type: "screenshot" },
  ]);
  assert.match(line, /scroll/);
  assert.match(line, /screenshot/);
});

test("navigate may lead a batch but its url is required by the caller, not here", () => {
  const out = batch.admitBatch([
    { type: "navigate", url: "https://x.test/list" },
    { type: "wait", ms: 500 },
    { type: "screenshot" },
  ]);
  assert.equal(out.admitted, true);
});

const { createAgentModel } = require("./runtime/model.cjs");

/**
 * A model whose transport returns one canned payload.
 *
 * `call()` reads `data.json` off the parsed response body and rejects anything
 * else as "returned no result", so the canned body wraps the decision rather
 * than being it.
 */
function cannedModel(payload) {
  const body = { ok: true, json: payload };
  return createAgentModel({
    apiBase: "https://api.test",
    getAuthToken: async () => "t",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    }),
  });
}

test("decide passes a steps array through", async () => {
  const model = cannedModel({
    kind: "act",
    action: { type: "scroll", direction: "down" },
    steps: [
      { type: "scroll", direction: "down" },
      { type: "wait", ms: 400 },
    ],
    reason: "load the whole list",
  });
  const out = await model.decide({ system: "s", user: "u" });
  assert.equal(Array.isArray(out.steps), true);
  assert.equal(out.steps.length, 2);
});

test("decide reports steps as null when the model sends none", async () => {
  const model = cannedModel({ kind: "act", action: { type: "scroll" }, reason: "r" });
  const out = await model.decide({ system: "s", user: "u" });
  assert.equal(out.steps, null);
});

test("decide ignores a steps value that is not an array", async () => {
  const model = cannedModel({ kind: "act", action: { type: "scroll" }, steps: "nope", reason: "r" });
  const out = await model.decide({ system: "s", user: "u" });
  assert.equal(out.steps, null);
});

const { normalizeDecision } = require("./runtime/executor.cjs");

const emptySnapshot = { byRef: new Map(), elements: [] };

test("an admissible batch survives normalisation", () => {
  const out = normalizeDecision(
    {
      kind: "act",
      action: { type: "scroll", direction: "down" },
      steps: [{ type: "scroll", direction: "down" }, { type: "wait", ms: 400 }],
    },
    emptySnapshot,
  );
  assert.equal(out.kind, "act");
  assert.equal(out.steps.length, 2);
});

test("an inadmissible batch degrades to the first step, it does not fail the round", () => {
  const out = normalizeDecision(
    {
      kind: "act",
      action: { type: "scroll", direction: "down" },
      steps: [{ type: "scroll", direction: "down" }, { type: "click_coord", x: 5, y: 5, label: "Buy" }],
    },
    emptySnapshot,
  );
  assert.equal(out.kind, "act", "the round must still run");
  assert.equal(out.steps, null, "the batch must be gone");
  assert.deepEqual(out.action, { type: "scroll", direction: "down" });
  assert.match(out.batchRejected, /click_coord/);
});

test("a batch whose first step disagrees with action is refused", () => {
  const out = normalizeDecision(
    {
      kind: "act",
      action: { type: "scroll", direction: "down" },
      steps: [{ type: "extract" }, { type: "scroll" }],
    },
    emptySnapshot,
  );
  assert.equal(out.steps, null);
  assert.match(out.batchRejected, /first step/i);
});

test("a batch on a non-act decision is dropped", () => {
  const out = normalizeDecision(
    { kind: "finish", answer: "done", steps: [{ type: "scroll" }, { type: "extract" }] },
    emptySnapshot,
  );
  assert.equal(out.steps, null);
});

test("an invalid action still reports invalid even with a batch attached", () => {
  const out = normalizeDecision(
    { kind: "act", action: { type: "navigate" }, steps: [{ type: "navigate" }, { type: "extract" }] },
    emptySnapshot,
  );
  assert.equal(out.kind, "invalid");
});

const { executeBatch } = require("./index.cjs");

/** A controller that records calls and can be told to fail at step N. */
function fakeController({ failAt = -1 } = {}) {
  const calls = [];
  const ok = () => ({ ok: true });
  let n = 0;
  const step = (type) => async (...args) => {
    n += 1;
    calls.push({ type, args });
    return n === failAt ? { ok: false, error: "boom" } : ok();
  };
  return {
    calls,
    controller: {
      scroll: step("scroll"),
      wait: step("wait"),
      screenshot: step("screenshot"),
      navigate: step("navigate"),
      goBack: step("go_back"),
      goForward: step("go_forward"),
      openTab: step("open_tab"),
      switchTab: step("switch_tab"),
      settle: async () => {},
    },
  };
}

test("a batch runs every step in order", async () => {
  const { calls, controller } = fakeController();
  const out = await executeBatch(controller, [
    { type: "scroll", direction: "down" },
    { type: "screenshot" },
    { type: "scroll", direction: "down" },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.ran, 3);
  assert.deepEqual(calls.map((c) => c.type), ["scroll", "screenshot", "scroll"]);
});

test("a batch stops at the first failing step", async () => {
  const { calls, controller } = fakeController({ failAt: 2 });
  const out = await executeBatch(controller, [
    { type: "scroll" },
    { type: "screenshot" },
    { type: "scroll" },
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.ran, 2, "the step that failed counts as run; the one after it must not");
  assert.equal(calls.length, 2);
  assert.equal(out.error, "boom");
});

test("a batch reports how far it got", async () => {
  const { controller } = fakeController({ failAt: 1 });
  const out = await executeBatch(controller, [{ type: "scroll" }, { type: "screenshot" }]);
  assert.equal(out.total, 2);
  assert.equal(out.ran, 1);
});

test("a throwing step is caught, not propagated", async () => {
  const controller = {
    scroll: async () => {
      throw new Error("detached");
    },
    settle: async () => {},
  };
  const out = await executeBatch(controller, [{ type: "scroll" }, { type: "screenshot" }]);
  assert.equal(out.ok, false);
  assert.match(out.error, /detached/);
});
