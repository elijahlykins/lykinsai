"use strict";

/**
 * Desktop control — the see→aim→act loop over the surface primitives.
 *
 * Two model-facing tools live here (dispatched by localSystem.cjs):
 *
 *   local_desktop_look  Screenshot of the screen or one window. The pixels go
 *                       back as `imageDataUrl`, which the chat agent loop
 *                       delivers to the model as a REAL image — the model
 *                       sees the screen, it does not read a description of it.
 *   local_desktop_act   One physical action (click, drag, scroll, type, key,
 *                       focus) aimed with 0-1000 coordinates on the last look.
 *
 * The correctness core is NOT here — it is surface/frame.cjs (frame epochs +
 * drift guards), surface/input.cjs (native input), surface/windows.cjs
 * (geometry). This module only owns the tool grammar, the one-frame state
 * machine between look and act, and macOS screen capture.
 *
 * Approval model: the FIRST act of a session pauses for user consent
 * ("let LYKN control this Mac"); after that the session is armed and actions
 * flow — a 30-click task cannot ask 30 times. localSystem.classifyRisk
 * consults sessionArmed(); dispatch calls armSession() (reaching dispatch
 * means the approval gate passed). Look never needs approval: it observes.
 *
 * Refusals are recovery hints, not failures: a stale/drifted frame tells the
 * model to take a fresh look, exactly like the browser agent's rounds.
 */

const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");

const {
  buildFrame,
  mapNormToScreen,
  frameDriftBlock,
  NORM_MAX,
} = require("./surface/frame.cjs");
const input = require("./surface/input.cjs");
const { createWindowSurface } = require("./surface/windows.cjs");

/** Vision models see ~1500px wide best; bigger only costs tokens. */
const MAX_IMAGE_WIDTH = 1568;
const JPEG_QUALITY = 80;
const FOCUS_SETTLE_MS = 250;
const MAX_WINDOWS_LISTED = 14;

const AIM_NOTE =
  `Coordinates for local_desktop_act are 0-${NORM_MAX} on THIS image ` +
  `(x: 0 = left edge, ${NORM_MAX} = right edge; y: 0 = top, ${NORM_MAX} = bottom).`;

// ---------------------------------------------------------------------------
// Session approval (process lifetime)
// ---------------------------------------------------------------------------

let sessionArmedFlag = false;

/** Has the user already said yes to desktop control this session? */
function sessionArmed() {
  return sessionArmedFlag;
}

/** Called from dispatch — reaching dispatch means the approval gate passed. */
function armSession() {
  sessionArmedFlag = true;
}

// ---------------------------------------------------------------------------
// macOS capture
// ---------------------------------------------------------------------------

function execFileP(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Capture a screen region to a JPEG data URL, downscaled for vision.
 * `screencapture` works in global screen points and produces Retina-scale
 * pixels; the frame carries the region in points, so mapping is unaffected.
 * Without the Screen Recording grant it still succeeds but windows render as
 * wallpaper — the look result warns when geometry reads also fail.
 */
async function captureRegionDefault(region) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "unsupported_platform", hint: "Desktop capture is macOS-only right now." };
  }
  const file = path.join(os.tmpdir(), `lykn-look-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await execFileP(
      "screencapture",
      ["-x", "-R", `${region.x},${region.y},${region.width},${region.height}`, file],
      15_000,
    );
    let dataUrl = "";
    let imgW = 0;
    let imgH = 0;
    try {
      // Electron main: downscale + JPEG via nativeImage (a Retina full-screen
      // PNG is ~10 MB of base64; the model needs none of that).
      const { nativeImage } = require("electron");
      let img = nativeImage.createFromPath(file);
      if (img.isEmpty()) throw new Error("empty capture");
      if (img.getSize().width > MAX_IMAGE_WIDTH) img = img.resize({ width: MAX_IMAGE_WIDTH });
      const size = img.getSize();
      imgW = size.width;
      imgH = size.height;
      dataUrl = `data:image/jpeg;base64,${img.toJPEG(JPEG_QUALITY).toString("base64")}`;
    } catch {
      const buf = await fsp.readFile(file);
      dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    }
    return { ok: true, dataUrl, imgW, imgH };
  } catch (e) {
    const msg = String(e?.message || e);
    return {
      ok: false,
      error: "capture_failed",
      // "could not create image from rect" is macOS's way of saying the
      // Screen Recording grant is missing for THIS binary. Say that instead
      // of echoing the command line at the model.
      hint: /could not create image/i.test(msg)
        ? "macOS blocked the screenshot — LYKN needs Screen Recording permission. " +
          "System Settings → Privacy & Security → Screen Recording → allow LYKN, then reopen it."
        : msg,
    };
  } finally {
    fsp.unlink(file).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The control surface
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * @param {object} [deps]  injectable for tests
 * @param {Function} [deps.capture]        (region) → { ok, dataUrl, imgW, imgH }
 * @param {object}   [deps.inputSurface]   surface/input.cjs shape
 * @param {object}   [deps.windowSurface]  surface/windows.cjs shape
 * @param {Function} [deps.getRunningApps] () → { ok, frontmost, running }
 * @param {Function} [deps.now]
 */
function createDesktopControl({
  capture = captureRegionDefault,
  inputSurface = input,
  windowSurface = null,
  getRunningApps = null,
  now = Date.now,
} = {}) {
  const windows =
    windowSurface || createWindowSurface({ getRunningApps: getRunningApps || undefined });

  /** The one live frame. An act is only as good as the look it aims off. */
  let lastFrame = null;

  async function screenRegion() {
    const size = await inputSurface.screenSize();
    if (size.ok) return { x: 0, y: 0, width: size.width, height: size.height };
    // Native layer missing (permissions, packaging) — Electron still knows
    // the display bounds, and a screen-scoped look remains useful.
    try {
      // eslint-disable-next-line global-require
      const { screen } = require("electron");
      const b = screen.getPrimaryDisplay().bounds;
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch {
      return null;
    }
  }

  async function frontmostAppName() {
    try {
      if (typeof getRunningApps === "function") {
        const res = await getRunningApps();
        if (res?.ok) return String(res.frontmost || "");
      } else {
        const res = await windows.frontmostApp();
        if (res?.ok) return String(res.frontmost || "");
      }
    } catch {
      /* diagnostic only */
    }
    return "";
  }

  function listWindowTitles() {
    const res = windows.listWindows();
    if (!res.ok) return [];
    return res.windows
      .filter((w) => w.title)
      .slice(0, MAX_WINDOWS_LISTED)
      .map((w) => ({ handle: w.handle, title: w.title }));
  }

  function findWindow(query) {
    const want = String(query || "").trim().toLowerCase();
    if (!want) return null;
    const res = windows.listWindows();
    if (!res.ok) return null;
    return (
      res.windows.find((w) => w.title.toLowerCase() === want) ||
      res.windows.find((w) => w.title.toLowerCase().includes(want)) ||
      null
    );
  }

  /**
   * local_desktop_look — capture the screen (default) or one window (`window`
   * matches a title; the window is focused first so it is actually visible).
   */
  async function look({ window: windowQuery = "" } = {}) {
    let region = null;
    let windowTitle = "";
    let windowHandle = null;
    let focusHint = "";

    if (windowQuery) {
      const found = findWindow(windowQuery);
      if (!found) {
        const titles = listWindowTitles().map((w) => w.title);
        return {
          ok: false,
          error: "window_not_found",
          hint:
            `No window title matches "${windowQuery}". ` +
            (titles.length
              ? `Open windows: ${titles.join(" | ")}.`
              : "No window titles are readable — LYKN may be missing the Accessibility/Screen Recording permission."),
        };
      }
      const focused = windows.focusWindow(found.handle);
      if (focused.ok) await sleep(FOCUS_SETTLE_MS);
      else focusHint = " (could not raise it — it may be partly covered)";
      const geo = windows.regionForHandle(found.handle);
      if (!geo.ok) return { ok: false, error: geo.error, hint: geo.hint };
      region = geo.region;
      windowTitle = geo.title;
      windowHandle = found.handle;
    } else {
      region = await screenRegion();
      if (!region) {
        return {
          ok: false,
          error: "no_screen_geometry",
          hint: "Could not read the screen size — native input and Electron display info are both unavailable.",
        };
      }
    }

    const shot = await capture(region);
    if (!shot.ok) return { ok: false, error: shot.error, hint: shot.hint };

    const frontmostApp = await frontmostAppName();
    lastFrame = buildFrame({
      region,
      frontmostApp,
      windowTitle,
      windowHandle,
      imgW: shot.imgW,
      imgH: shot.imgH,
      at: now(),
    });

    return {
      ok: true,
      imageDataUrl: shot.dataUrl,
      view: windowTitle ? `window: ${windowTitle}${focusHint}` : "full screen",
      frontmostApp,
      windows: listWindowTitles().map((w) => w.title),
      note: `${AIM_NOTE} Act right after looking — the frame goes stale as the screen changes.`,
    };
  }

  /** Live geometry to validate the frame against, matching its scope. */
  async function readLive(frame) {
    if (frame.windowHandle != null) {
      return windows.readLiveGeometry({ windowHandle: frame.windowHandle });
    }
    const region = await screenRegion();
    return { ok: !!region, region, frontmostApp: await frontmostAppName() };
  }

  const NEEDS_POINT = new Set(["click", "double_click", "right_click", "move"]);
  const ALL_ACTIONS = new Set([
    ...NEEDS_POINT, "drag", "scroll", "type", "key", "focus_window",
  ]);

  /**
   * local_desktop_act — one physical action aimed off the last look.
   * Returns drift refusals as { ok:false, error, hint } recovery rounds.
   */
  async function act(args = {}) {
    const action = String(args.action || "").trim().toLowerCase();
    if (!ALL_ACTIONS.has(action)) {
      return {
        ok: false,
        error: action ? "unknown_action" : "missing_action",
        hint: `${action ? `"${action}" is not an action. ` : ""}Use click, double_click, right_click, drag, scroll, type, key, focus_window, or move.`,
      };
    }

    if (action === "focus_window") {
      const found = findWindow(args.window);
      if (!found) {
        const titles = listWindowTitles().map((w) => w.title);
        return {
          ok: false,
          error: "window_not_found",
          hint: `No window title matches "${String(args.window || "")}". Open windows: ${titles.join(" | ") || "(none readable)"}.`,
        };
      }
      const res = windows.focusWindow(found.handle);
      if (!res.ok) return res;
      await sleep(FOCUS_SETTLE_MS);
      return { ok: true, focused: found.title, note: "Take a fresh local_desktop_look before aiming clicks." };
    }

    // type / key act on the focused control — no coordinates, no drift check.
    if (action === "type") {
      const res = await inputSurface.typeText(args.text);
      return res.ok ? { ...res, note: "Typed into the focused control. Look again to verify it landed where intended." } : res;
    }
    if (action === "key") {
      const res = await inputSurface.pressKey({ key: args.key, modifiers: args.modifiers });
      return res.ok ? { ...res, note: "Look again if this should have changed the screen." } : res;
    }

    // Everything below aims at coordinates from the last look.
    if (!lastFrame) {
      return { ok: false, error: "no_frame", hint: "Take a local_desktop_look first — coordinates only mean something on a screenshot." };
    }
    const live = await readLive(lastFrame);
    const block = frameDriftBlock(lastFrame, live, { now: now() });
    if (block) return block;

    if (action === "scroll") {
      let at = {};
      if (args.x != null || args.y != null) {
        const p = mapNormToScreen(args.x, args.y, lastFrame);
        if (!p.ok) return p;
        at = { x: p.x, y: p.y };
      }
      return inputSurface.scroll({
        ...at,
        direction: args.direction,
        amount: args.amount,
        modifiers: args.modifiers,
      });
    }

    if (action === "drag") {
      const from = mapNormToScreen(args.x, args.y, lastFrame);
      if (!from.ok) return from;
      const to = mapNormToScreen(args.toX, args.toY, lastFrame);
      if (!to.ok) return { ...to, hint: `${to.hint || ""} Drag needs toX and toY as well.`.trim() };
      const res = await inputSurface.drag({
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        button: args.button,
        modifiers: args.modifiers,
      });
      return res.ok ? { ...res, note: "Look again to see what the drag did." } : res;
    }

    if (NEEDS_POINT.has(action)) {
      const p = mapNormToScreen(args.x, args.y, lastFrame);
      if (!p.ok) return p;
      if (action === "move") return inputSurface.moveTo(p.x, p.y);
      const res = await inputSurface.click({
        x: p.x,
        y: p.y,
        button: action === "right_click" ? "right" : args.button || "left",
        count: action === "double_click" ? 2 : 1,
        modifiers: args.modifiers,
      });
      return res.ok ? { ...res, note: "Look again to verify the click did what you expected." } : res;
    }

    // Unreachable: ALL_ACTIONS gated above.
    return { ok: false, error: "unknown_action", hint: "" };
  }

  return { look, act, _frame: () => lastFrame };
}

// ---------------------------------------------------------------------------
// Singleton for localSystem dispatch
// ---------------------------------------------------------------------------

let singleton = null;

function getDesktopControl(deps) {
  if (!singleton) singleton = createDesktopControl(deps);
  return singleton;
}

module.exports = {
  createDesktopControl,
  getDesktopControl,
  sessionArmed,
  armSession,
  captureRegionDefault,
};
