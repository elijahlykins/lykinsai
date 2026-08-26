"use strict";

function registerOnboardingIpc(d) {
  const {
    app, BrowserWindow, WebContentsView, shell, globalShortcut, Menu, ipcMain,
    desktopCapturer, screen, systemPreferences, dialog, nativeImage, clipboard,
    Tray, session, Notification, powerMonitor, nativeTheme, protocol,
    net: electronNet,
  } = d.electron;
  const path = d.node.path;
  const { pathToFileURL } = d.node.url;
  const fs = d.node.fs;
  const fsSync = d.node.fsSync;
  const crypto = d.node.crypto;
  const http = d.node.http;
  const { execFile } = d.node.childProcess;
  const { IS_MAC, IS_WIN, GLASS_FALLBACK, APP_URL, APP_ORIGIN, API_BASE } = d.env;
  const localStore = d.localStore;
  const macFiles = d.macFiles;
  const chromeSync = d.chromeSync;
  const localSystem = d.localSystem;
  const appDock = d.appDock;
  const localApprovals = d.localApprovals;
  const ownedBrowserAct = d.ownedBrowserAct;
  const agentRecentVisits = d.agentRecentVisits;
  const { broadcastToAllWindows } = require("../services/initializeElectronServices.cjs");
  const overlayConstants = d.constants;
  const {
    OVERLAY_WIDTH, OVERLAY_MIN_HEIGHT, OVERLAY_BUBBLE, MENU_WIDTH, MENU_GAP,
    MENU_MIN_HEIGHT, MENU_MAX_HEIGHT, PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT,
  } = overlayConstants;
  const capturePrimaryScreen = (...a) => d.capturePrimaryScreen(...a);
  const createMainWindow = (...a) => d.createMainWindow(...a);
  const ensureScreenRecordingAccess = (...a) => d.ensureScreenRecordingAccess(...a);
  const getActiveBrowserTarget = (...a) => d.getActiveBrowserTarget(...a);
  const getAuthToken = (...a) => d.getAuthToken(...a);
  const getBrowserPageText = (...a) => d.getBrowserPageText(...a);
  const microphoneStatus = (...a) => d.microphoneStatus(...a);
  const onboardingMarkerPath = (...a) => d.onboardingMarkerPath(...a);
  const onboardingScreenStatus = (...a) => d.onboardingScreenStatus(...a);
  const openMicrophoneSettings = (...a) => d.openMicrophoneSettings(...a);
  const openScreenPrivacySettings = (...a) => d.openScreenPrivacySettings(...a);
  const probeScreenRecordingTcc = (...a) => d.probeScreenRecordingTcc(...a);
  const screenCaptureStatus = (...a) => d.screenCaptureStatus(...a);
  const withPermissionPrompt = (...a) => d.withPermissionPrompt(...a);

  // Signed-in check: the main window holds the Supabase session (localStorage),
  // so a live token read is the source of truth.
  ipcMain.handle("lykn:onboarding-auth-status", async () => {
    const token = await getAuthToken();
    return !!token;
  });

  ipcMain.on("lykn:onboarding-open-sign-in", () => {
    if (!d.mainWindow || d.mainWindow.isDestroyed()) createMainWindow();
    d.mainWindow.show();
    d.mainWindow.focus();
    // Keep the walkthrough visible next to the sign-in window so the user
    // comes back to it naturally once the auth badge flips.
    if (d.onboardingWindow && !d.onboardingWindow.isDestroyed()) {
      d.onboardingWindow.showInactive();
    }
  });

  ipcMain.handle("lykn:onboarding-mic-status", () => microphoneStatus());

  ipcMain.handle("lykn:onboarding-request-mic", async () => {
    try {
      const status = microphoneStatus();
      if (status === "granted") return true;
      if (IS_MAC) {
        if (status === "not-determined") {
          return await withPermissionPrompt("microphone", () =>
            systemPreferences.askForMediaAccess("microphone"),
          );
        }
        openMicrophoneSettings();
        return false;
      }
      // Windows: open Settings so the user can allow LYKN; getUserMedia also
      // prompts the first time voice/dictation runs.
      openMicrophoneSettings();
      return microphoneStatus() === "granted";
    } catch {
      return false;
    }
  });

  ipcMain.on("lykn:onboarding-open-mic-settings", () => {
    openMicrophoneSettings();
  });

  ipcMain.handle("lykn:onboarding-screen-status", () => onboardingScreenStatus());

  ipcMain.handle("lykn:onboarding-request-screen", async () => {
    // Attempting a capture is what makes macOS show the Screen Recording prompt
    // and register LYKN in the privacy list. On Windows it's a connectivity check.
    if (IS_MAC) {
      const access = await ensureScreenRecordingAccess();
      return access.status;
    }
    try {
      const dataUrl = await capturePrimaryScreen();
      d.screenProbeCache = dataUrl ? "granted" : "denied";
      return d.screenProbeCache;
    } catch {
      d.screenProbeCache = "denied";
      return "denied";
    }
  });

  ipcMain.on("lykn:onboarding-open-screen-settings", () => {
    // Fire-and-forget: probe first so LYKN is in the TCC list, then open Settings.
    void (async () => {
      if (IS_MAC && screenCaptureStatus() !== "granted") {
        await withPermissionPrompt("screen", () => probeScreenRecordingTcc());
      }
      await openScreenPrivacySettings({ afterTccRegister: true });
    })();
  });

  ipcMain.on("lykn:onboarding-open-automation-settings", () => {
    if (!IS_MAC) return;
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    );
  });

  ipcMain.handle("lykn:onboarding-accessibility-status", () => {
    if (!IS_MAC) return "granted";
    try {
      return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch {
      return "unknown";
    }
  });

  ipcMain.handle("lykn:onboarding-request-accessibility", async () => {
    if (!IS_MAC) return "granted";
    try {
      await withPermissionPrompt("accessibility", async () => {
        systemPreferences.isTrustedAccessibilityClient(true);
      });
      return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch {
      return "unknown";
    }
  });

  ipcMain.on("lykn:onboarding-open-accessibility-settings", () => {
    if (!IS_MAC) return;
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  });

  ipcMain.handle("lykn:onboarding-test-apple-events", async () => {
    if (!IS_MAC) return { state: "granted", browser: null };
    const target = await getActiveBrowserTarget();
    if (!target) return { state: "no-browser" };
    const text = await getBrowserPageText(target.appName);
    if (text) return { state: "granted", browser: target.appName };
    // We had a browser/URL but couldn't read the DOM — almost always the toggle.
    return {
      state: "denied",
      browser: target.appName,
      message: "Enable 'Allow JavaScript from Apple Events'",
    };
  });

  ipcMain.on("lykn:onboarding-finish", async () => {
    try {
      await fs.writeFile(onboardingMarkerPath(), new Date().toISOString());
    } catch {
      /* non-fatal */
    }
    if (d.onboardingWindow && !d.onboardingWindow.isDestroyed()) d.onboardingWindow.close();
    if (d.mainWindow && !d.mainWindow.isDestroyed()) {
      d.mainWindow.show();
      d.mainWindow.focus();
    }
  });
}

module.exports = { registerOnboardingIpc };
