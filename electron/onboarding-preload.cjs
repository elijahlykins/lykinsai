// Preload for the first-run setup window. Exposes a tiny, explicit API for
// checking + requesting the two permissions LYKN needs to read the screen and
// scrape the active browser tab.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknOnboarding", {
  // 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  screenStatus: () => ipcRenderer.invoke("lykn:onboarding-screen-status"),
  openScreenSettings: () => ipcRenderer.send("lykn:onboarding-open-screen-settings"),
  // Trigger the system Screen Recording prompt by attempting a capture.
  requestScreen: () => ipcRenderer.invoke("lykn:onboarding-request-screen"),
  // Probe "Allow JavaScript from Apple Events" in the active browser.
  // -> { ok, state: 'granted'|'denied'|'no-browser'|'error', browser, message }
  testAppleEvents: () => ipcRenderer.invoke("lykn:onboarding-test-apple-events"),
  openAutomationSettings: () => ipcRenderer.send("lykn:onboarding-open-automation-settings"),
  finish: () => ipcRenderer.send("lykn:onboarding-finish"),
});
