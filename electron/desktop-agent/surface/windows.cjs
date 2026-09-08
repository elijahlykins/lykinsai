"use strict";

/**
 * Window and app geometry for the desktop agent.
 *
 * Supplies the two halves of the frame epoch (see frame.cjs): the region a
 * capture covered, and which app owned the front window when it was taken.
 *
 * The native window API degrades SILENTLY when macOS has not granted this
 * binary Accessibility and Screen Recording. Verified by hand: window titles
 * come back as "" without Screen Recording, and with neither grant
 * getActiveWindow() returns the handle -1 and the rect is {0,0,0,0}. Nothing
 * throws. A 0x0 region would map every model coordinate onto its own origin —
 * a click at the top-left of the screen — so every read is validated here and
 * reported as unavailable rather than passed on as geometry.
 *
 * Accessibility is granted per BINARY: a dev run (Electron.app) and a packaged
 * run (LYKN.app) carry separate grants.
 */

const { nativeWindowProvider } = require("./input.cjs");

/** The native layer reports an unavailable window as this handle. */
const NO_WINDOW = -1;

const PERMISSION_HINT =
  "LYKN needs Accessibility and Screen Recording permission to see window positions. " +
  "System Settings -> Privacy & Security -> Accessibility (and Screen Recording), then reopen LYKN.";

/**
 * Native rect -> our region. Accepts both {x,y,...} (raw binding) and
 * {left,top,...} (wrapper) shapes, and rejects the zero-area sentinel.
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function normalizeRegion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = Number(raw.x ?? raw.left);
  const y = Number(raw.y ?? raw.top);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.nativeWindow]  the native provider (injected in tests)
 * @param {() => Promise<{ok:boolean, frontmost?:string, running?:string[], error?:string}>} [deps.getRunningApps]
 */
function createWindowSurface({ nativeWindow = null, getRunningApps = null } = {}) {
  const win = () => nativeWindow || nativeWindowProvider();

  async function frontmostApp() {
    if (typeof getRunningApps !== "function") {
      return { ok: false, error: "no_app_reader", hint: "No running-app reader configured." };
    }
    try {
      const res = await getRunningApps();
      if (!res || res.ok !== true) {
        return { ok: false, error: "app_read_failed", hint: res?.error || "Could not read running apps." };
      }
      return { ok: true, frontmost: String(res.frontmost || ""), running: res.running || [] };
    } catch (e) {
      return { ok: false, error: "app_read_failed", hint: String(e?.message || e) };
    }
  }

  function regionForHandle(handle) {
    const w = win();
    if (!w) return { ok: false, error: "native_input_unavailable", hint: PERMISSION_HINT };
    if (handle === NO_WINDOW || handle == null) {
      return { ok: false, error: "no_window", hint: PERMISSION_HINT };
    }
    try {
      const region = normalizeRegion(w.getWindowRect(handle));
      if (!region) return { ok: false, error: "no_window", hint: PERMISSION_HINT };
      let title = "";
      try {
        title = String(w.getWindowTitle(handle) || "");
      } catch {
        /* title is diagnostic only — a readable region without one is fine */
      }
      return { ok: true, handle, region, title };
    } catch (e) {
      return { ok: false, error: "window_read_failed", hint: String(e?.message || e) };
    }
  }

  function activeWindow() {
    const w = win();
    if (!w) return { ok: false, error: "native_input_unavailable", hint: PERMISSION_HINT };
    let handle;
    try {
      handle = w.getActiveWindow();
    } catch (e) {
      return { ok: false, error: "window_read_failed", hint: String(e?.message || e) };
    }
    return regionForHandle(handle);
  }

  /**
   * Measure the geometry frameDriftBlock compares a frame against.
   *
   * Pass the handle the frame was captured from so we re-measure THAT window
   * rather than whatever is active now — otherwise a transient focus steal
   * reads as a resize instead of the focus change it actually is.
   */
  async function readLiveGeometry({ windowHandle = null } = {}) {
    const geo = windowHandle == null ? activeWindow() : regionForHandle(windowHandle);
    const apps = await frontmostApp();
    return {
      ok: geo.ok === true,
      region: geo.ok ? geo.region : null,
      windowTitle: geo.ok ? geo.title : "",
      windowHandle: geo.ok ? geo.handle : null,
      frontmostApp: apps.ok ? apps.frontmost : "",
      hint: geo.ok ? "" : geo.hint || "",
    };
  }

  function listWindows() {
    const w = win();
    if (!w) return { ok: false, error: "native_input_unavailable", hint: PERMISSION_HINT };
    try {
      const handles = w.getWindows() || [];
      const windows = [];
      for (const h of handles) {
        const r = regionForHandle(h);
        if (r.ok) windows.push({ handle: h, title: r.title, region: r.region });
      }
      return { ok: true, windows };
    } catch (e) {
      return { ok: false, error: "window_list_failed", hint: String(e?.message || e) };
    }
  }

  function focusWindow(handle) {
    const w = win();
    if (!w) return { ok: false, error: "native_input_unavailable", hint: PERMISSION_HINT };
    if (handle === NO_WINDOW || handle == null) return { ok: false, error: "no_window", hint: PERMISSION_HINT };
    try {
      w.focusWindow(handle);
      return { ok: true, handle };
    } catch (e) {
      return { ok: false, error: "focus_failed", hint: String(e?.message || e) };
    }
  }

  return { activeWindow, regionForHandle, readLiveGeometry, listWindows, focusWindow, frontmostApp };
}

module.exports = { createWindowSurface, normalizeRegion, NO_WINDOW, PERMISSION_HINT };
