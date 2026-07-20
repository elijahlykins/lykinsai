// Preload for the first-run setup window. Exposes a tiny, explicit API for
// each step of the walkthrough: sign-in status, the permissions LYKN needs
// (screen + microphone; macOS also Accessibility / Apple Events), and a
// hotkey-pressed signal for the final "try ⌘/Ctrl+L" step.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknOnboarding", {
  platform: process.platform,

  // ── Sign in ──────────────────────────────────────────────────────────
  // true when the main window holds a Supabase session.
  authStatus: () => ipcRenderer.invoke("lykn:onboarding-auth-status"),
  // Surface the main LYKN window (at /login when signed out).
  openSignIn: () => ipcRenderer.send("lykn:onboarding-open-sign-in"),

  // ── Screen Recording / capture ───────────────────────────────────────
  // 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  screenStatus: () => ipcRenderer.invoke("lykn:onboarding-screen-status"),
  openScreenSettings: () => ipcRenderer.send("lykn:onboarding-open-screen-settings"),
  // Trigger the system Screen Recording prompt by attempting a capture.
  requestScreen: () => ipcRenderer.invoke("lykn:onboarding-request-screen"),

  // ── Microphone ───────────────────────────────────────────────────────
  micStatus: () => ipcRenderer.invoke("lykn:onboarding-mic-status"),
  requestMic: () => ipcRenderer.invoke("lykn:onboarding-request-mic"),
  openMicSettings: () => ipcRenderer.send("lykn:onboarding-open-mic-settings"),

  // ── Accessibility (browser actions) — macOS ──────────────────────────
  accessibilityStatus: () => ipcRenderer.invoke("lykn:onboarding-accessibility-status"),
  requestAccessibility: () => ipcRenderer.invoke("lykn:onboarding-request-accessibility"),
  openAccessibilitySettings: () => ipcRenderer.send("lykn:onboarding-open-accessibility-settings"),

  // ── Apple Events ("Allow JavaScript from Apple Events") — macOS ──────
  // -> { ok, state: 'granted'|'denied'|'no-browser'|'error', browser, message }
  testAppleEvents: () => ipcRenderer.invoke("lykn:onboarding-test-apple-events"),
  openAutomationSettings: () => ipcRenderer.send("lykn:onboarding-open-automation-settings"),

  // ── Try it ───────────────────────────────────────────────────────────
  // Fires when the user presses the global ⌘/Ctrl+L while this window is open.
  onHotkey: (cb) => ipcRenderer.on("lykn:onboarding-hotkey", () => cb()),

  finish: () => ipcRenderer.send("lykn:onboarding-finish"),
});
