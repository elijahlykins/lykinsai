"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createWindowSurface, normalizeRegion, NO_WINDOW } = require("./surface/windows.cjs");

/** Minimal stand-in for the native window provider. */
function fakeNative({ active = 42, rects = { 42: { x: 10, y: 20, width: 800, height: 600 } }, titles = { 42: "Untitled" }, windows = [42], titleThrows = false } = {}) {
  return {
    getActiveWindow: () => active,
    getWindowRect: (h) => rects[h] || { x: 0, y: 0, width: 0, height: 0 },
    getWindowTitle: (h) => {
      if (titleThrows) throw new Error("no screen recording");
      return titles[h] || "";
    },
    getWindows: () => windows,
    focusWindow: () => undefined,
  };
}

const okApps = async () => ({ ok: true, frontmost: "Blender", running: ["Blender", "Finder"] });

test("normalizeRegion accepts both native rect shapes", () => {
  assert.deepEqual(normalizeRegion({ x: 5, y: 6, width: 100, height: 50 }), { x: 5, y: 6, width: 100, height: 50 });
  assert.deepEqual(normalizeRegion({ left: 5, top: 6, width: 100, height: 50 }), { x: 5, y: 6, width: 100, height: 50 });
});

test("normalizeRegion rejects the zero-area sentinel and junk", () => {
  assert.equal(normalizeRegion({ x: 0, y: 0, width: 0, height: 0 }), null);
  assert.equal(normalizeRegion({ x: 0, y: 0, width: 800 }), null);
  assert.equal(normalizeRegion(null), null);
});

test("regionForHandle returns geometry for a readable window", () => {
  const s = createWindowSurface({ nativeWindow: fakeNative(), getRunningApps: okApps });
  const r = s.regionForHandle(42);
  assert.equal(r.ok, true);
  assert.deepEqual(r.region, { x: 10, y: 20, width: 800, height: 600 });
  assert.equal(r.title, "Untitled");
});

test("regionForHandle refuses the -1 handle with a permission hint", () => {
  const s = createWindowSurface({ nativeWindow: fakeNative({ active: NO_WINDOW }), getRunningApps: okApps });
  const r = s.regionForHandle(NO_WINDOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_window");
  assert.match(r.hint, /Accessibility and Screen Recording/);
});

test("regionForHandle refuses a zero-area rect rather than reporting an origin", () => {
  // Without this, every mapped coordinate becomes a click at (0,0).
  const s = createWindowSurface({ nativeWindow: fakeNative({ rects: {} }), getRunningApps: okApps });
  assert.equal(s.regionForHandle(42).error, "no_window");
});

test("a title read failure does not fail the geometry read", () => {
  // Titles need Screen Recording; positions only need Accessibility. Losing
  // the title is diagnostic, not fatal.
  const s = createWindowSurface({ nativeWindow: fakeNative({ titleThrows: true }), getRunningApps: okApps });
  const r = s.regionForHandle(42);
  assert.equal(r.ok, true);
  assert.equal(r.title, "");
});

test("activeWindow follows the native active handle", () => {
  const s = createWindowSurface({ nativeWindow: fakeNative(), getRunningApps: okApps });
  assert.equal(s.activeWindow().handle, 42);
});

test("readLiveGeometry composes window geometry with the frontmost app", async () => {
  const s = createWindowSurface({ nativeWindow: fakeNative(), getRunningApps: okApps });
  const g = await s.readLiveGeometry();
  assert.equal(g.ok, true);
  assert.equal(g.frontmostApp, "Blender");
  assert.deepEqual(g.region, { x: 10, y: 20, width: 800, height: 600 });
});

test("readLiveGeometry re-measures the frame's own window, not the active one", async () => {
  // A transient focus steal must read as a focus change, not as a resize of
  // the window we were working in.
  const native = fakeNative({
    active: 99,
    rects: { 42: { x: 10, y: 20, width: 800, height: 600 }, 99: { x: 0, y: 0, width: 200, height: 100 } },
    windows: [42, 99],
  });
  const s = createWindowSurface({ nativeWindow: native, getRunningApps: okApps });
  const g = await s.readLiveGeometry({ windowHandle: 42 });
  assert.deepEqual(g.region, { x: 10, y: 20, width: 800, height: 600 });
});

test("readLiveGeometry survives an unreadable app list", async () => {
  const s = createWindowSurface({
    nativeWindow: fakeNative(),
    getRunningApps: async () => ({ ok: false, error: "Automation denied" }),
  });
  const g = await s.readLiveGeometry();
  assert.equal(g.ok, true);
  assert.equal(g.frontmostApp, "");
});

test("listWindows skips windows that cannot be read", () => {
  const native = fakeNative({
    rects: { 42: { x: 10, y: 20, width: 800, height: 600 } },
    windows: [42, 77],
  });
  const s = createWindowSurface({ nativeWindow: native, getRunningApps: okApps });
  const r = s.listWindows();
  assert.equal(r.ok, true);
  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].handle, 42);
});

test("a throwing native call is reported, not swallowed", () => {
  const native = {
    getActiveWindow: () => { throw new Error("accessibility revoked"); },
    getWindowRect: () => { throw new Error("accessibility revoked"); },
    getWindowTitle: () => "",
    getWindows: () => { throw new Error("accessibility revoked"); },
    focusWindow: () => { throw new Error("accessibility revoked"); },
  };
  const s = createWindowSurface({ nativeWindow: native, getRunningApps: okApps });
  assert.equal(s.activeWindow().error, "window_read_failed");
  assert.equal(s.regionForHandle(42).error, "window_read_failed");
  assert.equal(s.listWindows().error, "window_list_failed");
  assert.equal(s.focusWindow(42).error, "focus_failed");
  assert.match(s.regionForHandle(42).hint, /accessibility revoked/);
});
