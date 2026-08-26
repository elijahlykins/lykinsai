"use strict";

const { bindOverlayIpcContext } = require("./overlayIpcContext.cjs");

function registerOverlayShellIpc(d) {
  const {
    app,
    BrowserWindow,
    WebContentsView,
    shell,
    globalShortcut,
    Menu,
    ipcMain,
    desktopCapturer,
    screen,
    systemPreferences,
    dialog,
    nativeImage,
    clipboard,
    Tray,
    session,
    Notification,
    powerMonitor,
    nativeTheme,
    protocol,
    electronNet,
    path,
    pathToFileURL,
    fs,
    fsSync,
    crypto,
    http,
    execFile,
    IS_MAC,
    IS_WIN,
    GLASS_FALLBACK,
    APP_URL,
    APP_ORIGIN,
    API_BASE,
    localStore,
    macFiles,
    chromeSync,
    localSystem,
    appDock,
    localApprovals,
    ownedBrowserAct,
    agentRecentVisits,
    broadcastToAllWindows,
    overlayConstants,
    OVERLAY_WIDTH,
    OVERLAY_MIN_HEIGHT,
    OVERLAY_BUBBLE,
    MENU_WIDTH,
    MENU_GAP,
    MENU_MIN_HEIGHT,
    MENU_MAX_HEIGHT,
    PICKER_WIDTH,
    PICKER_MIN_HEIGHT,
    PICKER_MAX_HEIGHT,
    addLiveWatchRule,
    afterStudioFullscreenExit,
    agentBrowserHomeSender,
    agentBrowserMainTabCount,
    agentStageUrlAllowed,
    agentStageVisible,
    applyContentProtection,
    attachmentsFromPickedPaths,
    broadcastStudioFullscreen,
    captureBrowserScreenThumbnail,
    captureInteractiveSnip,
    captureScreenDescription,
    clearLiveWatchRules,
    closeAgentFinishedPopup,
    closeStudioBrowserSession,
    commitAgentBrowserHistory,
    createMainWindow,
    describeBrowserTabProblem,
    destroyAgentBrowserWindow,
    emitAgentToUi,
    ensureAgentBrowserWindow,
    extractReactArtifactCodeFromHtml,
    extractReactArtifactCodeFromResult,
    fetchAppChatsForOverlay,
    fetchOverlayMedia,
    focusOverlayForTyping,
    getActiveAgentBrowserWebContents,
    getActiveBrowserTarget,
    getAgentBrowserWebContents,
    getAuthToken,
    getBrowserPageText,
    getLiveWatchStatus,
    healOverlayGeometry,
    hideAgentSidebarWindow,
    hideAllAgentBrowserWindows,
    hideLangPickerWindow,
    hideLiveWindow,
    hideMenuWindow,
    hideOverlay,
    hidePanelWindow,
    hidePickerWindow,
    hideStudioWindow,
    initAgentRuntime,
    isAgentArtifactTabId,
    isContentProtectionEnabled,
    layoutAgentStageViews,
    maybeNotifyProjectsChangedFromTool,
    microphoneStatus,
    normalizeSyncUrl,
    normalizeUrlForMatch,
    notifyStudioShowBrowser,
    omniboxToUrl,
    openAgentBrowserTabWithUrl,
    openAgentStageArtifact,
    openFreshStudioBrowserTab,
    openMicrophoneSettings,
    openStudioBrowserTabWithUrl,
    openUrlPreferAgentBrowser,
    overlaySessionPreview,
    overlaySessionTitle,
    overlayWorkArea,
    paintArtifactIntoAgentTab,
    parseWatchRuleIntent,
    persistAgentBrowserHistory,
    positionAgentSidebarWindow,
    positionLangPickerWindow,
    positionLiveWindow,
    positionMenuWindow,
    positionPanelWindow,
    positionPickerWindow,
    pushAgentBrowserHistory,
    pushAgentStageState,
    pushOverlaySessionToApp,
    raiseAgentBrowserHost,
    readAgentBrowserHistory,
    readOverlaySessionsStore,
    requestOmniboxFocusForTab,
    resetOverlayPositionToDefault,
    runOsascript,
    safeFetchMain,
    sanitizeHomeAttachments,
    saveHtmlToDownloads,
    sendLiveState,
    sendPanelState,
    setBrowsingContextFromHistory,
    setLiveWatchEnabled,
    setOverlayClickThrough,
    setOverlayCollapsed,
    setOverlaySize,
    setStudioBrowserEmbed,
    showAgentBrowserWindow,
    showAgentSidebarWindow,
    showLangPickerWindow,
    showLiveWindow,
    showMenuWindow,
    showOverlay,
    showPanelWindow,
    showPickerWindow,
    showStudioWindow,
    snapshotAgentBrowserHistory,
    stageNativeShareFile,
    streamScreenAnswer,
    studioFullscreenActive,
    studioStageEmbedActive,
    studioWindowRef,
    toggleAgentIncognito,
    uniqueDownloadPath,
    warmStudioBrowser,
    withOverlayHiddenForClick,
    withPermissionPrompt,
    writeOverlaySessionsStore,
    writeOverlaySettings,
    artifactHtmlCache,
    agentBrowserViews,
    agentBrowserMeta,
    agentBrowserLabels,
    collectBrowserInteractables,
    collectBrowserPageContext,
    executeBrowserActions,
    executeAdaptiveBrowserTask,
    resolvePlanActions,
    userWantsSearchOrType
  } = bindOverlayIpcContext(d);

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
}

module.exports = { registerOverlayShellIpc };
