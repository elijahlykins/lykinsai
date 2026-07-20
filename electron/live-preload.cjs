// Preload for the detached live meeting notes window. The overlay renderer
// owns the audio capture, transcription, and notes state; this card only
// renders pushed snapshots and forwards user actions back.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknLive", {
  platform: process.platform,
  // Forward a card action (pane switch, close, copy, save, ask) to the overlay.
  cmd: (name, arg) => ipcRenderer.send("lykn:live-cmd", { name, arg }),
  // Render snapshots pushed from the overlay renderer (via main).
  onState: (cb) => ipcRenderer.on("lykn:live-state", (_e, state) => cb(state || {})),
});
