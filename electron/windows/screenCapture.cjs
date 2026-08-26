"use strict";

function attachScreenCapture(d) {
  if (d.__attached_attachScreenCapture) return;
  d.__attached_attachScreenCapture = true;
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
    OVERLAY_WIDTH, OVERLAY_SIDE_WIDTH, OVERLAY_WATCH_SIDE_WIDTH, OVERLAY_MAX_WIDTH,
    OVERLAY_MIN_HEIGHT, OVERLAY_BOTTOM_MARGIN, GLASS_CORNER_RADIUS, OVERLAY_BUBBLE,
    OVERLAY_ACTIVATABLE_FOR_DROPS, MENU_WIDTH, MENU_GAP, MENU_MIN_HEIGHT, MENU_MAX_HEIGHT,
    PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT, LIVE_WIDTH, LIVE_HEIGHT,
    PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, UPDATE_REPROMPT_MS,
  } = overlayConstants;
  const ELECTRON_DIR = path.join(__dirname, "..");

async function withPermissionPrompt(_label, fn) {
  const prev = d.permissionPromptChain;
  let release;
  d.permissionPromptChain = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
  }
}

function isAutomationDeniedError(msg) {
  return /-1743|not authoriz|not allowed to send|user declined|osascript is not allowed/i.test(
    String(msg || ""),
  );
}

function screenCaptureStatus() {
  if (IS_MAC) {
    try {
      return systemPreferences.getMediaAccessStatus("screen");
    } catch {
      return "unknown";
    }
  }
  return d.screenProbeCache === "denied" ? "denied" : "granted";
}

function onboardingScreenStatus() {
  if (IS_MAC) return screenCaptureStatus();
  return d.screenProbeCache || "not-determined";
}

function microphoneStatus() {
  try {
    if (typeof systemPreferences.getMediaAccessStatus === "function") {
      return systemPreferences.getMediaAccessStatus("microphone");
    }
  } catch {
    /* fall through */
  }
  // Unknown OS / API — don't block; getUserMedia will prompt if needed.
  return IS_MAC ? "unknown" : "not-determined";
}

function openMicrophoneSettings() {
  if (IS_MAC) {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
    return;
  }
  if (IS_WIN) {
    shell.openExternal("ms-settings:privacy-microphone");
    return;
  }
}

async function openScreenPrivacySettings({ afterTccRegister = false } = {}) {
  if (IS_MAC) {
    if (afterTccRegister) {
      await new Promise((r) => setTimeout(r, 700));
    }
    // Ventura+ Settings app; fall back to the legacy pref-pane URL.
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
      );
    } catch {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    }
    return;
  }
  // Windows has no Screen Recording TCC pane like macOS; privacy hub is closest.
  if (IS_WIN) {
    shell.openExternal("ms-settings:privacy");
  }
}

async function probeScreenRecordingTcc() {
  try {
    await Promise.race([
      capturePrimaryScreen({ maxWidth: 320, format: "jpeg", quality: 40 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("screen-permission-prompt-timeout")), 10000),
      ),
    ]);
  } catch (e) {
    // Expected until the user allows; timeout avoids hanging forever on some OS/Electron builds.
    if (!String(e?.message || e).includes("screen-permission-prompt-timeout")) {
      console.log("[screen] permission probe:", e?.message || e);
    }
  }
}

async function ensureScreenRecordingAccess() {
  if (!IS_MAC) {
    const st = screenCaptureStatus();
    return { ok: st !== "denied", status: st };
  }

  let status = screenCaptureStatus();
  if (status === "granted") return { ok: true, status };

  // Mutex keeps this from stacking with Mic / Automation prompts.
  // Always probe first — even when status already looks denied — so TCC has
  // registered the app before we open Settings.
  return withPermissionPrompt("screen", async () => {
    status = screenCaptureStatus();
    if (status === "granted") return { ok: true, status };

    await probeScreenRecordingTcc();

    status = screenCaptureStatus();
    if (status === "granted") return { ok: true, status, prompted: true };

    if (status === "denied" || status === "restricted") {
      // Probe above registered LYKN with TCC; wait before opening so the list is fresh.
      await openScreenPrivacySettings({ afterTccRegister: true });
      return { ok: false, status, needsSettings: true, prompted: true };
    }

    // Still not determined — system Allow dialog should be on screen.
    // Do NOT open Settings here; that races the dialog and shows a stale list
    // without LYKN until the user closes and reopens Settings.
    return { ok: false, status, prompted: true };
  });
}

function screenRecordingDeniedMessage({ needsSettings, prompted } = {}) {
  if (needsSettings) {
    return (
      "LYKN needs Screen Recording permission. Open System Settings → Privacy & Security → " +
      "Screen Recording, turn on LYKN, then quit and reopen LYKN."
    );
  }
  if (prompted) {
    return (
      "macOS should be asking for Screen Recording permission — click Allow in that dialog, " +
      "then send your message again. If you don’t see a dialog, open System Settings → " +
      "Privacy & Security → Screen Recording, enable LYKN, then quit and reopen LYKN."
    );
  }
  return (
    "LYKN needs Screen Recording permission. Enable it in System Settings → Privacy & Security → " +
    "Screen Recording, then quit and reopen LYKN."
  );
}

function closeSnipWindow() {
  if (d.snipWindow && !d.snipWindow.isDestroyed()) {
    try { d.snipWindow.close(); } catch (_) { /* ignore */ }
  }
  d.snipWindow = null;
}

function captureInteractiveSnip() {
  return new Promise(async (resolve) => {
    if (d.snipResolver) {
      // Only one snip at a time.
      resolve(null);
      return;
    }
    const display = getTargetCaptureDisplay();
    const { bounds, scaleFactor } = display;
    const physW = Math.round(bounds.width * scaleFactor);
    const physH = Math.round(bounds.height * scaleFactor);

    let fullImage = null;
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: physW, height: physH },
      });
      const primary =
        sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      if (primary && !primary.thumbnail.isEmpty()) fullImage = primary.thumbnail;
    } catch (e) {
      console.error("[LYKN] snip capture failed:", e && e.message);
    }
    if (!fullImage) {
      resolve(null);
      return;
    }

    d.snipResolver = (rect) => {
      const done = d.snipResolver;
      d.snipResolver = null;
      closeSnipWindow();
      if (!rect || !done) {
        resolve(null);
        return;
      }
      try {
        const size = fullImage.getSize();
        // Map selection (physical px of the snip window) onto the bitmap.
        const sx = size.width / physW;
        const sy = size.height / physH;
        const crop = {
          x: Math.max(0, Math.round(rect.x * sx)),
          y: Math.max(0, Math.round(rect.y * sy)),
          width: Math.max(1, Math.round(rect.width * sx)),
          height: Math.max(1, Math.round(rect.height * sy)),
        };
        if (crop.x + crop.width > size.width) crop.width = size.width - crop.x;
        if (crop.y + crop.height > size.height) crop.height = size.height - crop.y;
        if (crop.width < 4 || crop.height < 4) {
          resolve(null);
          return;
        }
        const cropped = fullImage.crop(crop);
        resolve({
          kind: "image",
          name: "Screenshot.png",
          dataUrl: cropped.toDataURL(),
        });
      } catch (e) {
        console.error("[LYKN] snip crop failed:", e && e.message);
        resolve(null);
      }
    };

    d.snipWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      focusable: true,
      show: false,
      webPreferences: {
        preload: path.join(ELECTRON_DIR, "snip-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    d.snipWindow.setAlwaysOnTop(true, "screen-saver");
    d.snipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    d.snipWindow.loadFile(path.join(ELECTRON_DIR, "snip.html"));
    d.snipWindow.once("ready-to-show", () => {
      if (d.snipWindow && !d.snipWindow.isDestroyed()) {
        d.snipWindow.show();
        d.snipWindow.focus();
      }
    });
    d.snipWindow.on("closed", () => {
      d.snipWindow = null;
      if (d.snipResolver) {
        const r = d.snipResolver;
        d.snipResolver = null;
        r(null);
      }
    });
  });
}

function getTargetCaptureDisplay() {
  try {
    if (d.overlayWindow && !d.overlayWindow.isDestroyed()) {
      const b = d.overlayWindow.getBounds();
      return screen.getDisplayNearestPoint({
        x: b.x + Math.round(b.width / 2),
        y: b.y + Math.round(b.height / 2),
      });
    }
  } catch (_) {
    /* fall through */
  }
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch (_) {
    /* fall through */
  }
  return screen.getPrimaryDisplay();
}

async function capturePrimaryScreen({ maxWidth, format = "png", quality = 80 } = {}) {
  const display = getTargetCaptureDisplay();
  const scale = Number(display.scaleFactor) || 1;
  const dipW = Math.max(1, display.bounds.width);
  const dipH = Math.max(1, display.bounds.height);
  const physW = Math.max(1, Math.round(dipW * scale));
  const physH = Math.max(1, Math.round(dipH * scale));
  const aspect = physH / physW;
  // When a caller only needs a smaller image (e.g. the browser thumbnail), ask
  // the compositor for it directly instead of grabbing full Retina and
  // downscaling — capturing fewer pixels is meaningfully faster.
  const cap = maxWidth ? Math.min(physW, maxWidth) : Math.min(physW, 2560);
  const rawWidths = maxWidth
    ? [cap, Math.round(cap * 0.8), Math.min(960, cap)]
    : [cap, Math.min(2048, cap), Math.min(1600, cap), Math.min(1280, cap), 960];
  const widths = [...new Set(rawWidths.map((w) => Math.max(320, Math.round(w))))];
  const sizes = widths.map((width) => ({
    width,
    height: Math.max(1, Math.round(width * aspect)),
  }));

  let lastErr = null;
  for (const thumbnailSize of sizes) {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
      const matched =
        sources.find((s) => String(s.display_id) === String(display.id)) ||
        sources.find((s) => {
          // Some Electron builds leave display_id blank — pick the source whose
          // thumbnail aspect is closest to the target display.
          if (!s || s.thumbnail.isEmpty()) return false;
          const sz = s.thumbnail.getSize();
          if (!sz.width || !sz.height) return false;
          const a = sz.height / sz.width;
          return Math.abs(a - aspect) < 0.08;
        }) ||
        sources[0];
      if (matched && !matched.thumbnail.isEmpty()) {
        // JPEG is 5–10× smaller than PNG for a screenshot — much faster to upload
        // and for the vision model to ingest, at no meaningful cost to OCR quality.
        if (format === "jpeg") {
          return `data:image/jpeg;base64,${matched.thumbnail.toJPEG(quality).toString("base64")}`;
        }
        return matched.thumbnail.toDataURL();
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) console.error("[LYKN] screen capture failed:", lastErr.message);
  return null;
}

async function captureBrowserScreenThumbnail() {
  if (screenCaptureStatus() !== "granted") return "";
  try {
    const dataUrl = await capturePrimaryScreen({ maxWidth: 1280 });
    if (!dataUrl) return "";
    const img = nativeImage.createFromDataURL(dataUrl);
    const { width } = img.getSize();
    const resized = width > 1280 ? img.resize({ width: 1280 }) : img;
    const jpeg = resized.toJPEG(70);
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return "";
  }
}

  d.captureBrowserScreenThumbnail = captureBrowserScreenThumbnail;
  d.captureInteractiveSnip = captureInteractiveSnip;
  d.capturePrimaryScreen = capturePrimaryScreen;
  d.closeSnipWindow = closeSnipWindow;
  d.ensureScreenRecordingAccess = ensureScreenRecordingAccess;
  d.getTargetCaptureDisplay = getTargetCaptureDisplay;
  d.isAutomationDeniedError = isAutomationDeniedError;
  d.microphoneStatus = microphoneStatus;
  d.onboardingScreenStatus = onboardingScreenStatus;
  d.openMicrophoneSettings = openMicrophoneSettings;
  d.openScreenPrivacySettings = openScreenPrivacySettings;
  d.probeScreenRecordingTcc = probeScreenRecordingTcc;
  d.screenCaptureStatus = screenCaptureStatus;
  d.screenRecordingDeniedMessage = screenRecordingDeniedMessage;
  d.withPermissionPrompt = withPermissionPrompt;
}

module.exports = { attachScreenCapture };
