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
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const {
  collectBrowserInteractables,
  executeBrowserActions,
  sanitizePlanActions,
} = require("./browserAct.cjs");

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
/** @type {BrowserWindow | null} */
let onboardingWindow = null;

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
const OVERLAY_SIDE_WIDTH = 300; // side panels (sources right, more menu left)
const OVERLAY_MAX_WIDTH = OVERLAY_WIDTH + OVERLAY_SIDE_WIDTH;
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
    // or out of the full-screen app they're in.
    ...(process.platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  // Exclude the overlay itself from screen capture (NSWindowSharingNone on
  // macOS). The user still sees the glass bar, but our own screenshots — and
  // any other screen recording — won't include it, so LYKN never "sees" its own
  // chat window when reading the screen.
  overlayWindow.setContentProtection(true);
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
async function capturePrimaryScreen() {
  const display = screen.getPrimaryDisplay();
  const { width: w, height: h } = display.size;
  const aspect = h / w;
  const widths = [Math.min(w, 2048), 1600, 1280, 960];
  const sizes = widths.map((width) => ({ width, height: Math.round(width * aspect) }));

  let lastErr = null;
  for (const thumbnailSize of sizes) {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
      const primary =
        sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      if (primary && !primary.thumbnail.isEmpty()) return primary.thumbnail.toDataURL();
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) console.error("[LYKN] screen capture failed:", lastErr.message);
  return null;
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
  overlayWindow.show();
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

const OVERLAY_IGNORE_NOTE =
  "IMPORTANT: Ignore LYKN's own interface in the image — a translucent floating " +
  "glass bar/panel (it may contain this same question, an input field, mic/send " +
  "buttons, a chevron, or a live transcript). It is NOT part of the user's screen. " +
  "Never describe, mention, quote, or refer to it; answer only about the actual " +
  "app/website content behind it.";

async function streamScreenAnswer(event, { text, history, attachments }) {
  const wc = event.sender;
  const send = (channel, payload) => {
    if (!wc.isDestroyed()) wc.send(channel, payload);
  };

  // Split dropped attachments into images (sent as image inputs) and text files
  // (inlined into the prompt).
  const atts = Array.isArray(attachments) ? attachments : [];
  const imageAtts = atts.filter((a) => a && a.kind === "image" && a.dataUrl);
  const textAtts = atts.filter((a) => a && a.kind === "text" && a.text);

  // Capture the screen unless the user dropped their own image(s) to ask about —
  // then we don't force a screenshot (and don't block on the permission).
  let dataURL = null;
  if (screenCaptureStatus() === "granted") {
    try {
      dataURL = await capturePrimaryScreen();
    } catch {
      /* fall through */
    }
  } else if (imageAtts.length === 0) {
    send("lykn:answer-error", {
      message:
        "LYKN needs Screen Recording permission. Enable it in System Settings → Privacy & Security → Screen Recording, then reopen LYKN.",
    });
    return;
  }

  if (!dataURL && imageAtts.length === 0) {
    send("lykn:answer-error", { message: "Couldn't capture the screen." });
    return;
  }

  // If the user is looking at a web page, pull the live URL from the frontmost
  // browser and scrape the full article text so the model reads the real content
  // (not just OCR of the visible viewport). Best-effort — falls back silently.
  let pageContext = null;
  if (imageAtts.length === 0) {
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
          const yt = await fetchYouTubeTranscript(ytId, target.appName);
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
  }

  let prompt = dataURL
    ? "You are LYKN, a helpful assistant. The attached image is a screenshot of the " +
      "user's current screen, provided as CONTEXT in case it's relevant. Decide based " +
      "on the user's message: if they're asking about what's on their screen (this " +
      "page, app, error, etc.), use the screenshot to answer specifically. If it's a " +
      "general question or normal conversation that isn't about the screen, just answer " +
      "it normally like a regular assistant — do NOT force the screen into your reply or " +
      "describe what's on it. Be concise and specific. " +
      OVERLAY_IGNORE_NOTE
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
  prompt += `\n\nUser: ${String(text || "").slice(0, 4000)}`;

  const imageUrls = [
    ...(dataURL ? [dataURL] : []),
    ...imageAtts.map((a) => a.dataUrl),
  ];

  const body = {
    model: "lykn",
    intent: "ask",
    text: String(text || "").slice(0, 4000),
    prompt,
    imageUrls,
    useTools: true,
    ...(Array.isArray(history) && history.length ? { conversation: history.slice(-8) } : {}),
  };

  const token = await getAuthToken();
  if (!token) {
    send("lykn:answer-error", {
      message: "Sign in to LYKN first — open the main LYKN window and log in, then try again.",
    });
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/ai/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const ctype = res.headers.get("content-type") || "";
    if (!res.ok || !res.body) {
      send("lykn:answer-error", { message: `LYKN backend error (${res.status}).` });
      return;
    }

    // Non-streaming JSON fallback (some tiers/paths return a plain answer).
    if (!ctype.includes("text/event-stream")) {
      const data = await res.json().catch(() => null);
      const answer = stripHiddenTags(data?.response || data?.answer || data?.text || "");
      if (answer.trim()) send("lykn:answer-delta", { text: answer });
      send("lykn:answer-done", {});
      return;
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
            // Server-provided thinking/tool status, e.g. "Searching the web…".
            send("lykn:answer-status", { status: j.status.trim() });
          } else if (j.tool_call && typeof j.tool_call === "object") {
            // Fallback label when a tool starts but no status string came with it.
            const tc = j.tool_call;
            if (tc.status === "running") {
              const label = TOOL_STATUS_LABELS[tc.name] || "Working on it…";
              send("lykn:answer-status", { status: label });
            }
          } else if (j.error) {
            send("lykn:answer-error", { message: String(j.error) || "Stream error." });
          }
        } catch {
          /* ignore non-JSON keepalive lines */
        }
      }
    }
    send("lykn:answer-done", { text: stripHiddenTags(accumulated) });
  } catch (e) {
    send("lykn:answer-error", { message: `Request failed: ${e && e.message ? e.message : e}` });
  }
}

// Capture the current screen and ask the vision model for a short text
// description. Voice Mode can't receive images, so we feed this summary into the
// live agent as contextual text — giving voice the same "sees your screen"
// ability the typed overlay chat has.
async function captureScreenDescription() {
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

function registerOverlayIpc() {
  ipcMain.on("lykn:hide-overlay", () => hideOverlay());
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
    return {
      overlay,
      app: appResult.chats || [],
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
    const session = {
      id: sessionId,
      title,
      updatedAt: now,
      messages,
    };
    if (existingIdx >= 0) store.sessions[existingIdx] = session;
    else store.sessions.unshift(session);

    store.sessions.sort(
      (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
    );
    store.sessions = store.sessions.slice(0, 80);
    store.currentSessionId = sessionId;
    await writeOverlaySessionsStore(store);
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

  ipcMain.handle("lykn:browser-plan", async (_e, { intent } = {}) => {
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
    try {
      const res = await fetch(`${API_BASE}/api/desktop/browser-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          intent: goal,
          url: collected.page.url || target.url,
          title: collected.page.title || "",
          items: (collected.page.items || []).slice(0, 60),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        return fail("plan_failed", { message: (data && data.error) || "Could not plan actions." });
      }
      const selectors = new Set(
        (collected.page.items || []).map((i) => String(i.selector || "").trim()).filter(Boolean),
      );
      const actions = sanitizePlanActions(data.actions, selectors);
      if (!actions.length) {
        return fail("no_actions", {
          message: "No safe actions could be planned for this page.",
          explanation: String(data.explanation || "").trim(),
        });
      }
      return {
        ok: true,
        browser: target.appName,
        url: collected.page.url || target.url,
        title: collected.page.title || "",
        explanation: String(data.explanation || "").trim(),
        actions,
      };
    } catch (e) {
      return fail("plan_failed", { message: e && e.message ? e.message : "Could not plan actions." });
    }
  });

  ipcMain.handle("lykn:browser-execute", async (_e, { actions, appName } = {}) => {
    if (process.platform !== "darwin") return { ok: false, error: "unsupported" };
    const browser = String(appName || "").trim();
    if (!browser) return { ok: false, error: "no_browser" };
    const steps = sanitizePlanActions(actions, null);
    if (!steps.length) return { ok: false, error: "no_actions" };
    try {
      const results = await executeBrowserActions(runOsascript, browser, steps);
      const failed = results.find((r) => !r.ok);
      return {
        ok: !failed,
        results,
        message: failed
          ? `Stopped at “${failed.label || "step"}”: ${failed.error || "failed"}`
          : "Done.",
      };
    } catch (e) {
      return { ok: false, error: "execute_failed", message: e && e.message ? e.message : "Failed." };
    }
  });

  ipcMain.handle("lykn:suggest", async (_e, { question, answer } = {}) => {
    const empty = { followups: [], links: [] };
    try {
      const token = await getAuthToken();
      if (!token) return empty;
      const res = await fetch(`${API_BASE}/api/ai/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ question: String(question || ""), answer: String(answer || "") }),
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
  createMainWindow();
  createOverlayWindow();
  registerGlobalHotkey();
  initAutoUpdate();

  // Show the permissions walkthrough once, on first launch.
  onboardingComplete().then((done) => {
    if (!done) createOnboardingWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  // Standard macOS behaviour: stay alive until ⌘Q so the dock icon + hotkey
  // keep working after the last window closes.
  if (process.platform !== "darwin") app.quit();
});
