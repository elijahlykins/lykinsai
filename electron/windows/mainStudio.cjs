"use strict";

function attachMainStudio(d) {
  if (d.__attached_attachMainStudio) return;
  d.__attached_attachMainStudio = true;
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
  const destroyAuthKeeper = (...a) => d.destroyAuthKeeper(...a);
  const ensureAuthKeeper = (...a) => d.ensureAuthKeeper(...a);
  const flushPendingAuthTokens = (...a) => d.flushPendingAuthTokens(...a);
  const isAuthNavigation = (...a) => d.isAuthNavigation(...a);
  const openUrlPreferAgentBrowser = (...a) => d.openUrlPreferAgentBrowser(...a);
  const parkStudioStageViewsOnStage = (...a) => d.parkStudioStageViewsOnStage(...a);
  const setStudioBrowserEmbed = (...a) => d.setStudioBrowserEmbed(...a);

function createMainWindow() {
  // `second-instance` and `open-url` can both arrive while this instance is
  // still starting, and `screen` below throws if it is touched before ready.
  // Deferring is the correct behaviour rather than a guard: the user asked for
  // a window, so we still owe them one once there is a display to size it against.
  if (!app.isReady()) {
    if (d.mainWindowDeferred) return;
    d.mainWindowDeferred = true;
    app.whenReady().then(() => {
      d.mainWindowDeferred = false;
      if (!d.mainWindow || d.mainWindow.isDestroyed()) createMainWindow();
    });
    return;
  }

  // Coming back from background (menu-bar-only) mode: restore the Dock icon
  // before the window appears so it can take focus like a normal app window.
  if (IS_MAC && app.dock) {
    try { app.dock.show(); } catch (_) { /* cosmetic */ }
  }
  // Main window takes over as the auth provider — tear down the keeper so
  // two Supabase clients don't race the rotating refresh token.
  destroyAuthKeeper();

  // If a legacy second Studio window is still around, drop it — Studio is
  // the main window now, not a handoff target.
  if (d.studioWindow && !d.studioWindow.isDestroyed() && d.studioWindow !== d.mainWindow) {
    try {
      d.studioWindow.destroy();
    } catch (_) {
      /* ignore */
    }
    d.studioWindow = null;
  }

  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1320, workArea.width - 64);
  const height = Math.min(880, workArea.height - 64);
  d.mainWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    minWidth: 960,
    minHeight: 640,
    // Studio is the product shell: liquid-glass over native vibrancy.
    backgroundColor: "#00000000",
    hasShadow: false,
    ...(IS_MAC
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 22 },
          transparent: false,
          vibrancy: "hud",
          visualEffectState: "active",
          roundedCorners: true,
        }
      : {
          frame: false,
          transparent: false,
          backgroundMaterial: "acrylic",
          roundedCorners: false,
          thickFrame: false,
        }),
    autoHideMenuBar: IS_WIN,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    // Studio opens already fullscreen so there's no expand transition at all.
    // On macOS that's SIMPLE fullscreen (applied at ready-to-show below):
    // fills the screen like native fullscreen but stays on the regular
    // desktop instead of a separate Space. Native fullscreen also ignored
    // show:false during the walkthrough, leaking the booting web app
    // behind the welcome glass.
    fullscreen: !d.welcomeGateActive && !IS_MAC,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Installed apps open as windows on the desktop, and a <webview> is what
      // lets them do that without giving up what makes them apps: a subframe
      // gets no preload, so an <iframe> would cost them the bridge and their
      // own storage. Guests are held to that shape by `will-attach-webview`.
      webviewTag: true,
      // Auth provider for the overlay — keep token refresh alive while hidden.
      backgroundThrottling: false,
      disableHtmlFullscreenWindowResize: true,
    },
  });

  // Nothing but an installed app may attach, and only as itself: the guest is
  // pinned to the app preload and the app's own partition here, so markup in
  // the renderer can't ask for Node, a different preload, or another origin.
  d.mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const appProtocol = require("../appProtocol.cjs");
    const appHost = require("../appHost.cjs");
    const appId = appProtocol.appIdFromOrigin(params.src || "");
    if (!appId) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preloadURL;
    webPreferences.preload = appHost.PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    // Also binds the app scheme on that partition, which has to happen before
    // the guest navigates or it opens to a failed load.
    params.partition = appHost.partitionFor(appId);
  });
  // Studio features (browser dock, fullscreen IPC) attach to this same window.
  d.studioWindow = d.mainWindow;

  d.mainWindow.once("ready-to-show", () => {
    // First launch: stay hidden behind the welcome splash / walkthrough —
    // the onboarding flow (or its close fallback) reveals the window.
    if (d.welcomeGateActive) return;
    if (d.mainWindow && !d.mainWindow.isDestroyed()) {
      // Simple fullscreen before show — full screen with no separate Space.
      if (IS_MAC) {
        try {
          d.mainWindow.setSimpleFullScreen(true);
        } catch (_) {}
      }
      d.mainWindow.show();
      d.mainWindow.focus();
      broadcastStudioFullscreen();
    }
  });

  // Native fullscreen emits real enter/leave events — just relay them.
  d.mainWindow.on("enter-full-screen", broadcastStudioFullscreen);
  d.mainWindow.on("leave-full-screen", broadcastStudioFullscreen);
  // Moving to another display (laptop ↔ external) changes the camera /
  // menu-bar strip the top chrome has to clear.
  d.mainWindow.on("resize", broadcastStudioFullscreen);
  d.mainWindow.on("move", broadcastStudioFullscreen);

  if (IS_MAC) {
    const ensureTrafficLights = () => {
      try {
        if (d.mainWindow && !d.mainWindow.isDestroyed()) {
          d.mainWindow.setWindowButtonVisibility(true);
        }
      } catch (_) {
        /* ignore */
      }
    };
    d.mainWindow.on("enter-full-screen", ensureTrafficLights);
    d.mainWindow.on("leave-full-screen", ensureTrafficLights);
    d.mainWindow.on("enter-html-full-screen", ensureTrafficLights);
    d.mainWindow.on("leave-html-full-screen", ensureTrafficLights);
    d.mainWindow.once("ready-to-show", ensureTrafficLights);
  }

  // Boot straight into Studio. During the first-launch walkthrough the
  // walkthrough=1 flag bypasses ProtectedRoute's /login redirect — the old
  // login page must never render behind the welcome glass; the walkthrough
  // itself signs the user in.
  const studioHome = d.welcomeGateActive
    ? `${APP_ORIGIN}/studio?glass=1&walkthrough=1`
    : `${APP_ORIGIN}/studio?glass=1`;
  const loadAppUrl = (attempt = 0) => {
    if (!d.mainWindow || d.mainWindow.isDestroyed()) return;
    void d.mainWindow.loadURL(studioHome).catch((err) => {
      const msg = String(err?.message || err || "");
      const isLocal =
        /localhost|127\.0\.0\.1/i.test(APP_URL) ||
        msg.includes("ERR_CONNECTION_REFUSED");
      if (isLocal && attempt < 40) {
        setTimeout(() => loadAppUrl(attempt + 1), 250);
        return;
      }
      console.error("[main-window] failed to load", studioHome, msg);
    });
  };
  loadAppUrl();

  d.mainWindow.webContents.on("did-finish-load", flushPendingAuthTokens);

  d.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const origin = new URL(url).origin;
      if (origin === APP_ORIGIN || isAuthNavigation(url)) {
        return { action: "allow" };
      }
      // Chat links / artifacts with target=_blank → LYKN in-app browser.
      void openUrlPreferAgentBrowser(url);
      return { action: "deny" };
    } catch {
      return { action: "deny" };
    }
  });

  d.mainWindow.webContents.on("will-navigate", (event, url) => {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      event.preventDefault();
      return;
    }
    if (origin === APP_ORIGIN || isAuthNavigation(url)) return;
    event.preventDefault();
    void openUrlPreferAgentBrowser(url);
  });

  // Reloads land back on the dashboard tab — undock a browser parked over it.
  d.mainWindow.webContents.on("did-navigate", () => {
    try {
      setStudioBrowserEmbed({ open: false });
    } catch (_) {
      /* ignore */
    }
  });

  // Red close / ⌘W: HIDE, don't destroy (auth keeper for Glass).
  d.mainWindow.on("close", (e) => {
    if (d.allowQuit) return;
    e.preventDefault();
    hideStudioWindow();
    updateDockVisibility();
  });

  d.mainWindow.on("closed", () => {
    // Agent browser views live on this window from the moment they first dock
    // — closing the Browser window only hides them — so they have to be handed
    // over here whether or not the dock is active, or they'd be destroyed
    // along with it.
    d.studioStageEmbedded = false;
    parkStudioStageViewsOnStage();
    try {
      d.studioStageChromeView?.webContents?.close?.();
    } catch (_) {}
    d.studioStageChromeView = null;
    d.mainWindow = null;
    d.studioWindow = null;
    updateDockVisibility();
    if (!d.allowQuit) ensureAuthKeeper();
  });

  d.mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.warn("[main-window] renderer gone:", details?.reason || "unknown");
    if (details?.reason === "clean-exit") return;
    try {
      if (d.mainWindow && !d.mainWindow.isDestroyed()) d.mainWindow.webContents.reload();
    } catch (_) {}
  });
}

function createStudioWindow() {
  if (!d.mainWindow || d.mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  d.studioWindow = d.mainWindow;
  try {
    const cur = d.mainWindow.webContents.getURL() || "";
    if (!/\/studio(\?|$)/.test(cur)) {
      void d.mainWindow.loadURL(`${APP_ORIGIN}/studio?glass=1`);
    }
  } catch (_) {
    void d.mainWindow.loadURL(`${APP_ORIGIN}/studio?glass=1`);
  }
  // First-launch walkthrough owns the screen — the web app boots in the
  // hidden window and its studio IPC must not reveal it early.
  if (d.welcomeGateActive) return;
  // Re-shows come back fullscreen, matching the boot state (hide/minimize
  // exit simple fullscreen first, so it must be re-applied here).
  if (IS_MAC && !d.mainWindow.isVisible()) {
    try {
      if (!d.mainWindow.isSimpleFullScreen() && !d.mainWindow.isFullScreen()) {
        d.mainWindow.setSimpleFullScreen(true);
      }
    } catch (_) {}
  }
  d.mainWindow.show();
  d.mainWindow.focus();
}

function studioWindowRef() {
  if (d.studioWindow && !d.studioWindow.isDestroyed()) return d.studioWindow;
  if (d.mainWindow && !d.mainWindow.isDestroyed()) return d.mainWindow;
  return null;
}

function studioFullscreenActive() {
  const win = studioWindowRef();
  if (!win) return false;
  // Simple fullscreen (fills the screen without a separate macOS Space)
  // counts as fullscreen for the studio UI.
  try {
    if (typeof win.isSimpleFullScreen === "function" && win.isSimpleFullScreen()) {
      return true;
    }
  } catch (_) {}
  return win.isFullScreen();
}

function studioTopInset(win = studioWindowRef()) {
  if (!win || win.isDestroyed()) return 0;
  try {
    const { displayTopInsetForWindow } = require("./displayTopInset.cjs");
    return displayTopInsetForWindow(win.getBounds(), screen.getDisplayMatching(win.getBounds()));
  } catch (_) {
    return 0;
  }
}

function broadcastStudioFullscreen() {
  const win = studioWindowRef();
  if (!win) return;
  if (IS_MAC) {
    try {
      win.setWindowButtonVisibility(true);
    } catch (_) {
      /* ignore */
    }
  }
  const payload = {
    fullscreen: studioFullscreenActive(),
    topInset: studioTopInset(win),
  };
  if (
    d.__studioFsPayload &&
    d.__studioFsPayload.fullscreen === payload.fullscreen &&
    d.__studioFsPayload.topInset === payload.topInset
  ) {
    return;
  }
  d.__studioFsPayload = payload;
  win.webContents.send("lykn:studio-fullscreen", payload);
}

function showStudioWindow() {
  createStudioWindow();
}

function afterStudioFullscreenExit(win, then) {
  if (!win || win.isDestroyed()) return;
  // Simple fullscreen (macOS studio default) exits instantly — no animation.
  try {
    if (typeof win.isSimpleFullScreen === "function" && win.isSimpleFullScreen()) {
      win.setSimpleFullScreen(false);
      then();
      return;
    }
  } catch (_) {}
  if (!win.isFullScreen()) {
    then();
    return;
  }
  win.once("leave-full-screen", () => {
    if (win && !win.isDestroyed()) then();
  });
  win.setFullScreen(false);
}

function hideStudioWindow() {
  const win = studioWindowRef();
  if (!win) return;
  afterStudioFullscreenExit(win, () => {
    try {
      win.hide();
    } catch (_) {
      /* ignore */
    }
    updateDockVisibility();
  });
}

function updateDockVisibility() {
  if (!IS_MAC || !app.dock) return;
  try {
    if (d.mainWindow && !d.mainWindow.isDestroyed() && d.mainWindow.isVisible()) app.dock.show();
    else app.dock.hide();
  } catch (_) {
    /* cosmetic */
  }
}

  try {
    screen.on("display-metrics-changed", broadcastStudioFullscreen);
  } catch (_) {
    /* older Electron */
  }

  d.afterStudioFullscreenExit = afterStudioFullscreenExit;
  d.broadcastStudioFullscreen = broadcastStudioFullscreen;
  d.createMainWindow = createMainWindow;
  d.createStudioWindow = createStudioWindow;
  d.hideStudioWindow = hideStudioWindow;
  d.showStudioWindow = showStudioWindow;
  d.studioFullscreenActive = studioFullscreenActive;
  d.studioTopInset = studioTopInset;
  d.studioWindowRef = studioWindowRef;
  d.updateDockVisibility = updateDockVisibility;
}

module.exports = { attachMainStudio };
