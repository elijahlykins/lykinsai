"use strict";

const { bindOverlayIpcContext } = require("./overlayIpcContext.cjs");

function registerAppsIpc(d) {
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
}

module.exports = { registerAppsIpc };
