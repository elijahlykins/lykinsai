"use strict";

function attachTray(d) {
  if (d.__attached_attachTray) return;
  d.__attached_attachTray = true;
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
  const buildAppMenu = (...a) => d.buildAppMenu(...a);
  const createMainWindow = (...a) => d.createMainWindow(...a);
  const createOnboardingWindow = (...a) => d.createOnboardingWindow(...a);
  const maybePromptPendingUpdate = (...a) => d.maybePromptPendingUpdate(...a);
  const quitForReal = (...a) => d.quitForReal(...a);
  const readOverlaySettings = (...a) => d.readOverlaySettings(...a);
  const toggleOverlay = (...a) => d.toggleOverlay(...a);
  const writeOverlaySettings = (...a) => d.writeOverlaySettings(...a);

function registerGlobalHotkey() {
  globalShortcut.register("CommandOrControl+L", () => {
    // Let the first-run walkthrough celebrate the user's first ⌘L.
    if (d.onboardingWindow && !d.onboardingWindow.isDestroyed()) {
      d.onboardingWindow.webContents.send("lykn:onboarding-hotkey");
    }
    toggleOverlay();
  });
}

function refreshTrayUpdateAffordance() {
  if (d.tray) {
    const hotkeyLabel = IS_MAC ? "⌘L" : "Ctrl+L";
    if (d.pendingUpdate) {
      const ver = d.pendingUpdate.version ? ` ${d.pendingUpdate.version}` : "";
      d.tray.setToolTip(`LYKN${ver} is ready — restart to update (${hotkeyLabel})`);
      if (IS_MAC && app.dock) {
        try { app.dock.setBadge("↑"); } catch (_) { /* cosmetic */ }
      }
    } else {
      d.tray.setToolTip(`LYKN — open the chat overlay (${hotkeyLabel})`);
      if (IS_MAC && app.dock) {
        try { app.dock.setBadge(""); } catch (_) { /* cosmetic */ }
      }
    }
  }
  // Keep the app menu in sync so Restart is findable even without the d.tray menu.
  try {
    if (app.isReady()) buildAppMenu();
  } catch (_) { /* menu not ready yet */ }
}

function createTray() {
  if (d.tray) return;
  const trayFile = IS_MAC ? "trayTemplate.png" : "d.tray-win.png";
  const icon = nativeImage.createFromPath(
    path.join(ELECTRON_DIR, "resources", trayFile),
  );
  if (IS_MAC) icon.setTemplateImage(true);
  d.tray = new Tray(icon);
  refreshTrayUpdateAffordance();

  // Left click = the one-gesture action: toggle the overlay chat.
  d.tray.on("click", () => {
    toggleOverlay();
  });

  // Right-click = utility menu. Built lazily per popup so the overlay label
  // reflects current visibility. NOT set via setContextMenu — on macOS that
  // would hijack left-click into opening the menu instead of the overlay.
  // On Windows, also bind to "menu" / double-click for discoverability.
  const popupTrayMenu = () => {
    const overlayVisible = Boolean(d.overlayWindow && d.overlayWindow.isVisible());
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const items = [];
    if (d.pendingUpdate && d.installPendingUpdate) {
      const ver = d.pendingUpdate.version ? ` (${d.pendingUpdate.version})` : "";
      items.push({
        label: `Restart to Update${ver}`,
        click: () => d.installPendingUpdate(),
      });
      items.push({ type: "separator" });
    }
    items.push(
      {
        label: overlayVisible ? "Hide Chat Overlay" : "Open Chat Overlay",
        accelerator: "CommandOrControl+L",
        click: () => toggleOverlay(),
      },
      {
        label: "Open LYKN Window",
        click: () => {
          if (!d.mainWindow || d.mainWindow.isDestroyed()) createMainWindow();
          else {
            d.mainWindow.show();
            d.mainWindow.focus();
          }
          // Opening the window is a natural moment to re-offer a pending update.
          void maybePromptPendingUpdate({ force: false });
        },
      },
      { type: "separator" },
      {
        label: "Set Up LYKN / Permissions…",
        click: () => createOnboardingWindow(),
      },
      { type: "separator" },
      { label: "Quit LYKN Completely", click: () => quitForReal() },
    );
    const menu = Menu.buildFromTemplate(items);
    d.tray.popUpContextMenu(menu);
  };
  d.tray.on("right-click", popupTrayMenu);
  if (IS_WIN) {
    // Windows often surfaces the context menu on this event too.
    d.tray.on("double-click", () => toggleOverlay());
  }
}

function isLoginItemEnabled() {
  if (!app.isPackaged) return false;
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setLoginItemEnabled(enabled) {
  if (!app.isPackaged) return; // dev would register the bare Electron binary
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    // The user (or first-run) made an explicit choice — never auto-enable again.
    writeOverlaySettings({ loginItemConfigured: true });
  } catch (e) {
    console.error("[LYKN] failed to update login item:", e?.message);
  }
}

function setupLaunchAtLogin() {
  if (!app.isPackaged) return;
  if (readOverlaySettings().loginItemConfigured) return;
  setLoginItemEnabled(true);
}

function launchedAtLogin() {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  try {
    return !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

  d.createTray = createTray;
  d.isLoginItemEnabled = isLoginItemEnabled;
  d.launchedAtLogin = launchedAtLogin;
  d.refreshTrayUpdateAffordance = refreshTrayUpdateAffordance;
  d.registerGlobalHotkey = registerGlobalHotkey;
  d.setLoginItemEnabled = setLoginItemEnabled;
  d.setupLaunchAtLogin = setupLaunchAtLogin;
}

module.exports = { attachTray };
