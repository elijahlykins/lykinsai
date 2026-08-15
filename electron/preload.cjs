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

contextBridge.exposeInMainWorld("lykn", {
  desktop: true,
  platform: process.platform,
  version: appVersion,
  // Open a URL in the user's default browser (main validates http/https).
  // Needed for the browser-based Google sign-in: a plain window.open() to our
  // own origin would stay inside the shell window.
  openExternal: (url, title) =>
    ipcRenderer.send("lykn:open-url", { url: String(url || ""), title }),
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
  // A still picture of the docked browser (tab strip + page, captured
  // separately). The Browser window's open/close motion plays over this,
  // because CSS can move a native view but cannot scale or fade one.
  onStudioBrowserShot: (cb) => {
    const fn = (_e, p) => cb(p || null);
    ipcRenderer.on("lykn:studio-browser-shot", fn);
    return () => ipcRenderer.removeListener("lykn:studio-browser-shot", fn);
  },
  // Open a URL as a tab in the Studio's own browser (artifact "Open" etc.).
  studioOpenUrl: (url, title) =>
    ipcRenderer.invoke("lykn:studio-open-url", { url: String(url || ""), title }),
  // Open a chat artifact (URL and/or inline HTML) as a new agent tab.
  studioOpenArtifact: (payload) =>
    ipcRenderer.invoke("lykn:studio-open-artifact", payload || {}),
  // Main → Studio: switch to the Browser tab when a URL was opened in-app.
  // Prefer listening for the DOM event `lykn-studio-show-browser` (auto-forwarded
  // from this IPC below); this helper is for callers that want a direct cb.
  onStudioShowBrowser: (cb) => {
    const fn = () => {
      try {
        cb?.();
      } catch (_) {}
    };
    ipcRenderer.on("lykn:studio-show-browser", fn);
    return () => ipcRenderer.removeListener("lykn:studio-show-browser", fn);
  },
  // Ask main whether a chat prompt is really browser-agent work before the
  // chat surface spends a turn answering it as conversation.
  agentRouteCheck: (text) =>
    ipcRenderer.invoke("lykn:agent-route-check", { text }),
  // Studio agent rail (beside the docked browser): drive + observe agents.
  studioAgentSend: (text, attachments, agentId, opts = {}) =>
    ipcRenderer.invoke("lykn:studio-bar-send", {
      text,
      attachments,
      agentId,
      fromSuggestion: !!opts?.fromSuggestion,
    }),
  agentList: () => ipcRenderer.invoke("lykn:agent-list"),
  agentSwitch: (agentId) => ipcRenderer.invoke("lykn:agent-switch", agentId),
  agentClose: (agentId) => ipcRenderer.invoke("lykn:agent-close", agentId),
  agentCreate: (payload) => ipcRenderer.invoke("lykn:agent-create", payload || {}),
  agentResetMain: () => ipcRenderer.invoke("lykn:agent-reset-main"),
  agentShowBrowser: (agentId) =>
    ipcRenderer.invoke("lykn:agent-show-browser", { agentId, visible: true }),
  agentShowStep: (agentId, stepIndex) =>
    ipcRenderer.invoke("lykn:agent-show-step", { agentId, stepIndex }),
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
  // Cluely-style follow-ups after an agent/answer finishes (same as Glass).
  suggest: (question, answer, opts = {}) =>
    ipcRenderer.invoke("lykn:suggest", { question, answer, ...opts }),
  onAgentList: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-list", fn);
    return () => ipcRenderer.removeListener("lykn:agent-list", fn);
  },
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
      approved: opts?.approved === true,
    }),
  // Sync with Mac — synced-folders allowlist that scopes Local Mode.
  macSyncGet: () => ipcRenderer.invoke("lykn:mac-sync-get"),
  macSyncSet: ({ syncAll, syncedFolders } = {}) =>
    ipcRenderer.invoke("lykn:mac-sync-set", { syncAll, syncedFolders }),
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
  // Mac app dock — installed apps, launch, and running-state.
  macAppsList: () => ipcRenderer.invoke("lykn:mac-apps-list"),
  macAppLaunch: (path) => ipcRenderer.invoke("lykn:mac-app-launch", { path }),
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
  // Microphone — macOS only shows the TCC prompt when the app asks for it from
  // the main process; Chromium's getUserMedia inside Electron silently fails
  // when the OS status is still not-determined. Dictation and Voice Mode call
  // ensureMic() first so the user gets the system "Allow" dialog (or Settings
  // when they previously denied) before we open a stream.
  micStatus: () => ipcRenderer.invoke("lykn:onboarding-mic-status"),
  ensureMic: () => ipcRenderer.invoke("lykn:ensure-mic"),
  openMicSettings: () => ipcRenderer.send("lykn:onboarding-open-mic-settings"),
  // Global notifications mute — gates update/agent OS notifications, the
  // agent-finished popup, and renderer Notification permission requests.
  getNotificationsMuted: () => ipcRenderer.invoke("lykn:notifications-muted-get"),
  setNotificationsMuted: (muted) =>
    ipcRenderer.send("lykn:notifications-muted-set", { muted: !!muted }),
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
ipcRenderer.on("lykn:studio-show-browser", () => {
  try {
    window.dispatchEvent(new CustomEvent("lykn-studio-show-browser"));
  } catch (_) {}
});
