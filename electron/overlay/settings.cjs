"use strict";

function attachOverlaySettings(d) {
  if (d.__attached_attachOverlaySettings) return;
  d.__attached_attachOverlaySettings = true;
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

function overlaySettingsPath() {
  return path.join(app.getPath("userData"), "overlay-settings.json");
}

function readOverlaySettings() {
  try {
    return JSON.parse(fsSync.readFileSync(overlaySettingsPath(), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeOverlaySettings(patch) {
  const next = { ...readOverlaySettings(), ...patch };
  try {
    fsSync.writeFileSync(overlaySettingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("[LYKN] failed to write overlay settings:", e?.message);
  }
  return next;
}

function isContentProtectionEnabled() {
  const v = readOverlaySettings().contentProtection;
  return v === undefined ? true : !!v;
}

function applyContentProtection(enabled) {
  const on = enabled === undefined ? isContentProtectionEnabled() : !!enabled;
  for (const win of [
    d.overlayWindow,
    d.burstWindow,
    d.menuWindow,
    d.pickerWindow,
    d.langPickerWindow,
    d.liveWindow,
    d.panelWindow,
    d.agentSidebarWindow,
    d.agentStageWindow,
  ]) {
    try {
      if (win && !win.isDestroyed()) win.setContentProtection(on);
    } catch {
      /* platform may not support it (e.g. Linux) */
    }
  }
  return on;
}

  d.applyContentProtection = applyContentProtection;
  d.isContentProtectionEnabled = isContentProtectionEnabled;
  d.overlaySettingsPath = overlaySettingsPath;
  d.readOverlaySettings = readOverlaySettings;
  d.writeOverlaySettings = writeOverlaySettings;
}

module.exports = { attachOverlaySettings };
