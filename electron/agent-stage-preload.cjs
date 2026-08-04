const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknAgentStage", {
  platform: process.platform,
  onState: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-stage-state", fn);
    return () => ipcRenderer.removeListener("lykn:agent-stage-state", fn);
  },
  onToast: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-stage-toast", fn);
    return () => ipcRenderer.removeListener("lykn:agent-stage-toast", fn);
  },
  navigate: (url) => ipcRenderer.invoke("lykn:agent-stage-navigate", { url }),
  back: () => ipcRenderer.invoke("lykn:agent-stage-back"),
  forward: () => ipcRenderer.invoke("lykn:agent-stage-forward"),
  reload: () => ipcRenderer.invoke("lykn:agent-stage-reload"),
  selectTab: (agentId) => ipcRenderer.invoke("lykn:agent-stage-select", { agentId }),
  closeTab: (agentId) => ipcRenderer.invoke("lykn:agent-stage-close-tab", { agentId }),
  newTab: () => ipcRenderer.invoke("lykn:agent-stage-new-tab"),
  toggleIncognito: () => ipcRenderer.invoke("lykn:agent-stage-toggle-incognito"),
  listBookmarks: () => ipcRenderer.invoke("lykn:agent-bookmarks-list"),
  toggleBookmark: (payload) => ipcRenderer.invoke("lykn:agent-bookmarks-toggle", payload || {}),
  removeBookmark: (payload) => ipcRenderer.invoke("lykn:agent-bookmarks-remove", payload || {}),
  renameBookmark: (payload) => ipcRenderer.invoke("lykn:agent-bookmarks-rename", payload || {}),
  resizeChrome: (height) => ipcRenderer.send("lykn:agent-stage-chrome-height", { height }),
  // Saved-links dropdown open/closed — main raises the chrome over the page.
  setMenuOverlay: (open) => ipcRenderer.send("lykn:agent-stage-menu-overlay", { open }),
  // Chrome / Chromium sync (import logins + open tabs).
  chromeSyncStatus: () => ipcRenderer.invoke("lykn:chrome-sync-status"),
  chromeSyncRun: (opts) => ipcRenderer.invoke("lykn:chrome-sync-run", opts || {}),
  close: () => ipcRenderer.send("lykn:agent-stage-set", { open: false }),
});
