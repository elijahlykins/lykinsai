// Preload for the detached Translate-mode language picker.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknLangPicker", {
  platform: process.platform,
  select: (lang) => ipcRenderer.send("lykn:lang-picker-select", { lang }),
  close: () => ipcRenderer.send("lykn:lang-picker-close"),
  resize: (height) => ipcRenderer.send("lykn:lang-picker-resize", { height }),
  getState: () => ipcRenderer.invoke("lykn:lang-picker-state"),
  onShown: (cb) => ipcRenderer.on("lykn:lang-picker-shown", () => cb()),
});
