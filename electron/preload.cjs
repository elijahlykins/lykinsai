// Preload bridge for the LYKN desktop shell.
//
// v1 exposes only a tiny, read-only surface so the web app can tell it's
// running inside the native shell (e.g. to show a "Download" CTA differently,
// or enable desktop-only affordances later).
//
// TODO(jarvis): this is where the screen-capture / overlay IPC will be exposed
// to the renderer, e.g. window.lykn.captureScreen() → returns a data URL that
// the existing OCR/vision pipeline can consume. Keep the surface minimal and
// explicit — never expose ipcRenderer directly.

const { contextBridge, ipcRenderer } = require("electron");

// app.getVersion() via sync IPC: process.env.npm_package_version only exists
// when launched through npm, so it was always null in the packaged app.
let appVersion = null;
try {
  appVersion = ipcRenderer.sendSync("lykn:get-version") || null;
} catch {
  appVersion = null;
}

contextBridge.exposeInMainWorld("lykn", {
  desktop: true,
  platform: process.platform,
  version: appVersion,
});
