"use strict";

function attachOverlayFamily(d) {
  if (d.__attached_attachOverlayFamily) return;
  d.__attached_attachOverlayFamily = true;
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
  const applyContentProtection = (...a) => d.applyContentProtection(...a);
  const floatingGlassChrome = (...a) => d.floatingGlassChrome(...a);
  const hardenFloatingGlass = (...a) => d.hardenFloatingGlass(...a);
  const hideAgentSidebarWindow = (...a) => d.hideAgentSidebarWindow(...a);
  const hideLangPickerWindow = (...a) => d.hideLangPickerWindow(...a);
  const hideLiveWindow = (...a) => d.hideLiveWindow(...a);
  const hideMenuWindow = (...a) => d.hideMenuWindow(...a);
  const hideOverlayGlass = (...a) => d.hideOverlayGlass(...a);
  const hidePanelWindow = (...a) => d.hidePanelWindow(...a);
  const hidePickerWindow = (...a) => d.hidePickerWindow(...a);
  const isContentProtectionEnabled = (...a) => d.isContentProtectionEnabled(...a);
  const playOverlayBurst = (...a) => d.playOverlayBurst(...a);
  const positionAgentSidebarWindow = (...a) => d.positionAgentSidebarWindow(...a);
  const positionLangPickerWindow = (...a) => d.positionLangPickerWindow(...a);
  const positionLiveWindow = (...a) => d.positionLiveWindow(...a);
  const positionMenuWindow = (...a) => d.positionMenuWindow(...a);
  const positionPanelWindow = (...a) => d.positionPanelWindow(...a);
  const positionPickerWindow = (...a) => d.positionPickerWindow(...a);
  const setFloatingBounds = (...a) => d.setFloatingBounds(...a);
  const showAgentSidebarWindow = (...a) => d.showAgentSidebarWindow(...a);
  const showLiveWindow = (...a) => d.showLiveWindow(...a);
  const showPanelWindow = (...a) => d.showPanelWindow(...a);
  const studioStageEmbedActive = (...a) => d.studioStageEmbedActive(...a);

function overlayWorkArea(boundsHint) {
  try {
    if (boundsHint && typeof boundsHint.x === "number") {
      return screen.getDisplayMatching(boundsHint).workArea;
    }
    if (d.overlayWindow && !d.overlayWindow.isDestroyed()) {
      return screen.getDisplayMatching(d.overlayWindow.getBounds()).workArea;
    }
  } catch (_) {
    /* fall through */
  }
  return screen.getPrimaryDisplay().workArea;
}

function overlayPosition(height) {
  const workArea = overlayWorkArea();
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - height - OVERLAY_BOTTOM_MARGIN),
  };
}

function overlayBoundsNeedHeal(bounds, workArea) {
  if (!bounds || !workArea) return true;
  const margin = 4;
  const bottom = bounds.y + bounds.height;
  const right = bounds.x + bounds.width;
  const workBottom = workArea.y + workArea.height;
  const workRight = workArea.x + workArea.width;
  // Composer lives at the bottom — if that edge is past the dock/screen, heal.
  if (bottom > workBottom + margin) return true;
  if (bounds.y + bounds.height * 0.5 < workArea.y) return true;
  if (right < workArea.x + 40 || bounds.x > workRight - 40) return true;
  // Too short to show the composer toolbar (buttons look "cut off").
  if (bounds.height > 0 && bounds.height < 96) return true;
  // Almost none of the window is actually visible in the work area.
  const visibleH =
    Math.min(bottom, workBottom) - Math.max(bounds.y, workArea.y);
  if (visibleH < 64) return true;
  return false;
}

function resetOverlayPositionToDefault() {
  d.overlayUserPositioned = false;
  d.overlayAnchorLeft = null;
  d.overlayAnchorBottomY = null;
}

function healOverlayGeometry(forceReset = false) {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  try {
    setOverlayClickThrough(false);
  } catch (_) {}
  try {
    if (d.overlayCollapsed) setOverlayCollapsed(false);
  } catch (_) {}
  let b;
  try {
    b = d.overlayWindow.getBounds();
  } catch (_) {
    return;
  }
  const wa = overlayWorkArea(b);
  if (forceReset || overlayBoundsNeedHeal(b, wa)) {
    resetOverlayPositionToDefault();
  }
  const w = Math.max(OVERLAY_WIDTH, Math.round(b.width || OVERLAY_WIDTH));
  // Ensure at least a full composer (title + field + toolbar) is laid out.
  const h = Math.max(130, Math.round(b.height || OVERLAY_MIN_HEIGHT));
  setOverlaySize(w, h);
}

function createOverlayWindow() {
  const pos = overlayPosition(OVERLAY_MIN_HEIGHT);
  d.overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_MIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Let the panel respond to the first click/drag without being activated
    // first, so file drops register even though it's a non-activating panel.
    acceptFirstMouse: true,
    // Float above everything, including full-screen apps.
    alwaysOnTop: true,
    // macOS: a non-activating panel can become key for text input WITHOUT
    // activating the app, so summoning it never yanks the user to LYKN's Space
    // or out of the full-screen app they're in. We drop the panel type when
    // OVERLAY_ACTIVATABLE_FOR_DROPS is on so the window can accept OS file drops.
    ...(IS_MAC && !OVERLAY_ACTIVATABLE_FOR_DROPS
      ? { type: "panel" }
      : {}),
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Exclude the overlay itself from screen capture (NSWindowSharingNone on
  // macOS / WDA_EXCLUDEFROMCAPTURE on Windows). The user still sees the glass
  // bar, but our own screenshots — and any other screen recording/share — won't
  // include it, so LYKN never "sees" its own chat window when reading the screen.
  // User-toggleable + persisted; defaults ON.
  d.overlayWindow.setContentProtection(isContentProtectionEnabled());
  hardenFloatingGlass(d.overlayWindow);
  // canJoinAllSpaces + fullScreenAuxiliary so the panel appears on the CURRENT
  // Space (over full-screen apps too); skipTransformProcessType stops macOS
  // from switching Spaces when it shows.
  //
  // ORDER MATTERS (electron#10078 / #26350): setVisibleOnAllWorkspaces can
  // reset the NSWindow level back to normal on macOS, so the always-on-top
  // level must be applied AFTER it — and setFullScreenable(false) in between
  // pins NSWindowCollectionBehaviorFullScreenAuxiliary. With the level set
  // first, whether the bar showed above a full-screen app was a coin flip.
  // On Windows these are mostly no-ops / best-effort; always-on-top still applies.
  d.overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.overlayWindow.setFullScreenable(false);
  // screen-saver level is the most reliable always-on-top tier on both platforms.
  d.overlayWindow.setAlwaysOnTop(true, "screen-saver");
  d.overlayWindow.loadFile(path.join(ELECTRON_DIR, "overlay.html"));

  // Forward Escape to the renderer. macOS non-activating panel windows can miss
  // normal keydown delivery depending on key-window state; before-input-event is
  // the reliable path so Esc can stop voice mode / dismiss the bar.
  d.overlayWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key !== "Escape" && input.code !== "Escape") return;
    try {
      if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
      d.overlayWindow.webContents.send("lykn:overlay-escape");
    } catch (_) {}
  });

  // When the bar becomes key again (click back from Cursor/etc.), put caret in ask.
  d.overlayWindow.on("focus", () => {
    try {
      if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
      d.overlayWindow.webContents.send("lykn:overlay-focus-composer");
    } catch (_) {}
  });

  // When the user drags the bar (native drag region), remember where they put
  // it so we stop re-centering it. Ignore our own programmatic moves.
  d.overlayWindow.on("moved", () => {
    if (d.overlayProgrammaticMove || !d.overlayWindow) return;
    const b = d.overlayWindow.getBounds();
    d.overlayUserPositioned = true;
    d.overlayAnchorLeft = b.x;
    d.overlayAnchorBottomY = b.y + b.height;
    positionMenuWindow();
    positionPickerWindow();
    positionLangPickerWindow();
    positionLiveWindow();
    positionPanelWindow();
    positionAgentSidebarWindow();
  });

  d.overlayWindow.on("closed", () => {
    d.overlayWindow = null;
  });

  // If the overlay's renderer dies (GPU reset, OOM, Chromium crash), the
  // window object survives but paints nothing — ⌘L and the d.tray click then
  // toggle an invisible zombie and the overlay looks permanently dead until
  // the whole app restarts. Tear the window down so the next toggle recreates
  // it fresh.
  d.overlayWindow.webContents.on("render-process-gone", (_e, details) => {
    console.warn("[overlay] renderer gone:", details?.reason || "unknown");
    try {
      if (d.overlayWindow && !d.overlayWindow.isDestroyed()) d.overlayWindow.destroy();
    } catch (_) {}
    d.overlayWindow = null;
  });
}

function setOverlayCollapsed(collapsed) {
  if (!d.overlayWindow) return;
  d.overlayCollapsed = !!collapsed;
  const b = d.overlayWindow.getBounds();
  const workArea = overlayWorkArea(b);
  const w = collapsed ? OVERLAY_BUBBLE : OVERLAY_WIDTH;
  const h = collapsed ? OVERLAY_BUBBLE : OVERLAY_MIN_HEIGHT;
  // Keep the bottom-left corner fixed across the swap so the chat column stays
  // put (it lives on the left; the bubble takes the chat's bottom-left spot).
  const left = b.x;
  let bottom = b.y + b.height;
  const margin = 8;
  const maxBottom = workArea.y + workArea.height - margin;
  bottom = Math.min(bottom, maxBottom);
  let x = left;
  let y = bottom - h;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - w));
  y = Math.max(workArea.y + margin, Math.min(y, maxBottom - h));

  if (!collapsed) {
    // Anchor future growth to where the panel reappears.
    d.overlayUserPositioned = true;
    d.overlayAnchorLeft = x;
    d.overlayAnchorBottomY = y + h;
    // Bring the live / side-panel / agents cards back alongside the bar.
    if (d.liveCardOpen) showLiveWindow();
    if (d.panelCardOpen) showPanelWindow();
    if (d.agentSidebarOpen) showAgentSidebarWindow();
  }

  d.overlayProgrammaticMove = true;
  setFloatingBounds(d.overlayWindow, {
    x: Math.round(x),
    y: Math.round(y),
    width: w,
    height: h,
  });
  d.overlayProgrammaticMove = false;
  // Floating panels next to the bar don't belong beside the collapsed bubble —
  // they come back when the bar expands.
  if (collapsed) {
    hideMenuWindow();
    hidePickerWindow();
    hideLangPickerWindow();
    hideLiveWindow();
    hidePanelWindow();
    hideAgentSidebarWindow();
  }
}

function setOverlaySize(width, height) {
  if (!d.overlayWindow || d.overlayCollapsed) return;
  const hint =
    d.overlayUserPositioned && d.overlayAnchorLeft != null && d.overlayAnchorBottomY != null
      ? { x: d.overlayAnchorLeft, y: d.overlayAnchorBottomY - 40, width: OVERLAY_WIDTH, height: 40 }
      : d.overlayWindow.getBounds();
  const workArea = overlayWorkArea(hint);
  const margin = 8;
  const maxH = Math.max(OVERLAY_MIN_HEIGHT, workArea.height - margin * 2);
  const w = Math.max(OVERLAY_WIDTH, Math.min(Math.round(width || OVERLAY_WIDTH), OVERLAY_MAX_WIDTH));
  const h = Math.max(OVERLAY_MIN_HEIGHT, Math.min(Math.round(height) || OVERLAY_MIN_HEIGHT, 760, maxH));

  let chatLeft;
  let bottom;
  if (d.overlayUserPositioned && d.overlayAnchorLeft != null && d.overlayAnchorBottomY != null) {
    chatLeft = d.overlayAnchorLeft;
    bottom = d.overlayAnchorBottomY;
  } else {
    chatLeft = Math.round(workArea.x + workArea.width / 2 - OVERLAY_WIDTH / 2);
    bottom = workArea.y + workArea.height - OVERLAY_BOTTOM_MARGIN;
  }

  const maxBottom = workArea.y + workArea.height - margin;
  const minBottom = workArea.y + margin + h;
  // Prefer keeping the composer on-screen over preserving a bad drag anchor.
  if (bottom > maxBottom || bottom < workArea.y + OVERLAY_MIN_HEIGHT) {
    bottom = Math.min(maxBottom, Math.max(minBottom, workArea.y + workArea.height - OVERLAY_BOTTOM_MARGIN));
    if (d.overlayUserPositioned) d.overlayAnchorBottomY = bottom;
  } else {
    bottom = Math.min(maxBottom, Math.max(bottom, Math.min(minBottom, maxBottom)));
  }

  let x = chatLeft;
  let y = bottom - h;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - w));
  // If top would clip, shrink upward room by moving bottom down… no: move y down
  // only within the room that still keeps bottom visible.
  if (y < workArea.y + margin) {
    y = workArea.y + margin;
    bottom = y + h;
    if (bottom > maxBottom) {
      // Height already capped to maxH — pin to top of work area.
      y = workArea.y + margin;
      bottom = y + h;
    }
    if (d.overlayUserPositioned) d.overlayAnchorBottomY = bottom;
  }
  if (d.overlayUserPositioned) d.overlayAnchorLeft = x;

  d.overlayProgrammaticMove = true;
  setFloatingBounds(d.overlayWindow, {
    x: Math.round(x),
    y: Math.round(y),
    width: w,
    height: h,
  });
  d.overlayProgrammaticMove = false;
  // Keep the floating menu/picker/live/panel cards glued to the bar's edges as it grows.
  positionMenuWindow();
  positionPickerWindow();
  positionLangPickerWindow();
  positionLiveWindow();
  positionPanelWindow();
  positionAgentSidebarWindow();
}

function hideOverlay() {
  if (d.overlayWindow && d.overlayWindow.isVisible()) d.overlayWindow.hide();
  // Tear down the full-screen "LYKN is on" glass alongside the bar.
  hideOverlayGlass();
  // And the floating three-dot menu + picker + live notes + side-panel + agents.
  hideMenuWindow();
  hidePickerWindow();
  hideLangPickerWindow();
  hideLiveWindow();
  hidePanelWindow();
  hideAgentSidebarWindow();
}

function setOverlayClickThrough(enabled) {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  try {
    d.overlayWindow.setIgnoreMouseEvents(!!enabled, enabled ? { forward: true } : undefined);
  } catch (_) {}
}

function focusOverlayForTyping() {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  // Glass is its own feature and appears ONLY when the user summons it
  // (⌘/Ctrl+L or an explicit "Open LYKN Glass"). If it's hidden, this
  // must never show it — hand the keyboard to the Studio rail if that's
  // where the work is, otherwise do nothing.
  if (!d.overlayWindow.isVisible()) {
    if (studioStageEmbedActive()) {
      try {
        if (d.studioWindow.isVisible()) d.studioWindow.focus();
      } catch (_) {}
    }
    return;
  }
  try {
    healOverlayGeometry(false);
  } catch (_) {}
  try {
    // Panel windows often accept the click but never become key after Cursor/etc.
    if (process.platform === "darwin") {
      try {
        app.focus({ steal: true });
      } catch (_) {}
    }
    d.overlayWindow.moveTop();
    d.overlayWindow.focus();
    d.overlayWindow.webContents.focus();
    d.overlayWindow.webContents.send("lykn:overlay-focus-composer");
  } catch (_) {}
}

async function withOverlayHiddenForClick(fn) {
  const vis = d.overlayWindow && !d.overlayWindow.isDestroyed() && d.overlayWindow.isVisible();
  if (vis) d.overlayWindow.hide();
  await new Promise((r) => setTimeout(r, 200));
  try {
    return await fn();
  } finally {
    if (vis && d.overlayWindow && !d.overlayWindow.isDestroyed()) {
      d.overlayWindow.show();
      d.overlayWindow.moveTop();
    }
  }
}

function showOverlay() {
  // A crashed renderer leaves a window that "shows" but paints nothing —
  // rebuild it instead of showing a blank zombie.
  if (d.overlayWindow && !d.overlayWindow.isDestroyed() && d.overlayWindow.webContents.isCrashed()) {
    try { d.overlayWindow.destroy(); } catch (_) {}
    d.overlayWindow = null;
  }
  if (!d.overlayWindow) createOverlayWindow();
  // Re-assert top-of-stack status on EVERY show. The level/ordering set at
  // creation can be lost after an app restart, a Space switch, or a full-screen
  // transition — which is why the panel sometimes appeared *behind* other
  // always-on-top windows (e.g. the main window) instead of coming all the way
  // forward. Re-applying the level + moveTop() forces it to the front again.
  //
  // ORDER MATTERS (electron#10078 / #26350): setVisibleOnAllWorkspaces can
  // reset the NSWindow level on macOS, so it goes FIRST and the always-on-top
  // level goes LAST. With the old order (level, then workspaces) the level
  // reset raced the show and the bar intermittently stayed hidden behind
  // full-screen apps until the user left and re-entered full screen.
  d.overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  d.overlayWindow.setFullScreenable(false);
  d.overlayWindow.setAlwaysOnTop(true, "screen-saver");
  // Re-assert content protection on every show — like the window level, it can
  // be dropped after a restart or Space/full-screen transition.
  applyContentProtection();
  // Unstick click-through / clipped geometry before the user sees the bar.
  healOverlayGeometry(false);
  // Brief summon wash behind the bar (no persistent outline).
  playOverlayBurst();
  d.overlayWindow.show();
  // Re-assert the level AFTER show too — ordering a window onto a full-screen
  // Space can drop it again — then bring it above the burst flash.
  d.overlayWindow.setAlwaysOnTop(true, "screen-saver");
  d.overlayWindow.moveTop();
  d.overlayWindow.focus();
  // Heal again after show — Spaces / full-screen can rewrite bounds on map.
  healOverlayGeometry(false);
  // Restore the live meeting notes + side-panel + agent sidebar if still open.
  if (d.liveCardOpen && !d.overlayCollapsed) showLiveWindow();
  if (d.panelCardOpen && !d.overlayCollapsed) showPanelWindow();
  if (d.agentSidebarOpen && !d.overlayCollapsed) showAgentSidebarWindow();
  d.overlayWindow.webContents.send("lykn:overlay-shown");
  try {
    d.checkForAppUpdates?.();
  } catch (_) {
    /* updater not ready */
  }
  try {
    d.broadcastUpdateStatus?.();
  } catch (_) {
    /* updater not ready */
  }
}

function toggleOverlay() {
  const alive =
    d.overlayWindow &&
    !d.overlayWindow.isDestroyed() &&
    !d.overlayWindow.webContents.isCrashed();
  if (alive && d.overlayWindow.isVisible()) {
    hideOverlay();
    return;
  }
  showOverlay();
}

  d.createOverlayWindow = createOverlayWindow;
  d.focusOverlayForTyping = focusOverlayForTyping;
  d.healOverlayGeometry = healOverlayGeometry;
  d.hideOverlay = hideOverlay;
  d.overlayBoundsNeedHeal = overlayBoundsNeedHeal;
  d.overlayPosition = overlayPosition;
  d.overlayWorkArea = overlayWorkArea;
  d.resetOverlayPositionToDefault = resetOverlayPositionToDefault;
  d.setOverlayClickThrough = setOverlayClickThrough;
  d.setOverlayCollapsed = setOverlayCollapsed;
  d.setOverlaySize = setOverlaySize;
  d.showOverlay = showOverlay;
  d.toggleOverlay = toggleOverlay;
  d.withOverlayHiddenForClick = withOverlayHiddenForClick;
}

module.exports = { attachOverlayFamily };
