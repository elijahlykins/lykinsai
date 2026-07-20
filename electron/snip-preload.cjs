// Preload for the interactive region-snip overlay (Windows / cross-platform).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknSnip", {
  commit: (rect) => ipcRenderer.send("lykn:snip-commit", rect || null),
  cancel: () => ipcRenderer.send("lykn:snip-cancel"),
});
