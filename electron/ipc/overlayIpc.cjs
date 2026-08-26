"use strict";

function registerOverlayIpc(d) {
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
  const addLiveWatchRule = (...a) => d.addLiveWatchRule(...a);
  const afterStudioFullscreenExit = (...a) => d.afterStudioFullscreenExit(...a);
  const agentBrowserHomeSender = (...a) => d.agentBrowserHomeSender(...a);
  const agentBrowserMainTabCount = (...a) => d.agentBrowserMainTabCount(...a);
  const agentStageUrlAllowed = (...a) => d.agentStageUrlAllowed(...a);
  const agentStageVisible = (...a) => d.agentStageVisible(...a);
  const applyContentProtection = (...a) => d.applyContentProtection(...a);
  const attachmentsFromPickedPaths = (...a) => d.attachmentsFromPickedPaths(...a);
  const broadcastStudioFullscreen = (...a) => d.broadcastStudioFullscreen(...a);
  const captureBrowserScreenThumbnail = (...a) => d.captureBrowserScreenThumbnail(...a);
  const captureInteractiveSnip = (...a) => d.captureInteractiveSnip(...a);
  const captureScreenDescription = (...a) => d.captureScreenDescription(...a);
  const clearLiveWatchRules = (...a) => d.clearLiveWatchRules(...a);
  const closeAgentFinishedPopup = (...a) => d.closeAgentFinishedPopup(...a);
  const closeStudioBrowserSession = (...a) => d.closeStudioBrowserSession(...a);
  const commitAgentBrowserHistory = (...a) => d.commitAgentBrowserHistory(...a);
  const createMainWindow = (...a) => d.createMainWindow(...a);
  const describeBrowserTabProblem = (...a) => d.describeBrowserTabProblem(...a);
  const destroyAgentBrowserWindow = (...a) => d.destroyAgentBrowserWindow(...a);
  const emitAgentToUi = (...a) => d.emitAgentToUi(...a);
  const ensureAgentBrowserWindow = (...a) => d.ensureAgentBrowserWindow(...a);
  const extractReactArtifactCodeFromHtml = (...a) => d.extractReactArtifactCodeFromHtml(...a);
  const extractReactArtifactCodeFromResult = (...a) => d.extractReactArtifactCodeFromResult(...a);
  const fetchAppChatsForOverlay = (...a) => d.fetchAppChatsForOverlay(...a);
  const fetchOverlayMedia = (...a) => d.fetchOverlayMedia(...a);
  const focusOverlayForTyping = (...a) => d.focusOverlayForTyping(...a);
  const getActiveAgentBrowserWebContents = (...a) => d.getActiveAgentBrowserWebContents(...a);
  const getActiveBrowserTarget = (...a) => d.getActiveBrowserTarget(...a);
  const getAgentBrowserWebContents = (...a) => d.getAgentBrowserWebContents(...a);
  const getAuthToken = (...a) => d.getAuthToken(...a);
  const getBrowserPageText = (...a) => d.getBrowserPageText(...a);
  const getLiveWatchStatus = (...a) => d.getLiveWatchStatus(...a);
  const healOverlayGeometry = (...a) => d.healOverlayGeometry(...a);
  const hideAgentSidebarWindow = (...a) => d.hideAgentSidebarWindow(...a);
  const hideAllAgentBrowserWindows = (...a) => d.hideAllAgentBrowserWindows(...a);
  const hideLangPickerWindow = (...a) => d.hideLangPickerWindow(...a);
  const hideLiveWindow = (...a) => d.hideLiveWindow(...a);
  const hideMenuWindow = (...a) => d.hideMenuWindow(...a);
  const hideOverlay = (...a) => d.hideOverlay(...a);
  const hidePanelWindow = (...a) => d.hidePanelWindow(...a);
  const hidePickerWindow = (...a) => d.hidePickerWindow(...a);
  const hideStudioWindow = (...a) => d.hideStudioWindow(...a);
  const initAgentRuntime = (...a) => d.initAgentRuntime(...a);
  const isAgentArtifactTabId = (...a) => d.isAgentArtifactTabId(...a);
  const isContentProtectionEnabled = (...a) => d.isContentProtectionEnabled(...a);
  const layoutAgentStageViews = (...a) => d.layoutAgentStageViews(...a);
  const maybeNotifyProjectsChangedFromTool = (...a) => d.maybeNotifyProjectsChangedFromTool(...a);
  const microphoneStatus = (...a) => d.microphoneStatus(...a);
  const normalizeSyncUrl = (...a) => d.normalizeSyncUrl(...a);
  const normalizeUrlForMatch = (...a) => d.normalizeUrlForMatch(...a);
  const notifyStudioShowBrowser = (...a) => d.notifyStudioShowBrowser(...a);
  const omniboxToUrl = (...a) => d.omniboxToUrl(...a);
  const openAgentBrowserTabWithUrl = (...a) => d.openAgentBrowserTabWithUrl(...a);
  const openAgentStageArtifact = (...a) => d.openAgentStageArtifact(...a);
  const openFreshStudioBrowserTab = (...a) => d.openFreshStudioBrowserTab(...a);
  const openMicrophoneSettings = (...a) => d.openMicrophoneSettings(...a);
  const openStudioBrowserTabWithUrl = (...a) => d.openStudioBrowserTabWithUrl(...a);
  const openUrlPreferAgentBrowser = (...a) => d.openUrlPreferAgentBrowser(...a);
  const overlaySessionPreview = (...a) => d.overlaySessionPreview(...a);
  const overlaySessionTitle = (...a) => d.overlaySessionTitle(...a);
  const overlayWorkArea = (...a) => d.overlayWorkArea(...a);
  const paintArtifactIntoAgentTab = (...a) => d.paintArtifactIntoAgentTab(...a);
  const parseWatchRuleIntent = (...a) => d.parseWatchRuleIntent(...a);
  const persistAgentBrowserHistory = (...a) => d.persistAgentBrowserHistory(...a);
  const positionAgentSidebarWindow = (...a) => d.positionAgentSidebarWindow(...a);
  const positionLangPickerWindow = (...a) => d.positionLangPickerWindow(...a);
  const positionLiveWindow = (...a) => d.positionLiveWindow(...a);
  const positionMenuWindow = (...a) => d.positionMenuWindow(...a);
  const positionPanelWindow = (...a) => d.positionPanelWindow(...a);
  const positionPickerWindow = (...a) => d.positionPickerWindow(...a);
  const pushAgentBrowserHistory = (...a) => d.pushAgentBrowserHistory(...a);
  const pushAgentStageState = (...a) => d.pushAgentStageState(...a);
  const pushOverlaySessionToApp = (...a) => d.pushOverlaySessionToApp(...a);
  const raiseAgentBrowserHost = (...a) => d.raiseAgentBrowserHost(...a);
  const readAgentBrowserHistory = (...a) => d.readAgentBrowserHistory(...a);
  const readOverlaySessionsStore = (...a) => d.readOverlaySessionsStore(...a);
  const requestOmniboxFocusForTab = (...a) => d.requestOmniboxFocusForTab(...a);
  const resetOverlayPositionToDefault = (...a) => d.resetOverlayPositionToDefault(...a);
  const runOsascript = (...a) => d.runOsascript(...a);
  const safeFetchMain = (...a) => d.safeFetchMain(...a);
  const sanitizeHomeAttachments = (...a) => d.sanitizeHomeAttachments(...a);
  const saveHtmlToDownloads = (...a) => d.saveHtmlToDownloads(...a);
  const sendLiveState = (...a) => d.sendLiveState(...a);
  const sendPanelState = (...a) => d.sendPanelState(...a);
  const setBrowsingContextFromHistory = (...a) => d.setBrowsingContextFromHistory(...a);
  const setLiveWatchEnabled = (...a) => d.setLiveWatchEnabled(...a);
  const setOverlayClickThrough = (...a) => d.setOverlayClickThrough(...a);
  const setOverlayCollapsed = (...a) => d.setOverlayCollapsed(...a);
  const setOverlaySize = (...a) => d.setOverlaySize(...a);
  const setStudioBrowserEmbed = (...a) => d.setStudioBrowserEmbed(...a);
  const showAgentBrowserWindow = (...a) => d.showAgentBrowserWindow(...a);
  const showAgentSidebarWindow = (...a) => d.showAgentSidebarWindow(...a);
  const showLangPickerWindow = (...a) => d.showLangPickerWindow(...a);
  const showLiveWindow = (...a) => d.showLiveWindow(...a);
  const showMenuWindow = (...a) => d.showMenuWindow(...a);
  const showOverlay = (...a) => d.showOverlay(...a);
  const showPanelWindow = (...a) => d.showPanelWindow(...a);
  const showPickerWindow = (...a) => d.showPickerWindow(...a);
  const showStudioWindow = (...a) => d.showStudioWindow(...a);
  const snapshotAgentBrowserHistory = (...a) => d.snapshotAgentBrowserHistory(...a);
  const stageNativeShareFile = (...a) => d.stageNativeShareFile(...a);
  const streamScreenAnswer = (...a) => d.streamScreenAnswer(...a);
  const studioFullscreenActive = (...a) => d.studioFullscreenActive(...a);
  const studioStageEmbedActive = (...a) => d.studioStageEmbedActive(...a);
  const studioWindowRef = (...a) => d.studioWindowRef(...a);
  const toggleAgentIncognito = (...a) => d.toggleAgentIncognito(...a);
  const uniqueDownloadPath = (...a) => d.uniqueDownloadPath(...a);
  const warmStudioBrowser = (...a) => d.warmStudioBrowser(...a);
  const withOverlayHiddenForClick = (...a) => d.withOverlayHiddenForClick(...a);
  const withPermissionPrompt = (...a) => d.withPermissionPrompt(...a);
  const writeOverlaySessionsStore = (...a) => d.writeOverlaySessionsStore(...a);
  const writeOverlaySettings = (...a) => d.writeOverlaySettings(...a);

  ipcMain.on("lykn:hide-overlay", () => hideOverlay());
  // Renderer-initiated summon (Studio desktop right-click → "Open LYKN Glass").
  // Same path as the ⌘/Ctrl+L hotkey: show the bar and focus the composer.
  ipcMain.on("lykn:show-overlay", () => {
    try {
      showOverlay();
      focusOverlayForTyping();
    } catch (_) {}
  });
  ipcMain.on("lykn:focus-overlay-composer", () => focusOverlayForTyping());
  ipcMain.on("lykn:agent-finished-popup-close", () => closeAgentFinishedPopup());
  ipcMain.on("lykn:agent-finished-popup-open", (_e, agentId) => {
    const fallbackId =
      d.agentFinishedPopup && !d.agentFinishedPopup.isDestroyed()
        ? String(d.agentFinishedPopup.__lyknAgentId || "").trim()
        : "";
    const id = String(agentId || fallbackId || "").trim();
    closeAgentFinishedPopup();
    try {
      if (id) {
        const rt = initAgentRuntime();
        const switched = rt.switchAgent?.(id);
        // Always raise that worker's browser tab (even welcome-only tabs).
        // showAgentBrowserWindow raises the right host (Studio dock or,
        // only when no Studio window exists, the standalone stage).
        showAgentBrowserWindow(id, {
          focus: true,
          label: switched?.agent?.title || "Agent",
        });
      }
      // Glass only appears on an explicit summon (⌘L / "Open LYKN Glass") —
      // clicking a finish notice raises the agent's browser, nothing else.
    } catch (_) {}
  });
  ipcMain.on("lykn:reset-overlay-position", () => {
    resetOverlayPositionToDefault();
    healOverlayGeometry(true);
    try {
      if (d.overlayWindow && !d.overlayWindow.isDestroyed()) {
        d.overlayWindow.webContents.send("lykn:overlay-shown");
      }
    } catch (_) {}
  });
  ipcMain.on("lykn:open-main", () => {
    if (!d.mainWindow) createMainWindow();
    else {
      d.mainWindow.show();
      d.mainWindow.focus();
    }
  });
  ipcMain.on("lykn:open-vault", (_e, noteId) => {
    const id = String(noteId || "").trim();
    const url = id
      ? `${APP_ORIGIN}/vault?note=${encodeURIComponent(id)}`
      : `${APP_ORIGIN}/vault`;
    if (!d.mainWindow || d.mainWindow.isDestroyed()) createMainWindow();
    // Always navigate — createMainWindow loads the default app URL first.
    if (d.mainWindow && !d.mainWindow.isDestroyed()) d.mainWindow.loadURL(url);
    d.mainWindow.show();
    d.mainWindow.focus();
  });
  ipcMain.on("lykn:open-app-chat", (_e, chatId) => {
    // Studio replaced the AppSidebar chat shell as the product home.
    void chatId;
    showStudioWindow();
  });
  // ── LYKN Studio (liquid-glass workspace window) ────────────────────────
  ipcMain.on("lykn:studio-set", (_e, { open } = {}) => {
    if (open) showStudioWindow();
    else hideStudioWindow();
  });
  // Fullscreen toggle for the Studio window — plain native fullscreen; the
  // enter/leave events broadcast the new state to the renderer. While the
  // window is in SIMPLE fullscreen (no separate Space), exit that mode
  // instead — setFullScreen(false) wouldn't touch it.
  ipcMain.on("lykn:studio-fullscreen-set", (_e, { fullscreen } = {}) => {
    const win = studioWindowRef();
    if (!win) return;
    try {
      if (typeof win.isSimpleFullScreen === "function" && win.isSimpleFullScreen()) {
        if (!fullscreen) {
          win.setSimpleFullScreen(false);
          broadcastStudioFullscreen();
        }
        return;
      }
    } catch (_) {}
    win.setFullScreen(!!fullscreen);
  });
  ipcMain.handle("lykn:studio-fullscreen-get", () => ({
    fullscreen: studioFullscreenActive(),
  }));
  // Yellow dot — native or in-page: exit fullscreen if needed, then minimize.
  ipcMain.on("lykn:studio-minimize", () => {
    const win = studioWindowRef();
    if (!win) return;
    afterStudioFullscreenExit(win, () => win.minimize());
  });
  ipcMain.on("lykn:resize", (_e, payload) => {
    // Back-compat: a bare number is height-only; an object carries width too.
    if (payload && typeof payload === "object") {
      setOverlaySize(payload.width, payload.height);
    } else {
      setOverlaySize(OVERLAY_WIDTH, payload);
    }
  });
  ipcMain.on("lykn:collapse", (_e, collapsed) => setOverlayCollapsed(!!collapsed));
  // ── Detached three-dot menu window ────────────────────────────────────
  ipcMain.on("lykn:menu-set", (_e, { open } = {}) => {
    if (open) {
      hideLangPickerWindow();
      showMenuWindow();
    } else hideMenuWindow();
  });
  ipcMain.on("lykn:menu-close", () => hideMenuWindow());
  // The menu card reports its content height (menu vs past-chats view).
  ipcMain.on("lykn:menu-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0) {
      d.menuHeight = h;
      positionMenuWindow();
    }
  });
  // ── Detached side-panel picker window ─────────────────────────────────
  ipcMain.on("lykn:picker-set", (_e, { open } = {}) => {
    if (open) {
      hideLangPickerWindow();
      showPickerWindow();
    } else hidePickerWindow();
  });
  ipcMain.on("lykn:picker-close", () => hidePickerWindow());
  // Translate-mode language picker (detached vibrancy card under the To pill).
  ipcMain.on("lykn:lang-picker-set", (_e, { open, anchor } = {}) => {
    if (open) showLangPickerWindow(anchor);
    else hideLangPickerWindow();
  });
  ipcMain.on("lykn:lang-picker-close", () => hideLangPickerWindow());
  ipcMain.on("lykn:lang-picker-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0) {
      d.langPickerHeight = h;
      positionLangPickerWindow();
    }
  });
  ipcMain.on("lykn:lang-picker-select", (_e, { lang } = {}) => {
    try {
      if (d.overlayWindow && !d.overlayWindow.isDestroyed()) {
        d.overlayWindow.webContents.send("lykn:lang-picker-select", {
          lang: String(lang || ""),
        });
      }
    } catch (_) {}
  });
  ipcMain.handle("lykn:lang-picker-state", async () => {
    try {
      if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return null;
      return await d.overlayWindow.webContents.executeJavaScript(
        "window.__lyknLangPickerState ? window.__lyknLangPickerState() : null",
        true,
      );
    } catch (_) {
      return null;
    }
  });
  // The picker card reports its content height (varies with option count).
  ipcMain.on("lykn:picker-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0) {
      d.pickerHeight = h;
      positionPickerWindow();
    }
  });
  // A view was picked — apply it in the overlay renderer, which owns the
  // side-panel state and rendering.
  ipcMain.on("lykn:picker-select", (_e, { id } = {}) => {
    if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
    d.overlayWindow.webContents
      .executeJavaScript(
        `window.__lyknPickerSelect && window.__lyknPickerSelect(${JSON.stringify(
          String(id || ""),
        )});`,
        true,
      )
      .catch(() => {});
  });
  // Snapshot of the picker options (labels, counts, active view) from the overlay.
  ipcMain.handle("lykn:picker-state", async () => {
    if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return null;
    try {
      return await d.overlayWindow.webContents.executeJavaScript(
        "window.__lyknPickerState ? window.__lyknPickerState() : null",
        true,
      );
    } catch (_) {
      return null;
    }
  });
  // ── Detached live meeting notes window ────────────────────────────────
  ipcMain.on("lykn:live-set", (_e, { open } = {}) => {
    d.liveCardOpen = !!open;
    if (d.liveCardOpen) showLiveWindow();
    else {
      d.lastLiveState = null;
      hideLiveWindow();
    }
  });
  // The overlay renderer pushes render snapshots (head state + pane HTML);
  // we cache the latest so a freshly (re)created window paints immediately.
  ipcMain.on("lykn:live-push", (_e, state) => {
    d.lastLiveState = state || null;
    sendLiveState();
  });
  // ── Detached side-panel content window ─────────────────────────────────
  ipcMain.on("lykn:panel-set", (_e, { open } = {}) => {
    d.panelCardOpen = !!open;
    if (d.panelCardOpen) showPanelWindow();
    else {
      d.lastPanelState = null;
      hidePanelWindow();
    }
  });
  // The overlay renderer pushes render snapshots (title + section HTML);
  // we cache the latest so a freshly (re)created window paints immediately.
  ipcMain.on("lykn:panel-push", (_e, state) => {
    d.lastPanelState = state || null;
    const w = Math.round(Number(state && state.width) || 0);
    if (w > 0 && w !== d.panelWidth) {
      d.panelWidth = w;
      positionPanelWindow();
      positionMenuWindow();
    }
    sendPanelState();
  });
  // The panel card reports its content height (varies with section count).
  ipcMain.on("lykn:panel-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0 && h !== d.panelHeight) {
      d.panelHeight = h;
      positionPanelWindow();
    }
  });
  // User actions in the panel card (open link, ask follow-up, install
  // extension, close) run in the OVERLAY renderer, which owns the state.
  ipcMain.on("lykn:panel-cmd", (_e, { name, arg } = {}) => {
    if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
    d.overlayWindow.webContents
      .executeJavaScript(
        `window.__lyknPanelCmd && window.__lyknPanelCmd(${JSON.stringify(
          String(name || ""),
        )}, ${JSON.stringify(arg == null ? null : arg)});`,
        true,
      )
      .catch(() => {});
  });
  // User actions in the live card (tabs, close, copy, save, ask) run in the
  // OVERLAY renderer, which owns the audio streams + transcript state.
  ipcMain.on("lykn:live-cmd", (_e, { name, arg } = {}) => {
    if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
    d.overlayWindow.webContents
      .executeJavaScript(
        `window.__lyknLiveCmd && window.__lyknLiveCmd(${JSON.stringify(
          String(name || ""),
        )}, ${JSON.stringify(arg == null ? null : arg)});`,
        true,
      )
      .catch(() => {});
  });
  // Menu actions run in the OVERLAY renderer, which owns the real feature
  // logic (voice, live notes, watch, stealth, attach, snip, sessions…).
  ipcMain.on("lykn:menu-cmd", (_e, { name, arg } = {}) => {
    if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
    d.overlayWindow.webContents
      .executeJavaScript(
        `window.__lyknMenuCmd && window.__lyknMenuCmd(${JSON.stringify(
          String(name || ""),
        )}, ${JSON.stringify(arg == null ? null : arg)});`,
        true,
      )
      .catch(() => {});
  });
  // Snapshot of the overlay's toggle states so the menu badges stay in sync.
  ipcMain.handle("lykn:menu-state", async () => {
    if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return null;
    try {
      return await d.overlayWindow.webContents.executeJavaScript(
        "window.__lyknMenuState ? window.__lyknMenuState() : null",
        true,
      );
    } catch (_) {
      return null;
    }
  });
  // Content protection (exclude the overlay from screen capture). Persisted so
  // it survives restarts; applied to overlay + burst windows immediately.
  ipcMain.handle("lykn:get-content-protection", () => isContentProtectionEnabled());
  ipcMain.handle("lykn:set-content-protection", (_e, enabled) => {
    const on = !!enabled;
    writeOverlaySettings({ contentProtection: on });
    applyContentProtection(on);
    return on;
  });
  // Live Watch — continuous screen awareness with motion-aware frame diffing.
  ipcMain.handle("lykn:get-live-watch", () => getLiveWatchStatus());
  ipcMain.handle("lykn:set-live-watch", (_e, enabled) => setLiveWatchEnabled(!!enabled));
  ipcMain.handle("lykn:add-live-watch-rule", (_e, { text } = {}) => {
    if (!d.liveWatchState.enabled) return { ok: false, error: "watch_off" };
    const ruleText = parseWatchRuleIntent(text) || String(text || "").trim();
    if (!ruleText) return { ok: false, error: "empty_rule" };
    const entry = addLiveWatchRule(ruleText);
    return { ok: true, rule: entry?.text || ruleText, rules: d.liveWatchState.rules.map((r) => r.text) };
  });
  ipcMain.handle("lykn:clear-live-watch-rules", () => {
    clearLiveWatchRules();
    return { ok: true, rules: [] };
  });
  ipcMain.handle("lykn:get-night-briefs", async () => {
    try {
      const token = await getAuthToken();
      if (!token) return { ok: false, briefs: [] };
      const res = await fetch(`${API_BASE}/api/night-shift/briefs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, briefs: [], error: data?.error || res.status };
      return { ok: true, briefs: Array.isArray(data.briefs) ? data.briefs : [] };
    } catch (e) {
      return { ok: false, briefs: [], error: e?.message || "fetch_failed" };
    }
  });
  // During drag, only move the bar. Repositioning menu/picker/live/panel on
  // every pixel was stalling the cursor; those catch up on lykn:move-end.
  let overlayMoveSideTimer = null;
  const followOverlaySideWindows = () => {
    if (overlayMoveSideTimer) {
      clearTimeout(overlayMoveSideTimer);
      overlayMoveSideTimer = null;
    }
    positionMenuWindow();
    positionPickerWindow();
    positionLangPickerWindow();
    positionLiveWindow();
    positionPanelWindow();
    positionAgentSidebarWindow();
  };
  ipcMain.on("lykn:move-by", (_e, { dx, dy } = {}) => {
    if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
    const rdx = Math.round(dx || 0);
    const rdy = Math.round(dy || 0);
    if (!rdx && !rdy) return;
    const b = d.overlayWindow.getBounds();
    const workArea = overlayWorkArea(b);
    const margin = 8;
    const maxX = workArea.x + workArea.width - b.width;
    const maxY = workArea.y + workArea.height - b.height - margin;
    const nx = Math.max(workArea.x, Math.min(b.x + rdx, maxX));
    const ny = Math.max(workArea.y + margin, Math.min(b.y + rdy, Math.max(workArea.y + margin, maxY)));
    d.overlayProgrammaticMove = true;
    try {
      d.overlayWindow.setBounds(
        { x: nx, y: ny, width: b.width, height: b.height },
        false,
      );
    } catch (_) {
      try {
        d.overlayWindow.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
      } catch (_) {
        /* ignore */
      }
    }
    d.overlayProgrammaticMove = false;
    d.overlayUserPositioned = true;
    d.overlayAnchorLeft = nx;
    d.overlayAnchorBottomY = ny + b.height;
    // Safety net if the renderer never sends move-end (stuck drag / crash).
    if (overlayMoveSideTimer) clearTimeout(overlayMoveSideTimer);
    overlayMoveSideTimer = setTimeout(() => {
      overlayMoveSideTimer = null;
      followOverlaySideWindows();
    }, 120);
  });
  ipcMain.on("lykn:move-end", () => {
    followOverlaySideWindows();
  });
  ipcMain.on("lykn:ask", (event, args) => {
    streamScreenAnswer(event, args || {});
  });

  // ── Agent Mode IPC (parallel agents; does not share d.overlayAskGeneration) ─
  const runtime = () => initAgentRuntime();

  ipcMain.handle("lykn:agent-create", async (_e, payload = {}) => {
    // "New agent" from the rail = new tab too: agents and tabs are paired.
    const res = runtime().createAgent(payload || {});
    // Silent creation (LYKN Bots building a Bot) still gets its paired tab
    // from the runtime, but must not raise the browser window or steal focus.
    if (res?.ok && res.agentId && !payload?.silent) {
      try {
        showAgentBrowserWindow(res.agentId, {
          focus: true,
          label: res.agent?.title || "New agent",
        });
        requestOmniboxFocusForTab(res.agentId);
      } catch (_) {}
    }
    return res;
  });
  // LYKN Bots adopting an agent created before the headless flag existed:
  // mark it so the runtime stops raising the browser window for its runs.
  ipcMain.handle("lykn:agent-set-headless", async (_e, { agentId, headless } = {}) => {
    return runtime().setAgentHeadless?.(agentId, headless !== false) || { ok: false };
  });
  ipcMain.handle("lykn:agent-list", async () => {
    const rt = runtime();
    return {
      agents: rt.listPublic(),
      activeAgentId: rt.getActiveId(),
      agentModeOn: rt.isAgentModeOn(),
    };
  });
  ipcMain.handle("lykn:agent-switch", async (_e, agentId) => runtime().switchAgent(agentId));
  ipcMain.handle("lykn:agent-stop", async (_e, agentId) => runtime().stopAgent(agentId));
  ipcMain.handle("lykn:agent-close", async (_e, agentId) => {
    // Deleting an agent from the rail also retires its browser tab — capture
    // it for the History section before teardown wipes the view/meta.
    const snap = snapshotAgentBrowserHistory(agentId);
    const res = runtime().closeAgent(agentId);
    if (res?.ok) commitAgentBrowserHistory(snap);
    return res;
  });
  ipcMain.handle("lykn:agent-reset-main", async () => runtime().resetMainChat());
  ipcMain.handle("lykn:agent-send", async (_e, payload = {}) => {
    const { agentId, text, attachments } = payload || {};
    return runtime().send(agentId, { text, attachments });
  });
  ipcMain.handle("lykn:agent-choice-resolve", async (_e, payload = {}) => {
    const { agentId, choiceId, buttonId } = payload || {};
    return runtime().resolveChoice(agentId, { choiceId, buttonId });
  });
  ipcMain.handle("lykn:agent-mode-set", async (_e, { open } = {}) => {
    const rt = runtime();
    const res = rt.setAgentMode(!!open);
    d.agentSidebarOpen = !!open;
    if (open) {
      showAgentSidebarWindow();
      // Glass stays on Main; always open the agent browser (standby worker tab).
      const agents = Array.isArray(res.agents) ? res.agents : [];
      const worker =
        agents.find((a) => a && a.role !== "main") ||
        agents.find((a) => a && a.id && a.id !== res.mainAgentId);
      let browserId = worker?.id || res.linkedBrowserId || "";
      if (!browserId) {
        try {
          const created = rt.createAgent?.({
            title: "Agent 1",
            silent: true,
            activate: false,
          });
          browserId = created?.agentId || "";
          if (browserId) {
            agents.push(created.agent);
          }
        } catch (_) {}
      }
      if (browserId) {
        try {
          rt.setMainLinkedBrowser?.(browserId);
        } catch (_) {}
        showAgentBrowserWindow(browserId, {
          focus: false,
          label: (worker && worker.title) || "Agent 1",
        });
      }
    } else {
      hideAgentSidebarWindow();
    }
    return { ...res, browserVisible: open ? agentStageVisible() : false };
  });
  ipcMain.handle("lykn:agent-history", async (_e, agentId) => {
    return runtime().getSwitchSnapshot(agentId);
  });
  ipcMain.handle("lykn:agent-show-browser", async (_e, { agentId, visible } = {}) => {
    const id = agentId || runtime().getActiveId();
    if (!id) return { ok: false, error: "no_agent" };
    if (visible === false) {
      hideAllAgentBrowserWindows();
      return { ok: true, visible: false };
    }
    showAgentBrowserWindow(id, { focus: true });
    return { ok: true, visible: agentStageVisible() };
  });
  ipcMain.handle("lykn:agent-browser-visible", async () => ({
    ok: true,
    visible: agentStageVisible(),
  }));
  ipcMain.handle("lykn:agent-show-step", async (_e, { agentId, stepIndex } = {}) => {
    const id = agentId || runtime().getActiveId();
    if (!id) return { ok: false, error: "no_agent" };
    return runtime().showStepDeliverable(id, stepIndex);
  });
  ipcMain.on("lykn:agent-sidebar-set", (_e, { open } = {}) => {
    d.agentSidebarOpen = !!open;
    if (open) showAgentSidebarWindow();
    else hideAgentSidebarWindow();
  });
  ipcMain.on("lykn:agent-sidebar-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0 && h !== d.agentSidebarHeight) {
      d.agentSidebarHeight = h;
      positionAgentSidebarWindow();
      positionMenuWindow();
    }
  });
  ipcMain.handle("lykn:agent-stage-navigate", async (_e, { url } = {}) => {
    // Chrome-style omnibox: URLs load directly, plain text Googles it.
    const target = omniboxToUrl(url);
    if (!target) return { ok: false, error: "missing_url" };
    let id = d.agentStageActiveId || runtime().getActiveId();
    // Typing with no tab open just starts one, like a fresh browser window.
    if (!id) {
      openFreshStudioBrowserTab();
      id = d.agentStageActiveId || [...agentBrowserViews.keys()].pop();
    }
    if (!id) return { ok: false, error: "no_agent" };
    if (isAgentArtifactTabId(id)) {
      const view = agentBrowserViews.get(id);
      const wc = view?.webContents;
      if (!wc || wc.isDestroyed()) return { ok: false, error: "no_browser" };
      if (!agentStageUrlAllowed(target)) return { ok: false, error: "blocked_url" };
      try {
        await wc.loadURL(target);
        pushAgentStageState();
        return { ok: true, url: target };
      } catch (e) {
        return { ok: false, error: e?.message || "nav_failed" };
      }
    }
    const wc = getAgentBrowserWebContents(id);
    if (!wc) return { ok: false, error: "no_browser" };
    showAgentBrowserWindow(id, { focus: true });
    const nav = await ownedBrowserAct.navigate(wc, target);
    if (nav?.ok && nav.url) {
      pushAgentStageState();
    }
    return nav;
  });
  ipcMain.handle("lykn:agent-stage-back", async () => {
    const wc = getActiveAgentBrowserWebContents();
    if (wc?.canGoBack()) wc.goBack();
    return { ok: true };
  });
  ipcMain.handle("lykn:agent-stage-forward", async () => {
    const wc = getActiveAgentBrowserWebContents();
    if (wc?.canGoForward()) wc.goForward();
    return { ok: true };
  });
  ipcMain.handle("lykn:agent-stage-reload", async () => {
    const wc = getActiveAgentBrowserWebContents();
    if (wc) wc.reload();
    return { ok: true };
  });
  // Download the active tab. Artifact tabs (reports, built apps) save their
  // HTML into ~/Downloads; regular pages download the current URL.
  ipcMain.handle("lykn:agent-stage-download", async () => {
    const id = d.agentStageActiveId;
    const view = id ? agentBrowserViews.get(id) : null;
    const wc = view?.webContents;
    if (!id || !wc || wc.isDestroyed()) return { ok: false, error: "no_tab" };
    const meta = agentBrowserMeta.get(id) || {};
    const url = String(wc.getURL() || "");
    const isArtifactTab =
      meta.kind === "artifact" ||
      isAgentArtifactTabId(id) ||
      /^data:|^lykn-artifact:/i.test(url);
    if (isArtifactTab) {
      let html = "";
      // Prefer the original source over the rendered DOM.
      const cacheHit = url.match(/^lykn-artifact:\/\/([a-z0-9]+)/i);
      if (cacheHit) html = artifactHtmlCache.get(cacheHit[1]) || "";
      if (!html && /^data:text\/html/i.test(url)) {
        try {
          const [head, payload = ""] = url.split(/,(.+)/s);
          html = /;base64/i.test(head)
            ? Buffer.from(payload, "base64").toString("utf8")
            : decodeURIComponent(payload);
        } catch (_) {}
      }
      if (!html) {
        try {
          html = String(
            (await wc.executeJavaScript("document.documentElement.outerHTML", true)) || "",
          );
          if (html && !/^\s*<!doctype/i.test(html)) html = `<!doctype html>\n${html}`;
        } catch (_) {}
      }
      if (!html.trim()) return { ok: false, error: "no_content" };
      try {
        const target = saveHtmlToDownloads(html, meta.pageTitle || wc.getTitle() || "artifact");
        try {
          shell.showItemInFolder(target);
        } catch (_) {}
        return { ok: true, path: target };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }
    if (/^https?:\/\//i.test(url)) {
      try {
        wc.downloadURL(url);
        return { ok: true, started: true };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }
    return { ok: false, error: "nothing_to_download" };
  });
  ipcMain.handle("lykn:agent-stage-select", async (_e, { agentId } = {}) => {
    const id = String(agentId || "").trim();
    if (!id) return { ok: false, error: "missing_id" };
    if (!agentBrowserViews.has(id)) return { ok: false, error: "not_found" };

    // Switching away cancels a pending new-tab omnibox focus.
    if (d.agentStagePendingOmniboxFocusId && d.agentStagePendingOmniboxFocusId !== id) {
      d.agentStagePendingOmniboxFocusId = null;
    }

    // Correlate stage tab → Glass agent chat. Legacy art-* tabs use ownerAgentId;
    // one-tab-per-agent reuses the agent id even when kind is "artifact".
    const meta = agentBrowserMeta.get(id) || {};
    const tabAgentId = isAgentArtifactTabId(id)
      ? String(meta.ownerAgentId || "").trim()
      : id;

    const rt = runtime();
    const glassId = rt.getActiveId?.();

    // One agent per tab: clicking a tab always selects its agent in the rail.
    let switched = { ok: true, agentId: glassId || tabAgentId || id };
    if (tabAgentId) {
      switched = rt.switchAgent(tabAgentId);
      showAgentBrowserWindow(id, { focus: true });
    }

    // Keep the clicked stage tab visible.
    d.agentStageActiveId = id;
    raiseAgentBrowserHost({ focus: true });
    layoutAgentStageViews();
    pushAgentStageState();
    return { ...switched, tabId: id, linkedOnly: false };
  });
  ipcMain.handle("lykn:agent-stage-close-tab", async (_e, { agentId } = {}) => {
    const id = String(agentId || "").trim();
    if (!id) return { ok: false, error: "missing_id" };
    // Capture the tab for the rail's History section before teardown.
    const historySnap = snapshotAgentBrowserHistory(id);
    // The PRIMARY tab is the agent: closing it retires the agent entirely
    // (aborts the run, removes it from the agent list, tears down its browser
    // view). Tabs with no agent behind them — artifact previews, agent-owned
    // browse sub-tabs, manual new-tab pages, and the pinned Main agent
    // (closeAgent refuses to delete it) — just close the browser surface.
    const surfaceOnly = isAgentArtifactTabId(id) || agentTabIds.isSubTabId(id);
    let retired = null;
    if (!surfaceOnly) {
      try {
        retired = runtime().closeAgent?.(id);
      } catch (_) {}
    }
    if (!retired?.ok) {
      destroyAgentBrowserWindow(id);
      if (!surfaceOnly) {
        try {
          runtime().clearBrowserSurface?.(id);
        } catch (_) {}
      }
    }
    commitAgentBrowserHistory(historySnap);
    pushAgentStageState();
    return { ok: true };
  });
  // "+" on the stage tab strip — new agent chat + empty browser tab.
  ipcMain.handle("lykn:agent-stage-new-tab", async () => {
    if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) {
      return { ok: false, error: `max_tabs_${MAX_AGENT_BROWSER_TABS}` };
    }
    const rt = runtime();
    if (!rt.isAgentModeOn?.()) {
      rt.setAgentMode?.(true);
      // The Studio has its own agent rail beside the docked browser — only
      // pop the floating glass-chat sidebar when running standalone.
      if (!d.studioStageEmbedded) {
        d.agentSidebarOpen = true;
        try {
          showAgentSidebarWindow();
        } catch (_) {}
      }
    }
    const res = rt.createAgent({ title: "New agent" });
    if (!res?.ok || !res.agentId) return res || { ok: false, error: "create_failed" };
    showAgentBrowserWindow(res.agentId, {
      focus: true,
      label: res.agent?.title || "New agent",
    });
    requestOmniboxFocusForTab(res.agentId);
    return res;
  });
  ipcMain.handle("lykn:agent-stage-toggle-incognito", async () => {
    try {
      return await toggleAgentIncognito(d.agentStageActiveId);
    } catch (e) {
      return { ok: false, error: e?.message || "toggle_failed" };
    }
  });
  // Studio browser history — closed tabs/agents shown under the rail's
  // Agents section. Open = reopen the page in a fresh agent tab.
  ipcMain.handle("lykn:agent-browser-history-list", async () => ({
    ok: true,
    items: readAgentBrowserHistory(),
  }));
  ipcMain.handle("lykn:agent-browser-history-remove", async (_e, { entryId } = {}) => {
    const items = readAgentBrowserHistory();
    const idx = items.findIndex((i) => i.id === entryId);
    if (idx >= 0) {
      items.splice(idx, 1);
      persistAgentBrowserHistory();
      pushAgentBrowserHistory();
    }
    return { ok: true };
  });
  ipcMain.handle("lykn:agent-browser-history-open", async (_e, { entryId } = {}) => {
    const entry = readAgentBrowserHistory().find((i) => i.id === entryId);
    if (!entry) return { ok: false, error: "not_found" };
    if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) {
      return { ok: false, error: `max_tabs_${MAX_AGENT_BROWSER_TABS}` };
    }
    const rt = runtime();
    if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    // Restore the saved conversation with the agent so the rail shows the full
    // chat, and reopen its page in the same tab.
    const res = rt.createAgent({
      title: entry.title || "Agent",
      history: Array.isArray(entry.history) ? entry.history : [],
      activate: true,
    });
    if (!res?.ok || !res.agentId) return res || { ok: false, error: "create_failed" };
    showAgentBrowserWindow(res.agentId, {
      focus: true,
      label: entry.title || "Agent",
    });
    if (entry.url) {
      try {
        const wc = getAgentBrowserWebContents(res.agentId);
        if (wc) ownedBrowserAct.navigate(wc, entry.url).catch(() => {});
      } catch (_) {}
    }
    // Switch so the rail loads the restored thread (switchPayload carries it).
    try {
      rt.switchAgent(res.agentId);
    } catch (_) {}
    pushAgentStageState();
    return { ok: true, agentId: res.agentId };
  });
  // ── Chrome / Chromium sync (Polar-style) ──────────────────────────────────
  // Detect installed browsers + their profiles. No Keychain/Automation prompt
  // here — this only reads plaintext profile metadata so the UI can offer it.
  ipcMain.handle("lykn:chrome-sync-status", async () => {
    if (!chromeSync.IS_MAC) return { ok: true, supported: false, browsers: [] };
    try {
      const browsers = chromeSync.detectBrowsers().map((b) => ({
        id: b.id,
        name: b.name,
        profiles: chromeSync.listProfiles(b).map((p) => ({ dir: p.dir, name: p.name })),
      }));
      return { ok: true, supported: true, browsers };
    } catch (e) {
      return { ok: false, supported: true, browsers: [], error: e?.message || "status_failed" };
    }
  });
  // Import logins (cookies) and/or open tabs from a chosen browser profile.
  // First run triggers the Keychain prompt (cookies) and Automation prompt
  // (tabs) — both are the user's explicit consent.
  ipcMain.handle("lykn:chrome-sync-run", async (_e, opts = {}) => {
    if (!chromeSync.IS_MAC) return { ok: false, error: "unsupported_platform" };
    const browserId = String(opts.browserId || "chrome");
    const wantCookies = opts.importCookies !== false;
    const wantTabs = opts.importTabs !== false;
    const wantHistory = opts.importHistory !== false;
    const browser = chromeSync.detectBrowsers().find((b) => b.id === browserId);
    if (!browser) return { ok: false, error: "browser_not_found" };
    const profiles = chromeSync.listProfiles(browser);
    const profile =
      profiles.find((p) => p.dir === opts.profileDir) || profiles[0] || null;
    if (!profile) return { ok: false, error: "no_profile" };

    const result = {
      ok: true,
      browser: browser.name,
      profile: profile.name,
      cookies: { imported: 0, failed: 0 },
      tabs: { opened: 0, found: 0 },
      habits: { learned: false },
      warnings: [],
    };

    if (wantCookies) {
      const read = await chromeSync.readProfileCookies(browser, profile);
      if (!read.ok) {
        result.warnings.push(read.error || "cookie_read_failed");
        // A declined Keychain prompt means the user declined the sync. Do not
        // continue with tabs/history — opening the agent browser after "Deny"
        // is both surprising and violates the all-or-nothing welcome flow.
        return result;
      } else {
        try {
          const ses = session.fromPartition(AGENT_BROWSER_SHARED_PARTITION);
          // Families with partial decrypt failures are skipped wholesale —
          // importing half of Google's auth cookie set logs the user out.
          const { imported, failed, skipped } = await chromeSync.importCookiesToSession(
            ses,
            read.cookies,
            { skipDomains: read.corruptDomains || [] },
          );
          result.cookies = { imported, failed, skipped: skipped || 0 };
          if ((read.corruptDomains || []).length) {
            result.warnings.push(
              `cookies_kept_existing_login: ${read.corruptDomains.join(", ")}`,
            );
          }
        } catch (e) {
          result.warnings.push(`cookie_import_failed: ${e?.message || e}`);
        }
      }
    }

    if (wantTabs) {
      const open = await chromeSync.getOpenTabs(browser);
      if (!open.ok) {
        result.warnings.push(open.error || "tab_read_failed");
      } else {
        result.tabs.found = open.tabs.length;
        // Build the set of URLs already open, normalized, from LIVE webContents
        // (fresh tabs haven't written meta.url yet) plus stored meta. This makes
        // re-syncing idempotent and collapses trailing-slash / #hash variants.
        const seen = new Set();
        for (const [id, view] of agentBrowserViews) {
          const meta = agentBrowserMeta.get(id) || {};
          let u = meta.url || "";
          try {
            if (view?.webContents && !view.webContents.isDestroyed()) {
              u = view.webContents.getURL() || u;
            }
          } catch (_) {}
          const n = normalizeSyncUrl(u);
          if (n) seen.add(n);
        }
        // De-dupe the incoming Chrome list against itself + what's open, then
        // open the rest (each as its own agent), respecting the tab cap.
        let first = true;
        for (const url of open.tabs) {
          const n = normalizeSyncUrl(url);
          if (!n || seen.has(n)) continue;
          seen.add(n);
          if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) {
            result.warnings.push(`tab_cap_${MAX_AGENT_BROWSER_TABS}`);
            break;
          }
          const id = openAgentBrowserTabWithUrl(url, { focus: first });
          if (id) {
            result.tabs.opened += 1;
            first = false;
          }
        }
        // Active-tab id changed → relayout the view bounds, then refresh strip.
        layoutAgentStageViews();
        pushAgentStageState();
      }
    }

    if (wantHistory) {
      const hist = await chromeSync.readHistory(browser, profile, { limit: 60 });
      if (!hist.ok) {
        result.warnings.push(hist.error || "history_read_failed");
      } else {
        // Store privately as agent context — never shown to the user.
        result.habits.learned = setBrowsingContextFromHistory(hist, browser.name);
        if (!result.habits.learned) result.warnings.push("history_empty");
      }
    }

    return result;
  });
  ipcMain.handle("lykn:agent-recents-list", async () => {
    const items = agentRecentVisits.readRecents(app.getPath("userData")).items || [];
    return { ok: true, items };
  });
  ipcMain.handle("lykn:agent-recents-remove", async (_e, { id, host, url } = {}) => {
    const result = agentRecentVisits.removeRecent(app.getPath("userData"), {
      id,
      host,
      url,
    });
    pushAgentStageState();
    return { ok: !!result?.ok, items: result.items || [] };
  });
  // Local Mode — Vault switch grants file/terminal access to LYKN agents.
  // Device-level setting; tools only ever execute here in main.
  ipcMain.handle("lykn:local-mode-get", () => {
    const { enabled, syncAll, syncedFolders } = localSystem.readLocalMode(app.getPath("userData"));
    return { ok: true, enabled, syncAll, syncedFolders };
  });
  ipcMain.handle("lykn:local-mode-set", (_e, { enabled } = {}) => {
    const next = localSystem.writeLocalMode(app.getPath("userData"), !!enabled);
    // Every window (main app, Studio, overlay) should see the flip immediately.
    broadcastToAllWindows("lykn:local-mode-changed", { enabled: next.enabled });
    return { ok: true, enabled: next.enabled };
  });
  ipcMain.handle("lykn:local-tool-run", async (_e, { name, args, approvalToken } = {}) => {
    const { enabled } = localSystem.readLocalMode(app.getPath("userData"));
    if (!enabled) {
      return { ok: false, error: "Local mode is off — enable it in the Vault first." };
    }
    const toolName = String(name || "");
    const toolArgs = args || {};
    // Approval is NEVER taken from a renderer-supplied boolean. It is granted
    // only by a main-issued, single-use token bound to this exact tool + args.
    // Consuming here (before the run) makes the token one-shot; a missing,
    // wrong, expired, or already-used token simply yields approved=false.
    const approved = localApprovals.consume(approvalToken, toolName, toolArgs);
    const result = await localSystem.run(toolName, toolArgs, {
      approved,
      userDataPath: app.getPath("userData"),
    });
    // First pass on a risky action: main's own classifier asked for approval.
    // Mint a token so the approval UI can re-invoke the SAME action once the
    // user confirms. The token is bound to (tool, normalized args), so it can
    // only authorize this action.
    if (result && result.needsApproval === true) {
      result.approvalToken = localApprovals.issue(toolName, toolArgs);
    }
    return result;
  });

  ipcMain.handle("lykn:store-run", async (_e, { op, args } = {}) =>
    localStore.run(String(op || ""), args || {}),
  );

  // --- Installed apps ------------------------------------------------------
  // Managing apps (install, open, uninstall) is the main renderer's job. What
  // an app can do to the user's data is a different surface entirely and lives
  // on lykn:app-bridge, which only frames on a lykn-app:// origin can reach.
  const appHost = require("../appHost.cjs");

  ipcMain.handle("lykn:app-install", async (_e, payload = {}) => {
    const result = await appHost.installApp(payload || {});
    if (result.ok) {
      broadcastToAllWindows("lykn:apps-changed", { id: result.app.id, action: "install" });
    }
    return result;
  });

  ipcMain.handle("lykn:app-open", (_e, { id } = {}) => appHost.openApp(id));

  ipcMain.handle("lykn:app-uninstall", (_e, { id } = {}) => {
    const result = appHost.uninstallApp(id);
    broadcastToAllWindows("lykn:apps-changed", { id: String(id || ""), action: "uninstall" });
    return result;
  });

  ipcMain.handle("lykn:app-verify", async (_e, { id } = {}) => appHost.rebuildAndVerify(id));

  // Picking an icon is a user action, so it sticks: `icon_source` keeps the
  // next rebuild from handing the manifest's icon back.
  ipcMain.handle("lykn:app-set-icon", (_e, { id, icon } = {}) => {
    const record = localStore.apps.getApp(id);
    if (!record) return { ok: false, error: "app not found" };
    const app = localStore.apps.setAppIcon(id, icon);
    broadcastToAllWindows("lykn:apps-changed", { id: String(id), action: "update" });
    return { ok: true, app };
  });

  ipcMain.handle("lykn:app-list", () => ({ ok: true, apps: localStore.apps.listApps() }));

  ipcMain.handle("lykn:app-permissions", (_e, { id } = {}) => {
    const record = localStore.apps.getApp(id);
    if (!record) return { ok: false, error: "app not found" };
    return {
      ok: true,
      capabilities: record.capabilities || [],
      grants: record.grants || {},
      catalog: require("../appBridge.cjs").CAPABILITIES,
    };
  });

  // Revoking is a user action from settings; the app cannot do it to itself.
  ipcMain.handle("lykn:app-set-permission", (_e, { id, capability, allowed } = {}) => {
    const record = localStore.apps.getApp(id);
    if (!record) return { ok: false, error: "app not found" };
    const grants = { ...(record.grants || {}), [String(capability)]: allowed === true };
    localStore.apps.updateApp(id, { grants });
    return { ok: true, grants };
  });

  // --- Sync with Mac: synced-folders allowlist -----------------------------
  const macSyncState = (cfg) => ({
    ok: true,
    enabled: cfg.enabled,
    syncAll: cfg.syncAll,
    syncedFolders: cfg.syncedFolders,
    excludedFolders: cfg.excludedFolders,
  });
  ipcMain.handle("lykn:mac-sync-get", () =>
    macSyncState(localSystem.readLocalMode(app.getPath("userData")))
  );
  ipcMain.handle("lykn:mac-sync-set", (_e, { syncAll, syncedFolders } = {}) => {
    const next = localSystem.writeMacSync(app.getPath("userData"), { syncAll, syncedFolders });
    broadcastToAllWindows("lykn:mac-sync-changed", macSyncState(next));
    return macSyncState(next);
  });
  // One folder's switch, from its page in the Vault. Main works out what that
  // means for the allowlist so the renderer never has to reason about it.
  ipcMain.handle("lykn:mac-sync-folder", (_e, { folder, synced } = {}) => {
    const next = localSystem.writeFolderSync(app.getPath("userData"), { folder, synced });
    broadcastToAllWindows("lykn:mac-sync-changed", macSyncState(next));
    return macSyncState(next);
  });
  ipcMain.handle("lykn:mac-sync-pick-folder", async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(parent, {
      title: "Choose folders to sync with LYKN",
      buttonLabel: "Sync",
      properties: ["openDirectory", "multiSelections", "createDirectory"],
      defaultPath: app.getPath("home"),
    });
    if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, folders: res.filePaths };
  });

  // --- Mac Files browser (renderer-facing, gated on Local Mode + allowlist) -
  ipcMain.handle("lykn:mac-fs-list", async (_e, { path: dirPath } = {}) => {
    const cfg = localSystem.readLocalMode(app.getPath("userData"));
    if (!cfg.enabled) return { ok: false, error: "local_mode_off" };
    return localSystem.run("local_list_dir", { path: dirPath }, {
      userDataPath: app.getPath("userData"),
    });
  });
  ipcMain.handle("lykn:mac-fs-open", async (_e, { path: targetPath, reveal } = {}) => {
    const cfg = localSystem.readLocalMode(app.getPath("userData"));
    if (!cfg.enabled) return { ok: false, error: "local_mode_off" };
    const abs = localSystem.resolveUserPath(targetPath);
    if (!abs || !localSystem.isAllowedPath(abs, cfg)) {
      return { ok: false, error: "Path is not inside a synced folder" };
    }
    try {
      if (reveal) {
        shell.showItemInFolder(abs);
        return { ok: true };
      }
      const err = await shell.openPath(abs);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || "open failed" };
    }
  });
  // --- Files browser (the Vault's Locations sidebar) ------------------------
  // Richer than mac-fs-list above: sorting, hidden files, sidebar roots, the
  // editing operations, and a watcher so the view tracks the real disk. Each
  // op re-checks Local Mode and the allowlist inside macFiles itself.
  ipcMain.handle("lykn:files-list", (_e, args = {}) => macFiles.list(args));
  ipcMain.handle("lykn:files-thumbnail", (_e, args = {}) => macFiles.thumbnail(args));
  ipcMain.handle("lykn:files-roots", () => macFiles.roots());
  ipcMain.handle("lykn:files-mkdir", (_e, args = {}) => macFiles.mkdir(args));
  ipcMain.handle("lykn:files-rename", (_e, args = {}) => macFiles.rename(args));
  ipcMain.handle("lykn:files-move", (_e, args = {}) => macFiles.move(args));
  ipcMain.handle("lykn:files-copy", (_e, args = {}) => macFiles.copy(args));
  ipcMain.handle("lykn:files-duplicate", (_e, args = {}) => macFiles.duplicate(args));
  ipcMain.handle("lykn:files-trash", (_e, args = {}) => macFiles.trash(args));
  ipcMain.handle("lykn:files-watch", (_e, args = {}) => macFiles.watch(args));
  ipcMain.handle("lykn:files-unwatch", (_e, args = {}) => macFiles.unwatch(args));

  /**
   * Write bytes the renderer already holds into ~/Downloads.
   *
   * Chromium's own download plumbing is what an `<a download>` reaches, and
   * where it puts the file depends on the user's browser settings — which is
   * the wrong answer inside a desktop app that promises "it's in Downloads".
   * The bytes come over as a transferable buffer rather than a URL because
   * they're often a `lykn-blob://` or a data URL that only the renderer can
   * read.
   */
  ipcMain.handle("lykn:save-to-downloads", async (_e, { name, bytes } = {}) => {
    try {
      const buf = Buffer.from(bytes || []);
      if (!buf.length) return { ok: false, error: "empty" };
      const target = uniqueDownloadPath(name);
      await fs.writeFile(target, buf);
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err?.message || "write failed" };
    }
  });

  /**
   * The same bytes, but somewhere the user points at. The Mac's own save sheet
   * is the folder picker — it names the file and chooses the folder in one
   * step, and it is the panel people already know for "put this over there".
   */
  ipcMain.handle("lykn:save-file-as", async (e, { name, bytes, filters } = {}) => {
    try {
      const buf = Buffer.from(bytes || []);
      if (!buf.length) return { ok: false, error: "empty" };
      const parent =
        BrowserWindow.fromWebContents(e.sender) ||
        BrowserWindow.getFocusedWindow() ||
        undefined;
      const res = await dialog.showSaveDialog(parent, {
        defaultPath: path.join(app.getPath("downloads"), String(name || "file")),
        filters: Array.isArray(filters) && filters.length ? filters : undefined,
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      await fs.writeFile(res.filePath, buf);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err?.message || "write failed" };
    }
  });

  // The real, localized locations of the user's folders — Settings needs the
  // absolute Desktop path to mirror it and to add it to the sync allowlist.
  ipcMain.handle("lykn:mac-fs-home", () => {
    try {
      return {
        ok: true,
        home: app.getPath("home"),
        desktop: app.getPath("desktop"),
        documents: app.getPath("documents"),
        downloads: app.getPath("downloads"),
      };
    } catch (err) {
      return { ok: false, error: err?.message || "path lookup failed" };
    }
  });

  // --- Mac app dock: installed apps, launch, running-state ------------------
  ipcMain.handle("lykn:mac-apps-list", async () => {
    try {
      const apps = await appDock.listAppsWithIcons();
      return { ok: true, apps };
    } catch (err) {
      return { ok: false, error: err?.message || "app scan failed", apps: [] };
    }
  });
  ipcMain.handle("lykn:mac-app-launch", (_e, { path: bundlePath } = {}) =>
    appDock.launchApp(bundlePath)
  );
  ipcMain.handle("lykn:mac-app-quit", (_e, { path: bundlePath } = {}) =>
    appDock.quitApp(bundlePath)
  );
  ipcMain.handle("lykn:mac-apps-running", () => appDock.getRunningApps());
  // Studio dock subscribes while visible; polling stops when nobody listens.
  const runningAppWatchers = new Map(); // webContents.id -> unsubscribe
  ipcMain.on("lykn:mac-apps-watch", (e, { on } = {}) => {
    const wc = e.sender;
    const existing = runningAppWatchers.get(wc.id);
    if (!on) {
      if (existing) {
        existing();
        runningAppWatchers.delete(wc.id);
      }
      return;
    }
    if (existing) return;
    const unsubscribe = appDock.subscribeRunningApps((snapshot) => {
      try {
        if (!wc.isDestroyed()) {
          wc.send("lykn:mac-apps-running-changed", snapshot);
        }
      } catch (_) {}
    });
    runningAppWatchers.set(wc.id, unsubscribe);
    wc.once("destroyed", () => {
      const un = runningAppWatchers.get(wc.id);
      if (un) {
        un();
        runningAppWatchers.delete(wc.id);
      }
    });
  });
  ipcMain.on("lykn:agent-stage-chrome-height", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 40 && h !== d.agentStageChromeHeight) {
      d.agentStageChromeHeight = h;
      layoutAgentStageViews();
    }
  });
  // Saved-links dropdown open/closed — overlay the chrome above the page so
  // the menu renders in front of the browser instead of behind it.
  ipcMain.on("lykn:agent-stage-menu-overlay", (_e, { open } = {}) => {
    const next = !!open;
    if (next === d.agentStageMenuOverlay) return;
    d.agentStageMenuOverlay = next;
    try {
      // Transparent while overlaying so the page shows through around the
      // dropdown; opaque again once closed (normal seam-filling behavior).
      d.studioStageChromeView?.setBackgroundColor(next ? "#00000000" : "#ececeb");
    } catch (_) {}
    layoutAgentStageViews();
  });
  // Docked browser chrome → the Studio's floating Browser window. Its tab
  // strip carries the traffic lights and the title-bar drag, and it's a native
  // view, so the clicks land out here rather than in the Studio's DOM.
  ipcMain.on("lykn:studio-window-control", (_e, payload = {}) => {
    try {
      if (d.studioWindow && !d.studioWindow.isDestroyed()) {
        d.studioWindow.webContents.send("lykn:studio-window-control", payload || {});
      }
    } catch (_) {}
  });
  ipcMain.on("lykn:agent-stage-set", (_e, { open } = {}) => {
    if (open) {
      raiseAgentBrowserHost({ focus: true });
      pushAgentStageState();
    } else {
      hideAllAgentBrowserWindows();
    }
  });
  // Use LYKN pill / Studio close — show or hide the agent chat side panel.
  const setAgentChatOpen = (open, agentId = "") => {
    const next = !!open;
    if (next === d.agentChatOpen) {
      if (agentId) {
        emitAgentToUi("lykn:agent-chat-visibility", { open: next, agentId });
      }
      pushAgentStageState();
      return next;
    }
    d.agentChatOpen = next;
    emitAgentToUi("lykn:agent-chat-visibility", {
      open: next,
      ...(agentId ? { agentId } : {}),
    });
    pushAgentStageState();
    return next;
  };
  d.openBrowserTaskChat = (agentId) => setAgentChatOpen(true, agentId);
  ipcMain.handle("lykn:agent-chat-set", (_e, { open, toggle, agentId } = {}) => {
    if (toggle) return setAgentChatOpen(!d.agentChatOpen, agentId);
    return setAgentChatOpen(!!open, agentId);
  });
  ipcMain.handle("lykn:agent-chat-get", () => ({
    open: !!d.agentChatOpen,
    agentId: d.agentStageActiveId || runtime().getActiveId?.() || "",
  }));
  // Studio "Browser" tab — dock/undock the agent browser inside the Studio
  // window at the panel bounds the Studio renderer measured.
  ipcMain.on("lykn:studio-browser-set", (_e, payload = {}) => {
    try {
      setStudioBrowserEmbed(payload);
    } catch (err) {
      console.warn("[studio-browser] embed failed:", err?.message || err);
    }
  });
  // Sent as the Browser window starts opening, before it can report bounds —
  // load the chrome and the first tab while the frame animates.
  ipcMain.on("lykn:studio-browser-warm", () => {
    void warmStudioBrowser().catch((err) => {
      console.warn("[studio-browser] warm failed:", err?.message || err);
    });
  });
  // Red traffic light on the Studio Browser window — tear the session down.
  // Yellow minimize only parks the views via `studio-browser-set { open:false }`.
  ipcMain.handle("lykn:studio-browser-close", async () => {
    try {
      return closeStudioBrowserSession();
    } catch (err) {
      console.warn("[studio-browser] close failed:", err?.message || err);
      return { ok: false, error: err?.message || "close_failed" };
    }
  });
  // Studio artifact "Open" → open the URL in the Studio's own browser
  // (never the OS browser) as a fresh AGENT tab, so a new agent lands in
  // the rail and the AI can act on the page. The renderer switches the
  // Studio to its Browser tab right after this call, which docks the
  // views — so when the browser isn't docked yet the tab is selected
  // quietly instead of flashing the standalone stage window.
  ipcMain.handle("lykn:studio-open-url", async (_e, { url, title, chatId, attachChat } = {}) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: "bad_url" };
    if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) {
      return { ok: false, error: `max_tabs_${MAX_AGENT_BROWSER_TABS}` };
    }
    const label = String(title || "").trim().slice(0, 48);
    const sourceChatId = String(chatId || "").trim();
    const docked = studioStageEmbedActive();
    const studioOpen = !!(d.studioWindow && !d.studioWindow.isDestroyed());
    // Quiet create when Studio is open but Browser isn't docked yet — the
    // renderer will switch tabs and dock, and a loud create would flash the
    // standalone stage + race the welcome page over the real navigation.
    const quiet = studioOpen && !docked;
    const id =
      openAgentBrowserTabWithUrl(target, {
        title: label,
        focus: true,
        show: !quiet,
      }) || openStudioBrowserTabWithUrl(target, { focus: docked });
    if (!id) return { ok: false, error: "open_failed" };
    if (label) agentBrowserLabels.set(id, label);
    if (sourceChatId) {
      agentBrowserMeta.set(id, {
        ...(agentBrowserMeta.get(id) || {}),
        sourceChatId,
      });
    }
    setAgentChatOpen(true, id);
    notifyStudioShowBrowser({
      agentId: id,
      url: target,
      title: label || undefined,
      openRail: true,
    });
    if (docked) {
      showAgentBrowserWindow(id, { focus: true, label: label || undefined });
    } else {
      d.agentStageActiveId = id;
      layoutAgentStageViews();
      pushAgentStageState();
    }
    return { ok: true, id };
  });

  // Chat artifact open — same as studio-open-url but prefers inlined HTML when
  // provided (srcDoc) so React/deck artifacts paint even if the signed preview
  // URL is slow/expired, and marks the tab as an artifact so docking can't
  // wipe it back to the welcome page.
  ipcMain.handle("lykn:studio-open-artifact", async (_e, payload = {}) => {
    const url = String(payload.url || "").trim();
    const html = typeof payload.html === "string" ? payload.html : "";
    const label = String(payload.title || "Artifact").trim().slice(0, 48) || "Artifact";
    const kind = String(payload.kind || "artifact").trim() || "artifact";
    const sourceChatId = String(payload.chatId || "").trim();
    if (!url && !html.trim()) return { ok: false, error: "empty" };

    const docked = studioStageEmbedActive();
    const studioOpen = !!(d.studioWindow && !d.studioWindow.isDestroyed());
    const quiet = studioOpen && !docked;

    // Prefer a real agent tab (AI can act on the page). Fall back to a bare
    // stage artifact tab only if agent creation fails.
    let ownerId = null;
    try {
      const rt = initAgentRuntime();
      if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
      const res = rt.createAgent({ title: label, activate: true, silent: quiet || !docked });
      if (res?.ok && res.agentId) ownerId = res.agentId;
    } catch (_) {}

    if (ownerId) {
      agentBrowserLabels.set(ownerId, label);
      agentBrowserMeta.set(ownerId, {
        kind: "artifact",
        artifactKind: kind,
        ownerAgentId: ownerId,
        url: url || "lykn://artifact",
        pageTitle: label,
        ...(sourceChatId ? { sourceChatId } : {}),
      });
      ensureAgentBrowserWindow(ownerId, {
        show: docked,
        focus: true,
        label,
      });
      const painted = await paintArtifactIntoAgentTab(ownerId, {
        url,
        html,
        title: label,
        kind,
      });
      setAgentChatOpen(true, ownerId);
      notifyStudioShowBrowser({
        agentId: ownerId,
        url: url || undefined,
        title: label,
        openRail: true,
      });
      if (docked) {
        showAgentBrowserWindow(ownerId, { focus: true, label });
      } else {
        d.agentStageActiveId = ownerId;
        layoutAgentStageViews();
        pushAgentStageState();
      }
      return { ok: !!painted?.ok, id: ownerId, ...(painted || {}) };
    }

    // Last resort: classic deliverable subtab (no paired agent).
    const opened = openAgentStageArtifact({
      url: url || undefined,
      html: html || undefined,
      title: label,
      kind,
      show: docked,
      focus: true,
      // The user clicked "Open" — fronting is the whole point here.
      force: true,
    });
    notifyStudioShowBrowser({
      url: url || undefined,
      title: label,
      openRail: true,
    });
    return opened;
  });
  // The pre-send browser-route classifier and its offer flow are gone: the
  // chat model now sees local_browser_agent in its tool schemas and decides
  // for itself when a task belongs in the browser (see mcp-tools/localTools.js
  // and src/lib/ai/localToolExecutor.ts).

  // Studio agent rail chat bar → Main orchestrator. Enables Agent Mode
  // quietly (no floating sidebar window — the rail is already showing).
  ipcMain.handle("lykn:studio-bar-send", async (_e, { text, attachments, agentId, fromSuggestion, bot } = {}) => {
    const rt = runtime();
    try {
      if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    } catch (_) {}
    // Route to the agent the rail currently has selected, falling back to the
    // runtime's active agent. With no target at all, the runtime creates a
    // fresh agent (and its paired tab) for the prompt.
    const target = String(agentId || "").trim() || rt.getActiveId?.() || "";
    return rt.send(target, { text, attachments, fromSuggestion: !!fromSuggestion, bot: bot || null });
  });

  // Empty browser-tab composer → the browser agent. The preload exists on all
  // agent pages, so verify this is our bundled welcome document and identify
  // its paired agent from the sender before accepting the prompt.
  ipcMain.handle("lykn:agent-browser-ai-mode", async (event, { text, attachments } = {}) => {
    const sender = agentBrowserHomeSender(event);
    if (!sender) return { ok: false, error: "invalid_sender" };
    let agentId = "";
    for (const [id, view] of agentBrowserViews) {
      if (view?.webContents === sender) {
        agentId = id;
        break;
      }
    }
    if (!agentId) return { ok: false, error: "unknown_browser_tab" };
    const rt = runtime();
    try {
      if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    } catch (_) {}
    setAgentChatOpen(true, agentId);
    const goal = String(text || "").trim();
    const atts = sanitizeHomeAttachments(attachments);
    if (goal || atts.length) {
      void rt.send(agentId, {
        text: goal,
        attachments: atts,
        fromSuggestion: false,
      }).catch(() => {});
    }
    return { ok: true };
  });

  ipcMain.handle("lykn:agent-browser-ensure-mic", async (event) => {
    if (!agentBrowserHomeSender(event)) return false;
    try {
      const status = microphoneStatus();
      if (status === "granted") return true;
      if (IS_MAC) {
        if (status === "not-determined") {
          return await withPermissionPrompt("microphone", () =>
            systemPreferences.askForMediaAccess("microphone"),
          );
        }
        openMicrophoneSettings();
        return false;
      }
      if (status === "denied" || status === "restricted") {
        openMicrophoneSettings();
        return false;
      }
      return true;
    } catch {
      return !IS_MAC;
    }
  });

  ipcMain.handle("lykn:agent-browser-transcribe", async (event, { audio, mimeType, prompt } = {}) => {
    if (!agentBrowserHomeSender(event)) return { error: "invalid_sender" };
    try {
      const token = await getAuthToken();
      if (!token) return { error: "Sign in to LYKN first to use dictation." };

      const buf = Buffer.from(audio || []);
      if (!buf || buf.length < 2000) return { text: "" };

      const fd = new FormData();
      fd.append("audio", new Blob([buf], { type: mimeType || "audio/webm" }), "dictation.webm");
      fd.append("model", "whisper-1");
      fd.append("language", "en");
      if (prompt) fd.append("prompt", String(prompt).split(/\s+/).slice(-12).join(" "));

      const res = await fetch(`${API_BASE}/api/ai/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: `Transcription failed (${res.status}).` };
      return {
        text: String(data?.text || "").trim(),
        noSpeech: Number(data?.no_speech_prob) || 0,
      };
    } catch (e) {
      return { error: `Transcription failed: ${e && e.message ? e.message : e}` };
    }
  });

  ipcMain.handle("lykn:agent-browser-pick-files", async (event) => {
    const sender = agentBrowserHomeSender(event);
    if (!sender) return [];
    try {
      const parent =
        BrowserWindow.fromWebContents(sender) ||
        (d.studioWindow && !d.studioWindow.isDestroyed() ? d.studioWindow : undefined) ||
        BrowserWindow.getFocusedWindow() ||
        undefined;
      const res = await dialog.showOpenDialog(parent, {
        title: "Attach files",
        buttonLabel: "Add",
        properties: ["openFile", "multiSelections"],
      });
      if (res.canceled || !Array.isArray(res.filePaths) || !res.filePaths.length) {
        return [];
      }
      return attachmentsFromPickedPaths(res.filePaths);
    } catch {
      return [];
    }
  });

  ipcMain.handle("lykn:agent-browser-welcome-send", async (event, { text, requestId } = {}) => {
    const goal = String(text || "").trim();
    if (!goal) return { ok: false, error: "empty_prompt" };
    const sender = event?.sender;
    const senderUrl = String(sender?.getURL?.() || "");
    // Exact packaged-document identity — a remote page whose path ends in
    // agent-browser-welcome.html must not reach the agent.
    if (!isTrustedAgentBrowserHomeUrl(senderUrl)) {
      return { ok: false, error: "invalid_sender" };
    }
    let agentId = "";
    for (const [id, view] of agentBrowserViews) {
      if (view?.webContents === sender) {
        agentId = id;
        break;
      }
    }
    if (!agentId) return { ok: false, error: "unknown_browser_tab" };

    const rt = runtime();
    try {
      if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    } catch (_) {}
    // Use the runtime's own routing logic. Conversational prompts stay in the
    // new-tab thread; browser work opens the established task sidebar.
    // The new-tab composer is a normal chat surface. Keep every submitted
    // turn here and explicitly close any sidebar left open by a prior task.
    // Task handoff remains available from the existing browser chrome while
    // its dedicated inline handoff UI is built separately.
    const skill = "general";
    const task = false;
    setAgentChatOpen(false);
    browserWelcomeChatStreams.set(agentId, {
      sender,
      requestId: String(requestId || ""),
    });
    const run = rt.send(agentId, {
      text: goal,
      attachments: [],
      fromSuggestion: false,
    });
    if (task) {
      // The existing sidebar receives live agent progress for task work.
      void run.catch(() => {});
      return { ok: true, task: true, requestedSkill: skill };
    }
    // Chat remains on the new-tab surface. Return routing immediately, then
    // deliver the final conversational answer to its originating page.
    void run
      .then((result) => {
        browserWelcomeChatStreams.delete(agentId);
        if (!sender.isDestroyed?.()) {
          sender.send("lykn:agent-browser-welcome-result", {
            requestId: String(requestId || ""),
            ok: !!result?.ok,
            text: String(result?.text || ""),
          });
        }
      })
      .catch((error) => {
        browserWelcomeChatStreams.delete(agentId);
        if (!sender.isDestroyed?.()) {
          sender.send("lykn:agent-browser-welcome-result", {
            requestId: String(requestId || ""),
            ok: false,
            error: error?.message || "send_failed",
          });
        }
      });
    return { ok: true, task: false, requestedSkill: skill };
  });

  // Save a note (task summary, meeting notes, snippet, etc.) into the user's LYKN vault.
  ipcMain.handle("lykn:save-vault-note", async (_e, { title, content, tags, folder, source } = {}) => {
    try {
      const body = String(content || "").trim();
      if (!body) return { ok: false, error: "empty" };
      const token = await getAuthToken();
      if (!token) return { ok: false, error: "no_auth" };
      const payload = {
        title: String(title || "").slice(0, 200),
        content: body.slice(0, 60000),
        tags: Array.isArray(tags) ? tags.slice(0, 12).map((t) => String(t).slice(0, 32)) : undefined,
        folder: folder ? String(folder).slice(0, 80) : undefined,
      };
      // Overlay-authored notes (meetings, browser tasks) stamp a stable
      // `source` so the vault can render them as formatted docs — not
      // plain "Quick Note" cards.
      const src = typeof source === "string" ? source.trim().slice(0, 64) : "";
      if (src) payload.source = src;
      const res = await fetch(`${API_BASE}/api/v1/synthesis/vault`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        return { ok: false, error: (data && (data.error || data.text)) || `HTTP ${res.status}` };
      }
      return { ok: true, note: data.note || null };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : "save_failed" };
    }
  });

  // Native "attach files" picker. Dragging onto an always-on-top non-activating
  // panel is unreliable on macOS, so this is the dependable way to attach. We
  // read the files here and return ready-to-send attachment objects.
  ipcMain.handle("lykn:pick-files", async () => {
    try {
      // The overlay is a non-activating panel, so the app isn't frontmost — pull
      // it forward and parent the dialog to the overlay so the picker appears in
      // front instead of behind whatever app the user is in.
      try { app.focus({ steal: true }); } catch {}
      const parent =
        d.overlayWindow && !d.overlayWindow.isDestroyed() ? d.overlayWindow : undefined;
      const res = await dialog.showOpenDialog(parent, {
        properties: ["openFile", "multiSelections"],
        title: "Attach files to LYKN",
      });
      if (res.canceled || !Array.isArray(res.filePaths)) return [];
      const out = [];
      for (const p of res.filePaths.slice(0, 6)) {
        try {
          const name = path.basename(p);
          const ext = path.extname(p).toLowerCase();
          const imgMime = d.IMAGE_MIME_BY_EXT[ext];
          if (imgMime) {
            const buf = await fs.readFile(p);
            out.push({ kind: "image", name, dataUrl: `data:${imgMime};base64,${buf.toString("base64")}` });
          } else if (d.TEXT_FILE_RE.test(name)) {
            const text = await fs.readFile(p, "utf8");
            out.push({ kind: "text", name, text });
          } else {
            out.push({ kind: "text", name, text: "(Unsupported file type — not included.)" });
          }
        } catch {
          /* skip unreadable file */
        }
      }
      return out;
    } catch {
      return [];
    }
  });

  // Studio chat-bar Finder: the ordinary macOS Open panel, parented to the
  // window that asked so it isn't attached to the Glass overlay (which is
  // often hidden, so the picker would appear to do nothing). Returns the
  // chosen files as bytes the renderer can wrap in File objects.
  ipcMain.handle("lykn:pick-open-files", async (e) => {
    try {
      const parent =
        BrowserWindow.fromWebContents(e.sender) ||
        BrowserWindow.getFocusedWindow() ||
        undefined;
      const res = await dialog.showOpenDialog(parent, {
        title: "Choose files",
        buttonLabel: "Add",
        properties: ["openFile", "multiSelections"],
      });
      if (res.canceled || !Array.isArray(res.filePaths) || !res.filePaths.length) {
        return [];
      }
      const out = [];
      for (const p of res.filePaths) {
        try {
          const [buf, st] = await Promise.all([fs.readFile(p), fs.stat(p)]);
          if (st.isDirectory()) continue;
          const ext = path.extname(p).toLowerCase();
          out.push({
            name: path.basename(p),
            type: d.IMAGE_MIME_BY_EXT[ext] || "",
            lastModified: Math.round(st.mtimeMs) || Date.now(),
            data: buf,
          });
        } catch {
          /* skip unreadable file */
        }
      }
      return out;
    } catch {
      return [];
    }
  });

  // Snip-to-attach: drag-select a region and return it as an image attachment.
  // macOS uses the native screencapture crosshair; Windows (and fallback) uses
  // our fullscreen snip overlay. The glass bar is hidden so it isn't in the shot.
  ipcMain.handle("lykn:snip-screen", async () => {
    if (IS_MAC) {
      const outPath = path.join(app.getPath("temp"), `lykn-snip-${crypto.randomUUID()}.png`);
      try {
        await withOverlayHiddenForClick(
          () =>
            new Promise((resolve) => {
              // -i: interactive region select, -x: no camera sound.
              execFile("screencapture", ["-i", "-x", outPath], () => resolve());
            }),
        );
        let buf = null;
        try {
          buf = await fs.readFile(outPath);
        } catch {
          buf = null;
        }
        if (!buf || !buf.length) return null;
        return {
          kind: "image",
          name: "Screenshot.png",
          dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
        };
      } catch {
        return null;
      } finally {
        try {
          await fs.unlink(outPath);
        } catch {
          /* nothing to clean up */
        }
      }
    }
    return withOverlayHiddenForClick(() => captureInteractiveSnip());
  });

  // Snip overlay IPC (Windows region picker).
  ipcMain.on("lykn:snip-commit", (_e, rect) => {
    if (typeof d.snipResolver === "function") d.snipResolver(rect || null);
  });
  ipcMain.on("lykn:snip-cancel", () => {
    if (typeof d.snipResolver === "function") d.snipResolver(null);
  });

  // Past chats — merge ⌘L overlay sessions (local) with app chats (Supabase).
  ipcMain.handle("lykn:list-chats", async () => {
    const store = await readOverlaySessionsStore();
    const overlay = store.sessions
      .map((s) => ({
        id: s.id,
        title: s.title || overlaySessionTitle(s.messages),
        preview: overlaySessionPreview(s.messages),
        updatedAt: s.updatedAt || null,
        source: "overlay",
      }))
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    const appResult = await fetchAppChatsForOverlay();
    // Overlay sessions are now also mirrored into the app store (so they show
    // in the app's sidebar), which means they come back in BOTH lists with the
    // same id. The local overlay copy is canonical here (clicking it loads the
    // session inline), so drop the app duplicates to avoid double entries.
    const overlayIds = new Set(overlay.map((s) => s.id));
    const app = (appResult.chats || []).filter((c) => !overlayIds.has(c.id));
    return {
      overlay,
      app,
      currentSessionId: store.currentSessionId,
      error: appResult.error || null,
    };
  });

  ipcMain.handle("lykn:list-projects", async () => {
    const token = await getAuthToken().catch(() => null);
    if (!token) return { projects: [], error: "not_signed_in" };
    try {
      const res = await fetch(`${API_BASE}/api/v1/synthesis/projects?status=active&limit=40`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return { projects: [], error: "not_signed_in" };
      }
      if (!res.ok) {
        return { projects: [], error: `Could not load projects (${res.status}).` };
      }
      const data = await res.json().catch(() => ({}));
      const projects = Array.isArray(data?.projects) ? data.projects : [];
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name || "Untitled project",
          description: p.description || "",
          last_active_at: p.last_active_at || null,
          is_focus: !!p.is_focus,
        })),
        error: null,
      };
    } catch (err) {
      return { projects: [], error: err?.message || "Could not load projects." };
    }
  });

  ipcMain.handle("lykn:get-overlay-session", async (_e, sessionId) => {
    const id = String(sessionId || "").trim();
    if (!id) return null;
    const store = await readOverlaySessionsStore();
    const session = store.sessions.find((s) => s.id === id);
    return session || null;
  });

  ipcMain.handle("lykn:save-overlay-session", async (_e, payload = {}) => {
    const messages = Array.isArray(payload.messages)
      ? payload.messages
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
          .map((m) => ({
            role: m.role,
            content: String(m.content).slice(0, 12000),
            at: m.at || new Date().toISOString(),
          }))
      : [];
    if (!messages.length) return { ok: false };

    const store = await readOverlaySessionsStore();
    let sessionId = String(payload.sessionId || store.currentSessionId || "").trim();
    if (!sessionId) sessionId = crypto.randomUUID();

    const now = new Date().toISOString();
    const title = String(payload.title || "").trim() || overlaySessionTitle(messages);
    const existingIdx = store.sessions.findIndex((s) => s.id === sessionId);
    const existing = existingIdx >= 0 ? store.sessions[existingIdx] : null;

    // Track which pages this conversation touched so we can recall it later when
    // the user returns to the same page. Merge with any pages already recorded.
    const pageSource =
      payload.pageSource && payload.pageSource.url ? payload.pageSource : null;
    const pages = new Set(
      existing && Array.isArray(existing.pages) ? existing.pages : [],
    );
    let pageUrl = existing ? existing.pageUrl || null : null;
    let pageTitle = existing ? existing.pageTitle || null : null;
    if (pageSource) {
      const norm = normalizeUrlForMatch(pageSource.url);
      if (norm) pages.add(norm);
      pageUrl = pageSource.url;
      pageTitle = pageSource.title || pageTitle;
    }

    const session = {
      id: sessionId,
      title,
      updatedAt: now,
      messages,
      pages: Array.from(pages).slice(-20),
      pageUrl,
      pageTitle,
    };
    if (existingIdx >= 0) store.sessions[existingIdx] = session;
    else store.sessions.unshift(session);

    store.sessions.sort(
      (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
    );
    store.sessions = store.sessions.slice(0, 80);
    store.currentSessionId = sessionId;
    await writeOverlaySessionsStore(store);

    // Mirror the conversation into the app's chat store (lykn_chats /
    // lykn_chat_states) so it also appears in the actual app's "previous
    // chats" — not just the overlay's local list. Fire-and-forget: a failure
    // (offline, signed out) must never break the local save above.
    void pushOverlaySessionToApp(sessionId, title, messages);

    return { ok: true, sessionId };
  });

  ipcMain.handle("lykn:new-overlay-session", async () => {
    const store = await readOverlaySessionsStore();
    const sessionId = crypto.randomUUID();
    store.currentSessionId = sessionId;
    await writeOverlaySessionsStore(store);
    return { sessionId };
  });

  ipcMain.handle("lykn:ensure-overlay-session", async () => {
    const store = await readOverlaySessionsStore();
    if (store.currentSessionId) return { sessionId: store.currentSessionId };
    const sessionId = crypto.randomUUID();
    store.currentSessionId = sessionId;
    await writeOverlaySessionsStore(store);
    return { sessionId };
  });

  // Voice Mode: fetch an ElevenLabs session (signed URL / conversation token)
  // with the user's auth attached, so the overlay can open a live voice session.
  ipcMain.handle("lykn:voice-signed-url", async (_e, { instructions, timezone } = {}) => {
    try {
      const token = await getAuthToken();
      if (!token) return { error: "Sign in to LYKN first to use voice mode." };
      const res = await fetch(`${API_BASE}/api/ai/elevenlabs/signed-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          instructions: String(instructions || ""),
          chatId: null,
          timezone: timezone || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: String(data?.error || `Voice session failed (${res.status}).`) };
      return data;
    } catch (e) {
      return { error: `Voice session failed: ${e && e.message ? e.message : e}` };
    }
  });

  // Voice Mode tool dispatch — forwards an agent tool call to LYKN's realtime
  // tool endpoint with auth, mirroring the web app's /api/ai/realtime/tool path.
  ipcMain.handle("lykn:voice-tool", async (_e, { name, args } = {}) => {
    try {
      const token = await getAuthToken();
      if (!token) return { ok: false, error: "not_authenticated" };
      const res = await fetch(`${API_BASE}/api/ai/realtime/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, arguments: args ?? {}, chatId: null }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "bad_tool_response" }));
      maybeNotifyProjectsChangedFromTool(name, "done", data);
      return data;
    } catch {
      return { ok: false, error: "tool_request_failed" };
    }
  });

  // Voice Mode: capture + describe the current screen so the overlay can feed it
  // to the live agent as contextual text (voice can't take image inputs).
  ipcMain.handle("lykn:screen-context", async () => {
    return await captureScreenDescription();
  });

  // Voice Mode: capture + describe the screen, then push it to the server keyed
  // by the live session token so the custom-LLM injects it into every turn's
  // grounding. This is the reliable "voice sees your screen" path (it doesn't
  // depend on ElevenLabs forwarding contextual updates to the custom LLM).
  ipcMain.handle("lykn:voice-screen", async (_e, { sessionToken } = {}) => {
    try {
      if (!sessionToken) return { ok: false, error: "no_session" };
      const desc = await captureScreenDescription();
      if (!desc || desc.error || !desc.text) {
        return { ok: false, error: (desc && desc.error) || "no_text" };
      }
      const token = await getAuthToken();
      if (!token) return { ok: false, error: "not_authenticated" };
      const res = await fetch(`${API_BASE}/api/ai/realtime/screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionToken, text: desc.text }),
      });
      const data = await res.json().catch(() => ({}));
      console.log("[voice-screen] pushed:", res.status, "ok:", !!(data && data.ok));
      return data && data.ok ? { ok: true } : { ok: false, error: (data && data.error) || `http_${res.status}` };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : "failed" };
    }
  });

  // Make sure the OS has granted microphone access before the renderer records.
  ipcMain.handle("lykn:ensure-mic", async () => {
    try {
      const status = microphoneStatus();
      if (status === "granted") return true;
      if (IS_MAC) {
        if (status === "not-determined") {
          return await withPermissionPrompt("microphone", () =>
            systemPreferences.askForMediaAccess("microphone"),
          );
        }
        openMicrophoneSettings();
        return false;
      }
      // Windows: Chromium prompts on getUserMedia; if previously denied, open Settings.
      if (status === "denied" || status === "restricted") {
        openMicrophoneSettings();
        return false;
      }
      return true;
    } catch {
      return !IS_MAC;
    }
  });

  // Transcribe dictated audio. The renderer records (getUserMedia/MediaRecorder)
  // and hands us the bytes; we attach the auth token and post to LYKN's whisper
  // endpoint here so the token never lives in the overlay renderer.
  ipcMain.handle("lykn:transcribe", async (_e, { audio, mimeType, prompt }) => {
    try {
      const token = await getAuthToken();
      if (!token) return { error: "Sign in to LYKN first to use dictation." };

      const buf = Buffer.from(audio);
      if (!buf || buf.length < 2000) return { text: "" };

      const fd = new FormData();
      fd.append("audio", new Blob([buf], { type: mimeType || "audio/webm" }), "dictation.webm");
      fd.append("model", "whisper-1");
      fd.append("language", "en");
      if (prompt) fd.append("prompt", String(prompt).split(/\s+/).slice(-12).join(" "));

      const res = await fetch(`${API_BASE}/api/ai/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: `Transcription failed (${res.status}).` };
      return {
        text: String(data?.text || "").trim(),
        noSpeech: Number(data?.no_speech_prob) || 0,
      };
    } catch (e) {
      return { error: `Transcription failed: ${e && e.message ? e.message : e}` };
    }
  });

  // Live meeting notes — VAD-endpointed utterances from the overlay. fast=1
  // returns raw ASR text immediately (the overlay polishes asynchronously),
  // and gpt-4o-mini-transcribe beats whisper-1 on both speed and accuracy
  // for short conversational clips.
  ipcMain.handle("lykn:meeting-chunk", async (_e, { audio, mimeType, prompt, context } = {}) => {
    try {
      const token = await getAuthToken();
      if (!token) return { error: "Sign in to LYKN first." };

      const buf = Buffer.from(audio);
      if (!buf || buf.length < 800) return { text: "" };

      const mime = mimeType || "audio/webm";
      const ext = /wav/i.test(mime) ? "wav" : "webm";
      const fd = new FormData();
      fd.append("audio", new Blob([buf], { type: mime }), `meeting.${ext}`);
      fd.append("model", "gpt-4o-mini-transcribe");
      fd.append("fast", "1");
      fd.append("language", "en");
      // A longer rolling tail biases the ASR toward in-domain vocabulary
      // (names, jargon) — the single biggest accuracy lever Whisper exposes.
      if (prompt) fd.append("prompt", String(prompt).split(/\s+/).slice(-40).join(" "));
      if (context) fd.append("context", String(context).slice(-600));

      const res = await fetch(`${API_BASE}/api/ai/meeting-chunk`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: `Transcription failed (${res.status}).` };
      return {
        text: String(data?.text || "").trim(),
        noSpeech: Number(data?.no_speech_prob) || 0,
      };
    } catch (e) {
      return { error: `Transcription failed: ${e && e.message ? e.message : e}` };
    }
  });

  // Cluely-style live assist — the overlay streams the rolling transcript
  // after each utterance; the backend decides if this moment deserves a help
  // card (question answer, company brief, fact check, suggested reply) and
  // may run a live web search mid-sentence to compose it.
  ipcMain.handle("lykn:live-assist", async (_e, { transcript, shown } = {}) => {
    try {
      const token = await getAuthToken();
      if (!token) return { insight: null };
      const res = await fetch(`${API_BASE}/api/ai/live-assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: String(transcript || "").slice(-2400),
          shown: Array.isArray(shown) ? shown.slice(-10) : [],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { insight: null };
      return { insight: data?.insight || null };
    } catch (_) {
      return { insight: null };
    }
  });

  // Wispr-Flow-style cleanup for the live-listen transcript: strip fillers,
  // false starts, stutters and repeats from a raw Whisper chunk. Fails open
  // (returns the raw text) so the transcript never stalls on an error.
  ipcMain.handle("lykn:clean-transcript", async (_e, { text, context } = {}) => {
    const raw = String(text || "").trim();
    if (!raw) return { text: "" };
    try {
      const token = await getAuthToken();
      if (!token) return { text: raw };
      const res = await fetch(`${API_BASE}/api/ai/clean-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: raw, context: String(context || "") }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { text: raw };
      return { text: String(data?.text || "").trim() };
    } catch (_) {
      return { text: raw };
    }
  });

  // Open a URL from overlay / Studio chat links. Always opens a fresh agent
  // tab in the LYKN browser (never the OS browser for http(s)).
  // Never navigate the overlay window itself.
  ipcMain.on("lykn:open-url", (_e, payload) => {
    // Accept legacy string payloads and { url, title } from newer callers.
    const url =
      typeof payload === "string"
        ? payload
        : String(payload?.url || "");
    const title =
      typeof payload === "object" && payload
        ? String(payload.title || "")
        : "";
    void openUrlPreferAgentBrowser(url, { title });
  });

  // macOS sharing-services picker (AirDrop, Messages, Mail, Notes, Photos…).
  // Electron only exposes it through the native `shareMenu` role, and the
  // services are attached by AppKit when the menu holding that item is built —
  // the item's JS `submenu` is always empty, so it must never be popped on its
  // own (that shows an empty, invisible menu, i.e. "the button does nothing").
  ipcMain.handle("lykn:native-share", async (event, payload = {}) => {
    if (!IS_MAC) return { ok: false, error: "unsupported" };
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no_window" };
    const title = String(payload.title || "").trim().slice(0, 500);
    const text = String(payload.text || "").trim().slice(0, 20_000);
    const rawUrl = String(payload.url || "").trim().slice(0, 8_000);
    let url = "";
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") url = parsed.href;
    } catch {
      /* text-only sharing remains available */
    }

    // Sharing the bytes (not a signed link) is what unlocks AirDrop, Add to
    // Photos, and Mail attachments — the services a Mac user expects to see.
    let filePath = "";
    if (url && payload.asFile) {
      filePath = await stageNativeShareFile(url, payload.filename || title);
    }

    const sharingItem = {};
    if (filePath) sharingItem.filePaths = [filePath];
    const texts = [text || title].filter(Boolean);
    if (texts.length) sharingItem.texts = texts;
    // A signed asset URL alongside the file only duplicates the payload, and
    // some services then offer the link instead of the attachment.
    if (url && !filePath) sharingItem.urls = [url];
    if (!sharingItem.filePaths && !sharingItem.texts && !sharingItem.urls) {
      return { ok: false, error: "empty" };
    }

    const bounds = win.getContentBounds();
    const x = Math.max(0, Math.min(Math.round(Number(payload.x) || 0), Math.max(0, bounds.width - 1)));
    const y = Math.max(0, Math.min(Math.round(Number(payload.y) || 0), Math.max(0, bounds.height - 1)));
    const menu = Menu.buildFromTemplate([{ role: "shareMenu", sharingItem }]);
    // positioningItem puts "Share" itself under the cursor, so the services
    // list is one hover away — same feel as Finder's Share menu.
    menu.popup({ window: win, x, y, positioningItem: 0 });
    // `api` lets the renderer tell this handler apart from an older main
    // process still loaded from before a restart — without it, a stale build
    // answers `ok` while showing nothing and the Share button looks dead.
    return { ok: true, api: 2, sharedFile: !!filePath };
  });

  // Download a generated file (image mode picture, Build-mode artifact) into
  // ~/Downloads and reveal it in Finder. The overlay page is file:// so anchor
  // `download` attributes don't work on the cross-origin proxy URLs — the
  // main process fetches and writes the file instead. The same bytes are also
  // saved into the user's Vault (best-effort) so the artifact survives past
  // the signed URL's expiry.
  ipcMain.handle("lykn:download-file", async (_e, { url, name, title } = {}) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && !/^lykn-artifact:\/\//i.test(u)) {
      return { ok: false, error: "bad_url" };
    }
    try {
      let buf;
      let mime = "application/octet-stream";
      let filename = String(name || "").trim();

      if (/^lykn-artifact:\/\//i.test(u)) {
        const key = new URL(u).hostname.replace(/\/$/, "");
        const html = artifactHtmlCache.get(key);
        if (!html) return { ok: false, error: "expired" };
        buf = Buffer.from(html, "utf8");
        mime = "text/html";
      } else {
        const res = await fetchOverlayMedia(u);
        if (!res || !res.ok) return { ok: false, error: `http_${res?.status || 0}` };
        buf = Buffer.from(await res.arrayBuffer());
        mime = (res.headers.get("content-type") || "").split(";")[0].trim() || mime;
        if (!filename) {
          const cd = res.headers.get("content-disposition") || "";
          const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
          if (m) {
            try {
              filename = decodeURIComponent(m[1]);
            } catch {
              filename = m[1];
            }
          }
        }
        if (!filename) {
          try {
            filename = decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
          } catch {
            /* fall through */
          }
        }
      }

      filename =
        filename.replace(/[/\\:*?"<>|]+/g, "-").replace(/^\.+/, "").slice(0, 120) || "download";
      if (!/\.[a-z0-9]{1,8}$/i.test(filename)) {
        const ext = {
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/webp": ".webp",
          "image/gif": ".gif",
          "image/svg+xml": ".svg",
          "text/html": ".html",
          "application/pdf": ".pdf",
          "text/plain": ".txt",
          "video/mp4": ".mp4",
          "video/webm": ".webm",
        }[mime.toLowerCase()] || "";
        filename += ext;
      }

      const dir = app.getPath("downloads");
      const dot = filename.lastIndexOf(".");
      const base = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : "";
      let target = path.join(dir, filename);
      for (let i = 2; fsSync.existsSync(target); i += 1) {
        target = path.join(dir, `${base} (${i})${ext}`);
      }
      await fs.writeFile(target, buf);
      shell.showItemInFolder(target);

      // Vault copy — best-effort: a vault failure (offline, signed out, cap
      // reached) must not fail the local download the user asked for.
      let savedToVault = false;
      try {
        const token = await getAuthToken();
        if (token) {
          const form = new FormData();
          form.append("file", new Blob([buf], { type: mime }), filename);
          form.append("title", String(title || "").trim() || filename.replace(/\.[a-z0-9]{1,8}$/i, ""));
          const vaultRes = await fetch(`${API_BASE}/api/vault/save-file`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: form,
          });
          const vaultData = await vaultRes.json().catch(() => null);
          savedToVault = !!(vaultRes.ok && vaultData && vaultData.ok);
        }
      } catch {
        savedToVault = false;
      }

      return { ok: true, path: target, savedToVault };
    } catch (err) {
      return { ok: false, error: err?.message || "download_failed" };
    }
  });

  // Extract the raw JSX source of a Build-mode artifact. The runner HTML
  // embeds it in a <script id="lykn-artifact-source" type="application/json">
  // block, so we fetch the artifact URL here (main process — no CORS) and
  // hand the decoded component source back to the overlay's Code view.
  ipcMain.handle("lykn:artifact-code", async (_e, { url } = {}) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && !/^lykn-artifact:\/\//i.test(u)) {
      return { ok: false, error: "bad_url" };
    }
    try {
      let html = "";
      if (/^lykn-artifact:\/\//i.test(u)) {
        const key = new URL(u).hostname.replace(/\/$/, "");
        html = artifactHtmlCache.get(key) || "";
        if (!html) return { ok: false, error: "expired" };
      } else {
        const res = await fetchOverlayMedia(u);
        if (!res || !res.ok) return { ok: false, error: `http_${res?.status || 0}` };
        html = await res.text();
      }
      const code = await extractReactArtifactCodeFromHtml(html);
      if (!code) return { ok: false, error: "no_source_block" };
      return { ok: true, code };
    } catch (err) {
      return { ok: false, error: err?.message || "fetch_failed" };
    }
  });

  // Seed Build-mode refine from a vault/generated artifact URL (Edit button).
  ipcMain.handle("lykn:seed-artifact-from-url", async (_e, { url, title } = {}) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && !/^lykn-artifact:\/\//i.test(u)) {
      return { ok: false, error: "bad_url" };
    }
    try {
      const code = await extractReactArtifactCodeFromResult({
        file_url: u,
        title: String(title || "Artifact"),
      });
      if (!code || !String(code).trim()) {
        return { ok: false, error: "no_source_block" };
      }
      d.lastOverlayReactArtifact = {
        toolName: "lykn_build_react_artifact",
        title: String(title || "Artifact").replace(/\s+/g, " ").trim() || "Artifact",
        code: String(code),
      };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || "seed_failed" };
    }
  });

  // Fetch an image (or any allowlisted media URL) as a data URL for Image mode.
  ipcMain.handle("lykn:fetch-as-data-url", async (_e, { url } = {}) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) {
      return { ok: false, error: "bad_url" };
    }
    if (/^data:image\//i.test(u)) return { ok: true, dataUrl: u };
    try {
      const res = await safeFetchMain(u);
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, error: "empty" };
      const mime =
        (res.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
      if (!/^image\//i.test(mime)) return { ok: false, error: "not_image" };
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
    } catch (err) {
      return { ok: false, error: err?.message || "fetch_failed" };
    }
  });

  // Cluely-style suggestions after an answer: follow-up questions + real source
  // links looked up on the web. Best-effort: returns empty on any failure.
  // Browser control for the ⌘L overlay — scan interactables + plan/execute via
  // AppleScript JavaScript in the user's active browser tab.
  ipcMain.handle("lykn:browser-capability", async () => {
    // Click/type control still needs Apple Events (macOS). Page *reading* works
    // on Windows via the Chrome Live Feed extension.
    if (!IS_MAC) {
      const target = await getActiveBrowserTarget();
      const connected = !!d.extensionBridge?.isConnected?.();
      if (target?.url) {
        return {
          ok: false,
          error: "control_mac_only",
          browser: target.appName,
          url: target.url,
          title: target.title || "",
          reading: true,
          message:
            "LYKN can read this tab via Chrome Live Feed. Clicking and typing in the browser is macOS-only for now — ask about what's on screen instead.",
        };
      }
      return {
        ok: false,
        error: connected ? "no_browser" : "needs_extension",
        message: connected
          ? "Open an https:// page in Chrome/Edge, then try again."
          : "Install Chrome Live Feed (d.tray → Open LYKN, or the Live Feed button) so LYKN can read your active tab. Browser click-control is macOS-only for now.",
      };
    }
    const target = await getActiveBrowserTarget();
    if (!target) {
      return { ok: false, error: "no_browser", message: "Open a browser tab first." };
    }
    const probe = await collectBrowserInteractables(runOsascript, target.appName);
    if (probe.error === "apple_events_disabled") {
      return {
        ok: false,
        error: "apple_events_disabled",
        browser: target.appName,
        url: target.url,
        message: "Enable “Allow JavaScript from Apple Events” in your browser.",
      };
    }
    if (probe.error) {
      return {
        ok: false,
        error: probe.error,
        browser: target.appName,
        url: target.url,
        message: probe.message || "Could not read the page.",
      };
    }
    return {
      ok: true,
      browser: target.appName,
      url: probe.page?.url || target.url,
      title: probe.page?.title || "",
      elementCount: Array.isArray(probe.page?.items) ? probe.page.items.length : 0,
    };
  });

  ipcMain.handle("lykn:browser-plan", async (_e, { intent, conversationHistory } = {}) => {
    const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
    if (!IS_MAC) {
      return fail("control_mac_only", {
        message:
          "Browser click-control is macOS-only for now. Install Chrome Live Feed to let LYKN read your tab, or ask about what's on your screen.",
      });
    }
    const goal = String(intent || "").trim().slice(0, 500);
    if (!goal) return fail("no_intent");
    const target = await getActiveBrowserTarget();
    if (!target) {
      const hint = await describeBrowserTabProblem();
      return fail(hint?.error || "no_browser", {
        message: hint?.message || "Open an https:// page in your browser, then try again.",
      });
    }
    const collected = await collectBrowserInteractables(runOsascript, target.appName);
    if (collected.error === "apple_events_disabled") {
      return fail("apple_events_disabled", {
        browser: target.appName,
        url: target.url,
        message: "Enable “Allow JavaScript from Apple Events” in your browser.",
      });
    }
    if (collected.error || !collected.page) {
      return fail(collected.error || "scan_failed", {
        browser: target.appName,
        url: target.url,
        message: collected.message || "Could not scan the page.",
      });
    }
    const token = await getAuthToken();
    if (!token) return fail("no_auth", { message: "Sign in to LYKN to use browser control." });
    const pageCtx = await collectBrowserPageContext(runOsascript, target.appName);
    let pageText = String(pageCtx?.text || "");
    try {
      const live = await getBrowserPageText(target.appName);
      if (live && live.length > pageText.length) pageText = live;
    } catch (_) {}
    const imageUrl = await captureBrowserScreenThumbnail();
    try {
      const res = await fetch(`${API_BASE}/api/desktop/browser-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          intent: goal,
          url: collected.page.url || target.url,
          title: collected.page.title || "",
          pageText: pageText.slice(0, 15000),
          imageUrl: imageUrl || "",
          items: (collected.page.items || []).slice(0, 130),
          conversationHistory: Array.isArray(conversationHistory) ? conversationHistory.slice(-8) : [],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        return fail("plan_failed", { message: (data && data.error) || "Could not plan actions." });
      }
      const actions = resolvePlanActions(data.actions, collected.page.items || []);
      const explanation =
        String(data.explanation || "").trim() ||
        (actions.length
          ? ""
          : "Click Run once. LYKN will read the page, act step by step, and verify as it goes.");
      return {
        ok: true,
        browser: target.appName,
        appName: target.appName,
        url: collected.page.url || target.url,
        title: collected.page.title || "",
        explanation,
        taskPlan: String(data.taskPlan || "").trim(),
        plannedAnswer: String(data.plannedAnswer || "").trim(),
        actions,
        agentMode: data.agentMode || "",
        holoMessages: data.holoMessages || null,
      };
    } catch (e) {
      return fail("plan_failed", { message: e && e.message ? e.message : "Could not plan actions." });
    }
  });

  ipcMain.handle("lykn:browser-execute", async (event, { actions, appName, url, intent, taskPlan, conversationHistory, holoMessages: seedHoloMessages } = {}) => {
    const sendProgress = (status) => {
      try {
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send("lykn:browser-progress", { status: String(status || "") });
        }
      } catch (_) {}
    };
    if (d.browserExecuteInFlight) {
      return {
        ok: false,
        error: "busy",
        results: [],
        message: "Browser control is already running. Wait for it to finish.",
      };
    }
    if (!IS_MAC) {
      return {
        ok: false,
        error: "control_mac_only",
        results: [],
        message:
          "Browser click-control is macOS-only for now. LYKN can still read your tab via Chrome Live Feed — ask about the page instead.",
      };
    }
    const browser = String(appName || "").trim();
    if (!browser) {
      return {
        ok: false,
        error: "no_browser",
        results: [],
        message: "Missing browser name. Plan again from Control this page.",
      };
    }
    // Hard allowlist: `browser` is interpolated verbatim into AppleScript
    // (`tell application "<browser>" …`), so a renderer-supplied name containing
    // quotes/newlines could break out and run arbitrary osascript. Only exact
    // matches from our own detected-browser list are ever allowed.
    if (!d.BROWSER_APP_NAMES.includes(browser)) {
      return {
        ok: false,
        error: "unsupported_browser",
        results: [],
        message: "Unsupported browser. Plan again from Control this page.",
      };
    }
    const pageUrl = String(url || "").trim();
    const goal = String(intent || "").trim();

    if (goal) {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        await withPermissionPrompt("accessibility", async () => {
          systemPreferences.isTrustedAccessibilityClient(true);
        });
      }
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        return {
          ok: false,
          error: "accessibility_required",
          results: [],
          message:
            "Browser clicks need Accessibility. Open System Settings → Privacy & Security → Accessibility, enable LYKN (or Electron when developing), then quit and reopen the app.",
        };
      }
    }

    d.browserExecuteInFlight = true;
    const hadOverlay =
      d.overlayWindow && !d.overlayWindow.isDestroyed() && d.overlayWindow.isVisible();
    if (hadOverlay) setOverlayClickThrough(true);
    await new Promise((r) => setTimeout(r, 200));

    let holoMessages = Array.isArray(seedHoloMessages) && seedHoloMessages.length ? seedHoloMessages : null;
    let lastScreenBrief = "";
    let lastAgentResult = "";

    async function callPlanNext(body) {
      const token = await getAuthToken();
      if (!token) return { error: "no_auth", message: "Sign in to LYKN to use browser control." };

      let pageText = String(body.pageText || "");
      if (!pageText) {
        const ctx = await collectBrowserPageContext(runOsascript, browser);
        if (ctx?.text) {
          pageText = ctx.text;
        } else {
          const live = await getBrowserPageText(browser);
          pageText = String(live || "");
        }
      } else {
        try {
          const live = await getBrowserPageText(browser);
          if (live && live.length > pageText.length) pageText = live;
        } catch (_) {}
      }

      const payload = {
        intent: String(body.intent || ""),
        url: String(body.url || ""),
        title: String(body.title || ""),
        pageText: pageText.slice(0, 15000),
        imageUrl: String(body.imageUrl || ""),
        items: Array.isArray(body.items) ? body.items : [],
        completedSteps: Array.isArray(body.completedSteps) ? body.completedSteps : [],
        stuckHint: String(body.stuckHint || "").slice(0, 500),
        taskPlan: String(body.taskPlan || "").slice(0, 2000),
        lastReasoning: String(body.lastReasoning || "").slice(0, 800),
        lastActionDiff: String(body.lastActionDiff || "").slice(0, 400),
        sessionSummary: String(body.sessionSummary || "").slice(0, 1200),
        conversationHistory: Array.isArray(body.conversationHistory) ? body.conversationHistory.slice(-8) : [],
      };

      if (holoMessages) payload.holoMessages = holoMessages;
      if (body.toolName) {
        payload.toolName = String(body.toolName);
        payload.toolOutput = body.toolOutput != null ? String(body.toolOutput).slice(0, 2000) : "ok";
      }

      if (userWantsSearchOrType(payload.intent) && !payload.stuckHint) {
        const query = payload.intent
          .replace(/^search( for| up)?\s*/i, "")
          .replace(/^look up\s*/i, "")
          .trim();
        payload.searchHint = query.slice(0, 120);
      }

      let res = await fetch(`${API_BASE}/api/desktop/browser-plan-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        const hint =
          res.status === 404
            ? "Restart npm run server (or dev:overlay). API route missing."
            : "";
        return {
          error: "plan_failed",
          message: (data && data.error) || hint || `Could not plan next step (HTTP ${res.status}).`,
        };
      }

      if (Array.isArray(data.holoMessages)) holoMessages = data.holoMessages;
      if (data.screenBrief) lastScreenBrief = String(data.screenBrief);
      if (data.agentResult) lastAgentResult = String(data.agentResult);
      else if (data.done && data.explanation) lastAgentResult = String(data.explanation);

      let actions = resolvePlanActions(data.actions, payload.items);
      // Server may return raw DOM ordinal clicks with id+selector — ensure id resolves.
      if (!actions.length && Array.isArray(data.actions) && data.actions[0]?.selector) {
        actions = data.actions.slice(0, 1);
      }
      if (!(actions[0]?.type === "type" && actions[1]?.type === "press")) {
        actions = actions.slice(0, 1);
      } else {
        actions = actions.slice(0, 2);
      }

      // Planner returned prose but no executable action — retry only for non-MCQ flows.
      if (!actions.length && !data.done && !data.planFailed && data.agentMode !== "holo") {
        const stuckHint = userWantsSearchOrType(payload.intent)
          ? `User wants to search: "${payload.searchHint || payload.intent}". TYPE the query into the search field, then press Enter. Do not click unrelated navigation.`
          : "Your last response had no actions. Think like chat advice, then return exactly one click or type action from ELEMENTS.";
        const retryRes = await fetch(`${API_BASE}/api/desktop/browser-plan-next`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            ...payload,
            stuckHint,
            forceAction: true,
          }),
        });
        const retryData = await retryRes.json().catch(() => null);
        if (retryRes.ok && retryData) {
          data.done = retryData.done;
          data.explanation = retryData.explanation || data.explanation;
          data.reasoning = retryData.reasoning || data.reasoning;
          data.taskPlan = retryData.taskPlan || data.taskPlan;
          data.actions = retryData.actions;
          data.solved = retryData.solved ?? data.solved;
          data.actionKind = retryData.actionKind || data.actionKind;
          data.planFailed = retryData.planFailed ?? data.planFailed;
          actions = resolvePlanActions(retryData.actions, payload.items);
          if (!(actions[0]?.type === "type" && actions[1]?.type === "press")) {
            actions = actions.slice(0, 1);
          } else {
            actions = actions.slice(0, 2);
          }
        }
      }

      // Never infer done from "no actions" — only trust an explicit done flag.
      // Empty actions after some steps usually means the planner stalled, not finished.
      const done = typeof data.done === "boolean" ? data.done : false;

      return {
        done,
        explanation: String(data.explanation || "").trim(),
        reasoning: String(data.reasoning || "").trim(),
        taskPlan: String(data.taskPlan || payload.taskPlan || "").trim(),
        actions,
        screenBrief: String(data.screenBrief || lastScreenBrief || "").trim(),
        agentResult: String(data.agentResult || "").trim(),
        planFailed:
          data.planFailed
            ? String(data.explanation || "").trim() || "Planning failed. Could not determine the next step."
            : !done && !actions.length
              ? String(data.explanation || "").trim() || "Planner returned no action"
              : "",
      };
    }

    try {
      const initialTaskPlan = String(taskPlan || "").slice(0, 2000);
      const convHistory = Array.isArray(conversationHistory) ? conversationHistory.slice(-8) : [];

      // Dynamic pages: re-scan, verify, and replan after each action.
      if (goal) {
        const out = await executeAdaptiveBrowserTask(
          runOsascript,
          (payload) =>
            callPlanNext({
              ...payload,
              conversationHistory: convHistory,
              taskPlan: payload.taskPlan || initialTaskPlan,
            }),
          browser,
          goal,
          pageUrl,
          {
            maxRounds: undefined,
            onProgress: sendProgress,
            captureScreen: captureBrowserScreenThumbnail,
            initialTaskPlan,
            conversationHistory: convHistory,
          },
        );
        const failed = out.results.find((r) => !r.ok);
        const taskOk = out.done && !failed;
        let message = failed
          ? `Stopped at “${failed.label || "step"}”: ${failed.error || "failed"}`
          : out.done
            ? out.explanation || "Done. Task completed in your browser."
            : out.message || "Stopped before the task finished.";

        try {
          const token = await getAuthToken();
          if (token) {
            const reportRes = await fetch(`${API_BASE}/api/desktop/browser-report`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                intent: goal,
                ok: taskOk,
                url: pageUrl,
                title: "",
                screenBrief: lastScreenBrief,
                agentResult: lastAgentResult || out.explanation || "",
                completedSteps: out.completed || [],
                conversationHistory: convHistory,
              }),
            });
            const reportData = await reportRes.json().catch(() => null);
            if (reportRes.ok && reportData?.message) {
              message = String(reportData.message).trim();
            }
          }
        } catch (_) {
          /* keep fallback message */
        }

        return {
          ok: taskOk,
          adaptive: true,
          results: out.results,
          rounds: out.completed?.length || out.results.length,
          message,
          explanation: out.explanation || "",
        };
      }

      const steps = Array.isArray(actions)
        ? actions
            .filter((a) => a && typeof a === "object" && a.type)
            .slice(0, 8)
            .map((a) => ({
              type: String(a.type || "").toLowerCase(),
              selector: String(a.selector || ""),
              label: String(a.label || a.selector || "step"),
              value: a.value != null ? String(a.value) : undefined,
              key: a.key != null ? String(a.key) : undefined,
              delta: a.delta != null ? Number(a.delta) : undefined,
            }))
        : [];
      if (!steps.length) {
        console.log("[browser-execute] no steps — raw actions:", actions);
        return {
          ok: false,
          error: "no_actions",
          results: [],
          message: "No actions reached the browser. Close and re-open Control this page, then Run again.",
        };
      }
      const results = await executeBrowserActions(runOsascript, browser, steps, { pageUrl });
      const failed = results.find((r) => !r.ok);
      return {
        ok: !failed,
        results,
        message: failed
          ? `Stopped at “${failed.label || "step"}”: ${failed.error || "failed"}`
          : "Done.",
      };
    } catch (e) {
      console.log("[browser-execute] error:", e && e.message ? e.message : e);
      return {
        ok: false,
        error: "execute_failed",
        results: [],
        message: e && e.message ? e.message : "Failed to run browser actions.",
      };
    } finally {
      d.browserExecuteInFlight = false;
      if (hadOverlay && d.overlayWindow && !d.overlayWindow.isDestroyed()) {
        setOverlayClickThrough(false);
        d.overlayWindow.moveTop();
      }
    }
  });

  ipcMain.handle("lykn:suggest", async (_e, { question, answer, mode } = {}) => {
    const empty = { followups: [], links: [] };
    try {
      const token = await getAuthToken();
      if (!token) return empty;
      const res = await fetch(`${API_BASE}/api/ai/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          question: String(question || ""),
          answer: String(answer || ""),
          mode: String(mode || ""),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return empty;
      return {
        followups: Array.isArray(data.followups) ? data.followups : [],
        links: Array.isArray(data.links) ? data.links : [],
      };
    } catch (_) {
      return empty;
    }
  });

  // Rolling meeting notes (summary + key points + action items) from the live
  // transcript. Best-effort: returns empty notes on any failure.
  ipcMain.handle("lykn:meeting-notes", async (_e, { transcript, previousNotes } = {}) => {
    const empty = {
      summary: "",
      keyPoints: [],
      actionItems: [],
      questionsToAsk: [],
      suggestions: [],
      topics: [],
    };
    const t = String(transcript || "").trim();
    if (t.length < 40) return empty;
    try {
      const token = await getAuthToken();
      if (!token) return empty;
      const res = await fetch(`${API_BASE}/api/ai/meeting-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: t, previousNotes: previousNotes || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return empty;
      return {
        summary: String(data.summary || "").trim(),
        keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [],
        actionItems: Array.isArray(data.actionItems) ? data.actionItems : [],
        questionsToAsk: Array.isArray(data.questionsToAsk) ? data.questionsToAsk : [],
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
        topics: Array.isArray(data.topics) ? data.topics : [],
      };
    } catch (_) {
      return empty;
    }
  });
}

module.exports = { registerOverlayIpc };
