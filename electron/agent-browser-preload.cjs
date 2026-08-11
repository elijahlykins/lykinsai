const { contextBridge, ipcRenderer } = require("electron");

// The main process verifies that calls originate from the bundled new-tab
// document before it will accept them. Keeping this bridge tiny avoids giving
// ordinary websites in an agent browser tab any privileged surface.
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
