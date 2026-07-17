// Preload for the detached side-panel picker window. Small remote-control
// API — the overlay renderer owns the side-panel state; this card only
// renders the option list and reports the pick back.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknPicker", {
  // A view was picked — main forwards it to the overlay renderer.
  select: (id) => ipcRenderer.send("lykn:picker-select", { id }),
  close: () => ipcRenderer.send("lykn:picker-close"),
  // Content height changed (option count varies) — main resizes the window.
  resize: (height) => ipcRenderer.send("lykn:picker-resize", { height }),
  // Snapshot of the options (labels, counts, active view) from the overlay.
  getState: () => ipcRenderer.invoke("lykn:picker-state"),
  onShown: (cb) => ipcRenderer.on("lykn:picker-shown", () => cb()),
});
