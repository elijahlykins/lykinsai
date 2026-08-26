"use strict";

function attachGlassChrome(d) {
  if (d.__attached_attachGlassChrome) return;
  d.__attached_attachGlassChrome = true;
  const {
    app, BrowserWindow, WebContentsView, shell, globalShortcut, Menu, ipcMain,
    desktopCapturer, screen, systemPreferences, dialog, nativeImage, clipboard,
    Tray, session, Notification, powerMonitor, nativeTheme, protocol,
    net: electronNet,
  } = d.electron;
  const path = d.node.path;
  const { pathToFileURL } = d.node.url;
  const fs = d.node.fs;
  const fsSync = d.node.fsSync;
  const crypto = d.node.crypto;
  const http = d.node.http;
  const { execFile } = d.node.childProcess;
  const { IS_MAC, IS_WIN, GLASS_FALLBACK, APP_URL, APP_ORIGIN, API_BASE } = d.env;
  const localStore = d.localStore;
  const macFiles = d.macFiles;
  const chromeSync = d.chromeSync;
  const localSystem = d.localSystem;
  const appDock = d.appDock;
  const localApprovals = d.localApprovals;
  const ownedBrowserAct = d.ownedBrowserAct;
  const agentRecentVisits = d.agentRecentVisits;
  const { broadcastToAllWindows } = require("../services/initializeElectronServices.cjs");
  const overlayConstants = d.constants;
  const {
    OVERLAY_WIDTH, OVERLAY_SIDE_WIDTH, OVERLAY_WATCH_SIDE_WIDTH, OVERLAY_MAX_WIDTH,
    OVERLAY_MIN_HEIGHT, OVERLAY_BOTTOM_MARGIN, GLASS_CORNER_RADIUS, OVERLAY_BUBBLE,
    OVERLAY_ACTIVATABLE_FOR_DROPS, MENU_WIDTH, MENU_GAP, MENU_MIN_HEIGHT, MENU_MAX_HEIGHT,
    PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT, LIVE_WIDTH, LIVE_HEIGHT,
    PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, UPDATE_REPROMPT_MS,
  } = overlayConstants;
  const ELECTRON_DIR = path.join(__dirname, "..");

function floatingGlassChrome() {
  if (IS_MAC) {
    return {
      transparent: false,
      backgroundColor: "#00000000",
      vibrancy: "hud",
      visualEffectState: "active",
      roundedCorners: true,
      hasShadow: true,
    };
  }
  return {
    transparent: true,
    backgroundColor: "#00000000",
    // Win11 DWM draws its own rounded frame/shadow outside CSS radius —
    // that shows as square "corner stubs". Kill native chrome; CSS owns shape.
    roundedCorners: false,
    hasShadow: false,
    thickFrame: false,
    backgroundMaterial: "none",
  };
}

function roundedRectShape(width, height, radius) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(w / 2), Math.floor(h / 2)));
  if (r <= 0) return [{ x: 0, y: 0, width: w, height: h }];
  const rects = [];
  for (let y = 0; y < h; y++) {
    let inset = 0;
    if (y < r) {
      const dy = r - y;
      inset = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    } else if (y >= h - r) {
      const dy = y - (h - r - 1);
      inset = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    }
    const rw = w - inset * 2;
    if (rw > 0) rects.push({ x: inset, y, width: rw, height: 1 });
  }
  return rects;
}

function applyFloatingGlassShape(win, radius = GLASS_CORNER_RADIUS) {
  if (!IS_WIN || !win || win.isDestroyed()) return;
  if (typeof win.setShape !== "function") return;
  try {
    const b = win.getBounds();
    const r = Math.min(radius, Math.floor(Math.min(b.width, b.height) / 2));
    win.setShape(roundedRectShape(b.width, b.height, r));
  } catch (_) { /* ignore */ }
}

function hardenFloatingGlass(win) {
  if (!IS_WIN || !win || win.isDestroyed()) return;
  try {
    if (typeof win.setHasShadow === "function") win.setHasShadow(false);
  } catch (_) { /* ignore */ }
  try {
    if (typeof win.setBackgroundMaterial === "function") win.setBackgroundMaterial("none");
  } catch (_) { /* ignore */ }
  applyFloatingGlassShape(win);
  // DWM sometimes re-applies chrome on show — re-clip without stacking listeners.
  if (!win.__lyknGlassHardened) {
    win.__lyknGlassHardened = true;
    win.on("show", () => hardenFloatingGlass(win));
  }
}

function setFloatingBounds(win, bounds) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setBounds(bounds, false);
  } catch (_) {
    try { win.setBounds(bounds); } catch (_) { /* ignore */ }
  }
  applyFloatingGlassShape(win);
}

  d.applyFloatingGlassShape = applyFloatingGlassShape;
  d.floatingGlassChrome = floatingGlassChrome;
  d.hardenFloatingGlass = hardenFloatingGlass;
  d.roundedRectShape = roundedRectShape;
  d.setFloatingBounds = setFloatingBounds;
}

module.exports = { attachGlassChrome };
