"use strict";

function bindOverlayIpcContext(d) {

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
  const concealBotBrowserTab = (...a) => d.concealBotBrowserTab(...a);
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
  const artifactHtmlCache = d.artifactHtmlCache;
  const agentBrowserViews = d.agentBrowserViews;
  const agentBrowserMeta = d.agentBrowserMeta;
  const agentBrowserLabels = d.agentBrowserLabels;
  const tabChatProjection = (...a) =>
    d.tabChatProjection ? d.tabChatProjection(...a) : {};
  const applyTabSourceChatId = (...a) => d.applyTabSourceChatId?.(...a);
  const clearTabSourceChatIds = (...a) => d.clearTabSourceChatIds?.(...a);
  const {
    collectBrowserInteractables,
    collectBrowserPageContext,
    executeBrowserActions,
    executeAdaptiveBrowserTask,
    resolvePlanActions,
    userWantsSearchOrType,
  } = require("../browserAct.cjs");

  
  return {
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
    concealBotBrowserTab,
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
    tabChatProjection,
    applyTabSourceChatId,
    clearTabSourceChatIds,
    collectBrowserInteractables,
    collectBrowserPageContext,
    executeBrowserActions,
    executeAdaptiveBrowserTask,
    resolvePlanActions,
    userWantsSearchOrType,
  };
}

module.exports = { bindOverlayIpcContext };
