"use strict";

const { bindOverlayIpcContext } = require("./overlayIpcContext.cjs");
const { isTrustedLyknIpcSender, trustedLyknIpcOpts } = require("../trustedIpcSender.cjs");

function registerOverlayAiIpc(d) {
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
              out.push({ kind: "text", name, text: "(Unsupported file type, not included.)" });
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
    ipcMain.handle("lykn:voice-signed-url", async (_e, { instructions, timezone, desktop, localMode } = {}) => {
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
            desktop: desktop !== false,
            localMode: localMode === true,
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
    ipcMain.on("lykn:open-url", (e, payload) => {
      if (!isTrustedLyknIpcSender(e, trustedLyknIpcOpts({ app, path, appOrigin: APP_ORIGIN, appUrl: APP_URL }))) return;
      // Accept legacy string payloads and { url, title, chatId } from newer callers.
      const url =
        typeof payload === "string"
          ? payload
          : String(payload?.url || "");
      const title =
        typeof payload === "object" && payload
          ? String(payload.title || "")
          : "";
      const sourceChatId =
        typeof payload === "object" && payload
          ? String(payload.chatId || "").trim()
          : "";
      void openUrlPreferAgentBrowser(url, {
        title,
        ...(sourceChatId ? { sourceChatId } : {}),
      });
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
              "LYKN can read this tab via Chrome Live Feed. Clicking and typing in the browser is macOS-only for now. Ask about what's on screen instead.",
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
            "Browser click-control is macOS-only for now. LYKN can still read your tab via Chrome Live Feed. Ask about the page instead.",
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

module.exports = { registerOverlayAiIpc };
