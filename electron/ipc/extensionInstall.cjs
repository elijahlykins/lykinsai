"use strict";

function registerExtensionInstallIpc(d) {
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
    OVERLAY_WIDTH, OVERLAY_MIN_HEIGHT, OVERLAY_BUBBLE, MENU_WIDTH, MENU_GAP,
    MENU_MIN_HEIGHT, MENU_MAX_HEIGHT, PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT,
  } = overlayConstants;
  const createExtensionInstallWindow = (...a) => d.createExtensionInstallWindow(...a);

  ipcMain.handle("lykn:open-extension-install", () => {
    createExtensionInstallWindow();
    return { ok: true };
  });
  ipcMain.handle("lykn:extension-install-mode", () => getExtensionInstallMode());
  ipcMain.handle("lykn:install-extension-one-click", async (_e, { browser } = {}) => {
    try {
      return await installExtensionOneClick(
        {
          browser: browser || "chrome",
          userDataPath: app.getPath("userData"),
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appDir: __dirname,
          shell,
          clipboard,
          dialog,
          writeBridgeConfig: (dir) => d.extensionBridge?.writeBridgeConfigToExtensionDir?.(dir),
        },
      );
    } catch (e) {
      console.warn("[extension-install]", e?.message || e);
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle("lykn:reveal-extension-folder", async (_e, { reveal = true } = {}) => {
    try {
      const extPath = await prepareExtensionInstallDir({
        userDataPath: app.getPath("userData"),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appDir: __dirname,
        writeBridgeConfig: (dir) => d.extensionBridge?.writeBridgeConfigToExtensionDir?.(dir),
      });
      clipboard.writeText(extPath);
      if (!reveal) {
        return { ok: true, path: extPath, folderName: path.basename(extPath) };
      }
      const revealed = await revealExtensionInstallFolder(shell, extPath);
      return {
        ok: !!revealed?.ok,
        path: extPath,
        folderName: path.basename(extPath),
        error: revealed?.error,
      };
    } catch (e) {
      console.warn("[extension-install] reveal:", e?.message || e);
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle("lykn:extension-bridge-status", () => {
    const connected = !!d.extensionBridge?.isConnected?.();
    if (connected) d.liveWatchState.extensionConnected = true;
    return {
      ok: true,
      connected,
      live: !!d.extensionBridge?.isLive?.(),
      port: d.extensionBridge?.port || 38471,
      // Shown in install UI so store-installed extensions can be paired manually.
      token: d.extensionBridge?.getToken?.() || "",
    };
  });
  ipcMain.on("lykn:extension-install-close", () => {
    if (d.extensionInstallWindow && !d.extensionInstallWindow.isDestroyed()) {
      d.extensionInstallWindow.close();
    }
  });
}

module.exports = { registerExtensionInstallIpc };
