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

// Once the user drags the bar we stop auto-centering it. We anchor by its
// BOTTOM edge so it grows upward in place as answers stream in.
let overlayUserPositioned = false;
let overlayAnchorX = null;
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

/* ------------------------------------------------------------------ */
/*  Jarvis overlay — ⌘+L summons a transparent always-on-top window     */
/*  that reads the screen behind it.                                    */
/* ------------------------------------------------------------------ */

const OVERLAY_WIDTH = 720;
const OVERLAY_MIN_HEIGHT = 64;
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
    overlayAnchorX = b.x;
    overlayAnchorBottomY = b.y + b.height;
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

// Grow/shrink the bar as the answer streams in. By default it stays pinned
// bottom-center; once the user has dragged it, we keep their X and anchor the
// bottom edge so it grows upward in place.
function setOverlayHeight(height) {
  if (!overlayWindow) return;
  const h = Math.max(OVERLAY_MIN_HEIGHT, Math.min(Math.round(height), 640));
  const { workArea } = screen.getPrimaryDisplay();

  let x;
  let y;
  if (overlayUserPositioned && overlayAnchorX != null && overlayAnchorBottomY != null) {
    x = overlayAnchorX;
    y = overlayAnchorBottomY - h;
  } else {
    const pos = overlayPosition(h);
    x = pos.x;
    y = pos.y;
  }
  // Keep it on-screen.
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));

  overlayProgrammaticMove = true;
  overlayWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: OVERLAY_WIDTH, height: h });
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
function toggleOverlay() {
  if (!overlayWindow) createOverlayWindow();
  if (overlayWindow.isVisible()) {
    hideOverlay();
    return;
  }
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send("lykn:overlay-shown");
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

// Capture the screen, send it + the user's question to LYKN's streaming chat
// endpoint, and forward text deltas to the overlay. Runs in the main process so
// there's no CORS and the screenshot never touches the renderer.
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

  let prompt = dataURL
    ? "The attached image is a screenshot of the user's current screen. Use it to answer " +
      "their question about what is on screen. Be concise and specific."
    : "Use the attached image(s) and any files below to answer the user's question. " +
      "Be concise and specific.";
  if (textAtts.length) {
    prompt +=
      "\n\nAttached files:\n" +
      textAtts
        .map((a) => `--- ${a.name || "file"} ---\n${String(a.text).slice(0, 8000)}`)
        .join("\n\n");
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
      "ask questions, or add commentary — just the description.",
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
  ipcMain.on("lykn:resize", (_e, height) => setOverlayHeight(height));
  ipcMain.on("lykn:move-by", (_e, { dx, dy }) => {
    if (!overlayWindow) return;
    const b = overlayWindow.getBounds();
    const nx = b.x + Math.round(dx || 0);
    const ny = b.y + Math.round(dy || 0);
    overlayProgrammaticMove = true;
    overlayWindow.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
    overlayProgrammaticMove = false;
    // Remember the new spot (anchored by bottom edge) so streaming answers
    // grow in place instead of snapping back to center.
    overlayUserPositioned = true;
    overlayAnchorX = nx;
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
      return { text: String(data?.text || "").trim() };
    } catch (e) {
      return { error: `Transcription failed: ${e && e.message ? e.message : e}` };
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // Present a clean Chrome user agent. Google (and some other providers) reject
  // OAuth sign-in from any UA advertising "Electron" with disallowed_useragent,
  // so we strip the Electron/app tokens and look like plain desktop Chrome.
  app.userAgentFallback =
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

  installPermissionHandler();
  buildAppMenu();
  registerOverlayIpc();
  createMainWindow();
  createOverlayWindow();
  registerGlobalHotkey();

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
