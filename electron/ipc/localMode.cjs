"use strict";

const { bindOverlayIpcContext } = require("./overlayIpcContext.cjs");
const { untrustedSenderResult, trustedLyknIpcOpts } = require("../trustedIpcSender.cjs");

function registerLocalModeIpc(d) {
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

    const senderOpts = trustedLyknIpcOpts({ app, path, appOrigin: APP_ORIGIN, appUrl: APP_URL });

    ipcMain.handle("lykn:local-mode-get", () => {
      const { enabled, syncAll, syncedFolders } = localSystem.readLocalMode(app.getPath("userData"));
      return { ok: true, enabled, syncAll, syncedFolders };
    });
    ipcMain.handle("lykn:local-mode-set", (e, { enabled } = {}) => {
      const denied = untrustedSenderResult(e, senderOpts);
      if (denied) return denied;
      const next = localSystem.writeLocalMode(app.getPath("userData"), !!enabled);
      // Every window (main app, Studio, overlay) should see the flip immediately.
      broadcastToAllWindows("lykn:local-mode-changed", { enabled: next.enabled });
      return { ok: true, enabled: next.enabled };
    });
    ipcMain.handle("lykn:local-tool-run", async (e, { name, args, approvalToken } = {}) => {
      const denied = untrustedSenderResult(e, senderOpts);
      if (denied) return denied;
      const { enabled } = localSystem.readLocalMode(app.getPath("userData"));
      if (!enabled) {
        return { ok: false, error: "Local mode is off. Enable it in the Vault first." };
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
  
    ipcMain.handle("lykn:store-run", async (e, { op, args } = {}) => {
      const denied = untrustedSenderResult(e, senderOpts);
      if (denied) return denied;
      return localStore.run(String(op || ""), args || {});
    });
}

module.exports = { registerLocalModeIpc };
