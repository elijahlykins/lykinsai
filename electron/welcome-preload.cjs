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
  /** "Continue with Google": the OAuth round-trip runs in the system browser. */
  signInWithGoogle: () => ipcRenderer.invoke("lykn:welcome-google"),
  /** Fired when the Google round-trip lands a session in the app. */
  onGoogleSignedIn: (callback) => ipcRenderer.on("lykn:welcome-google-signed-in", () => callback()),
  /** Confirm the emailed account verification code. */
  verifyCode: (email, code) =>
    ipcRenderer.invoke("lykn:welcome-verify", { email: String(email || ""), code: String(code || "") }),
  /** Send a fresh account verification code. */
  resendCode: (email) => ipcRenderer.invoke("lykn:welcome-resend", { email: String(email || "") }),
  /**
   * Import stage: browsers installed on this machine.
   * Resolves [{ id, name, profiles?: { dir, name }[] }].
   */
  getBrowsers: () => ipcRenderer.invoke("lykn:welcome-browsers"),
  /**
   * Import stage "Next": remember which browser (and optional profile) to
   * import from. Accepts a browser id string or { id, profileDir }.
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
   * Mac sync stage: open the native folder picker for extra synced folders.
   * Resolves { ok, folders?: string[] }.
   */
  pickSyncFolder: () => ipcRenderer.invoke("lykn:mac-sync-pick-folder"),
  /**
   * Mac sync stage "Next": persist the synced-folders allowlist and turn
   * Local Mode on so LYKN AI can read what the user picked.
   * @param {{ syncAll?: boolean, folders?: string[] }} payload
   */
  setMacSync: (payload) => ipcRenderer.invoke("lykn:welcome-macsync", payload),
  /**
   * Background stage: small preview of the user's current macOS wallpaper.
   * Resolves { ok, dataUrl? }.
   */
  wallpaperPreview: () => ipcRenderer.invoke("lykn:background-wallpaper-preview"),
  /**
   * Background stage: native image picker.
   * Resolves { ok, path?, dataUrl? } (dataUrl is a small preview).
   */
  pickBackgroundImage: () => ipcRenderer.invoke("lykn:background-pick-file"),
  /**
   * Background stage "Next": persist the chosen Studio background.
   * @param {{ source: "wallpaper" | "file", path?: string }} payload
   */
  setBackground: ({ source, path } = {}) =>
    ipcRenderer.invoke("lykn:background-set", { source, path }),
  /**
   * Widgets stage "Next": which widgets sit on the Home desktop.
   * @param {Record<string, boolean>} widgets e.g. { calendar: true, todos: false }
   */
  setHomeWidgets: (widgets) => ipcRenderer.invoke("lykn:welcome-widgets", widgets),
  /**
   * Apps stage "Next": the apps the user works with, so LYKN can tailor
   * itself to their workflow.
   * @param {string[]} apps e.g. ["slack", "gmail"]
   */
  setFavoriteApps: (apps) => ipcRenderer.invoke("lykn:welcome-apps", apps),
  /**
   * Make LYKN Yours: theme, response, and chat-color picks from the
   * customization slides. Values match Settings (`lykinsai_settings`).
   * @param {{
   *   accent?: string,
   *   appearance?: string,
   *   responseLength?: string,
   *   userPrompt?: string,
   *   chatUserTextColor?: string,
   *   chatBubbleColor?: string,
   *   chatAiTextColor?: string,
   *   chatUserTextSize?: string,
   *   chatAiTextSize?: string,
   *   chatBarSize?: string,
   *   chatBubbleShape?: string,
   *   chatBarShape?: string,
   *   chatSendIcon?: string,
   *   chatSendShape?: string,
   * }} prefs
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
