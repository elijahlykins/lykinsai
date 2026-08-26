// Preload bridge for the LYKN desktop shell.
//
// v1 exposes only a tiny, read-only surface so the web app can tell it's
// running inside the native shell (e.g. to show a "Download" CTA differently,
// or enable desktop-only affordances later).
//
// TODO(jarvis): this is where the screen-capture / overlay IPC will be exposed
// to the renderer, e.g. window.lykn.captureScreen() → returns a data URL that
// the existing OCR/vision pipeline can consume. Keep the surface minimal and
// explicit — never expose ipcRenderer directly.

const { contextBridge, ipcRenderer } = require("electron");

// app.getVersion() via sync IPC: process.env.npm_package_version only exists
// when launched through npm, so it was always null in the packaged app.
let appVersion = null;
try {
  appVersion = ipcRenderer.sendSync("lykn:get-version") || null;
} catch {
  appVersion = null;
}

// Google sign-in hand-off: the OAuth round-trip happens in the user's real
// browser (Google blocks embedded browsers), which deep-links the Supabase
// session back via lykn://auth. Main forwards the tokens here; buffer them in
// the preload so a token that arrives before the web app registers its
// listener (React mounts after did-finish-load) is not dropped.
let pendingAuthTokens = null;
let authTokensCallback = null;
ipcRenderer.on("lykn:auth-tokens", (_event, tokens) => {
  if (authTokensCallback) authTokensCallback(tokens);
  else pendingAuthTokens = tokens;
});

// Overlay / voice project writes happen in another window. Main forwards them
// here so /projects + Synthesis can reuse the same CustomEvent live-sync path.
ipcRenderer.on("lykn:projects-changed", (_event, detail) => {
  try {
    window.dispatchEvent(
      new CustomEvent("lykn:projects-changed", {
        detail: detail && typeof detail === "object" ? detail : {},
      }),
    );
  } catch {
    /* renderer may not be ready */
  }
});

// Intel-Mac GPUs render CSS backdrop-filter as transparent holes (Chromium
// IOSurface compositor bug — see GLASS_FALLBACK in main.cjs). The web app
// reads this flag at boot and swaps liquid glass for a near-opaque tint
// (html.lykn-glass-fallback). LYKN_GLASS_FALLBACK=1|0 forces it for testing.
let glassFallback = process.platform === "darwin" && process.arch === "x64";
try {
  if (process.env.LYKN_GLASS_FALLBACK != null) {
    glassFallback = process.env.LYKN_GLASS_FALLBACK === "1";
  }
} catch {
  /* sandboxed env unavailable — keep the arch-based default */
}

contextBridge.exposeInMainWorld("lykn", {
  desktop: true,
  platform: process.platform,
  glassFallback,
  version: appVersion,
  // Open a URL in the user's default browser (main validates http/https).
  // Needed for the browser-based Google sign-in: a plain window.open() to our
  // own origin would stay inside the shell window.
  openExternal: (url, title) =>
    ipcRenderer.send("lykn:open-url", { url: String(url || ""), title }),
  // Native macOS sharing-services menu, anchored to the renderer button.
  nativeShare: (payload = {}) =>
    ipcRenderer.invoke("lykn:native-share", {
      title: String(payload.title || ""),
      text: String(payload.text || ""),
      url: String(payload.url || ""),
      // Share the asset itself (AirDrop, Photos, Mail attachment) instead of
      // a signed link, for anything that is really a file.
      asFile: !!payload.asFile,
      filename: String(payload.filename || ""),
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
    }),
  // LYKN Glass — the always-on-top ⌘/Ctrl+L chat overlay. Same path as the
  // global hotkey: summon the bar and focus its composer for typing.
  openGlass: () => ipcRenderer.send("lykn:show-overlay"),
  // LYKN Studio: the liquid-glass workspace window (loads /studio). Open from
  // the main app's sidebar; close from the Studio UI's own chrome.
  openStudio: () => ipcRenderer.send("lykn:studio-set", { open: true }),
  closeStudio: () => ipcRenderer.send("lykn:studio-set", { open: false }),
  // Studio fullscreen — Studio is frameless, so its own top-bar button drives
  // this; state events keep the button in sync with menu/OS transitions.
  setStudioFullscreen: (fullscreen) =>
    ipcRenderer.send("lykn:studio-fullscreen-set", { fullscreen: !!fullscreen }),
  minimizeStudio: () => ipcRenderer.send("lykn:studio-minimize"),
  getStudioFullscreen: () => ipcRenderer.invoke("lykn:studio-fullscreen-get"),
  onStudioFullscreen: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:studio-fullscreen", fn);
    return () => ipcRenderer.removeListener("lykn:studio-fullscreen", fn);
  },
  // Raise the agent browser (stage) window — used by Studio's Browser nav item.
  openAgentBrowser: () => ipcRenderer.send("lykn:agent-stage-set", { open: true }),
  // Dock/undock the agent browser inside the Studio window. `bounds` is the
  // Studio panel rect (window-relative CSS px) where the browser should sit.
  setStudioBrowser: (payload) =>
    ipcRenderer.send("lykn:studio-browser-set", payload || { open: false }),
  // Called as the Browser window starts opening, so the first tab can load
  // while the frame animates instead of after it has settled.
  warmStudioBrowser: () => ipcRenderer.send("lykn:studio-browser-warm"),
  // Red traffic light on the Browser window: retire every tab and agent.
  // Yellow minimize only parks the views via setStudioBrowser({ open: false }).
  closeStudioBrowser: () => ipcRenderer.invoke("lykn:studio-browser-close"),
  // A still picture of the docked browser (tab strip + page, captured
  // separately). The Browser window's open/close motion plays over this,
  // because CSS can move a native view but cannot scale or fade one.
  onStudioBrowserShot: (cb) => {
    const fn = (_e, p) => cb(p || null);
    ipcRenderer.on("lykn:studio-browser-shot", fn);
    return () => ipcRenderer.removeListener("lykn:studio-browser-shot", fn);
  },
  // Open a URL as a tab in the Studio's own browser (artifact "Open" etc.).
  // Optional opts.chatId binds that tab to the LyknChat that opened it so the
  // rail chat bar continues the same conversation.
  studioOpenUrl: (url, title, opts = {}) =>
    ipcRenderer.invoke("lykn:studio-open-url", {
      url: String(url || ""),
      title,
      chatId: opts?.chatId,
      attachChat: !!opts?.attachChat,
    }),
  // Open a chat artifact (URL and/or inline HTML) as a new agent tab.
  studioOpenArtifact: (payload) =>
    ipcRenderer.invoke("lykn:studio-open-artifact", payload || {}),
  // Main → Studio: switch to the Browser tab when a URL was opened in-app.
  // Prefer listening for the DOM event `lykn-studio-show-browser` (auto-forwarded
  // from this IPC below); this helper is for callers that want a direct cb.
  onStudioShowBrowser: (cb) => {
    const fn = (_e, p) => {
      try {
        cb?.(p || {});
      } catch (_) {}
    };
    ipcRenderer.on("lykn:studio-show-browser", fn);
    return () => ipcRenderer.removeListener("lykn:studio-show-browser", fn);
  },
  // Studio agent rail (beside the docked browser): drive + observe agents.
  studioAgentSend: (text, attachments, agentId, opts = {}) =>
    ipcRenderer.invoke("lykn:studio-bar-send", {
      text,
      attachments,
      agentId,
      fromSuggestion: !!opts?.fromSuggestion,
      // Bot dispatches carry the structured identity (name/role/persona) so
      // the harness system prompt holds it every turn — never parsed back
      // out of the message text.
      bot: opts?.bot || null,
      // Canonical Task input. The renderer supplies provenance and the raw
      // objective; Electron's TaskCompiler creates the authoritative Task.
      task: opts?.task || null,
    }),
  agentList: () => ipcRenderer.invoke("lykn:agent-list"),
  agentSwitch: (agentId) => ipcRenderer.invoke("lykn:agent-switch", agentId),
  agentStop: (agentId) => ipcRenderer.invoke("lykn:agent-stop", agentId),
  agentClose: (agentId) => ipcRenderer.invoke("lykn:agent-close", agentId),
  agentCreate: (payload) => ipcRenderer.invoke("lykn:agent-create", payload || {}),
  agentSetHeadless: (agentId, headless = true) =>
    ipcRenderer.invoke("lykn:agent-set-headless", { agentId, headless }),
  agentResetMain: () => ipcRenderer.invoke("lykn:agent-reset-main"),
  agentShowBrowser: (agentId) =>
    ipcRenderer.invoke("lykn:agent-show-browser", { agentId, visible: true }),
  agentShowStep: (agentId, stepIndex) =>
    ipcRenderer.invoke("lykn:agent-show-step", { agentId, stepIndex }),
  // Live screenshots of a Bot's hidden browser tab while it runs a
  // user-approved browser task — feeds the tiny viewport above the chat bar.
  onBotBrowserShot: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:bot-browser-shot", fn);
    return () => ipcRenderer.removeListener("lykn:bot-browser-shot", fn);
  },
  agentHistory: (agentId) => ipcRenderer.invoke("lykn:agent-history", agentId),
  // Use LYKN pill — open/close the agent chat side panel.
  agentChatSet: (payload) =>
    ipcRenderer.invoke("lykn:agent-chat-set", payload || {}),
  agentChatGet: () => ipcRenderer.invoke("lykn:agent-chat-get"),
  onAgentChatVisibility: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-chat-visibility", fn);
    return () => ipcRenderer.removeListener("lykn:agent-chat-visibility", fn);
  },
  // Traffic lights / title-bar drag from the docked browser's tab strip: it
  // draws its own title bar in a native view, above anything React can paint,
  // so its window controls arrive here instead of as DOM events.
  onStudioWindowControl: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:studio-window-control", fn);
    return () => ipcRenderer.removeListener("lykn:studio-window-control", fn);
  },
  // Studio browser history — closed tabs/agents (rail "History" section).
  agentBrowserHistoryList: () => ipcRenderer.invoke("lykn:agent-browser-history-list"),
  agentBrowserHistoryOpen: (entryId) =>
    ipcRenderer.invoke("lykn:agent-browser-history-open", { entryId }),
  agentBrowserHistoryRemove: (entryId) =>
    ipcRenderer.invoke("lykn:agent-browser-history-remove", { entryId }),
  onAgentBrowserHistory: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-browser-history", fn);
    return () => ipcRenderer.removeListener("lykn:agent-browser-history", fn);
  },
  pickFiles: () => ipcRenderer.invoke("lykn:pick-files"),
  // Native macOS Open panel, parented to the calling window — the same
  // selector a Mac app shows when the user wants to add files.
  pickOpenFiles: () => ipcRenderer.invoke("lykn:pick-open-files"),
  // Cluely-style follow-ups after an agent/answer finishes (same as Glass).
  suggest: (question, answer, opts = {}) =>
    ipcRenderer.invoke("lykn:suggest", { question, answer, ...opts }),
  onAgentList: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-list", fn);
    return () => ipcRenderer.removeListener("lykn:agent-list", fn);
  },
  // A parked run asks its question over "lykn:agent-choice" and waits on
  // resolveChoice. Without these two the main-process handler
  // ("lykn:agent-choice-resolve", main.cjs) is unreachable from Studio, so the
  // rail can show the question but never answer it.
  onAgentChoice: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-choice", fn);
    return () => ipcRenderer.removeListener("lykn:agent-choice", fn);
  },
  agentChoiceResolve: (agentId, choiceId, buttonId) =>
    ipcRenderer.invoke("lykn:agent-choice-resolve", { agentId, choiceId, buttonId }),
  onAgentProgress: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-progress", fn);
    return () => ipcRenderer.removeListener("lykn:agent-progress", fn);
  },
  onAgentSwitched: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-switched", fn);
    return () => ipcRenderer.removeListener("lykn:agent-switched", fn);
  },
  onAgentDelta: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-delta", fn);
    return () => ipcRenderer.removeListener("lykn:agent-delta", fn);
  },
  // Persistent "paused, waiting on you" state — outlives the finished turn.
  onAgentWaiting: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-waiting", fn);
    return () => ipcRenderer.removeListener("lykn:agent-waiting", fn);
  },
  onAgentDone: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-done", fn);
    return () => ipcRenderer.removeListener("lykn:agent-done", fn);
  },
  onTaskEvent: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:task-event", fn);
    return () => ipcRenderer.removeListener("lykn:task-event", fn);
  },
  // Bot Routines — durable schedules/monitors owned by main. The renderer
  // reads and edits definitions; execution stays in the task runtime.
  routinesList: (botId) => ipcRenderer.invoke("lykn:routines-list", botId ? { botId } : {}),
  routineCreate: (payload) => ipcRenderer.invoke("lykn:routine-create", payload || {}),
  routineUpdate: (routineId, patch) =>
    ipcRenderer.invoke("lykn:routine-update", { routineId, patch: patch || {} }),
  routineSetEnabled: (routineId, enabled) =>
    ipcRenderer.invoke("lykn:routine-set-enabled", { routineId, enabled: !!enabled }),
  routineDelete: (routineId) => ipcRenderer.invoke("lykn:routine-delete", { routineId }),
  routineRunNow: (routineId) => ipcRenderer.invoke("lykn:routine-run-now", { routineId }),
  routineRuns: (routineId, limit) =>
    ipcRenderer.invoke("lykn:routine-runs", { routineId, limit }),
  activitySnapshot: () => ipcRenderer.invoke("lykn:activity-snapshot", {}),
  taskStop: (taskId) => ipcRenderer.invoke("lykn:task-stop", { taskId }),
  onRoutinesChanged: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:routines-changed", fn);
    return () => ipcRenderer.removeListener("lykn:routines-changed", fn);
  },
  onActivityNotification: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:activity-notification", fn);
    return () => ipcRenderer.removeListener("lykn:activity-notification", fn);
  },
  onActivityOpen: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:activity-open", fn);
    return () => ipcRenderer.removeListener("lykn:activity-open", fn);
  },
  // Local Mode — Vault switch that grants LYKN file/terminal access on this
  // device. Tools execute in main (never in the renderer or on the server).
  localModeGet: () => ipcRenderer.invoke("lykn:local-mode-get"),
  localModeSet: (enabled) =>
    ipcRenderer.invoke("lykn:local-mode-set", { enabled: !!enabled }),
  onLocalModeChanged: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:local-mode-changed", fn);
    return () => ipcRenderer.removeListener("lykn:local-mode-changed", fn);
  },
  localToolRun: (name, args, opts = {}) =>
    ipcRenderer.invoke("lykn:local-tool-run", {
      name: String(name || ""),
      args: args || {},
      // Approval is a main-issued token, not a renderer-asserted boolean.
      approvalToken: typeof opts?.approvalToken === "string" ? opts.approvalToken : "",
    }),
  // Local store — the device-side home for vault items, chat threads,
  // artifacts, and the retrieval index. Every call resolves to
  // { ok: true, data } or { ok: false, error }; main never rejects, because a
  // rejected invoke loses its stack crossing the bridge.
  //
  // Namespaced rather than flattened onto window.lykn: the surface is wide and
  // grows with each phase of the local-first migration, and grouping keeps it
  // obvious which calls touch the user's own data.
  store: {
    run: (op, args = {}) =>
      ipcRenderer.invoke("lykn:store-run", { op: String(op || ""), args: args || {} }),

    // Items — vault notes, attachments, generated images, artifacts.
    putItem: (item) => ipcRenderer.invoke("lykn:store-run", { op: "item.put", args: { item } }),
    getItem: (id) => ipcRenderer.invoke("lykn:store-run", { op: "item.get", args: { id } }),
    getItems: (ids = []) =>
      ipcRenderer.invoke("lykn:store-run", { op: "item.getMany", args: { ids } }),
    updateItem: (id, patch, opts = {}) =>
      ipcRenderer.invoke("lykn:store-run", {
        op: "item.update",
        args: { id, patch, ifUpdatedAt: opts?.ifUpdatedAt || null },
      }),
    listItems: (args = {}) => ipcRenderer.invoke("lykn:store-run", { op: "item.list", args }),
    softDeleteItem: (id) =>
      ipcRenderer.invoke("lykn:store-run", { op: "item.softDelete", args: { id } }),
    restoreItem: (id) =>
      ipcRenderer.invoke("lykn:store-run", { op: "item.restore", args: { id } }),
    deleteItem: (id) => ipcRenderer.invoke("lykn:store-run", { op: "item.delete", args: { id } }),
    countItems: (args = {}) => ipcRenderer.invoke("lykn:store-run", { op: "item.count", args }),
    tagCounts: () => ipcRenderer.invoke("lykn:store-run", { op: "item.tagCounts", args: {} }),

    // Threads and messages — chat history and grid boards.
    putThread: (thread) =>
      ipcRenderer.invoke("lykn:store-run", { op: "thread.put", args: { thread } }),
    getThread: (id) => ipcRenderer.invoke("lykn:store-run", { op: "thread.get", args: { id } }),
    listThreads: (args = {}) => ipcRenderer.invoke("lykn:store-run", { op: "thread.list", args }),
    deleteThread: (id, opts = {}) =>
      ipcRenderer.invoke("lykn:store-run", {
        op: "thread.delete",
        args: { id, hard: opts?.hard === true },
      }),
    appendMessage: (threadId, message) =>
      ipcRenderer.invoke("lykn:store-run", { op: "message.append", args: { threadId, message } }),
    listMessages: (threadId, args = {}) =>
      ipcRenderer.invoke("lykn:store-run", { op: "message.list", args: { threadId, ...args } }),

    // Save + index in one call. Prefer this over putItem for anything the user
    // should be able to find later; putItem writes the row but leaves its
    // vectors to the next backfill.
    saveItem: (item) => ipcRenderer.invoke("lykn:store-run", { op: "item.save", args: { item } }),

    // Retrieval — FTS5 lexical, cosine semantic, and the fusion of the two.
    // `search` embeds the query on-device and degrades to lexical when the
    // model is unavailable, so callers never have to branch on it.
    search: (query, args = {}) =>
      ipcRenderer.invoke("lykn:store-run", { op: "search.local", args: { query, ...args } }),
    searchLexical: (query, args = {}) =>
      ipcRenderer.invoke("lykn:store-run", { op: "search.lexical", args: { query, ...args } }),
    searchMessages: (query, args = {}) =>
      ipcRenderer.invoke("lykn:store-run", { op: "search.messages", args: { query, ...args } }),
    putChunks: (sourceKind, sourceId, chunks, model) =>
      ipcRenderer.invoke("lykn:store-run", {
        op: "chunks.put",
        args: { sourceKind, sourceId, chunks, model },
      }),
    staleChunkSources: (model) =>
      ipcRenderer.invoke("lykn:store-run", { op: "chunks.stale", args: { model } }),

    // On-device embeddings. `embedStatus().data.runtimeAvailable` is false on
    // platforms with no ONNX Runtime build; search still works, lexically.
    embedStatus: () => ipcRenderer.invoke("lykn:store-run", { op: "embed.status", args: {} }),
    embedWarmup: () => ipcRenderer.invoke("lykn:store-run", { op: "embed.warmup", args: {} }),
    embedQuery: (text) =>
      ipcRenderer.invoke("lykn:store-run", { op: "embed.query", args: { text } }),

    // Indexing — one source at a time, or a resumable pass over everything.
    indexItem: (id, opts = {}) =>
      ipcRenderer.invoke("lykn:store-run", {
        op: "index.item",
        args: { id, force: opts?.force === true },
      }),
    indexThread: (id, opts = {}) =>
      ipcRenderer.invoke("lykn:store-run", {
        op: "index.thread",
        args: { id, force: opts?.force === true },
      }),
    indexPending: () => ipcRenderer.invoke("lykn:store-run", { op: "index.pending", args: {} }),

    // Chunked binary writes. Prefer these over `writeBlob` for anything that
    // could be large: a single-message write holds the whole file in memory on
    // both sides of the bridge at once.
    beginBlobWrite: (itemId, opts = {}) =>
      ipcRenderer.invoke("lykn:store-run", {
        op: "blob.beginWrite",
        args: { itemId, ...opts },
      }),
    appendBlobWrite: (token, data) =>
      ipcRenderer.invoke("lykn:store-run", { op: "blob.appendWrite", args: { token, data } }),
    finishBlobWrite: (token) =>
      ipcRenderer.invoke("lykn:store-run", { op: "blob.finishWrite", args: { token } }),
    abortBlobWrite: (token) =>
      ipcRenderer.invoke("lykn:store-run", { op: "blob.abortWrite", args: { token } }),

    // Migration from Supabase. The renderer owns the session, so it hands the
    // access token down; the main process only ever reads with it.
    importConfigure: ({ url, accessToken, apiKey, userId } = {}) =>
      ipcRenderer.invoke("lykn:store-run", {
        op: "import.configure",
        args: { url, accessToken, apiKey, userId },
      }),
    importPreflight: () =>
      ipcRenderer.invoke("lykn:store-run", { op: "import.preflight", args: {} }),
    importStart: (args = {}) => ipcRenderer.invoke("lykn:store-run", { op: "import.start", args }),
    importStatus: () => ipcRenderer.invoke("lykn:store-run", { op: "import.status", args: {} }),
    importCancel: () => ipcRenderer.invoke("lykn:store-run", { op: "import.cancel", args: {} }),
    importVerify: (args = {}) =>
      ipcRenderer.invoke("lykn:store-run", { op: "import.verify", args }),
    importReset: () => ipcRenderer.invoke("lykn:store-run", { op: "import.reset", args: {} }),
    indexBackfill: (args = {}) =>
      ipcRenderer.invoke("lykn:store-run", { op: "index.backfill", args }),
    indexStatus: () => ipcRenderer.invoke("lykn:store-run", { op: "index.status", args: {} }),
    indexCancel: () => ipcRenderer.invoke("lykn:store-run", { op: "index.cancel", args: {} }),

    // Binaries.
    writeBlob: (itemId, data, opts = {}) =>
      ipcRenderer.invoke("lykn:store-run", { op: "blob.write", args: { itemId, data, ...opts } }),
    readBlob: (path) => ipcRenderer.invoke("lykn:store-run", { op: "blob.read", args: { path } }),
    blobPath: (path) =>
      ipcRenderer.invoke("lykn:store-run", { op: "blob.absolutePath", args: { path } }),

    // Maintenance.
    stats: () => ipcRenderer.invoke("lykn:store-run", { op: "store.stats", args: {} }),
    snapshot: () => ipcRenderer.invoke("lykn:store-run", { op: "backup.snapshot", args: {} }),
    listSnapshots: () => ipcRenderer.invoke("lykn:store-run", { op: "backup.list", args: {} }),
  },

  // Apps LYKN built for the user, installed on this device.
  //
  // This surface manages apps from the outside — install, launch, uninstall,
  // review permissions. It is NOT how an app reaches its own data: that runs
  // over a separate channel only a lykn-app:// origin can reach, so nothing
  // here can be used to read one app's data from another.
  apps: {
    list: () => ipcRenderer.invoke("lykn:app-list"),
    install: (payload = {}) => ipcRenderer.invoke("lykn:app-install", payload),
    open: (id) => ipcRenderer.invoke("lykn:app-open", { id }),
    uninstall: (id) => ipcRenderer.invoke("lykn:app-uninstall", { id }),
    /** The user's own icon choice — a lucide name, or null for the default. */
    setIcon: (id, icon) => ipcRenderer.invoke("lykn:app-set-icon", { id, icon }),
    /** Recompile and load the app for real, returning anything that broke. */
    verify: (id) => ipcRenderer.invoke("lykn:app-verify", { id }),
    permissions: (id) => ipcRenderer.invoke("lykn:app-permissions", { id }),
    setPermission: (id, capability, allowed) =>
      ipcRenderer.invoke("lykn:app-set-permission", { id, capability, allowed }),

    // Files and versions, for an editor surface and for rollback.
    files: (id) => ipcRenderer.invoke("lykn:store-run", { op: "app.files.list", args: { id } }),
    versions: (id) => ipcRenderer.invoke("lykn:store-run", { op: "app.version.list", args: { id } }),
    rollback: (id, version) =>
      ipcRenderer.invoke("lykn:store-run", { op: "app.version.rollback", args: { id, version } }),
    stats: (id) => ipcRenderer.invoke("lykn:store-run", { op: "app.stats", args: { id } }),
    dataCollections: (id) =>
      ipcRenderer.invoke("lykn:store-run", { op: "app.data.collections", args: { id } }),
    clearData: (id, collection = null) =>
      ipcRenderer.invoke("lykn:store-run", { op: "app.data.clear", args: { id, collection } }),

    /** Fires when an app is installed or removed, in any window. */
    onChanged: (cb) => {
      const fn = (_e, p) => cb(p || {});
      ipcRenderer.on("lykn:apps-changed", fn);
      return () => ipcRenderer.removeListener("lykn:apps-changed", fn);
    },
  },
  // Sync with Mac — synced-folders allowlist that scopes Local Mode.
  macSyncGet: () => ipcRenderer.invoke("lykn:mac-sync-get"),
  macSyncSet: ({ syncAll, syncedFolders } = {}) =>
    ipcRenderer.invoke("lykn:mac-sync-set", { syncAll, syncedFolders }),
  // One folder's sync switch — the button on each Mac folder page in the Vault.
  macSyncSetFolder: ({ folder, synced } = {}) =>
    ipcRenderer.invoke("lykn:mac-sync-folder", { folder, synced: synced === true }),
  macSyncPickFolder: () => ipcRenderer.invoke("lykn:mac-sync-pick-folder"),
  onMacSyncChanged: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:mac-sync-changed", fn);
    return () => ipcRenderer.removeListener("lykn:mac-sync-changed", fn);
  },
  // Mac Files browser — list synced directories and open items natively.
  macFsList: (path) => ipcRenderer.invoke("lykn:mac-fs-list", { path }),
  macFsOpen: (path, opts = {}) =>
    ipcRenderer.invoke("lykn:mac-fs-open", { path, reveal: opts?.reveal === true }),
  macFsHome: () => ipcRenderer.invoke("lykn:mac-fs-home"),
  // Downloads land in the user's Downloads folder, not wherever Chromium's
  // settings happen to point.
  saveToDownloads: ({ name, bytes } = {}) =>
    ipcRenderer.invoke("lykn:save-to-downloads", { name, bytes }),
  // "Put this in a folder on my Mac" — the native save sheet picks the folder.
  saveFileAs: ({ name, bytes, filters } = {}) =>
    ipcRenderer.invoke("lykn:save-file-as", { name, bytes, filters }),
  // Files browser — the Vault's Locations sidebar. Browsing, editing, and a
  // per-folder watch so the view follows what actually happens on disk.
  files: {
    list: (args = {}) => ipcRenderer.invoke("lykn:files-list", args),
    // A QuickLook preview (PDF page, video frame, app icon) as a data URL.
    thumbnail: (path, size) => ipcRenderer.invoke("lykn:files-thumbnail", { path, size }),
    roots: () => ipcRenderer.invoke("lykn:files-roots"),
    mkdir: (args = {}) => ipcRenderer.invoke("lykn:files-mkdir", args),
    rename: (args = {}) => ipcRenderer.invoke("lykn:files-rename", args),
    move: (args = {}) => ipcRenderer.invoke("lykn:files-move", args),
    copy: (args = {}) => ipcRenderer.invoke("lykn:files-copy", args),
    duplicate: (args = {}) => ipcRenderer.invoke("lykn:files-duplicate", args),
    trash: (args = {}) => ipcRenderer.invoke("lykn:files-trash", args),
    watch: (path) => ipcRenderer.invoke("lykn:files-watch", { path }),
    unwatch: (path) => ipcRenderer.invoke("lykn:files-unwatch", { path }),
    onChanged: (cb) => {
      const fn = (_e, p) => cb(p || {});
      ipcRenderer.on("lykn:files-changed", fn);
      return () => ipcRenderer.removeListener("lykn:files-changed", fn);
    },
  },
  // Mac app dock — installed apps, launch, and running-state.
  macAppsList: () => ipcRenderer.invoke("lykn:mac-apps-list"),
  macAppLaunch: (path) => ipcRenderer.invoke("lykn:mac-app-launch", { path }),
  macAppQuit: (path) => ipcRenderer.invoke("lykn:mac-app-quit", { path }),
  macAppsRunning: () => ipcRenderer.invoke("lykn:mac-apps-running"),
  macAppsWatch: (on) => ipcRenderer.send("lykn:mac-apps-watch", { on: !!on }),
  macDockPinsGet: () => ipcRenderer.invoke("lykn:mac-dock-pins-get"),
  macDockPinsSet: (pins) => ipcRenderer.invoke("lykn:mac-dock-pins-set", { pins }),
  onMacAppsRunning: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:mac-apps-running-changed", fn);
    return () => ipcRenderer.removeListener("lykn:mac-apps-running-changed", fn);
  },
  // Studio background — the backdrop image synced from the Mac (welcome flow
  // or settings). Data URLs; empty string means "no custom background".
  backgroundGet: () => ipcRenderer.invoke("lykn:background-get"),
  backgroundSet: (payload) => ipcRenderer.invoke("lykn:background-set", payload),
  backgroundPickFile: () => ipcRenderer.invoke("lykn:background-pick-file"),
  backgroundClear: () => ipcRenderer.invoke("lykn:background-clear"),
  // The wallpapers macOS ships. Listing is cheap (names only); thumbnails come
  // one at a time because each HEIC needs a sips pass, and applying one may
  // have to fetch the master from Apple — hence the progress channel.
  backgroundSystemList: () => ipcRenderer.invoke("lykn:background-system-list"),
  backgroundSystemThumb: (id) => ipcRenderer.invoke("lykn:background-system-thumb", id),
  backgroundSystemApply: (id) => ipcRenderer.invoke("lykn:background-system-apply", id),
  onBackgroundProgress: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:background-progress", fn);
    return () => ipcRenderer.removeListener("lykn:background-progress", fn);
  },
  onBackgroundChanged: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:background-changed", fn);
    return () => ipcRenderer.removeListener("lykn:background-changed", fn);
  },
  // Home desktop widgets picked in the welcome walkthrough. `stamp` tells the
  // studio whether these picks are newer than what it already applied.
  homeWidgetsGet: () => ipcRenderer.invoke("lykn:home-widgets-get"),
  onHomeWidgetsChanged: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:home-widgets-changed", fn);
    return () => ipcRenderer.removeListener("lykn:home-widgets-changed", fn);
  },
  // Design picks from the welcome walkthrough (theme, accent, response
  // length, chat inks). `stamp` tells the studio whether these are newer
  // than what it already applied.
  welcomeDesignGet: () => ipcRenderer.invoke("lykn:welcome-design-get"),
  onWelcomeDesignChanged: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:welcome-design-changed", fn);
    return () => ipcRenderer.removeListener("lykn:welcome-design-changed", fn);
  },
  // Microphone — macOS only shows the TCC prompt when the app asks for it from
  // the main process; Chromium's getUserMedia inside Electron silently fails
  // when the OS status is still not-determined. Dictation and Voice Mode call
  // ensureMic() first so the user gets the system "Allow" dialog (or Settings
  // when they previously denied) before we open a stream.
  micStatus: () => ipcRenderer.invoke("lykn:onboarding-mic-status"),
  ensureMic: () => ipcRenderer.invoke("lykn:ensure-mic"),
  openMicSettings: () => ipcRenderer.send("lykn:onboarding-open-mic-settings"),
  // Subscribe to deep-linked Supabase session tokens (see lykn://auth flow).
  onAuthTokens: (callback) => {
    authTokensCallback = typeof callback === "function" ? callback : null;
    if (authTokensCallback && pendingAuthTokens) {
      const tokens = pendingAuthTokens;
      pendingAuthTokens = null;
      authTokensCallback(tokens);
    }
  },
});

// Always forward main→Studio "show browser" into a DOM event so Studio.jsx
// (and any other listener) can switch to the Browser tab without an extra
// subscription. Harmless when Studio isn't mounted.
ipcRenderer.on("lykn:studio-show-browser", (_e, p) => {
  try {
    window.dispatchEvent(
      new CustomEvent("lykn-studio-show-browser", { detail: p || {} }),
    );
  } catch (_) {}
});
