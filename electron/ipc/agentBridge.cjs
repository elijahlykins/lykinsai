"use strict";

const { bindOverlayIpcContext } = require("./overlayIpcContext.cjs");

function registerAgentBridgeIpc(d) {
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
    ipcMain.handle("lykn:studio-bar-send", async (_e, { text, attachments, agentId, fromSuggestion, bot, task } = {}) => {
      const rt = runtime();
      try {
        if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
      } catch (_) {}
      // Route to the agent the rail currently has selected, falling back to the
      // runtime's active agent. With no target at all, the runtime creates a
      // fresh agent (and its paired tab) for the prompt.
      const target = String(agentId || "").trim() || rt.getActiveId?.() || "";
      return rt.send(target, {
        text,
        attachments,
        fromSuggestion: !!fromSuggestion,
        bot: bot || null,
        task: task || null,
      });
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
}

module.exports = { registerAgentBridgeIpc };
