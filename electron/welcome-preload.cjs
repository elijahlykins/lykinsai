// Preload for the first-launch welcome window (welcome.html).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyknWelcome", {
  /**
   * "Get started" on the essentials page: apply the chosen setup options.
   * The renderer then advances to the next stage in the same window.
   * @param {{ defaultBrowser?: boolean, dock?: boolean, login?: boolean }} options
   */
  getStarted: (options) => ipcRenderer.invoke("lykn:welcome-get-started", options),
  /**
   * Stage change: past the reveal (stage >= 2) the main process drops the
   * window from screen-saver level so the user can switch apps.
   * @param {number} stage
   */
  stageChanged: (stage) => ipcRenderer.send("lykn:welcome-stage", stage),
  /** Start the email/password account setup flow. */
  signUp: (email, password) =>
    ipcRenderer.invoke("lykn:welcome-signup", { email: String(email || ""), password: String(password || "") }),
  /** Sign an existing account in, then resume the walkthrough. */
  signIn: (email, password) =>
    ipcRenderer.invoke("lykn:welcome-signin", { email: String(email || ""), password: String(password || "") }),
  /** Confirm the emailed account verification code. */
  verifyCode: (email, code) =>
    ipcRenderer.invoke("lykn:welcome-verify", { email: String(email || ""), code: String(code || "") }),
  /** Send a fresh account verification code. */
  resendCode: (email) => ipcRenderer.invoke("lykn:welcome-resend", { email: String(email || "") }),
  /**
   * Import stage: browsers installed on this machine.
   * Resolves [{ id, name, profiles? }].
   */
  getBrowsers: () => ipcRenderer.invoke("lykn:welcome-browsers"),
  /**
   * Import stage "Next": remember which browser to import from.
   * @param {string} browser e.g. "chrome" | "safari"
   */
  setImportBrowser: (browser) => ipcRenderer.invoke("lykn:welcome-import", browser),
  /**
   * Logins stage: record that the user allowed browser-login import.
   * @param {boolean} wanted
   */
  setImportLogins: (wanted) => ipcRenderer.invoke("lykn:welcome-import-logins", wanted),
  /**
   * Fully sync a selected Chromium profile into LYKN: signed-in sessions,
   * open tabs, and recent browsing context. macOS owns any credential prompt.
   */
  syncBrowser: (options) => ipcRenderer.invoke("lykn:chrome-sync-run", options || {}),
  /**
   * Apps stage "Next": the apps the user works with, so LYKN can tailor
   * itself to their workflow.
   * @param {string[]} apps e.g. ["slack", "gmail"]
   */
  setFavoriteApps: (apps) => ipcRenderer.invoke("lykn:welcome-apps", apps),
  /**
   * Make LYKN Yours: theme + layout preferences from the customization
   * slides.
   * @param {{ accent?: string, appearance?: string, tabLayout?: string, startView?: string }} prefs
   */
  setPrefs: (prefs) => ipcRenderer.invoke("lykn:welcome-prefs", prefs),
  /**
   * Privacy stage: tracker blocking + content-data sharing choices.
   * @param {{ blockTrackers?: boolean, shareContentData?: boolean }} privacy
   */
  setPrivacy: (privacy) => ipcRenderer.invoke("lykn:welcome-privacy", privacy),
  /** Done with the welcome stages: close this window, advance the walkthrough. */
  finish: () => ipcRenderer.invoke("lykn:welcome-finish"),
  /** Open the privacy policy in the system browser. */
  openPrivacyPolicy: () => ipcRenderer.send("lykn:welcome-open-privacy"),
  /** Open the terms of use in the system browser. */
  openTerms: () => ipcRenderer.send("lykn:welcome-open-terms"),
});
