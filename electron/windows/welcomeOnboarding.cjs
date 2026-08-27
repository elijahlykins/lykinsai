"use strict";

function attachWelcomeOnboarding(d) {
  if (d.__attached_attachWelcomeOnboarding) return;
  d.__attached_attachWelcomeOnboarding = true;
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
  const { getUserExtensionDir } = require("../extensionInstaller.cjs");
  const { buildDiagnosticsReport } = require("../diagnostics.cjs");
  const overlayConstants = d.constants;
  const {
    OVERLAY_WIDTH, OVERLAY_SIDE_WIDTH, OVERLAY_WATCH_SIDE_WIDTH, OVERLAY_MAX_WIDTH,
    OVERLAY_MIN_HEIGHT, OVERLAY_BOTTOM_MARGIN, GLASS_CORNER_RADIUS, OVERLAY_BUBBLE,
    OVERLAY_ACTIVATABLE_FOR_DROPS, MENU_WIDTH, MENU_GAP, MENU_MIN_HEIGHT, MENU_MAX_HEIGHT,
    PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT, LIVE_WIDTH, LIVE_HEIGHT,
    PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, UPDATE_REPROMPT_MS,
  } = overlayConstants;
  const ELECTRON_DIR = path.join(__dirname, "..");
  const broadcastStudioFullscreen = (...a) => d.broadcastStudioFullscreen(...a);
  const createMainWindow = (...a) => d.createMainWindow(...a);
  const createOverlayWindow = (...a) => d.createOverlayWindow(...a);
  const deliverAuthTokensToRenderer = (...a) => d.deliverAuthTokensToRenderer(...a);
  const floatingGlassChrome = (...a) => d.floatingGlassChrome(...a);
  const hideOverlay = (...a) => d.hideOverlay(...a);
  const isLoginItemEnabled = (...a) => d.isLoginItemEnabled(...a);
  const quitForReal = (...a) => d.quitForReal(...a);
  const setLoginItemEnabled = (...a) => d.setLoginItemEnabled(...a);

function getExtensionDir() {
  const userCopy = getUserExtensionDir(app.getPath("userData"));
  if (fsSync.existsSync(userCopy)) return userCopy;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "extensions", "save-to-lykn");
  }
  return path.join(ELECTRON_DIR, "..", "extensions", "save-to-lykn");
}

function restoreOverlayAfterExtensionInstall() {
  if (
    d.overlayVisibleBeforeExtensionInstall &&
    d.overlayWindow &&
    !d.overlayWindow.isDestroyed()
  ) {
    d.overlayWindow.show();
    d.overlayWindow.moveTop();
  }
  d.overlayVisibleBeforeExtensionInstall = false;
}

function createExtensionInstallWindow() {
  if (d.extensionInstallWindow && !d.extensionInstallWindow.isDestroyed()) {
    d.overlayVisibleBeforeExtensionInstall =
      d.overlayWindow && !d.overlayWindow.isDestroyed() && d.overlayWindow.isVisible();
    if (d.overlayVisibleBeforeExtensionInstall) hideOverlay();
    d.extensionInstallWindow.show();
    d.extensionInstallWindow.focus();
    return;
  }

  d.overlayVisibleBeforeExtensionInstall =
    d.overlayWindow && !d.overlayWindow.isDestroyed() && d.overlayWindow.isVisible();
  if (d.overlayVisibleBeforeExtensionInstall) hideOverlay();

  d.extensionInstallWindow = new BrowserWindow({
    width: 440,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Chrome Live Feed",
    backgroundColor: "#0b0b0f",
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "extension-install-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  d.extensionInstallWindow.setMenu(null);
  d.extensionInstallWindow.loadFile(path.join(ELECTRON_DIR, "extension-install.html"));
  d.extensionInstallWindow.center();
  d.extensionInstallWindow.on("closed", () => {
    d.extensionInstallWindow = null;
    restoreOverlayAfterExtensionInstall();
  });
}

function onboardingMarkerPath() {
  return path.join(app.getPath("userData"), "onboarding-complete");
}

async function onboardingComplete() {
  try {
    await fs.access(onboardingMarkerPath());
    return true;
  } catch {
    return false;
  }
}

function createOnboardingWindow() {
  if (d.onboardingWindow && !d.onboardingWindow.isDestroyed()) {
    d.onboardingWindow.show();
    d.onboardingWindow.focus();
    return;
  }
  d.onboardingWindow = new BrowserWindow({
    width: 580,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Set up LYKN",
    backgroundColor: "#0b0b0f",
    titleBarStyle: IS_MAC ? "hiddenInset" : "default",
    autoHideMenuBar: IS_WIN,
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "onboarding-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  d.onboardingWindow.loadFile(path.join(ELECTRON_DIR, "onboarding.html"));
  d.onboardingWindow.on("closed", () => {
    d.onboardingWindow = null;
  });
}

function welcomeMarkerPath() {
  return path.join(app.getPath("userData"), "welcome-shown");
}

function hasSeenWelcomeSplash() {
  try {
    fsSync.accessSync(welcomeMarkerPath());
    return true;
  } catch {
    return false;
  }
}

function showWelcomeSplash() {
  if (d.welcomeWindow && !d.welcomeWindow.isDestroyed()) {
    d.welcomeWindow.show();
    d.welcomeWindow.focus();
    return;
  }
  // Cover the entire screen (menu bar and dock included) — a full glass
  // sheet over the desktop, like the snip overlay.
  const { bounds } = screen.getPrimaryDisplay();
  d.welcomeWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    ...floatingGlassChrome(),
    // Full-bleed sheet — no rounded corners at the screen edges.
    roundedCorners: false,
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "welcome-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Workspaces first, level last — setVisibleOnAllWorkspaces can reset the
  // window level on macOS (see createOverlayWindow). The main window boots
  // fullscreen (its own Space), so the splash must ride above it; screen-saver
  // level clears the menu bar like the snip overlay.
  d.welcomeWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.welcomeWindow.setAlwaysOnTop(true, "screen-saver");
  d.welcomeWindow.once("ready-to-show", () => {
    // showInactive: never steal keyboard focus — the user may be typing while
    // the app boots, and a stray keystroke would land on (and dismiss) the
    // splash. Clicks still skip it; it closes itself when the reveal ends.
    if (d.welcomeWindow && !d.welcomeWindow.isDestroyed()) d.welcomeWindow.showInactive();
  });
  d.welcomeWindow.on("closed", () => {
    d.welcomeWindow = null;
    if (!d.welcomeGateActive) return;
    // The welcome stages are the whole walkthrough. Its final handoff opens
    // the normal glass Studio, not the retired sign-in surface.
    d.welcomeGateActive = false;
    if (d.mainWindow && !d.mainWindow.isDestroyed()) {
      const revealStudio = () => {
        if (!d.mainWindow || d.mainWindow.isDestroyed()) return;
        if (d.mainWindow.isMinimized()) d.mainWindow.restore();
        d.mainWindow.show();
        d.mainWindow.focus();
        // The window boots windowed while gated (fullscreen would have made
        // it visible behind the welcome glass) — go fullscreen at reveal.
        // macOS uses simple fullscreen so it stays on the regular desktop.
        if (IS_MAC) {
          try {
            if (!d.mainWindow.isSimpleFullScreen()) d.mainWindow.setSimpleFullScreen(true);
          } catch (_) {}
        } else if (!d.mainWindow.isFullScreen()) {
          d.mainWindow.setFullScreen(true);
        }
        broadcastStudioFullscreen();
      };
      // Normal walkthrough handoff: the studio finished loading behind the
      // welcome loader — reveal it as-is. Reloading here would restart the
      // app boot and flash its loading screen.
      if (d.welcomeStudioPreloaded) {
        revealStudio();
        return;
      }
      void d.mainWindow
        .loadURL(`${APP_ORIGIN}/studio?glass=1&walkthrough=1`)
        .then(revealStudio)
        .catch((err) => {
          console.warn("[welcome] Studio handoff:", err?.message || err);
          revealStudio();
        });
    } else {
      createMainWindow();
    }
  });
  void d.welcomeWindow.loadFile(path.join(ELECTRON_DIR, "welcome.html"));
  try {
    fsSync.writeFileSync(welcomeMarkerPath(), new Date().toISOString(), "utf8");
  } catch {
    /* non-fatal — worst case the splash replays next launch */
  }
}

function welcomeSupabaseAuthCreds() {
  let url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
  let key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";
  if ((!url || !key) && !app.isPackaged) {
    try {
      for (const line of fsSync.readFileSync(path.join(ELECTRON_DIR, "..", ".env"), "utf8").split("\n")) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, "").trim();
        if (!url && ["VITE_SUPABASE_URL", "SUPABASE_URL"].includes(match[1])) url = value;
        if (!key && ["VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"].includes(match[1])) key = value;
      }
    } catch {
      /* development .env is optional */
    }
  }
  return url && key ? { url, key } : null;
}

async function signInWelcomeAccount() {
  const secret = d.welcomeSignupSecret;
  d.welcomeSignupSecret = null;
  const creds = welcomeSupabaseAuthCreds();
  if (!secret || !creds) return false;
  try {
    const response = await fetch(`${creds.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: creds.key },
      body: JSON.stringify(secret),
    });
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !session?.access_token || !session?.refresh_token) return false;
    deliverAuthTokensToRenderer(session.access_token, session.refresh_token);
    return true;
  } catch {
    return false;
  }
}

function installPermissionHandler() {
  const ses = require("electron").session.defaultSession;
  const ALLOWED = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "notifications"]);
  const isOverlayContents = (webContents) =>
    d.overlayWindow && !d.overlayWindow.isDestroyed() && webContents === d.overlayWindow.webContents;
  const originAllowed = (webContents) => {
    try {
      return new URL(webContents.getURL()).origin === APP_ORIGIN;
    } catch {
      return false;
    }
  };
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    // The overlay loads from file:// (no http origin) but is our own trusted
    // window — allow it the same media (mic) access for dictation.
    const allow =
      ALLOWED.has(permission) &&
      (originAllowed(webContents) || isOverlayContents(webContents));
    callback(allow);
  });
  // Some getUserMedia paths consult the synchronous check handler too.
  ses.setPermissionCheckHandler((webContents, permission) => {
    return ALLOWED.has(permission) && (originAllowed(webContents) || isOverlayContents(webContents));
  });
}

function setupSystemAudioCapture() {
  const ses = require("electron").session.defaultSession;
  if (typeof ses.setDisplayMediaRequestHandler !== "function") return;
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        // Only Glass (file:// overlay) may take silent full-screen + loopback.
        // Deny http(s) origins so XSS on lykn.io can't capture without a picker.
        const origin = String(request?.securityOrigin || "");
        if (/^https?:/i.test(origin) || origin === APP_ORIGIN) {
          console.warn("[display-media] denied for web origin:", origin);
          return callback({});
        }
        if (!d.overlayWindow || d.overlayWindow.isDestroyed()) {
          return callback({});
        }
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        if (!sources.length) return callback({});
        callback({ video: sources[0], audio: "loopback" });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

function buildAppMenu() {
  // macOS: standard app/edit/window menu. Windows: File + Edit so Alt shortcuts
  // and copy/paste still work with autoHideMenuBar.
  const loginItem = {
    label: "Start LYKN at Login",
    type: "checkbox",
    checked: isLoginItemEnabled(),
    enabled: app.isPackaged,
    click: (item) => setLoginItemEnabled(item.checked),
  };
  // TODO(devtools): we want a developer mode here — a `toggleDevTools` role,
  // gated so it is unreachable on a normal install (an env var we set, or an
  // internal-account check), plus a raw trace viewer for browser-agent runs.
  //
  // It is deliberately absent for now rather than half-built. DevTools on any
  // LYKN window exposes the whole product: the agent's prompt corpus and skill
  // files, the IPC surface, the snapshot format the agent builds from a page,
  // and every request to our own API. Shipping that behind nothing but an
  // obscure shortcut hands the architecture to anyone who goes looking. When it
  // is built, the gate is the feature — not the toggle.
  //
  // "Save Diagnostics…" below is the supported path in the meantime: it answers
  // support questions from the same data without exposing any of it.
  const viewMenu = {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  // Diagnostics is an internal tool and is not part of the shipped product.
  //
  // Even though the report it writes is counts-only, the menu item itself
  // advertises that the agent has more than one runtime, that runs have rounds,
  // recoveries and grounding — the shape of the architecture, handed to anyone
  // who opens the Help menu. So it exists in dev builds, and in a packaged build
  // only when someone deliberately launches with LYKN_DIAGNOSTICS=1, which is
  // how we would walk an internal tester through producing one.
  //
  // If this ever needs to reach real users for support, gate it on the account
  // (the internal-email list the server already keeps) rather than by making it
  // visible to everybody.
  const diagnosticsEnabled = !app.isPackaged || process.env.LYKN_DIAGNOSTICS === "1";
  const helpMenu = {
    role: "help",
    submenu: [
      { label: "Set Up LYKN / Permissions…", click: () => createOnboardingWindow() },
      ...(diagnosticsEnabled
        ? [
            { type: "separator" },
            { label: "Save Diagnostics…", click: () => saveDiagnosticsReport() },
          ]
        : []),
    ],
  };

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const updateMenuItems =
    d.pendingUpdate && d.installPendingUpdate
      ? [
          {
            label: `Restart to Update${d.pendingUpdate.version ? ` (${d.pendingUpdate.version})` : ""}`,
            click: () => d.installPendingUpdate(),
          },
          { type: "separator" },
        ]
      : [];

  /** @type {Electron.MenuItemConstructorOptions[]} */
  let template;
  if (IS_MAC) {
    template = [
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          { type: "separator" },
          ...updateMenuItems,
          loginItem,
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          // ⌘Q closes the windows but LYKN keeps running in the menu bar (the
          // before-quit hook reroutes it); the labels make that explicit.
          { role: "quit", label: "Close LYKN (Keeps Running in Menu Bar)" },
          {
            label: "Quit LYKN Completely",
            accelerator: "Command+Alt+Q",
            click: () => quitForReal(),
          },
        ],
      },
      { role: "editMenu" },
      viewMenu,
      { role: "windowMenu" },
      helpMenu,
    ];
  } else {
    template = [
      {
        label: "File",
        submenu: [
          ...updateMenuItems,
          loginItem,
          { type: "separator" },
          // Alt+F4 / File→Close hides windows; d.tray + Ctrl+L stay armed.
          {
            label: "Close Window (Keeps Running in Tray)",
            accelerator: "Alt+F4",
            click: () => {
              try {
                if (d.overlayWindow && d.overlayWindow.isVisible()) hideOverlay();
              } catch (_) { /* ignore */ }
              try {
                if (d.mainWindow && !d.mainWindow.isDestroyed()) d.mainWindow.hide();
              } catch (_) { /* ignore */ }
            },
          },
          {
            label: "Quit LYKN Completely",
            accelerator: "Control+Shift+Q",
            click: () => quitForReal(),
          },
        ],
      },
      { role: "editMenu" },
      viewMenu,
      helpMenu,
    ];
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function saveDiagnosticsReport() {
  let report = "";
  try {
    report = buildDiagnosticsReport({
      userDataPath: app.getPath("userData"),
      env: {
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        packaged: app.isPackaged,
      },
    });
  } catch (e) {
    dialog.showErrorBox(
      "Could not build diagnostics",
      String(e?.message || e).slice(0, 500),
    );
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save LYKN Diagnostics",
    defaultPath: path.join(app.getPath("downloads"), `lykn-diagnostics-${stamp}.txt`),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (canceled || !filePath) return;

  try {
    await fs.writeFile(filePath, report, "utf8");
    // Reveal rather than open: the point is to attach it to something, and a
    // revealed file is one drag away from an email.
    shell.showItemInFolder(filePath);
  } catch (e) {
    dialog.showErrorBox("Could not save diagnostics", String(e?.message || e).slice(0, 500));
  }
}

  d.buildAppMenu = buildAppMenu;
  d.createExtensionInstallWindow = createExtensionInstallWindow;
  d.createOnboardingWindow = createOnboardingWindow;
  d.getExtensionDir = getExtensionDir;
  d.hasSeenWelcomeSplash = hasSeenWelcomeSplash;
  d.installPermissionHandler = installPermissionHandler;
  d.onboardingComplete = onboardingComplete;
  d.onboardingMarkerPath = onboardingMarkerPath;
  d.restoreOverlayAfterExtensionInstall = restoreOverlayAfterExtensionInstall;
  d.saveDiagnosticsReport = saveDiagnosticsReport;
  d.setupSystemAudioCapture = setupSystemAudioCapture;
  d.showWelcomeSplash = showWelcomeSplash;
  d.signInWelcomeAccount = signInWelcomeAccount;
  d.welcomeMarkerPath = welcomeMarkerPath;
  d.welcomeSupabaseAuthCreds = welcomeSupabaseAuthCreds;
}

module.exports = { attachWelcomeOnboarding };
