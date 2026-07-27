const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknExtensionInstall", {
  bridgeStatus: () => ipcRenderer.invoke("lykn:extension-bridge-status"),
  getInstallMode: () => ipcRenderer.invoke("lykn:extension-install-mode"),
  installOneClick: (browser) => ipcRenderer.invoke("lykn:install-extension-one-click", { browser }),
  revealFolder: () => ipcRenderer.invoke("lykn:reveal-extension-folder", { reveal: true }),
  copyPath: () => ipcRenderer.invoke("lykn:reveal-extension-folder", { reveal: false }),
  close: () => ipcRenderer.send("lykn:extension-install-close"),
});
