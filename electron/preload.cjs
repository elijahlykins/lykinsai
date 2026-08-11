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
