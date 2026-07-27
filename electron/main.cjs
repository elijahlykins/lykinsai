// LYKN desktop shell (macOS + Windows) — thin native wrapper around the live
// web app at APP_URL, plus the always-on-top glass overlay (⌘/Ctrl+L), tray
// icon, and screen-context bridge.
//
// Platform notes:
//   • macOS: native vibrancy panels, Accessibility/AppleScript browser act,
//     notarized DMG.
//   • Windows: transparent glass fallbacks, tray-resident like mac, NSIS
//     installer. Browser-act / frontmost-doc parity lands in a later pass.

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
  Tray,
  powerMonitor,
  nativeTheme,
  protocol,
} = require("electron");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
// Taskbar grouping + toast attribution on Windows (must match appId).
if (IS_WIN) {
  try {
    app.setAppUserModelId("ai.lykn.desktop");
  } catch (_) {
    /* best-effort */
  }
}

// Vault HTML artifacts in Glass: served from an in-memory cache via
// lykn-artifact:// so the overlay iframe never depends on localhost file-proxy
// (SSRF-blocked + private-network iframe failures → "fetch failed").
protocol.registerSchemesAsPrivileged([
  {
    scheme: "lykn-artifact",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

// Force dark appearance for the whole shell. The glass overlay family (bar,
// menu, picker, side panel, live notes) uses native "hud" vibrancy, and that
// material follows the OS appearance: on Light-Mode Macs it rendered as pale
// glass under our dark-tuned text/tint CSS, making the placeholder nearly
// unreadable. Pinning dark keeps the glass identical on every machine. The
// web app in the main window is unaffected unless the user picked "System"
// theme — in which case they get LYKN's dark-first default, which matches.
nativeTheme.themeSource = "dark";
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const net = require("node:net");
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

// ---------------------------------------------------------------------------
// SSRF guard for main-process fetches of renderer/AI-supplied URLs.
// download-file / artifact-code fetch arbitrary URLs that originate from AI
// markdown, so we must block requests that would reach loopback, private,
// link-local, or cloud-metadata addresses. The check runs on the RESOLVED IP
// (not the hostname string) and is re-run on every redirect hop.
// ---------------------------------------------------------------------------
function isPrivateIpMain(ip) {
  if (!ip) return true;
  const v = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv6(v)) {
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("ff")) return true;
    const mapped = v.match(/(?:::ffff:)((?:\d{1,3}\.){3}\d{1,3})$/);
    if (mapped) return isPrivateIpMain(mapped[1]);
    return false;
  }
  if (!net.isIPv4(v)) return true; // unparseable → unsafe
  const [a, b] = v.split(".").map((n) => parseInt(n, 10));
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

async function assertPublicHttpUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(String(urlStr || ""));
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "bad_scheme" };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIpMain(host)) return { ok: false, error: "private_ip" };
    return { ok: true, url: parsed.toString() };
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, error: "dns_failed" };
  }
  if (!addrs || !addrs.length) return { ok: false, error: "dns_empty" };
  for (const { address } of addrs) {
    if (isPrivateIpMain(address)) return { ok: false, error: "private_ip" };
  }
  return { ok: true, url: parsed.toString() };
}

// SSRF-safe fetch: validate the URL, follow redirects manually, re-validate
// every hop so an allowed public URL can't 30x into an internal address.
async function safeFetchMain(url, init = {}, { maxRedirects = 5 } = {}) {
  let current = String(url || "");
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safe = await assertPublicHttpUrl(current);
    if (!safe.ok) {
      const err = new Error(`ssrf_blocked:${safe.error}`);
      err.code = "SSRF_BLOCKED";
      throw err;
    }
    const res = await fetch(safe.url, { ...init, redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, safe.url).toString();
      continue;
    }
    return res;
  }
  const err = new Error("ssrf_blocked:too_many_redirects");
  err.code = "SSRF_BLOCKED";
  throw err;
}

// Open a URL in the user's real browser, but only for web/mail schemes. This
// stops an injected/open-redirect link on the app origin from handing the OS a
// file:/smb:/custom-scheme URL via shell.openExternal (which the OS would then
// route to a native handler). Hardcoded `x-apple.systempreferences:` deep links
// call shell.openExternal directly since they are trusted constants.
const OPEN_EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
function openExternalSafe(url) {
  try {
    const proto = new URL(String(url || "")).protocol;
    if (OPEN_EXTERNAL_SCHEMES.has(proto)) {
      shell.openExternal(url);
      return true;
    }
  } catch {
    /* unparseable → never open */
  }
  return false;
}

// Friendly fallback labels for tool-call events that arrive without a server
// status string. Mirrors the web app's voice-mode TOOL_STATUS_COPY so the
// overlay's thinking indicator reads the same as the rest of LYKN.
const TOOL_STATUS_LABELS = {
  search_vault: "Checking what’s in your stuff…",
  read_document: "Reading the document…",
  display_document: "Pulling that up…",
  web_search: "Searching the web…",
  web_fetch: "Reading the page…",
  find_connections: "Finding connections…",
  get_beliefs: "Remembering who you are…",
  get_rules: "Checking your rules…",
  get_facts: "Recalling your preferences…",
  propose_fact: "Making a note of that…",
  list_projects: "Connecting this to your projects…",
  get_project_state: "Checking what you’re on…",
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
  generate_image: "Creating your image…",
  build_react_artifact: "Building…",
  build_template: "Building…",
  build_spreadsheet: "Building…",
  render_video: "Rendering your video…",
};

// The agent loop emits chat-tool names like "lykn_web_search" /
// "lykn_searchVault", while the label table above uses voice-mode
// snake_case keys ("web_search", "search_vault"). Normalize before lookup
// so tool activity reads as a friendly status instead of "Working on it…".
function toolStatusLabel(name) {
  const key = String(name || "")
    .replace(/^lykn_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return TOOL_STATUS_LABELS[key] || "Working on it…";
}

// Overlay chat/voice run in a separate BrowserWindow from the main app.
// When those paths create/update projects, the main /projects page never
// hears the in-renderer CustomEvent — bridge it over IPC instead.
const OVERLAY_PROJECT_WRITE_TOOLS = new Set([
  "lykn_createProject",
  "lykn_setActiveProject",
  "lykn_pushProjectState",
  "lykn_updateProject",
  "lykn_deleteProject",
  "lykn_mergeProjects",
  "lykn_addProjectNeurons",
  "lykn_removeProjectNeurons",
  "lykn_uploadToProject",
  "create_project",
  "set_active_project",
  "add_to_project",
  "update_project_state",
]);

function notifyMainProjectsChanged(detail = {}) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("lykn:projects-changed", detail);
    }
  } catch {
    /* main window may be closed */
  }
}

function maybeNotifyProjectsChangedFromTool(name, status, result) {
  if (status !== "done") return;
  if (!OVERLAY_PROJECT_WRITE_TOOLS.has(String(name || ""))) return;
  if (result && typeof result === "object" && result.ok === false) return;
  const project =
    result && typeof result === "object"
      ? result.project || result.target || null
      : null;
  const projectId =
    project && typeof project.id === "string" && project.id ? project.id : null;
  notifyMainProjectsChanged({ projectId });
}

// Shared with server.js via lib/webSearchIntent.cjs — explicit "search the
// web" OR live-freshness asks (latest models / news / prices / …). Arms
// forceWebSearch so Serper is pre-fetched instead of relying on nano's
// June 2024 cutoff + optional tool call.
const {
  shouldForceWebSearch: overlayShouldForceWebSearch,
} = require("../lib/webSearchIntent.cjs");

// Mirrors server REDESIGN_INTENT_RE — when false and we have a cached Build
// artifact, Glass sends activeArtifact and does NOT force a ground-up rebuild.
const OVERLAY_REDESIGN_INTENT_RE =
  /\b(?:redesign|restyle|rebrand|rebuild|overhaul|from scratch|start over|new look|new theme|new palette|rewrite (?:the )?(?:whole|entire|all))\b/i;

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
];

// Pin Supabase auth hosts to THIS project when VITE_SUPABASE_URL is known —
// a blanket *.supabase.co allowlist let any tenant's project stay inside the
// app chrome. Fall back to the suffix only when the env isn't baked in.
const SUPABASE_AUTH_HOST = (() => {
  try {
    const raw = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
    if (!raw) return null;
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
})();

// GitHub needs path-level treatment: its OAuth surface must open in-app for
// the sign-in redirect to work, but the rest of github.com must NOT — the Mac
// release downloads live on github.com, and allowlisting the whole host let a
// "Download for Mac" click hijack the app window into GitHub instead of
// triggering a clean external download.
const GITHUB_AUTH_PATH_RE = /^\/(login|sessions?)(\/|$)/;

function isAuthNavigation(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (AUTH_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s))) {
      return true;
    }
    if (SUPABASE_AUTH_HOST) {
      if (host === SUPABASE_AUTH_HOST) return true;
    } else if (host.endsWith(".supabase.co") || host.endsWith(".supabase.in")) {
      // Dev fallback when project URL isn't in the Electron env — still
      // prefer pinning via VITE_SUPABASE_URL in production builds.
      return true;
    }
    if (host === "github.com" || host === "www.github.com") {
      return GITHUB_AUTH_PATH_RE.test(parsed.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

// ── Deep-link sign-in (lykn://auth) ─────────────────────────────────────────
// Google refuses OAuth inside embedded browsers ("This browser or app may not
// be secure"), so Google sign-in runs in the user's REAL browser instead:
// the web app's /desktop-auth page completes the Supabase OAuth round-trip
// there, then hands the session back via lykn://auth#access_token=…&
// refresh_token=…. We forward those tokens to the renderer, where the web
// app calls supabase.auth.setSession(). Tokens ride in the URL fragment and
// are never logged or persisted by the main process.
//
// Bound to a one-time `state` minted when the app opens /desktop-auth — without
// it, any local process could `open lykn://auth#…` and inject a session.
/** @type {{access_token: string, refresh_token: string} | null} */
let pendingAuthTokens = null;
/** @type {{ state: string, expiresAt: number } | null} */
let pendingDesktopAuthState = null;
const DESKTOP_AUTH_STATE_TTL_MS = 15 * 60 * 1000;

function desktopAuthStatePath() {
  return path.join(app.getPath("userData"), "pending-desktop-auth-state.json");
}

function persistDesktopAuthState(record) {
  pendingDesktopAuthState = record;
  try {
    fsSync.writeFileSync(desktopAuthStatePath(), JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    /* best-effort */
  }
}

function loadDesktopAuthState() {
  if (pendingDesktopAuthState && pendingDesktopAuthState.expiresAt > Date.now()) {
    return pendingDesktopAuthState;
  }
  try {
    const raw = fsSync.readFileSync(desktopAuthStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.state && parsed.expiresAt > Date.now()) {
      pendingDesktopAuthState = parsed;
      return parsed;
    }
  } catch {
    /* none */
  }
  pendingDesktopAuthState = null;
  return null;
}

function clearDesktopAuthState() {
  pendingDesktopAuthState = null;
  try {
    fsSync.unlinkSync(desktopAuthStatePath());
  } catch {
    /* ignore */
  }
}

function mintDesktopAuthUrl(baseUrl) {
  const state = crypto.randomBytes(24).toString("base64url");
  persistDesktopAuthState({ state, expiresAt: Date.now() + DESKTOP_AUTH_STATE_TTL_MS });
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("desktop_state", state);
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function flushPendingAuthTokens() {
  if (!pendingAuthTokens) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isLoading()) return; // did-finish-load will re-flush
  wc.send("lykn:auth-tokens", pendingAuthTokens);
  pendingAuthTokens = null;
}

function handleAuthDeepLink(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return;
  }
  if (parsed.protocol !== "lykn:") return;
  // Accept lykn://auth… — hostname parsing of custom schemes varies, so
  // check both the host and the path form.
  const target = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  if (target !== "auth") return;
  const frag = new URLSearchParams(String(parsed.hash || "").replace(/^#/, ""));
  const access_token = frag.get("access_token") || "";
  const refresh_token = frag.get("refresh_token") || "";
  const state = frag.get("state") || "";
  if (!access_token || !refresh_token) return;

  const expected = loadDesktopAuthState();
  if (!expected?.state || !state || expected.state !== state) {
    console.warn("[auth] lykn://auth rejected — missing or mismatched desktop_state");
    return;
  }
  clearDesktopAuthState();

  pendingAuthTokens = { access_token, refresh_token };
  // Cold start via the deep link: open-url can fire before whenReady, and
  // BrowserWindow can't be created yet. whenReady's createMainWindow (deep-link
  // launches are not login launches) will flush the tokens on did-finish-load.
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(); // flushes on did-finish-load
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    flushPendingAuthTokens();
  }
  try {
    app.focus({ steal: true });
  } catch (_) {
    /* focus is best-effort */
  }
}

// macOS delivers custom-scheme URLs here (both cold start and while running).
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleAuthDeepLink(url);
});

// Windows (and Linux) deliver lykn:// URLs via process argv — cold start and
// second-instance. Scan an argv-like list for the first lykn: URL.
function findLyknUrlInArgv(argv) {
  for (const arg of argv || []) {
    if (typeof arg === "string" && arg.startsWith("lykn:")) return arg;
  }
  return null;
}
{
  const cold = findLyknUrlInArgv(process.argv);
  if (cold) handleAuthDeepLink(cold);
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
/** @type {import('electron').Tray | null} — module-scoped so it isn't GC'd. */
let tray = null;

// ── Background-app lifecycle ────────────────────────────────────────────────
// LYKN lives in the menu bar for as long as the user is logged in: ⌘Q (and
// the red close button) only dismiss the WINDOWS — the tray icon and the ⌘+L
// hotkey stay armed. The only ways to actually exit are the tray menu's
// "Quit LYKN Completely", the matching app-menu item, an app update install,
// or a system shutdown/restart (powerMonitor flips the flag so we never block
// those).
let allowQuit = false;

function quitForReal() {
  allowQuit = true;
  // Real quit: tear down the auth keeper and let the main window's close
  // handler actually destroy (allowQuit short-circuits the hide-on-close).
  destroyAuthKeeper();
  app.quit();
}

// Menu-bar-app dock behaviour: the Dock icon appears only while the main
// window is VISIBLE; with just the tray + hotkey running (main window hidden
// but still alive as the auth keeper) we stay out of the Dock and the
// ⌘-Tab switcher like any other background companion.
function updateDockVisibility() {
  if (!IS_MAC || !app.dock) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) app.dock.show();
    else app.dock.hide();
  } catch (_) {
    /* cosmetic */
  }
}
/** @type {BrowserWindow | null} */
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
  // Coming back from background (menu-bar-only) mode: restore the Dock icon
  // before the window appears so it can take focus like a normal app window.
  if (IS_MAC && app.dock) {
    try { app.dock.show(); } catch (_) { /* cosmetic */ }
  }
  // Main window takes over as the auth provider — tear down the keeper so
  // two Supabase clients don't race the rotating refresh token.
  destroyAuthKeeper();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#000000",
    // macOS: hiddenInset traffic lights. Windows: standard frame so the web
    // app doesn't need a custom drag region yet (titleBarOverlay can land later).
    titleBarStyle: IS_MAC ? "hiddenInset" : "default",
    autoHideMenuBar: IS_WIN,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // We load a trusted first-party origin (lykn.io). Keep the renderer
      // sandboxed; any native capability is exposed explicitly via preload.
      sandbox: true,
      // The window doubles as the overlay's auth provider: the web app's
      // Supabase client must keep its token-refresh timer firing even when the
      // window sits hidden/occluded for hours, or the overlay reads an expired
      // access token from localStorage and every ask 401s.
      backgroundThrottling: false,
    },
  });

  // Avoid a white flash before the remote app paints.
  mainWindow.once("ready-to-show", () => mainWindow && mainWindow.show());

  mainWindow.loadURL(APP_URL);

  // If a lykn://auth deep link arrived before this window existed (cold start
  // from the browser hand-off), deliver the tokens once the app has loaded.
  mainWindow.webContents.on("did-finish-load", flushPendingAuthTokens);

  // New windows / target=_blank links: keep OAuth + same-origin flows inside
  // the app, but send genuinely external links (docs, third-party sites) out
  // to the user's real browser. Crucially we do NOT intercept top-level
  // navigations (see note below) so the full-page OAuth redirect to Google and
  // back to lykn.io completes in-window and Supabase can store the session.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const origin = new URL(url).origin;
      if (origin === APP_ORIGIN || isAuthNavigation(url)) {
        return { action: "allow" };
      }
      openExternalSafe(url);
      return { action: "deny" };
    } catch {
      // Fail closed: a URL we can't even parse is never something we want to
      // open in a new app window.
      return { action: "deny" };
    }
  });

  // Top-level navigation guard. We allow our own origin and the OAuth provider
  // origins (Supabase does a full-page redirect through Google/GitHub/Supabase
  // and back to lykn.io — bouncing that to the system browser strands sign-in),
  // and cancel navigation anywhere else, routing genuinely external links to
  // the user's real browser. Without this, an open redirect or injected link
  // on lykn.io could drive the app frame to an arbitrary origin (phishing with
  // the app's chrome). Sandbox + contextIsolation keep this out of Node, so
  // this closes the remaining session/phishing surface.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      event.preventDefault();
      return;
    }
    if (origin === APP_ORIGIN || isAuthNavigation(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  });

  // Red close / ⌘W: HIDE, don't destroy. Destroying kills the Supabase client
  // that owns the rotating refresh token, so the next ⌘L ask reads a stale
  // access token from disk (or an empty in-memory cache) and Glass says
  // "session expired" even though the user never signed out. Keeping the
  // window alive (hidden, backgroundThrottling:false) is what "stay logged
  // in" means for a menu-bar app.
  mainWindow.on("close", (e) => {
    if (allowQuit) return;
    e.preventDefault();
    try { mainWindow.hide(); } catch (_) { /* ignore */ }
    updateDockVisibility();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // Last window gone → back to menu-bar-only mode (tray + ⌘L stay armed).
    // Spin up the lightweight auth keeper so Glass can still refresh tokens
    // after a real destroy (crash recovery, allowQuit teardown mid-flight).
    updateDockVisibility();
    if (!allowQuit) ensureAuthKeeper();
  });

  // Recover from a crashed renderer (GPU reset, OOM) with a reload instead of
  // leaving a frozen white window — this window is also the overlay's auth
  // source, so a dead renderer would break Glass asks too.
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.warn("[main-window] renderer gone:", details?.reason || "unknown");
    if (details?.reason === "clean-exit") return;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    } catch (_) {}
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
// this handler hands back a screen video source plus loopback audio:
//   • Windows — Chromium loopback (supported natively)
//   • macOS 13+ — ScreenCaptureKit path in Electron (no virtual device)
// The overlay only uses the audio track (to transcribe meetings/conversations).
function setupSystemAudioCapture() {
  const ses = require("electron").session.defaultSession;
  if (typeof ses.setDisplayMediaRequestHandler !== "function") return;
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        // Only Glass (file:// overlay) may take silent full-screen + loopback.
        // Deny http(s) origins so XSS on lykn.io can't capture without a picker.
        const origin = String(request?.securityOrigin || "");
        if (/^https?:/i.test(origin) || origin === APP_ORIGIN) {
          console.warn("[display-media] denied for web origin:", origin);
          return callback({});
        }
        if (!overlayWindow || overlayWindow.isDestroyed()) {
          return callback({});
        }
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

// Matches CSS border-radius on overlay #wrap / floating #card.
const GLASS_CORNER_RADIUS = 16;

// Shared chrome for the glass overlay family (bar, menu, picker, panel, live).
// macOS: native vibrancy clipped to a rounded rect.
// Windows: fully transparent HWND — Win11 DWM otherwise draws square corner
// stubs / shadow outside our CSS border-radius. CSS owns the glass card;
// setShape hard-clips the HWND so those stubs can't paint.
function floatingGlassChrome() {
  if (IS_MAC) {
    return {
      transparent: false,
      backgroundColor: "#00000000",
      vibrancy: "hud",
      visualEffectState: "active",
      roundedCorners: true,
      hasShadow: true,
    };
  }
  return {
    transparent: true,
    backgroundColor: "#00000000",
    // Win11 DWM draws its own rounded frame/shadow outside CSS radius —
    // that shows as square "corner stubs". Kill native chrome; CSS owns shape.
    roundedCorners: false,
    hasShadow: false,
    thickFrame: false,
    backgroundMaterial: "none",
  };
}

/** Approximate a rounded rect as 1px scanlines for win.setShape (Win/Linux). */
function roundedRectShape(width, height, radius) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(w / 2), Math.floor(h / 2)));
  if (r <= 0) return [{ x: 0, y: 0, width: w, height: h }];
  const rects = [];
  for (let y = 0; y < h; y++) {
    let inset = 0;
    if (y < r) {
      const dy = r - y;
      inset = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    } else if (y >= h - r) {
      const dy = y - (h - r - 1);
      inset = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    }
    const rw = w - inset * 2;
    if (rw > 0) rects.push({ x: inset, y, width: rw, height: 1 });
  }
  return rects;
}

/** Clip floating glass HWND to CSS radius so Win11 can't paint square corner stubs. */
function applyFloatingGlassShape(win, radius = GLASS_CORNER_RADIUS) {
  if (!IS_WIN || !win || win.isDestroyed()) return;
  if (typeof win.setShape !== "function") return;
  try {
    const b = win.getBounds();
    const r = Math.min(radius, Math.floor(Math.min(b.width, b.height) / 2));
    win.setShape(roundedRectShape(b.width, b.height, r));
  } catch (_) { /* ignore */ }
}

/** Re-assert transparent glass chrome after create (some Win11 builds re-enable DWM). */
function hardenFloatingGlass(win) {
  if (!IS_WIN || !win || win.isDestroyed()) return;
  try {
    if (typeof win.setHasShadow === "function") win.setHasShadow(false);
  } catch (_) { /* ignore */ }
  try {
    if (typeof win.setBackgroundMaterial === "function") win.setBackgroundMaterial("none");
  } catch (_) { /* ignore */ }
  applyFloatingGlassShape(win);
  // DWM sometimes re-applies chrome on show — re-clip without stacking listeners.
  if (!win.__lyknGlassHardened) {
    win.__lyknGlassHardened = true;
    win.on("show", () => hardenFloatingGlass(win));
  }
}

/** setBounds without animation — animated resizes flicker on Win transparent HWNDs. */
function setFloatingBounds(win, bounds) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setBounds(bounds, false);
  } catch (_) {
    try { win.setBounds(bounds); } catch (_) { /* ignore */ }
  }
  applyFloatingGlassShape(win);
}

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
    ...floatingGlassChrome(),
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
    ...(IS_MAC && !OVERLAY_ACTIVATABLE_FOR_DROPS
      ? { type: "panel" }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Exclude the overlay itself from screen capture (NSWindowSharingNone on
  // macOS / WDA_EXCLUDEFROMCAPTURE on Windows). The user still sees the glass
  // bar, but our own screenshots — and any other screen recording/share — won't
  // include it, so LYKN never "sees" its own chat window when reading the screen.
  // User-toggleable + persisted; defaults ON.
  overlayWindow.setContentProtection(isContentProtectionEnabled());
  hardenFloatingGlass(overlayWindow);
  // canJoinAllSpaces + fullScreenAuxiliary so the panel appears on the CURRENT
  // Space (over full-screen apps too); skipTransformProcessType stops macOS
  // from switching Spaces when it shows.
  //
  // ORDER MATTERS (electron#10078 / #26350): setVisibleOnAllWorkspaces can
  // reset the NSWindow level back to normal on macOS, so the always-on-top
  // level must be applied AFTER it — and setFullScreenable(false) in between
  // pins NSWindowCollectionBehaviorFullScreenAuxiliary. With the level set
  // first, whether the bar showed above a full-screen app was a coin flip.
  // On Windows these are mostly no-ops / best-effort; always-on-top still applies.
  overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  overlayWindow.setFullScreenable(false);
  // screen-saver level is the most reliable always-on-top tier on both platforms.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));

  // When the user drags the bar (native drag region), remember where they put
  // it so we stop re-centering it. Ignore our own programmatic moves.
  overlayWindow.on("moved", () => {
    if (overlayProgrammaticMove || !overlayWindow) return;
    const b = overlayWindow.getBounds();
    overlayUserPositioned = true;
    overlayAnchorLeft = b.x;
    overlayAnchorBottomY = b.y + b.height;
    positionMenuWindow();
    positionPickerWindow();
    positionLiveWindow();
    positionPanelWindow();
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  // If the overlay's renderer dies (GPU reset, OOM, Chromium crash), the
  // window object survives but paints nothing — ⌘L and the tray click then
  // toggle an invisible zombie and the overlay looks permanently dead until
  // the whole app restarts. Tear the window down so the next toggle recreates
  // it fresh.
  overlayWindow.webContents.on("render-process-gone", (_e, details) => {
    console.warn("[overlay] renderer gone:", details?.reason || "unknown");
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    } catch (_) {}
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
    // Bring the live meeting notes + side-panel cards back alongside the bar.
    if (liveCardOpen) showLiveWindow();
    if (panelCardOpen) showPanelWindow();
  }

  overlayProgrammaticMove = true;
  setFloatingBounds(overlayWindow, {
    x: Math.round(x),
    y: Math.round(y),
    width: w,
    height: h,
  });
  overlayProgrammaticMove = false;
  // The floating menu/picker/live cards don't make sense next to the collapsed
  // bubble (the live card comes back when the bar expands — see lykn:collapse).
  if (collapsed) {
    hideMenuWindow();
    hidePickerWindow();
    hideLiveWindow();
    hidePanelWindow();
  }
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
  setFloatingBounds(overlayWindow, {
    x: Math.round(clampedX),
    y: Math.round(y),
    width: w,
    height: h,
  });
  overlayProgrammaticMove = false;
  // Keep the floating menu/picker/live/panel cards glued to the bar's edges as it grows.
  positionMenuWindow();
  positionPickerWindow();
  positionLiveWindow();
  positionPanelWindow();
}

function hideOverlay() {
  if (overlayWindow && overlayWindow.isVisible()) overlayWindow.hide();
  // Tear down the full-screen "LYKN is on" glass alongside the bar.
  hideOverlayGlass();
  // And the floating three-dot menu + picker + live notes + side-panel cards.
  hideMenuWindow();
  hidePickerWindow();
  hideLiveWindow();
  hidePanelWindow();
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

// Windows/Linux have no Screen Recording TCC pane — we cache an onboarding
// probe so the walkthrough can show "Test screen capture". Feature gates use
// screenCaptureStatus() which stays allowed unless a probe explicitly failed.
/** @type {"granted"|"denied"|null} */
let screenProbeCache = null;

// Returns 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'.
// Used to gate overlay asks / live watch — on Windows defaults to allowed.
function screenCaptureStatus() {
  if (IS_MAC) {
    try {
      return systemPreferences.getMediaAccessStatus("screen");
    } catch {
      return "unknown";
    }
  }
  return screenProbeCache === "denied" ? "denied" : "granted";
}

// Onboarding UI status — Windows starts as not-determined until the user tests.
function onboardingScreenStatus() {
  if (IS_MAC) return screenCaptureStatus();
  return screenProbeCache || "not-determined";
}

// Microphone privacy status. Works on macOS + Windows via Chromium.
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

function openScreenPrivacySettings() {
  if (IS_MAC) {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
    return;
  }
  // Windows has no Screen Recording TCC pane like macOS; privacy hub is closest.
  if (IS_WIN) {
    shell.openExternal("ms-settings:privacy");
  }
}

/**
 * Make sure Screen Recording is available before Glass / capture features run.
 *
 * macOS only shows the "Allow LYKN to record this computer's screen?" dialog when
 * we actually attempt a capture (or call the TCC prompt via getSources). There is
 * no askForMediaAccess("screen"). Previously Glass failed fast with a Settings
 * message whenever status !== granted — so users who skipped onboarding (or whose
 * older Mac never showed the dialog) never got the system prompt.
 *
 * @returns {Promise<{ok:boolean,status:string,prompted?:boolean,needsSettings?:boolean}>}
 */
async function ensureScreenRecordingAccess() {
  if (!IS_MAC) {
    const st = screenCaptureStatus();
    return { ok: st !== "denied", status: st };
  }

  let status = screenCaptureStatus();
  if (status === "granted") return { ok: true, status };

  // Already denied/restricted — macOS will not show the dialog again.
  if (status === "denied" || status === "restricted") {
    openScreenPrivacySettings();
    return { ok: false, status, needsSettings: true };
  }

  // not-determined / unknown — attempt a tiny capture to surface the system dialog.
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

  status = screenCaptureStatus();
  if (status === "granted") return { ok: true, status, prompted: true };
  if (status === "denied" || status === "restricted") {
    openScreenPrivacySettings();
    return { ok: false, status, needsSettings: true, prompted: true };
  }

  // Still not determined — dialog may be on screen, or this Mac failed to present it.
  return { ok: false, status, prompted: true };
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

/** @type {BrowserWindow | null} */
let snipWindow = null;
/** @type {((rect: {x:number,y:number,width:number,height:number}|null) => void) | null} */
let snipResolver = null;

function closeSnipWindow() {
  if (snipWindow && !snipWindow.isDestroyed()) {
    try { snipWindow.close(); } catch (_) { /* ignore */ }
  }
  snipWindow = null;
}

// Interactive region select for Windows (and as a mac fallback). Full-screen
// dimmed overlay → drag a rectangle → crop from a fresh primary-display capture.
function captureInteractiveSnip() {
  return new Promise(async (resolve) => {
    if (snipResolver) {
      // Only one snip at a time.
      resolve(null);
      return;
    }
    const display = screen.getPrimaryDisplay();
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

    snipResolver = (rect) => {
      const done = snipResolver;
      snipResolver = null;
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

    snipWindow = new BrowserWindow({
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
        preload: path.join(__dirname, "snip-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    snipWindow.setAlwaysOnTop(true, "screen-saver");
    snipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    snipWindow.loadFile(path.join(__dirname, "snip.html"));
    snipWindow.once("ready-to-show", () => {
      if (snipWindow && !snipWindow.isDestroyed()) {
        snipWindow.show();
        snipWindow.focus();
      }
    });
    snipWindow.on("closed", () => {
      snipWindow = null;
      if (snipResolver) {
        const r = snipResolver;
        snipResolver = null;
        r(null);
      }
    });
  });
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
  // Clicks pass straight through to whatever is underneath.
  burstWindow.setIgnoreMouseEvents(true, { forward: true });
  // Keep our own screen reads from capturing the flash.
  try { burstWindow.setContentProtection(true); } catch (_) {}
  // Workspaces first, level last — setVisibleOnAllWorkspaces can reset the
  // window level on macOS (see createOverlayWindow).
  burstWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  burstWindow.setFullScreenable(false);
  burstWindow.setAlwaysOnTop(true, "pop-up-menu");
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

// ── Detached three-dot menu window ──────────────────────────────────────
// The menu is its OWN small vibrancy window floating to the right of the
// glass bar. It can't live inside the overlay window: macOS window vibrancy
// fills the whole window rect, so any in-window panel would sit on a grey
// blurred slab instead of floating free next to the bar.
const MENU_WIDTH = 248;
const MENU_GAP = 12;
const MENU_MIN_HEIGHT = 120;
const MENU_MAX_HEIGHT = 480;
let menuWindow = null;
let menuHeight = 420;

function createMenuWindow() {
  menuWindow = new BrowserWindow({
    width: MENU_WIDTH,
    height: menuHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never steal focus from the bar (or the app under it) — buttons still
    // take the first click thanks to acceptFirstMouse.
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "menu-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    menuWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(menuWindow);
  // Workspaces first, level last — setVisibleOnAllWorkspaces can reset the
  // window level on macOS (see createOverlayWindow).
  menuWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  menuWindow.setFullScreenable(false);
  menuWindow.setAlwaysOnTop(true, "screen-saver");
  menuWindow.loadFile(path.join(__dirname, "menu.html"));
  menuWindow.on("closed", () => {
    menuWindow = null;
  });
}

// Bottom-aligned with the bar, hanging off its right edge (flips to the left
// edge when there's no room on the right).
function menuTargetBounds() {
  const ob = overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(MENU_MIN_HEIGHT, Math.min(menuHeight, MENU_MAX_HEIGHT, workArea.height - 16));
  // The live meeting notes card and the side-panel card occupy the bar's
  // right flank when open — step past them so the menu doesn't land underneath.
  const rightInset =
    (liveWindowVisible() ? LIVE_WIDTH + MENU_GAP : 0) +
    (panelWindowVisible() ? panelWidth + MENU_GAP : 0);
  let x = ob.x + ob.width + MENU_GAP + rightInset;
  if (x + MENU_WIDTH > workArea.x + workArea.width) x = ob.x - MENU_GAP - MENU_WIDTH;
  x = Math.max(workArea.x, x);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x: Math.round(x), y: Math.round(y), width: MENU_WIDTH, height: h };
}

function positionMenuWindow() {
  if (!menuWindow || menuWindow.isDestroyed() || !menuWindow.isVisible()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setFloatingBounds(menuWindow, menuTargetBounds());
}

function notifyMenuVisibility(visible) {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed())
      overlayWindow.webContents.send("lykn:menu-visible", !!visible);
  } catch (_) {}
}

function showMenuWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Only one floating card next to the bar at a time.
  hidePickerWindow();
  if (!menuWindow || menuWindow.isDestroyed()) createMenuWindow();
  const fire = () => {
    if (!menuWindow || menuWindow.isDestroyed()) return;
    setFloatingBounds(menuWindow, menuTargetBounds());
    menuWindow.showInactive();
    menuWindow.moveTop();
    menuWindow.webContents.send("lykn:menu-shown");
    notifyMenuVisibility(true);
  };
  if (menuWindow.webContents.isLoading()) menuWindow.webContents.once("did-finish-load", fire);
  else fire();
}

function hideMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) menuWindow.hide();
  notifyMenuVisibility(false);
}

// ── Detached side-panel picker window ───────────────────────────────────
// The "None" view picker in the bar toolbar gets the same treatment as the
// three-dot menu: its OWN small vibrancy card floating next to the bar
// (an in-window drawer can't float on a transparent gap — see the menu
// window rationale above). It hangs off the bar's LEFT edge, mirroring its
// trigger button, and flips right when there's no room.
const PICKER_WIDTH = 200;
const PICKER_MIN_HEIGHT = 60;
const PICKER_MAX_HEIGHT = 420;
let pickerWindow = null;
let pickerHeight = 280;

function createPickerWindow() {
  pickerWindow = new BrowserWindow({
    width: PICKER_WIDTH,
    height: pickerHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "picker-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    pickerWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(pickerWindow);
  // Workspaces first, level last — see createOverlayWindow.
  pickerWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  pickerWindow.setFullScreenable(false);
  pickerWindow.setAlwaysOnTop(true, "screen-saver");
  pickerWindow.loadFile(path.join(__dirname, "picker.html"));
  pickerWindow.on("closed", () => {
    pickerWindow = null;
  });
}

// Bottom-aligned with the bar, hanging off its left edge (flips to the right
// edge when there's no room on the left).
function pickerTargetBounds() {
  const ob = overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(
    PICKER_MIN_HEIGHT,
    Math.min(pickerHeight, PICKER_MAX_HEIGHT, workArea.height - 16),
  );
  let x = ob.x - MENU_GAP - PICKER_WIDTH;
  if (x < workArea.x) x = ob.x + ob.width + MENU_GAP;
  x = Math.min(x, workArea.x + workArea.width - PICKER_WIDTH);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x: Math.round(x), y: Math.round(y), width: PICKER_WIDTH, height: h };
}

function positionPickerWindow() {
  if (!pickerWindow || pickerWindow.isDestroyed() || !pickerWindow.isVisible()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setFloatingBounds(pickerWindow, pickerTargetBounds());
}

function notifyPickerVisibility(visible) {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed())
      overlayWindow.webContents.send("lykn:picker-visible", !!visible);
  } catch (_) {}
}

function showPickerWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Only one floating card next to the bar at a time.
  hideMenuWindow();
  if (!pickerWindow || pickerWindow.isDestroyed()) createPickerWindow();
  const fire = () => {
    if (!pickerWindow || pickerWindow.isDestroyed()) return;
    setFloatingBounds(pickerWindow, pickerTargetBounds());
    pickerWindow.showInactive();
    pickerWindow.moveTop();
    pickerWindow.webContents.send("lykn:picker-shown");
    notifyPickerVisibility(true);
  };
  if (pickerWindow.webContents.isLoading()) pickerWindow.webContents.once("did-finish-load", fire);
  else fire();
}

function hidePickerWindow() {
  if (pickerWindow && !pickerWindow.isDestroyed() && pickerWindow.isVisible()) pickerWindow.hide();
  notifyPickerVisibility(false);
}

// ── Detached live meeting notes window ──────────────────────────────────
// The live transcription / meeting notes card gets the same treatment as the
// three-dot menu and the view picker: its OWN vibrancy window floating next
// to the bar, instead of an in-window side column that stretched the chat
// bar and bled into the composer. The overlay renderer keeps ALL of the
// capture/transcription logic (it owns the audio streams); it pushes render
// snapshots here and receives user actions back.
const LIVE_WIDTH = 420;
const LIVE_HEIGHT = 520;
let liveWindow = null;
let lastLiveState = null;
// Whether the overlay renderer considers the live card open — lets us bring
// the card back when the bar is re-shown/expanded mid-meeting.
let liveCardOpen = false;

function createLiveWindow() {
  liveWindow = new BrowserWindow({
    width: LIVE_WIDTH,
    height: LIVE_HEIGHT,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "live-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    liveWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(liveWindow);
  // Workspaces first, level last — see createOverlayWindow.
  liveWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  liveWindow.setFullScreenable(false);
  liveWindow.setAlwaysOnTop(true, "screen-saver");
  liveWindow.loadFile(path.join(__dirname, "live.html"));
  liveWindow.on("closed", () => {
    liveWindow = null;
  });
}

function liveWindowVisible() {
  return !!(liveWindow && !liveWindow.isDestroyed() && liveWindow.isVisible());
}

// Bottom-aligned with the bar, hanging off its right edge (flips to the left
// edge when there's no room on the right).
function liveTargetBounds() {
  const ob = overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.min(LIVE_HEIGHT, workArea.height - 16);
  let x = ob.x + ob.width + MENU_GAP;
  if (x + LIVE_WIDTH > workArea.x + workArea.width) x = ob.x - MENU_GAP - LIVE_WIDTH;
  x = Math.max(workArea.x, x);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x: Math.round(x), y: Math.round(y), width: LIVE_WIDTH, height: h };
}

function positionLiveWindow() {
  if (!liveWindowVisible()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setFloatingBounds(liveWindow, liveTargetBounds());
}

function sendLiveState() {
  if (!liveWindowVisible() || !lastLiveState) return;
  try {
    liveWindow.webContents.send("lykn:live-state", lastLiveState);
  } catch (_) {}
}

function showLiveWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!liveWindow || liveWindow.isDestroyed()) createLiveWindow();
  const fire = () => {
    if (!liveWindow || liveWindow.isDestroyed()) return;
    setFloatingBounds(liveWindow, liveTargetBounds());
    liveWindow.showInactive();
    liveWindow.moveTop();
    sendLiveState();
    // The side-panel card and three-dot menu float on the same side; re-place
    // them so they land next to the live card instead of underneath it.
    positionPanelWindow();
    positionMenuWindow();
  };
  if (liveWindow.webContents.isLoading()) liveWindow.webContents.once("did-finish-load", fire);
  else fire();
}

function hideLiveWindow() {
  if (liveWindowVisible()) liveWindow.hide();
  positionPanelWindow();
  positionMenuWindow();
}

// ── Detached side-panel content window ──────────────────────────────────
// The view picked from the bar's "None" dropdown (Sources / Tasks /
// Follow-ups / Notes / Live feedback) used to render as an in-window column
// that widened the chat bar. It now gets the same treatment as the menu,
// picker and live cards: its OWN vibrancy window floating off the bar's
// right flank, visually separated from the chat glass. The overlay renderer
// stays the source of truth and pushes render snapshots here.
const PANEL_MIN_HEIGHT = 120;
const PANEL_MAX_HEIGHT = 560;
let panelWindow = null;
let panelWidth = 300;
let panelHeight = 280;
let lastPanelState = null;
// Whether the overlay renderer considers the panel open — lets us bring it
// back when the bar is re-shown/expanded.
let panelCardOpen = false;

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: panelWidth,
    height: panelHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "panel-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    panelWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(panelWindow);
  // Workspaces first, level last — see createOverlayWindow.
  panelWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  panelWindow.setFullScreenable(false);
  panelWindow.setAlwaysOnTop(true, "screen-saver");
  panelWindow.loadFile(path.join(__dirname, "panel.html"));
  panelWindow.on("closed", () => {
    panelWindow = null;
  });
}

function panelWindowVisible() {
  return !!(panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible());
}

// Bottom-aligned with the bar on its right flank; stacks past the live
// meeting notes card when that's open, and flips left when out of room.
function panelTargetBounds() {
  const ob = overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(
    PANEL_MIN_HEIGHT,
    Math.min(panelHeight, PANEL_MAX_HEIGHT, workArea.height - 16),
  );
  const rightInset = liveWindowVisible() ? LIVE_WIDTH + MENU_GAP : 0;
  let x = ob.x + ob.width + MENU_GAP + rightInset;
  if (x + panelWidth > workArea.x + workArea.width) x = ob.x - MENU_GAP - panelWidth;
  x = Math.max(workArea.x, x);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(panelWidth), height: h };
}

function positionPanelWindow() {
  if (!panelWindowVisible()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setFloatingBounds(panelWindow, panelTargetBounds());
}

function sendPanelState() {
  if (!panelWindowVisible() || !lastPanelState) return;
  try {
    panelWindow.webContents.send("lykn:panel-state", lastPanelState);
  } catch (_) {}
}

function showPanelWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!panelWindow || panelWindow.isDestroyed()) createPanelWindow();
  const fire = () => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    setFloatingBounds(panelWindow, panelTargetBounds());
    panelWindow.showInactive();
    panelWindow.moveTop();
    sendPanelState();
    // The three-dot menu shares the right flank; re-place it so it lands
    // next to the panel instead of underneath it.
    positionMenuWindow();
  };
  if (panelWindow.webContents.isLoading()) panelWindow.webContents.once("did-finish-load", fire);
  else fire();
}

function hidePanelWindow() {
  if (panelWindowVisible()) panelWindow.hide();
  positionMenuWindow();
}

// ⌘+L: toggle the floating glass bar. Screen capture happens silently at ask
// time (see streamScreenAnswer) so the bar always reflects the live screen and
// the user never sees the screenshot.
function showOverlay() {
  // A crashed renderer leaves a window that "shows" but paints nothing —
  // rebuild it instead of showing a blank zombie.
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.webContents.isCrashed()) {
    try { overlayWindow.destroy(); } catch (_) {}
    overlayWindow = null;
  }
  if (!overlayWindow) createOverlayWindow();
  // Re-assert top-of-stack status on EVERY show. The level/ordering set at
  // creation can be lost after an app restart, a Space switch, or a full-screen
  // transition — which is why the panel sometimes appeared *behind* other
  // always-on-top windows (e.g. the main window) instead of coming all the way
  // forward. Re-applying the level + moveTop() forces it to the front again.
  //
  // ORDER MATTERS (electron#10078 / #26350): setVisibleOnAllWorkspaces can
  // reset the NSWindow level on macOS, so it goes FIRST and the always-on-top
  // level goes LAST. With the old order (level, then workspaces) the level
  // reset raced the show and the bar intermittently stayed hidden behind
  // full-screen apps until the user left and re-entered full screen.
  overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  overlayWindow.setFullScreenable(false);
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  // Re-assert content protection on every show — like the window level, it can
  // be dropped after a restart or Space/full-screen transition.
  applyContentProtection();
  // Fade in the full-screen glass behind the bar so the user gets an
  // unmistakable "LYKN is on" cue for as long as the overlay is up.
  playOverlayBurst();
  overlayWindow.show();
  // Re-assert the level AFTER show too — ordering a window onto a full-screen
  // Space can drop it again — then bring it above the burst flash.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.moveTop();
  overlayWindow.focus();
  // Restore the live meeting notes + side-panel cards if still open.
  if (liveCardOpen && !overlayCollapsed) showLiveWindow();
  if (panelCardOpen && !overlayCollapsed) showPanelWindow();
  overlayWindow.webContents.send("lykn:overlay-shown");
}

function toggleOverlay() {
  const alive =
    overlayWindow &&
    !overlayWindow.isDestroyed() &&
    !overlayWindow.webContents.isCrashed();
  if (alive && overlayWindow.isVisible()) {
    hideOverlay();
    return;
  }
  showOverlay();
}

function registerGlobalHotkey() {
  globalShortcut.register("CommandOrControl+L", () => {
    // Let the first-run walkthrough celebrate the user's first ⌘L.
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.webContents.send("lykn:onboarding-hotkey");
    }
    toggleOverlay();
  });
}

// ── Tray icon ───────────────────────────────────────────────────────────────
// Lives in the macOS menu bar / Windows notification area for as long as the
// app runs (including silent login launches). Click toggles the glass overlay
// chat — same as ⌘/Ctrl+L; right-click opens a small utility menu.
//
// macOS: TEMPLATE image (black + alpha) so the system recolors it.
//   node scripts/generate-tray-icon.mjs
// Windows: colored glyph (template images aren't used in the Win tray).
//   node scripts/generate-windows-icons.mjs
function createTray() {
  if (tray) return;
  const trayFile = IS_MAC ? "trayTemplate.png" : "tray-win.png";
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "resources", trayFile),
  );
  if (IS_MAC) icon.setTemplateImage(true);
  tray = new Tray(icon);
  const hotkeyLabel = IS_MAC ? "⌘L" : "Ctrl+L";
  tray.setToolTip(`LYKN — open the chat overlay (${hotkeyLabel})`);

  // Left click = the one-gesture action: toggle the overlay chat.
  tray.on("click", () => {
    toggleOverlay();
  });

  // Right-click = utility menu. Built lazily per popup so the overlay label
  // reflects current visibility. NOT set via setContextMenu — on macOS that
  // would hijack left-click into opening the menu instead of the overlay.
  // On Windows, also bind to "menu" / double-click for discoverability.
  const popupTrayMenu = () => {
    const overlayVisible = Boolean(overlayWindow && overlayWindow.isVisible());
    const menu = Menu.buildFromTemplate([
      {
        label: overlayVisible ? "Hide Chat Overlay" : "Open Chat Overlay",
        accelerator: "CommandOrControl+L",
        click: () => toggleOverlay(),
      },
      {
        label: "Open LYKN Window",
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
          else {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: "separator" },
      {
        label: "Set Up LYKN / Permissions…",
        click: () => createOnboardingWindow(),
      },
      { type: "separator" },
      { label: "Quit LYKN Completely", click: () => quitForReal() },
    ]);
    tray.popUpContextMenu(menu);
  };
  tray.on("right-click", popupTrayMenu);
  if (IS_WIN) {
    // Windows often surfaces the context menu on this event too.
    tray.on("double-click", () => toggleOverlay());
  }
}

// Strip the hidden control tags the chat models emit so they never leak into
// the overlay bubble (the web app strips these too, server-side prompt aside).
function stripHiddenTags(s) {
  return String(s || "")
    .replace(/<\/?(?:learned|reason|applied)>[\s\S]*?<\/(?:learned|reason|applied)>/gi, "")
    .replace(/<\/?(?:learned|reason|applied)\b[^>]*>/gi, "")
    .replace(/\[TAG_NOTES:[^\]]*\]/gi, "")
    // Legacy [[HIGHLIGHT: …]] tags (screen glow feature removed) — strip if
    // an older model or cached prompt still emits them.
    .replace(/\[\[\s*HIGHLIGHT\s*:[^\]]*\]\]/gi, "")
    // Brand is always LYKN (all caps) — leave lykn.io / lykn_* / lykn-* alone
    // (hyphen: overlay markers like lykn-artifact: / lykn-video:).
    .replace(/\b[Ll][Yy][Kk][Nn]\b(?!\.io\b)(?![_\-/])/g, "LYKN")
    // Normalize overlay markers to lykn_artifact: / lykn_video: / lykn_vault:
    // (underscore form). Covers LYKN-artifact from older brand rewrites and hyphen forms.
    .replace(/!\[(?:LYKN|lykn)[-_](artifact|video|vault):/gi, (_, kind) => `![lykn_${String(kind).toLowerCase()}:`);
}

// Overlay session seeds for vault pull-ups → Build / Image edit.
// Declared above the vault marker helpers that write them.
let lastOverlayReactArtifact = null; // { toolName, title, code }
let lastOverlayVaultImage = null; // { url, title }

/**
 * Parse `[ATTACHMENTS_JSON:…]` from vault note content (CJS twin of
 * lib/vault/attachmentsMarker.js — main cannot import that ESM module).
 */
function parseVaultAttachmentsFromContent(content) {
  const MARKER = "[ATTACHMENTS_JSON:";
  const raw = String(content || "");
  const start = raw.indexOf(MARKER);
  if (start === -1) return [];
  const jsonStart = start + MARKER.length;
  if (raw[jsonStart] !== "[") return [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd === -1) return [];
  try {
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stripVaultAttachmentsMarker(content) {
  const MARKER = "[ATTACHMENTS_JSON:";
  const raw = String(content || "");
  const start = raw.indexOf(MARKER);
  if (start === -1) return raw.trim();
  // Cheap strip: drop from marker to matching close (same scanner as parse).
  const atts = parseVaultAttachmentsFromContent(raw);
  if (!atts.length && start >= 0) {
    // Malformed marker — cut from marker to end of first line-ish chunk.
    return raw.slice(0, start).replace(/\n{3,}/g, "\n\n").trim();
  }
  const spanStart = start;
  // Re-scan for markerEnd including trailing ].
  const jsonStart = start + MARKER.length;
  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  let markerEnd = jsonEnd > 0 ? jsonEnd : raw.length;
  if (raw[markerEnd] === "]") markerEnd += 1;
  return `${raw.slice(0, spanStart)}${raw.slice(markerEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Classify a vault attachment for Glass view mode (image / html / video / other). */
function classifyVaultAttachmentForOverlay(att) {
  if (!att || typeof att !== "object") return "other";
  // Match VaultAttachment: explicit non-"file" type wins; "file" falls through
  // to mime/extension so saved React artifacts still preview as HTML.
  const type = String(att.type || "").toLowerCase();
  if (type === "image" || type === "html" || type === "video") return type;
  const mime = String(att.mimeType || att.mime_type || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/html") return "html";
  if (mime.startsWith("video/")) return "video";
  const src = String(att.name || att.url || att.storagePath || att.storage_path || "")
    .split("?")[0]
    .toLowerCase();
  if (/\.(jpe?g|png|gif|webp|svg|bmp|heic|heif|tiff)$/i.test(src)) return "image";
  if (/\.html?$/i.test(src)) return "html";
  if (/\.(mp4|webm|mov|m4v)$/i.test(src)) return "video";
  if (/^data:image\//i.test(String(att.url || ""))) return "image";
  if (type && type !== "file" && type !== "other") return type;
  return "other";
}

/** In-memory HTML for lykn-artifact:// iframe previews in Glass. */
const artifactHtmlCache = new Map(); // key -> html string

function cacheArtifactHtmlForOverlay(html) {
  const body = String(html || "");
  if (!body.trim()) return "";
  const key = crypto.randomUUID().replace(/-/g, "");
  artifactHtmlCache.set(key, body);
  while (artifactHtmlCache.size > 40) {
    const oldest = artifactHtmlCache.keys().next().value;
    artifactHtmlCache.delete(oldest);
  }
  return `lykn-artifact://${key}`;
}

function isOverlayFirstPartyHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host === "artifacts.lykn.io" || host === "api.lykn.io" || host === "lykn.io") return true;
  try {
    const apiHost = new URL(API_BASE).hostname.toLowerCase();
    if (host === apiHost) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Fetch media bytes; allow our own API/localhost (file-proxy in dev). */
async function fetchOverlayMedia(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  let host = "";
  try {
    host = new URL(u).hostname;
  } catch {
    return null;
  }
  try {
    if (isOverlayFirstPartyHost(host)) {
      return await fetch(u);
    }
    return await safeFetchMain(u);
  } catch (e) {
    console.warn("[overlay-vault] media fetch failed:", e?.message || e);
    return null;
  }
}

async function mintStorageSignedUrl(storagePath, bucket, token) {
  const res = await fetch(`${API_BASE}/api/storage/signed-url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ storagePath, bucket }),
  });
  if (!res.ok) return "";
  const data = await res.json().catch(() => null);
  return String(data?.signedUrl || "").trim();
}

/**
 * HTML artifacts must NOT use raw Supabase signed URLs in an iframe (wrong
 * MIME / frame-ancestors → blank). Prefer a public file-proxy URL; in local
 * API / private-proxy cases, fetch the HTML in main and serve via lykn-artifact://.
 */
async function resolveVaultHtmlDisplayUrl(att, token) {
  const storagePath = String(att.storagePath || att.storage_path || "").trim();
  const bucket = String(att.storageBucket || att.storage_bucket || "user-files").trim();
  const filename = String(att.name || "").trim() || "artifact.html";

  const materializeFromUrl = async (url) => {
    const res = await fetchOverlayMedia(url);
    if (!res || !res.ok) return "";
    const html = await res.text().catch(() => "");
    return cacheArtifactHtmlForOverlay(html);
  };

  if (storagePath && token) {
    try {
      const res = await fetch(`${API_BASE}/api/storage/file-proxy-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ storagePath, bucket, filename }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const proxyUrl = String(data?.url || "").trim();
        if (/^https?:\/\//i.test(proxyUrl) && !/supabase\.co\/storage\//i.test(proxyUrl)) {
          const pub = await assertPublicHttpUrl(proxyUrl);
          if (pub.ok) return proxyUrl;
          // localhost / private API file-proxy — pull bytes into local scheme.
          const local = await materializeFromUrl(proxyUrl);
          if (local) return local;
        }
      } else {
        console.warn("[overlay-vault] file-proxy-url", res.status);
      }
    } catch (e) {
      console.warn("[overlay-vault] file-proxy mint failed:", e?.message || e);
    }

    try {
      const signed = await mintStorageSignedUrl(storagePath, bucket, token);
      if (signed) {
        const local = await materializeFromUrl(signed);
        if (local) return local;
      }
    } catch (e) {
      console.warn("[overlay-vault] signed html materialize failed:", e?.message || e);
    }
  }

  const fallback = String(att.url || "").trim();
  if (/^https?:\/\//i.test(fallback) && !/supabase\.co\/storage\//i.test(fallback)) {
    const pub = await assertPublicHttpUrl(fallback);
    if (pub.ok) return fallback;
    const local = await materializeFromUrl(fallback);
    if (local) return local;
  }
  // Last resort: supabase URL as bytes → local scheme (never as iframe src).
  if (/^https?:\/\//i.test(fallback) && /supabase\.co\/storage\//i.test(fallback)) {
    const local = await materializeFromUrl(fallback);
    if (local) return local;
  }
  return "";
}

/** Fresh signed / file-proxy URL so Glass can iframe/img vault media. */
async function resolveVaultAttachmentDisplayUrl(att, token) {
  if (!att || typeof att !== "object") return "";
  const kind = classifyVaultAttachmentForOverlay(att);
  if (kind === "html") return resolveVaultHtmlDisplayUrl(att, token);

  const storagePath = String(att.storagePath || att.storage_path || "").trim();
  const bucket = String(att.storageBucket || att.storage_bucket || "user-files").trim();
  if (storagePath && token) {
    try {
      const signed = await mintStorageSignedUrl(storagePath, bucket, token);
      if (/^https?:\/\//i.test(signed)) return signed;
    } catch {
      /* fall through */
    }
  }
  const fallback = String(att.url || "").trim();
  return /^https?:\/\//i.test(fallback) || /^data:image\//i.test(fallback) ? fallback : "";
}

function vaultOpenCardMarkdown(kind, id, title, subtitle) {
  const safeTitle = String(title || "Saved item").replace(/[\]\n\r]/g, " ").slice(0, 100) || "Saved item";
  const safeSub = String(subtitle || "")
    .replace(/["\n\r]/g, " ")
    .slice(0, 160);
  const href = `lykn-vault://${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
  return safeSub
    ? `![lykn_vault:${safeTitle}](${href} "${safeSub}")`
    : `![lykn_vault:${safeTitle}](${href})`;
}

/**
 * Build Glass view-mode markers from lykn_loadNeuron / lykn_loadNeurons.
 * Vault images → md-img, HTML → lykn_artifact iframe, else Open card.
 * Also seeds lastOverlayReactArtifact when an editable React source is found.
 */
async function overlayVaultMarkersFromToolResult(toolName, result) {
  const name = String(toolName || "");
  const entries = [];
  if (!result || typeof result !== "object") return "";

  if (/loadNeurons$/i.test(name) && Array.isArray(result.results)) {
    for (const entry of result.results) {
      if (entry && entry.ok === true) entries.push(entry);
    }
  } else if (result.ok === true) {
    entries.push(result);
  }

  const lines = [];
  const seen = new Set();
  let token = null;
  const ensureToken = async () => {
    if (token !== null) return token;
    try {
      token = (await getAuthToken()) || "";
    } catch {
      token = "";
    }
    return token;
  };

  for (const entry of entries) {
    const kind = String(entry.kind || "").toLowerCase();
    let id = "";
    let title = "";
    let subtitle = "";
    if (kind === "vault") {
      id =
        String(entry.note?.id || "").trim() ||
        String(entry.node_id || "")
          .replace(/^vault_/i, "")
          .trim();
      title = String(entry.note?.title || entry.display || "Vault item")
        .replace(/\s+/g, " ")
        .trim();
      const body = stripVaultAttachmentsMarker(String(entry.note?.content || ""))
        .replace(/\s+/g, " ")
        .trim();
      subtitle = body.slice(0, 140);
    } else if (kind === "belief") {
      id =
        String(entry.belief?.id || "").trim() ||
        String(entry.node_id || "")
          .replace(/^belief_/i, "")
          .trim();
      title = String(entry.belief?.text || entry.display || "Belief")
        .replace(/\s+/g, " ")
        .trim();
      subtitle = "Core belief";
    } else if (kind === "fact") {
      id =
        String(entry.fact?.id || "").trim() ||
        String(entry.node_id || "")
          .replace(/^fact_/i, "")
          .trim();
      title = String(entry.fact?.text || entry.display || "Fact")
        .replace(/\s+/g, " ")
        .trim();
      subtitle = "Preference / fact";
    } else if (kind === "concept") {
      id =
        String(entry.concept?.id || entry.concept?.slug || "").trim() ||
        String(entry.node_id || "")
          .replace(/^concept_/i, "")
          .trim();
      title = String(entry.concept?.label || entry.display || "Concept")
        .replace(/\s+/g, " ")
        .trim();
      subtitle = "Concept";
    } else {
      continue;
    }
    if (!id || seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    const safeTitle = title.replace(/[\]\n\r]/g, " ").slice(0, 100) || "Saved item";

    // Vault media: render the same view as Vault (image / live artifact / video).
    if (kind === "vault") {
      const atts = parseVaultAttachmentsFromContent(entry.note?.content || "");
      const primary = atts.find((a) => a && typeof a === "object") || null;
      if (primary) {
        const mediaKind = classifyVaultAttachmentForOverlay(primary);
        const auth = await ensureToken();
        const mediaUrl = await resolveVaultAttachmentDisplayUrl(primary, auth);
        if (mediaUrl && mediaKind === "image") {
          lines.push(`![${safeTitle}](${mediaUrl})`);
          lines.push(vaultOpenCardMarkdown("vault", id, safeTitle, "Image · Open in Vault"));
          lastOverlayVaultImage = { url: mediaUrl, title: safeTitle };
          continue;
        }
        if (mediaUrl && mediaKind === "html") {
          lines.push(`![lykn_artifact:${safeTitle}](${mediaUrl})`);
          lines.push(vaultOpenCardMarkdown("vault", id, safeTitle, "Artifact · Open in Vault"));
          // Seed Build-mode refine before the card lands so Edit → Build works.
          try {
            const code = await extractReactArtifactCodeFromResult({
              file_url: mediaUrl,
              title: safeTitle,
            });
            if (code && String(code).trim()) {
              lastOverlayReactArtifact = {
                toolName: "lykn_build_react_artifact",
                title: safeTitle,
                code: String(code),
              };
            }
          } catch {
            /* non-React HTML still previews; Build starts fresh */
          }
          continue;
        }
        if (mediaUrl && mediaKind === "video") {
          lines.push(`![lykn_video:${safeTitle}](${mediaUrl})`);
          lines.push(vaultOpenCardMarkdown("vault", id, safeTitle, "Video · Open in Vault"));
          continue;
        }
      }
    }

    lines.push(vaultOpenCardMarkdown(kind, id, safeTitle, subtitle));
    if (lines.length >= 12) break;
  }
  return lines.length ? `\n\n${lines.join("\n\n")}\n\n` : "";
}

// While streaming, a control tag can arrive split across deltas. Trim any
// unfinished "[[..." tail so raw markup never flashes in the bubble.
function trimPartialControlTagTail(s) {
  return String(s || "")
    .replace(/\[\[(?![\s\S]*\]\])[\s\S]*$/, "")
    .replace(/\[$/, "");
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
    const err = await errorFromAiResponse(res);
    return { error: humanizeStreamError(err) };
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

// ── Auth token access ───────────────────────────────────────────────────────
// The web app keeps the Supabase session in localStorage (sb-<ref>-auth-token)
// on the default Electron session and auto-refreshes it while a window running
// lykn.io is alive. We attach it as a Bearer token exactly like the web app's
// installAuthFetch patch does, so /api/ai/stream authorizes the request.
//
// LYKN deliberately runs as a menu-bar app: a login-item launch starts with NO
// main window, and closing/⌘Q'ing the window keeps the tray + ⌘L overlay
// armed. The token must therefore be readable WITHOUT a main window —
// otherwise every overlay ask after a reboot fails with "Sign in to LYKN
// first" even though the session is still on disk. Strategy:
//   1. Live read from the main window when it exists (current behavior).
//   2. Fall back to a short-lived in-memory cache of the last good token.
//   3. Fall back to a hidden window that loads the app: same localStorage,
//      and the web app's Supabase client refreshes an expired stored session
//      on boot, so this also recovers after long sleeps/reboots.

const READ_SUPABASE_TOKEN_JS = `(function () {
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
})()`;

// Distinguishes "signed out" (no sb- key at all → give up fast) from "session
// stored but access token stale" (keep polling while Supabase refreshes it).
const HAS_SUPABASE_SESSION_JS = `(function () {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) return true;
    }
  } catch (e) {}
  return false;
})()`;

let cachedAuthToken = null;
let cachedAuthTokenExpMs = 0;
/** @type {Promise<string | null> | null} */
let hiddenAuthReadPromise = null;
/** @type {BrowserWindow | null} */
// Persistent hidden window that keeps the web app's Supabase client alive
// when there's no main window (login-item launch, or main window crashed).
// Same default session / localStorage as the main window — just never shown.
let authKeeperWindow = null;

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1], "base64").toString("utf8"),
    );
    const exp = Number(payload?.exp || 0);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function cacheAuthToken(token) {
  cachedAuthToken = token;
  // Unknown expiry → assume 5 minutes so we re-verify soon rather than serve
  // a possibly-dead token for an hour.
  cachedAuthTokenExpMs = jwtExpiryMs(token) || Date.now() + 5 * 60 * 1000;
}

async function readTokenFromWebContents(webContents) {
  const raw = await webContents.executeJavaScript(READ_SUPABASE_TOKEN_JS, true);
  return typeof raw === "string" && raw ? raw : null;
}

// Ask the web app's own Supabase client (installAuthFetch exposes
// window.__lyknGetFreshToken) to refresh and hand back a valid access token.
// This is the only reliable way to recover from an EXPIRED token in storage:
// the renderer owns the rotating refresh token, so refreshing must happen
// through its client, not by re-reading localStorage from out here.
async function refreshTokenViaWebContents(webContents) {
  try {
    const raw = await webContents.executeJavaScript(
      "window.__lyknGetFreshToken ? window.__lyknGetFreshToken(true) : null",
      true,
    );
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

// True when a JWT is missing its expiry or expires within `marginMs`.
function tokenIsStale(token, marginMs = 60_000) {
  const expMs = jwtExpiryMs(token);
  return !expMs || expMs <= Date.now() + marginMs;
}

// Prefer the (possibly hidden) main window; otherwise the dedicated auth
// keeper. Both share the default session and keep backgroundThrottling off
// so Supabase's refresh timer keeps firing.
function liveAuthWebContents() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.webContents;
  if (authKeeperWindow && !authKeeperWindow.isDestroyed()) {
    return authKeeperWindow.webContents;
  }
  return null;
}

// Keep a hidden lykn.io window alive whenever there's no main window, so
// login-item launches (and crash recovery) still have a live Supabase client
// for Glass asks. Idempotent.
function ensureAuthKeeper() {
  if (mainWindow && !mainWindow.isDestroyed()) return;
  if (authKeeperWindow && !authKeeperWindow.isDestroyed()) return;
  try {
    authKeeperWindow = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      skipTaskbar: true,
      frame: false,
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Same reason as mainWindow: the refresh timer must keep firing.
        backgroundThrottling: false,
      },
    });
    authKeeperWindow.loadURL(APP_URL);
    authKeeperWindow.on("closed", () => {
      authKeeperWindow = null;
    });
  } catch (e) {
    console.warn("[auth-keeper] failed to create:", e?.message || e);
    authKeeperWindow = null;
  }
}

function destroyAuthKeeper() {
  try {
    if (authKeeperWindow && !authKeeperWindow.isDestroyed()) authKeeperWindow.destroy();
  } catch (_) { /* ignore */ }
  authKeeperWindow = null;
}

// Read + optionally refresh through a live auth webContents. Returns null when
// the window has no session (signed out) so the caller can drop the cache.
async function readTokenFromLiveAuth(webContents, { forceRefresh = false } = {}) {
  const token = await readTokenFromWebContents(webContents);
  if (token && !forceRefresh && !tokenIsStale(token)) {
    cacheAuthToken(token);
    return token;
  }
  if (token || forceRefresh) {
    const refreshed = await refreshTokenViaWebContents(webContents);
    if (refreshed && !tokenIsStale(refreshed)) {
      cacheAuthToken(refreshed);
      return refreshed;
    }
    // Refresh hook unavailable (app still booting) or refresh failed —
    // a present non-stale token is still worth trying; a known-stale one
    // is not (it just becomes a guaranteed 401).
    if (token && !tokenIsStale(token, 0)) {
      cacheAuthToken(token);
      return token;
    }
  }
  // Alive window, no usable session → signed out.
  if (!token && !forceRefresh) {
    cachedAuthToken = null;
    cachedAuthTokenExpMs = 0;
    return null;
  }
  return null;
}

// Boot (or reuse) a hidden window on the shared default session to refresh
// the stored Supabase session. Kept around as the auth keeper afterwards so
// the next ask doesn't pay another cold boot. Deduplicated across parallel
// overlay asks.
function readTokenViaHiddenWindow() {
  if (hiddenAuthReadPromise) return hiddenAuthReadPromise;
  hiddenAuthReadPromise = (async () => {
    try {
      ensureAuthKeeper();
      const win = authKeeperWindow;
      if (!win || win.isDestroyed()) return null;

      // Wait for the SPA to finish its first load if we just created it.
      if (win.webContents.isLoading()) {
        await new Promise((resolve) => {
          const done = () => resolve();
          win.webContents.once("did-finish-load", done);
          setTimeout(done, 12_000);
        });
      }

      const hasStoredSession = await win.webContents
        .executeJavaScript(HAS_SUPABASE_SESSION_JS, true)
        .catch(() => false);
      if (!hasStoredSession) return null; // genuinely signed out

      // Poll while the app's Supabase client validates/refreshes the stored
      // session. Wait for the refresh hook to appear, then force a refresh.
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const hookReady = await win.webContents
          .executeJavaScript("typeof window.__lyknGetFreshToken === 'function'", true)
          .catch(() => false);
        if (hookReady) {
          const refreshed = await refreshTokenViaWebContents(win.webContents);
          if (refreshed && !tokenIsStale(refreshed)) {
            cacheAuthToken(refreshed);
            return refreshed;
          }
        }
        const token = await readTokenFromWebContents(win.webContents).catch(() => null);
        if (token && !tokenIsStale(token)) {
          cacheAuthToken(token);
          return token;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return null;
    } catch {
      return null;
    } finally {
      hiddenAuthReadPromise = null;
    }
  })();
  return hiddenAuthReadPromise;
}

async function getAuthToken({ forceRefresh = false } = {}) {
  // 1. Live read from the main window (even when hidden) or the auth keeper.
  //    An expired token in storage is NOT good enough — after the window
  //    idles the stored access token may be dead, so validate expiry and
  //    push a real refresh through the app's Supabase client when needed.
  const live = liveAuthWebContents();
  if (live) {
    try {
      const fromLive = await readTokenFromLiveAuth(live, { forceRefresh });
      if (fromLive) return fromLive;
      // Live window says signed out (no token at all, not force-refreshing).
      if (!forceRefresh) return null;
    } catch {
      // Window mid-load/navigation — fall through to the cache/hidden read.
    }
  }

  // 2. Recent token from memory (menu-bar mode within the same app run).
  if (!forceRefresh && cachedAuthToken && Date.now() < cachedAuthTokenExpMs - 60_000) {
    return cachedAuthToken;
  }

  // 3. Ensure an auth keeper exists and refresh through it (login-item
  //    launch, crash recovery, or forceRefresh after a 401 with no live win).
  return readTokenViaHiddenWindow();
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

// ── Launch at login ─────────────────────────────────────────────────────────
// LYKN is a background companion: it must already be running for ⌘+L to work,
// so the packaged app registers itself as a login item on first run. We only
// auto-enable ONCE (marker in overlay settings) — if the user later disables
// LYKN in System Settings › Login Items, we respect that and never re-add it.

function isLoginItemEnabled() {
  if (!app.isPackaged) return false;
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setLoginItemEnabled(enabled) {
  if (!app.isPackaged) return; // dev would register the bare Electron binary
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    // The user (or first-run) made an explicit choice — never auto-enable again.
    writeOverlaySettings({ loginItemConfigured: true });
  } catch (e) {
    console.error("[LYKN] failed to update login item:", e?.message);
  }
}

function setupLaunchAtLogin() {
  if (!app.isPackaged) return;
  if (readOverlaySettings().loginItemConfigured) return;
  setLoginItemEnabled(true);
}

// True when macOS launched us at login (SMAppService). In that case we start
// silently in the background — no main window — and just arm the ⌘+L hotkey.
function launchedAtLogin() {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  try {
    return !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
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
  for (const win of [overlayWindow, burstWindow, menuWindow, pickerWindow, liveWindow, panelWindow]) {
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

async function startLiveWatch() {
  const access = await ensureScreenRecordingAccess();
  if (!access.ok) {
    return { ok: false, error: "no_permission", ...access };
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

async function setLiveWatchEnabled(on) {
  const enabled = !!on;
  if (enabled) {
    const result = await startLiveWatch();
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
    width: 400,
    height: 520,
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
  return IS_MAC ? "⌘L chat" : "Ctrl+L chat";
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
          "This tab is a blank new-tab page, so there's nothing to click or type on yet. " +
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

// Prefer the Chrome Live Feed extension (works on macOS + Windows). Fall back
// to AppleScript tab discovery on macOS when the extension isn't connected.
async function getActiveBrowserTarget() {
  const ext = extensionBridge?.getSnapshot?.(12_000);
  if (ext?.url && /^https?:/i.test(ext.url)) {
    console.log(`[scrape] active tab via extension: ${ext.url}`);
    return {
      appName: "Google Chrome",
      url: ext.url,
      title: ext.title || "",
      source: "extension",
    };
  }

  if (!IS_MAC) {
    console.log("[scrape] no extension tab (Windows needs Chrome Live Feed for live page text)");
    return null;
  }

  // Two-step so the AppleScript always compiles:
  //   1) list running browsers (frontmost browser first when applicable),
  //   2) a literal `tell application "<name>"` reads its active tab's URL.
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

// Read LIVE rendered text from the active tab. Extension bridge first (cross-
// platform); AppleScript JS injection on macOS as fallback.
// Returns "title\n<body text>" or null.
async function getBrowserPageText(appName) {
  const ext = extensionBridge?.getSnapshot?.(12_000);
  if (ext?.text && ext.text.length > 40) {
    const title = String(ext.title || "").trim();
    const body = String(ext.text || "").trim();
    return title ? `${title}\n${body}` : body;
  }

  if (!IS_MAC) return null;

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
      // SSRF-safe: DNS + private-IP deny, re-check every redirect hop.
      res = await safeFetchMain(url, {
        signal: ctrl.signal,
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

// Parse YouTube timedtext payloads — json3 (preferred) or legacy XML.
function parseYouTubeCaptionBody(body) {
  const raw = String(body || "").trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.events)) {
      const text = j.events
        .map((e) => (e.segs || []).map((s) => s.utf8 || "").join(""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text;
    }
  } catch {
    /* not json3 — try XML below */
  }
  const parts = [...raw.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
    decodeHtmlEntities(m[1].replace(/<[^>]+>/g, " ")),
  );
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Same backend stack the in-app chat uses (captions → Whisper). Local in-tab
// / timedtext fetches often fail from the Electron shell (bot checks, empty
// session-bound URLs), which used to leave Glass with only the YouTube
// description — and the model would invent a "transcript fetch error".
async function fetchYouTubeTranscriptViaApi(videoId, { onStatus } = {}) {
  const token = await getAuthToken().catch(() => null);
  if (!token) {
    console.log("[scrape] yt api transcript skipped — no auth token");
    return null;
  }
  const headers = { Authorization: `Bearer ${token}` };
  const pull = async (qs, status) => {
    if (status) {
      try { onStatus?.(status); } catch { /* ignore */ }
    }
    const res = await fetch(
      `${API_BASE}/api/youtube/transcript?id=${encodeURIComponent(videoId)}${qs}`,
      { headers },
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.log(
        `[scrape] yt api transcript HTTP ${res.status}:`,
        errBody?.error || res.statusText,
      );
      return null;
    }
    return res.json().catch(() => null);
  };

  try {
    // Fast captions-only pass first (matches in-app chat).
    let data = await pull("&fast=1", "Reading the video transcript…");
    let text = String(data?.transcript || "").trim();
    let source = String(data?.source || "").toLowerCase();

    // Description-only is NOT a transcript — run Whisper like the web app does.
    if ((!text || source === "description_fallback") && source !== "whisper_full") {
      data = await pull(
        "&retryWhisper=1",
        "No captions found — transcribing the video audio…",
      );
      text = String(data?.transcript || "").trim();
      source = String(data?.source || "").toLowerCase();
    }

    // Still only a description → don't pretend we have spoken content.
    if (!text || source === "description_fallback") return null;

    return {
      title: "",
      text: text.slice(0, 16000),
      source,
    };
  } catch (e) {
    console.log("[scrape] yt api transcript error:", e?.message || e);
    return null;
  }
}

// Fetch a YouTube video's caption transcript. Tries the in-page method first
// (reliable, uses the user's session), then a local timedtext fetch, then the
// LYKN backend (captions + Whisper) — same path as in-app chat.
async function fetchYouTubeTranscript(videoId, appName, { onStatus } = {}) {
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

  if (Array.isArray(tracks) && tracks.length) {
    // Prefer a manually-authored English track, then any English, then the first.
    const pick =
      tracks.find((t) => /^en/i.test(t.languageCode || "") && t.kind !== "asr") ||
      tracks.find((t) => /^en/i.test(t.languageCode || "")) ||
      tracks[0];
    let baseUrl = pick && pick.baseUrl;
    if (baseUrl) {
      baseUrl = baseUrl.replace(/\\u0026/g, "&");
      if (baseUrl.indexOf("fmt=") < 0) {
        baseUrl += (baseUrl.indexOf("?") < 0 ? "?" : "&") + "fmt=json3";
      }
      try {
        const res = await fetch(baseUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        const text = parseYouTubeCaptionBody(await res.text());
        if (text) {
          console.log("[scrape] yt transcript via timedtext");
          return { title, text: text.slice(0, 16000) };
        }
      } catch {
        /* fall through to API */
      }
    }
  }

  // 3) LYKN backend — captions + Whisper. This is what makes in-app chat
  //    reliable; Glass was missing it, so caption failures became vague
  //    description-only answers ("transcript not accessible due to a fetch error").
  const viaApi = await fetchYouTubeTranscriptViaApi(videoId, { onStatus });
  if (viaApi && viaApi.text) {
    console.log(`[scrape] yt transcript via API (${viaApi.source || "unknown"})`);
    if (title && !viaApi.title) viaApi.title = title;
    return viaApi;
  }

  return title ? { title, text: "" } : null;
}

let overlayAskGeneration = 0;
let overlayAskAbort = null;
// The LYKN project the user is currently working in, sniffed from the active
// browser tab's URL (…/projects/<uuid>). We remember the last one seen so a
// conversational follow-up ("add a task", "put that on my calendar") — which
// deliberately skips the page scrape for speed — still scopes its writes to
// the project the user was just looking at, instead of landing unfiled.
let overlayActiveProjectId = null;

async function extractReactArtifactCodeFromHtml(html) {
  const m =
    /<script id="lykn-artifact-source" type="application\/json">([\s\S]*?)<\/script>/.exec(
      String(html || ""),
    );
  if (!m) return "";
  try {
    const code = JSON.parse(m[1]);
    return typeof code === "string" ? code : "";
  } catch {
    return "";
  }
}

async function extractReactArtifactCodeFromResult(result) {
  if (typeof result?.artifact_code === "string" && result.artifact_code.trim()) {
    return result.artifact_code;
  }
  const url = pickArtifactUrl(result);
  if (!url) return "";
  // Glass-local vault materialization.
  if (/^lykn-artifact:\/\//i.test(url)) {
    try {
      const key = new URL(url).hostname.replace(/\/$/, "");
      return extractReactArtifactCodeFromHtml(artifactHtmlCache.get(key) || "");
    } catch {
      return "";
    }
  }
  if (!/^https?:\/\//i.test(url)) return "";
  try {
    const res = await fetchOverlayMedia(url);
    if (!res || !res.ok) return "";
    return extractReactArtifactCodeFromHtml(await res.text());
  } catch {
    return "";
  }
}

// Pull a LYKN project UUID out of a workspace URL like
// "https://lykn.io/projects/<uuid>" or "http://localhost:5174/projects/<uuid>".
// Returns null for any other page (vault, settings, non-LYKN sites).
function extractLyknProjectId(url) {
  const m = /\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    String(url || ""),
  );
  return m ? m[1] : null;
}

function isRetryableStreamError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    /terminated|econnreset|econnrefused|socket hang up|network|fetch failed|aborted|unexpected end|broken pipe|reset by peer/.test(
      msg,
    ) && !/sign in|not authenticated|401|403|429/.test(msg)
  );
}

function humanizeStreamError(err, { forceImage = false } = {}) {
  const msg = String(err?.message || err || "").trim();
  // Never surface the old "trouble connecting" / "Request failed:" framing —
  // stalls during image gen looked like a dead network when the provider
  // was still working.
  if (
    /trouble connecting|didn't work — try again|Couldn't create that image/i.test(msg)
  ) {
    return forceImage
      ? "Couldn't create that image — try again in a moment."
      : "That didn't work — try again in a moment.";
  }
  if (/terminated|econnreset|socket hang up|broken pipe|reset by peer/i.test(msg)) {
    return forceImage
      ? "Couldn't create that image — try again in a moment."
      : "That didn't work — try again in a moment.";
  }
  if (/aborted/i.test(msg)) return "Request was cancelled.";
  // Only reached after the automatic refresh-and-retry also failed, so the
  // session really is gone (signed out elsewhere / refresh token revoked).
  if (/\(401\)/.test(msg)) {
    return "Your LYKN session expired. Open the main LYKN window to sign back in, then try again.";
  }
  // Monthly plan quota (checkAiUsageLimit) — keep the server's wording when
  // present; otherwise fall back to a clear upgrade nudge.
  if (/ai_limit_reached|used all .+ (AI )?requests this month/i.test(msg)) {
    if (/used all .+ requests this month/i.test(msg)) return msg;
    return "You've used all your LYKN AI requests this month. Upgrade your plan or add a top-up to continue.";
  }
  // Burst / provider / express-rate-limit 429 — not "you spammed us", just
  // temporarily unavailable. Don't retry-spam the same window.
  if (/\(429\)|rate limit|too many requests|temporarily unavailable/i.test(msg)) {
    return "LYKN is temporarily unavailable. Please wait a moment and try again.";
  }
  if (forceImage) return "Couldn't create that image — try again in a moment.";
  return msg || "That didn't work — try again in a moment.";
}

/** Turn a non-OK /api/ai/* response into an Error with a useful message. */
async function errorFromAiResponse(res) {
  let body = null;
  try {
    body = await res.clone().json();
  } catch {
    /* ignore parse errors */
  }
  if (res.status === 429) {
    if (body?.error === "ai_limit_reached") {
      return new Error(
        body.message ||
          "You've used all your LYKN AI requests this month. Upgrade your plan or add a top-up to continue.",
      );
    }
    return new Error("LYKN backend error (429).");
  }
  if (body?.message && typeof body.message === "string" && body.message.trim()) {
    return new Error(body.message.trim());
  }
  if (body?.error && typeof body.error === "string" && body.error.trim()) {
    return new Error(body.error.trim());
  }
  return new Error(`LYKN backend error (${res.status}).`);
}

/** Glass: only render vault Open/image cards when the user asked for saved stuff. */
function overlayUserWantsVaultSurface(userText, history) {
  const t = String(userText || "").trim();
  if (!t) return false;
  const saved =
    /\b(?:vault|saved|artifact|artifacts|my\s+(?:notes?|files?|pics?|pictures?|photos?|images?|docs?|documents?|links?|articles?|bookmarks?|artifacts?|stuff)|from\s+(?:my\s+)?(?:vault|notion|drive|gmail|readwise)|what\s+(?:have|did)\s+i\s+save|something\s+i\s+saved)\b/i.test(
      t,
    );
  const view =
    /\b(show|see|view|open|pull\s*(?:up|in)|bring\s*(?:up|in)|display|load|find|grab)\b/i.test(t);
  if (saved && view) return true;
  if (
    /\b(?:show|see|open|pull|bring|display|load)\b.{0,48}\b(?:my|the|that|those)\b.{0,24}\b(?:notes?|files?|pics?|pictures?|photos?|images?|docs?|vault|saved|links?|articles?|artifacts?)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(?:\s*(?:yes|yep|yeah|yup|sure|ok|okay|k|please|do\s*it|go(?:\s*ahead)?)\b[\s.,!]*)+$/i.test(t)) {
    const turns = Array.isArray(history) ? history : [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const m = turns[i];
      if (m?.role !== "assistant") continue;
      return /\b(pull\s*(?:them|those|it|up|in)|bring\s*(?:them|those|it|up|in)|want\s*me\s*to\s*(?:pull|show|bring)|in\s*(?:your\s*)?vault|saved\s*(?:note|notes|item|items|image|images))\b/i.test(
        String(m.content || ""),
      );
    }
  }
  return false;
}

async function readOverlayStreamResponse(res, send, opts = {}) {
  const allowVaultSurface = opts.allowVaultSurface === true;
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok || !res.body) {
    throw await errorFromAiResponse(res);
  }

  if (!ctype.includes("text/event-stream")) {
    const data = await res.json().catch(() => null);
    const raw = data?.response || data?.answer || data?.text || "";
    const answer = stripHiddenTags(raw);
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
          // Trim any unfinished "[[..." tail so a half-received tag never
          // flashes in the bubble (stripHiddenTags handles completed tags).
          send("lykn:answer-delta", {
            text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
          });
        } else if (typeof j.status === "string" && j.status.trim()) {
          send("lykn:answer-status", { status: j.status.trim() });
        } else if (j.tool_call && typeof j.tool_call === "object") {
          const tc = j.tool_call;
          maybeNotifyProjectsChangedFromTool(tc.name, tc.status, tc.result);
          if (tc.status === "running") {
            send("lykn:answer-status", { status: toolStatusLabel(tc.name) });
          } else if (
            tc.status === "done" &&
            /generate_image$/.test(String(tc.name || "")) &&
            tc.result &&
            typeof tc.result.image_url === "string" &&
            /^https?:\/\//.test(tc.result.image_url)
          ) {
            // Surface the generated image inline: append it as a standalone
            // markdown image line, which the overlay's renderer turns into an
            // <img> card. Living in `accumulated` means it also persists into
            // the saved session like any other answer text.
            accumulated += `\n\n![Generated image](${tc.result.image_url})\n\n`;
            lastOverlayVaultImage = {
              url: tc.result.image_url,
              title: "Generated image",
            };
            send("lykn:answer-delta", {
              text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
            });
            // Do not auto-vault — user must Save or ask the AI to keep it.
          } else if (
            tc.status === "done" &&
            /build_react_artifact$/.test(String(tc.name || "")) &&
            tc.result
          ) {
            // Build mode result: append a lykn_artifact marker line, which the
            // overlay's renderer turns into a live iframe preview card with an
            // "Open" affordance. Underscore form survives brand capitalization
            // (lykn_* is excluded); hyphen form is normalized in stripHiddenTags.
            const title = String(tc.result.title || "Interactive artifact")
              .replace(/[\]\n\r]/g, " ")
              .trim();
            const fileUrl = pickArtifactUrl(tc.result);
            if (fileUrl) {
              accumulated += `\n\n![lykn_artifact:${title}](${fileUrl})\n\n`;
              send("lykn:answer-delta", {
                text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
              });
            }
            // Do not auto-vault — user must Save or ask the AI to keep it.
            // Cache source for the next refine turn (surgical edits).
            void extractReactArtifactCodeFromResult(tc.result).then((code) => {
              if (code && code.trim()) {
                lastOverlayReactArtifact = {
                  toolName: "lykn_build_react_artifact",
                  title,
                  code,
                };
              }
            });
          } else if (
            tc.status === "done" &&
            /render_video$/.test(String(tc.name || "")) &&
            tc.result &&
            typeof tc.result.file_url === "string" &&
            /^https?:\/\//.test(tc.result.file_url)
          ) {
            // Remotion render result: a lykn_video marker line becomes an
            // inline <video> card in the overlay's renderer (playable +
            // downloadable), persisted in the session like images/artifacts.
            const title = String(tc.result.title || "Video")
              .replace(/[\]\n\r]/g, " ")
              .trim();
            accumulated += `\n\n![lykn_video:${title}](${tc.result.file_url})\n\n`;
            send("lykn:answer-delta", {
              text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
            });
            // Do not auto-vault — user must Save or ask the AI to keep it.
          } else if (
            tc.status === "done" &&
            /generate_chart$/.test(String(tc.name || "")) &&
            tc.result &&
            typeof tc.result.chart_url === "string" &&
            /^https?:\/\//.test(tc.result.chart_url)
          ) {
            // Standalone chart tool (not Build mode): inject a clean markdown
            // image so Glass renders it — models often mangle the huge
            // QuickChart URL when pasting it themselves.
            const title = String(tc.result.title || "Chart")
              .replace(/[\]\n\r]/g, " ")
              .trim() || "Chart";
            accumulated = accumulated
              .replace(/\n*!\[([^\]]*)\]\(https?:\/\/(?:www\.)?quickchart\.io[^\s)]+\)\n*/gi, "\n")
              .replace(/^!.*(?:quickchart\.io|%22%2C%22data|bkg=white).*$/gim, "");
            accumulated += `\n\n![${title}](${tc.result.chart_url})\n\n`;
            send("lykn:answer-delta", {
              text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
            });
          } else if (
            tc.status === "done" &&
            /generate_diagram$/.test(String(tc.name || "")) &&
            tc.result
          ) {
            // Mermaid fences don't render in Glass — show the Kroki preview
            // image instead (same pattern as main-chat diagram cards).
            const preview =
              (typeof tc.result.preview_url === "string" && tc.result.preview_url) ||
              (typeof tc.result.kroki_url === "string" && tc.result.kroki_url) ||
              "";
            if (/^https?:\/\//.test(preview)) {
              const title = String(tc.result.title || "Diagram")
                .replace(/[\]\n\r]/g, " ")
                .trim() || "Diagram";
              accumulated = accumulated
                .replace(/\n*!\[([^\]]*)\]\(https?:\/\/(?:[\w.-]+\.)?kroki\.io[^\s)]+\)\n*/gi, "\n")
                .replace(/```mermaid[\s\S]*?```/gi, "");
              accumulated += `\n\n![${title}](${preview})\n\n`;
              send("lykn:answer-delta", {
                text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
              });
            }
          } else if (
            tc.status === "done" &&
            tc.result &&
            /(build_template|build_spreadsheet|manage_file|process_image)$/.test(
              String(tc.name || ""),
            )
          ) {
            // Other capability artifacts may not get an inline preview card in
            // the overlay yet. Vault persistence is explicit (Save / ask AI).
          } else if (
            tc.status === "done" &&
            tc.result &&
            /(^lykn_loadNeuron$|loadNeuron$)/.test(String(tc.name || ""))
          ) {
            // Vault pull-up only when the user asked for saved stuff this turn
            // (or confirmed an offer). Blocks random loadNeuron on normal chat.
            if (allowVaultSurface) {
              const markers = await overlayVaultMarkersFromToolResult(tc.name, tc.result);
              if (markers) {
                accumulated += markers;
                send("lykn:answer-delta", {
                  text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
                });
              }
            }
          } else if (
            tc.status === "done" &&
            tc.result &&
            /(^lykn_loadNeurons$|loadNeurons$)/.test(String(tc.name || ""))
          ) {
            if (allowVaultSurface) {
              const markers = await overlayVaultMarkersFromToolResult(tc.name, tc.result);
              if (markers) {
                accumulated += markers;
                send("lykn:answer-delta", {
                  text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
                });
              }
            }
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
  // Also trim from the final text: if the stream died mid-tag, the unfinished
  // "[[..." fragment must not persist in the saved answer.
  return trimPartialControlTagTail(stripHiddenTags(accumulated));
}

function overlayMessageLooksScreenRelated(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /\b(on (my|the) screen|what('| i)?s on|what do you see|do you see|are you seeing|this (page|site|tab|website|article|video|error|message|screen|one|problem|question)|look at|read (this|the|my)|what am i|explain (this|it)|summarize (this|it)|the (question|quiz|problem|error|answer)|fix (this|it)|help me with this|can you see|what is (this|that|on)|what are (these|those)|why (is|does|are)|how (do|does|can)|where (is|are)|who (is|are)|tell me about (this|the|what)|describe (this|the|what)|click|submit|solve (this|it|the)|answer (this|the|it)|is (this|that|it) (right|correct|wrong|good|true|false)|which (one|answer|option|choice)|what should i (pick|choose|select|do)|(next|this) one)\b/.test(
    t,
  );
}

// Much NARROWER than overlayMessageLooksScreenRelated (which is broad on
// purpose for the "don't skip the screen" decision): this matches only when
// the message clearly needs the actual PIXELS — the user is asking what we
// can see, or asking to be pointed at / walked through something in the UI
// in front of them. Used to force the screenshot back on for text-rich pages,
// which otherwise go text-only for speed — without a screenshot the model
// can't answer visual / layout questions.
function overlayMessageWantsVisualGuidance(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  // "do/can you see...", "are you seeing my screen", "look at this".
  if (/\b(do|can|are) you see(ing)?\b/.test(t)) return true;
  if (/\b(on (my|the) screen|look at (my|the|this)|screenshot)\b/.test(t)) return true;
  // Naming a concrete UI element ("the run button", "that settings icon") is
  // about LAYOUT — the page text can't answer where it is or whether it shows.
  if (
    /\b(button|icon|tab|toolbar|menu|sidebar|panel|modal|dialog|field|input|toggle|checkbox|dropdown|slider)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // "I don't see / can't find ..." — the user is lost in the UI.
  if (/\b(don'?t|can'?t|cannot|do not|unable to) (see|find|locate|spot)\b/.test(t)) return true;
  // Pointing / navigation: the user wants to be SHOWN a spot in the UI.
  if (
    /\b(show me|point (me|it|to|at)|guide me|walk me through|where (is|are|do|does|can|should|it)|which one|click|press|tap)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // A how-to anchored to something they're looking at: "how do I run this
  // migration", "how can I enable that setting".
  if (/\bhow (do|can|should) i\b/.test(t) && /\b(this|that|these|those|here|it)\b/.test(t)) {
    return true;
  }
  return false;
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
      // Remember the LYKN project the user is viewing so writes (tasks,
      // events, project state) scope to it — including on later follow-ups
      // that skip this scrape.
      const sniffedProjectId = extractLyknProjectId(target.url);
      if (sniffedProjectId) overlayActiveProjectId = sniffedProjectId;

      let title = "";
      let text = "";
      let kind = "page";
      let videoTranscriptMissing = false;

      // YouTube (or other video): the spoken content isn't in the page text,
      // so fetch the caption transcript instead (in-tab → timedtext → LYKN API
      // with Whisper). No hard 12s race — Whisper can legitimately take longer
      // and aborting early was leaving Glass with only the video description.
      const ytId = parseYouTubeId(target.url);
      if (ytId) {
        send("lykn:answer-status", { status: "Reading the video transcript…" });
        const yt = await fetchYouTubeTranscript(ytId, target.appName, {
          onStatus: (status) => {
            if (!superseded()) send("lykn:answer-status", { status });
          },
        });
        if (superseded()) return { pageContext: null, pastPageSection: "" };
        if (yt && yt.text) {
          title = yt.title || "";
          text = yt.text;
          kind = "video";
          console.log(`[scrape] OK (yt transcript) — "${title || ytId}" (${text.length} chars)`);
        } else {
          console.log("[scrape] no transcript/captions available for video", ytId);
          if (yt && yt.title) title = yt.title;
          videoTranscriptMissing = true;
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
          title = (title || (nl > 0 ? live.slice(0, nl).trim() : "")).trim();
          text = (nl > 0 ? live.slice(nl + 1) : live)
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          console.log(`[scrape] OK (live DOM) — "${title || "(no title)"}" (${text.length} chars)`);
        } else {
          // 2) Fall back to a plain HTTP fetch (works for non-bot-blocked pages).
          const page = await scrapePageText(target.url);
          if (page && page.text) {
            title = title || page.title;
            text = page.text;
            console.log(`[scrape] OK (http) — "${title || "(no title)"}" (${text.length} chars)`);
          }
        }
        if (text) {
          pageContext = {
            url: target.url,
            title,
            text: text.slice(0, 12000),
            // So the prompt can say "we only have the page/description" instead
            // of the model inventing a fake "transcript fetch error".
            ...(videoTranscriptMissing ? { videoTranscriptMissing: true } : {}),
          };
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

async function streamScreenAnswer(event, { text, history, attachments, forceImage, buildMode }) {
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
  let imageAtts = atts.filter((a) => a && a.kind === "image" && a.dataUrl);
  const textAtts = atts.filter((a) => a && a.kind === "text" && a.text);
  // Image mode with no attach: use the last vault/generated image shown in Glass
  // so the user can enter Image mode and edit that thing directly.
  if (
    forceImage &&
    imageAtts.length === 0 &&
    lastOverlayVaultImage &&
    /^https?:\/\//i.test(String(lastOverlayVaultImage.url || ""))
  ) {
    try {
      const res = await safeFetchMain(lastOverlayVaultImage.url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const mime =
          (res.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
        if (buf.length && /^image\//i.test(mime)) {
          const name =
            `${String(lastOverlayVaultImage.title || "image")
              .replace(/[^\w.-]+/g, "-")
              .slice(0, 40) || "image"}.png`;
          imageAtts = [
            {
              kind: "image",
              name,
              dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
            },
          ];
        }
      }
    } catch {
      /* keep empty — Image mode still works as a fresh generate */
    }
  }
  const conversationFollowUp = overlayMessageIsConversationFollowUp(text, history);
  const skipScreenContext =
    conversationFollowUp && imageAtts.length === 0 && textAtts.length === 0;
  const liveWatchSummary = !skipScreenContext ? getFreshLiveWatchSummary(4000) : "";

  // Screen Recording: trigger the macOS Allow dialog when still not-determined
  // instead of only telling the user to dig through Privacy settings.
  const needScreen = !skipScreenContext && imageAtts.length === 0;
  if (needScreen) {
    const access = await ensureScreenRecordingAccess();
    if (!access.ok) {
      send("lykn:answer-error", {
        message: screenRecordingDeniedMessage(access),
      });
      return;
    }
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
      message: "Sign in to LYKN first. Open the main LYKN window and log in, then try again.",
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
  // A message that clearly wants VISUAL help ("do you see this?", "how do I
  // run this?", "where do I click?") must keep the pixels even when the page
  // is text-rich — the text-only fast path leaves the model blind to layout.
  const wantsVisualGuidance =
    !skipScreenContext && overlayMessageWantsVisualGuidance(text);
  // Live Watch already ran a recent vision pass — skip the screenshot upload when
  // there's no scraped page text (games, native apps) to stay fast.
  let attachScreenshot =
    !!dataURL &&
    !hasVideoTranscript &&
    (wantsVisualGuidance || (!hasRichPageText && !liveWatchSummary));
  // Image mode with an attached image: the attachment IS the subject being
  // generated from — a stray screen capture riding along just confuses the
  // model about which image the user means (and could bleed screen content
  // into the generation). Drop it; the attachment carries the pixels.
  if (forceImage && imageAtts.length) attachScreenshot = false;
  if (hasRichPageText && dataURL && !attachScreenshot) {
    console.log(
      `[overlay-ask] text-rich page (${pageContext.text.length} chars) — dropping screenshot, staying on fast model`,
    );
  } else if (hasRichPageText && attachScreenshot) {
    console.log(
      `[overlay-ask] text-rich page (${pageContext.text.length} chars) but message wants visual guidance — keeping screenshot`,
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
    "paragraph when bullets or headers would read better." +
    "\n\nSimple formatting does NOT need Build mode: for a standalone chart or " +
    "graph, call lykn_generate_chart (Glass shows the image automatically — do " +
    "NOT invent or paste QuickChart URLs). For a flowchart/diagram, call " +
    "lykn_generate_diagram. Lists, headers, and bold are just Markdown in your " +
    "reply. Reserve Build mode for live coded apps / dashboards / interactive tools.";
  if (!hasVideoTranscript) {
    // Tools are on for this turn (see useTools below), which includes live web
    // search. Without this note the screen-first framing above makes the model
    // claim it "can't browse the web" instead of just calling the tool.
    prompt +=
      "\n\nYou CAN search the live web: when the user asks about current events, " +
      "news, prices, scores, weather, latest AI/LLM models, model comparisons, " +
      "or anything requiring up-to-date information beyond their screen, call " +
      "lykn_web_search (and lykn_web_fetch to read a specific page) BEFORE " +
      "answering — never invent a stale model landscape from memory. Never say " +
      "you can't browse the web or suggest connecting external tools for it.";
  }
  if (attachScreenshot) {
    // Describe UI locations in words only — do NOT claim to highlight, glow,
    // or light up anything on the user's screen (that feature was removed).
    prompt +=
      "\n\nWhen the user asks where something is on screen, describe its location " +
      "in plain language (e.g. 'top-right of the toolbar, blue button labeled Run'). " +
      "Do NOT say you have highlighted, lit up, glowed, or ringed anything on their " +
      "screen, and do NOT emit [[HIGHLIGHT: …]] tags.";
  }
  // Three-bucket memory — Glass should feel like it knows the person, not a
  // generic screen Q&A bot. Server also injects WHO_I_AM / WHAT_IM_ON /
  // WHAT_IVE_SAVED; this keeps the overlay prompt aligned when those land.
  if (!skipScreenContext) {
    prompt +=
      "\n\nHow you know this person (use lightly — one personal anchor max unless they ask): " +
      "WHO THEY ARE = preferences/facts/beliefs in context; " +
      "WHAT THEY'RE ON = connect this screen to the best-fit project when clear; " +
      "WHAT THEY'VE SAVED = Vault — pull only when they need something saved or one hit clearly helps. " +
      "Keep learning them: if they reveal or contradict something about themselves, remember/update it. " +
      "Answer the screen first; don't brief them with everything you know.";
  }
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
  } else if (pageContext && pageContext.videoTranscriptMissing) {
    prompt +=
      "\n\nFor context, the user is watching a YouTube video but LYKN could not " +
      "retrieve its spoken transcript (no captions and audio transcription unavailable). " +
      "You only have the page text / description below — NOT the spoken content. " +
      "Do NOT invent a transcript, do NOT claim a 'fetch error', and do NOT pretend " +
      "you watched the video. Say plainly that the transcript isn't available and " +
      "answer from the title/description only, or ask them to try again.\n" +
      `URL: ${pageContext.url}\n` +
      (pageContext.title ? `Video title: ${pageContext.title}\n` : "") +
      `--- PAGE TEXT (not a transcript) ---\n${pageContext.text}\n--- END PAGE TEXT ---`;
  } else if (pageContext) {
    // When the screenshot rides along (visual-guidance asks), the image is the
    // primary context — cap the scraped text hard so the prompt stays small
    // and time-to-first-token stays low. Text-only asks get the full scrape.
    const pageBody = attachScreenshot
      ? String(pageContext.text || "").slice(0, 3000)
      : pageContext.text;
    prompt += attachScreenshot
      ? "\n\nFor context, the user has this web page open — the SCREENSHOT is your " +
        "primary view of it; the excerpt below is just supporting text.\n" +
        `URL: ${pageContext.url}\n` +
        (pageContext.title ? `Page title: ${pageContext.title}\n` : "") +
        `--- PAGE TEXT (EXCERPT) ---\n${pageBody}\n--- END PAGE TEXT ---`
      : "\n\nFor context, the user currently has this web page open and its full text " +
        "was scraped below. If their question is about this page/article, use this text " +
        "as the primary, authoritative source (it's more complete than the screenshot) " +
        "and answer directly without asking for a link. If their question is NOT about " +
        "this page, ignore it and just answer normally.\n" +
        `URL: ${pageContext.url}\n` +
        (pageContext.title ? `Page title: ${pageContext.title}\n` : "") +
        `--- PAGE CONTENT ---\n${pageBody}\n--- END PAGE CONTENT ---`;
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
  // Per-turn attachment metadata (same shape the web composer sends): tells
  // the server which imageUrls entries are USER ATTACHMENTS vs the screen
  // capture, so tools like lykn_generate_image can use the attached images as
  // pixel references without ever treating the screenshot as one.
  const attachmentIndexOffset = attachScreenshot ? 1 : 0;
  const attachmentsMeta = imageAtts.map((a, i) => ({
    type: "image",
    name: a.name || "image",
    imageIndex: attachmentIndexOffset + i,
  }));

  const body = {
    model: "lykn",
    intent: "ask",
    text: String(text || "").slice(0, 4000),
    prompt,
    imageUrls,
    // Keep tools available on follow-ups too. skipScreenContext only means "no
    // fresh screen/page context needed" — it must NOT strip the agent loop, or
    // action follow-ups ("add a task", "put that on my calendar", "mark it
    // done") silently no-op while the model claims success. The backend's
    // casual-turn gate still turns tools off for pure chit-chat.
    useTools: !hasVideoTranscript,
    // Web search: explicit asks OR live-freshness (latest models / news /
    // prices / landscape charts) arm Serper pre-fetch. Everything else stays
    // skipWebSearch: true for latency — the model can still call
    // lykn_web_search via the agent loop when needed.
    ...(overlayShouldForceWebSearch(String(text || ""))
      ? { skipWebSearch: false, forceWebSearch: true }
      : { skipWebSearch: true }),
    // Image mode (menu → "Create an image"): the server forces the
    // lykn_generate_image tool (GPT Image 2), same as the web app's "+" →
    // Generate image. Only ever set by an explicit user toggle.
    ...(forceImage ? { forceImage: true, useTools: true } : {}),
    // Build mode: refine the last artifact (session build or vault pull-up)
    // when we have source; otherwise force a fresh React artifact. Only
    // armed while the composer is in Build mode — normal chat must not
    // keep patching the last artifact.
    ...(() => {
      if (!buildMode) return {};
      const redesign = OVERLAY_REDESIGN_INTENT_RE.test(String(text || ""));
      const cached =
        lastOverlayReactArtifact &&
        typeof lastOverlayReactArtifact.code === "string" &&
        lastOverlayReactArtifact.code.trim()
          ? lastOverlayReactArtifact
          : null;
      if (cached && !redesign) {
        return { activeArtifact: cached, useTools: true };
      }
      return { forceArtifact: true, artifactType: "webapp", useTools: true };
    })(),
    overlayAsk: true,
    // Scope writes to the project the user is working in (sniffed from the
    // active browser tab). Lets "add this task to my project" land on the
    // project they're looking at instead of unfiled.
    ...(overlayActiveProjectId ? { projectId: overlayActiveProjectId } : {}),
    ...(attachmentsMeta.length ? { attachments: attachmentsMeta } : {}),
    ...(Array.isArray(history) && history.length ? { conversation: history.slice(-8) } : {}),
  };

  try {
    let lastErr = null;
    let bearerToken = token;
    let authRetried = false;
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
            Authorization: `Bearer ${bearerToken}`,
          },
          body: JSON.stringify(body),
          signal: askSignal,
        });
        // 401 = the token we grabbed pre-flight was already dead (revoked, or
        // expired between read and send). Force one real refresh through the
        // app's Supabase client and retry — this is recoverable, not an error.
        if (res.status === 401 && !authRetried) {
          authRetried = true;
          // Drop the in-memory cache so forceRefresh can't hand us the same
          // dead JWT again — we need the live Supabase client to mint a new one.
          cachedAuthToken = null;
          cachedAuthTokenExpMs = 0;
          const fresh = await getAuthToken({ forceRefresh: true }).catch(() => null);
          if (superseded()) return;
          if (fresh) {
            bearerToken = fresh;
            attempt -= 1; // don't burn a network-retry slot on the auth retry
            continue;
          }
          // Refresh really failed (signed out / refresh token revoked).
          throw new Error("LYKN backend error (401).");
        }
        const accumulated = await readOverlayStreamResponse(res, send, {
          allowVaultSurface: overlayUserWantsVaultSurface(text, history),
        });
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
    send("lykn:answer-error", {
      message: humanizeStreamError(lastErr, { forceImage: !!forceImage }),
    });
  } catch (e) {
    if (superseded()) return;
    send("lykn:answer-error", {
      message: humanizeStreamError(e, { forceImage: !!forceImage }),
    });
  }
}

// Capture the current screen and ask the vision model for a short text
// description. Voice Mode can't receive images, so we feed this summary into the
// live agent as contextual text — giving voice the same "sees your screen"
// ability the typed overlay chat has.
async function captureScreenDescription() {
  const liveSummary = getFreshLiveWatchSummary(8000);
  if (liveSummary) return { text: liveSummary, source: "live_watch" };

  const access = await ensureScreenRecordingAccess();
  console.log("[screen-context] capture status:", access.status);
  if (!access.ok) return { error: "no_permission", ...access };
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
  const access = await ensureScreenRecordingAccess();
  if (!access.ok) return { ok: false, error: "no_permission", ...access };
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

// Persist raw bytes to the vault via /api/vault/save-file. Best-effort.
async function saveBufferToVault(buf, { title, filename, mime, token } = {}) {
  if (!buf || !buf.length) return false;
  try {
    const authToken = token || (await getAuthToken());
    if (!authToken) return false;
    let name =
      String(filename || "")
        .replace(/[/\\:*?"<>|]+/g, "-")
        .replace(/^\.+/, "")
        .slice(0, 120) || "artifact";
    const contentType =
      String(mime || "").split(";")[0].trim() || "application/octet-stream";
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
      const ext = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "text/html": ".html",
        "application/pdf": ".pdf",
        "text/plain": ".txt",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
      }[contentType.toLowerCase()] || "";
      name += ext;
    }
    const form = new FormData();
    form.append("file", new Blob([buf], { type: contentType }), name);
    form.append(
      "title",
      String(title || "").trim() || name.replace(/\.[a-z0-9]{1,8}$/i, ""),
    );
    form.append("source", "ai_artifact");
    const vaultRes = await fetch(`${API_BASE}/api/vault/save-file`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    });
    const vaultData = await vaultRes.json().catch(() => null);
    return !!(vaultRes.ok && vaultData && vaultData.ok);
  } catch {
    return false;
  }
}

// Fetch a generated artifact URL and persist it to the vault. Used when the
// overlay finishes an image / React build / video tool so artifacts land in
// the vault without requiring a manual Download click. Best-effort.
async function saveUrlToVault(url, { title, filename, token } = {}) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    const authToken = token || (await getAuthToken());
    if (!authToken) return false;
    const res = await safeFetchMain(u);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return false;

    let name = String(filename || "").trim();
    if (!name) {
      const cd = res.headers.get("content-disposition") || "";
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      if (m) {
        try {
          name = decodeURIComponent(m[1]);
        } catch {
          name = m[1];
        }
      }
    }
    if (!name) {
      try {
        name = decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
      } catch {
        /* fall through */
      }
    }
    const mime =
      (res.headers.get("content-type") || "").split(";")[0].trim() ||
      "application/octet-stream";
    return saveBufferToVault(buf, { title, filename: name, mime, token: authToken });
  } catch {
    return false;
  }
}

/** Pick the best downloadable URL from a capability tool result. */
function pickArtifactUrl(result) {
  if (!result || typeof result !== "object") return "";
  for (const key of ["file_url", "image_url", "download_url", "primary_download"]) {
    const v = result[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  if (Array.isArray(result.download_links)) {
    for (const link of result.download_links) {
      const v = link && link.url;
      if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    }
  }
  return "";
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
  ipcMain.on("lykn:open-vault", (_e, noteId) => {
    const id = String(noteId || "").trim();
    const url = id
      ? `${APP_ORIGIN}/vault?note=${encodeURIComponent(id)}`
      : `${APP_ORIGIN}/vault`;
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    // Always navigate — createMainWindow loads the default app URL first.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url);
    mainWindow.show();
    mainWindow.focus();
  });
  ipcMain.on("lykn:open-synthesis", () => {
    const url = `${APP_ORIGIN}/synthesis-layer`;
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url);
    mainWindow.show();
    mainWindow.focus();
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
  // ── Detached three-dot menu window ────────────────────────────────────
  ipcMain.on("lykn:menu-set", (_e, { open } = {}) => {
    if (open) showMenuWindow();
    else hideMenuWindow();
  });
  ipcMain.on("lykn:menu-close", () => hideMenuWindow());
  // The menu card reports its content height (menu vs past-chats view).
  ipcMain.on("lykn:menu-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0) {
      menuHeight = h;
      positionMenuWindow();
    }
  });
  // ── Detached side-panel picker window ─────────────────────────────────
  ipcMain.on("lykn:picker-set", (_e, { open } = {}) => {
    if (open) showPickerWindow();
    else hidePickerWindow();
  });
  ipcMain.on("lykn:picker-close", () => hidePickerWindow());
  // The picker card reports its content height (varies with option count).
  ipcMain.on("lykn:picker-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0) {
      pickerHeight = h;
      positionPickerWindow();
    }
  });
  // A view was picked — apply it in the overlay renderer, which owns the
  // side-panel state and rendering.
  ipcMain.on("lykn:picker-select", (_e, { id } = {}) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents
      .executeJavaScript(
        `window.__lyknPickerSelect && window.__lyknPickerSelect(${JSON.stringify(
          String(id || ""),
        )});`,
        true,
      )
      .catch(() => {});
  });
  // Snapshot of the picker options (labels, counts, active view) from the overlay.
  ipcMain.handle("lykn:picker-state", async () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return null;
    try {
      return await overlayWindow.webContents.executeJavaScript(
        "window.__lyknPickerState ? window.__lyknPickerState() : null",
        true,
      );
    } catch (_) {
      return null;
    }
  });
  // ── Detached live meeting notes window ────────────────────────────────
  ipcMain.on("lykn:live-set", (_e, { open } = {}) => {
    liveCardOpen = !!open;
    if (liveCardOpen) showLiveWindow();
    else {
      lastLiveState = null;
      hideLiveWindow();
    }
  });
  // The overlay renderer pushes render snapshots (head state + pane HTML);
  // we cache the latest so a freshly (re)created window paints immediately.
  ipcMain.on("lykn:live-push", (_e, state) => {
    lastLiveState = state || null;
    sendLiveState();
  });
  // ── Detached side-panel content window ─────────────────────────────────
  ipcMain.on("lykn:panel-set", (_e, { open } = {}) => {
    panelCardOpen = !!open;
    if (panelCardOpen) showPanelWindow();
    else {
      lastPanelState = null;
      hidePanelWindow();
    }
  });
  // The overlay renderer pushes render snapshots (title + section HTML);
  // we cache the latest so a freshly (re)created window paints immediately.
  ipcMain.on("lykn:panel-push", (_e, state) => {
    lastPanelState = state || null;
    const w = Math.round(Number(state && state.width) || 0);
    if (w > 0 && w !== panelWidth) {
      panelWidth = w;
      positionPanelWindow();
      positionMenuWindow();
    }
    sendPanelState();
  });
  // The panel card reports its content height (varies with section count).
  ipcMain.on("lykn:panel-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0 && h !== panelHeight) {
      panelHeight = h;
      positionPanelWindow();
    }
  });
  // User actions in the panel card (open link, ask follow-up, install
  // extension, close) run in the OVERLAY renderer, which owns the state.
  ipcMain.on("lykn:panel-cmd", (_e, { name, arg } = {}) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents
      .executeJavaScript(
        `window.__lyknPanelCmd && window.__lyknPanelCmd(${JSON.stringify(
          String(name || ""),
        )}, ${JSON.stringify(arg == null ? null : arg)});`,
        true,
      )
      .catch(() => {});
  });
  // User actions in the live card (tabs, close, copy, save, ask) run in the
  // OVERLAY renderer, which owns the audio streams + transcript state.
  ipcMain.on("lykn:live-cmd", (_e, { name, arg } = {}) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents
      .executeJavaScript(
        `window.__lyknLiveCmd && window.__lyknLiveCmd(${JSON.stringify(
          String(name || ""),
        )}, ${JSON.stringify(arg == null ? null : arg)});`,
        true,
      )
      .catch(() => {});
  });
  // Menu actions run in the OVERLAY renderer, which owns the real feature
  // logic (voice, live notes, watch, stealth, attach, snip, sessions…).
  ipcMain.on("lykn:menu-cmd", (_e, { name, arg } = {}) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents
      .executeJavaScript(
        `window.__lyknMenuCmd && window.__lyknMenuCmd(${JSON.stringify(
          String(name || ""),
        )}, ${JSON.stringify(arg == null ? null : arg)});`,
        true,
      )
      .catch(() => {});
  });
  // Snapshot of the overlay's toggle states so the menu badges stay in sync.
  ipcMain.handle("lykn:menu-state", async () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return null;
    try {
      return await overlayWindow.webContents.executeJavaScript(
        "window.__lyknMenuState ? window.__lyknMenuState() : null",
        true,
      );
    } catch (_) {
      return null;
    }
  });
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
  ipcMain.handle("lykn:get-night-briefs", async () => {
    try {
      const token = await getAuthToken();
      if (!token) return { ok: false, briefs: [] };
      const res = await fetch(`${API_BASE}/api/night-shift/briefs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, briefs: [], error: data?.error || res.status };
      return { ok: true, briefs: Array.isArray(data.briefs) ? data.briefs : [] };
    } catch (e) {
      return { ok: false, briefs: [], error: e?.message || "fetch_failed" };
    }
  });
  ipcMain.on("lykn:move-by", (_e, { dx, dy }) => {
    if (!overlayWindow) return;
    const b = overlayWindow.getBounds();
    const nx = b.x + Math.round(dx || 0);
    const ny = b.y + Math.round(dy || 0);
    overlayProgrammaticMove = true;
    setFloatingBounds(overlayWindow, { x: nx, y: ny, width: b.width, height: b.height });
    overlayProgrammaticMove = false;
    overlayUserPositioned = true;
    overlayAnchorLeft = nx;
    overlayAnchorBottomY = ny + b.height;
    positionMenuWindow();
    positionPickerWindow();
    positionLiveWindow();
    positionPanelWindow();
  });
  ipcMain.on("lykn:ask", (event, args) => {
    streamScreenAnswer(event, args || {});
  });

  // Save a note (task summary, meeting notes, snippet, etc.) into the user's LYKN vault.
  ipcMain.handle("lykn:save-vault-note", async (_e, { title, content, tags, folder, source } = {}) => {
    try {
      const body = String(content || "").trim();
      if (!body) return { ok: false, error: "empty" };
      const token = await getAuthToken();
      if (!token) return { ok: false, error: "no_auth" };
      const payload = {
        title: String(title || "").slice(0, 200),
        content: body.slice(0, 60000),
        tags: Array.isArray(tags) ? tags.slice(0, 12).map((t) => String(t).slice(0, 32)) : undefined,
        folder: folder ? String(folder).slice(0, 80) : undefined,
      };
      // Overlay-authored notes (meetings, browser tasks) stamp a stable
      // `source` so the vault can render them as formatted docs — not
      // plain "Quick Note" cards.
      const src = typeof source === "string" ? source.trim().slice(0, 64) : "";
      if (src) payload.source = src;
      const res = await fetch(`${API_BASE}/api/v1/synthesis/vault`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
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

  // Snip-to-attach: drag-select a region and return it as an image attachment.
  // macOS uses the native screencapture crosshair; Windows (and fallback) uses
  // our fullscreen snip overlay. The glass bar is hidden so it isn't in the shot.
  ipcMain.handle("lykn:snip-screen", async () => {
    if (IS_MAC) {
      const outPath = path.join(app.getPath("temp"), `lykn-snip-${crypto.randomUUID()}.png`);
      try {
        await withOverlayHiddenForClick(
          () =>
            new Promise((resolve) => {
              // -i: interactive region select, -x: no camera sound.
              execFile("screencapture", ["-i", "-x", outPath], () => resolve());
            }),
        );
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
    }
    return withOverlayHiddenForClick(() => captureInteractiveSnip());
  });

  // Snip overlay IPC (Windows region picker).
  ipcMain.on("lykn:snip-commit", (_e, rect) => {
    if (typeof snipResolver === "function") snipResolver(rect || null);
  });
  ipcMain.on("lykn:snip-cancel", () => {
    if (typeof snipResolver === "function") snipResolver(null);
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
      maybeNotifyProjectsChangedFromTool(name, "done", data);
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

  // Make sure the OS has granted microphone access before the renderer records.
  ipcMain.handle("lykn:ensure-mic", async () => {
    try {
      const status = microphoneStatus();
      if (status === "granted") return true;
      if (IS_MAC) {
        if (status === "not-determined") {
          return await systemPreferences.askForMediaAccess("microphone");
        }
        openMicrophoneSettings();
        return false;
      }
      // Windows: Chromium prompts on getUserMedia; if previously denied, open Settings.
      if (status === "denied" || status === "restricted") {
        openMicrophoneSettings();
        return false;
      }
      return true;
    } catch {
      return !IS_MAC;
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

  // Live meeting notes — VAD-endpointed utterances from the overlay. fast=1
  // returns raw ASR text immediately (the overlay polishes asynchronously),
  // and gpt-4o-mini-transcribe beats whisper-1 on both speed and accuracy
  // for short conversational clips.
  ipcMain.handle("lykn:meeting-chunk", async (_e, { audio, mimeType, prompt, context } = {}) => {
    try {
      const token = await getAuthToken();
      if (!token) return { error: "Sign in to LYKN first." };

      const buf = Buffer.from(audio);
      if (!buf || buf.length < 800) return { text: "" };

      const mime = mimeType || "audio/webm";
      const ext = /wav/i.test(mime) ? "wav" : "webm";
      const fd = new FormData();
      fd.append("audio", new Blob([buf], { type: mime }), `meeting.${ext}`);
      fd.append("model", "gpt-4o-mini-transcribe");
      fd.append("fast", "1");
      fd.append("language", "en");
      // A longer rolling tail biases the ASR toward in-domain vocabulary
      // (names, jargon) — the single biggest accuracy lever Whisper exposes.
      if (prompt) fd.append("prompt", String(prompt).split(/\s+/).slice(-40).join(" "));
      if (context) fd.append("context", String(context).slice(-600));

      const res = await fetch(`${API_BASE}/api/ai/meeting-chunk`, {
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

  // Cluely-style live assist — the overlay streams the rolling transcript
  // after each utterance; the backend decides if this moment deserves a help
  // card (question answer, company brief, fact check, suggested reply) and
  // may run a live web search mid-sentence to compose it.
  ipcMain.handle("lykn:live-assist", async (_e, { transcript, shown } = {}) => {
    try {
      const token = await getAuthToken();
      if (!token) return { insight: null };
      const res = await fetch(`${API_BASE}/api/ai/live-assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          transcript: String(transcript || "").slice(-2400),
          shown: Array.isArray(shown) ? shown.slice(-10) : [],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { insight: null };
      return { insight: data?.insight || null };
    } catch (_) {
      return { insight: null };
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
    // Mint a one-time state when opening desktop-auth so lykn://auth can't
    // inject an unbound session from another local app.
    let target = u;
    try {
      const parsed = new URL(u);
      if (
        (parsed.pathname === "/desktop-auth" || parsed.pathname.endsWith("/desktop-auth")) &&
        (parsed.origin === APP_ORIGIN || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
      ) {
        target = mintDesktopAuthUrl(parsed.toString());
      }
    } catch {
      /* open as-is through the scheme allowlist */
    }
    openExternalSafe(target);
  });

  // Download a generated file (image mode picture, Build-mode artifact) into
  // ~/Downloads and reveal it in Finder. The overlay page is file:// so anchor
  // `download` attributes don't work on the cross-origin proxy URLs — the
  // main process fetches and writes the file instead. The same bytes are also
  // saved into the user's Vault (best-effort) so the artifact survives past
  // the signed URL's expiry.
  ipcMain.handle("lykn:download-file", async (_e, { url, name, title } = {}) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && !/^lykn-artifact:\/\//i.test(u)) {
      return { ok: false, error: "bad_url" };
    }
    try {
      let buf;
      let mime = "application/octet-stream";
      let filename = String(name || "").trim();

      if (/^lykn-artifact:\/\//i.test(u)) {
        const key = new URL(u).hostname.replace(/\/$/, "");
        const html = artifactHtmlCache.get(key);
        if (!html) return { ok: false, error: "expired" };
        buf = Buffer.from(html, "utf8");
        mime = "text/html";
      } else {
        const res = await fetchOverlayMedia(u);
        if (!res || !res.ok) return { ok: false, error: `http_${res?.status || 0}` };
        buf = Buffer.from(await res.arrayBuffer());
        mime = (res.headers.get("content-type") || "").split(";")[0].trim() || mime;
        if (!filename) {
          const cd = res.headers.get("content-disposition") || "";
          const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
          if (m) {
            try {
              filename = decodeURIComponent(m[1]);
            } catch {
              filename = m[1];
            }
          }
        }
        if (!filename) {
          try {
            filename = decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
          } catch {
            /* fall through */
          }
        }
      }

      filename =
        filename.replace(/[/\\:*?"<>|]+/g, "-").replace(/^\.+/, "").slice(0, 120) || "download";
      if (!/\.[a-z0-9]{1,8}$/i.test(filename)) {
        const ext = {
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/webp": ".webp",
          "image/gif": ".gif",
          "image/svg+xml": ".svg",
          "text/html": ".html",
          "application/pdf": ".pdf",
          "text/plain": ".txt",
          "video/mp4": ".mp4",
          "video/webm": ".webm",
        }[mime.toLowerCase()] || "";
        filename += ext;
      }

      const dir = app.getPath("downloads");
      const dot = filename.lastIndexOf(".");
      const base = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : "";
      let target = path.join(dir, filename);
      for (let i = 2; fsSync.existsSync(target); i += 1) {
        target = path.join(dir, `${base} (${i})${ext}`);
      }
      await fs.writeFile(target, buf);
      shell.showItemInFolder(target);

      // Vault copy — best-effort: a vault failure (offline, signed out, cap
      // reached) must not fail the local download the user asked for.
      let savedToVault = false;
      try {
        const token = await getAuthToken();
        if (token) {
          const form = new FormData();
          form.append("file", new Blob([buf], { type: mime }), filename);
          form.append("title", String(title || "").trim() || filename.replace(/\.[a-z0-9]{1,8}$/i, ""));
          const vaultRes = await fetch(`${API_BASE}/api/vault/save-file`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: form,
          });
          const vaultData = await vaultRes.json().catch(() => null);
          savedToVault = !!(vaultRes.ok && vaultData && vaultData.ok);
        }
      } catch {
        savedToVault = false;
      }

      return { ok: true, path: target, savedToVault };
    } catch (err) {
      return { ok: false, error: err?.message || "download_failed" };
    }
  });

  // Extract the raw JSX source of a Build-mode artifact. The runner HTML
  // embeds it in a <script id="lykn-artifact-source" type="application/json">
  // block, so we fetch the artifact URL here (main process — no CORS) and
  // hand the decoded component source back to the overlay's Code view.
  ipcMain.handle("lykn:artifact-code", async (_e, { url } = {}) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && !/^lykn-artifact:\/\//i.test(u)) {
      return { ok: false, error: "bad_url" };
    }
    try {
      let html = "";
      if (/^lykn-artifact:\/\//i.test(u)) {
        const key = new URL(u).hostname.replace(/\/$/, "");
        html = artifactHtmlCache.get(key) || "";
        if (!html) return { ok: false, error: "expired" };
      } else {
        const res = await fetchOverlayMedia(u);
        if (!res || !res.ok) return { ok: false, error: `http_${res?.status || 0}` };
        html = await res.text();
      }
      const code = await extractReactArtifactCodeFromHtml(html);
      if (!code) return { ok: false, error: "no_source_block" };
      return { ok: true, code };
    } catch (err) {
      return { ok: false, error: err?.message || "fetch_failed" };
    }
  });

  // Seed Build-mode refine from a vault/generated artifact URL (Edit button).
  ipcMain.handle("lykn:seed-artifact-from-url", async (_e, { url, title } = {}) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && !/^lykn-artifact:\/\//i.test(u)) {
      return { ok: false, error: "bad_url" };
    }
    try {
      const code = await extractReactArtifactCodeFromResult({
        file_url: u,
        title: String(title || "Artifact"),
      });
      if (!code || !String(code).trim()) {
        return { ok: false, error: "no_source_block" };
      }
      lastOverlayReactArtifact = {
        toolName: "lykn_build_react_artifact",
        title: String(title || "Artifact").replace(/\s+/g, " ").trim() || "Artifact",
        code: String(code),
      };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || "seed_failed" };
    }
  });

  // Fetch an image (or any allowlisted media URL) as a data URL for Image mode.
  ipcMain.handle("lykn:fetch-as-data-url", async (_e, { url } = {}) => {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) {
      return { ok: false, error: "bad_url" };
    }
    if (/^data:image\//i.test(u)) return { ok: true, dataUrl: u };
    try {
      const res = await safeFetchMain(u);
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, error: "empty" };
      const mime =
        (res.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
      if (!/^image\//i.test(mime)) return { ok: false, error: "not_image" };
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
    } catch (err) {
      return { ok: false, error: err?.message || "fetch_failed" };
    }
  });

  // Cluely-style suggestions after an answer: follow-up questions + real source
  // links looked up on the web. Best-effort: returns empty on any failure.
  // Browser control for the ⌘L overlay — scan interactables + plan/execute via
  // AppleScript JavaScript in the user's active browser tab.
  ipcMain.handle("lykn:browser-capability", async () => {
    // Click/type control still needs Apple Events (macOS). Page *reading* works
    // on Windows via the Chrome Live Feed extension.
    if (!IS_MAC) {
      const target = await getActiveBrowserTarget();
      const connected = !!extensionBridge?.isConnected?.();
      if (target?.url) {
        return {
          ok: false,
          error: "control_mac_only",
          browser: target.appName,
          url: target.url,
          title: target.title || "",
          reading: true,
          message:
            "LYKN can read this tab via Chrome Live Feed. Clicking and typing in the browser is macOS-only for now — ask about what's on screen instead.",
        };
      }
      return {
        ok: false,
        error: connected ? "no_browser" : "needs_extension",
        message: connected
          ? "Open an https:// page in Chrome/Edge, then try again."
          : "Install Chrome Live Feed (tray → Open LYKN, or the Live Feed button) so LYKN can read your active tab. Browser click-control is macOS-only for now.",
      };
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
    if (!IS_MAC) {
      return fail("control_mac_only", {
        message:
          "Browser click-control is macOS-only for now. Install Chrome Live Feed to let LYKN read your tab, or ask about what's on your screen.",
      });
    }
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
          : "Click Run once. LYKN will read the page, act step by step, and verify as it goes.");
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
        message: "Browser control is already running. Wait for it to finish.",
      };
    }
    if (!IS_MAC) {
      return {
        ok: false,
        error: "control_mac_only",
        results: [],
        message:
          "Browser click-control is macOS-only for now. LYKN can still read your tab via Chrome Live Feed — ask about the page instead.",
      };
    }
    const browser = String(appName || "").trim();
    if (!browser) {
      return {
        ok: false,
        error: "no_browser",
        results: [],
        message: "Missing browser name. Plan again from Control this page.",
      };
    }
    // Hard allowlist: `browser` is interpolated verbatim into AppleScript
    // (`tell application "<browser>" …`), so a renderer-supplied name containing
    // quotes/newlines could break out and run arbitrary osascript. Only exact
    // matches from our own detected-browser list are ever allowed.
    if (!BROWSER_APP_NAMES.includes(browser)) {
      return {
        ok: false,
        error: "unsupported_browser",
        results: [],
        message: "Unsupported browser. Plan again from Control this page.",
      };
    }
    const pageUrl = String(url || "").trim();
    const goal = String(intent || "").trim();

    if (goal) {
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
            ? "Restart npm run server (or dev:overlay). API route missing."
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
            ? String(data.explanation || "").trim() || "Planning failed. Could not determine the next step."
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
            ? out.explanation || "Done. Task completed in your browser."
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
  ipcMain.handle("lykn:meeting-notes", async (_e, { transcript, previousNotes } = {}) => {
    const empty = {
      summary: "",
      keyPoints: [],
      actionItems: [],
      questionsToAsk: [],
      suggestions: [],
      topics: [],
    };
    const t = String(transcript || "").trim();
    if (t.length < 40) return empty;
    try {
      const token = await getAuthToken();
      if (!token) return empty;
      const res = await fetch(`${API_BASE}/api/ai/meeting-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transcript: t, previousNotes: previousNotes || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return empty;
      return {
        summary: String(data.summary || "").trim(),
        keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [],
        actionItems: Array.isArray(data.actionItems) ? data.actionItems : [],
        questionsToAsk: Array.isArray(data.questionsToAsk) ? data.questionsToAsk : [],
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
        topics: Array.isArray(data.topics) ? data.topics : [],
      };
    } catch (_) {
      return empty;
    }
  });
}

function buildAppMenu() {
  // macOS: standard app/edit/window menu. Windows: File + Edit so Alt shortcuts
  // and copy/paste still work with autoHideMenuBar.
  const loginItem = {
    label: "Start LYKN at Login",
    type: "checkbox",
    checked: isLoginItemEnabled(),
    enabled: app.isPackaged,
    click: (item) => setLoginItemEnabled(item.checked),
  };
  const viewMenu = {
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
  };
  const helpMenu = {
    role: "help",
    submenu: [
      { label: "Set Up LYKN / Permissions…", click: () => createOnboardingWindow() },
    ],
  };

  /** @type {Electron.MenuItemConstructorOptions[]} */
  let template;
  if (IS_MAC) {
    template = [
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          { type: "separator" },
          loginItem,
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          // ⌘Q closes the windows but LYKN keeps running in the menu bar (the
          // before-quit hook reroutes it); the labels make that explicit.
          { role: "quit", label: "Close LYKN (Keeps Running in Menu Bar)" },
          {
            label: "Quit LYKN Completely",
            accelerator: "Command+Alt+Q",
            click: () => quitForReal(),
          },
        ],
      },
      { role: "editMenu" },
      viewMenu,
      { role: "windowMenu" },
      helpMenu,
    ];
  } else {
    template = [
      {
        label: "File",
        submenu: [
          loginItem,
          { type: "separator" },
          // Alt+F4 / File→Close hides windows; tray + Ctrl+L stay armed.
          {
            label: "Close Window (Keeps Running in Tray)",
            accelerator: "Alt+F4",
            click: () => {
              try {
                if (overlayWindow && overlayWindow.isVisible()) hideOverlay();
              } catch (_) { /* ignore */ }
              try {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
              } catch (_) { /* ignore */ }
            },
          },
          {
            label: "Quit LYKN Completely",
            accelerator: "Control+Shift+Q",
            click: () => quitForReal(),
          },
        ],
      },
      { role: "editMenu" },
      viewMenu,
      helpMenu,
    ];
  }
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
    width: 580,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Set up LYKN",
    backgroundColor: "#0b0b0f",
    titleBarStyle: IS_MAC ? "hiddenInset" : "default",
    autoHideMenuBar: IS_WIN,
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
  // Signed-in check: the main window holds the Supabase session (localStorage),
  // so a live token read is the source of truth.
  ipcMain.handle("lykn:onboarding-auth-status", async () => {
    const token = await getAuthToken();
    return !!token;
  });

  ipcMain.on("lykn:onboarding-open-sign-in", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    mainWindow.show();
    mainWindow.focus();
    // Keep the walkthrough visible next to the sign-in window so the user
    // comes back to it naturally once the auth badge flips.
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.showInactive();
    }
  });

  ipcMain.handle("lykn:onboarding-mic-status", () => microphoneStatus());

  ipcMain.handle("lykn:onboarding-request-mic", async () => {
    try {
      const status = microphoneStatus();
      if (status === "granted") return true;
      if (IS_MAC) {
        if (status === "not-determined") {
          return await systemPreferences.askForMediaAccess("microphone");
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
      screenProbeCache = dataUrl ? "granted" : "denied";
      return screenProbeCache;
    } catch {
      screenProbeCache = "denied";
      return "denied";
    }
  });

  ipcMain.on("lykn:onboarding-open-screen-settings", () => {
    openScreenPrivacySettings();
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

  ipcMain.handle("lykn:onboarding-request-accessibility", () => {
    if (!IS_MAC) return "granted";
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
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
          writeBridgeConfig: (dir) => extensionBridge?.writeBridgeConfigToExtensionDir?.(dir),
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
      // Shown in install UI so store-installed extensions can be paired manually.
      token: extensionBridge?.getToken?.() || "",
    };
  });
  ipcMain.on("lykn:extension-install-close", () => {
    if (extensionInstallWindow && !extensionInstallWindow.isDestroyed()) {
      extensionInstallWindow.close();
    }
  });
}

// Synchronous version lookup for the preload bridge. `app.getVersion()` reads
// the packaged app's Info.plist / package.json version — unlike
// process.env.npm_package_version, which only exists under `npm run` and made
// window.lykn.version null in production builds.
ipcMain.on("lykn:get-version", (event) => {
  try {
    event.returnValue = app.getVersion();
  } catch {
    event.returnValue = null;
  }
});

app.on("second-instance", (_event, commandLine) => {
  // Windows deep-link while already running: lykn:// arrives on argv.
  const deepLink = findLyknUrlInArgv(commandLine);
  if (deepLink) {
    handleAuthDeepLink(deepLink);
    return;
  }
  // Re-opening LYKN while it's already running in the background (e.g. after
  // a silent login launch) should surface the main window, not do nothing.
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
  // electron-updater's property is `autoDownload` (a previous typo set the
  // nonexistent `autoDownloadAll`, silently relying on the default).
  autoUpdater.autoDownload = true;
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
    const ver = info && info.version ? ` (${info.version})` : "";
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: "Restart to update LYKN.",
      detail: `A new version${ver} is ready. Restart the app to install it.`,
    });
    if (response === 0) {
      // Installing an update is a legitimate exit — don't reroute it to
      // background mode.
      allowQuit = true;
      autoUpdater.quitAndInstall();
    }
  });
  // Check on launch, then every 6 hours while the app stays open.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

  app.whenReady().then(() => {
  // Serve vault HTML artifacts to Glass iframes from memory (see
  // resolveVaultHtmlDisplayUrl). Avoids localhost file-proxy iframe failures.
  try {
    protocol.handle("lykn-artifact", (request) => {
      try {
        const key = new URL(request.url).hostname.replace(/\/$/, "");
        const html = artifactHtmlCache.get(key);
        if (!html) {
          return new Response("Artifact preview expired — pull it in again.", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      } catch {
        return new Response("Bad artifact URL", { status: 400 });
      }
    });
  } catch (e) {
    console.warn("[overlay-vault] lykn-artifact protocol:", e?.message || e);
  }

  // Dock icon: dock.setIcon draws the image literally (no system squircle
  // mask), so we always use the pre-rounded asset. Packaged builds also set
  // this so Finder/Dock never show the full-bleed square from a bad cache or
  // Electron path. electron-builder mac.icon is icon-rounded.png for the same reason.
  if (IS_MAC && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, "resources/icon-rounded.png"));
    } catch {
      /* cosmetic only */
    }
  }

  // Present a clean Chrome user agent. Google (and some other providers) reject
  // OAuth sign-in from any UA advertising "Electron" with disallowed_useragent,
  // so we strip the Electron/app tokens and look like plain desktop Chrome.
  // NOTE: Google now detects Electron beyond the UA string ("This browser or
  // app may not be secure"), so Google sign-in no longer happens in-window at
  // all — see the lykn://auth deep-link flow. The clean UA stays for the other
  // in-app auth providers and general site compatibility.
  const chromeVer = process.versions.chrome;
  app.userAgentFallback = IS_WIN
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`
    : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;

  // Claim the lykn:// scheme so the browser-based Google sign-in can deep-link
  // the session back into the app. Packaged builds also declare the scheme via
  // electron-builder "protocols". On Windows in dev we must pass the script
  // path so the protocol handler relaunches this project, not bare Electron.
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("lykn", process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    } else {
      app.setAsDefaultProtocolClient("lykn");
    }
  } catch (_) {
    /* registration is best-effort */
  }

  installPermissionHandler();
  setupSystemAudioCapture();
  buildAppMenu();
  registerOverlayIpc();
  registerOnboardingIpc();
  registerExtensionInstallIpc();
  extensionBridge = startExtensionBridge({
    userDataPath: app.getPath("userData"),
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
  // Keep the unpacked extension copy's bridge-config.json in sync on every boot
  // so Live Feed auth works after token rotation / first launch.
  try {
    const extDir = getUserExtensionDir(app.getPath("userData"));
    extensionBridge?.writeBridgeConfigToExtensionDir?.(extDir);
  } catch (_) {
    /* best-effort */
  }
  setupLaunchAtLogin();

  // When macOS starts LYKN at login, stay silent in the background: no main
  // window, just the armed ⌘+L hotkey. The dock icon / ⌘+L bring the UI up.
  // Boot a hidden auth keeper so Glass can refresh the stored session without
  // the user opening the main window first.
  const backgroundLaunch = launchedAtLogin();
  if (!backgroundLaunch) createMainWindow();
  else ensureAuthKeeper();
  // Menu-bar icon: present for the whole app lifetime, on every launch mode —
  // it's the always-there affordance for pulling up the overlay chat.
  createTray();
  createOverlayWindow();
  // Pre-create + warm the full-screen glass/burst window now so the FIRST ⌘+L
  // doesn't hitch while it loads + rasterizes its blurred layers and noise.
  createBurstWindow();
  registerGlobalHotkey();
  initAutoUpdate();
  if (isLiveWatchEnabled()) void startLiveWatch();

  // First launch goes straight to the web app's login screen — no automatic
  // permissions walkthrough. It stays reachable from the tray menu
  // ("Set Up LYKN / Permissions…") for when the user is ready.
  // Glass asks trigger ensureScreenRecordingAccess() so the macOS Allow dialog
  // still appears the first time they need the screen, even if they skipped setup.

  // Menu-bar-app mode: no main window (silent login launch, or the user
  // closed it) → no Dock icon. The tray + ⌘L are the way back in.
  updateDockVisibility();

  // Never block a system shutdown/restart: flip the quit flag the moment the
  // OS announces it so the before-quit reroute below stands down.
  powerMonitor.on("shutdown", () => {
    allowQuit = true;
  });

  app.on("activate", () => {
    // The hidden overlay/burst windows always exist, so check the main window
    // itself — otherwise the dock icon does nothing after a background launch.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

// ⌘Q / Alt+F4 / app.quit() → dismiss the windows but stay resident in the
// tray, so the tray icon and ⌘/Ctrl+L keep working. Real exits (tray/app-menu
// "Quit LYKN Completely", update install, OS shutdown) set allowQuit first.
app.on("before-quit", (event) => {
  if (allowQuit) return;
  event.preventDefault();
  try {
    if (overlayWindow && overlayWindow.isVisible()) hideOverlay();
  } catch (_) { /* keep going */ }
  // Hide the main window — do NOT destroy it. Destroying drops the live
  // Supabase session client and the next Glass ask 401s with "session
  // expired" until the user reopens the window and signs in again.
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  } catch (_) { /* keep going */ }
  updateDockVisibility();
});

app.on("will-quit", () => {
  stopLiveWatch();
  extensionBridge?.stop?.();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  // Tray app on every platform: stay alive so the hotkey + tray keep working.
  // Real exits go through quitForReal() / allowQuit.
});
