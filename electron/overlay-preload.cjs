// Preload for the Jarvis glass bar. Exposes a tiny, explicit API to the local
// overlay page — never the raw ipcRenderer.

const { contextBridge, ipcRenderer, clipboard } = require("electron");

contextBridge.exposeInMainWorld("lyknOverlay", {
  platform: process.platform,
  // Ask LYKN about the current screen. The main process captures the screen
  // silently and streams the answer back via onDelta/onDone/onError.
  // opts: { forceImage } — image mode armed via menu → "Create an image".
  //       { buildMode }  — build mode armed via menu → "Build mode" (the
  //                        server forces the React artifact builder).
  ask: (text, history, attachments, opts) =>
    ipcRenderer.send("lykn:ask", { text, history, attachments, ...(opts || {}) }),
  onShown: (cb) => ipcRenderer.on("lykn:overlay-shown", () => cb()),
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
  // AI picks the described region of the screen, crops it, saves to Downloads
  // + clipboard. Pass the user's phrasing (e.g. "the chart top-right").
  saveScreenRegion: (description) =>
    ipcRenderer.invoke("lykn:save-screen-region", description),
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
  openSynthesis: () => ipcRenderer.send("lykn:open-synthesis"),
  onBrowserProgress: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:browser-progress", fn);
    return () => ipcRenderer.removeListener("lykn:browser-progress", fn);
  },
  // Open a URL in the default browser (source links, answer links).
  openUrl: (url) => ipcRenderer.send("lykn:open-url", url),
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
  setLiveWatch: (enabled) => ipcRenderer.invoke("lykn:set-live-watch", !!enabled),
  addLiveWatchRule: (text) => ipcRenderer.invoke("lykn:add-live-watch-rule", { text }),
  clearLiveWatchRules: () => ipcRenderer.invoke("lykn:clear-live-watch-rules"),
  onLiveWatchUpdate: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:live-watch-update", fn);
    return () => ipcRenderer.removeListener("lykn:live-watch-update", fn);
  },
  openExtensionInstall: () => ipcRenderer.invoke("lykn:open-extension-install"),
  getNightBriefs: () => ipcRenderer.invoke("lykn:get-night-briefs"),
});
