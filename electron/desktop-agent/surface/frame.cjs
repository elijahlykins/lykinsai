"use strict";

/**
 * Frame epoch and coordinate mapping for the desktop agent.
 *
 * The browser agent learned this the hard way three separate times
 * (browser/controller.cjs layoutDriftBlock + staleViewBlock, and
 * ownedBrowserAct.cjs mapNormCoordToClient's `stale` flag). The principle,
 * stated at controller.cjs:139-143, is:
 *
 *   an observation is only actionable while the geometry it was taken under
 *   still holds.
 *
 * It matters MORE here than in the browser. A page has durable element refs
 * that re-resolve by selector at act time, so only point-aimed actions pay the
 * check. A native app has no refs at all — every desktop action is aimed at a
 * coordinate, so every action pays it. A window dragged 200px between the
 * screenshot and the click puts the click on whatever moved into that spot.
 *
 * This module is deliberately PURE: no electron, no libnut, no I/O. The whole
 * correctness argument for desktop control lives in functions that a headless
 * test can drive with plain objects.
 */

/**
 * Fraction of the captured region a window may drift before its coordinates
 * are refused. Matches LAYOUT_DRIFT_TOLERANCE in the browser controller: 2%
 * absorbs shadow/rounding noise without absorbing a real move.
 */
const DEFAULT_DRIFT_TOLERANCE = 0.02;

/**
 * A frame older than this is refused outright. Observations arrive once per
 * round, so a frame this old means the round stalled (a slow model call, a
 * held approval) and the screen has had time to become fiction.
 */
const DEFAULT_MAX_AGE_MS = 30_000;

/** Normalized coordinate space the model speaks, on every surface. */
const NORM_MAX = 1000;

let frameGeneration = 0;

/**
 * Region shape: { x, y, width, height } in GLOBAL screen points, where x/y is
 * the top-left corner on the virtual desktop (so a second monitor left of the
 * primary has negative x — the reason we never assume the primary display).
 */
function isUsableRegion(region) {
  if (!region || typeof region !== "object") return false;
  const { x, y, width, height } = region;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return false;
  // libnut reports an unavailable window as a 0x0 region rather than throwing
  // (verified: getActiveWindow returns -1 and getWindowRegion returns
  // {0,0,0,0} when Accessibility is not granted). A zero-area region must
  // never be treated as a real frame — every coordinate would map to its
  // origin, which is a click at the top-left of the screen.
  return width > 0 && height > 0;
}

/**
 * Record the geometry an observation was taken under.
 *
 * @param {object} opts
 * @param {{x:number,y:number,width:number,height:number}} opts.region  captured area, global screen points
 * @param {string} [opts.frontmostApp]   app owning the frontmost window at capture
 * @param {string} [opts.windowTitle]    title of the targeted window, when window-scoped
 * @param {number|null} [opts.windowHandle]
 * @param {number|null} [opts.displayId]
 * @param {number} [opts.scaleFactor]
 * @param {number} [opts.imgW]  pixel width of the image the model actually saw
 * @param {number} [opts.imgH]
 * @param {number} [opts.at]    capture timestamp
 * @returns {object} frame
 */
function buildFrame({
  region,
  frontmostApp = "",
  windowTitle = "",
  windowHandle = null,
  displayId = null,
  scaleFactor = 1,
  imgW = 0,
  imgH = 0,
  at = Date.now(),
} = {}) {
  frameGeneration += 1;
  return {
    generation: frameGeneration,
    region: isUsableRegion(region)
      ? { x: region.x, y: region.y, width: region.width, height: region.height }
      : null,
    frontmostApp: String(frontmostApp || ""),
    windowTitle: String(windowTitle || ""),
    windowHandle,
    displayId,
    scaleFactor: Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1,
    imgW: Number(imgW) || 0,
    imgH: Number(imgH) || 0,
    at,
    invalidated: false,
  };
}

/** Mark a frame unusable — the desktop analogue of controller.invalidate(). */
function invalidateFrame(frame) {
  if (frame && typeof frame === "object") frame.invalidated = true;
  return frame;
}

/**
 * Map a model coordinate (0-1000 on the captured image) to a global screen point.
 *
 * Normalization is against the CAPTURED REGION, not the primary display. This
 * is the bug in electron/browserAct.cjs resolveVisionCoords, which divides by
 * screen.getPrimaryDisplay().size unconditionally: on a window-scoped capture
 * every click lands in the wrong place, and on a second monitor it lands on
 * the wrong screen entirely.
 *
 * Screen points, not pixels: Electron's screen API and libnut both work in
 * points, so a Retina scaleFactor of 2 needs no arithmetic here. scaleFactor
 * is carried on the frame for diagnostics only.
 *
 * @returns {{ok:true, x:number, y:number}|{ok:false, error:string, hint?:string}}
 */
function mapNormToScreen(nx, ny, frame) {
  if (!frame || !frame.region) {
    return { ok: false, error: "no_frame", hint: "No usable capture geometry — take a screenshot first." };
  }
  const x = Number(nx);
  const y = Number(ny);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: "bad_coordinates", hint: "Coordinates must be numbers between 0 and 1000." };
  }
  if (x < 0 || x > NORM_MAX || y < 0 || y > NORM_MAX) {
    return {
      ok: false,
      error: "bad_coordinates",
      hint: `Coordinates are 0-${NORM_MAX} on the screenshot; got (${x}, ${y}).`,
    };
  }
  const { region } = frame;
  return {
    ok: true,
    x: Math.round(region.x + (x / NORM_MAX) * region.width),
    y: Math.round(region.y + (y / NORM_MAX) * region.height),
  };
}

/**
 * How far the live geometry has moved from the frame's, as a fraction of the
 * frame's own size.
 *
 * Position drift is measured against SIZE on purpose: a 40px shift matters
 * enormously in a 200px palette and not at all across a 3000px window, and it
 * is the offset in the frame's own units that decides whether a mapped point
 * still lands on the thing the model aimed at.
 *
 * @returns {number} 0 when identical, Infinity when either region is unusable
 */
function frameDrift(frame, live) {
  if (!frame || !isUsableRegion(frame.region) || !isUsableRegion(live)) return Infinity;
  const f = frame.region;
  return Math.max(
    Math.abs(live.x - f.x) / f.width,
    Math.abs(live.y - f.y) / f.height,
    Math.abs(live.width - f.width) / f.width,
    Math.abs(live.height - f.height) / f.height,
  );
}

/**
 * The guard. Returns null when the frame is still actionable, or a refusal the
 * loop can hand back to the model as a recovery hint.
 *
 * A refusal is NOT a failure: the browser agent's equivalent feeds the hint
 * into the next round, the model re-observes, and the task continues. Refusing
 * costs one round; acting on a stale frame costs a click somewhere unknown.
 *
 * @param {object} frame       the frame the coordinates were read off
 * @param {object} live        { region, frontmostApp } measured right now
 * @param {object} [opts]
 * @returns {null|{ok:false, error:string, hint:string}}
 */
function frameDriftBlock(frame, live, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_DRIFT_TOLERANCE;
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  if (!frame || !frame.region) {
    return { ok: false, error: "no_frame", hint: "No usable capture geometry — take a screenshot first." };
  }
  if (frame.invalidated) {
    return {
      ok: false,
      error: "stale_view",
      hint: "The screen changed since that screenshot. Take a new one before aiming.",
    };
  }
  if (now - frame.at > maxAgeMs) {
    return {
      ok: false,
      error: "stale_view",
      hint: `That screenshot is ${Math.round((now - frame.at) / 1000)}s old. Take a new one before aiming.`,
    };
  }

  // Focus change beats geometry. If a different app came forward — a save
  // sheet, a notification, an installer — the window we measured may not even
  // be on top any more, so a point inside its old bounds now lands on whatever
  // is covering it. Geometry can be unchanged and the click still wrong.
  const wasFront = String(frame.frontmostApp || "");
  const isFront = String(live?.frontmostApp || "");
  if (wasFront && isFront && wasFront !== isFront) {
    return {
      ok: false,
      error: "frame_changed",
      hint: `${isFront} came to the front after that screenshot (was ${wasFront}). Take a new one before aiming.`,
    };
  }

  if (!isUsableRegion(live?.region)) {
    return {
      ok: false,
      error: "frame_changed",
      hint: "The target window is no longer readable — it may have closed or minimized.",
    };
  }

  const drift = frameDrift(frame, live.region);
  if (drift > tolerance) {
    const f = frame.region;
    const l = live.region;
    return {
      ok: false,
      error: "frame_changed",
      hint:
        `The window moved or resized after that screenshot ` +
        `(${f.width}x${f.height} at ${f.x},${f.y} -> ${l.width}x${l.height} at ${l.x},${l.y}). ` +
        `Take a new screenshot before aiming.`,
    };
  }

  return null;
}

module.exports = {
  DEFAULT_DRIFT_TOLERANCE,
  DEFAULT_MAX_AGE_MS,
  NORM_MAX,
  buildFrame,
  invalidateFrame,
  isUsableRegion,
  mapNormToScreen,
  frameDrift,
  frameDriftBlock,
};
