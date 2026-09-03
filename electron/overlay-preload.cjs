// Preload for the Jarvis glass bar. Exposes a tiny, explicit API to the local
// overlay page — never the raw ipcRenderer.

const { contextBridge, ipcRenderer, clipboard } = require("electron");
const {
  GLASS_LIVE_WATCH_ENABLED,
  GLASS_AGENT_MODE_ENABLED,
} = require("./overlay/glassFeatures.cjs");

contextBridge.exposeInMainWorld("lyknOverlay", {
  platform: process.platform,
  glassLiveWatchEnabled: GLASS_LIVE_WATCH_ENABLED,
  glassAgentModeEnabled: GLASS_AGENT_MODE_ENABLED,
  // Local Mode — file/terminal access, shared with the main-app surface so the
  // Glass overlay can run local tools too. Tools execute in main.
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
  // Ask LYKN about the current screen. The main process captures the screen
  // silently and streams the answer back via onDelta/onDone/onError.
  // opts: { forceImage } — image mode armed via menu → "Create an image".
  //       { buildMode }  — build mode armed via menu → "Build mode" (the
  //                        server forces the React artifact builder).
  ask: (text, history, attachments, opts) =>
    ipcRenderer.send("lykn:ask", { text, history, attachments, ...(opts || {}) }),
  onShown: (cb) => ipcRenderer.on("lykn:overlay-shown", () => cb()),
  // Re-key the glass bar so typing works after another app / agent stage stole focus.
  focusComposer: () => ipcRenderer.send("lykn:focus-overlay-composer"),
  onFocusComposer: (cb) => ipcRenderer.on("lykn:overlay-focus-composer", () => cb()),
  // Snap the bar back to bottom-center if it got clipped under the dock.
  resetPosition: () => ipcRenderer.send("lykn:reset-overlay-position"),
  // Main forwards Escape via before-input-event so panel windows still receive it.
  onEscape: (cb) => ipcRenderer.on("lykn:overlay-escape", () => cb()),
  // Thinking / tool-use status updates ("Searching the web…").
  onStatus: (cb) => ipcRenderer.on("lykn:answer-status", (_e, p) => cb(p)),
  onDelta: (cb) => ipcRenderer.on("lykn:answer-delta", (_e, p) => cb(p)),
  onDone: (cb) => ipcRenderer.on("lykn:answer-done", (_e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on("lykn:answer-error", (_e, p) => cb(p)),
  // Deep research / stream-provided source list for the Sources side panel.
  onSources: (cb) => ipcRenderer.on("lykn:answer-sources", (_e, p) => cb(p)),
  // The page LYKN scraped to answer (so the UI can show it as a source).
  onPageSource: (cb) => ipcRenderer.on("lykn:page-source", (_e, p) => cb(p)),
  // Tell main the current content width + height so it can resize the panel.
  resize: (width, height, opts) =>
    ipcRenderer.send("lykn:resize", { width, height, ...(opts || {}) }),
  // Drag the floating bar by a screen-pixel delta.
  moveBy: (dx, dy) => ipcRenderer.send("lykn:move-by", { dx, dy }),
  // Drag finished — main can catch side panels up without doing it every pixel.
  moveEnd: () => ipcRenderer.send("lykn:move-end"),
  // Collapse the panel to a small LYKN icon bubble (true) or expand it (false).
  collapse: (v) => ipcRenderer.send("lykn:collapse", !!v),
  hide: () => ipcRenderer.send("lykn:hide-overlay"),
  // Detached three-dot menu window (floats next to the bar).
  setMenu: (open) => ipcRenderer.send("lykn:menu-set", { open: !!open }),
  onMenuVisible: (cb) => ipcRenderer.on("lykn:menu-visible", (_e, v) => cb(!!v)),
  // Detached side-panel picker window (floats next to the bar, like the menu).
  setPicker: (open) => ipcRenderer.send("lykn:picker-set", { open: !!open }),
  onPickerVisible: (cb) => ipcRenderer.on("lykn:picker-visible", (_e, v) => cb(!!v)),
  // Detached Translate-mode language list (floats under the To pill).
  setLangPicker: (open, anchor) =>
    ipcRenderer.send("lykn:lang-picker-set", { open: !!open, anchor: anchor || null }),
  onLangPickerVisible: (cb) =>
    ipcRenderer.on("lykn:lang-picker-visible", (_e, v) => cb(!!v)),
  onLangPickerSelect: (cb) =>
    ipcRenderer.on("lykn:lang-picker-select", (_e, p) => cb(p || {})),
  // Detached live meeting notes window — this renderer owns the audio capture
  // and transcript state, and pushes render snapshots to the floating card.
  setLive: (open) => ipcRenderer.send("lykn:live-set", { open: !!open }),
  pushLive: (state) => ipcRenderer.send("lykn:live-push", state || {}),
  // Detached side-panel content window (Sources / Tasks / Notes / Live
  // feedback) — same snapshot-push pattern as the live card.
  setPanel: (open) => ipcRenderer.send("lykn:panel-set", { open: !!open }),
  pushPanel: (state) => ipcRenderer.send("lykn:panel-push", state || {}),
  openMain: () => ipcRenderer.send("lykn:open-main"),
  openAppChat: (chatId) => ipcRenderer.send("lykn:open-app-chat", chatId),
  // Past chats — overlay sessions (local) + app chats (Supabase via API).
  listChats: () => ipcRenderer.invoke("lykn:list-chats"),
  getOverlaySession: (sessionId) => ipcRenderer.invoke("lykn:get-overlay-session", sessionId),
  saveOverlaySession: (payload) => ipcRenderer.invoke("lykn:save-overlay-session", payload),
  newOverlaySession: () => ipcRenderer.invoke("lykn:new-overlay-session"),
  ensureOverlaySession: () => ipcRenderer.invoke("lykn:ensure-overlay-session"),
  // Open a native file picker and get back ready-to-send attachment objects.
  pickFiles: () => ipcRenderer.invoke("lykn:pick-files"),
  // Drag-select a region of the screen and get it back as an image attachment.
  snipScreen: () => ipcRenderer.invoke("lykn:snip-screen"),
  // Voice mode: fetch a signed ElevenLabs session, and dispatch agent tools.
  voiceSignedUrl: (payload) => ipcRenderer.invoke("lykn:voice-signed-url", payload || {}),
  voiceTool: (name, args) => ipcRenderer.invoke("lykn:voice-tool", { name, args }),
  // Voice mode: capture + describe the current screen as text for the agent.
  screenContext: () => ipcRenderer.invoke("lykn:screen-context"),
  // Voice mode: push the current screen to the live session's server grounding.
  voiceScreen: (sessionToken) => ipcRenderer.invoke("lykn:voice-screen", { sessionToken }),
  // Dictation: confirm mic access, then transcribe recorded audio bytes.
  ensureMic: () => ipcRenderer.invoke("lykn:ensure-mic"),
  transcribe: (audio, mimeType, prompt) =>
    ipcRenderer.invoke("lykn:transcribe", { audio, mimeType, prompt }),
  meetingChunk: (audio, mimeType, prompt, context) =>
    ipcRenderer.invoke("lykn:meeting-chunk", { audio, mimeType, prompt, context }),
  // Wispr-Flow-style cleanup of a raw transcript chunk for live-listen mode.
  cleanTranscript: (text, context) =>
    ipcRenderer.invoke("lykn:clean-transcript", { text, context }),
  // Cluely-style live assist: rolling transcript in, occasional help card out.
  liveAssist: (transcript, shown) =>
    ipcRenderer.invoke("lykn:live-assist", { transcript, shown }),
  // Rolling meeting notes from the live transcript.
  meetingNotes: (transcript, previousNotes) =>
    ipcRenderer.invoke("lykn:meeting-notes", { transcript, previousNotes }),
  // Cluely-style follow-up questions + real source links for an answer.
  suggest: (question, answer, opts = {}) =>
    ipcRenderer.invoke("lykn:suggest", { question, answer, ...opts }),
  // Browser control — scan the active tab, plan clicks/types, execute after confirm.
  browserCapability: () => ipcRenderer.invoke("lykn:browser-capability"),
  browserPlan: (intent, conversationHistory) =>
    ipcRenderer.invoke("lykn:browser-plan", {
      intent,
      conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
    }),
  browserExecute: (payload) => ipcRenderer.invoke("lykn:browser-execute", payload || {}),
  // Save a note (e.g. a task summary) to the user's LYKN vault.
  saveVaultNote: (payload) => ipcRenderer.invoke("lykn:save-vault-note", payload || {}),
  copyText: (text) => {
    try {
      const s = String(text || "");
      if (!s) return false;
      clipboard.writeText(s);
      return true;
    } catch {
      return false;
    }
  },
  openVault: (noteId) => ipcRenderer.send("lykn:open-vault", noteId || ""),
  onBrowserProgress: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:browser-progress", fn);
    return () => ipcRenderer.removeListener("lykn:browser-progress", fn);
  },
  // Open a URL — Agent Mode: LYKN agent browser; otherwise OS default browser.
  openUrl: (url, title) =>
    ipcRenderer.send("lykn:open-url", { url: String(url || ""), title }),
  // Download a generated image / Build-mode artifact into ~/Downloads and
  // reveal it in Finder; also saves a copy into the user's Vault (best-effort).
  // Returns { ok, path, savedToVault } or { ok: false, error }.
  downloadFile: (url, name, title) => ipcRenderer.invoke("lykn:download-file", { url, name, title }),
  // Fetch the raw JSX source embedded in a Build-mode artifact's runner HTML
  // (for the artifact card's "Code" view). Returns { ok, code } or { ok:false }.
  artifactCode: (url) => ipcRenderer.invoke("lykn:artifact-code", { url }),
  // Seed Build-mode refine from a vault/generated artifact URL (extracts
  // #lykn-artifact-source into lastOverlayReactArtifact in main).
  seedArtifactFromUrl: (url, title) =>
    ipcRenderer.invoke("lykn:seed-artifact-from-url", { url, title }),
  // Fetch an image URL as a data URL so Image mode can attach it as a reference.
  fetchAsDataUrl: (url) => ipcRenderer.invoke("lykn:fetch-as-data-url", { url }),
  // Content protection — hide the overlay from screen recordings/shares.
  getContentProtection: () => ipcRenderer.invoke("lykn:get-content-protection"),
  setContentProtection: (enabled) =>
    ipcRenderer.invoke("lykn:set-content-protection", !!enabled),
  // Live Watch — continuous screen awareness (motion-aware frame stream).
  getLiveWatch: () => ipcRenderer.invoke("lykn:get-live-watch"),
  setLiveWatch: (enabled) => {
    if (!GLASS_LIVE_WATCH_ENABLED && enabled) {
      return Promise.resolve({ ok: false, error: "unplugged", enabled: false });
    }
    return ipcRenderer.invoke("lykn:set-live-watch", !!enabled);
  },
  addLiveWatchRule: (text) => ipcRenderer.invoke("lykn:add-live-watch-rule", { text }),
  clearLiveWatchRules: () => ipcRenderer.invoke("lykn:clear-live-watch-rules"),
  onLiveWatchUpdate: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:live-watch-update", fn);
    return () => ipcRenderer.removeListener("lykn:live-watch-update", fn);
  },
  openExtensionInstall: () => ipcRenderer.invoke("lykn:open-extension-install"),
  getNightBriefs: () => ipcRenderer.invoke("lykn:get-night-briefs"),
  updateStatus: () => ipcRenderer.invoke("lykn:update-status"),
  installUpdate: () => ipcRenderer.invoke("lykn:update-install"),
  onUpdateStatus: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:update-status", fn);
    return () => ipcRenderer.removeListener("lykn:update-status", fn);
  },
  // Agent Mode — parallel cowork agents (owned browser sessions).
  agentCreate: (payload) => ipcRenderer.invoke("lykn:agent-create", payload || {}),
  agentList: () => ipcRenderer.invoke("lykn:agent-list"),
  agentSwitch: (agentId) => ipcRenderer.invoke("lykn:agent-switch", agentId),
  agentStop: (agentId) => ipcRenderer.invoke("lykn:agent-stop", agentId),
  agentClose: (agentId) => ipcRenderer.invoke("lykn:agent-close", agentId),
  agentResetMain: () => ipcRenderer.invoke("lykn:agent-reset-main"),
  agentSend: (agentId, text, attachments) =>
    ipcRenderer.invoke("lykn:agent-send", { agentId, text, attachments }),
  agentChoiceResolve: (agentId, choiceId, buttonId) =>
    ipcRenderer.invoke("lykn:agent-choice-resolve", { agentId, choiceId, buttonId }),
  agentModeSet: (open) => {
    // Soft-unplug: Glass cannot enter Agent Mode. Closing still works so a
    // leftover session can stand down. Studio uses a different preload.
    if (!GLASS_AGENT_MODE_ENABLED && open) {
      return Promise.resolve({ ok: false, unplugged: true, agentModeOn: false });
    }
    return ipcRenderer.invoke("lykn:agent-mode-set", { open: !!open });
  },
  agentHistory: (agentId) => ipcRenderer.invoke("lykn:agent-history", agentId),
  agentShowBrowser: (agentId, visible) =>
    ipcRenderer.invoke("lykn:agent-show-browser", { agentId, visible: visible !== false }),
  agentBrowserVisible: () => ipcRenderer.invoke("lykn:agent-browser-visible"),
  agentShowStep: (agentId, stepIndex) =>
    ipcRenderer.invoke("lykn:agent-show-step", { agentId, stepIndex }),
  onAgentBrowserVisibility: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-browser-visibility", fn);
    return () => ipcRenderer.removeListener("lykn:agent-browser-visibility", fn);
  },
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
  onAgentStatus: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-status", fn);
    return () => ipcRenderer.removeListener("lykn:agent-status", fn);
  },
  // Persistent "paused, waiting on you" state (sign-in wall, captcha, manual
  // step). Survives the finished turn until the runtime clears it.
  onAgentWaiting: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-waiting", fn);
    return () => ipcRenderer.removeListener("lykn:agent-waiting", fn);
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
  onAgentChoice: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-choice", fn);
    return () => ipcRenderer.removeListener("lykn:agent-choice", fn);
  },
  onAgentToast: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-toast", fn);
    return () => ipcRenderer.removeListener("lykn:agent-toast", fn);
  },
  onAgentError: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-error", fn);
    return () => ipcRenderer.removeListener("lykn:agent-error", fn);
  },
  onAgentSources: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-sources", fn);
    return () => ipcRenderer.removeListener("lykn:agent-sources", fn);
  },
});
