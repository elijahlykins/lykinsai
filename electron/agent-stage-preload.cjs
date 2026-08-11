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
  downloadPage: () => ipcRenderer.invoke("lykn:agent-stage-download"),
  selectTab: (agentId) => ipcRenderer.invoke("lykn:agent-stage-select", { agentId }),
  closeTab: (agentId) => ipcRenderer.invoke("lykn:agent-stage-close-tab", { agentId }),
  newTab: () => ipcRenderer.invoke("lykn:agent-stage-new-tab"),
  toggleIncognito: () => ipcRenderer.invoke("lykn:agent-stage-toggle-incognito"),
  listHistory: () => ipcRenderer.invoke("lykn:agent-browser-history-list"),
  removeRecent: (payload) => ipcRenderer.invoke("lykn:agent-recents-remove", payload || {}),
  resizeChrome: (height) => ipcRenderer.send("lykn:agent-stage-chrome-height", { height }),
  // Dropdown open/closed — main raises the chrome over the page.
  setMenuOverlay: (open) => ipcRenderer.send("lykn:agent-stage-menu-overlay", { open }),
  // Chrome / Chromium sync (import logins + open tabs).
  chromeSyncStatus: () => ipcRenderer.invoke("lykn:chrome-sync-status"),
  chromeSyncRun: (opts) => ipcRenderer.invoke("lykn:chrome-sync-run", opts || {}),
  // Toggle / set the Studio agent chat panel (Use LYKN pill).
  toggleAgentChat: () => ipcRenderer.invoke("lykn:agent-chat-set", { toggle: true }),
  setAgentChat: (open) => ipcRenderer.invoke("lykn:agent-chat-set", { open: !!open }),
  close: () => ipcRenderer.send("lykn:agent-stage-set", { open: false }),
});
