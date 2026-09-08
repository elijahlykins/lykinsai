"use strict";

// Desktop control: the look→act state machine over injected fake surfaces —
// aiming math, drift refusals, focus flows, and the session approval flag.
// The primitives underneath have their own suites (frame/input/windows).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createDesktopControl, sessionArmed, armSession } = require("./desktopControl.cjs");

const SCREEN = { x: 0, y: 0, width: 1000, height: 800 };
const BLENDER = { handle: 7, title: "Blender", region: { x: 100, y: 50, width: 600, height: 400 } };

function fakes({ liveRegion = null, frontmost = "Finder", captureOk = true } = {}) {
  const calls = [];
  const state = { frontmost, blenderRegion: BLENDER.region, live: liveRegion };

  const inputSurface = {
    screenSize: async () => ({ ok: true, width: SCREEN.width, height: SCREEN.height }),
    click: async (a) => (calls.push(["click", a]), { ok: true, ...a }),
    drag: async (a) => (calls.push(["drag", a]), { ok: true, ...a }),
    scroll: async (a) => (calls.push(["scroll", a]), { ok: true, ...a }),
    typeText: async (t) => (calls.push(["type", t]), { ok: true, length: String(t).length }),
    pressKey: async (a) => (calls.push(["key", a]), { ok: true, ...a }),
    moveTo: async (x, y) => (calls.push(["move", { x, y }]), { ok: true, x, y }),
  };
  const windowSurface = {
    listWindows: () => ({ ok: true, windows: [{ ...BLENDER, region: state.blenderRegion }] }),
    focusWindow: (h) => (calls.push(["focus", h]), { ok: true, handle: h }),
    regionForHandle: (h) =>
      h === BLENDER.handle
        ? { ok: true, handle: h, region: state.blenderRegion, title: BLENDER.title }
        : { ok: false, error: "no_window", hint: "gone" },
    readLiveGeometry: async () => ({
      ok: true,
      region: state.live || state.blenderRegion,
      frontmostApp: state.frontmost,
      windowTitle: BLENDER.title,
      windowHandle: BLENDER.handle,
    }),
    frontmostApp: async () => ({ ok: true, frontmost: state.frontmost, running: [] }),
  };
  const capture = async (region) => {
    calls.push(["capture", region]);
    return captureOk
      ? { ok: true, dataUrl: "data:image/jpeg;base64,QUFB", imgW: region.width, imgH: region.height }
      : { ok: false, error: "capture_failed", hint: "nope" };
  };
  const getRunningApps = async () => ({ ok: true, frontmost: state.frontmost, running: ["Finder", "Blender"] });

  const control = createDesktopControl({ capture, inputSurface, windowSurface, getRunningApps });
  return { control, calls, state };
}

test("look returns real pixels plus the aiming contract; act maps 0-1000 to screen points", async () => {
  const { control, calls } = fakes();

  const seen = await control.look({});
  assert.equal(seen.ok, true);
  assert.match(seen.imageDataUrl, /^data:image\/jpeg/);
  assert.equal(seen.view, "full screen");
  assert.match(seen.note, /0-1000/);
  assert.deepEqual(calls.find(([k]) => k === "capture")[1], SCREEN);

  // (500, 500) normalized on a 1000x800 screen = (500, 400) in points.
  const clicked = await control.act({ action: "click", x: 500, y: 500 });
  assert.equal(clicked.ok, true);
  const call = calls.find(([k]) => k === "click")[1];
  assert.equal(call.x, 500);
  assert.equal(call.y, 400);
  assert.match(clicked.note, /Look again/);
});

test("acting blind is refused: coordinates only mean something on a screenshot", async () => {
  const { control } = fakes();
  const res = await control.act({ action: "click", x: 500, y: 500 });
  assert.equal(res.ok, false);
  assert.equal(res.error, "no_frame");
  assert.match(res.hint, /local_desktop_look/);
});

test("window-scoped look focuses the window and maps into its global region", async () => {
  const { control, calls } = fakes();
  const seen = await control.look({ window: "blend" });
  assert.equal(seen.ok, true);
  assert.match(seen.view, /Blender/);
  assert.deepEqual(calls.find(([k]) => k === "capture")[1], BLENDER.region);
  assert.equal(calls.some(([k, v]) => k === "focus" && v === BLENDER.handle), true);

  // Center of the image = center of the WINDOW: 100 + 600/2, 50 + 400/2.
  await control.act({ action: "click", x: 500, y: 500 });
  const call = calls.find(([k]) => k === "click")[1];
  assert.equal(call.x, 400);
  assert.equal(call.y, 250);
});

test("a moved window turns the act into a take-a-new-look refusal, not a wrong click", async () => {
  const { control, state } = fakes();
  await control.look({ window: "Blender" });
  state.live = { ...BLENDER.region, x: BLENDER.region.x + 200 }; // dragged 200px
  const res = await control.act({ action: "click", x: 500, y: 500 });
  assert.equal(res.ok, false);
  assert.equal(res.error, "frame_changed");
  assert.match(res.hint, /new screenshot/i);
});

test("an app stealing focus after a screen look also forces a re-look", async () => {
  const { control, state } = fakes({ frontmost: "Finder" });
  await control.look({});
  state.frontmost = "Installer"; // something came to the front
  const res = await control.act({ action: "click", x: 10, y: 10 });
  assert.equal(res.ok, false);
  assert.equal(res.error, "frame_changed");
  assert.match(res.hint, /Installer/);
});

test("type and key act on the focused control without needing a frame", async () => {
  const { control, calls } = fakes();
  const typed = await control.act({ action: "type", text: "hello" });
  assert.equal(typed.ok, true);
  assert.deepEqual(calls.find(([k]) => k === "type")[1], "hello");
  const key = await control.act({ action: "key", key: "enter", modifiers: ["cmd"] });
  assert.equal(key.ok, true);
});

test("drag maps both endpoints and refuses a missing destination", async () => {
  const { control, calls } = fakes();
  await control.look({});
  const ok = await control.act({ action: "drag", x: 0, y: 0, toX: 1000, toY: 1000 });
  assert.equal(ok.ok, true);
  const d = calls.find(([k]) => k === "drag")[1];
  assert.deepEqual([d.fromX, d.fromY, d.toX, d.toY], [0, 0, 1000, 800]);

  const bad = await control.act({ action: "drag", x: 0, y: 0 });
  assert.equal(bad.ok, false);
  assert.match(bad.hint, /toX and toY/);
});

test("unknown windows and unknown actions answer with guidance", async () => {
  const { control } = fakes();
  const win = await control.act({ action: "focus_window", window: "Photoshop" });
  assert.equal(win.ok, false);
  assert.match(win.hint, /Blender/); // lists what IS open

  const bad = await control.act({ action: "teleport" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "unknown_action");

  const noLook = await control.look({ window: "Photoshop" });
  assert.equal(noLook.ok, false);
  assert.equal(noLook.error, "window_not_found");
});

test("failed capture reports instead of returning a frame to aim at", async () => {
  const { control } = fakes({ captureOk: false });
  const res = await control.look({});
  assert.equal(res.ok, false);
  assert.equal(res.error, "capture_failed");
  const after = await control.act({ action: "click", x: 1, y: 1 });
  assert.equal(after.error, "no_frame");
});

test("session approval: off until armed, then remembered for the process", () => {
  assert.equal(sessionArmed(), false);
  armSession();
  assert.equal(sessionArmed(), true);
});
