// Preload for the detached three-dot menu window. Small remote-control API —
// commands are forwarded by main to the overlay renderer, which owns the
// actual feature logic and state.

const { contextBridge, ipcRenderer } = require("electron");
const {
  GLASS_LIVE_WATCH_ENABLED,
  GLASS_AGENT_MODE_ENABLED,
} = require("./overlay/glassFeatures.cjs");

contextBridge.exposeInMainWorld("lyknMenu", {
  platform: process.platform,
  glassLiveWatchEnabled: GLASS_LIVE_WATCH_ENABLED,
  glassAgentModeEnabled: GLASS_AGENT_MODE_ENABLED,
  // Forward a menu action (e.g. "menu-new", "voice") to the overlay renderer.
  cmd: (name, arg) => ipcRenderer.send("lykn:menu-cmd", { name, arg }),
  close: () => ipcRenderer.send("lykn:menu-close"),
  // Content height changed (menu vs past-chats view) — main resizes the window.
  resize: (height) => ipcRenderer.send("lykn:menu-resize", { height }),
  // Snapshot of toggle states (voice / listen / watch / stealth) from the overlay.
  getState: () => ipcRenderer.invoke("lykn:menu-state"),
  // Past chats reuse the overlay's existing list source.
  listChats: () => ipcRenderer.invoke("lykn:list-chats"),
  listProjects: () => ipcRenderer.invoke("lykn:list-projects"),
  openAppChat: (chatId) => ipcRenderer.send("lykn:open-app-chat", chatId),
  onShown: (cb) => ipcRenderer.on("lykn:menu-shown", () => cb()),
  updateStatus: () => ipcRenderer.invoke("lykn:update-status"),
  installUpdate: () => ipcRenderer.invoke("lykn:update-install"),
});
