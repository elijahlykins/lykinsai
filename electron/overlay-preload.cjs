// Preload for the Jarvis glass bar. Exposes a tiny, explicit API to the local
// overlay page — never the raw ipcRenderer.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknOverlay", {
  // Ask LYKN about the current screen. The main process captures the screen
  // silently and streams the answer back via onDelta/onDone/onError.
  ask: (text, history, attachments) =>
    ipcRenderer.send("lykn:ask", { text, history, attachments }),
  onShown: (cb) => ipcRenderer.on("lykn:overlay-shown", () => cb()),
  // Thinking / tool-use status updates ("Searching the web…").
  onStatus: (cb) => ipcRenderer.on("lykn:answer-status", (_e, p) => cb(p)),
  onDelta: (cb) => ipcRenderer.on("lykn:answer-delta", (_e, p) => cb(p)),
  onDone: (cb) => ipcRenderer.on("lykn:answer-done", (_e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on("lykn:answer-error", (_e, p) => cb(p)),
  // The page LYKN scraped to answer (so the UI can show it as a source).
  onPageSource: (cb) => ipcRenderer.on("lykn:page-source", (_e, p) => cb(p)),
  // Tell main the current content width + height so it can resize the panel.
  resize: (width, height, opts) =>
    ipcRenderer.send("lykn:resize", { width, height, ...(opts || {}) }),
  // Drag the floating bar by a screen-pixel delta.
  moveBy: (dx, dy) => ipcRenderer.send("lykn:move-by", { dx, dy }),
  // Collapse the panel to a small LYKN icon bubble (true) or expand it (false).
  collapse: (v) => ipcRenderer.send("lykn:collapse", !!v),
  hide: () => ipcRenderer.send("lykn:hide-overlay"),
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
  // Wispr-Flow-style cleanup of a raw transcript chunk for live-listen mode.
  cleanTranscript: (text, context) =>
    ipcRenderer.invoke("lykn:clean-transcript", { text, context }),
  // Rolling meeting notes (summary + key points + action items) from transcript.
  meetingNotes: (transcript) =>
    ipcRenderer.invoke("lykn:meeting-notes", { transcript }),
  // Cluely-style follow-up questions + real source links for an answer.
  suggest: (question, answer) =>
    ipcRenderer.invoke("lykn:suggest", { question, answer }),
  // Browser control — scan the active tab, plan clicks/types, execute after confirm.
  browserCapability: () => ipcRenderer.invoke("lykn:browser-capability"),
  browserPlan: (intent) => ipcRenderer.invoke("lykn:browser-plan", { intent }),
  browserExecute: (payload) => ipcRenderer.invoke("lykn:browser-execute", payload || {}),
  // Open a URL in the default browser (source links, answer links).
  openUrl: (url) => ipcRenderer.send("lykn:open-url", url),
});
