"use strict";

function attachAutoUpdate(d) {
  if (d.__attached_attachAutoUpdate) return;
  d.__attached_attachAutoUpdate = true;
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
  const createMainWindow = (...a) => d.createMainWindow(...a);
  const destroyAuthKeeper = (...a) => d.destroyAuthKeeper(...a);
  const refreshTrayUpdateAffordance = (...a) => d.refreshTrayUpdateAffordance(...a);

function quitForReal() {
  d.allowQuit = true;
  // Real quit: tear down the auth keeper and let the main window's close
  // handler actually destroy (d.allowQuit short-circuits the hide-on-close).
  destroyAuthKeeper();
  app.quit();
}

function ensureAppSurfacedForUpdate() {
  if (IS_MAC && app.dock) {
    try { app.dock.show(); } catch (_) { /* cosmetic */ }
  }
  try {
    app.focus();
  } catch (_) { /* best-effort */ }
  if (!d.mainWindow || d.mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (d.mainWindow && !d.mainWindow.isDestroyed()) {
    try {
      if (d.mainWindow.isMinimized()) d.mainWindow.restore();
      d.mainWindow.show();
      d.mainWindow.focus();
      d.mainWindow.moveTop();
    } catch (_) { /* best-effort */ }
    return d.mainWindow;
  }
  return null;
}

function notifyUpdateReady(version) {
  const key = version || "pending";
  if (d.updateNotifiedForVersion === key) return;
  d.updateNotifiedForVersion = key;
  const ver = version ? ` ${version}` : "";
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "LYKN update ready",
        body: `Version${ver} downloaded. Restart LYKN to install — or use Restart to Update in the menu bar.`,
        silent: false,
      });
      n.on("click", () => {
        void maybePromptPendingUpdate({ force: true });
      });
      n.show();
    }
  } catch (e) {
    console.log("[update] notification failed:", e && e.message ? e.message : e);
  }
}

async function maybePromptPendingUpdate(opts = {}) {
  const force = Boolean(opts.force);
  if (!d.pendingUpdate || !d.installPendingUpdate) return;
  if (d.updatePromptOpen) return;
  if (!force && d.lastUpdatePromptAt && Date.now() - d.lastUpdatePromptAt < UPDATE_REPROMPT_MS) {
    return;
  }

  d.updatePromptOpen = true;
  d.lastUpdatePromptAt = Date.now();
  refreshTrayUpdateAffordance();
  notifyUpdateReady(d.pendingUpdate.version);

  const parent = ensureAppSurfacedForUpdate();
  // Give macOS a beat to show Dock + window before an app-modal dialog;
  // otherwise always-on / login-launch sessions often never surface it.
  await new Promise((r) => setTimeout(r, 350));

  const ver = d.pendingUpdate.version ? ` (${d.pendingUpdate.version})` : "";
  const closeHint = IS_MAC
    ? "⌘Q keeps LYKN in the menu bar"
    : "Closing the window keeps LYKN in the d.tray";
  const boxOpts = {
    type: "info",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Update ready",
    message: "Restart to update LYKN.",
    detail:
      `A new version${ver} is ready. Restart the app to install it.\n\n` +
      `Tip: ${closeHint} — choose Restart here, or ` +
      `"Restart to Update" / "Quit LYKN Completely" from the menu bar icon.`,
  };

  try {
    // Re-surface in case focus was stolen during the short delay.
    const liveParent =
      parent && !parent.isDestroyed() ? parent : ensureAppSurfacedForUpdate();
    const { response } = liveParent
      ? await dialog.showMessageBox(liveParent, boxOpts)
      : await dialog.showMessageBox(boxOpts);
    if (response === 0) {
      d.installPendingUpdate();
    }
  } catch (e) {
    console.log("[update] prompt failed:", e && e.message ? e.message : e);
  } finally {
    d.updatePromptOpen = false;
  }
}

function initAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    console.log("[update] electron-updater unavailable:", e && e.message);
    return;
  }
  // electron-updater's property is `autoDownload` (a previous typo set the
  // nonexistent `autoDownloadAll`, silently relying on the default).
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  d.installPendingUpdate = () => {
    // Installing an update is a legitimate exit — don't reroute it to
    // background mode via before-quit.
    d.allowQuit = true;
    try {
      autoUpdater.quitAndInstall();
    } catch (e) {
      console.log("[update] quitAndInstall failed:", e && e.message ? e.message : e);
      quitForReal();
    }
  };

  autoUpdater.on("error", (err) => {
    console.log("[update] error:", err && err.message ? err.message : err);
  });
  autoUpdater.on("update-available", (info) => {
    console.log("[update] available:", info && info.version);
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[update] up to date");
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log("[update] downloaded:", info && info.version);
    d.pendingUpdate = { version: (info && info.version) || "" };
    refreshTrayUpdateAffordance();
    // Force the first prompt so always-on / background launches still see it.
    void maybePromptPendingUpdate({ force: true });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log("[update] check failed:", err && err.message ? err.message : err);
    });
  };

  // Check on launch, every 6 hours while alive, and again after sleep/wake
  // (Mac mini / laptop lids often skip the interval until the process wakes).
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
  try {
    powerMonitor.on("resume", () => {
      setTimeout(check, 15_000);
      void maybePromptPendingUpdate({ force: false });
    });
  } catch (_) {
    /* older Electron */
  }
}

  d.ensureAppSurfacedForUpdate = ensureAppSurfacedForUpdate;
  d.initAutoUpdate = initAutoUpdate;
  d.maybePromptPendingUpdate = maybePromptPendingUpdate;
  d.notifyUpdateReady = notifyUpdateReady;
  d.quitForReal = quitForReal;
}

module.exports = { attachAutoUpdate };
