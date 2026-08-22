// Usage: node --test electron/browser-agent/timing.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTimer } = require("./runtime/timing.cjs");

test("a disabled timer is a true no-op and never calls onSpan", async () => {
  let called = 0;
  const t = createTimer({ enabled: false, onSpan: () => { called += 1; } });
  assert.equal(t.enabled, false);
  assert.equal(t.span("decide")(), 0);
  assert.equal(await t.time("decide", async () => 42), 42);
  assert.equal(t.roundRollup(1), null);
  assert.equal(called, 0, "a disabled timer must not emit spans");
});

test("a disabled timer returns the same shared closure, so it allocates nothing per call", () => {
  const t = createTimer({ enabled: false });
  assert.equal(t.span("a"), t.span("b"));
});

test("spans are recorded and sum to no more than the round total", async () => {
  const seen = [];
  const t = createTimer({ enabled: true, onSpan: (s) => seen.push(s) });
  await t.time("decide", () => new Promise((r) => setTimeout(r, 12)));
  await t.time("verify", () => new Promise((r) => setTimeout(r, 8)));
  const roll = t.roundRollup(1);

  assert.deepEqual(seen.map((s) => s.name), ["decide", "verify"]);
  assert.equal(roll.round, 1);
  assert.equal(roll.stages.decide.n, 1);
  assert.ok(roll.stages.decide.ms >= 10, `decide should be ~12ms, got ${roll.stages.decide.ms}`);
  const summed = Object.values(roll.stages).reduce((a, s) => a + s.ms, 0);
  assert.ok(summed <= roll.totalMs + 1, "stage sum must not exceed the round total");
  assert.ok(roll.otherMs >= 0);
});

test("repeat calls to one stage accumulate rather than overwrite", async () => {
  const t = createTimer({ enabled: true });
  await t.time("ground", () => new Promise((r) => setTimeout(r, 5)));
  await t.time("ground", () => new Promise((r) => setTimeout(r, 5)));
  const roll = t.roundRollup(1);
  assert.equal(roll.stages.ground.n, 2);
  assert.ok(roll.stages.ground.ms >= 8);
});

test("a throwing stage is still timed, because slow failures are the interesting ones", async () => {
  const t = createTimer({ enabled: true });
  await assert.rejects(() => t.time("decide", async () => { throw new Error("boom"); }));
  const roll = t.roundRollup(1);
  assert.equal(roll.stages.decide.n, 1);
});

test("rollup clears state so the next round starts from zero", async () => {
  const t = createTimer({ enabled: true });
  await t.time("decide", () => new Promise((r) => setTimeout(r, 3)));
  t.roundRollup(1);
  const roll2 = t.roundRollup(2);
  assert.deepEqual(roll2.stages, {}, "stages must not leak across rounds");
  assert.equal(roll2.round, 2);
});

test("an onSpan that throws cannot break the run", async () => {
  const t = createTimer({ enabled: true, onSpan: () => { throw new Error("logger down"); } });
  await assert.doesNotReject(() => t.time("decide", async () => "ok"));
});
