const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknExtensionInstall", {
  bridgeStatus: () => ipcRenderer.invoke("lykn:extension-bridge-status"),
  getInstallMode: () => ipcRenderer.invoke("lykn:extension-install-mode"),
  installOneClick: (browser) => ipcRenderer.invoke("lykn:install-extension-one-click", { browser }),
  close: () => ipcRenderer.send("lykn:extension-install-close"),
});
