const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknAgentSidebar", {
  platform: process.platform,
  create: (payload) => ipcRenderer.invoke("lykn:agent-create", payload || {}),
  list: () => ipcRenderer.invoke("lykn:agent-list"),
  switch: (agentId) => ipcRenderer.invoke("lykn:agent-switch", agentId),
  stop: (agentId) => ipcRenderer.invoke("lykn:agent-stop", agentId),
  close: (agentId) => ipcRenderer.invoke("lykn:agent-close", agentId),
  resetMain: () => ipcRenderer.invoke("lykn:agent-reset-main"),
  showBrowser: (agentId, visible) =>
    ipcRenderer.invoke("lykn:agent-show-browser", { agentId, visible: visible !== false }),
  onList: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-list", fn);
    return () => ipcRenderer.removeListener("lykn:agent-list", fn);
  },
  onProgress: (cb) => {
    const fn = (_e, p) => cb(p || {});
    ipcRenderer.on("lykn:agent-progress", fn);
    return () => ipcRenderer.removeListener("lykn:agent-progress", fn);
  },
  resize: (width, height) => ipcRenderer.send("lykn:agent-sidebar-resize", { width, height }),
  hide: () => ipcRenderer.send("lykn:agent-sidebar-set", { open: false }),
});
