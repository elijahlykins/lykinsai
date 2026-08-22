// Usage: node --test electron/browser-agent/grounding.test.cjs
//
// The contract these pin down: refs mode is untouched, a grounding miss becomes
// an ordinary invalid decision (so the existing 3-strike machinery handles it),
// a transport failure ends the run loudly rather than silently reverting to
// refs, and the description survives onto action.label so the safety gate and
// the narration still have something to read.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGrounder, resolveGroundingMode, resolveSnapMode } = require("./runtime/grounding.cjs");

const SNAPSHOT = { url: "https://example.com/cart", title: "Cart", byRef: new Map() };
const clickDecision = (target = "the blue Checkout button in the header") => ({
  kind: "act",
  action: { type: "click", target },
  reason: "proceed to checkout",
});

function fakeModel(impl) {
  const calls = [];
  return {
    calls,
    ground: async (args) => {
      calls.push(args);
      return impl(args, calls.length);
    },
  };
}

test("refs mode returns no grounder at all", () => {
  assert.equal(createGrounder({ mode: "refs", model: fakeModel(() => ({})) }), null);
  assert.equal(createGrounder({ mode: "", model: fakeModel(() => ({})) }), null);
});

test("mode and snap resolve from explicit value then env, defaulting safely", () => {
  assert.equal(resolveGroundingMode("holo"), "holo");
  assert.equal(resolveGroundingMode("nonsense"), "refs");
  assert.equal(resolveSnapMode("nearest"), "nearest");
  assert.equal(resolveSnapMode("nonsense"), "none", "an unknown snap mode must not silently enable label snapping");
});

test("terminal decisions are never grounded", () => {
  const g = createGrounder({ mode: "holo", model: fakeModel(() => ({})) });
  for (const kind of ["finish", "ask_user", "replan", "invalid"]) {
    assert.equal(g.needsGrounding({ kind, action: { type: "click", target: "x" } }), false);
  }
  assert.equal(g.needsGrounding({ kind: "act", action: { type: "navigate", url: "https://x.com" } }), false);
  assert.equal(g.needsGrounding(clickDecision()), true);
});

test("a click becomes click_coord and keeps the description as the label", async () => {
  const model = fakeModel(() => ({ found: true, x: 742, y: 318, confidence: "high", note: "Checkout button" }));
  const g = createGrounder({ mode: "holo", model });
  const out = await g.ground({ decision: clickDecision(), snapshot: SNAPSHOT, imageUrl: "data:image/png;base64,AAA" });

  assert.equal(out.ok, true);
  assert.equal(out.decision.action.type, "click_coord");
  assert.equal(out.decision.action.x, 742);
  assert.equal(out.decision.action.y, 318);
  assert.equal(out.decision.action.label, "the blue Checkout button in the header",
    "the label feeds the safety gate and the progress narration");
  assert.equal(out.decision.action.snap, "none", "raw coordinates by default, so accuracy is measurable");
  assert.equal(out.decision.reason, "proceed to checkout", "the rest of the decision is preserved");
  assert.equal(model.calls[0].intent, "click");
  assert.equal(model.calls[0].url, "https://example.com/cart");
});

test("the input decision is never mutated in place", async () => {
  const model = fakeModel(() => ({ found: true, x: 1, y: 2 }));
  const g = createGrounder({ mode: "holo", model });
  const decision = clickDecision();
  await g.ground({ decision, snapshot: SNAPSHOT, imageUrl: "data:image/png;base64,AAA" });
  assert.equal(decision.action.type, "click", "the caller's decision must be untouched");
  assert.equal(decision.action.x, undefined);
});

test("a grounding miss becomes an invalid decision, not a fatal error", async () => {
  const model = fakeModel(() => ({ found: false, note: "not visible" }));
  const g = createGrounder({ mode: "holo", model });
  const out = await g.ground({ decision: clickDecision(), snapshot: SNAPSHOT, imageUrl: "data:image/png;base64,AAA" });

  assert.equal(out.ok, false);
  assert.ok(!out.fatal, "a miss must not end the run — the recovery ladder handles it");
  assert.match(out.invalidReason, /could not find/i);
  assert.match(out.invalidReason, /below the fold|closed menu/i, "the hint should tell the model what to try next");
  assert.equal(out.log.found, false);
});

test("a transport failure is fatal — it must never silently fall back to refs", async () => {
  const model = { ground: async () => { throw new Error("ECONNRESET"); } };
  const g = createGrounder({ mode: "holo", model, retries: 1 });
  const out = await g.ground({ decision: clickDecision(), snapshot: SNAPSHOT, imageUrl: "data:image/png;base64,AAA" });

  assert.equal(out.ok, false);
  assert.equal(out.fatal, true,
    "a holo run that quietly became a refs run would invalidate the comparison this mode exists to produce");
  assert.match(out.error, /ECONNRESET/);
});

test("transport blips are retried before giving up", async () => {
  let n = 0;
  const model = {
    ground: async () => {
      n += 1;
      if (n < 3) throw new Error("blip");
      return { found: true, x: 10, y: 20 };
    },
  };
  const g = createGrounder({ mode: "holo", model, retries: 2 });
  const out = await g.ground({ decision: clickDecision(), snapshot: SNAPSHOT, imageUrl: "data:image/png;base64,AAA" });
  assert.equal(out.ok, true);
  assert.equal(n, 3);
});

test("actions with no coordinate form are rejected with a usable redirect", async () => {
  const g = createGrounder({ mode: "holo", model: fakeModel(() => ({})) });
  for (const [type, expect] of [["select", /dropdown/i], ["replace_text", /retype/i], ["extract", /page text/i]]) {
    const out = await g.ground({
      decision: { kind: "act", action: { type, target: "the size dropdown" } },
      snapshot: SNAPSHOT,
      imageUrl: "data:image/png;base64,AAA",
    });
    assert.equal(out.ok, false, `${type} should be rejected`);
    assert.ok(!out.fatal);
    assert.match(out.invalidReason, expect, `${type} should say what to do instead`);
  }
});

test("a type becomes type_coord carrying its text and Enter intent", async () => {
  const model = fakeModel(() => ({ found: true, x: 400, y: 220 }));
  const g = createGrounder({ mode: "holo", model });
  const out = await g.ground({
    decision: { kind: "act", action: { type: "type", target: "the search box", text: "90028", pressEnter: true } },
    snapshot: SNAPSHOT,
    imageUrl: "data:image/png;base64,AAA",
  });
  assert.equal(out.decision.action.type, "type_coord");
  assert.equal(out.decision.action.text, "90028");
  assert.equal(out.decision.action.pressEnter, true);
  assert.equal(model.calls[0].intent, "type");
});

test("a drag grounds both ends, and a miss on either end fails the action", async () => {
  const ok = createGrounder({
    mode: "holo",
    model: fakeModel((_a, n) => ({ found: true, x: n === 1 ? 100 : 800, y: n === 1 ? 200 : 600 })),
  });
  const out = await ok.ground({
    decision: { kind: "act", action: { type: "drag", target: "the image block", to: "the empty layout slot" } },
    snapshot: SNAPSHOT,
    imageUrl: "data:image/png;base64,AAA",
  });
  assert.equal(out.decision.action.type, "drag");
  assert.deepEqual(
    [out.decision.action.x, out.decision.action.y, out.decision.action.toX, out.decision.action.toY],
    [100, 200, 800, 600],
  );

  const halfMiss = createGrounder({
    mode: "holo",
    model: fakeModel((_a, n) => (n === 1 ? { found: true, x: 1, y: 2 } : { found: false })),
  });
  const bad = await halfMiss.ground({
    decision: { kind: "act", action: { type: "drag", target: "a", to: "b" } },
    snapshot: SNAPSHOT,
    imageUrl: "data:image/png;base64,AAA",
  });
  assert.equal(bad.ok, false);
  assert.match(bad.invalidReason, /drop target/i);
});

test("with no screenshot the round is invalid rather than a blind click", async () => {
  const g = createGrounder({ mode: "holo", model: fakeModel(() => ({ found: true, x: 1, y: 1 })) });
  const out = await g.ground({ decision: clickDecision(), snapshot: SNAPSHOT, imageUrl: "" });
  assert.equal(out.ok, false);
  assert.ok(!out.fatal);
  assert.match(out.invalidReason, /screenshot/i);
});

test("a described scroll container degrades to a page scroll", async () => {
  const model = fakeModel(() => ({ found: true, x: 1, y: 1 }));
  const g = createGrounder({ mode: "holo", model });
  const out = await g.ground({
    decision: { kind: "act", action: { type: "scroll", direction: "down", target: "the results panel" } },
    snapshot: SNAPSHOT,
    imageUrl: "data:image/png;base64,AAA",
  });
  assert.equal(out.ok, true);
  assert.equal(out.decision.action.target, undefined);
  assert.equal(out.decision.action.direction, "down");
  assert.equal(model.calls.length, 0, "a page scroll needs no grounding call");
});
