"use strict";

const { bindOverlayIpcContext } = require("./overlayIpcContext.cjs");

function registerLocalFilesIpc(d) {
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
}

module.exports = { registerLocalFilesIpc };
