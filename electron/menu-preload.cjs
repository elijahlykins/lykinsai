// Preload for the detached three-dot menu window. Small remote-control API —
// commands are forwarded by main to the overlay renderer, which owns the
// actual feature logic and state.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknMenu", {
  platform: process.platform,
  // Forward a menu action (e.g. "menu-new", "voice") to the overlay renderer.
  cmd: (name, arg) => ipcRenderer.send("lykn:menu-cmd", { name, arg }),
  close: () => ipcRenderer.send("lykn:menu-close"),
  // Content height changed (menu vs past-chats view) — main resizes the window.
  resize: (height) => ipcRenderer.send("lykn:menu-resize", { height }),
  // Snapshot of toggle states (voice / listen / watch / stealth) from the overlay.
  getState: () => ipcRenderer.invoke("lykn:menu-state"),
  // Past chats reuse the overlay's existing list source.
  listChats: () => ipcRenderer.invoke("lykn:list-chats"),
  openAppChat: (chatId) => ipcRenderer.send("lykn:open-app-chat", chatId),
  onShown: (cb) => ipcRenderer.on("lykn:menu-shown", () => cb()),
});
