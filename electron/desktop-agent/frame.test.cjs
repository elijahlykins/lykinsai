"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  buildFrame,
  invalidateFrame,
  isUsableRegion,
  mapNormToScreen,
  frameDrift,
  frameDriftBlock,
} = require("./surface/frame.cjs");

const REGION = { x: 100, y: 200, width: 800, height: 600 };
const frameAt = (over = {}) =>
  buildFrame({ region: REGION, frontmostApp: "Blender", at: 1_000_000, ...over });

// ---------------------------------------------------------------------------
// Region validity — the 0x0 sentinel is the dangerous case
// ---------------------------------------------------------------------------

test("isUsableRegion rejects the zero-area sentinel the native layer returns", () => {
  // libnut reports an unreadable window as {0,0,0,0} rather than throwing.
  // Treating that as geometry would map every coordinate to the screen origin.
  assert.equal(isUsableRegion({ x: 0, y: 0, width: 0, height: 0 }), false);
  assert.equal(isUsableRegion({ x: 0, y: 0, width: 800, height: 0 }), false);
  assert.equal(isUsableRegion(null), false);
  assert.equal(isUsableRegion({ x: 0, y: 0, width: 800, height: 600 }), true);
});

test("buildFrame stores no region when the geometry is unusable", () => {
  const f = buildFrame({ region: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(f.region, null);
});

test("buildFrame mints a fresh generation each time", () => {
  assert.ok(buildFrame({ region: REGION }).generation < buildFrame({ region: REGION }).generation);
});

// ---------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------

test("mapNormToScreen maps against the captured region, not the primary display", () => {
  const f = frameAt();
  assert.deepEqual(mapNormToScreen(0, 0, f), { ok: true, x: 100, y: 200 });
  assert.deepEqual(mapNormToScreen(1000, 1000, f), { ok: true, x: 900, y: 800 });
  assert.deepEqual(mapNormToScreen(500, 500, f), { ok: true, x: 500, y: 500 });
});

test("mapNormToScreen handles a monitor left of the primary (negative origin)", () => {
  // The bug this guards: browserAct.resolveVisionCoords divides by
  // getPrimaryDisplay().size unconditionally, so a second monitor lands the
  // click on the wrong screen entirely.
  const f = buildFrame({ region: { x: -1920, y: 0, width: 1920, height: 1080 }, at: 1_000_000 });
  assert.deepEqual(mapNormToScreen(0, 0, f), { ok: true, x: -1920, y: 0 });
  assert.deepEqual(mapNormToScreen(1000, 1000, f), { ok: true, x: 0, y: 1080 });
});

test("mapNormToScreen refuses out-of-range and non-numeric coordinates", () => {
  const f = frameAt();
  for (const [x, y] of [[-1, 0], [0, -1], [1001, 0], [0, 1001], [NaN, 0], ["a", 0]]) {
    assert.equal(mapNormToScreen(x, y, f).ok, false, `expected refusal for (${x}, ${y})`);
    assert.equal(mapNormToScreen(x, y, f).error, "bad_coordinates");
  }
});

test("mapNormToScreen refuses without a frame", () => {
  assert.equal(mapNormToScreen(500, 500, null).error, "no_frame");
  assert.equal(mapNormToScreen(500, 500, buildFrame({ region: null })).error, "no_frame");
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

test("frameDrift measures position against size, not absolute pixels", () => {
  const f = frameAt();
  // 80px on an 800px-wide window is 10%.
  assert.equal(frameDrift(f, { ...REGION, x: REGION.x + 80 }), 0.1);
  assert.equal(frameDrift(f, REGION), 0);
  assert.equal(frameDrift(f, { x: 0, y: 0, width: 0, height: 0 }), Infinity);
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

const live = (over = {}) => ({ region: { ...REGION }, frontmostApp: "Blender", ...over });

test("frameDriftBlock passes an unchanged frame", () => {
  assert.equal(frameDriftBlock(frameAt(), live(), { now: 1_000_100 }), null);
});

test("frameDriftBlock tolerates sub-tolerance jitter", () => {
  // 8px on 800 is 1%, under the 2% tolerance — shadow/rounding noise.
  const l = live({ region: { ...REGION, x: REGION.x + 8 } });
  assert.equal(frameDriftBlock(frameAt(), l, { now: 1_000_100 }), null);
});

test("frameDriftBlock refuses after the window moves", () => {
  const l = live({ region: { ...REGION, x: REGION.x + 200 } });
  const blocked = frameDriftBlock(frameAt(), l, { now: 1_000_100 });
  assert.equal(blocked.error, "frame_changed");
  assert.match(blocked.hint, /moved or resized/);
});

test("frameDriftBlock refuses after the window resizes", () => {
  const l = live({ region: { ...REGION, width: 400 } });
  assert.equal(frameDriftBlock(frameAt(), l, { now: 1_000_100 }).error, "frame_changed");
});

test("frameDriftBlock refuses on a focus change even when geometry is identical", () => {
  // A save sheet or installer can come forward without moving the window we
  // measured. The geometry still matches; the click would hit the new window.
  const l = live({ frontmostApp: "Installer" });
  const blocked = frameDriftBlock(frameAt(), l, { now: 1_000_100 });
  assert.equal(blocked.error, "frame_changed");
  assert.match(blocked.hint, /Installer came to the front/);
});

test("frameDriftBlock refuses an explicitly invalidated frame", () => {
  const f = invalidateFrame(frameAt());
  assert.equal(frameDriftBlock(f, live(), { now: 1_000_100 }).error, "stale_view");
});

test("frameDriftBlock refuses a frame older than the age ceiling", () => {
  const blocked = frameDriftBlock(frameAt(), live(), { now: 1_000_000 + 45_000 });
  assert.equal(blocked.error, "stale_view");
  assert.match(blocked.hint, /45s old/);
});

test("frameDriftBlock refuses when the window became unreadable", () => {
  const l = live({ region: { x: 0, y: 0, width: 0, height: 0 } });
  const blocked = frameDriftBlock(frameAt(), l, { now: 1_000_100 });
  assert.equal(blocked.error, "frame_changed");
  assert.match(blocked.hint, /closed or minimized/);
});

test("frameDriftBlock does not punish an unknown frontmost app", () => {
  // The app reader needs Automation permission; without it we get "". That
  // should not block work the geometry check is happy with.
  assert.equal(frameDriftBlock(frameAt(), live({ frontmostApp: "" }), { now: 1_000_100 }), null);
  const f = buildFrame({ region: REGION, frontmostApp: "", at: 1_000_000 });
  assert.equal(frameDriftBlock(f, live(), { now: 1_000_100 }), null);
});

test("frameDriftBlock refuses without a frame at all", () => {
  assert.equal(frameDriftBlock(null, live(), { now: 1 }).error, "no_frame");
});
