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
  // Tell main the current content height so it can resize the floating bar.
  resize: (height) => ipcRenderer.send("lykn:resize", height),
  // Drag the floating bar by a screen-pixel delta.
  moveBy: (dx, dy) => ipcRenderer.send("lykn:move-by", { dx, dy }),
  hide: () => ipcRenderer.send("lykn:hide-overlay"),
  openMain: () => ipcRenderer.send("lykn:open-main"),
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
});
