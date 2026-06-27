// LYKN desktop shell (macOS) — v1 "web wrapper".
//
// This is intentionally a thin native shell that loads the live web app from
// APP_URL, exactly like the Capacitor iOS shell loads lykn.io. The whole
// point of v1 is to prove the download → install → notarize → auto-update
// pipeline end-to-end before we layer the ⌘+L screen-reading overlay on top.
//
// Forward-looking hooks (the Jarvis surface) are marked with TODO(jarvis) so
// the next pass has obvious seams: a transparent always-on-top overlay window,
// a global ⌘+L shortcut that captures the screen via desktopCapturer, and an
// IPC bridge that pipes captured frames into the app's existing OCR/vision
// pipeline (src/lib/ai/imageOcr.ts).

const {
  app,
  BrowserWindow,
  shell,
  globalShortcut,
  Menu,
  ipcMain,
  desktopCapturer,
  screen,
  systemPreferences,
  dialog,
  nativeImage,
  clipboard,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const {
  collectBrowserInteractables,
  collectBrowserPageContext,
  executeBrowserActions,
  executeAdaptiveBrowserTask,
  resolvePlanActions,
  userWantsSearchOrType,
  screenFingerprint,
} = require("./browserAct.cjs");
const { screenDiffRatio, textSimilarity } = require("../lib/browserScreen.cjs");
const { startExtensionBridge } = require("./extensionBridge.cjs");
const {
  installExtensionOneClick,
  getExtensionInstallMode,
  getUserExtensionDir,
} = require("./extensionInstaller.cjs");

const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
};
const TEXT_FILE_RE =
  /\.(txt|md|markdown|csv|json|xml|ya?ml|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|css|html?|sh|sql|log)$/i;

// The live web app. Override with LYKN_APP_URL=http://localhost:5173 to point
// the shell at a local dev server instead of production.
const APP_URL = process.env.LYKN_APP_URL || "https://lykn.io";
const APP_ORIGIN = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return "https://lykn.io";
  }
})();

// LYKN AI backend (the streaming chat endpoint the web app uses). Override with
// LYKN_API_URL=http://localhost:3001 when testing against a local backend.
const API_BASE = process.env.LYKN_API_URL || "https://api.lykn.io";

// Friendly fallback labels for tool-call events that arrive without a server
// status string. Mirrors the web app's voice-mode TOOL_STATUS_COPY so the
// overlay's thinking indicator reads the same as the rest of LYKN.
const TOOL_STATUS_LABELS = {
  search_vault: "Searching your vault…",
  read_document: "Reading the document…",
  display_document: "Pulling that up…",
  web_search: "Searching the web…",
  web_fetch: "Reading the page…",
  find_connections: "Finding connections…",
  get_beliefs: "Reviewing your beliefs…",
  get_rules: "Checking your rules…",
  get_facts: "Recalling what it knows…",
  propose_fact: "Making a note of that…",
  list_projects: "Looking through your projects…",
  get_project_state: "Checking the project…",
  set_active_project: "Switching projects…",
  create_project: "Starting a new project…",
  update_project_state: "Updating the project…",
  get_recent_activity: "Catching up on recent activity…",
  create_reminder: "Setting a reminder…",
  list_reminders: "Checking your reminders…",
  update_reminder: "Updating the reminder…",
  create_event: "Adding to your calendar…",
  list_events: "Checking your calendar…",
  update_event: "Updating the event…",
  delete_event: "Removing the event…",
  create_todo: "Adding a to-do…",
  list_todos: "Checking your to-dos…",
  update_todo: "Updating the to-do…",
  delete_todo: "Removing the to-do…",
  save_to_vault: "Saving to your vault…",
  add_to_project: "Adding it to the project…",
};

// Allow Cmd+Q / single-instance behaviour to feel native.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// OAuth provider origins we allow to open in-app (rather than the external
// browser) so the redirect can return to lykn.io with the session intact.
const AUTH_HOST_SUFFIXES = [
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "github.com",
  "supabase.co",
  "supabase.in",
];

function isAuthOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return AUTH_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
  } catch {
    return false;
  }
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let overlayWindow = null;
// NOTE: macOS non-activating panels (`type: 'panel'`) won't receive OS file
// drops — the drag falls behind the bar. We tried dropping the panel type to
// make the window activatable + drop-capable, but that breaks float-over-
// everything (the bar sinks behind other windows). So the panel type stays, and
// adding files goes through the in-bar attach button / native picker instead.
const OVERLAY_ACTIVATABLE_FOR_DROPS = false;
/** @type {BrowserWindow | null} */
let burstWindow = null;
let burstHideTimer = null;
let burstWindowWarmed = false;
let browserExecuteInFlight = false;
/** @type {BrowserWindow | null} */
let onboardingWindow = null;
/** @type {BrowserWindow | null} */
let extensionInstallWindow = null;
let overlayVisibleBeforeExtensionInstall = false;

// Once the user drags the bar we stop auto-centering it. We anchor by the
// BOTTOM-RIGHT corner so the chat column stays put as answers stream in (grows
// up) and as the left source panel opens/closes (grows left).
let overlayUserPositioned = false;
let overlayAnchorLeft = null;
let overlayAnchorBottomY = null;
let overlayProgrammaticMove = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#000000",
    titleBarStyle: "hiddenInset",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // We load a trusted first-party origin (lykn.io). Keep the renderer
      // sandboxed; any native capability is exposed explicitly via preload.
      sandbox: true,
    },
  });

  // Avoid a white flash before the remote app paints.
  mainWindow.once("ready-to-show", () => mainWindow && mainWindow.show());

  mainWindow.loadURL(APP_URL);

  // New windows / target=_blank links: keep OAuth + same-origin flows inside
  // the app, but send genuinely external links (docs, third-party sites) out
  // to the user's real browser. Crucially we do NOT intercept top-level
  // navigations (see note below) so the full-page OAuth redirect to Google and
  // back to lykn.io completes in-window and Supabase can store the session.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const origin = new URL(url).origin;
      if (origin === APP_ORIGIN || isAuthOrigin(origin)) {
        return { action: "allow" };
      }
      shell.openExternal(url);
      return { action: "deny" };
    } catch {
      return { action: "allow" };
    }
  });

  // NOTE: we intentionally do not redirect off-origin top-level navigations to
  // the external browser. Supabase OAuth is a full-page redirect through the
  // provider (accounts.google.com, …) back to lykn.io; bouncing it out to the
  // system browser is what stranded sign-in there instead of in the app.

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Grant the renderer the permissions the web app already uses (microphone for
// voice mode, etc.) but only for our own origin. Everything else is denied.
function installPermissionHandler() {
  const ses = require("electron").session.defaultSession;
  const ALLOWED = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "notifications"]);
  const isOverlayContents = (webContents) =>
    overlayWindow && !overlayWindow.isDestroyed() && webContents === overlayWindow.webContents;
  const originAllowed = (webContents) => {
    try {
      return new URL(webContents.getURL()).origin === APP_ORIGIN;
    } catch {
      return false;
    }
  };
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    // The overlay loads from file:// (no http origin) but is our own trusted
    // window — allow it the same media (mic) access for dictation.
    const allow = ALLOWED.has(permission) && (originAllowed(webContents) || isOverlayContents(webContents));
    callback(allow);
  });
  // Some getUserMedia paths consult the synchronous check handler too.
  ses.setPermissionCheckHandler((webContents, permission) => {
    return ALLOWED.has(permission) && (originAllowed(webContents) || isOverlayContents(webContents));
  });
}

// Enable system ("loopback") audio capture for the overlay's live-listen mode.
// When the overlay calls navigator.mediaDevices.getDisplayMedia({audio:true}),
// this handler hands back a screen video source plus loopback audio, which on
// macOS 13+ is captured via ScreenCaptureKit — no virtual audio device needed.
// The overlay only uses the audio track (to transcribe meetings/conversations).
function setupSystemAudioCapture() {
  const ses = require("electron").session.defaultSession;
  if (typeof ses.setDisplayMediaRequestHandler !== "function") return;
  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        if (!sources.length) return callback({});
        callback({ video: sources[0], audio: "loopback" });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

/* ------------------------------------------------------------------ */
/*  Jarvis overlay — ⌘+L summons a transparent always-on-top window     */
/*  that reads the screen behind it.                                    */
/* ------------------------------------------------------------------ */

const OVERLAY_WIDTH = 520; // the chat column
const OVERLAY_SIDE_WIDTH = 300; // side panels (sources, etc.)
const OVERLAY_WATCH_SIDE_WIDTH = 360; // wider live-watch feed panel
const OVERLAY_MAX_WIDTH = OVERLAY_WIDTH + OVERLAY_WATCH_SIDE_WIDTH;
const OVERLAY_MIN_HEIGHT = 82;
const OVERLAY_BOTTOM_MARGIN = 90;

function overlayPosition(height) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - height - OVERLAY_BOTTOM_MARGIN),
  };
}

function createOverlayWindow() {
  const pos = overlayPosition(OVERLAY_MIN_HEIGHT);
  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_MIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    // Real background blur of the desktop behind the panel comes from native
    // macOS vibrancy (NSVisualEffectView) — CSS backdrop-filter can't blur the
    // desktop behind a transparent window. With transparent:false + roundedCorners
    // macOS clips the vibrancy material to a rounded rect, giving a clean floating
    // glass panel instead of a square blurred rectangle.
    transparent: process.platform === "darwin" ? false : true,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin"
      ? { vibrancy: "hud", visualEffectState: "active", roundedCorners: true }
      : {}),
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Let the panel respond to the first click/drag without being activated
    // first, so file drops register even though it's a non-activating panel.
    acceptFirstMouse: true,
    // Float above everything, including full-screen apps.
    alwaysOnTop: true,
    // macOS: a non-activating panel can become key for text input WITHOUT
    // activating the app, so summoning it never yanks the user to LYKN's Space
    // or out of the full-screen app they're in. We drop the panel type when
    // OVERLAY_ACTIVATABLE_FOR_DROPS is on so the window can accept OS file drops.
    ...(process.platform === "darwin" && !OVERLAY_ACTIVATABLE_FOR_DROPS
      ? { type: "panel" }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  // Exclude the overlay itself from screen capture (NSWindowSharingNone on
  // macOS / WDA_EXCLUDEFROMCAPTURE on Windows). The user still sees the glass
  // bar, but our own screenshots — and any other screen recording/share — won't
  // include it, so LYKN never "sees" its own chat window when reading the screen.
  // User-toggleable + persisted; defaults ON.
  overlayWindow.setContentProtection(isContentProtectionEnabled());
  // canJoinAllSpaces + fullScreenAuxiliary so the panel appears on the CURRENT
  // Space (over full-screen apps too); skipTransformProcessType stops macOS
  // from switching Spaces when it shows.
  overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));

  // When the user drags the bar (native drag region), remember where they put
  // it so we stop re-centering it. Ignore our own programmatic moves.
  overlayWindow.on("moved", () => {
    if (overlayProgrammaticMove || !overlayWindow) return;
    const b = overlayWindow.getBounds();
    overlayUserPositioned = true;
    overlayAnchorLeft = b.x;
    overlayAnchorBottomY = b.y + b.height;
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

// Grow/shrink the bar as the answer streams in. By default it stays pinned
// bottom-center; once the user has dragged it, we keep their X and anchor the
// bottom edge so it grows upward in place.
// Collapse the whole panel down to a small LYKN icon "bubble" (and back). The
// bubble stays centered on where the panel was and keeps its bottom edge, so it
// doesn't jump across the screen. While collapsed we ignore height reports.
const OVERLAY_BUBBLE = 54;
let overlayCollapsed = false;

function setOverlayCollapsed(collapsed) {
  if (!overlayWindow) return;
  overlayCollapsed = !!collapsed;
  const { workArea } = screen.getPrimaryDisplay();
  const b = overlayWindow.getBounds();
  const w = collapsed ? OVERLAY_BUBBLE : OVERLAY_WIDTH;
  const h = collapsed ? OVERLAY_BUBBLE : OVERLAY_MIN_HEIGHT;
  // Keep the bottom-left corner fixed across the swap so the chat column stays
  // put (it lives on the left; the bubble takes the chat's bottom-left spot).
  const left = b.x;
  const bottom = b.y + b.height;
  let x = left;
  let y = bottom - h;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - w));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));

  if (!collapsed) {
    // Anchor future growth to where the panel reappears.
    overlayUserPositioned = true;
    overlayAnchorLeft = x;
    overlayAnchorBottomY = y + h;
  }

  overlayProgrammaticMove = true;
  overlayWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  overlayProgrammaticMove = false;
}

// Size the window to the renderer-reported content. Width varies with side panels;
// we anchor the chat column's left edge so it never shifts when panels open.
function setOverlaySize(width, height) {
  if (!overlayWindow || overlayCollapsed) return;
  const w = Math.max(OVERLAY_WIDTH, Math.min(Math.round(width || OVERLAY_WIDTH), OVERLAY_MAX_WIDTH));
  const h = Math.max(OVERLAY_MIN_HEIGHT, Math.min(Math.round(height), 760));
  const { workArea } = screen.getPrimaryDisplay();

  let chatLeft;
  let bottom;
  if (overlayUserPositioned && overlayAnchorLeft != null && overlayAnchorBottomY != null) {
    chatLeft = overlayAnchorLeft;
    bottom = overlayAnchorBottomY;
  } else {
    chatLeft = Math.round(workArea.x + workArea.width / 2 - OVERLAY_WIDTH / 2);
    bottom = workArea.y + workArea.height - OVERLAY_BOTTOM_MARGIN;
  }
  const x = chatLeft;
  let y = bottom - h;
  const clampedX = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - w));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));

  overlayProgrammaticMove = true;
  overlayWindow.setBounds({ x: Math.round(clampedX), y: Math.round(y), width: w, height: h });
  overlayProgrammaticMove = false;
}

function hideOverlay() {
  if (overlayWindow && overlayWindow.isVisible()) overlayWindow.hide();
  // Tear down the full-screen "LYKN is on" glass alongside the bar.
  hideOverlayGlass();
}

function setOverlayClickThrough(enabled) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    overlayWindow.setIgnoreMouseEvents(!!enabled, enabled ? { forward: true } : undefined);
  } catch (_) {}
}

async function withOverlayHiddenForClick(fn) {
  const vis = overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
  if (vis) overlayWindow.hide();
  await new Promise((r) => setTimeout(r, 200));
  try {
    return await fn();
  } finally {
    if (vis && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.moveTop();
    }
  }
}

// Returns 'granted' | 'denied' | 'not-determined' | 'restricted'. On non-mac
// platforms screen capture needs no explicit permission.
function screenCaptureStatus() {
  if (process.platform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

// Capture the primary display and return a PNG data URL. desktopCapturer fails
// ("Failed to get sources") when asked for a very large thumbnail (e.g. full
// Retina resolution), so we try a ladder of decreasing sizes and take the
// first that succeeds — sharp when possible, reliable always.
async function capturePrimaryScreen({ maxWidth, format = "png", quality = 80 } = {}) {
  const display = screen.getPrimaryDisplay();
  const { width: w, height: h } = display.size;
  const aspect = h / w;
  // When a caller only needs a smaller image (e.g. the browser thumbnail), ask
  // the compositor for it directly instead of grabbing 2048px and downscaling —
  // capturing fewer pixels is meaningfully faster.
  const cap = maxWidth ? Math.min(w, maxWidth) : Math.min(w, 2048);
  const widths = maxWidth
    ? [cap, Math.round(cap * 0.8), 960]
    : [cap, 1600, 1280, 960];
  const sizes = widths.map((width) => ({ width, height: Math.round(width * aspect) }));

  let lastErr = null;
  for (const thumbnailSize of sizes) {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
      const primary =
        sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      if (primary && !primary.thumbnail.isEmpty()) {
        // JPEG is 5–10× smaller than PNG for a screenshot — much faster to upload
        // and for the vision model to ingest, at no meaningful cost to OCR quality.
        if (format === "jpeg") {
          return `data:image/jpeg;base64,${primary.thumbnail.toJPEG(quality).toString("base64")}`;
        }
        return primary.thumbnail.toDataURL();
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

// ── "LYKN is on" glass ───────────────────────────────────────────────────
// A full-screen, transparent, click-through window that fades in a subtle
// frosted-glass wash (pink→blue, with a glowing rim) across the WHOLE screen
// while the overlay is active — an unmistakable "LYKN is live" cue. It sits
// behind the glass bar, never steals focus, and stays up until the overlay is
// dismissed (then hideOverlayGlass() fades it out).
function createBurstWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  burstWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Same panel treatment as the overlay so it floats over full-screen apps
    // and Spaces without yanking focus.
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the renderer hot so the first summon doesn't pay a wake-up cost.
      backgroundThrottling: false,
    },
  });

  // Below the overlay (screen-saver) so the glass bar stays crisp on top, but
  // above everything else on screen.
  burstWindow.setAlwaysOnTop(true, "pop-up-menu");
  // Clicks pass straight through to whatever is underneath.
  burstWindow.setIgnoreMouseEvents(true, { forward: true });
  // Keep our own screen reads from capturing the flash.
  try { burstWindow.setContentProtection(true); } catch (_) {}
  burstWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  burstWindow.loadFile(path.join(__dirname, "burst.html"));

  // Warm-up: run the full burst animation ONCE while the window is parked
  // entirely off-screen (so it's invisible) — this forces the renderer to
  // actually rasterize the blurred color layers + noise tiles, so the first
  // real ⌘+L has everything cached and doesn't hitch.
  burstWindow.webContents.once("did-finish-load", () => {
    if (!burstWindow || burstWindow.isDestroyed() || burstWindowWarmed) return;
    burstWindowWarmed = true;
    try {
      const { bounds } = screen.getPrimaryDisplay();
      // Park the window one full screen-height above the display.
      burstWindow.setBounds({
        x: bounds.x,
        y: bounds.y - bounds.height - 120,
        width: bounds.width,
        height: bounds.height,
      });
      burstWindow.setIgnoreMouseEvents(true, { forward: true });
      burstWindow.showInactive();
      burstWindow.webContents
        .executeJavaScript("window.__lyknBurst && window.__lyknBurst();", true)
        .catch(() => {});
      setTimeout(() => {
        if (!burstWindow || burstWindow.isDestroyed()) return;
        burstWindow.webContents
          .executeJavaScript("window.__lyknBurstOff && window.__lyknBurstOff();", true)
          .catch(() => {});
        burstWindow.hide();
      }, 1500);
    } catch (_) {
      /* warm-up is best-effort */
    }
  });

  burstWindow.on("closed", () => {
    burstWindow = null;
  });
}

function playOverlayBurst() {
  try {
    if (!burstWindow || burstWindow.isDestroyed()) createBurstWindow();
    // Re-cover the (possibly changed) primary display each time.
    const { bounds } = screen.getPrimaryDisplay();
    burstWindow.setBounds(bounds);
    burstWindow.setIgnoreMouseEvents(true, { forward: true });
    // Show without activating so the overlay keeps key focus for typing.
    burstWindow.showInactive();
    const fire = () => {
      if (!burstWindow || burstWindow.isDestroyed()) return;
      burstWindow.webContents
        .executeJavaScript("window.__lyknBurst && window.__lyknBurst();", true)
        .catch(() => {});
    };
    if (burstWindow.webContents.isLoading()) {
      burstWindow.webContents.once("did-finish-load", fire);
    } else {
      fire();
    }
    // The glass PERSISTS while the overlay is active (it's the "LYKN is on"
    // cue); the one-shot color burst plays once on summon (see burst.html).
    // hideOverlayGlass() fades everything out when the overlay is dismissed.
    if (burstHideTimer) {
      clearTimeout(burstHideTimer);
      burstHideTimer = null;
    }
  } catch (_) {
    /* the burst is purely cosmetic — never block showing the overlay */
  }
}

// Fade the full-screen glass back out, then hide its window once the CSS
// transition has finished. Called whenever the overlay is dismissed.
function hideOverlayGlass() {
  try {
    if (!burstWindow || burstWindow.isDestroyed()) return;
    burstWindow.webContents
      .executeJavaScript("window.__lyknBurstOff && window.__lyknBurstOff();", true)
      .catch(() => {});
    if (burstHideTimer) clearTimeout(burstHideTimer);
    burstHideTimer = setTimeout(() => {
      burstHideTimer = null;
      if (burstWindow && !burstWindow.isDestroyed()) burstWindow.hide();
    }, 360);
  } catch (_) {
    /* purely cosmetic */
  }
}

// ⌘+L: toggle the floating glass bar. Screen capture happens silently at ask
// time (see streamScreenAnswer) so the bar always reflects the live screen and
// the user never sees the screenshot.
function showOverlay() {
  if (!overlayWindow) createOverlayWindow();
  // Re-assert top-of-stack status on EVERY show. The level/ordering set at
  // creation can be lost after an app restart, a Space switch, or a full-screen
  // transition — which is why the panel sometimes appeared *behind* other
  // always-on-top windows (e.g. the main window) instead of coming all the way
  // forward. Re-applying the level + moveTop() forces it to the front again.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  // Re-assert content protection on every show — like the window level, it can
  // be dropped after a restart or Space/full-screen transition.
  applyContentProtection();
  // Fade in the full-screen glass behind the bar so the user gets an
  // unmistakable "LYKN is on" cue for as long as the overlay is up.
  playOverlayBurst();
  overlayWindow.show();
  // Re-assert top-of-stack so the glass bar stays above the burst flash.
  overlayWindow.moveTop();
  overlayWindow.focus();
  overlayWindow.webContents.send("lykn:overlay-shown");
}

function toggleOverlay() {
  if (overlayWindow && overlayWindow.isVisible()) {
    hideOverlay();
    return;
  }
  showOverlay();
}

function registerGlobalHotkey() {
  globalShortcut.register("CommandOrControl+L", () => {
    toggleOverlay();
  });
}

// Strip the hidden control tags the chat models emit so they never leak into
// the overlay bubble (the web app strips these too, server-side prompt aside).
function stripHiddenTags(s) {
  return String(s || "")
    .replace(/<\/?(?:learned|reason|applied)>[\s\S]*?<\/(?:learned|reason|applied)>/gi, "")
    .replace(/<\/?(?:learned|reason|applied)\b[^>]*>/gi, "")
    .replace(/\[TAG_NOTES:[^\]]*\]/gi, "");
}

function parseJsonFromAiText(text) {
  const raw = stripHiddenTags(String(text || "")).trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchAiStreamCompletion(token, body, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/ai/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  if (!res.ok) {
    return { error: `LYKN backend error (${res.status})` };
  }
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/event-stream") || !res.body) {
    const data = await res.json().catch(() => null);
    const text = stripHiddenTags(data?.response || data?.answer || data?.text || "");
    return text.trim() ? { text } : { error: "Empty AI response" };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(t.indexOf(":") + 1).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (typeof j.t === "string") accumulated += j.t;
        else if (j.error) return { error: String(j.error) || "Stream error" };
      } catch {
        /* ignore keepalive */
      }
    }
  }
  const text = stripHiddenTags(accumulated).trim();
  return text ? { text } : { error: "Empty AI response" };
  } catch (e) {
    if (e && e.name === "AbortError") return { error: "Quiz solve timed out (60s)" };
    return { error: e && e.message ? e.message : "Stream request failed" };
  } finally {
    clearTimeout(timer);
  }
}

// Read the Supabase access token from the signed-in main window. The web app
// keeps it in localStorage (sb-<ref>-auth-token) and auto-refreshes it, so a
// live read is current. We attach it as a Bearer token exactly like the web
// app's installAuthFetch patch does, so /api/ai/stream authorizes the request.
async function getAuthToken() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const raw = await mainWindow.webContents.executeJavaScript(
      `(function () {
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
              const v = JSON.parse(localStorage.getItem(k) || 'null');
              const tok = v && (v.access_token || (v.currentSession && v.currentSession.access_token));
              if (tok) return tok;
            }
          }
        } catch (e) {}
        return null;
      })()`,
      true,
    );
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

// ── Overlay settings (small, synchronous JSON store) ───────────────────────
// Persists user toggles that must be known the instant the window is created
// (before any async IPC), so we read/write it synchronously. Currently holds
// `contentProtection` — whether the overlay is excluded from screen capture.

function overlaySettingsPath() {
  return path.join(app.getPath("userData"), "overlay-settings.json");
}

function readOverlaySettings() {
  try {
    return JSON.parse(fsSync.readFileSync(overlaySettingsPath(), "utf8")) || {};
  } catch {
    return {};
  }
}

function writeOverlaySettings(patch) {
  const next = { ...readOverlaySettings(), ...patch };
  try {
    fsSync.writeFileSync(overlaySettingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("[LYKN] failed to write overlay settings:", e?.message);
  }
  return next;
}

// Default ON: the overlay stays out of the user's own screen recordings/shares
// unless they explicitly turn it off.
function isContentProtectionEnabled() {
  const v = readOverlaySettings().contentProtection;
  return v === undefined ? true : !!v;
}

// Apply the current content-protection setting to every capture-excludable
// window. Safe to call repeatedly (we re-assert it on show).
function applyContentProtection(enabled) {
  const on = enabled === undefined ? isContentProtectionEnabled() : !!enabled;
  for (const win of [overlayWindow, burstWindow]) {
    try {
      if (win && !win.isDestroyed()) win.setContentProtection(on);
    } catch {
      /* platform may not support it (e.g. Linux) */
    }
  }
  return on;
}

const OVERLAY_IGNORE_NOTE =
  "IMPORTANT: Ignore LYKN's own interface in the image — a translucent floating " +
  "glass bar/panel (it may contain this same question, an input field, mic/send " +
  "buttons, a chevron, or a live transcript). It is NOT part of the user's screen. " +
  "Never describe, mention, quote, or refer to it; answer only about the actual " +
  "app/website content behind it.";

// ── Live Watch — continuous screen awareness ────────────────────────────────
// Captures the screen on a motion-aware schedule, diffs frames locally, and
// only calls the vision model when pixels meaningfully change. Maintains a
// rolling text summary injected into overlay chat + voice sessions.
const LIVE_WATCH_STATIC_MS = 2000; // 0.5 fps when static
const LIVE_WATCH_ACTIVE_MS = 500; // 2 fps when moderate motion
const LIVE_WATCH_BURST_MS = 200; // 5 fps during heavy motion
const LIVE_WATCH_BURST_DURATION_MS = 4000;
const LIVE_WATCH_VISION_MIN_MS = 2500; // min gap between vision calls
const LIVE_WATCH_DIFF_VISION = 0.04; // call vision above this diff
const LIVE_WATCH_DIFF_MOTION = 0.02; // treat as "something moved"
const LIVE_WATCH_DIFF_BURST = 0.12; // heavy motion → burst fps
const LIVE_WATCH_SUMMARY_MAX_AGE_MS = 45000;

// Vision only sees still JPEGs every ~1–2s — not video. Models often misread a
// frozen-looking gameplay frame as "paused"; this note goes in every live-watch prompt.
const LIVE_WATCH_SNAPSHOT_NOTE =
  "CRITICAL — HOW CAPTURE WORKS: You receive still screenshots every 1–2 seconds, NOT " +
  "live video. A frame that looks frozen or unchanged does NOT mean the user paused — " +
  "active games, videos, and apps often look static between snapshots. Only say paused, " +
  "idle, or stopped if you clearly see an explicit pause menu, pause icon, or PAUSED text " +
  "on screen. Never infer pause from a static-looking image alone.";

let liveWatchTimer = null;
let liveWatchCaptureInFlight = false;
let liveWatchVisionInFlight = false;
let liveWatchLastFingerprint = "";
let liveWatchLastFrameUrl = "";
let liveWatchLastVisionAt = 0;
let liveWatchBurstUntil = 0;
let liveWatchForceVision = false;
let liveWatchState = {
  enabled: false,
  summary: "",
  commentary: "",
  commentaryKind: "note", // note | alert
  at: 0,
  motionLevel: "static",
  lastDiff: 0,
  capturing: false,
  isNewCommentary: false,
  rules: [], // { id, text, createdAt }
  contextSource: "vision", // extension | scrape | vision
  extensionConnected: false,
  pageTitle: "",
  pageUrl: "",
};

let liveWatchTextInFlight = false;
let liveWatchForceTextPass = false;
let liveWatchPendingTextPass = false;
let liveWatchLastPageText = "";
let liveWatchLastPageSig = "";
let liveWatchLastPageUrl = "";
let liveWatchLastScrapeAt = 0;
const LIVE_WATCH_SCRAPE_MIN_MS = 3000;
const LIVE_WATCH_TEXT_MIN_MS = 2000;
const LIVE_WATCH_TEXT_CHANGE = 0.08; // ~8% text change triggers LLM

let extensionBridge = null;

let liveWatchLastRuleCheckAt = 0;
let liveWatchSettleUntil = 0;
let liveWatchPendingNavVision = false;
let liveWatchConsecutiveBurstFrames = 0;
const LIVE_WATCH_RULE_CHECK_MS = 3500;
const LIVE_WATCH_MAX_RULES = 8;
const LIVE_WATCH_CAPTURE_TIMEOUT_MS = 6000;
const LIVE_WATCH_VISION_TIMEOUT_MS = 35000;
const LIVE_WATCH_NAV_DIFF = 0.55; // full page/app switch — settle before re-reading
const LIVE_WATCH_NAV_SETTLE_MS = 1400;

function parseWatchRuleIntent(text) {
  const t = String(text || "").trim();
  const patterns = [
    /^(?:tell me|let me know|notify me|alert me|warn me|ping me)\s+when\s+(.+)$/i,
    /^watch\s+(?:for|out for)\s+(.+)$/i,
    /^(?:alert|notify)\s+(?:me\s+)?when\s+(.+)$/i,
    /^let me know if\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) return m[1].trim().replace(/[.?!]+$/, "");
  }
  return null;
}

function looksLikeClearWatchRules(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    /\b(clear|stop|cancel|remove|delete)\b.*\b(watch rules?|alerts?|notifications?)\b/.test(t) ||
    /^stop watching for\b/.test(t) ||
    /^clear watch\b/.test(t)
  );
}

function addLiveWatchRule(ruleText) {
  const text = String(ruleText || "").trim().slice(0, 200);
  if (!text) return null;
  const dupe = liveWatchState.rules.some((r) => textSimilarity(r.text, text) > 0.85);
  if (dupe) return liveWatchState.rules.find((r) => textSimilarity(r.text, text) > 0.85);
  const entry = { id: crypto.randomUUID(), text, createdAt: Date.now() };
  liveWatchState.rules.push(entry);
  if (liveWatchState.rules.length > LIVE_WATCH_MAX_RULES) {
    liveWatchState.rules = liveWatchState.rules.slice(-LIVE_WATCH_MAX_RULES);
  }
  liveWatchForceVision = true;
  scheduleLiveWatchTick(100);
  notifyLiveWatchUpdate();
  return entry;
}

function clearLiveWatchRules() {
  liveWatchState.rules = [];
  notifyLiveWatchUpdate();
}

function parseLiveWatchResponse(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed || /^\[unchanged\]$/i.test(trimmed)) return { type: "unchanged" };
  const alertBracket = trimmed.match(/^\[alert:\s*(.+?)\]$/is);
  if (alertBracket) return { type: "alert", text: alertBracket[1].trim() };
  const alertTag = trimmed.match(/^\[alert\]\s*(.+)/is);
  if (alertTag) return { type: "alert", text: alertTag[1].trim() };
  const noteBracket = trimmed.match(/^\[note:\s*(.+?)\]$/is);
  if (noteBracket) return { type: "note", text: noteBracket[1].trim() };
  return { type: "note", text: trimmed };
}

function buildLiveWatchRulesSection() {
  if (!liveWatchState.rules.length) return "";
  const lines = liveWatchState.rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n");
  return (
    "\n\nUSER WATCH RULES — check the screenshot against EACH rule. " +
    "If one is clearly true RIGHT NOW, output [alert: one short sentence] " +
    "describing what happened (under 15 words). Rules:\n" +
    lines
  );
}

function isLiveWatchEnabled() {
  return !!readOverlaySettings().liveWatch;
}

function getLiveWatchStatus() {
  return {
    enabled: liveWatchState.enabled,
    summary: liveWatchState.summary,
    commentary: liveWatchState.commentary,
    commentaryKind: liveWatchState.commentaryKind,
    at: liveWatchState.at,
    motionLevel: liveWatchState.motionLevel,
    lastDiff: liveWatchState.lastDiff,
    capturing: liveWatchState.capturing,
    isNewCommentary: liveWatchState.isNewCommentary,
    rules: liveWatchState.rules.map((r) => r.text),
    contextSource: liveWatchState.contextSource,
    extensionConnected: !!extensionBridge?.isConnected?.(),
    pageTitle: liveWatchState.pageTitle || "",
    pageUrl: liveWatchState.pageUrl || "",
  };
}

function getFreshLiveWatchSummary(maxAgeMs = LIVE_WATCH_SUMMARY_MAX_AGE_MS) {
  const text = String(liveWatchState.summary || "").trim();
  if (!text || !liveWatchState.at) return "";
  if (Date.now() - liveWatchState.at > maxAgeMs) return "";
  return text;
}

function getLiveWatchContextSection() {
  const text = getFreshLiveWatchSummary();
  if (!text) return "";
  const ageSec = Math.max(0, Math.round((Date.now() - liveWatchState.at) / 1000));
  return (
    "\n\n[LIVE SCREEN WATCH] LYKN has been continuously watching the user's screen " +
    `(last updated ${ageSec}s ago). Use this rolling summary as your live view — ` +
    "it may be more current than a single screenshot for fast-moving apps and games.\n" +
    `--- LIVE SCREEN SUMMARY ---\n${text}\n--- END LIVE SCREEN SUMMARY ---`
  );
}

function notifyLiveWatchUpdate() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("lykn:live-watch-update", getLiveWatchStatus());
  }
}

function setLiveWatchCapturing(on) {
  const next = !!on;
  if (liveWatchState.capturing === next) return;
  liveWatchState.capturing = next;
  notifyLiveWatchUpdate();
}

function setLiveWatchSummary(text, { motionLevel, diff, kind = "note" } = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  const prev = liveWatchState.commentary || liveWatchState.summary;
  const isNew = kind === "alert" || !prev || textSimilarity(prev, trimmed) < 0.62;
  liveWatchState.summary = trimmed.slice(0, 4000);
  liveWatchState.commentary = trimmed.slice(0, 1200);
  liveWatchState.commentaryKind = kind === "alert" ? "alert" : "note";
  liveWatchState.isNewCommentary = isNew;
  liveWatchState.at = Date.now();
  if (motionLevel) liveWatchState.motionLevel = motionLevel;
  if (typeof diff === "number") liveWatchState.lastDiff = diff;
  notifyLiveWatchUpdate();
  liveWatchState.isNewCommentary = false;
}

function liveWatchIntervalMs() {
  const now = Date.now();
  // Slow down while a vision/text call is in flight — prevents pile-up on page switches.
  if (liveWatchVisionInFlight || liveWatchTextInFlight) return LIVE_WATCH_STATIC_MS;
  if (now < liveWatchSettleUntil) return 400;
  if (now < liveWatchBurstUntil || liveWatchState.motionLevel === "burst") {
    return LIVE_WATCH_BURST_MS;
  }
  if (liveWatchState.motionLevel === "active") return LIVE_WATCH_ACTIVE_MS;
  return LIVE_WATCH_STATIC_MS;
}

async function captureForLiveWatch() {
  try {
    return await Promise.race([
      capturePrimaryScreen({ maxWidth: 960, format: "jpeg", quality: 72 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("capture_timeout")), LIVE_WATCH_CAPTURE_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    console.warn("[live-watch] capture failed:", e?.message);
    return null;
  }
}

async function postAiStreamTextWithTimeout(body, token, timeoutMs = LIVE_WATCH_VISION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/ai/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return "";
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      const data = await res.json().catch(() => null);
      return stripHiddenTags(data?.response || data?.answer || data?.text || "").trim();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accumulated = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(t.indexOf(":") + 1).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (typeof j.t === "string") accumulated += j.t;
        } catch {
          /* ignore keepalive */
        }
      }
    }
    return stripHiddenTags(accumulated).trim();
  } catch (e) {
    if (e?.name === "AbortError") console.warn("[live-watch] vision timed out");
    else console.warn("[live-watch] vision fetch failed:", e?.message);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function scheduleLiveWatchTick(delayMs) {
  if (liveWatchTimer) clearTimeout(liveWatchTimer);
  if (!liveWatchState.enabled) {
    liveWatchTimer = null;
    return;
  }
  liveWatchTimer = setTimeout(() => void liveWatchTick(), Math.max(50, delayMs || liveWatchIntervalMs()));
}

function stopLiveWatch() {
  liveWatchState.enabled = false;
  if (liveWatchTimer) {
    clearTimeout(liveWatchTimer);
    liveWatchTimer = null;
  }
  liveWatchCaptureInFlight = false;
  liveWatchForceVision = false;
  liveWatchState.motionLevel = "static";
  setLiveWatchCapturing(false);
  liveWatchState.commentary = "";
  liveWatchState.summary = "";
  liveWatchState.rules = [];
  liveWatchSettleUntil = 0;
  liveWatchPendingNavVision = false;
  liveWatchConsecutiveBurstFrames = 0;
  liveWatchTextInFlight = false;
  liveWatchForceTextPass = false;
  liveWatchPendingTextPass = false;
  liveWatchLastPageText = "";
  liveWatchLastPageSig = "";
  liveWatchLastPageUrl = "";
  liveWatchLastScrapeAt = 0;
  liveWatchState.contextSource = "vision";
  liveWatchState.pageTitle = "";
  liveWatchState.pageUrl = "";
  notifyLiveWatchUpdate();
}

function startLiveWatch() {
  if (screenCaptureStatus() !== "granted") {
    return { ok: false, error: "no_permission" };
  }
  liveWatchState.enabled = true;
  liveWatchForceVision = true;
  liveWatchLastFingerprint = "";
  liveWatchLastFrameUrl = "";
  liveWatchSettleUntil = 0;
  liveWatchPendingNavVision = false;
  liveWatchConsecutiveBurstFrames = 0;
  notifyLiveWatchUpdate();
  scheduleLiveWatchTick(100);
  return { ok: true, ...getLiveWatchStatus() };
}

function setLiveWatchEnabled(on) {
  const enabled = !!on;
  if (enabled) {
    const result = startLiveWatch();
    if (!result.ok) return result;
    writeOverlaySettings({ liveWatch: true });
    return { ...result, needsExtension: !extensionBridge?.isConnected?.() };
  }
  writeOverlaySettings({ liveWatch: false });
  stopLiveWatch();
  return { ok: true, enabled: false, ...getLiveWatchStatus() };
}

function getExtensionDir() {
  const userCopy = getUserExtensionDir(app.getPath("userData"));
  if (fsSync.existsSync(userCopy)) return userCopy;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "extensions", "save-to-lykn");
  }
  return path.join(__dirname, "..", "extensions", "save-to-lykn");
}

function restoreOverlayAfterExtensionInstall() {
  if (
    overlayVisibleBeforeExtensionInstall &&
    overlayWindow &&
    !overlayWindow.isDestroyed()
  ) {
    overlayWindow.show();
    overlayWindow.moveTop();
  }
  overlayVisibleBeforeExtensionInstall = false;
}

function createExtensionInstallWindow() {
  if (extensionInstallWindow && !extensionInstallWindow.isDestroyed()) {
    overlayVisibleBeforeExtensionInstall =
      overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
    if (overlayVisibleBeforeExtensionInstall) hideOverlay();
    extensionInstallWindow.show();
    extensionInstallWindow.focus();
    return;
  }

  overlayVisibleBeforeExtensionInstall =
    overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
  if (overlayVisibleBeforeExtensionInstall) hideOverlay();

  extensionInstallWindow = new BrowserWindow({
    width: 360,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Chrome Live Feed",
    backgroundColor: "#0b0b0f",
    webPreferences: {
      preload: path.join(__dirname, "extension-install-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  extensionInstallWindow.setMenu(null);
  extensionInstallWindow.loadFile(path.join(__dirname, "extension-install.html"));
  extensionInstallWindow.center();
  extensionInstallWindow.on("closed", () => {
    extensionInstallWindow = null;
    restoreOverlayAfterExtensionInstall();
  });
}

async function describeLiveWatchFrame(dataURL, previousSummary, { diff = 1, motionLevel = "static", rulesOnly = false } = {}) {
  const token = await getAuthToken();
  if (!token) return { error: "not_authenticated" };

  const prev = String(previousSummary || "").trim();
  const hasRules = liveWatchState.rules.length > 0;
  const rulesSection = buildLiveWatchRulesSection();
  const changePct = Math.round(Math.min(1, Math.max(0, diff)) * 100);
  const changeLine =
    diff >= 0.99
      ? ""
      : `\n\nSnapshot metadata: ~${changePct}% of screen pixels changed since the last capture ` +
        `(motion: ${motionLevel}).`;

  const outputRules =
    "OUTPUT (pick exactly one):\n" +
    "- [unchanged] — nothing new" +
    (hasRules ? ", no watch rules triggered" : "") +
    "\n" +
    (hasRules ? "- [alert: message] — a USER WATCH RULE is true on screen now (max 15 words)\n" : "") +
    (rulesOnly
      ? "- Rules-only check: output [alert: …] or [unchanged] only.\n"
      : "- [note: message] — one brief basic line if something changed (max 12 words)\n");

  const prompt = prev
    ? "You are LYKN watching the user's screen via still snapshots every 1–2 seconds.\n\n" +
      `LAST UPDATE:\n${prev.slice(0, 800)}\n\n` +
      outputRules +
      rulesSection +
      LIVE_WATCH_SNAPSHOT_NOTE +
      changeLine +
      "\n" +
      OVERLAY_IGNORE_NOTE
    : "You are LYKN watching the user's screen via still snapshots every 1–2 seconds.\n\n" +
      outputRules +
      rulesSection +
      "If nothing to say yet, output [unchanged]. Otherwise one short [note: …] about what they're doing (max 12 words).\n" +
      LIVE_WATCH_SNAPSHOT_NOTE +
      "\n" +
      OVERLAY_IGNORE_NOTE;

  const text = await postAiStreamTextWithTimeout(
    {
      model: "lykn",
      intent: "ask",
      text: "Live screen watch.",
      prompt,
      imageUrls: [dataURL],
      useTools: false,
      skipWebSearch: true,
      overlayAsk: true,
      liveWatch: true,
    },
    token,
  );
  const parsed = parseLiveWatchResponse(text);
  if (parsed.type === "unchanged") return { error: "unchanged" };
  const out = parsed.text.trim();
  if (!out) return { error: "unchanged" };
  if (parsed.type === "alert") return { text: out, kind: "alert" };
  // Reject pause/idling guesses when pixels barely moved — classic snapshot artifact.
  if (diff < 0.05 && /\b(paused?|on pause|you(?:'re| are) idle|standing still|not moving|game is paused)\b/i.test(out)) {
    return { error: "unchanged" };
  }
  // Skip long general chatter — keep live feed basic.
  if (out.split(/\s+/).length > 18) {
    return { text: out.split(/\s+/).slice(0, 15).join(" ") + "…", kind: "note" };
  }
  return { text: out, kind: "note" };
}

async function describeLiveWatchPageText(snap, previousSummary, { textSim = 0, rulesOnly = false } = {}) {
  const token = await getAuthToken();
  if (!token) return { error: "not_authenticated" };

  const prev = String(previousSummary || "").trim();
  const hasRules = liveWatchState.rules.length > 0;
  const rulesSection = buildLiveWatchRulesSection();
  const changePct = Math.round(Math.min(100, Math.max(0, (1 - textSim) * 100)));
  const pageBlock =
    `PAGE: ${snap.title || "Untitled"}\nURL: ${snap.url || ""}\n\n` +
    `VISIBLE TEXT (live DOM from browser — not a screenshot):\n${String(snap.text || "").slice(0, 8000)}`;

  const outputRules =
    "OUTPUT (pick exactly one):\n" +
    "- [unchanged] — nothing new" +
    (hasRules ? ", no watch rules triggered" : "") +
    "\n" +
    (hasRules ? "- [alert: message] — a USER WATCH RULE is true on this page now (max 15 words)\n" : "") +
    (rulesOnly
      ? "- Rules-only check: output [alert: …] or [unchanged] only.\n"
      : "- [note: message] — one brief basic line if something changed (max 12 words)\n");

  const prompt = prev
    ? "You are LYKN watching the user's browser via live page text (DOM, not screenshots).\n\n" +
      `LAST UPDATE:\n${prev.slice(0, 800)}\n\n` +
      `${pageBlock}\n\n` +
      `Page text ~${changePct}% changed since last check.\n\n` +
      outputRules +
      rulesSection +
      "\n" +
      OVERLAY_IGNORE_NOTE
    : "You are LYKN watching the user's browser via live page text (DOM, not screenshots).\n\n" +
      `${pageBlock}\n\n` +
      outputRules +
      rulesSection +
      "If nothing to say yet, output [unchanged]. Otherwise one short [note: …] about what they're reading or doing (max 12 words).\n" +
      "\n" +
      OVERLAY_IGNORE_NOTE;

  const text = await postAiStreamTextWithTimeout(
    {
      model: "lykn",
      intent: "ask",
      text: "Live browser watch.",
      prompt,
      useTools: false,
      skipWebSearch: true,
      overlayAsk: true,
      liveWatch: true,
    },
    token,
  );
  const parsed = parseLiveWatchResponse(text);
  if (parsed.type === "unchanged") return { error: "unchanged" };
  const out = parsed.text.trim();
  if (!out) return { error: "unchanged" };
  if (parsed.type === "alert") return { text: out, kind: "alert" };
  if (out.split(/\s+/).length > 18) {
    return { text: out.split(/\s+/).slice(0, 15).join(" ") + "…", kind: "note" };
  }
  return { text: out, kind: "note" };
}

async function liveWatchTextPass(snap, { textSim = 0, rulesOnly = false } = {}) {
  if (liveWatchTextInFlight) return;
  const now = Date.now();
  const force = liveWatchForceTextPass;
  if (!force && now - liveWatchLastVisionAt < LIVE_WATCH_TEXT_MIN_MS) return;

  liveWatchTextInFlight = true;
  liveWatchForceTextPass = false;
  liveWatchLastVisionAt = now;
  if (rulesOnly) liveWatchLastRuleCheckAt = now;
  try {
    const result = await describeLiveWatchPageText(snap, liveWatchState.summary, { textSim, rulesOnly });
    if (result?.text) {
      setLiveWatchSummary(result.text, {
        motionLevel: liveWatchState.motionLevel,
        diff: 1 - textSim,
        kind: result.kind || "note",
      });
    }
  } catch (e) {
    console.warn("[live-watch] text pass failed:", e?.message);
  } finally {
    liveWatchTextInFlight = false;
  }
}

async function tryLiveWatchBrowserScrape() {
  const now = Date.now();
  if (now - liveWatchLastScrapeAt < LIVE_WATCH_SCRAPE_MIN_MS) return null;
  liveWatchLastScrapeAt = now;
  try {
    const target = await getActiveBrowserTarget();
    if (!target?.appName) return null;
    const live = await getBrowserPageText(target.appName);
    const text = String(live?.text || live?.pageText || "").trim();
    if (text.length < 80) return null;
    const url = String(live?.url || target.url || "");
    const title = String(live?.title || target.title || "");
    const sig = `${url}|${text.length}|${text.slice(0, 240)}|${text.slice(-120)}`;
    return { url, title, text: text.slice(0, 15000), sig, at: Date.now(), source: "scrape" };
  } catch {
    return null;
  }
}

async function liveWatchPageTextTick(snap, source) {
  liveWatchState.contextSource = source;
  liveWatchState.extensionConnected = source === "extension" || !!extensionBridge?.isConnected?.();
  liveWatchState.pageTitle = String(snap.title || "").trim();
  liveWatchState.pageUrl = String(snap.url || "").trim();

  const textSim =
    snap.sig && snap.sig === liveWatchLastPageSig
      ? 1
      : liveWatchLastPageText
        ? textSimilarity(liveWatchLastPageText, snap.text)
        : 0;
  const textChanged = 1 - textSim >= LIVE_WATCH_TEXT_CHANGE;
  liveWatchState.lastDiff = 1 - textSim;

  const now = Date.now();
  const urlChanged = liveWatchLastPageUrl && snap.url && liveWatchLastPageUrl !== snap.url;

  if (urlChanged) {
    liveWatchSettleUntil = now + 800;
    liveWatchPendingTextPass = true;
    liveWatchLastPageUrl = snap.url;
    liveWatchLastPageText = snap.text;
    liveWatchLastPageSig = snap.sig || "";
    return Math.max(300, liveWatchSettleUntil - now + 50);
  }

  if (now < liveWatchSettleUntil) {
    return Math.max(200, liveWatchSettleUntil - now + 50);
  }

  if (liveWatchPendingTextPass) {
    liveWatchPendingTextPass = false;
    liveWatchForceTextPass = true;
  }

  liveWatchState.motionLevel = textChanged ? "active" : "static";

  const hasRules = liveWatchState.rules.length > 0;
  const ruleCheckDue = hasRules && now - liveWatchLastRuleCheckAt >= LIVE_WATCH_RULE_CHECK_MS;
  const shouldPass =
    liveWatchForceTextPass || !liveWatchState.summary || textChanged || ruleCheckDue;
  const skipNearDuplicate =
    !liveWatchForceTextPass && !ruleCheckDue && liveWatchState.summary && textSim > 0.97;

  if (shouldPass && !skipNearDuplicate && !liveWatchTextInFlight) {
    void liveWatchTextPass(snap, { textSim, rulesOnly: ruleCheckDue && !textChanged });
  }

  liveWatchLastPageText = snap.text;
  liveWatchLastPageSig = snap.sig || "";
  liveWatchLastPageUrl = snap.url || "";

  notifyLiveWatchUpdate();
  return textChanged ? LIVE_WATCH_ACTIVE_MS : LIVE_WATCH_STATIC_MS;
}

async function liveWatchVisionPass(dataURL, diff, { rulesOnly = false } = {}) {
  if (liveWatchVisionInFlight) return;
  const now = Date.now();
  const force = liveWatchForceVision;
  if (!force && now - liveWatchLastVisionAt < LIVE_WATCH_VISION_MIN_MS) return;

  liveWatchVisionInFlight = true;
  liveWatchForceVision = false;
  liveWatchLastVisionAt = now;
  if (rulesOnly) liveWatchLastRuleCheckAt = now;
  try {
    const result = await describeLiveWatchFrame(dataURL, liveWatchState.summary, {
      diff,
      motionLevel: liveWatchState.motionLevel,
      rulesOnly,
    });
    if (result?.text) {
      setLiveWatchSummary(result.text, {
        motionLevel: liveWatchState.motionLevel,
        diff,
        kind: result.kind || "note",
      });
    }
  } catch (e) {
    console.warn("[live-watch] vision pass failed:", e?.message);
  } finally {
    liveWatchVisionInFlight = false;
  }
}

async function liveWatchTick() {
  if (!liveWatchState.enabled) return;
  if (screenCaptureStatus() !== "granted") {
    stopLiveWatch();
    return;
  }
  if (liveWatchCaptureInFlight) {
    scheduleLiveWatchTick(liveWatchIntervalMs());
    return;
  }

  liveWatchCaptureInFlight = true;
  let nextDelay = null;

  try {
    // Text-first: browser extension (cheapest — no screenshot, no vision).
    const extSnap = extensionBridge?.getSnapshot?.(6000);
    if (extSnap?.text && extSnap.text.length >= 80) {
      nextDelay = await liveWatchPageTextTick(extSnap, "extension");
      return;
    }

    // Text fallback: AppleScript DOM scrape when extension not connected.
    const scrapeSnap = await tryLiveWatchBrowserScrape();
    if (scrapeSnap?.text && scrapeSnap.text.length >= 80) {
      nextDelay = await liveWatchPageTextTick(scrapeSnap, "scrape");
      return;
    }

    liveWatchState.extensionConnected = !!extensionBridge?.isConnected?.();
    liveWatchState.contextSource = "vision";

    setLiveWatchCapturing(true);
    const dataURL = await captureForLiveWatch();
    if (!liveWatchState.enabled) return;
    if (!dataURL) {
      nextDelay = LIVE_WATCH_STATIC_MS;
      return;
    }

    liveWatchLastFrameUrl = dataURL;
    const fp = screenFingerprint(dataURL);
    const diff = liveWatchLastFingerprint ? screenDiffRatio(liveWatchLastFingerprint, fp) : 1;
    liveWatchLastFingerprint = fp;
    liveWatchState.lastDiff = diff;

    const now = Date.now();
    const navigated = diff >= LIVE_WATCH_NAV_DIFF;

    if (navigated) {
      // Page/app switch — wait for the new screen to settle instead of burst-flooding vision.
      liveWatchSettleUntil = now + LIVE_WATCH_NAV_SETTLE_MS;
      liveWatchPendingNavVision = true;
      liveWatchBurstUntil = 0;
      liveWatchConsecutiveBurstFrames = 0;
      liveWatchState.motionLevel = "static";
      nextDelay = Math.max(200, liveWatchSettleUntil - now + 50);
      return;
    }

    if (now < liveWatchSettleUntil) {
      nextDelay = Math.max(200, liveWatchSettleUntil - now + 50);
      return;
    }

    if (liveWatchPendingNavVision) {
      liveWatchPendingNavVision = false;
      liveWatchForceVision = true;
    }

    if (diff >= LIVE_WATCH_DIFF_BURST) {
      liveWatchConsecutiveBurstFrames += 1;
      if (liveWatchConsecutiveBurstFrames >= 2) {
        liveWatchState.motionLevel = "burst";
        liveWatchBurstUntil = now + LIVE_WATCH_BURST_DURATION_MS;
      } else {
        liveWatchState.motionLevel = "active";
      }
    } else if (diff >= LIVE_WATCH_DIFF_MOTION) {
      liveWatchConsecutiveBurstFrames = 0;
      liveWatchState.motionLevel = "active";
    } else if (now >= liveWatchBurstUntil) {
      liveWatchConsecutiveBurstFrames = 0;
      liveWatchState.motionLevel = "static";
    }

    const hasRules = liveWatchState.rules.length > 0;
    const ruleCheckDue = hasRules && now - liveWatchLastRuleCheckAt >= LIVE_WATCH_RULE_CHECK_MS;
    const shouldVision =
      liveWatchForceVision ||
      !liveWatchState.summary ||
      diff >= LIVE_WATCH_DIFF_VISION ||
      ruleCheckDue;
    const skipNearDuplicate =
      !liveWatchForceVision && !ruleCheckDue && liveWatchState.summary && diff < 0.03;
    if (shouldVision && !skipNearDuplicate && !liveWatchVisionInFlight) {
      void liveWatchVisionPass(dataURL, diff, { rulesOnly: ruleCheckDue && diff < LIVE_WATCH_DIFF_VISION });
    }
  } catch (e) {
    console.warn("[live-watch] capture tick failed:", e?.message);
    nextDelay = LIVE_WATCH_STATIC_MS;
  } finally {
    liveWatchCaptureInFlight = false;
    setLiveWatchCapturing(false);
    if (liveWatchState.enabled) {
      scheduleLiveWatchTick(nextDelay != null ? nextDelay : liveWatchIntervalMs());
    }
  }
}

function overlaySessionsPath() {
  return path.join(app.getPath("userData"), "overlay-sessions.json");
}

async function readOverlaySessionsStore() {
  try {
    const raw = await fs.readFile(overlaySessionsPath(), "utf8");
    const data = JSON.parse(raw);
    return {
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      currentSessionId: data.currentSessionId || null,
    };
  } catch {
    return { sessions: [], currentSessionId: null };
  }
}

async function writeOverlaySessionsStore(store) {
  await fs.writeFile(overlaySessionsPath(), JSON.stringify(store, null, 2), "utf8");
}

function overlaySessionTitle(messages) {
  const firstUser = (messages || []).find((m) => m && m.role === "user" && String(m.content || "").trim());
  if (firstUser) return String(firstUser.content).trim().slice(0, 72);
  return "⌘L chat";
}

function overlaySessionPreview(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const text = String(m?.content || "").trim();
    if (text) return text.slice(0, 140);
  }
  return "";
}

// Normalize a URL to a stable "page key" so we can recognize when the user is
// back on the same page across sessions. Drops protocol, www, query, hash, and
// trailing slashes — host + path is a good balance between "same page" and not
// over-merging different articles on one site.
function normalizeUrlForMatch(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./i, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return raw
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[#?].*$/, "")
      .replace(/\/+$/, "");
  }
}

// Find earlier ⌘L conversations that happened on the same page (matched by
// normalized URL) and format the most recent excerpts. Lets the overlay AI
// remember what it already discussed when the user returns to a page.
async function buildPastPageConversationSection(normalizedUrl, excludeSessionId) {
  if (!normalizedUrl) return "";
  let store;
  try {
    store = await readOverlaySessionsStore();
  } catch {
    return "";
  }
  const matches = (store.sessions || [])
    .filter((s) => s && s.id !== excludeSessionId && Array.isArray(s.messages) && s.messages.length)
    .filter((s) => {
      const pages = Array.isArray(s.pages) ? s.pages : [];
      if (pages.includes(normalizedUrl)) return true;
      if (s.pageUrl && normalizeUrlForMatch(s.pageUrl) === normalizedUrl) return true;
      return false;
    })
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, 3);
  if (!matches.length) return "";

  const blocks = [];
  let budget = 4000;
  for (const s of matches) {
    const when = s.updatedAt
      ? new Date(s.updatedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
    const turns = s.messages
      .slice(-6)
      .map((m) => {
        const role = m && m.role === "assistant" ? "LYKN" : "User";
        const content = String((m && m.content) || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 600);
        return content ? `${role}: ${content}` : "";
      })
      .filter(Boolean)
      .join("\n");
    if (!turns) continue;
    const entry = `Earlier conversation${when ? ` (${when})` : ""}:\n${turns}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    blocks.push(entry);
  }
  return blocks.join("\n\n");
}

async function fetchAppChatsForOverlay() {
  const token = await getAuthToken();
  if (!token) return { chats: [], error: "not_signed_in" };
  try {
    const res = await fetch(`${API_BASE}/api/desktop/chats?limit=40`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { chats: [], error: body || `http_${res.status}` };
    }
    const data = await res.json();
    return { chats: Array.isArray(data.chats) ? data.chats : [] };
  } catch (e) {
    return { chats: [], error: e && e.message ? e.message : "fetch_failed" };
  }
}

// Mirror an overlay conversation into the app's durable chat store so it shows
// up in the actual app's "previous chats" alongside chats started in-app. The
// overlay sessionId is already a UUID, so it doubles as the lykn_chats row id —
// repeated saves of the same conversation upsert the same row. Best-effort.
async function pushOverlaySessionToApp(sessionId, title, messages) {
  try {
    const token = await getAuthToken();
    if (!token) return false;
    if (!sessionId || !Array.isArray(messages) || !messages.length) return false;
    const res = await fetch(`${API_BASE}/api/desktop/chats/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ chatId: sessionId, title, messages }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Capture the screen, send it + the user's question to LYKN's streaming chat
// endpoint, and forward text deltas to the overlay. Runs in the main process so
// there's no CORS and the screenshot never touches the renderer.
// The screenshot always contains LYKN's own floating overlay (the glass chat
// bar with the question, mic/send buttons, and any live transcript). Without
// this note the model "reads" its own UI back to the user ("…and there's a chat
// bar that says…"). Tell it to treat the overlay as invisible.
// Ask macOS (via AppleScript) for the URL of the active tab in the frontmost
// browser. When LYKN's overlay has keyboard focus our own app is "frontmost",
// so we fall back to the first running browser that has an open window. This
// lets the user just ask "what's this article about?" without pasting a link.
function runOsascript(script, timeout = 4000) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout }, (err, stdout, stderr) => {
      if (err) {
        const msg = String((stderr || "") + " " + (err.message || "")).trim();
        resolve({ error: msg || String(err.code || err) });
        return;
      }
      resolve({ out: String(stdout || "").trim() });
    });
  });
}

const BROWSER_APP_NAMES = [
  "Google Chrome",
  "Google Chrome Canary",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Chromium",
  "Opera",
  "Vivaldi",
  "Dia",
  "Sidekick",
  "Safari",
  "Safari Technology Preview",
];

// When several browsers are open, prefer daily drivers over Safari Technology Preview.
const BROWSER_PICK_PRIORITY = {
  "Google Chrome": 100,
  "Google Chrome Canary": 98,
  Arc: 95,
  "Brave Browser": 90,
  "Microsoft Edge": 88,
  Chromium: 85,
  Opera: 80,
  Vivaldi: 78,
  Dia: 75,
  Sidekick: 73,
  Safari: 50,
  "Safari Technology Preview": 5,
};
const DEPRIORITIZED_BROWSERS = new Set(["Safari Technology Preview"]);

async function listRunningBrowserApps() {
  const listLiteral = `{${BROWSER_APP_NAMES.map((n) => `"${n}"`).join(", ")}}`;
  // Match running *process* names — never `tell application "Arc"` unless Arc is
  // actually open. Probing every app in the allowlist triggers macOS "Where is Arc?"
  // file-picker dialogs for browsers that aren't installed.
  const pickScript = `
tell application "System Events"
  set procNames to name of every process
end tell
set allBrowsers to ${listLiteral}
set out to ""
repeat with b in allBrowsers
  if procNames contains (b as string) then
    if out is "" then
      set out to (b as string)
    else
      set out to out & "|" & (b as string)
    end if
  end if
end repeat
return out
`;
  const pick = await runOsascript(pickScript, 8000);
  if (pick.error) {
    console.log("[scrape] browser-detect error:", pick.error);
    if (/-1743|not authoriz/i.test(pick.error)) {
      console.log(
        "[scrape] → Grant Automation permission: System Settings → Privacy & " +
          "Security → Automation → enable System Events for LYKN/Electron.",
      );
    }
    return [];
  }
  return String(pick.out || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readBrowserFrontTabUrl(appName, { anyScheme = false } = {}) {
  const accept = (u) => {
    const url = String(u || "").trim();
    if (!url) return null;
    if (anyScheme) return url;
    return /^https?:\/\//i.test(url) ? url : null;
  };
  const isSafari = /^Safari/.test(appName);
  const script = isSafari
    ? `tell application "${appName}" to get URL of current tab of front window`
    : `tell application "${appName}" to get URL of active tab of front window`;
  const r = await runOsascript(script, 6000);
  if (r.error) {
    console.log(`[scrape] url-read error (${appName}):`, r.error);
    if (/-1743|not authoriz/i.test(r.error)) {
      console.log(`[scrape] → Grant Automation permission for ${appName} under LYKN/Electron.`);
    }
    return null;
  }
  return accept(r.out);
}

async function readBrowserTabUrl(appName, { anyScheme = false } = {}) {
  const front = await readBrowserFrontTabUrl(appName, { anyScheme });
  if (front) return front;
  if (/^Safari/.test(appName)) return null;

  const accept = (u) => {
    const url = String(u || "").trim();
    if (!url) return null;
    if (anyScheme) return url;
    return /^https?:\/\//i.test(url) ? url : null;
  };
  const r = await runOsascript(
    `tell application "${appName}"
      if (count of windows) is 0 then return ""
      repeat with w in windows
        try
          set u to URL of active tab of w
          if u is not "" then return u
        end try
      end repeat
      return ""
    end tell`,
    6000,
  );
  if (r.error) {
    console.log(`[scrape] url-read error (${appName}):`, r.error);
    return null;
  }
  const url = accept(r.out);
  if (url) return url;
  if (anyScheme && String(r.out || "").trim()) return String(r.out).trim();
  return null;
}

async function listBrowserHttpTargets({ frontWindowOnly = false } = {}) {
  const candidates = await listRunningBrowserApps();
  const out = [];
  for (const appName of candidates) {
    const url = frontWindowOnly
      ? await readBrowserFrontTabUrl(appName)
      : await readBrowserTabUrl(appName);
    if (url) out.push({ appName, url });
  }
  return out;
}

function pickBestBrowserTarget(targets) {
  if (!targets.length) return null;
  let pool = targets;
  const hasMainBrowser = pool.some((t) => !DEPRIORITIZED_BROWSERS.has(t.appName));
  if (hasMainBrowser) {
    pool = pool.filter((t) => !DEPRIORITIZED_BROWSERS.has(t.appName));
  }
  pool.sort(
    (a, b) =>
      (BROWSER_PICK_PRIORITY[b.appName] ?? 40) - (BROWSER_PICK_PRIORITY[a.appName] ?? 40),
  );
  return pool[0];
}

async function describeBrowserTabProblem() {
  const candidates = await listRunningBrowserApps();
  if (!candidates.length) {
    return {
      error: "no_browser",
      message: "Open Chrome (or another browser) with a website loaded, then try again.",
    };
  }
  for (const appName of candidates) {
    const httpUrl = await readBrowserTabUrl(appName);
    if (httpUrl) return null;
    const raw = await readBrowserTabUrl(appName, { anyScheme: true });
    if (raw && /^(chrome|about|edge|brave|arc):/i.test(raw)) {
      return {
        error: "new_tab",
        message:
          "This tab is a blank new-tab page — there's nothing to click or type on yet. " +
          "Go to a real site first (e.g. youtube.com or google.com), then try again.",
      };
    }
  }
  return {
    error: "no_browser",
    message:
      "No usable browser tab found. Open an https:// page (not chrome://newtab), then try again.",
  };
}

// Two-step so the AppleScript always compiles:
//   1) list running browsers (frontmost browser first when applicable),
//   2) a literal `tell application "<name>"` reads its active tab's URL.
// When LYKN's overlay has focus, Electron is frontmost — we try every running
// browser until one has an http(s) tab (Safari in the background no longer blocks Chrome).
async function getActiveBrowserTarget() {
  if (process.platform !== "darwin") return null;
  const candidates = await listRunningBrowserApps();
  if (!candidates.length) {
    console.log("[scrape] no browser frontmost or running");
    return null;
  }
  // Prefer front-window tabs in Chrome/Arc/etc. over stale STP background tabs.
  let best = pickBestBrowserTarget(await listBrowserHttpTargets({ frontWindowOnly: true }));
  if (!best) {
    best = pickBestBrowserTarget(await listBrowserHttpTargets({ frontWindowOnly: false }));
  }
  if (!best) {
    console.log("[scrape] browsers running but none have an http(s) tab:", candidates.join(", "));
    return null;
  }
  console.log(`[scrape] active browser URL: ${best.url} (${best.appName})`);
  return best;
}

// Read the LIVE rendered text from the user's active browser tab via AppleScript
// JS execution. This is the most robust "scrape" — it sees exactly what the user
// sees, bypassing bot blocks, Cloudflare, and paywalls (it's their real session).
// Requires the browser's "Allow JavaScript from Apple Events" setting (Chrome:
// View → Developer; Safari: Develop menu). Returns "title\n<body text>" or null.
async function getBrowserPageText(appName) {
  // No double quotes or backslashes in this JS so it embeds cleanly in the
  // AppleScript double-quoted string (AppleScript treats \n etc. as escapes).
  const js =
    "(function(){var e=document.querySelector('article')||document.querySelector('main')||document.body;" +
    "var t=(document.title||'')+String.fromCharCode(10)+(e?e.innerText:'');return t.slice(0,15000);})()";
  const isSafari = /^Safari/.test(appName);
  const script = isSafari
    ? `tell application "${appName}" to do JavaScript "${js}" in current tab of front window`
    : `tell application "${appName}" to execute active tab of front window javascript "${js}"`;
  const r = await runOsascript(script, 6000);
  if (r.error) {
    if (/turned off|not allowed|Allow JavaScript|Apple Events/i.test(r.error)) {
      console.log(
        `[scrape] live-DOM read off for ${appName} — enable "Allow JavaScript from ` +
          `Apple Events" (Chrome: View → Developer). Falling back to HTTP fetch.`,
      );
    } else {
      console.log(`[scrape] live-DOM read error (${appName}):`, r.error);
    }
    return null;
  }
  const out = (r.out || "").trim();
  return out.length > 40 ? out : null;
}

function decodeHtmlEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return "";
      }
    });
}

// Fetch a web page and extract its readable text. Best-effort HTML→text with no
// dependencies: drop scripts/styles/nav chrome, prefer <article>/<main> content,
// strip tags, decode entities, collapse whitespace, and cap the length.
async function scrapePageText(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return null;
    const ctype = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null;

    let html = await res.text();
    const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleM ? decodeHtmlEntities(titleM[1]).replace(/\s+/g, " ").trim() : "";

    // Strip non-content elements before extracting text.
    html = html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");

    // Prefer the main article body when the page marks one up.
    const main =
      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
      html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const source = main ? main[1] : html;

    const text = decodeHtmlEntities(
      source
        .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .replace(/^[ \t]+|[ \t]+$/gm, "")
      .trim();

    if (!text) return null;
    return { url, title, text: text.slice(0, 12000) };
  } catch {
    return null;
  }
}

// Pull the YouTube video id from a watch / youtu.be / shorts / embed URL.
function parseYouTubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) return m[2];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

// Fetch the transcript from INSIDE the user's tab. YouTube now binds timedtext
// URLs to the originating session/IP, so a server fetch returns empty — but an
// in-page fetch uses the user's own session and works. AppleScript can't await a
// promise, so we kick off the fetch (stashing the result on window.__lyknYT) and
// then poll for it.
async function getBrowserYouTubeTranscript(appName) {
  if (!appName) return null;
  const isSafari = /^Safari/.test(appName);
  const wrap = (js) =>
    isSafari
      ? `tell application "${appName}" to do JavaScript "${js}" in current tab of front window`
      : `tell application "${appName}" to execute active tab of front window javascript "${js}"`;

  // No double quotes or backslashes in this JS (it embeds in an AppleScript
  // double-quoted string). json3 captions parse cleanly into events[].segs[].
  const kick =
    "(function(){try{var r=window.ytInitialPlayerResponse;" +
    "var tt=r&&r.captions&&r.captions.playerCaptionsTracklistRenderer&&r.captions.playerCaptionsTracklistRenderer.captionTracks;" +
    "if(!tt||!tt.length){window.__lyknYT={status:'notracks'};return 'notracks';}" +
    "var en=tt.filter(function(t){return /^en/i.test(t.languageCode||'')&&t.kind!=='asr';});" +
    "var en2=tt.filter(function(t){return /^en/i.test(t.languageCode||'');});" +
    "var pick=en[0]||en2[0]||tt[0];var u=pick.baseUrl;" +
    "if(u.indexOf('fmt=')<0){u+=(u.indexOf('?')<0?'?':'&')+'fmt=json3';}" +
    "window.__lyknYT={status:'loading',title:document.title};" +
    "fetch(u).then(function(x){return x.text();}).then(function(txt){var out='';" +
    "try{var j=JSON.parse(txt);if(j&&j.events){out=j.events.map(function(e){return (e.segs||[]).map(function(s){return s.utf8||'';}).join('');}).join(' ');}}catch(e){out=txt;}" +
    "window.__lyknYT={status:'done',title:document.title,text:(out||'').slice(0,20000)};})" +
    ".catch(function(e){window.__lyknYT={status:'error'};});return 'started';}" +
    "catch(e){window.__lyknYT={status:'error'};return 'error';}})()";

  const start = await runOsascript(wrap(kick), 6000);
  if (start.error) {
    if (/turned off|Allow JavaScript|Apple Events/i.test(start.error)) {
      console.log(
        `[scrape] yt: live-DOM JS off for ${appName} — enable "Allow JavaScript from Apple Events".`,
      );
    } else {
      console.log("[scrape] yt kick error:", start.error);
    }
    return null;
  }
  if (/notracks|^error$/.test((start.out || "").trim())) return null;

  const pollJs =
    "(function(){try{return JSON.stringify(window.__lyknYT||null);}catch(e){return '';}})()";
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 350));
    const p = await runOsascript(wrap(pollJs), 4000);
    if (p.error || !p.out) continue;
    let obj = null;
    try {
      obj = JSON.parse(p.out);
    } catch {
      continue;
    }
    if (!obj) continue;
    if (obj.status === "done" && obj.text) {
      const text = String(obj.text).replace(/\s+/g, " ").trim();
      if (text) return { title: obj.title || "", text: text.slice(0, 16000) };
      return null;
    }
    if (obj.status === "error" || obj.status === "notracks") return null;
  }
  return null;
}

// Fetch a YouTube video's caption transcript. Tries the in-page method first
// (reliable, uses the user's session), then falls back to a server-side fetch of
// the watch page + timedtext (works for some videos / when no browser JS access).
async function fetchYouTubeTranscript(videoId, appName) {
  const inPage = await getBrowserYouTubeTranscript(appName);
  if (inPage && inPage.text) {
    console.log("[scrape] yt transcript via live tab");
    return inPage;
  }

  let title = "";
  let tracks = null;

  // 1) Live tab — most reliable (bypasses YouTube's bot checks).
  if (appName && !/^Safari/.test(appName)) {
    const js =
      "(function(){try{var r=window.ytInitialPlayerResponse;" +
      "var t=r&&r.captions&&r.captions.playerCaptionsTracklistRenderer&&r.captions.playerCaptionsTracklistRenderer.captionTracks;" +
      "return JSON.stringify({title:document.title,tracks:t||[]});}catch(e){return '';}})()";
    const r = await runOsascript(
      `tell application "${appName}" to execute active tab of front window javascript "${js}"`,
      6000,
    );
    if (!r.error && r.out) {
      try {
        const parsed = JSON.parse(r.out);
        title = parsed.title || "";
        if (Array.isArray(parsed.tracks) && parsed.tracks.length) tracks = parsed.tracks;
      } catch {
        /* ignore */
      }
    }
  }

  // 2) Fallback: fetch the watch page HTML and regex out the caption tracks.
  if (!tracks) {
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const html = await res.text();
      if (!title) {
        const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (tm) title = decodeHtmlEntities(tm[1]).replace(/\s*-\s*YouTube\s*$/, "").trim();
      }
      const m = html.match(/"captionTracks":(\[.*?\])(?:,"audioTracks"|,"translationLanguages"|\})/);
      if (m) {
        try {
          tracks = JSON.parse(m[1].replace(/\\u0026/g, "&"));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!Array.isArray(tracks) || !tracks.length) return null;

  // Prefer a manually-authored English track, then any English, then the first.
  const pick =
    tracks.find((t) => /^en/i.test(t.languageCode || "") && t.kind !== "asr") ||
    tracks.find((t) => /^en/i.test(t.languageCode || "")) ||
    tracks[0];
  let baseUrl = pick && pick.baseUrl;
  if (!baseUrl) return null;
  baseUrl = baseUrl.replace(/\\u0026/g, "&");

  try {
    const res = await fetch(baseUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const xml = await res.text();
    const parts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
      decodeHtmlEntities(m[1].replace(/<[^>]+>/g, " ")),
    );
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { title, text: text.slice(0, 16000) };
  } catch {
    return null;
  }
}

let overlayAskGeneration = 0;
let overlayAskAbort = null;

function isRetryableStreamError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    /terminated|econnreset|econnrefused|socket hang up|network|fetch failed|aborted|unexpected end|broken pipe|reset by peer/.test(
      msg,
    ) && !/sign in|not authenticated|401|403|429/.test(msg)
  );
}

function humanizeStreamError(err) {
  const msg = String(err?.message || err || "").trim();
  if (/terminated|econnreset|socket hang up|broken pipe|reset by peer/i.test(msg)) {
    return "Connection dropped before LYKN could finish — usually a brief network or server hiccup. Try again.";
  }
  if (/aborted/i.test(msg)) return "Request was cancelled.";
  return msg ? `Request failed: ${msg}` : "Request failed.";
}

async function readOverlayStreamResponse(res, send) {
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok || !res.body) {
    throw new Error(`LYKN backend error (${res.status}).`);
  }

  if (!ctype.includes("text/event-stream")) {
    const data = await res.json().catch(() => null);
    const answer = stripHiddenTags(data?.response || data?.answer || data?.text || "");
    if (answer.trim()) send("lykn:answer-delta", { text: answer });
    return answer;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(t.indexOf(":") + 1).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (typeof j.t === "string") {
          accumulated += j.t;
          send("lykn:answer-delta", { text: stripHiddenTags(accumulated) });
        } else if (typeof j.status === "string" && j.status.trim()) {
          send("lykn:answer-status", { status: j.status.trim() });
        } else if (j.tool_call && typeof j.tool_call === "object") {
          const tc = j.tool_call;
          if (tc.status === "running") {
            const label = TOOL_STATUS_LABELS[tc.name] || "Working on it…";
            send("lykn:answer-status", { status: label });
          }
        } else if (j.error) {
          throw new Error(String(j.error) || "Stream error.");
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return stripHiddenTags(accumulated);
}

function overlayMessageLooksScreenRelated(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /\b(on my screen|what('| i)?s on|what do you see|this (page|site|tab|website|article|video|error|message|screen|one|problem|question)|look at|read (this|the|my)|what am i|explain (this|it)|summarize (this|it)|the (question|quiz|problem|error|answer)|fix (this|it)|help me with this|can you see|what is (this|that|on)|what are (these|those)|why (is|does|are)|how (do|does|can)|where (is|are)|who (is|are)|tell me about (this|the|what)|describe (this|the|what)|click|submit|solve (this|it|the)|answer (this|the|it)|is (this|that|it) (right|correct|wrong|good|true|false)|which (one|answer|option|choice)|what should i (pick|choose|select|do)|(next|this) one)\b/.test(
    t,
  );
}

function overlayMessageIsPhatic(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.…,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 80) return false;
  if (overlayMessageLooksScreenRelated(t)) return false;
  // Emoji-only acknowledgements.
  if (/^(👍|🙏|🔥|💯|✅|🙌|😂|😄|🤝|👌)+$/.test(t)) return true;
  // Acknowledgement phrases — a message is phatic when it's made up ONLY of these
  // (plus a few filler words), so "gotcha thanks", "ok cool thanks so much", and
  // "ah that makes sense" all count, not just single-word replies.
  const ackPhrases =
    /\b(awesome|great|perfect|nice one|nice|cool|thank you|thanks|thx|ty|got ?it|got ?cha|gotcha|gotchu|ok(?:ay)?|kk?|sounds (good|great)|that makes sense|makes sense|that helps|that helped|helpful|appreciate (it|that|you)|love it|wonderful|excellent|good (to know|stuff|call|point|looks)|good|understood|fair enough|sweet|bet|for sure|totally|yep|yup|yeah|yes|right on|exactly|100%|no worries|np|my bad|lol+|haha+|hah|cheers|alright|aight|roger|copy (that)?|all good|will do|word|dope|facts|solid|neat|ditto|same here|same|of course|np)\b/g;
  const filler = /\b(and|i|you|me|so|then|just|really|very|much|the|a|an|to|know|ya|ah+|oh+|hmm+|well|now|then|man|dude|cool)\b/g;
  const stripped = t
    .replace(ackPhrases, " ")
    .replace(filler, " ")
    .replace(/[^a-z0-9%]/g, "")
    .trim();
  return stripped.length === 0;
}

function overlayMessageIsConversationFollowUp(text, history) {
  if (!Array.isArray(history) || history.length < 1) return false;
  const msg = String(text || "").trim();
  if (!msg || overlayMessageLooksScreenRelated(msg)) return false;
  if (overlayMessageIsPhatic(msg)) return true;
  // Only skip the screen when the message clearly refers to the PRIOR CONVERSATION.
  // Bare deictic words ("this", "it", "that") frequently point at the SCREEN, so
  // they must NOT suppress screen capture on their own — otherwise the AI goes blind
  // the moment there's any chat history. Require an explicit conversational anchor.
  if (
    msg.length <= 220 &&
    /\b(you (said|mentioned|told me|wrote|asked|meant)|like you said|as you (said|mentioned)|earlier you|before you|your (last |previous )?(answer|reply|response|point)|expand( on)?|elaborate|go deeper|tell me more|more about (that|it|this)|what you (said|meant)|follow[- ]?up|one more thing|rephrase|reword|say (that|it) again|repeat (that|it))\b/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

// Pull the live page/video the user is looking at, plus any earlier ⌘L
// conversation about that same page. Factored out of streamScreenAnswer so it can
// run CONCURRENTLY with the screenshot + auth fetch (it was the slowest serial
// step). Returns best-effort; never throws.
async function gatherOverlayPageContext({ send, superseded }) {
  let pageContext = null;
  try {
    const target = await getActiveBrowserTarget();
    console.log(
      "[scrape] active browser URL:",
      target ? `${target.url} (${target.appName})` : "(none detected)",
    );
    if (target && target.url) {
      let title = "";
      let text = "";
      let kind = "page";

      // YouTube (or other video): the spoken content isn't in the page text,
      // so fetch the caption transcript instead.
      const ytId = parseYouTubeId(target.url);
      if (ytId) {
        send("lykn:answer-status", { status: "Reading the video transcript…" });
        const yt = await Promise.race([
          fetchYouTubeTranscript(ytId, target.appName),
          new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
        ]);
        if (superseded()) return { pageContext: null, pastPageSection: "" };
        if (yt && yt.text) {
          title = yt.title || "";
          text = yt.text;
          kind = "video";
          console.log(`[scrape] OK (yt transcript) — "${title || ytId}" (${text.length} chars)`);
        } else {
          console.log("[scrape] no transcript/captions available for video", ytId);
        }
      }

      if (text) {
        // already have video transcript — skip the DOM/HTTP path below
        pageContext = { url: target.url, title, text: text.slice(0, 16000), kind };
        send("lykn:page-source", { url: target.url, title });
      } else {
        send("lykn:answer-status", { status: "Reading the page…" });
        // 1) Live rendered DOM from the user's own tab (most reliable).
        const live = await getBrowserPageText(target.appName);
        if (live) {
          const nl = live.indexOf("\n");
          title = nl > 0 ? live.slice(0, nl).trim() : "";
          text = (nl > 0 ? live.slice(nl + 1) : live)
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          console.log(`[scrape] OK (live DOM) — "${title || "(no title)"}" (${text.length} chars)`);
        } else {
          // 2) Fall back to a plain HTTP fetch (works for non-bot-blocked pages).
          const page = await scrapePageText(target.url);
          if (page && page.text) {
            title = page.title;
            text = page.text;
            console.log(`[scrape] OK (http) — "${title || "(no title)"}" (${text.length} chars)`);
          }
        }
        if (text) {
          pageContext = { url: target.url, title, text: text.slice(0, 12000) };
          send("lykn:page-source", { url: target.url, title });
        } else {
          console.log("[scrape] failed to extract text from", target.url);
        }
      }
    }
  } catch (e) {
    console.log("[scrape] error:", e && e.message ? e.message : e);
  }

  // Recall earlier ⌘L conversations the user had on this same page, so LYKN can
  // pick up where it left off instead of starting cold each visit.
  let pastPageSection = "";
  if (pageContext && pageContext.url) {
    try {
      const store = await readOverlaySessionsStore();
      pastPageSection = await buildPastPageConversationSection(
        normalizeUrlForMatch(pageContext.url),
        store.currentSessionId,
      );
    } catch {
      /* best-effort */
    }
  }

  return { pageContext, pastPageSection };
}

async function streamScreenAnswer(event, { text, history, attachments }) {
  const wc = event.sender;
  const askGen = ++overlayAskGeneration;
  if (overlayAskAbort) {
    try {
      overlayAskAbort.abort();
    } catch {
      /* ignore */
    }
  }
  overlayAskAbort = new AbortController();
  const askSignal = overlayAskAbort.signal;

  const send = (channel, payload) => {
    if (askGen !== overlayAskGeneration) return;
    if (!wc.isDestroyed()) wc.send(channel, payload);
  };
  const superseded = () => askGen !== overlayAskGeneration || askSignal.aborted;

  // Split dropped attachments into images (sent as image inputs) and text files
  // (inlined into the prompt).
  const atts = Array.isArray(attachments) ? attachments : [];
  const imageAtts = atts.filter((a) => a && a.kind === "image" && a.dataUrl);
  const textAtts = atts.filter((a) => a && a.kind === "text" && a.text);
  const conversationFollowUp = overlayMessageIsConversationFollowUp(text, history);
  const skipScreenContext =
    conversationFollowUp && imageAtts.length === 0 && textAtts.length === 0;
  const liveWatchSummary = !skipScreenContext ? getFreshLiveWatchSummary(4000) : "";

  // Fail fast on missing permission before kicking off any work.
  const needScreen = !skipScreenContext && imageAtts.length === 0;
  if (needScreen && screenCaptureStatus() !== "granted") {
    send("lykn:answer-error", {
      message:
        "LYKN needs Screen Recording permission. Enable it in System Settings → Privacy & Security → Screen Recording, then reopen LYKN.",
    });
    return;
  }

  // Gather everything the backend needs CONCURRENTLY. The screenshot, the page
  // scrape, and the auth token are independent of each other, so running them in
  // parallel (instead of one-after-another) is the single biggest win for
  // time-to-first-token — pre-fetch latency drops from sum() to max().
  const capturePromise =
    !skipScreenContext && screenCaptureStatus() === "granted"
      ? liveWatchSummary && liveWatchLastFrameUrl
        ? Promise.resolve(liveWatchLastFrameUrl)
        : capturePrimaryScreen({ maxWidth: 1536, format: "jpeg", quality: 82 }).catch(() => null)
      : Promise.resolve(null);
  const pageContextPromise =
    imageAtts.length === 0 && !skipScreenContext
      ? gatherOverlayPageContext({ send, superseded })
      : Promise.resolve({ pageContext: null, pastPageSection: "" });
  const tokenPromise = getAuthToken().catch(() => null);

  const [dataURL, pageBundle, token] = await Promise.all([
    capturePromise,
    pageContextPromise,
    tokenPromise,
  ]);
  if (superseded()) return;

  const pageContext = pageBundle?.pageContext || null;
  const pastPageSection = pageBundle?.pastPageSection || "";

  if (needScreen && !dataURL) {
    send("lykn:answer-error", { message: "Couldn't capture the screen." });
    return;
  }
  if (!token) {
    send("lykn:answer-error", {
      message: "Sign in to LYKN first — open the main LYKN window and log in, then try again.",
    });
    return;
  }

  const hasVideoTranscript = pageContext?.kind === "video" && !!pageContext?.text;
  // If we scraped substantial page text, the text IS the context — so drop the
  // screenshot and let the request go text-only. That keeps the backend on the
  // fast model (no nano→gpt-4.1 vision upgrade) and shrinks the upload to almost
  // nothing — the single biggest "feels instant" win for reading pages. We still
  // captured the screenshot above as a fallback for thin pages / non-browser apps.
  const RICH_PAGE_TEXT_CHARS = 1200;
  const hasRichPageText =
    !!pageContext &&
    pageContext.kind !== "video" &&
    (pageContext.text?.length || 0) >= RICH_PAGE_TEXT_CHARS;
  // Live Watch already ran a recent vision pass — skip the screenshot upload when
  // there's no scraped page text (games, native apps) to stay fast.
  let attachScreenshot =
    !!dataURL && !hasVideoTranscript && !hasRichPageText && !liveWatchSummary;
  if (hasRichPageText && dataURL) {
    console.log(
      `[overlay-ask] text-rich page (${pageContext.text.length} chars) — dropping screenshot, staying on fast model`,
    );
  }
  let prompt = skipScreenContext
    ? "You are LYKN, a helpful assistant. The user is continuing an ongoing conversation " +
      "with you — respond naturally to their latest message. Do NOT describe their screen, " +
      "do NOT say 'on your screen I see', and do NOT re-introduce context they already know. " +
      "Keep it brief and conversational unless they ask for more detail."
    : hasVideoTranscript
    ? "You are LYKN, a helpful assistant. The user is watching a video and its " +
      "caption transcript is provided below. Answer their question using that " +
      "transcript as the authoritative source — summarize, explain, or quote from it. " +
      "Be concise and specific. Do NOT ask them to paste the video link."
    : attachScreenshot
    ? "You are LYKN, a helpful assistant that CAN see the user's screen. The attached " +
      "image is a screenshot of their current screen, provided as CONTEXT. " +
      "The user is looking at their screen while talking to you, so when their message " +
      "is ambiguous or uses words like 'this', 'that', 'it', 'here', 'the question', " +
      "'the answer', or 'this one' without a clear referent earlier in the conversation, " +
      "ASSUME they mean what is currently on their screen and use the screenshot to answer " +
      "specifically. Only treat the message as unrelated to the screen when it is clearly a " +
      "general question or normal conversation — in that case answer normally and do NOT " +
      "describe what's on screen. When in doubt, look at the screen first. " +
      "If the user's message is just small talk, an acknowledgement, or a thank-you " +
      "(e.g. 'gotcha thanks', 'cool', 'makes sense'), reply briefly and warmly in one line " +
      "and do NOT read or describe the screen. Match the user's energy — short messages get short replies. " +
      "Be concise and specific. " +
      OVERLAY_IGNORE_NOTE
    : hasRichPageText
    ? "You are LYKN, a helpful assistant. The user is reading the web page whose full text " +
      "is provided below — treat that text as your view of their screen and answer from it " +
      "directly and specifically. When their message is ambiguous or uses words like 'this', " +
      "'that', 'it', 'the question', or 'the answer', assume they mean something on this page. " +
      "If their message is clearly a general question or just small talk, answer normally and " +
      "do NOT summarize the page. If they ask about something purely visual that isn't in the " +
      "text, say briefly you can't see it this time. Be concise and specific."
    : "You are LYKN, a helpful assistant. Use the attached image(s) and any files below " +
      "if they're relevant to the user's question; otherwise just answer normally. " +
      "Be concise and specific.";
  prompt +=
    "\n\nFormat your answer in clean Markdown: use short ## headers to group " +
    "sections when helpful, '- ' bullet points for lists, **bold** for key terms, " +
    "and `code` for code/identifiers. Keep it scannable — don't write one long " +
    "paragraph when bullets or headers would read better.";
  if (textAtts.length) {
    prompt +=
      "\n\nAttached files:\n" +
      textAtts
        .map((a) => `--- ${a.name || "file"} ---\n${String(a.text).slice(0, 8000)}`)
        .join("\n\n");
  }
  if (pageContext && pageContext.kind === "video") {
    prompt +=
      "\n\nFor context, the user is currently watching this video and its spoken " +
      "transcript (from captions) is provided below. If their question is about the " +
      "video, use this transcript as the authoritative source — summarize, answer, or " +
      "quote from it directly without asking them to paste anything. If their question " +
      "is NOT about the video, ignore this and answer normally.\n" +
      `URL: ${pageContext.url}\n` +
      (pageContext.title ? `Video title: ${pageContext.title}\n` : "") +
      `--- VIDEO TRANSCRIPT ---\n${pageContext.text}\n--- END VIDEO TRANSCRIPT ---`;
  } else if (pageContext) {
    prompt +=
      "\n\nFor context, the user currently has this web page open and its full text " +
      "was scraped below. If their question is about this page/article, use this text " +
      "as the primary, authoritative source (it's more complete than the screenshot) " +
      "and answer directly without asking for a link. If their question is NOT about " +
      "this page, ignore it and just answer normally.\n" +
      `URL: ${pageContext.url}\n` +
      (pageContext.title ? `Page title: ${pageContext.title}\n` : "") +
      `--- PAGE CONTENT ---\n${pageContext.text}\n--- END PAGE CONTENT ---`;
  }
  if (pastPageSection) {
    prompt +=
      "\n\nYou (LYKN) have spoken with this user about this exact page before. " +
      "Below are excerpts from those earlier conversations. Use them for continuity: " +
      "remember what you already explained, build on it, and avoid repeating yourself. " +
      "If the user's new question is unrelated to this prior context, ignore it.\n" +
      "--- EARLIER CONVERSATIONS ON THIS PAGE ---\n" +
      pastPageSection +
      "\n--- END EARLIER CONVERSATIONS ---";
  }
  if (!skipScreenContext) {
    const liveSection = getLiveWatchContextSection();
    if (liveSection) prompt += liveSection;
  }
  prompt += `\n\nUser: ${String(text || "").slice(0, 4000)}`;

  // Attach the screenshot only when we actually need it (no video transcript and
  // no rich page text). Dropping it for text-rich pages keeps the request on the
  // fast model and avoids a multi-hundred-KB upload.
  const imageUrls = attachScreenshot
    ? [dataURL, ...imageAtts.map((a) => a.dataUrl)]
    : imageAtts.map((a) => a.dataUrl);

  const body = {
    model: "lykn",
    intent: "ask",
    text: String(text || "").slice(0, 4000),
    prompt,
    imageUrls,
    useTools: !hasVideoTranscript && !skipScreenContext,
    skipWebSearch: true,
    overlayAsk: true,
    ...(Array.isArray(history) && history.length ? { conversation: history.slice(-8) } : {}),
  };

  try {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (superseded()) return;
      if (attempt > 0) {
        send("lykn:answer-status", { status: "Retrying…" });
        await new Promise((r) => setTimeout(r, 700 * attempt));
      } else {
        send("lykn:answer-status", { status: hasVideoTranscript ? "Analyzing transcript…" : "Thinking…" });
      }
      try {
        const res = await fetch(`${API_BASE}/api/ai/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: askSignal,
        });
        const accumulated = await readOverlayStreamResponse(res, send);
        if (superseded()) return;
        send("lykn:answer-done", { text: accumulated });
        return;
      } catch (e) {
        if (superseded()) return;
        lastErr = e;
        if (!isRetryableStreamError(e) || attempt >= 2) break;
        console.log("[overlay-ask] retry after stream error:", e && e.message ? e.message : e);
      }
    }
    send("lykn:answer-error", { message: humanizeStreamError(lastErr) });
  } catch (e) {
    if (superseded()) return;
    send("lykn:answer-error", { message: humanizeStreamError(e) });
  }
}

// Capture the current screen and ask the vision model for a short text
// description. Voice Mode can't receive images, so we feed this summary into the
// live agent as contextual text — giving voice the same "sees your screen"
// ability the typed overlay chat has.
async function captureScreenDescription() {
  const liveSummary = getFreshLiveWatchSummary(8000);
  if (liveSummary) return { text: liveSummary, source: "live_watch" };

  const status = screenCaptureStatus();
  console.log("[screen-context] capture status:", status);
  if (status !== "granted") return { error: "no_permission" };
  let dataURL = null;
  try {
    dataURL = await capturePrimaryScreen();
  } catch (e) {
    console.log("[screen-context] capture threw:", e && e.message);
    return { error: "capture_failed" };
  }
  console.log("[screen-context] dataURL length:", dataURL ? dataURL.length : 0);
  if (!dataURL) return { error: "capture_failed" };

  const token = await getAuthToken();
  console.log("[screen-context] has token:", !!token);
  if (!token) return { error: "not_authenticated" };

  const body = {
    model: "lykn",
    intent: "ask",
    text: "Describe the user's current screen.",
    prompt:
      "The attached image is a screenshot of the user's current screen. In 2–4 short " +
      "sentences, concisely describe what is on screen: the app/website, the page or view, " +
      "any important visible text, and what the user appears to be doing. Do not greet, " +
      "ask questions, or add commentary — just the description. " +
      OVERLAY_IGNORE_NOTE,
    imageUrls: [dataURL],
    useTools: false,
  };

  try {
    const res = await fetch(`${API_BASE}/api/ai/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    console.log("[screen-context] /api/ai/stream status:", res.status, "ctype:", res.headers.get("content-type"));
    if (!res.ok || !res.body) return { error: `screen_describe_failed_${res.status}` };

    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      const data = await res.json().catch(() => null);
      const answer = stripHiddenTags(data?.response || data?.answer || data?.text || "");
      console.log("[screen-context] non-SSE answer length:", answer.length);
      return { text: answer.trim() };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accumulated = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(t.indexOf(":") + 1).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (typeof j.t === "string") accumulated += j.t;
        } catch {
          /* ignore keepalive */
        }
      }
    }
    const finalText = stripHiddenTags(accumulated).trim();
    console.log("[screen-context] SSE answer length:", finalText.length, "preview:", finalText.slice(0, 120));
    return { text: finalText };
  } catch (e) {
    console.log("[screen-context] fetch threw:", e && e.message);
    return { error: `screen_describe_failed: ${e && e.message ? e.message : e}` };
  }
}

// POST a one-shot request to the AI stream endpoint and return the full
// accumulated text (handles both SSE and plain-JSON responses).
async function postAiStreamText(body, token) {
  const res = await fetch(`${API_BASE}/api/ai/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) return "";
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/event-stream")) {
    const data = await res.json().catch(() => null);
    return stripHiddenTags(data?.response || data?.answer || data?.text || "").trim();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(t.indexOf(":") + 1).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (typeof j.t === "string") accumulated += j.t;
      } catch {
        /* ignore keepalive */
      }
    }
  }
  return stripHiddenTags(accumulated).trim();
}

// Ask the vision model for the bounding box (as 0..1 fractions from the
// top-left) of the on-screen region the user described. Returns { full: true }
// for "whole screen", a { x, y, width, height } box, or null if undetermined.
async function requestScreenRegionBox(dataURL, description, token, model = "lykn") {
  const isGemini = String(model || "").startsWith("gemini");
  // Each model speaks its own box dialect. Gemini's grounding is native to
  // [ymin, xmin, ymax, xmax] on a 0–1000 scale; everyone else gets the simple
  // 0..1 {x,y,width,height}. The parser below tolerates either regardless.
  const formatInstruction = isGemini
    ? "Respond with ONLY a JSON array of four integers [ymin, xmin, ymax, xmax] giving the " +
      "tight bounding box on a 0–1000 scale (the standard Gemini box_2d convention), measured " +
      "from the top-left corner. If the user means the whole screen, or you cannot identify a " +
      'specific region, respond exactly {"full":true}. No other text or code fences.'
    : "Respond with ONLY a compact JSON object giving the tight bounding box to crop, using " +
      'fractions of the image measured from the TOP-LEFT corner: {"x":<0..1>,"y":<0..1>,"width":<0..1>,"height":<0..1>}. ' +
      "Draw the box snugly around the described element. If the user means the whole screen, or " +
      'you cannot confidently identify a specific region, respond exactly {"full":true}. No other ' +
      "text or code fences.";
  const body = {
    model,
    // NOTE: a non-chat intent is deliberate. "ask"/"chat"/"question" trigger the
    // server's full LYKN enrichment (synthesis, beliefs, user model, identity),
    // which prepends ~70K+ chars of irrelevant context and wrecks the model's
    // visual grounding. A non-chat intent skips all of that so the model sees
    // only the screenshot + this instruction. For non-chat intents the server
    // passes `prompt` straight to the model, so the instruction lives there.
    intent: "vision_box",
    text: "Find the region to crop.",
    prompt:
      "You are a precise vision grounding tool. The attached image is a screenshot of the " +
      'user\'s screen. The user wants to SAVE a specific part of it, described as: "' +
      String(description || "").slice(0, 400) +
      '". ' +
      formatInstruction,
    imageUrls: [dataURL],
    useTools: false,
    skipWebSearch: true,
  };
  let text = "";
  try {
    text = await postAiStreamText(body, token);
  } catch {
    return null;
  }
  return parseRegionBox(text, isGemini);
}

// Tolerant box parser. Accepts the 0..1 {x,y,width,height} object, the corner
// {ymin,xmin,ymax,xmax} object, or a bare [ymin,xmin,ymax,xmax]/[xmin,ymin,...]
// array — at either 0..1 or 0–1000 scale. Returns { full } / {x,y,width,height}
// fractions / null. `geminiOrder` decides array axis order (y-first for Gemini).
function parseRegionBox(text, geminiOrder) {
  if (!text) return null;
  if (/"full"\s*:\s*true/i.test(text)) return { full: true };
  // Normalize a set of numbers to 0..1: if anything looks like 0–1000, scale down.
  const toFrac = (vals) => {
    const maxV = Math.max(...vals.map((v) => Math.abs(v)));
    const scale = maxV > 1.5 ? 1000 : 1;
    return vals.map((v) => v / scale);
  };
  const cornersToBox = (ymin, xmin, ymax, xmax) => ({
    x: Math.min(xmin, xmax),
    y: Math.min(ymin, ymax),
    width: Math.abs(xmax - xmin),
    height: Math.abs(ymax - ymin),
  });

  // 1) Bare array of 4 numbers.
  const arrMatch = text.match(/\[\s*-?\d[\d.\s,+-]*\]/);
  if (arrMatch) {
    const nums = (arrMatch[0].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length >= 4) {
      const [a, b, c, d] = toFrac(nums.slice(0, 4));
      // Gemini → [ymin, xmin, ymax, xmax]; otherwise assume [xmin, ymin, xmax, ymax].
      return geminiOrder ? cornersToBox(a, b, c, d) : cornersToBox(b, a, d, c);
    }
  }

  // 2) JSON object with named keys.
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    let obj;
    try {
      obj = JSON.parse(objMatch[0]);
    } catch {
      obj = null;
    }
    if (obj) {
      if (obj.full === true) return { full: true };
      const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
      const ymin = num(obj.ymin),
        xmin = num(obj.xmin),
        ymax = num(obj.ymax),
        xmax = num(obj.xmax);
      if (ymin !== null && xmin !== null && ymax !== null && xmax !== null) {
        const [yn, xn, yx, xx] = toFrac([ymin, xmin, ymax, xmax]);
        return cornersToBox(yn, xn, yx, xx);
      }
      const x = num(obj.x),
        y = num(obj.y),
        w = num(obj.width),
        h = num(obj.height);
      if (x !== null && y !== null && w !== null && h !== null) {
        const [xf, yf, wf, hf] = toFrac([x, y, w, h]);
        return { x: xf, y: yf, width: wf, height: hf };
      }
    }
  }
  return null;
}

// Capture the screen, let the AI pick the region the user described, crop to it
// (full screen if unsure), then save the PNG to Downloads and copy it to the
// clipboard. The "drag from screen" replacement: LYKN grabs the region for you.
async function saveScreenRegion(description) {
  if (screenCaptureStatus() !== "granted") return { ok: false, error: "no_permission" };
  let dataURL = null;
  try {
    dataURL = await capturePrimaryScreen();
  } catch {
    dataURL = null;
  }
  if (!dataURL) return { ok: false, error: "capture_failed" };

  let image = nativeImage.createFromDataURL(dataURL);
  if (!image || image.isEmpty()) return { ok: false, error: "capture_failed" };
  const { width: imgW, height: imgH } = image.getSize();

  let full = true;
  const token = await getAuthToken();
  if (token && String(description || "").trim()) {
    // Use the default reader (gpt-4.1 on the image turn). NOTE: gemini-pro is
    // plan-locked for most tiers and silently downgrades to this anyway, so we
    // don't waste a round-trip requesting it.
    const box = await requestScreenRegionBox(dataURL, description, token, "lykn");
    if (box && !box.full) {
      // Clamp the fractional box to the image.
      let x = Math.max(0, Math.min(1, box.x));
      let y = Math.max(0, Math.min(1, box.y));
      let w = Math.max(0.02, Math.min(1 - x, box.width));
      let h = Math.max(0.02, Math.min(1 - y, box.height));
      // Tiny safety margin so a slightly-off detection still fully contains the
      // subject without obviously over-cropping. We now ask for a tight box, so
      // keep this minimal (~3% of the box).
      const padX = w * 0.03;
      const padY = h * 0.03;
      x = Math.max(0, x - padX);
      y = Math.max(0, y - padY);
      w = Math.min(1 - x, w + padX * 2);
      h = Math.min(1 - y, h + padY * 2);
      const rect = {
        x: Math.round(x * imgW),
        y: Math.round(y * imgH),
        width: Math.max(1, Math.round(w * imgW)),
        height: Math.max(1, Math.round(h * imgH)),
      };
      try {
        const cropped = image.crop(rect);
        if (cropped && !cropped.isEmpty()) {
          image = cropped;
          full = false;
        }
      } catch {
        /* fall back to full screen */
      }
    }
  }

  const png = image.toPNG();
  const stamp = new Date()
    .toLocaleString("sv")
    .replace(/[:]/g, ".")
    .replace(" ", " at ");
  const fileName = `LYKN Screenshot ${stamp}.png`;
  let savedPath = null;
  try {
    savedPath = path.join(app.getPath("downloads"), fileName);
    await fs.writeFile(savedPath, png);
  } catch {
    savedPath = null;
  }
  try {
    clipboard.writeImage(image);
  } catch {
    /* clipboard best-effort */
  }

  // The AI took this shot because the user asked us to "save" something, so it
  // belongs in their Vault too — not just Downloads/clipboard. Best-effort: a
  // vault failure (offline, not signed in) shouldn't fail the whole snip.
  const { width: outW, height: outH } = image.getSize();
  let savedToVault = false;
  try {
    const title = (String(description || "").trim() || "Screenshot").slice(0, 120);
    savedToVault = await saveImageToVault(png, {
      title,
      fileName,
      width: outW,
      height: outH,
      token,
    });
  } catch {
    savedToVault = false;
  }

  return {
    ok: true,
    full,
    fileName: savedPath ? fileName : null,
    savedToFile: !!savedPath,
    savedToVault,
    width: outW,
    height: outH,
  };
}

// POST a PNG buffer to the server, which uploads it to storage and creates a
// vault_items row (the browser upload pipeline can't run in the Electron main
// process). Multipart so large screenshots aren't capped by the JSON body
// limit. Returns true on success. Best-effort by design.
async function saveImageToVault(png, { title, fileName, width, height, token } = {}) {
  const authToken = token || (await getAuthToken());
  if (!authToken || !png || !png.length) return false;
  try {
    const form = new FormData();
    form.append(
      "image",
      new Blob([png], { type: "image/png" }),
      fileName || "screenshot.png",
    );
    if (title) form.append("title", String(title));
    if (width) form.append("width", String(width));
    if (height) form.append("height", String(height));
    const res = await fetch(`${API_BASE}/api/vault/save-image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    });
    const data = await res.json().catch(() => null);
    return !!(res.ok && data && data.ok);
  } catch {
    return false;
  }
}

function registerOverlayIpc() {
  ipcMain.on("lykn:hide-overlay", () => hideOverlay());
  ipcMain.handle("lykn:save-screen-region", async (_e, description) => {
    try {
      return await saveScreenRegion(description);
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : "save_failed" };
    }
  });
  ipcMain.on("lykn:open-main", () => {
    if (!mainWindow) createMainWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  ipcMain.on("lykn:open-app-chat", (_e, chatId) => {
    const id = String(chatId || "").trim();
    const url = id ? `${APP_ORIGIN}/chat/${encodeURIComponent(id)}` : APP_URL;
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    else mainWindow.loadURL(url);
    mainWindow.show();
    mainWindow.focus();
  });
  ipcMain.on("lykn:resize", (_e, payload) => {
    // Back-compat: a bare number is height-only; an object carries width too.
    if (payload && typeof payload === "object") {
      setOverlaySize(payload.width, payload.height);
    } else {
      setOverlaySize(OVERLAY_WIDTH, payload);
    }
  });
  ipcMain.on("lykn:collapse", (_e, collapsed) => setOverlayCollapsed(!!collapsed));
  // Content protection (exclude the overlay from screen capture). Persisted so
  // it survives restarts; applied to overlay + burst windows immediately.
  ipcMain.handle("lykn:get-content-protection", () => isContentProtectionEnabled());
  ipcMain.handle("lykn:set-content-protection", (_e, enabled) => {
    const on = !!enabled;
    writeOverlaySettings({ contentProtection: on });
    applyContentProtection(on);
    return on;
  });
  // Live Watch — continuous screen awareness with motion-aware frame diffing.
  ipcMain.handle("lykn:get-live-watch", () => getLiveWatchStatus());
  ipcMain.handle("lykn:set-live-watch", (_e, enabled) => setLiveWatchEnabled(!!enabled));
  ipcMain.handle("lykn:add-live-watch-rule", (_e, { text } = {}) => {
    if (!liveWatchState.enabled) return { ok: false, error: "watch_off" };
    const ruleText = parseWatchRuleIntent(text) || String(text || "").trim();
    if (!ruleText) return { ok: false, error: "empty_rule" };
    const entry = addLiveWatchRule(ruleText);
    return { ok: true, rule: entry?.text || ruleText, rules: liveWatchState.rules.map((r) => r.text) };
  });
  ipcMain.handle("lykn:clear-live-watch-rules", () => {
    clearLiveWatchRules();
    return { ok: true, rules: [] };
  });
  ipcMain.on("lykn:move-by", (_e, { dx, dy }) => {
    if (!overlayWindow) return;
    const b = overlayWindow.getBounds();
    const nx = b.x + Math.round(dx || 0);
    const ny = b.y + Math.round(dy || 0);
    overlayProgrammaticMove = true;
    overlayWindow.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
    overlayProgrammaticMove = false;
    overlayUserPositioned = true;
    overlayAnchorLeft = nx;
    overlayAnchorBottomY = ny + b.height;
  });
  ipcMain.on("lykn:ask", (event, args) => {
    streamScreenAnswer(event, args || {});
  });

  // Save a note (task summary, snippet, etc.) into the user's LYKN vault.
  ipcMain.handle("lykn:save-vault-note", async (_e, { title, content, tags, folder } = {}) => {
    try {
      const body = String(content || "").trim();
      if (!body) return { ok: false, error: "empty" };
      const token = await getAuthToken();
      if (!token) return { ok: false, error: "no_auth" };
      const res = await fetch(`${API_BASE}/api/v1/synthesis/vault`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: String(title || "").slice(0, 200),
          content: body.slice(0, 60000),
          tags: Array.isArray(tags) ? tags.slice(0, 12).map((t) => String(t).slice(0, 32)) : undefined,
          folder: folder ? String(folder).slice(0, 80) : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        return { ok: false, error: (data && (data.error || data.text)) || `HTTP ${res.status}` };
      }
      return { ok: true, note: data.note || null };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : "save_failed" };
    }
  });

  // Native "attach files" picker. Dragging onto an always-on-top non-activating
  // panel is unreliable on macOS, so this is the dependable way to attach. We
  // read the files here and return ready-to-send attachment objects.
  ipcMain.handle("lykn:pick-files", async () => {
    try {
      // The overlay is a non-activating panel, so the app isn't frontmost — pull
      // it forward and parent the dialog to the overlay so the picker appears in
      // front instead of behind whatever app the user is in.
      try { app.focus({ steal: true }); } catch {}
      const parent =
        overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : undefined;
      const res = await dialog.showOpenDialog(parent, {
        properties: ["openFile", "multiSelections"],
        title: "Attach files to LYKN",
      });
      if (res.canceled || !Array.isArray(res.filePaths)) return [];
      const out = [];
      for (const p of res.filePaths.slice(0, 6)) {
        try {
          const name = path.basename(p);
          const ext = path.extname(p).toLowerCase();
          const imgMime = IMAGE_MIME_BY_EXT[ext];
          if (imgMime) {
            const buf = await fs.readFile(p);
            out.push({ kind: "image", name, dataUrl: `data:${imgMime};base64,${buf.toString("base64")}` });
          } else if (TEXT_FILE_RE.test(name)) {
            const text = await fs.readFile(p, "utf8");
            out.push({ kind: "text", name, text });
          } else {
            out.push({ kind: "text", name, text: "(Unsupported file type — not included.)" });
          }
        } catch {
          /* skip unreadable file */
        }
      }
      return out;
    } catch {
      return [];
    }
  });

  // Snip-to-attach: let the user drag-select a region of the screen (native
  // macOS crosshair) and return it as an image attachment — "grab what's on
  // screen" without downloading anything. The overlay is hidden during the
  // selection so it's never in the way (and never in the shot).
  ipcMain.handle("lykn:snip-screen", async () => {
    if (process.platform !== "darwin") {
      // Fallback for non-macOS: capture the whole primary screen.
      try {
        const dataUrl = await capturePrimaryScreen();
        return dataUrl ? { kind: "image", name: "Screenshot.png", dataUrl } : null;
      } catch {
        return null;
      }
    }
    const outPath = path.join(app.getPath("temp"), `lykn-snip-${crypto.randomUUID()}.png`);
    try {
      await withOverlayHiddenForClick(
        () =>
          new Promise((resolve) => {
            // -i: interactive region select, -x: no camera sound.
            execFile("screencapture", ["-i", "-x", outPath], () => resolve());
          }),
      );
      // The file only exists if the user actually completed a selection
      // (pressing Escape cancels and writes nothing).
      let buf = null;
      try {
        buf = await fs.readFile(outPath);
      } catch {
        buf = null;
      }
      if (!buf || !buf.length) return null;
      return {
        kind: "image",
        name: "Screenshot.png",
        dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
      };
    } catch {
      return null;
    } finally {
      try {
        await fs.unlink(outPath);
      } catch {
        /* nothing to clean up */
      }
    }
  });

  // Past chats — merge ⌘L overlay sessions (local) with app chats (Supabase).
  ipcMain.handle("lykn:list-chats", async () => {
    const store = await readOverlaySessionsStore();
    const overlay = store.sessions
      .map((s) => ({
        id: s.id,
        title: s.title || overlaySessionTitle(s.messages),
        preview: overlaySessionPreview(s.messages),
        updatedAt: s.updatedAt || null,
        source: "overlay",
      }))
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    const appResult = await fetchAppChatsForOverlay();
    // Overlay sessions are now also mirrored into the app store (so they show
    // in the app's sidebar), which means they come back in BOTH lists with the
    // same id. The local overlay copy is canonical here (clicking it loads the
    // session inline), so drop the app duplicates to avoid double entries.
    const overlayIds = new Set(overlay.map((s) => s.id));
    const app = (appResult.chats || []).filter((c) => !overlayIds.has(c.id));
    return {
      overlay,
      app,
      currentSessionId: store.currentSessionId,
      error: appResult.error || null,
    };
  });

  ipcMain.handle("lykn:get-overlay-session", async (_e, sessionId) => {
    const id = String(sessionId || "").trim();
    if (!id) return null;
    const store = await readOverlaySessionsStore();
    const session = store.sessions.find((s) => s.id === id);
    return session || null;
  });

  ipcMain.handle("lykn:save-overlay-session", async (_e, payload = {}) => {
    const messages = Array.isArray(payload.messages)
      ? payload.messages
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
          .map((m) => ({
            role: m.role,
            content: String(m.content).slice(0, 12000),
            at: m.at || new Date().toISOString(),
          }))
      : [];
    if (!messages.length) return { ok: false };

    const store = await readOverlaySessionsStore();
    let sessionId = String(payload.sessionId || store.currentSessionId || "").trim();
    if (!sessionId) sessionId = crypto.randomUUID();

    const now = new Date().toISOString();
    const title = String(payload.title || "").trim() || overlaySessionTitle(messages);
    const existingIdx = store.sessions.findIndex((s) => s.id === sessionId);
    const existing = existingIdx >= 0 ? store.sessions[existingIdx] : null;

    // Track which pages this conversation touched so we can recall it later when
    // the user returns to the same page. Merge with any pages already recorded.
    const pageSource =
      payload.pageSource && payload.pageSource.url ? payload.pageSource : null;
    const pages = new Set(
      existing && Array.isArray(existing.pages) ? existing.pages : [],
    );
    let pageUrl = existing ? existing.pageUrl || null : null;
    let pageTitle = existing ? existing.pageTitle || null : null;
    if (pageSource) {
      const norm = normalizeUrlForMatch(pageSource.url);
      if (norm) pages.add(norm);
      pageUrl = pageSource.url;
      pageTitle = pageSource.title || pageTitle;
    }

    const session = {
      id: sessionId,
      title,
      updatedAt: now,
      messages,
      pages: Array.from(pages).slice(-20),
      pageUrl,
      pageTitle,
    };
    if (existingIdx >= 0) store.sessions[existingIdx] = session;
    else store.sessions.unshift(session);

    store.sessions.sort(
      (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
    );
    store.sessions = store.sessions.slice(0, 80);
    store.currentSessionId = sessionId;
    await writeOverlaySessionsStore(store);

    // Mirror the conversation into the app's chat store (lykn_chats /
    // lykn_chat_states) so it also appears in the actual app's "previous
    // chats" — not just the overlay's local list. Fire-and-forget: a failure
    // (offline, signed out) must never break the local save above.
    void pushOverlaySessionToApp(sessionId, title, messages);

    return { ok: true, sessionId };
  });

  ipcMain.handle("lykn:new-overlay-session", async () => {
    const store = await readOverlaySessionsStore();
    const sessionId = crypto.randomUUID();
    store.currentSessionId = sessionId;
    await writeOverlaySessionsStore(store);
    return { sessionId };
  });

  ipcMain.handle("lykn:ensure-overlay-session", async () => {
    const store = await readOverlaySessionsStore();
    if (store.currentSessionId) return { sessionId: store.currentSessionId };
    const sessionId = crypto.randomUUID();
    store.currentSessionId = sessionId;
    await writeOverlaySessionsStore(store);
    return { sessionId };
  });

  // Voice Mode: fetch an ElevenLabs session (signed URL / conversation token)
  // with the user's auth attached, so the overlay can open a live voice session.
  ipcMain.handle("lykn:voice-signed-url", async (_e, { instructions, timezone } = {}) => {
    try {
      const token = await getAuthToken();
      if (!token) return { error: "Sign in to LYKN first to use voice mode." };
      const res = await fetch(`${API_BASE}/api/ai/elevenlabs/signed-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          instructions: String(instructions || ""),
          chatId: null,
          timezone: timezone || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: String(data?.error || `Voice session failed (${res.status}).`) };
      return data;
    } catch (e) {
      return { error: `Voice session failed: ${e && e.message ? e.message : e}` };
    }
  });

  // Voice Mode tool dispatch — forwards an agent tool call to LYKN's realtime
  // tool endpoint with auth, mirroring the web app's /api/ai/realtime/tool path.
  ipcMain.handle("lykn:voice-tool", async (_e, { name, args } = {}) => {
    try {
      const token = await getAuthToken();
      if (!token) return { ok: false, error: "not_authenticated" };
      const res = await fetch(`${API_BASE}/api/ai/realtime/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, arguments: args ?? {}, chatId: null }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "bad_tool_response" }));
      return data;
    } catch {
      return { ok: false, error: "tool_request_failed" };
    }
  });

  // Voice Mode: capture + describe the current screen so the overlay can feed it
  // to the live agent as contextual text (voice can't take image inputs).
  ipcMain.handle("lykn:screen-context", async () => {
    return await captureScreenDescription();
  });

  // Voice Mode: capture + describe the screen, then push it to the server keyed
  // by the live session token so the custom-LLM injects it into every turn's
  // grounding. This is the reliable "voice sees your screen" path (it doesn't
  // depend on ElevenLabs forwarding contextual updates to the custom LLM).
  ipcMain.handle("lykn:voice-screen", async (_e, { sessionToken } = {}) => {
    try {
      if (!sessionToken) return { ok: false, error: "no_session" };
      const desc = await captureScreenDescription();
      if (!desc || desc.error || !desc.text) {
        return { ok: false, error: (desc && desc.error) || "no_text" };
      }
      const token = await getAuthToken();
      if (!token) return { ok: false, error: "not_authenticated" };
      const res = await fetch(`${API_BASE}/api/ai/realtime/screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionToken, text: desc.text }),
      });
      const data = await res.json().catch(() => ({}));
      console.log("[voice-screen] pushed:", res.status, "ok:", !!(data && data.ok));
      return data && data.ok ? { ok: true } : { ok: false, error: (data && data.error) || `http_${res.status}` };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : "failed" };
    }
  });

  // Make sure macOS has granted microphone access before the renderer records.
  ipcMain.handle("lykn:ensure-mic", async () => {
    if (process.platform !== "darwin") return true;
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "granted") return true;
      return await systemPreferences.askForMediaAccess("microphone");
    } catch {
      return false;
    }
  });

  // Transcribe dictated audio. The renderer records (getUserMedia/MediaRecorder)
  // and hands us the bytes; we attach the auth token and post to LYKN's whisper
  // endpoint here so the token never lives in the overlay renderer.
  ipcMain.handle("lykn:transcribe", async (_e, { audio, mimeType, prompt }) => {
    try {
      const token = await getAuthToken();
      if (!token) return { error: "Sign in to LYKN first to use dictation." };

      const buf = Buffer.from(audio);
      if (!buf || buf.length < 2000) return { text: "" };

      const fd = new FormData();
      fd.append("audio", new Blob([buf], { type: mimeType || "audio/webm" }), "dictation.webm");
      fd.append("model", "whisper-1");
      fd.append("language", "en");
      if (prompt) fd.append("prompt", String(prompt).split(/\s+/).slice(-12).join(" "));

      const res = await fetch(`${API_BASE}/api/ai/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: `Transcription failed (${res.status}).` };
      return {
        text: String(data?.text || "").trim(),
        noSpeech: Number(data?.no_speech_prob) || 0,
      };
    } catch (e) {
      return { error: `Transcription failed: ${e && e.message ? e.message : e}` };
    }
  });

  // Wispr-Flow-style cleanup for the live-listen transcript: strip fillers,
  // false starts, stutters and repeats from a raw Whisper chunk. Fails open
  // (returns the raw text) so the transcript never stalls on an error.
  ipcMain.handle("lykn:clean-transcript", async (_e, { text, context } = {}) => {
    const raw = String(text || "").trim();
    if (!raw) return { text: "" };
    try {
      const token = await getAuthToken();
      if (!token) return { text: raw };
      const res = await fetch(`${API_BASE}/api/ai/clean-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: raw, context: String(context || "") }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { text: raw };
      return { text: String(data?.text || "").trim() };
    } catch (_) {
      return { text: raw };
    }
  });

  // Open a URL in the user's default browser (overlay source links / answer
  // links). Never navigate the overlay window itself.
  ipcMain.on("lykn:open-url", (_e, url) => {
    const u = String(url || "").trim();
    if (/^https?:\/\//i.test(u)) shell.openExternal(u);
  });

  // Cluely-style suggestions after an answer: follow-up questions + real source
  // links looked up on the web. Best-effort: returns empty on any failure.
  // Browser control for the ⌘L overlay — scan interactables + plan/execute via
  // AppleScript JavaScript in the user's active browser tab.
  ipcMain.handle("lykn:browser-capability", async () => {
    if (process.platform !== "darwin") {
      return { ok: false, error: "unsupported", message: "Browser control is macOS-only for now." };
    }
    const target = await getActiveBrowserTarget();
    if (!target) {
      return { ok: false, error: "no_browser", message: "Open a browser tab first." };
    }
    const probe = await collectBrowserInteractables(runOsascript, target.appName);
    if (probe.error === "apple_events_disabled") {
      return {
        ok: false,
        error: "apple_events_disabled",
        browser: target.appName,
        url: target.url,
        message: "Enable “Allow JavaScript from Apple Events” in your browser.",
      };
    }
    if (probe.error) {
      return {
        ok: false,
        error: probe.error,
        browser: target.appName,
        url: target.url,
        message: probe.message || "Could not read the page.",
      };
    }
    return {
      ok: true,
      browser: target.appName,
      url: probe.page?.url || target.url,
      title: probe.page?.title || "",
      elementCount: Array.isArray(probe.page?.items) ? probe.page.items.length : 0,
    };
  });

  ipcMain.handle("lykn:browser-plan", async (_e, { intent, conversationHistory } = {}) => {
    const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
    if (process.platform !== "darwin") return fail("unsupported");
    const goal = String(intent || "").trim().slice(0, 500);
    if (!goal) return fail("no_intent");
    const target = await getActiveBrowserTarget();
    if (!target) {
      const hint = await describeBrowserTabProblem();
      return fail(hint?.error || "no_browser", {
        message: hint?.message || "Open an https:// page in your browser, then try again.",
      });
    }
    const collected = await collectBrowserInteractables(runOsascript, target.appName);
    if (collected.error === "apple_events_disabled") {
      return fail("apple_events_disabled", {
        browser: target.appName,
        url: target.url,
        message: "Enable “Allow JavaScript from Apple Events” in your browser.",
      });
    }
    if (collected.error || !collected.page) {
      return fail(collected.error || "scan_failed", {
        browser: target.appName,
        url: target.url,
        message: collected.message || "Could not scan the page.",
      });
    }
    const token = await getAuthToken();
    if (!token) return fail("no_auth", { message: "Sign in to LYKN to use browser control." });
    const pageCtx = await collectBrowserPageContext(runOsascript, target.appName);
    let pageText = String(pageCtx?.text || "");
    try {
      const live = await getBrowserPageText(target.appName);
      if (live && live.length > pageText.length) pageText = live;
    } catch (_) {}
    const imageUrl = await captureBrowserScreenThumbnail();
    try {
      const res = await fetch(`${API_BASE}/api/desktop/browser-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          intent: goal,
          url: collected.page.url || target.url,
          title: collected.page.title || "",
          pageText: pageText.slice(0, 15000),
          imageUrl: imageUrl || "",
          items: (collected.page.items || []).slice(0, 130),
          conversationHistory: Array.isArray(conversationHistory) ? conversationHistory.slice(-8) : [],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        return fail("plan_failed", { message: (data && data.error) || "Could not plan actions." });
      }
      const actions = resolvePlanActions(data.actions, collected.page.items || []);
      const explanation =
        String(data.explanation || "").trim() ||
        (actions.length
          ? ""
          : "Click Run once — LYKN will read the page, act step by step, and verify as it goes.");
      return {
        ok: true,
        browser: target.appName,
        appName: target.appName,
        url: collected.page.url || target.url,
        title: collected.page.title || "",
        explanation,
        taskPlan: String(data.taskPlan || "").trim(),
        plannedAnswer: String(data.plannedAnswer || "").trim(),
        actions,
        agentMode: data.agentMode || "",
        holoMessages: data.holoMessages || null,
      };
    } catch (e) {
      return fail("plan_failed", { message: e && e.message ? e.message : "Could not plan actions." });
    }
  });

  ipcMain.handle("lykn:browser-execute", async (event, { actions, appName, url, intent, taskPlan, conversationHistory, holoMessages: seedHoloMessages } = {}) => {
    const sendProgress = (status) => {
      try {
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send("lykn:browser-progress", { status: String(status || "") });
        }
      } catch (_) {}
    };
    if (browserExecuteInFlight) {
      return {
        ok: false,
        error: "busy",
        results: [],
        message: "Browser control is already running — wait for it to finish.",
      };
    }
    if (process.platform !== "darwin") {
      return { ok: false, error: "unsupported", results: [], message: "macOS only." };
    }
    const browser = String(appName || "").trim();
    if (!browser) {
      return {
        ok: false,
        error: "no_browser",
        results: [],
        message: "Missing browser name — plan again from Control this page.",
      };
    }
    const pageUrl = String(url || "").trim();
    const goal = String(intent || "").trim();

    if (process.platform === "darwin" && goal) {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        systemPreferences.isTrustedAccessibilityClient(true);
      }
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        return {
          ok: false,
          error: "accessibility_required",
          results: [],
          message:
            "Browser clicks need Accessibility. Open System Settings → Privacy & Security → Accessibility, enable LYKN (or Electron when developing), then quit and reopen the app.",
        };
      }
    }

    browserExecuteInFlight = true;
    const hadOverlay =
      overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
    if (hadOverlay) setOverlayClickThrough(true);
    await new Promise((r) => setTimeout(r, 200));

    let holoMessages = Array.isArray(seedHoloMessages) && seedHoloMessages.length ? seedHoloMessages : null;
    let lastScreenBrief = "";
    let lastAgentResult = "";

    async function callPlanNext(body) {
      const token = await getAuthToken();
      if (!token) return { error: "no_auth", message: "Sign in to LYKN to use browser control." };

      let pageText = String(body.pageText || "");
      if (!pageText) {
        const ctx = await collectBrowserPageContext(runOsascript, browser);
        if (ctx?.text) {
          pageText = ctx.text;
        } else {
          const live = await getBrowserPageText(browser);
          pageText = String(live || "");
        }
      } else {
        try {
          const live = await getBrowserPageText(browser);
          if (live && live.length > pageText.length) pageText = live;
        } catch (_) {}
      }

      const payload = {
        intent: String(body.intent || ""),
        url: String(body.url || ""),
        title: String(body.title || ""),
        pageText: pageText.slice(0, 15000),
        imageUrl: String(body.imageUrl || ""),
        items: Array.isArray(body.items) ? body.items : [],
        completedSteps: Array.isArray(body.completedSteps) ? body.completedSteps : [],
        stuckHint: String(body.stuckHint || "").slice(0, 500),
        taskPlan: String(body.taskPlan || "").slice(0, 2000),
        lastReasoning: String(body.lastReasoning || "").slice(0, 800),
        lastActionDiff: String(body.lastActionDiff || "").slice(0, 400),
        sessionSummary: String(body.sessionSummary || "").slice(0, 1200),
        conversationHistory: Array.isArray(body.conversationHistory) ? body.conversationHistory.slice(-8) : [],
      };

      if (holoMessages) payload.holoMessages = holoMessages;
      if (body.toolName) {
        payload.toolName = String(body.toolName);
        payload.toolOutput = body.toolOutput != null ? String(body.toolOutput).slice(0, 2000) : "ok";
      }

      if (userWantsSearchOrType(payload.intent) && !payload.stuckHint) {
        const query = payload.intent
          .replace(/^search( for| up)?\s*/i, "")
          .replace(/^look up\s*/i, "")
          .trim();
        payload.searchHint = query.slice(0, 120);
      }

      let res = await fetch(`${API_BASE}/api/desktop/browser-plan-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        const hint =
          res.status === 404
            ? "Restart npm run server (or dev:overlay) — API route missing."
            : "";
        return {
          error: "plan_failed",
          message: (data && data.error) || hint || `Could not plan next step (HTTP ${res.status}).`,
        };
      }

      if (Array.isArray(data.holoMessages)) holoMessages = data.holoMessages;
      if (data.screenBrief) lastScreenBrief = String(data.screenBrief);
      if (data.agentResult) lastAgentResult = String(data.agentResult);
      else if (data.done && data.explanation) lastAgentResult = String(data.explanation);

      let actions = resolvePlanActions(data.actions, payload.items);
      // Server may return raw DOM ordinal clicks with id+selector — ensure id resolves.
      if (!actions.length && Array.isArray(data.actions) && data.actions[0]?.selector) {
        actions = data.actions.slice(0, 1);
      }
      if (!(actions[0]?.type === "type" && actions[1]?.type === "press")) {
        actions = actions.slice(0, 1);
      } else {
        actions = actions.slice(0, 2);
      }

      // Planner returned prose but no executable action — retry only for non-MCQ flows.
      if (!actions.length && !data.done && !data.planFailed && data.agentMode !== "holo") {
        const stuckHint = userWantsSearchOrType(payload.intent)
          ? `User wants to search: "${payload.searchHint || payload.intent}". TYPE the query into the search field, then press Enter. Do not click unrelated navigation.`
          : "Your last response had no actions. Think like chat advice, then return exactly one click or type action from ELEMENTS.";
        const retryRes = await fetch(`${API_BASE}/api/desktop/browser-plan-next`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            ...payload,
            stuckHint,
            forceAction: true,
          }),
        });
        const retryData = await retryRes.json().catch(() => null);
        if (retryRes.ok && retryData) {
          data.done = retryData.done;
          data.explanation = retryData.explanation || data.explanation;
          data.reasoning = retryData.reasoning || data.reasoning;
          data.taskPlan = retryData.taskPlan || data.taskPlan;
          data.actions = retryData.actions;
          data.solved = retryData.solved ?? data.solved;
          data.actionKind = retryData.actionKind || data.actionKind;
          data.planFailed = retryData.planFailed ?? data.planFailed;
          actions = resolvePlanActions(retryData.actions, payload.items);
          if (!(actions[0]?.type === "type" && actions[1]?.type === "press")) {
            actions = actions.slice(0, 1);
          } else {
            actions = actions.slice(0, 2);
          }
        }
      }

      const done =
        typeof data.done === "boolean"
          ? data.done
          : !actions.length && payload.completedSteps.length > 0;

      return {
        done,
        explanation: String(data.explanation || "").trim(),
        reasoning: String(data.reasoning || "").trim(),
        taskPlan: String(data.taskPlan || payload.taskPlan || "").trim(),
        actions,
        screenBrief: String(data.screenBrief || lastScreenBrief || "").trim(),
        agentResult: String(data.agentResult || "").trim(),
        planFailed:
          data.planFailed
            ? String(data.explanation || "").trim() || "Planning failed — could not determine the next step."
            : !done && !actions.length
              ? String(data.explanation || "").trim() || "Planner returned no action"
              : "",
      };
    }

    try {
      const initialTaskPlan = String(taskPlan || "").slice(0, 2000);
      const convHistory = Array.isArray(conversationHistory) ? conversationHistory.slice(-8) : [];

      // Dynamic pages: re-scan, verify, and replan after each action.
      if (goal) {
        const out = await executeAdaptiveBrowserTask(
          runOsascript,
          (payload) =>
            callPlanNext({
              ...payload,
              conversationHistory: convHistory,
              taskPlan: payload.taskPlan || initialTaskPlan,
            }),
          browser,
          goal,
          pageUrl,
          {
            maxRounds: undefined,
            onProgress: sendProgress,
            captureScreen: captureBrowserScreenThumbnail,
            initialTaskPlan,
            conversationHistory: convHistory,
          },
        );
        const failed = out.results.find((r) => !r.ok);
        const taskOk = out.done && !failed;
        let message = failed
          ? `Stopped at “${failed.label || "step"}”: ${failed.error || "failed"}`
          : out.done
            ? out.explanation || "Done — task completed in your browser."
            : out.message || "Stopped before the task finished.";

        try {
          const token = await getAuthToken();
          if (token) {
            const reportRes = await fetch(`${API_BASE}/api/desktop/browser-report`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                intent: goal,
                ok: taskOk,
                url: pageUrl,
                title: "",
                screenBrief: lastScreenBrief,
                agentResult: lastAgentResult || out.explanation || "",
                completedSteps: out.completed || [],
                conversationHistory: convHistory,
              }),
            });
            const reportData = await reportRes.json().catch(() => null);
            if (reportRes.ok && reportData?.message) {
              message = String(reportData.message).trim();
            }
          }
        } catch (_) {
          /* keep fallback message */
        }

        return {
          ok: taskOk,
          adaptive: true,
          results: out.results,
          rounds: out.completed?.length || out.results.length,
          message,
          explanation: out.explanation || "",
        };
      }

      const steps = Array.isArray(actions)
        ? actions
            .filter((a) => a && typeof a === "object" && a.type)
            .slice(0, 8)
            .map((a) => ({
              type: String(a.type || "").toLowerCase(),
              selector: String(a.selector || ""),
              label: String(a.label || a.selector || "step"),
              value: a.value != null ? String(a.value) : undefined,
              key: a.key != null ? String(a.key) : undefined,
              delta: a.delta != null ? Number(a.delta) : undefined,
            }))
        : [];
      if (!steps.length) {
        console.log("[browser-execute] no steps — raw actions:", actions);
        return {
          ok: false,
          error: "no_actions",
          results: [],
          message: "No actions reached the browser. Close and re-open Control this page, then Run again.",
        };
      }
      const results = await executeBrowserActions(runOsascript, browser, steps, { pageUrl });
      const failed = results.find((r) => !r.ok);
      return {
        ok: !failed,
        results,
        message: failed
          ? `Stopped at “${failed.label || "step"}”: ${failed.error || "failed"}`
          : "Done.",
      };
    } catch (e) {
      console.log("[browser-execute] error:", e && e.message ? e.message : e);
      return {
        ok: false,
        error: "execute_failed",
        results: [],
        message: e && e.message ? e.message : "Failed to run browser actions.",
      };
    } finally {
      browserExecuteInFlight = false;
      if (hadOverlay && overlayWindow && !overlayWindow.isDestroyed()) {
        setOverlayClickThrough(false);
        overlayWindow.moveTop();
      }
    }
  });

  ipcMain.handle("lykn:suggest", async (_e, { question, answer, mode } = {}) => {
    const empty = { followups: [], links: [] };
    try {
      const token = await getAuthToken();
      if (!token) return empty;
      const res = await fetch(`${API_BASE}/api/ai/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          question: String(question || ""),
          answer: String(answer || ""),
          mode: String(mode || ""),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return empty;
      return {
        followups: Array.isArray(data.followups) ? data.followups : [],
        links: Array.isArray(data.links) ? data.links : [],
      };
    } catch (_) {
      return empty;
    }
  });

  // Rolling meeting notes (summary + key points + action items) from the live
  // transcript. Best-effort: returns empty notes on any failure.
  ipcMain.handle("lykn:meeting-notes", async (_e, { transcript } = {}) => {
    const empty = { summary: "", keyPoints: [], actionItems: [] };
    const t = String(transcript || "").trim();
    if (t.length < 40) return empty;
    try {
      const token = await getAuthToken();
      if (!token) return empty;
      const res = await fetch(`${API_BASE}/api/ai/meeting-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: t }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return empty;
      return {
        summary: String(data.summary || "").trim(),
        keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [],
        actionItems: Array.isArray(data.actionItems) ? data.actionItems : [],
      };
    } catch (_) {
      return empty;
    }
  });
}

function buildAppMenu() {
  // Keep the standard macOS edit/window menu so copy/paste, ⌘Q, and
  // fullscreen all work; this is otherwise lost on a frameless-ish window.
  const template = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Set Up LYKN / Permissions…", click: () => createOnboardingWindow() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/*  First-run setup — guide the user through the two permissions LYKN   */
/*  needs (Screen Recording + "Allow JavaScript from Apple Events").    */
/* ------------------------------------------------------------------ */

function onboardingMarkerPath() {
  return path.join(app.getPath("userData"), "onboarding-complete");
}

async function onboardingComplete() {
  try {
    await fs.access(onboardingMarkerPath());
    return true;
  } catch {
    return false;
  }
}

function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }
  onboardingWindow = new BrowserWindow({
    width: 560,
    height: 600,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Set up LYKN",
    backgroundColor: "#0b0b0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "onboarding-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  onboardingWindow.loadFile(path.join(__dirname, "onboarding.html"));
  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
  });
}

function registerOnboardingIpc() {
  ipcMain.handle("lykn:onboarding-screen-status", () => screenCaptureStatus());

  ipcMain.handle("lykn:onboarding-request-screen", async () => {
    // Attempting a capture is what makes macOS show the Screen Recording prompt
    // and register LYKN in the privacy list.
    try {
      await capturePrimaryScreen();
    } catch {
      /* the prompt is the point; the capture itself may fail until granted */
    }
    return screenCaptureStatus();
  });

  ipcMain.on("lykn:onboarding-open-screen-settings", () => {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  });

  ipcMain.on("lykn:onboarding-open-automation-settings", () => {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    );
  });

  ipcMain.handle("lykn:onboarding-accessibility-status", () => {
    if (process.platform !== "darwin") return "granted";
    try {
      return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch {
      return "unknown";
    }
  });

  ipcMain.handle("lykn:onboarding-request-accessibility", () => {
    if (process.platform !== "darwin") return "granted";
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
      return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    } catch {
      return "unknown";
    }
  });

  ipcMain.on("lykn:onboarding-open-accessibility-settings", () => {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  });

  ipcMain.handle("lykn:onboarding-test-apple-events", async () => {
    if (process.platform !== "darwin") return { state: "granted", browser: null };
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
    if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function registerExtensionInstallIpc() {
  ipcMain.handle("lykn:open-extension-install", () => {
    createExtensionInstallWindow();
    return { ok: true };
  });
  ipcMain.handle("lykn:extension-install-mode", () => getExtensionInstallMode());
  ipcMain.handle("lykn:install-extension-one-click", async (_e, { browser } = {}) => {
    try {
      return await installExtensionOneClick(
        {
          browser: browser || "chrome",
          userDataPath: app.getPath("userData"),
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appDir: __dirname,
          shell,
          clipboard,
          dialog,
        },
      );
    } catch (e) {
      console.warn("[extension-install]", e?.message || e);
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle("lykn:extension-bridge-status", () => {
    const connected = !!extensionBridge?.isConnected?.();
    if (connected) liveWatchState.extensionConnected = true;
    return {
      ok: true,
      connected,
      live: !!extensionBridge?.isLive?.(),
      port: extensionBridge?.port || 38471,
    };
  });
  ipcMain.on("lykn:extension-install-close", () => {
    if (extensionInstallWindow && !extensionInstallWindow.isDestroyed()) {
      extensionInstallWindow.close();
    }
  });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Silent background auto-update via GitHub Releases (electron-updater). Only
// runs in the packaged app — in dev there's no update feed. Downloads new
// versions in the background and, once ready, offers a one-click restart.
function initAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    console.log("[update] electron-updater unavailable:", e && e.message);
    return;
  }
  autoUpdater.autoDownloadAll = true;
  autoUpdater.on("error", (err) => {
    console.log("[update] error:", err && err.message ? err.message : err);
  });
  autoUpdater.on("update-available", (info) => {
    console.log("[update] available:", info && info.version);
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[update] up to date");
  });
  autoUpdater.on("update-downloaded", async (info) => {
    console.log("[update] downloaded:", info && info.version);
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `LYKN ${info && info.version ? info.version : ""} is ready to install.`,
      detail: "Restart LYKN to apply the update.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  // Check on launch, then every 6 hours while the app stays open.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

  app.whenReady().then(() => {
  // Present a clean Chrome user agent. Google (and some other providers) reject
  // OAuth sign-in from any UA advertising "Electron" with disallowed_useragent,
  // so we strip the Electron/app tokens and look like plain desktop Chrome.
  app.userAgentFallback =
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

  installPermissionHandler();
  setupSystemAudioCapture();
  buildAppMenu();
  registerOverlayIpc();
  registerOnboardingIpc();
  registerExtensionInstallIpc();
  extensionBridge = startExtensionBridge({
    onUpdate: () => {
      liveWatchState.extensionConnected = !!extensionBridge?.isConnected?.();
      writeOverlaySettings({ chromeLiveFeedLinked: true });
      notifyLiveWatchUpdate();
      if (extensionInstallWindow && !extensionInstallWindow.isDestroyed()) {
        setTimeout(() => {
          if (extensionInstallWindow && !extensionInstallWindow.isDestroyed()) {
            extensionInstallWindow.close();
          }
        }, 2500);
      }
    },
  });
  createMainWindow();
  createOverlayWindow();
  // Pre-create + warm the full-screen glass/burst window now so the FIRST ⌘+L
  // doesn't hitch while it loads + rasterizes its blurred layers and noise.
  createBurstWindow();
  registerGlobalHotkey();
  initAutoUpdate();
  if (isLiveWatchEnabled()) startLiveWatch();

  // Show the permissions walkthrough once, on first launch.
  onboardingComplete().then((done) => {
    if (!done) createOnboardingWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("will-quit", () => {
  stopLiveWatch();
  extensionBridge?.stop?.();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  // Standard macOS behaviour: stay alive until ⌘Q so the dock icon + hotkey
  // keep working after the last window closes.
  if (process.platform !== "darwin") app.quit();
});
