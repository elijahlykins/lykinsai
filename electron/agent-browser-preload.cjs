const { contextBridge, ipcRenderer } = require("electron");

// The main process verifies that calls originate from the bundled new-tab
// document before it will accept them. Keeping this bridge tiny avoids giving
// ordinary websites in an agent browser tab any privileged surface.
contextBridge.exposeInMainWorld("lyknBrowserHome", {
  openAiMode: (text, attachments) =>
    ipcRenderer.invoke("lykn:agent-browser-ai-mode", {
      text: String(text || ""),
      attachments: Array.isArray(attachments) ? attachments : [],
    }),
  ensureMic: () => ipcRenderer.invoke("lykn:agent-browser-ensure-mic"),
  transcribe: (audio, mimeType, prompt) =>
    ipcRenderer.invoke("lykn:agent-browser-transcribe", {
      audio,
      mimeType: String(mimeType || "audio/webm"),
      prompt: String(prompt || ""),
    }),
  pickFiles: () => ipcRenderer.invoke("lykn:agent-browser-pick-files"),
  openMicSettings: () => ipcRenderer.send("lykn:onboarding-open-mic-settings"),
});
contextBridge.exposeInMainWorld("lyknBrowserWelcome", {
  sendToAgent: (text, model, requestId) =>
    ipcRenderer.invoke("lykn:agent-browser-welcome-send", {
      text: String(text || ""),
      model: String(model || "lykn"),
      requestId: String(requestId || ""),
    }),
  onChatResult: (cb) => {
    const fn = (_event, payload) => cb?.(payload || {});
    ipcRenderer.on("lykn:agent-browser-welcome-result", fn);
    return () => ipcRenderer.removeListener("lykn:agent-browser-welcome-result", fn);
  },
  onChatStream: (cb) => {
    const fn = (_event, payload) => cb?.(payload || {});
    ipcRenderer.on("lykn:agent-browser-welcome-stream", fn);
    return () => ipcRenderer.removeListener("lykn:agent-browser-welcome-stream", fn);
  },
});
