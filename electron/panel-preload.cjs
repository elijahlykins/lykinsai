// Preload for the detached side-panel content window (the view picked from
// the bar's dropdown: Sources / Tasks / Follow-ups / Notes / Live feedback).
// The overlay renderer owns the data and rendering; this card only paints
// pushed snapshots and forwards user actions back.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknPanel", {
  // Forward a card action (open url, ask follow-up, install, close) to the overlay.
  cmd: (name, arg) => ipcRenderer.send("lykn:panel-cmd", { name, arg }),
  // Report the rendered content height so main can size the window to fit.
  resize: (height) => ipcRenderer.send("lykn:panel-resize", { height }),
  // Render snapshots pushed from the overlay renderer (via main).
  onState: (cb) => ipcRenderer.on("lykn:panel-state", (_e, state) => cb(state || {})),
});
