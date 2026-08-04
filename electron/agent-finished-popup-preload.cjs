const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknFinishedPopup", {
  close: () => ipcRenderer.send("lykn:agent-finished-popup-close"),
  openAgent: (agentId) => ipcRenderer.send("lykn:agent-finished-popup-open", String(agentId || "")),
});
