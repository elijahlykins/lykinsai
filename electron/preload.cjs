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

// Google sign-in hand-off: the OAuth round-trip happens in the user's real
// browser (Google blocks embedded browsers), which deep-links the Supabase
// session back via lykn://auth. Main forwards the tokens here; buffer them in
// the preload so a token that arrives before the web app registers its
// listener (React mounts after did-finish-load) is not dropped.
let pendingAuthTokens = null;
let authTokensCallback = null;
ipcRenderer.on("lykn:auth-tokens", (_event, tokens) => {
  if (authTokensCallback) authTokensCallback(tokens);
  else pendingAuthTokens = tokens;
});

contextBridge.exposeInMainWorld("lykn", {
  desktop: true,
  platform: process.platform,
  version: appVersion,
  // Open a URL in the user's default browser (main validates http/https).
  // Needed for the browser-based Google sign-in: a plain window.open() to our
  // own origin would stay inside the shell window.
  openExternal: (url) => ipcRenderer.send("lykn:open-url", String(url || "")),
  // Subscribe to deep-linked Supabase session tokens (see lykn://auth flow).
  onAuthTokens: (callback) => {
    authTokensCallback = typeof callback === "function" ? callback : null;
    if (authTokensCallback && pendingAuthTokens) {
      const tokens = pendingAuthTokens;
      pendingAuthTokens = null;
      authTokensCallback(tokens);
    }
  },
});
