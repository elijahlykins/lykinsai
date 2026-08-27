"use strict";

function attachOverlaySatellites(d) {
  if (d.__attached_attachOverlaySatellites) return;
  d.__attached_attachOverlaySatellites = true;
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
    LANG_PICKER_WIDTH, LANG_PICKER_MIN_HEIGHT, LANG_PICKER_MAX_HEIGHT, LANG_PICKER_GAP,
    AGENT_SIDEBAR_WIDTH,
  } = overlayConstants;
  const ELECTRON_DIR = path.join(__dirname, "..");
  const agentSidebarWindowVisible = (...a) => d.agentSidebarWindowVisible(...a);
  const createOverlayWindow = (...a) => d.createOverlayWindow(...a);
  const floatingGlassChrome = (...a) => d.floatingGlassChrome(...a);
  const getTargetCaptureDisplay = (...a) => d.getTargetCaptureDisplay(...a);
  const hardenFloatingGlass = (...a) => d.hardenFloatingGlass(...a);
  const isContentProtectionEnabled = (...a) => d.isContentProtectionEnabled(...a);
  const setFloatingBounds = (...a) => d.setFloatingBounds(...a);

function createBurstWindow() {
  const { bounds } = getTargetCaptureDisplay();
  d.burstWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Same panel treatment as the overlay so it floats over full-screen apps
    // and Spaces without yanking focus.
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the renderer hot so the first summon doesn't pay a wake-up cost.
      backgroundThrottling: false,
    },
  });

  // Below the overlay (screen-saver) so the glass bar stays crisp on top, but
  // above everything else on screen.
  // Clicks pass straight through to whatever is underneath.
  d.burstWindow.setIgnoreMouseEvents(true, { forward: true });
  // Keep our own screen reads from capturing the flash.
  try { d.burstWindow.setContentProtection(true); } catch (_) {}
  // Workspaces first, level last — setVisibleOnAllWorkspaces can reset the
  // window level on macOS (see createOverlayWindow).
  d.burstWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.burstWindow.setFullScreenable(false);
  d.burstWindow.setAlwaysOnTop(true, "pop-up-menu");
  d.burstWindow.loadFile(path.join(ELECTRON_DIR, "burst.html"));

  // Warm-up: run the full burst animation ONCE while the window is parked
  // entirely off-screen (so it's invisible) — this forces the renderer to
  // actually rasterize the blurred color layers + noise tiles, so the first
  // real ⌘+L has everything cached and doesn't hitch.
  d.burstWindow.webContents.once("did-finish-load", () => {
    if (!d.burstWindow || d.burstWindow.isDestroyed() || d.burstWindowWarmed) return;
    d.burstWindowWarmed = true;
    try {
      const { bounds } = getTargetCaptureDisplay();
      // Park the window one full screen-height above the display.
      d.burstWindow.setBounds({
        x: bounds.x,
        y: bounds.y - bounds.height - 120,
        width: bounds.width,
        height: bounds.height,
      });
      d.burstWindow.setIgnoreMouseEvents(true, { forward: true });
      // Belt and braces: macOS can clamp "off-screen" windows back onto the
      // display, which made this warm-up flash blue at app launch. Opacity 0
      // keeps the renderer rasterizing while guaranteeing nothing shows.
      d.burstWindow.setOpacity(0);
      d.burstWindow.showInactive();
      d.burstWindow.webContents
        .executeJavaScript("window.__lyknBurst && window.__lyknBurst();", true)
        .catch(() => {});
      setTimeout(() => {
        if (!d.burstWindow || d.burstWindow.isDestroyed()) return;
        d.burstWindow.webContents
          .executeJavaScript("window.__lyknBurstOff && window.__lyknBurstOff();", true)
          .catch(() => {});
        d.burstWindow.hide();
        d.burstWindow.setOpacity(1);
      }, 1500);
    } catch (_) {
      /* warm-up is best-effort */
    }
  });

  d.burstWindow.on("closed", () => {
    d.burstWindow = null;
  });
}

function playOverlayBurst() {
  try {
    if (!d.burstWindow || d.burstWindow.isDestroyed()) createBurstWindow();
    // Cover the display the overlay is on (handles external / scaled screens).
    const { bounds } = getTargetCaptureDisplay();
    d.burstWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
    d.burstWindow.setIgnoreMouseEvents(true, { forward: true });
    // The boot warm-up runs at opacity 0 — a summon during that window must
    // reset it or the real burst would be invisible.
    d.burstWindow.setOpacity(1);
    // Show without activating so the overlay keeps key focus for typing.
    d.burstWindow.showInactive();
    const fire = () => {
      if (!d.burstWindow || d.burstWindow.isDestroyed()) return;
      d.burstWindow.webContents
        .executeJavaScript("window.__lyknBurst && window.__lyknBurst();", true)
        .catch(() => {});
    };
    if (d.burstWindow.webContents.isLoading()) {
      d.burstWindow.webContents.once("did-finish-load", fire);
    } else {
      fire();
    }
    // One-shot summon cue only — hide once the wash finishes (no persistent rim).
    if (d.burstHideTimer) {
      clearTimeout(d.burstHideTimer);
      d.burstHideTimer = null;
    }
    d.burstHideTimer = setTimeout(() => {
      d.burstHideTimer = null;
      hideOverlayGlass();
    }, 1400);
  } catch (_) {
    /* the burst is purely cosmetic — never block showing the overlay */
  }
}

function hideOverlayGlass() {
  try {
    if (!d.burstWindow || d.burstWindow.isDestroyed()) return;
    d.burstWindow.webContents
      .executeJavaScript("window.__lyknBurstOff && window.__lyknBurstOff();", true)
      .catch(() => {});
    if (d.burstHideTimer) clearTimeout(d.burstHideTimer);
    d.burstHideTimer = setTimeout(() => {
      d.burstHideTimer = null;
      if (d.burstWindow && !d.burstWindow.isDestroyed()) d.burstWindow.hide();
    }, 360);
  } catch (_) {
    /* purely cosmetic */
  }
}

function createMenuWindow() {
  d.menuWindow = new BrowserWindow({
    width: MENU_WIDTH,
    height: d.menuHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never steal focus from the bar (or the app under it) — buttons still
    // take the first click thanks to acceptFirstMouse.
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "menu-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    d.menuWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(d.menuWindow);
  // Workspaces first, level last — setVisibleOnAllWorkspaces can reset the
  // window level on macOS (see createOverlayWindow).
  d.menuWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.menuWindow.setFullScreenable(false);
  d.menuWindow.setAlwaysOnTop(true, "screen-saver");
  d.menuWindow.loadFile(path.join(ELECTRON_DIR, "menu.html"));
  d.menuWindow.on("closed", () => {
    d.menuWindow = null;
  });
}

function menuTargetBounds() {
  const ob = d.overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(MENU_MIN_HEIGHT, Math.min(d.menuHeight, MENU_MAX_HEIGHT, workArea.height - 16));
  // The live / panel / agent-sidebar cards occupy the bar's right flank when
  // open — step past them so the menu doesn't land underneath.
  const rightInset =
    (liveWindowVisible() ? LIVE_WIDTH + MENU_GAP : 0) +
    (panelWindowVisible() ? d.panelWidth + MENU_GAP : 0) +
    (agentSidebarWindowVisible() ? AGENT_SIDEBAR_WIDTH + MENU_GAP : 0);
  let x = ob.x + ob.width + MENU_GAP + rightInset;
  if (x + MENU_WIDTH > workArea.x + workArea.width) x = ob.x - MENU_GAP - MENU_WIDTH;
  x = Math.max(workArea.x, x);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x: Math.round(x), y: Math.round(y), width: MENU_WIDTH, height: h };
}

function positionMenuWindow() {
  if (!d.menuWindow || d.menuWindow.isDestroyed() || !d.menuWindow.isVisible()) return;
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  setFloatingBounds(d.menuWindow, menuTargetBounds());
}

function notifyMenuVisibility(visible) {
  try {
    if (d.overlayWindow && !d.overlayWindow.isDestroyed())
      d.overlayWindow.webContents.send("lykn:menu-visible", !!visible);
  } catch (_) {}
}

function showMenuWindow() {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  // Only one floating card next to the bar at a time.
  hidePickerWindow();
  if (!d.menuWindow || d.menuWindow.isDestroyed()) createMenuWindow();
  const fire = () => {
    if (!d.menuWindow || d.menuWindow.isDestroyed()) return;
    setFloatingBounds(d.menuWindow, menuTargetBounds());
    d.menuWindow.showInactive();
    d.menuWindow.moveTop();
    d.menuWindow.webContents.send("lykn:menu-shown");
    notifyMenuVisibility(true);
  };
  if (d.menuWindow.webContents.isLoading()) d.menuWindow.webContents.once("did-finish-load", fire);
  else fire();
}

function hideMenuWindow() {
  if (d.menuWindow && !d.menuWindow.isDestroyed() && d.menuWindow.isVisible()) d.menuWindow.hide();
  notifyMenuVisibility(false);
}

function createPickerWindow() {
  d.pickerWindow = new BrowserWindow({
    width: PICKER_WIDTH,
    height: d.pickerHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "picker-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    d.pickerWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(d.pickerWindow);
  // Workspaces first, level last — see createOverlayWindow.
  d.pickerWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.pickerWindow.setFullScreenable(false);
  d.pickerWindow.setAlwaysOnTop(true, "screen-saver");
  d.pickerWindow.loadFile(path.join(ELECTRON_DIR, "picker.html"));
  d.pickerWindow.on("closed", () => {
    d.pickerWindow = null;
  });
}

function pickerTargetBounds() {
  const ob = d.overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(
    PICKER_MIN_HEIGHT,
    Math.min(d.pickerHeight, PICKER_MAX_HEIGHT, workArea.height - 16),
  );
  let x = ob.x - MENU_GAP - PICKER_WIDTH;
  if (x < workArea.x) x = ob.x + ob.width + MENU_GAP;
  x = Math.min(x, workArea.x + workArea.width - PICKER_WIDTH);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x: Math.round(x), y: Math.round(y), width: PICKER_WIDTH, height: h };
}

function positionPickerWindow() {
  if (!d.pickerWindow || d.pickerWindow.isDestroyed() || !d.pickerWindow.isVisible()) return;
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  setFloatingBounds(d.pickerWindow, pickerTargetBounds());
}

function notifyPickerVisibility(visible) {
  try {
    if (d.overlayWindow && !d.overlayWindow.isDestroyed())
      d.overlayWindow.webContents.send("lykn:picker-visible", !!visible);
  } catch (_) {}
}

function showPickerWindow() {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  // Only one floating card next to the bar at a time.
  hideMenuWindow();
  if (!d.pickerWindow || d.pickerWindow.isDestroyed()) createPickerWindow();
  const fire = () => {
    if (!d.pickerWindow || d.pickerWindow.isDestroyed()) return;
    setFloatingBounds(d.pickerWindow, pickerTargetBounds());
    d.pickerWindow.showInactive();
    d.pickerWindow.moveTop();
    d.pickerWindow.webContents.send("lykn:picker-shown");
    notifyPickerVisibility(true);
  };
  if (d.pickerWindow.webContents.isLoading()) d.pickerWindow.webContents.once("did-finish-load", fire);
  else fire();
}

function hidePickerWindow() {
  if (d.pickerWindow && !d.pickerWindow.isDestroyed() && d.pickerWindow.isVisible()) d.pickerWindow.hide();
  notifyPickerVisibility(false);
}

function createLangPickerWindow() {
  d.langPickerWindow = new BrowserWindow({
    width: LANG_PICKER_WIDTH,
    height: d.langPickerHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "lang-picker-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    d.langPickerWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(d.langPickerWindow);
  d.langPickerWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.langPickerWindow.setFullScreenable(false);
  d.langPickerWindow.setAlwaysOnTop(true, "screen-saver");
  d.langPickerWindow.loadFile(path.join(ELECTRON_DIR, "lang-picker.html"));
  d.langPickerWindow.on("closed", () => {
    d.langPickerWindow = null;
  });
}

function langPickerTargetBounds() {
  const ob = d.overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(
    LANG_PICKER_MIN_HEIGHT,
    Math.min(d.langPickerHeight, LANG_PICKER_MAX_HEIGHT, workArea.height - 16),
  );
  const a = d.langPickerAnchor || { left: 12, bottom: 40, width: LANG_PICKER_WIDTH };
  let x = Math.round(ob.x + Number(a.left || 0));
  let y = Math.round(ob.y + Number(a.bottom || 0) + LANG_PICKER_GAP);
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - LANG_PICKER_WIDTH));
  if (y + h > workArea.y + workArea.height) {
    // Flip above the pill when there's no room below.
    y = Math.round(ob.y + Number(a.top || a.bottom || 0) - LANG_PICKER_GAP - h);
  }
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x, y, width: LANG_PICKER_WIDTH, height: h };
}

function positionLangPickerWindow() {
  if (!d.langPickerWindow || d.langPickerWindow.isDestroyed() || !d.langPickerWindow.isVisible()) return;
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  setFloatingBounds(d.langPickerWindow, langPickerTargetBounds());
}

function notifyLangPickerVisibility(visible) {
  try {
    if (d.overlayWindow && !d.overlayWindow.isDestroyed())
      d.overlayWindow.webContents.send("lykn:lang-picker-visible", !!visible);
  } catch (_) {}
}

function showLangPickerWindow(anchor) {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  if (anchor && typeof anchor === "object") d.langPickerAnchor = anchor;
  hideMenuWindow();
  hidePickerWindow();
  if (!d.langPickerWindow || d.langPickerWindow.isDestroyed()) createLangPickerWindow();
  const fire = () => {
    if (!d.langPickerWindow || d.langPickerWindow.isDestroyed()) return;
    setFloatingBounds(d.langPickerWindow, langPickerTargetBounds());
    d.langPickerWindow.showInactive();
    d.langPickerWindow.moveTop();
    d.langPickerWindow.webContents.send("lykn:lang-picker-shown");
    notifyLangPickerVisibility(true);
  };
  if (d.langPickerWindow.webContents.isLoading()) {
    d.langPickerWindow.webContents.once("did-finish-load", fire);
  } else fire();
}

function hideLangPickerWindow() {
  if (
    d.langPickerWindow &&
    !d.langPickerWindow.isDestroyed() &&
    d.langPickerWindow.isVisible()
  ) {
    d.langPickerWindow.hide();
  }
  notifyLangPickerVisibility(false);
}

function createLiveWindow() {
  d.liveWindow = new BrowserWindow({
    width: LIVE_WIDTH,
    height: LIVE_HEIGHT,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "live-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    d.liveWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(d.liveWindow);
  // Workspaces first, level last — see createOverlayWindow.
  d.liveWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.liveWindow.setFullScreenable(false);
  d.liveWindow.setAlwaysOnTop(true, "screen-saver");
  d.liveWindow.loadFile(path.join(ELECTRON_DIR, "live.html"));
  d.liveWindow.on("closed", () => {
    d.liveWindow = null;
  });
}

function liveWindowVisible() {
  return !!(d.liveWindow && !d.liveWindow.isDestroyed() && d.liveWindow.isVisible());
}

function liveTargetBounds() {
  const ob = d.overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.min(LIVE_HEIGHT, workArea.height - 16);
  let x = ob.x + ob.width + MENU_GAP;
  if (x + LIVE_WIDTH > workArea.x + workArea.width) x = ob.x - MENU_GAP - LIVE_WIDTH;
  x = Math.max(workArea.x, x);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x: Math.round(x), y: Math.round(y), width: LIVE_WIDTH, height: h };
}

function positionLiveWindow() {
  if (!liveWindowVisible()) return;
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  setFloatingBounds(d.liveWindow, liveTargetBounds());
}

function sendLiveState() {
  if (!liveWindowVisible() || !d.lastLiveState) return;
  try {
    d.liveWindow.webContents.send("lykn:live-state", d.lastLiveState);
  } catch (_) {}
}

function showLiveWindow() {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  if (!d.liveWindow || d.liveWindow.isDestroyed()) createLiveWindow();
  const fire = () => {
    if (!d.liveWindow || d.liveWindow.isDestroyed()) return;
    setFloatingBounds(d.liveWindow, liveTargetBounds());
    d.liveWindow.showInactive();
    d.liveWindow.moveTop();
    sendLiveState();
    // The side-panel card and three-dot menu float on the same side; re-place
    // them so they land next to the live card instead of underneath it.
    positionPanelWindow();
    positionMenuWindow();
  };
  if (d.liveWindow.webContents.isLoading()) d.liveWindow.webContents.once("did-finish-load", fire);
  else fire();
}

function hideLiveWindow() {
  if (liveWindowVisible()) d.liveWindow.hide();
  positionPanelWindow();
  positionMenuWindow();
}

function createPanelWindow() {
  d.panelWindow = new BrowserWindow({
    width: d.panelWidth,
    height: d.panelHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "panel-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    d.panelWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(d.panelWindow);
  // Workspaces first, level last — see createOverlayWindow.
  d.panelWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.panelWindow.setFullScreenable(false);
  d.panelWindow.setAlwaysOnTop(true, "screen-saver");
  d.panelWindow.loadFile(path.join(ELECTRON_DIR, "panel.html"));
  d.panelWindow.on("closed", () => {
    d.panelWindow = null;
  });
}

function panelWindowVisible() {
  return !!(d.panelWindow && !d.panelWindow.isDestroyed() && d.panelWindow.isVisible());
}

function panelTargetBounds() {
  const ob = d.overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(
    PANEL_MIN_HEIGHT,
    Math.min(d.panelHeight, PANEL_MAX_HEIGHT, workArea.height - 16),
  );
  const rightInset =
    (liveWindowVisible() ? LIVE_WIDTH + MENU_GAP : 0) +
    (agentSidebarWindowVisible() ? AGENT_SIDEBAR_WIDTH + MENU_GAP : 0);
  let x = ob.x + ob.width + MENU_GAP + rightInset;
  if (x + d.panelWidth > workArea.x + workArea.width) x = ob.x - MENU_GAP - d.panelWidth;
  x = Math.max(workArea.x, x);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(d.panelWidth), height: h };
}

function positionPanelWindow() {
  if (!panelWindowVisible()) return;
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  setFloatingBounds(d.panelWindow, panelTargetBounds());
}

function sendPanelState() {
  if (!panelWindowVisible() || !d.lastPanelState) return;
  try {
    d.panelWindow.webContents.send("lykn:panel-state", d.lastPanelState);
  } catch (_) {}
}

function showPanelWindow() {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  if (!d.panelWindow || d.panelWindow.isDestroyed()) createPanelWindow();
  const fire = () => {
    if (!d.panelWindow || d.panelWindow.isDestroyed()) return;
    setFloatingBounds(d.panelWindow, panelTargetBounds());
    d.panelWindow.showInactive();
    d.panelWindow.moveTop();
    sendPanelState();
    // The three-dot menu shares the right flank; re-place it so it lands
    // next to the panel instead of underneath it.
    positionMenuWindow();
  };
  if (d.panelWindow.webContents.isLoading()) d.panelWindow.webContents.once("did-finish-load", fire);
  else fire();
}

function hidePanelWindow() {
  if (panelWindowVisible()) d.panelWindow.hide();
  positionMenuWindow();
}

  d.createBurstWindow = createBurstWindow;
  d.createLangPickerWindow = createLangPickerWindow;
  d.createLiveWindow = createLiveWindow;
  d.createMenuWindow = createMenuWindow;
  d.createPanelWindow = createPanelWindow;
  d.createPickerWindow = createPickerWindow;
  d.hideLangPickerWindow = hideLangPickerWindow;
  d.hideLiveWindow = hideLiveWindow;
  d.hideMenuWindow = hideMenuWindow;
  d.hideOverlayGlass = hideOverlayGlass;
  d.hidePanelWindow = hidePanelWindow;
  d.hidePickerWindow = hidePickerWindow;
  d.langPickerTargetBounds = langPickerTargetBounds;
  d.liveTargetBounds = liveTargetBounds;
  d.liveWindowVisible = liveWindowVisible;
  d.menuTargetBounds = menuTargetBounds;
  d.notifyLangPickerVisibility = notifyLangPickerVisibility;
  d.notifyMenuVisibility = notifyMenuVisibility;
  d.notifyPickerVisibility = notifyPickerVisibility;
  d.panelTargetBounds = panelTargetBounds;
  d.panelWindowVisible = panelWindowVisible;
  d.pickerTargetBounds = pickerTargetBounds;
  d.playOverlayBurst = playOverlayBurst;
  d.positionLangPickerWindow = positionLangPickerWindow;
  d.positionLiveWindow = positionLiveWindow;
  d.positionMenuWindow = positionMenuWindow;
  d.positionPanelWindow = positionPanelWindow;
  d.positionPickerWindow = positionPickerWindow;
  d.sendLiveState = sendLiveState;
  d.sendPanelState = sendPanelState;
  d.showLangPickerWindow = showLangPickerWindow;
  d.showLiveWindow = showLiveWindow;
  d.showMenuWindow = showMenuWindow;
  d.showPanelWindow = showPanelWindow;
  d.showPickerWindow = showPickerWindow;
}

module.exports = { attachOverlaySatellites };
