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
  WebContentsView,
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
  session,
  Notification,
  powerMonitor,
  nativeTheme,
  protocol,
  net: electronNet,
} = require("electron");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

// Intel-Mac GPUs hit a Chromium compositor bug where CSS backdrop-filter's
// IOSurface texture share silently fails, so every blurred region renders as
// a fully transparent hole (same class of bug tracked across Electron apps,
// e.g. openai/codex#23458 — GPU flags do not reliably fix it). Native window
// vibrancy is macOS-side and unaffected. The shell therefore strips
// page-level backdrop-filter from every LYKN-owned document on those
// machines, and the web app compensates with a near-opaque tint
// (html.lykn-glass-fallback in index.css, flagged through the preload).
// LYKN_GLASS_FALLBACK=1|0 forces the mode on any machine for testing.
const GLASS_FALLBACK =
  process.env.LYKN_GLASS_FALLBACK != null
    ? process.env.LYKN_GLASS_FALLBACK === "1"
    : IS_MAC && process.arch === "x64";

// Let the welcome walkthrough play its reveal sound without a prior click —
// Chromium otherwise mutes un-gestured audio (the video is muted; the sound
// rides a separate <audio> element).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Chromium's popup blocker has nowhere to report itself here: a real browser
// shows a blocked-popup marker in the omnibox, and we have no such UI, so a
// blocked window.open is indistinguishable from a dead button. Sign-in flows
// walk right into it — the ones that do any async work (a token fetch, a config
// call) before opening lose the user gesture Chromium requires and get dropped
// silently. Nothing gets to open unchecked regardless: every window.open in the
// agent browser goes through setWindowOpenHandler, which decides what opens,
// where, and in which session (see wireAgentBrowserViewEvents).
app.commandLine.appendSwitch("disable-popup-blocking");
// Google's sign-in library reaches for FedCM (navigator.credentials.get with an
// identity provider) before it will fall back to opening a window. FedCM needs
// an account chooser drawn by the browser itself, which Electron has no
// implementation of and no API for — so the call never resolves, the library
// never gets to its popup, and the button does nothing at all with nothing
// logged. Turning the feature off is what makes it visible to the library as
// unavailable, so it takes the window.open path we do support.
app.commandLine.appendSwitch("disable-features", "FedCm");
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
  // Locally stored vault media. The window loads a remote origin and so cannot
  // read file://; this is how an <img> or <video> gets at bytes on disk.
  require("./localStore/blobProtocol.cjs").schemeRegistration(),
  // Files on this Mac, so the Files browser can show them in LYKN rather than
  // handing them off to another app.
  require("./macFileProtocol.cjs").schemeRegistration(),
  // Apps LYKN built for the user. Registered `standard` + `secure` so each app
  // gets a real, trustworthy origin — that is what makes IndexedDB and
  // localStorage work inside a generated app at all, and it is what isolates
  // one app's storage from another's (the app id is the hostname).
  require("./appProtocol.cjs").schemeRegistration(),
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
const http = require("node:http");
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
const ownedBrowserAct = require("./ownedBrowserAct.cjs");
const agentRecentVisits = require("./agentRecentVisits.cjs");
const localSystem = require("./localSystem.cjs");
const macFiles = require("./macFiles.cjs");
const localStore = require("./localStore/index.cjs");
const appDock = require("./appDock.cjs");
const chromeSync = require("./chromeSync.cjs");
const { createAgentRuntime } = require("./agentRuntime.cjs");
const agentTabIds = require("./agentTabIds.cjs");
const { decideChatRoute } = require("./chatAgentRoute.cjs");
const { buildDiagnosticsReport } = require("./diagnostics.cjs");
const {
  wrapReportAsStageHtml,
  titleFromMarkdown: titleFromStageMarkdown,
} = require("./markdownToStageHtml.cjs");
const { screenDiffRatio, textSimilarity } = require("../lib/browserScreen.cjs");
const { startExtensionBridge } = require("./extensionBridge.cjs");
const {
  installExtensionOneClick,
  revealExtensionInstallFolder,
  getExtensionInstallMode,
  getUserExtensionDir,
  prepareExtensionInstallDir,
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

// Intel-Mac glass fallback (see GLASS_FALLBACK above): kill page-level
// backdrop-filter in every document WE ship — the app itself plus the
// overlay-family html (bar, menu, picker, live, stage chrome…). External
// pages in the agent browser are left alone; how a website degrades on this
// GPU is that site's business, and rewriting its CSS would break real pages.
if (GLASS_FALLBACK) {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("dom-ready", () => {
      let owned = false;
      try {
        const url = contents.getURL() || "";
        owned = url.startsWith("file:") || new URL(url).origin === APP_ORIGIN;
      } catch (_) {
        /* about:blank etc. — skip */
      }
      if (!owned) return;
      contents
        .insertCSS(
          "*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }",
        )
        .catch(() => {});
    });
  });
}

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

// Shared with server via lib/artifactBuildIntent.cjs — when false and we have
// a cached Build artifact, Glass sends activeArtifact and does NOT force a
// ground-up rebuild. Includes "follow this style" / "like this style".
const {
  isRedesignAsk: overlayIsRedesignAsk,
} = require("../lib/artifactBuildIntent.cjs");
const OVERLAY_REDESIGN_INTENT_RE = {
  test: (text) => overlayIsRedesignAsk(text),
};

// Allow Cmd+Q / single-instance behaviour to feel native.
// The losing instance must exit immediately: registering before-quit below
// would call preventDefault and leave a zombie process that users Force Quit.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Say so before leaving. A crash can leave a stale Singleton* in userData,
  // and then every relaunch lands here and exits with no window and no output,
  // which reads as "the app is broken" rather than "another instance owns it".
  console.error(
    "[LYKN] another instance already holds the lock — exiting. If no LYKN window " +
      "is open, delete Singleton* from the userData folder and relaunch.",
  );
  app.quit();
  process.exit(0);
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
// After a successful accept we clear one-time desktop_state immediately so
// concurrent HTTP POSTs can't double-accept. Keep the last tokens briefly so
// a second "Open LYKN" / pagehide retry with the SAME tokens still works.
/** @type {{ access_token: string, refresh_token: string, expiresAt: number } | null} */
let lastAcceptedAuthHandoff = null;
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

// Loopback auth handoff: after Google finishes in the system browser,
// /desktop-auth POSTs tokens to 127.0.0.1 so the Mac app can sign in without
// requiring a click on "Open LYKN". lykn://auth remains a manual fallback.
// Also used in unpackaged/local shells so we never steal lykn:// from the
// installed LYKN.app (Launch Services would relaunch Electron.app with no main).
const AUTH_HANDOFF_PORT = Number(process.env.LYKN_DEV_AUTH_PORT || 38472);
// A second LYKN can already own the default port — typically the installed
// LYKN.app while a dev shell runs. Posting tokens to a port we don't own hands
// them to the OTHER instance, which rejects them as bad_state (it never minted
// that desktop_state), so each instance needs a port of its own.
const AUTH_HANDOFF_PORT_CANDIDATES = [
  AUTH_HANDOFF_PORT,
  AUTH_HANDOFF_PORT + 10,
  AUTH_HANDOFF_PORT + 11,
  AUTH_HANDOFF_PORT + 12,
];
/** @type {import('node:http').Server | null} */
let authHandoffServer = null;
// 0 until listen() succeeds — mintDesktopAuthUrl only advertises a port we own.
let authHandoffPort = 0;

function authHandoffAllowedOrigin(origin) {
  const o = String(origin || "");
  if (!o) return "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return o;
  if (/^https:\/\/(www\.)?lykn\.io$/i.test(o)) return o;
  try {
    const appOrigin = new URL(APP_URL).origin;
    if (o === appOrigin) return o;
  } catch {
    /* ignore */
  }
  return "";
}

function isReplayOfLastAuthHandoff(access_token, refresh_token) {
  return Boolean(
    lastAcceptedAuthHandoff &&
      lastAcceptedAuthHandoff.expiresAt > Date.now() &&
      lastAcceptedAuthHandoff.access_token === access_token &&
      lastAcceptedAuthHandoff.refresh_token === refresh_token,
  );
}

function deliverAuthTokensToRenderer(access_token, refresh_token) {
  pendingAuthTokens = { access_token, refresh_token };
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else if (welcomeGateActive) {
    // First-launch walkthrough owns the screen: hand the session to the
    // hidden window but let the walkthrough decide when to reveal it.
    flushPendingAuthTokens();
    // Google round-trips through the system browser — tell the walkthrough
    // the session landed so it can advance, and take the screen back.
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.webContents.send("lykn:welcome-google-signed-in");
      welcomeWindow.show();
      welcomeWindow.focus();
    }
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    flushPendingAuthTokens();
  }
  try {
    app.focus({ steal: true });
  } catch (_) {
    /* best-effort */
  }
}

function acceptAuthHandoffPayload(body) {
  const access_token = String(body?.access_token || "");
  const refresh_token = String(body?.refresh_token || "");
  const state = String(body?.state || "");
  if (!access_token || !refresh_token) {
    return { ok: false, error: "missing_tokens" };
  }
  if (!isReplayOfLastAuthHandoff(access_token, refresh_token)) {
    const expected = loadDesktopAuthState();
    if (!expected?.state || !state || expected.state !== state) {
      console.warn("[auth] localhost handoff rejected — missing or mismatched desktop_state");
      return { ok: false, error: "bad_state" };
    }
    // Consume one-time state before any window work so a concurrent POST
    // with the same mint can't both pass the state check.
    clearDesktopAuthState();
    lastAcceptedAuthHandoff = {
      access_token,
      refresh_token,
      expiresAt: Date.now() + DESKTOP_AUTH_STATE_TTL_MS,
    };
  }
  deliverAuthTokensToRenderer(access_token, refresh_token);
  return { ok: true };
}

function startAuthHandoffServer(attempt = 0) {
  if (authHandoffServer) return;
  const port = AUTH_HANDOFF_PORT_CANDIDATES[attempt];
  if (!port) {
    console.warn(
      "[auth] every localhost handoff port is in use — Google sign-in falls back to lykn://auth",
    );
    return;
  }
  let bound = false;
  try {
    const server = http.createServer((req, res) => {
      const origin = String(req.headers.origin || "");
      const allowOrigin = authHandoffAllowedOrigin(origin);
      if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        res.setHeader("Vary", "Origin");
      }
      // Chrome Private Network Access: https://lykn.io → http://127.0.0.1
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") {
        res.writeHead(allowOrigin ? 204 : 403);
        res.end();
        return;
      }

      let pathname = "/";
      try {
        pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      } catch {
        /* keep / */
      }
      if (req.method !== "POST" || pathname !== "/auth-handoff") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      if (!allowOrigin) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad_origin" }));
        return;
      }

      const chunks = [];
      req.on("data", (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length > 64 * 1024) req.destroy();
      });
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad_json" }));
          return;
        }
        const result = acceptAuthHandoffPayload(body);
        res.writeHead(result.ok ? 200 : 403, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      });
    });
    server.on("error", (err) => {
      authHandoffServer = null;
      authHandoffPort = 0;
      if (!bound && err?.code === "EADDRINUSE") {
        startAuthHandoffServer(attempt + 1);
        return;
      }
      console.warn("[auth] localhost handoff server error:", err?.message || err);
    });
    server.listen(port, "127.0.0.1", () => {
      bound = true;
      authHandoffPort = port;
      console.log(`[auth] localhost handoff listening on http://127.0.0.1:${port}/auth-handoff`);
    });
    authHandoffServer = server;
  } catch (err) {
    console.warn("[auth] failed to start localhost handoff server:", err?.message || err);
    authHandoffServer = null;
    authHandoffPort = 0;
  }
}

function mintDesktopAuthUrl(baseUrl) {
  // The instance that blocked us at launch may have quit since — try again so
  // this round-trip can use loopback instead of the lykn:// fallback.
  if (!authHandoffPort) startAuthHandoffServer();
  const state = crypto.randomBytes(24).toString("base64url");
  // New Google round-trip — don't accept replays from a prior attempt.
  lastAcceptedAuthHandoff = null;
  persistDesktopAuthState({ state, expiresAt: Date.now() + DESKTOP_AUTH_STATE_TTL_MS });
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("desktop_state", state);
    // Prefer loopback POST so /desktop-auth can auto-handoff without a click.
    // lykn://auth stays available as the Open LYKN button fallback.
    if (authHandoffPort) u.searchParams.set("handoff_port", String(authHandoffPort));
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
  // State is consumed at accept-time; this is a safety clear for older paths.
  clearDesktopAuthState();
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

  if (!isReplayOfLastAuthHandoff(access_token, refresh_token)) {
    const expected = loadDesktopAuthState();
    if (!expected?.state || !state || expected.state !== state) {
      console.warn("[auth] lykn://auth rejected — missing or mismatched desktop_state");
      // Still raise the app so the user isn't left staring at a dead browser tab
      // when Launch Services delivered the link to us but state was already used.
      if (app.isReady() && mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      return;
    }
    // Consume immediately; same-token retries use lastAcceptedAuthHandoff.
    clearDesktopAuthState();
    lastAcceptedAuthHandoff = {
      access_token,
      refresh_token,
      expiresAt: Date.now() + DESKTOP_AUTH_STATE_TTL_MS,
    };
  }
  // Cold start via the deep link: open-url can fire before whenReady, and
  // BrowserWindow can't be created yet. whenReady's createMainWindow (deep-link
  // launches are not login launches) will flush the tokens on did-finish-load.
  deliverAuthTokensToRenderer(access_token, refresh_token);
}

// macOS delivers custom-scheme URLs here (both cold start and while running).
// Register synchronously at startup (not inside whenReady) so cold-start
// lykn://auth opens aren't missed.
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

const LYKN_PROTOCOL = "lykn";
const LYKN_BUNDLE_ID = "ai.lykn.desktop";

function findPackagedLyknApp() {
  const candidates = [
    "/Applications/LYKN.app",
    path.join(__dirname, "../release/mac-universal/LYKN.app"),
    path.join(__dirname, "../release/mac/LYKN.app"),
    path.join(__dirname, "../release/mac-arm64/LYKN.app"),
    path.join(__dirname, "../release/mac-x64/LYKN.app"),
  ];
  for (const p of candidates) {
    try {
      if (fsSync.existsSync(p)) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Best-effort: make Launch Services prefer LYKN.app for lykn:// (macOS). */
function preferPackagedLyknUrlHandler() {
  if (!IS_MAC) return;
  const packaged = findPackagedLyknApp();
  if (!packaged) return;
  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  try {
    execFile(lsregister, ["-f", packaged], { timeout: 10000 }, () => {});
  } catch {
    /* best-effort */
  }
  // setAsDefaultProtocolClient only binds the *current* process bundle, so from
  // unpackaged Electron we must set ai.lykn.desktop explicitly.
  const swift = [
    "import CoreServices",
    `let s = LSSetDefaultHandlerForURLScheme("${LYKN_PROTOCOL}" as CFString, "${LYKN_BUNDLE_ID}" as CFString)`,
    "exit(s == noErr ? 0 : 1)",
  ].join("\n");
  try {
    execFile("swift", ["-e", swift], { timeout: 20000 }, () => {});
  } catch {
    /* best-effort — lsregister alone may still be enough */
  }
}

// Claim lykn:// for desktop OAuth return. Packaged builds also declare the
// scheme via electron-builder "protocols".
//
// CRITICAL (macOS + unpackaged): never call setAsDefaultProtocolClient here.
// It registers node_modules Electron.app (com.github.Electron), Launch Services
// relaunches that binary with no main script, and the user sees Electron's
// default "path-to-app" page instead of LYKN. Same reason we refuse to register
// login items while unpackaged.
function claimLyknProtocol() {
  try {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(LYKN_PROTOCOL);
      return;
    }

    if (IS_MAC) {
      try {
        if (app.isDefaultProtocolClient(LYKN_PROTOCOL)) {
          app.removeAsDefaultProtocolClient(LYKN_PROTOCOL);
        }
      } catch {
        /* ignore */
      }
      preferPackagedLyknUrlHandler();
      return;
    }

    // Windows/Linux honor execPath + argv, so deep links relaunch this project.
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(LYKN_PROTOCOL, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
      return;
    }
    app.setAsDefaultProtocolClient(LYKN_PROTOCOL);
  } catch {
    /* registration is best-effort */
  }
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} — LYKN Studio liquid-glass workspace. */
let studioWindow = null;
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

// Pending electron-updater payload. Tray apps often have no visible window /
// Dock icon when update-downloaded fires, so we keep state and re-surface the
// prompt from activate / resume / tray instead of relying on a one-shot dialog.
/** @type {{ version: string } | null} */
let pendingUpdate = null;
/** @type {(() => void) | null} */
let installPendingUpdate = null;
let updatePromptOpen = false;
let lastUpdatePromptAt = 0;
let updateNotifiedForVersion = "";
const UPDATE_REPROMPT_MS = 30 * 60 * 1000;

function quitForReal() {
  allowQuit = true;
  // Real quit: tear down the auth keeper and let the main window's close
  // handler actually destroy (allowQuit short-circuits the hide-on-close).
  destroyAuthKeeper();
  app.quit();
}

/** Bring Dock + main window forward so a modal update dialog can actually appear. */
function ensureAppSurfacedForUpdate() {
  if (IS_MAC && app.dock) {
    try { app.dock.show(); } catch (_) { /* cosmetic */ }
  }
  try {
    app.focus();
  } catch (_) { /* best-effort */ }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.moveTop();
    } catch (_) { /* best-effort */ }
    return mainWindow;
  }
  return null;
}

function notifyUpdateReady(version) {
  const key = version || "pending";
  if (updateNotifiedForVersion === key) return;
  updateNotifiedForVersion = key;
  const ver = version ? ` ${version}` : "";
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "LYKN update ready",
        body: `Version${ver} downloaded. Restart LYKN to install — or use Restart to Update in the menu bar.`,
        silent: false,
      });
      n.on("click", () => {
        void maybePromptPendingUpdate({ force: true });
      });
      n.show();
    }
  } catch (e) {
    console.log("[update] notification failed:", e && e.message ? e.message : e);
  }
}

const AGENT_DONE_SKILL_LABEL = {
  research: "Research ready",
  "report-edit": "Report updated",
  build: "Artifact ready",
  image: "Image ready",
  browse: "Browse finished",
  "browse-summary": "Summary ready",
  "sheets-fill": "Sheet filled",
  "sheets-create": "Sheet created",
  "tool-create": "Created in tool",
  monitor: "Monitor alert",
  general: "Finished",
};

/** @type {BrowserWindow | null} */
let agentFinishedPopup = null;
let agentFinishedPopupTimer = null;
let agentStageToastReserve = 0;

/** Compact Glass-matched finish banner over the agent browser. */
function showAgentFinishedPopup(payload) {
  const agentId = String(payload?.agentId || "").trim();
  const prompt = String(payload?.prompt || payload?.name || "Agent task")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  const status = String(payload?.status || payload?.label || "Finished")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  const ok = payload?.ok !== false;
  // Prefer anchoring to the agent stage if it's already open — never raise it.
  const stage =
    agentStageWindow && !agentStageWindow.isDestroyed() ? agentStageWindow : null;

  // Recreate if an older transparent popup is still around — need vibrancy chrome.
  if (agentFinishedPopup && !agentFinishedPopup.isDestroyed()) {
    try {
      const usingGlass = !!agentFinishedPopup.__lyknGlassFinish;
      if (!usingGlass) {
        agentFinishedPopup.destroy();
        agentFinishedPopup = null;
      }
    } catch (_) {
      agentFinishedPopup = null;
    }
  }

  if (!agentFinishedPopup || agentFinishedPopup.isDestroyed()) {
    agentFinishedPopup = new BrowserWindow({
      width: 340,
      height: 96,
      show: false,
      frame: false,
      ...floatingGlassChrome(),
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      acceptFirstMouse: true,
      ...(IS_MAC ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "agent-finished-popup-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    agentFinishedPopup.__lyknGlassFinish = true;
    try {
      agentFinishedPopup.setContentProtection(isContentProtectionEnabled());
    } catch (_) {}
    hardenFloatingGlass(agentFinishedPopup);
    try {
      agentFinishedPopup.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    } catch (_) {}
    try {
      agentFinishedPopup.setAlwaysOnTop(true, "screen-saver");
    } catch (_) {
      try {
        agentFinishedPopup.setAlwaysOnTop(true, "floating");
      } catch (_) {}
    }
    agentFinishedPopup.on("closed", () => {
      agentFinishedPopup = null;
    });
  }

  const w = 340;
  const h = 96;
  const pad = 12;
  let anchor = null;
  try {
    if (stage && stage.isVisible()) {
      anchor =
        typeof stage.getContentBounds === "function"
          ? stage.getContentBounds()
          : stage.getBounds();
    }
  } catch (_) {}
  if (!anchor) {
    try {
      if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
        anchor = overlayWindow.getBounds();
      }
    } catch (_) {}
  }
  if (!anchor) {
    const { workArea } = screen.getPrimaryDisplay();
    anchor = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
  }
  agentFinishedPopup.__lyknAgentId = agentId;
  setFloatingBounds(agentFinishedPopup, {
    x: Math.round(anchor.x + Math.max(pad, anchor.width - w - pad)),
    y: Math.round(anchor.y + pad),
    width: w,
    height: h,
  });
  applyFloatingGlassShape(agentFinishedPopup);
  const qs = new URLSearchParams({
    prompt: prompt || "Agent task",
    status: status || (ok ? "Finished" : "Failed"),
    ok: ok ? "1" : "0",
    agentId,
  });
  try {
    agentFinishedPopup.loadFile(path.join(__dirname, "agent-finished-popup.html"), {
      query: Object.fromEntries(qs),
    });
  } catch (_) {
    try {
      agentFinishedPopup.loadURL(
        "file://" +
          path.join(__dirname, "agent-finished-popup.html") +
          "?" +
          qs.toString(),
      );
    } catch (_) {}
  }
  try {
    if (typeof agentFinishedPopup.setOpacity === "function") agentFinishedPopup.setOpacity(1);
  } catch (_) {}
  try {
    agentFinishedPopup.showInactive();
    agentFinishedPopup.moveTop();
  } catch (_) {
    try {
      agentFinishedPopup.show();
    } catch (_) {}
  }
  if (agentFinishedPopupTimer) clearTimeout(agentFinishedPopupTimer);
  // Hide the whole window at once — no content-only fade (that left a glass ghost).
  agentFinishedPopupTimer = setTimeout(() => {
    closeAgentFinishedPopup();
  }, 5500);

  agentStageToastReserve = 0;
  layoutAgentStageViews();
}

function closeAgentFinishedPopup() {
  if (agentFinishedPopupTimer) {
    clearTimeout(agentFinishedPopupTimer);
    agentFinishedPopupTimer = null;
  }
  try {
    if (agentFinishedPopup && !agentFinishedPopup.isDestroyed()) {
      agentFinishedPopup.hide();
      if (typeof agentFinishedPopup.setOpacity === "function") agentFinishedPopup.setOpacity(1);
    }
  } catch (_) {}
  agentStageToastReserve = 0;
  try {
    layoutAgentStageViews();
  } catch (_) {}
}

/** Agent finish notices are off — the result already lands in chat. */
function notifyAgentFinished(_payload) {}

/**
 * Show the Restart/Later dialog for a downloaded update. Safe to call from
 * update-downloaded, tray, activate, resume, or second-instance.
 * @param {{ force?: boolean }} [opts]
 */
async function maybePromptPendingUpdate(opts = {}) {
  const force = Boolean(opts.force);
  if (!pendingUpdate || !installPendingUpdate) return;
  if (updatePromptOpen) return;
  if (!force && lastUpdatePromptAt && Date.now() - lastUpdatePromptAt < UPDATE_REPROMPT_MS) {
    return;
  }

  updatePromptOpen = true;
  lastUpdatePromptAt = Date.now();
  refreshTrayUpdateAffordance();
  notifyUpdateReady(pendingUpdate.version);

  const parent = ensureAppSurfacedForUpdate();
  // Give macOS a beat to show Dock + window before an app-modal dialog;
  // otherwise always-on / login-launch sessions often never surface it.
  await new Promise((r) => setTimeout(r, 350));

  const ver = pendingUpdate.version ? ` (${pendingUpdate.version})` : "";
  const closeHint = IS_MAC
    ? "⌘Q keeps LYKN in the menu bar"
    : "Closing the window keeps LYKN in the tray";
  const boxOpts = {
    type: "info",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Update ready",
    message: "Restart to update LYKN.",
    detail:
      `A new version${ver} is ready. Restart the app to install it.\n\n` +
      `Tip: ${closeHint} — choose Restart here, or ` +
      `"Restart to Update" / "Quit LYKN Completely" from the menu bar icon.`,
  };

  try {
    // Re-surface in case focus was stolen during the short delay.
    const liveParent =
      parent && !parent.isDestroyed() ? parent : ensureAppSurfacedForUpdate();
    const { response } = liveParent
      ? await dialog.showMessageBox(liveParent, boxOpts)
      : await dialog.showMessageBox(boxOpts);
    if (response === 0) {
      installPendingUpdate();
    }
  } catch (e) {
    console.log("[update] prompt failed:", e && e.message ? e.message : e);
  } finally {
    updatePromptOpen = false;
  }
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
/** @type {BrowserWindow | null} */
let welcomeWindow = null;
// First-launch gate: while true, the main window loads hidden behind the
// welcome splash → walkthrough, and only the walkthrough flow reveals it.
let welcomeGateActive = false;
// Set once the finish handler has reloaded the studio behind the welcome
// loader — the closed handler can then reveal it instantly instead of
// kicking off a fresh load after the glass is already gone.
let welcomeStudioPreloaded = false;
let overlayVisibleBeforeExtensionInstall = false;

// Once the user drags the bar we stop auto-centering it. We anchor by the
// BOTTOM-RIGHT corner so the chat column stays put as answers stream in (grows
// up) and as the left source panel opens/closes (grows left).
let overlayUserPositioned = false;
let overlayAnchorLeft = null;
let overlayAnchorBottomY = null;
let overlayProgrammaticMove = false;

let mainWindowDeferred = false;

function createMainWindow() {
  // `second-instance` and `open-url` can both arrive while this instance is
  // still starting, and `screen` below throws if it is touched before ready.
  // Deferring is the correct behaviour rather than a guard: the user asked for
  // a window, so we still owe them one once there is a display to size it against.
  if (!app.isReady()) {
    if (mainWindowDeferred) return;
    mainWindowDeferred = true;
    app.whenReady().then(() => {
      mainWindowDeferred = false;
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    });
    return;
  }

  // Coming back from background (menu-bar-only) mode: restore the Dock icon
  // before the window appears so it can take focus like a normal app window.
  if (IS_MAC && app.dock) {
    try { app.dock.show(); } catch (_) { /* cosmetic */ }
  }
  // Main window takes over as the auth provider — tear down the keeper so
  // two Supabase clients don't race the rotating refresh token.
  destroyAuthKeeper();

  // If a legacy second Studio window is still around, drop it — Studio is
  // the main window now, not a handoff target.
  if (studioWindow && !studioWindow.isDestroyed() && studioWindow !== mainWindow) {
    try {
      studioWindow.destroy();
    } catch (_) {
      /* ignore */
    }
    studioWindow = null;
  }

  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1320, workArea.width - 64);
  const height = Math.min(880, workArea.height - 64);
  mainWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    minWidth: 960,
    minHeight: 640,
    // Studio is the product shell: liquid-glass over native vibrancy.
    backgroundColor: "#00000000",
    hasShadow: false,
    ...(IS_MAC
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 22 },
          transparent: false,
          vibrancy: "hud",
          visualEffectState: "active",
          roundedCorners: true,
        }
      : {
          frame: false,
          transparent: false,
          backgroundMaterial: "acrylic",
          roundedCorners: false,
          thickFrame: false,
        }),
    autoHideMenuBar: IS_WIN,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    // Studio opens already fullscreen so there's no expand transition at all.
    // On macOS that's SIMPLE fullscreen (applied at ready-to-show below):
    // fills the screen like native fullscreen but stays on the regular
    // desktop instead of a separate Space. Native fullscreen also ignored
    // show:false during the walkthrough, leaking the booting web app
    // behind the welcome glass.
    fullscreen: !welcomeGateActive && !IS_MAC,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Installed apps open as windows on the desktop, and a <webview> is what
      // lets them do that without giving up what makes them apps: a subframe
      // gets no preload, so an <iframe> would cost them the bridge and their
      // own storage. Guests are held to that shape by `will-attach-webview`.
      webviewTag: true,
      // Auth provider for the overlay — keep token refresh alive while hidden.
      backgroundThrottling: false,
      disableHtmlFullscreenWindowResize: true,
    },
  });

  // Nothing but an installed app may attach, and only as itself: the guest is
  // pinned to the app preload and the app's own partition here, so markup in
  // the renderer can't ask for Node, a different preload, or another origin.
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const appProtocol = require("./appProtocol.cjs");
    const appHost = require("./appHost.cjs");
    const appId = appProtocol.appIdFromOrigin(params.src || "");
    if (!appId) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preloadURL;
    webPreferences.preload = appHost.PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    // Also binds the app scheme on that partition, which has to happen before
    // the guest navigates or it opens to a failed load.
    params.partition = appHost.partitionFor(appId);
  });
  // Studio features (browser dock, fullscreen IPC) attach to this same window.
  studioWindow = mainWindow;

  mainWindow.once("ready-to-show", () => {
    // First launch: stay hidden behind the welcome splash / walkthrough —
    // the onboarding flow (or its close fallback) reveals the window.
    if (welcomeGateActive) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Simple fullscreen before show — full screen with no separate Space.
      if (IS_MAC) {
        try {
          mainWindow.setSimpleFullScreen(true);
        } catch (_) {}
      }
      mainWindow.show();
      mainWindow.focus();
      broadcastStudioFullscreen();
    }
  });

  // Native fullscreen emits real enter/leave events — just relay them.
  mainWindow.on("enter-full-screen", broadcastStudioFullscreen);
  mainWindow.on("leave-full-screen", broadcastStudioFullscreen);

  if (IS_MAC) {
    const ensureTrafficLights = () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setWindowButtonVisibility(true);
        }
      } catch (_) {
        /* ignore */
      }
    };
    mainWindow.on("enter-full-screen", ensureTrafficLights);
    mainWindow.on("leave-full-screen", ensureTrafficLights);
    mainWindow.on("enter-html-full-screen", ensureTrafficLights);
    mainWindow.on("leave-html-full-screen", ensureTrafficLights);
    mainWindow.once("ready-to-show", ensureTrafficLights);
  }

  // Boot straight into Studio. During the first-launch walkthrough the
  // walkthrough=1 flag bypasses ProtectedRoute's /login redirect — the old
  // login page must never render behind the welcome glass; the walkthrough
  // itself signs the user in.
  const studioHome = welcomeGateActive
    ? `${APP_ORIGIN}/studio?glass=1&walkthrough=1`
    : `${APP_ORIGIN}/studio?glass=1`;
  const loadAppUrl = (attempt = 0) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void mainWindow.loadURL(studioHome).catch((err) => {
      const msg = String(err?.message || err || "");
      const isLocal =
        /localhost|127\.0\.0\.1/i.test(APP_URL) ||
        msg.includes("ERR_CONNECTION_REFUSED");
      if (isLocal && attempt < 40) {
        setTimeout(() => loadAppUrl(attempt + 1), 250);
        return;
      }
      console.error("[main-window] failed to load", studioHome, msg);
    });
  };
  loadAppUrl();

  mainWindow.webContents.on("did-finish-load", flushPendingAuthTokens);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const origin = new URL(url).origin;
      if (origin === APP_ORIGIN || isAuthNavigation(url)) {
        return { action: "allow" };
      }
      // Chat links / artifacts with target=_blank → LYKN in-app browser.
      void openUrlPreferAgentBrowser(url);
      return { action: "deny" };
    } catch {
      return { action: "deny" };
    }
  });

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
    void openUrlPreferAgentBrowser(url);
  });

  // Reloads land back on the dashboard tab — undock a browser parked over it.
  mainWindow.webContents.on("did-navigate", () => {
    try {
      setStudioBrowserEmbed({ open: false });
    } catch (_) {
      /* ignore */
    }
  });

  // Red close / ⌘W: HIDE, don't destroy (auth keeper for Glass).
  mainWindow.on("close", (e) => {
    if (allowQuit) return;
    e.preventDefault();
    hideStudioWindow();
    updateDockVisibility();
  });

  mainWindow.on("closed", () => {
    // Agent browser views live on this window from the moment they first dock
    // — closing the Browser window only hides them — so they have to be handed
    // over here whether or not the dock is active, or they'd be destroyed
    // along with it.
    studioStageEmbedded = false;
    parkStudioStageViewsOnStage();
    try {
      studioStageChromeView?.webContents?.close?.();
    } catch (_) {}
    studioStageChromeView = null;
    mainWindow = null;
    studioWindow = null;
    updateDockVisibility();
    if (!allowQuit) ensureAuthKeeper();
  });

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.warn("[main-window] renderer gone:", details?.reason || "unknown");
    if (details?.reason === "clean-exit") return;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    } catch (_) {}
  });
}

// ── LYKN Studio ──────────────────────────────────────────────────────────────
// Studio IS the main window (vibrancy + `/studio?glass=1`). These helpers
// stay so older IPC (`lykn:studio-set`, browser dock) keeps working without
// opening a second window.
function createStudioWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  studioWindow = mainWindow;
  try {
    const cur = mainWindow.webContents.getURL() || "";
    if (!/\/studio(\?|$)/.test(cur)) {
      void mainWindow.loadURL(`${APP_ORIGIN}/studio?glass=1`);
    }
  } catch (_) {
    void mainWindow.loadURL(`${APP_ORIGIN}/studio?glass=1`);
  }
  // First-launch walkthrough owns the screen — the web app boots in the
  // hidden window and its studio IPC must not reveal it early.
  if (welcomeGateActive) return;
  // Re-shows come back fullscreen, matching the boot state (hide/minimize
  // exit simple fullscreen first, so it must be re-applied here).
  if (IS_MAC && !mainWindow.isVisible()) {
    try {
      if (!mainWindow.isSimpleFullScreen() && !mainWindow.isFullScreen()) {
        mainWindow.setSimpleFullScreen(true);
      }
    } catch (_) {}
  }
  mainWindow.show();
  mainWindow.focus();
}

// Studio fullscreen: simple fullscreen on macOS (fills the screen with no
// separate Space), plain native fullscreen elsewhere.
function studioWindowRef() {
  if (studioWindow && !studioWindow.isDestroyed()) return studioWindow;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return null;
}

function studioFullscreenActive() {
  const win = studioWindowRef();
  if (!win) return false;
  // Simple fullscreen (fills the screen without a separate macOS Space)
  // counts as fullscreen for the studio UI.
  try {
    if (typeof win.isSimpleFullScreen === "function" && win.isSimpleFullScreen()) {
      return true;
    }
  } catch (_) {}
  return win.isFullScreen();
}

function broadcastStudioFullscreen() {
  const win = studioWindowRef();
  if (!win) return;
  if (IS_MAC) {
    try {
      win.setWindowButtonVisibility(true);
    } catch (_) {
      /* ignore */
    }
  }
  win.webContents.send("lykn:studio-fullscreen", {
    fullscreen: studioFullscreenActive(),
  });
}

function showStudioWindow() {
  createStudioWindow();
}

// Runs `then` once the window is out of fullscreen — immediately when it
// already is, otherwise after macOS's animated exit lands (hiding or
// minimizing a fullscreen window mid-animation gets ignored).
function afterStudioFullscreenExit(win, then) {
  if (!win || win.isDestroyed()) return;
  // Simple fullscreen (macOS studio default) exits instantly — no animation.
  try {
    if (typeof win.isSimpleFullScreen === "function" && win.isSimpleFullScreen()) {
      win.setSimpleFullScreen(false);
      then();
      return;
    }
  } catch (_) {}
  if (!win.isFullScreen()) {
    then();
    return;
  }
  win.once("leave-full-screen", () => {
    if (win && !win.isDestroyed()) then();
  });
  win.setFullScreen(false);
}

function hideStudioWindow() {
  const win = studioWindowRef();
  if (!win) return;
  afterStudioFullscreenExit(win, () => {
    try {
      win.hide();
    } catch (_) {
      /* ignore */
    }
    updateDockVisibility();
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
    const allow =
      ALLOWED.has(permission) &&
      (originAllowed(webContents) || isOverlayContents(webContents));
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

/** Work area for the display that currently holds (or will hold) the glass bar. */
function overlayWorkArea(boundsHint) {
  try {
    if (boundsHint && typeof boundsHint.x === "number") {
      return screen.getDisplayMatching(boundsHint).workArea;
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      return screen.getDisplayMatching(overlayWindow.getBounds()).workArea;
    }
  } catch (_) {
    /* fall through */
  }
  return screen.getPrimaryDisplay().workArea;
}

function overlayPosition(height) {
  const workArea = overlayWorkArea();
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - height - OVERLAY_BOTTOM_MARGIN),
  };
}

/** True when most of the bar (esp. the bottom/composer) is off the work area. */
function overlayBoundsNeedHeal(bounds, workArea) {
  if (!bounds || !workArea) return true;
  const margin = 4;
  const bottom = bounds.y + bounds.height;
  const right = bounds.x + bounds.width;
  const workBottom = workArea.y + workArea.height;
  const workRight = workArea.x + workArea.width;
  // Composer lives at the bottom — if that edge is past the dock/screen, heal.
  if (bottom > workBottom + margin) return true;
  if (bounds.y + bounds.height * 0.5 < workArea.y) return true;
  if (right < workArea.x + 40 || bounds.x > workRight - 40) return true;
  // Too short to show the composer toolbar (buttons look "cut off").
  if (bounds.height > 0 && bounds.height < 96) return true;
  // Almost none of the window is actually visible in the work area.
  const visibleH =
    Math.min(bottom, workBottom) - Math.max(bounds.y, workArea.y);
  if (visibleH < 64) return true;
  return false;
}

function resetOverlayPositionToDefault() {
  overlayUserPositioned = false;
  overlayAnchorLeft = null;
  overlayAnchorBottomY = null;
}

/** Unstick click-through + snap a clipped/tiny bar back to bottom-center. */
function healOverlayGeometry(forceReset = false) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    setOverlayClickThrough(false);
  } catch (_) {}
  try {
    if (overlayCollapsed) setOverlayCollapsed(false);
  } catch (_) {}
  let b;
  try {
    b = overlayWindow.getBounds();
  } catch (_) {
    return;
  }
  const wa = overlayWorkArea(b);
  if (forceReset || overlayBoundsNeedHeal(b, wa)) {
    resetOverlayPositionToDefault();
  }
  const w = Math.max(OVERLAY_WIDTH, Math.round(b.width || OVERLAY_WIDTH));
  // Ensure at least a full composer (title + field + toolbar) is laid out.
  const h = Math.max(130, Math.round(b.height || OVERLAY_MIN_HEIGHT));
  setOverlaySize(w, h);
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

  // Forward Escape to the renderer. macOS non-activating panel windows can miss
  // normal keydown delivery depending on key-window state; before-input-event is
  // the reliable path so Esc can stop voice mode / dismiss the bar.
  overlayWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key !== "Escape" && input.code !== "Escape") return;
    try {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      overlayWindow.webContents.send("lykn:overlay-escape");
    } catch (_) {}
  });

  // When the bar becomes key again (click back from Cursor/etc.), put caret in ask.
  overlayWindow.on("focus", () => {
    try {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      overlayWindow.webContents.send("lykn:overlay-focus-composer");
    } catch (_) {}
  });

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
    positionLangPickerWindow();
    positionLiveWindow();
    positionPanelWindow();
    positionAgentSidebarWindow();
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
  const b = overlayWindow.getBounds();
  const workArea = overlayWorkArea(b);
  const w = collapsed ? OVERLAY_BUBBLE : OVERLAY_WIDTH;
  const h = collapsed ? OVERLAY_BUBBLE : OVERLAY_MIN_HEIGHT;
  // Keep the bottom-left corner fixed across the swap so the chat column stays
  // put (it lives on the left; the bubble takes the chat's bottom-left spot).
  const left = b.x;
  let bottom = b.y + b.height;
  const margin = 8;
  const maxBottom = workArea.y + workArea.height - margin;
  bottom = Math.min(bottom, maxBottom);
  let x = left;
  let y = bottom - h;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - w));
  y = Math.max(workArea.y + margin, Math.min(y, maxBottom - h));

  if (!collapsed) {
    // Anchor future growth to where the panel reappears.
    overlayUserPositioned = true;
    overlayAnchorLeft = x;
    overlayAnchorBottomY = y + h;
    // Bring the live / side-panel / agents cards back alongside the bar.
    if (liveCardOpen) showLiveWindow();
    if (panelCardOpen) showPanelWindow();
    if (agentSidebarOpen) showAgentSidebarWindow();
  }

  overlayProgrammaticMove = true;
  setFloatingBounds(overlayWindow, {
    x: Math.round(x),
    y: Math.round(y),
    width: w,
    height: h,
  });
  overlayProgrammaticMove = false;
  // Floating panels next to the bar don't belong beside the collapsed bubble —
  // they come back when the bar expands.
  if (collapsed) {
    hideMenuWindow();
    hidePickerWindow();
    hideLangPickerWindow();
    hideLiveWindow();
    hidePanelWindow();
    hideAgentSidebarWindow();
  }
}

// Size the window to the renderer-reported content. Width varies with side panels;
// we anchor the chat column's left edge so it never shifts when panels open.
// Always keep the BOTTOM (composer / buttons) on-screen — never clip under the dock.
function setOverlaySize(width, height) {
  if (!overlayWindow || overlayCollapsed) return;
  const hint =
    overlayUserPositioned && overlayAnchorLeft != null && overlayAnchorBottomY != null
      ? { x: overlayAnchorLeft, y: overlayAnchorBottomY - 40, width: OVERLAY_WIDTH, height: 40 }
      : overlayWindow.getBounds();
  const workArea = overlayWorkArea(hint);
  const margin = 8;
  const maxH = Math.max(OVERLAY_MIN_HEIGHT, workArea.height - margin * 2);
  const w = Math.max(OVERLAY_WIDTH, Math.min(Math.round(width || OVERLAY_WIDTH), OVERLAY_MAX_WIDTH));
  const h = Math.max(OVERLAY_MIN_HEIGHT, Math.min(Math.round(height) || OVERLAY_MIN_HEIGHT, 760, maxH));

  let chatLeft;
  let bottom;
  if (overlayUserPositioned && overlayAnchorLeft != null && overlayAnchorBottomY != null) {
    chatLeft = overlayAnchorLeft;
    bottom = overlayAnchorBottomY;
  } else {
    chatLeft = Math.round(workArea.x + workArea.width / 2 - OVERLAY_WIDTH / 2);
    bottom = workArea.y + workArea.height - OVERLAY_BOTTOM_MARGIN;
  }

  const maxBottom = workArea.y + workArea.height - margin;
  const minBottom = workArea.y + margin + h;
  // Prefer keeping the composer on-screen over preserving a bad drag anchor.
  if (bottom > maxBottom || bottom < workArea.y + OVERLAY_MIN_HEIGHT) {
    bottom = Math.min(maxBottom, Math.max(minBottom, workArea.y + workArea.height - OVERLAY_BOTTOM_MARGIN));
    if (overlayUserPositioned) overlayAnchorBottomY = bottom;
  } else {
    bottom = Math.min(maxBottom, Math.max(bottom, Math.min(minBottom, maxBottom)));
  }

  let x = chatLeft;
  let y = bottom - h;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - w));
  // If top would clip, shrink upward room by moving bottom down… no: move y down
  // only within the room that still keeps bottom visible.
  if (y < workArea.y + margin) {
    y = workArea.y + margin;
    bottom = y + h;
    if (bottom > maxBottom) {
      // Height already capped to maxH — pin to top of work area.
      y = workArea.y + margin;
      bottom = y + h;
    }
    if (overlayUserPositioned) overlayAnchorBottomY = bottom;
  }
  if (overlayUserPositioned) overlayAnchorLeft = x;

  overlayProgrammaticMove = true;
  setFloatingBounds(overlayWindow, {
    x: Math.round(x),
    y: Math.round(y),
    width: w,
    height: h,
  });
  overlayProgrammaticMove = false;
  // Keep the floating menu/picker/live/panel cards glued to the bar's edges as it grows.
  positionMenuWindow();
  positionPickerWindow();
  positionLangPickerWindow();
  positionLiveWindow();
  positionPanelWindow();
  positionAgentSidebarWindow();
}

function hideOverlay() {
  if (overlayWindow && overlayWindow.isVisible()) overlayWindow.hide();
  // Tear down the full-screen "LYKN is on" glass alongside the bar.
  hideOverlayGlass();
  // And the floating three-dot menu + picker + live notes + side-panel + agents.
  hideMenuWindow();
  hidePickerWindow();
  hideLangPickerWindow();
  hideLiveWindow();
  hidePanelWindow();
  hideAgentSidebarWindow();
}

function setOverlayClickThrough(enabled) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    overlayWindow.setIgnoreMouseEvents(!!enabled, enabled ? { forward: true } : undefined);
  } catch (_) {}
}

/** Re-key the glass bar for typing after another app (or the agent stage) stole focus. */
function focusOverlayForTyping() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Working the agents from the Studio's docked browser with Glass hidden —
  // don't pop Glass open; the keyboard belongs to the Studio's agent rail.
  if (!overlayWindow.isVisible() && studioStageEmbedActive()) {
    try {
      if (studioWindow.isVisible()) studioWindow.focus();
    } catch (_) {}
    return;
  }
  try {
    healOverlayGeometry(false);
  } catch (_) {}
  try {
    if (!overlayWindow.isVisible()) overlayWindow.show();
    // Panel windows often accept the click but never become key after Cursor/etc.
    if (process.platform === "darwin") {
      try {
        app.focus({ steal: true });
      } catch (_) {}
    }
    overlayWindow.moveTop();
    overlayWindow.focus();
    overlayWindow.webContents.focus();
    overlayWindow.webContents.send("lykn:overlay-focus-composer");
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

// Serialize macOS TCC / Automation Allow dialogs so one Glass ask never stacks
// Screen Recording + System Events + N browser prompts at once.
let permissionPromptChain = Promise.resolve();
async function withPermissionPrompt(_label, fn) {
  const prev = permissionPromptChain;
  let release;
  permissionPromptChain = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
  }
}

// Session cache for Apple Events / Automation. macOS has no query API; we learn
// from osascript success / errAEEventNotPermitted (-1743) and avoid re-probing
// denied targets (and stop fanning out to every open browser in one action).
const automationOk = {
  /** @type {null|boolean} */
  systemEvents: null,
  /** @type {Record<string, boolean>} */
  browsers: Object.create(null),
};

function isAutomationDeniedError(msg) {
  return /-1743|not authoriz|not allowed to send|user declined|osascript is not allowed/i.test(
    String(msg || ""),
  );
}

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

/**
 * Open System Settings → Screen Recording.
 *
 * macOS only adds LYKN to that list after a real capture/TCC probe. Opening the
 * pane too early (or before TCC has flushed) shows an empty/stale list until the
 * user closes and reopens Settings — so callers should probe first, then pass
 * `{ afterTccRegister: true }` so we wait a beat before opening.
 */
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

/** Tiny capture so TCC registers LYKN under Screen Recording before Settings opens. */
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

/**
 * Make sure Screen Recording is available before Glass / capture features run.
 *
 * macOS only shows the "Allow LYKN to record this computer's screen?" dialog when
 * we actually attempt a capture (or call the TCC prompt via getSources). There is
 * no askForMediaAccess("screen"). Previously Glass failed fast with a Settings
 * message whenever status !== granted — so users who skipped onboarding (or whose
 * older Mac never showed the dialog) never got the system prompt.
 *
 * Always probe before opening Settings so LYKN appears in the list (opening the
 * pane without a prior capture leaves LYKN missing until Settings is relaunched).
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

// Display the overlay (or cursor) is on — so capture / burst cover the screen
// the user is actually looking at, not always the primary (external monitors,
// Sidecar, resolution changes).
function getTargetCaptureDisplay() {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const b = overlayWindow.getBounds();
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

// Capture the full target display and return a data URL. Always scales the
// WHOLE screen (never a cropped sub-rectangle). desktopCapturer fails
// ("Failed to get sources") when asked for a very large thumbnail (e.g. full
// Retina resolution), so we try a ladder of decreasing sizes and take the
// first that succeeds — sharp when possible, reliable always. Sizes are based
// on physical pixels (bounds × scaleFactor) so Retina / HiDPI / ultrawide
// Macs still yield a full-frame image.
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

// ── Summon burst ─────────────────────────────────────────────────────────
// A full-screen, transparent, click-through window that plays a brief color
// wash across the WHOLE screen when the overlay is summoned. No persistent
// outline — capture reads the full display on its own. The window covers the
// display the overlay is on (not always primary) and hides after the anim.
function createBurstWindow() {
  const { bounds } = getTargetCaptureDisplay();
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
      const { bounds } = getTargetCaptureDisplay();
      // Park the window one full screen-height above the display.
      burstWindow.setBounds({
        x: bounds.x,
        y: bounds.y - bounds.height - 120,
        width: bounds.width,
        height: bounds.height,
      });
      burstWindow.setIgnoreMouseEvents(true, { forward: true });
      // Belt and braces: macOS can clamp "off-screen" windows back onto the
      // display, which made this warm-up flash blue at app launch. Opacity 0
      // keeps the renderer rasterizing while guaranteeing nothing shows.
      burstWindow.setOpacity(0);
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
        burstWindow.setOpacity(1);
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
    // Cover the display the overlay is on (handles external / scaled screens).
    const { bounds } = getTargetCaptureDisplay();
    burstWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
    burstWindow.setIgnoreMouseEvents(true, { forward: true });
    // The boot warm-up runs at opacity 0 — a summon during that window must
    // reset it or the real burst would be invisible.
    burstWindow.setOpacity(1);
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
    // One-shot summon cue only — hide once the wash finishes (no persistent rim).
    if (burstHideTimer) {
      clearTimeout(burstHideTimer);
      burstHideTimer = null;
    }
    burstHideTimer = setTimeout(() => {
      burstHideTimer = null;
      hideOverlayGlass();
    }, 1400);
  } catch (_) {
    /* the burst is purely cosmetic — never block showing the overlay */
  }
}

// Stop the summon animation and hide its window. Called after the one-shot
// wash finishes, or immediately when the overlay is dismissed.
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
  // The live / panel / agent-sidebar cards occupy the bar's right flank when
  // open — step past them so the menu doesn't land underneath.
  const rightInset =
    (liveWindowVisible() ? LIVE_WIDTH + MENU_GAP : 0) +
    (panelWindowVisible() ? panelWidth + MENU_GAP : 0) +
    (agentSidebarWindowVisible() ? AGENT_SIDEBAR_WIDTH + MENU_GAP : 0);
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

// ── Detached Translate-mode language picker ─────────────────────────────
// Same vibrancy-window pattern as menu/picker: can't hang inside the overlay
// HWND or macOS paints a blurred slab under the list.
const LANG_PICKER_WIDTH = 180;
const LANG_PICKER_MIN_HEIGHT = 72;
const LANG_PICKER_MAX_HEIGHT = 180;
const LANG_PICKER_GAP = 6;
let langPickerWindow = null;
let langPickerHeight = 160;
/** Pill rect relative to the overlay window content (from renderer). */
let langPickerAnchor = null;

function createLangPickerWindow() {
  langPickerWindow = new BrowserWindow({
    width: LANG_PICKER_WIDTH,
    height: langPickerHeight,
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
      preload: path.join(__dirname, "lang-picker-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    langPickerWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(langPickerWindow);
  langPickerWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  langPickerWindow.setFullScreenable(false);
  langPickerWindow.setAlwaysOnTop(true, "screen-saver");
  langPickerWindow.loadFile(path.join(__dirname, "lang-picker.html"));
  langPickerWindow.on("closed", () => {
    langPickerWindow = null;
  });
}

function langPickerTargetBounds() {
  const ob = overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(
    LANG_PICKER_MIN_HEIGHT,
    Math.min(langPickerHeight, LANG_PICKER_MAX_HEIGHT, workArea.height - 16),
  );
  const a = langPickerAnchor || { left: 12, bottom: 40, width: LANG_PICKER_WIDTH };
  let x = Math.round(ob.x + Number(a.left || 0));
  let y = Math.round(ob.y + Number(a.bottom || 0) + LANG_PICKER_GAP);
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - LANG_PICKER_WIDTH));
  if (y + h > workArea.y + workArea.height) {
    // Flip above the pill when there's no room below.
    y = Math.round(ob.y + Number(a.top || a.bottom || 0) - LANG_PICKER_GAP - h);
  }
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return { x, y, width: LANG_PICKER_WIDTH, height: h };
}

function positionLangPickerWindow() {
  if (!langPickerWindow || langPickerWindow.isDestroyed() || !langPickerWindow.isVisible()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setFloatingBounds(langPickerWindow, langPickerTargetBounds());
}

function notifyLangPickerVisibility(visible) {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed())
      overlayWindow.webContents.send("lykn:lang-picker-visible", !!visible);
  } catch (_) {}
}

function showLangPickerWindow(anchor) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (anchor && typeof anchor === "object") langPickerAnchor = anchor;
  hideMenuWindow();
  hidePickerWindow();
  if (!langPickerWindow || langPickerWindow.isDestroyed()) createLangPickerWindow();
  const fire = () => {
    if (!langPickerWindow || langPickerWindow.isDestroyed()) return;
    setFloatingBounds(langPickerWindow, langPickerTargetBounds());
    langPickerWindow.showInactive();
    langPickerWindow.moveTop();
    langPickerWindow.webContents.send("lykn:lang-picker-shown");
    notifyLangPickerVisibility(true);
  };
  if (langPickerWindow.webContents.isLoading()) {
    langPickerWindow.webContents.once("did-finish-load", fire);
  } else fire();
}

function hideLangPickerWindow() {
  if (
    langPickerWindow &&
    !langPickerWindow.isDestroyed() &&
    langPickerWindow.isVisible()
  ) {
    langPickerWindow.hide();
  }
  notifyLangPickerVisibility(false);
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
  const rightInset =
    (liveWindowVisible() ? LIVE_WIDTH + MENU_GAP : 0) +
    (agentSidebarWindowVisible() ? AGENT_SIDEBAR_WIDTH + MENU_GAP : 0);
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

// ── Agent Mode: sidebar + owned browser sessions ───────────────────────────
const AGENT_SIDEBAR_WIDTH = 280;
const AGENT_SIDEBAR_MIN_HEIGHT = 180;
const AGENT_SIDEBAR_MAX_HEIGHT = 560;
let agentSidebarWindow = null;
let agentSidebarHeight = 360;
let agentSidebarOpen = false;
let agentRuntime = null;
// Inline browser-new-tab conversations receive the same live agent events as
// the regular LYKN chat, scoped to their paired browser agent.
const browserWelcomeChatStreams = new Map();
let openBrowserTaskChat = null;

function emitAgentToUi(channel, payload) {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(channel, payload);
    }
  } catch (_) {}
  try {
    if (agentSidebarWindow && !agentSidebarWindow.isDestroyed()) {
      agentSidebarWindow.webContents.send(channel, payload);
    }
  } catch (_) {}
  // The Studio's browser tab renders an agent rail beside the docked
  // browser — mirror agent events there too.
  try {
    if (studioWindow && !studioWindow.isDestroyed()) {
      studioWindow.webContents.send(channel, payload);
    }
  } catch (_) {}
  const agentId = String(payload?.agentId || "");
  const stream = agentId ? browserWelcomeChatStreams.get(agentId) : null;
  // Open the task panel only after the runtime has resolved the turn into
  // actual work. This avoids the old keyword-based behavior that opened it
  // for ordinary questions.
  if (
    stream &&
    channel === "lykn:agent-progress" &&
    !stream.taskPanelOpened &&
    ["browse", "build", "image", "local", "tool-create", "sheets-create", "sheets-fill"].includes(
      String(payload?.skill || ""),
    )
  ) {
    stream.taskPanelOpened = true;
    try {
      openBrowserTaskChat?.(agentId);
    } catch (_) {}
  }
  if (
    stream &&
    ["lykn:agent-status", "lykn:agent-delta", "lykn:agent-done", "lykn:agent-error"].includes(
      channel,
    )
  ) {
    try {
      if (!stream.sender.isDestroyed?.()) {
        stream.sender.send("lykn:agent-browser-welcome-stream", {
          requestId: stream.requestId,
          channel,
          ...payload,
        });
      }
    } catch (_) {}
    if (channel === "lykn:agent-done" || channel === "lykn:agent-error") {
      browserWelcomeChatStreams.delete(agentId);
    }
  }
}

function createAgentSidebarWindow() {
  agentSidebarWindow = new BrowserWindow({
    width: AGENT_SIDEBAR_WIDTH,
    height: agentSidebarHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "agent-sidebar-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    agentSidebarWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(agentSidebarWindow);
  agentSidebarWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  agentSidebarWindow.setFullScreenable(false);
  agentSidebarWindow.setAlwaysOnTop(true, "screen-saver");
  agentSidebarWindow.loadFile(path.join(__dirname, "agent-sidebar.html"));
  agentSidebarWindow.on("closed", () => {
    agentSidebarWindow = null;
  });
}

function agentSidebarWindowVisible() {
  return !!(
    agentSidebarWindow &&
    !agentSidebarWindow.isDestroyed() &&
    agentSidebarWindow.isVisible()
  );
}

function agentSidebarTargetBounds() {
  const ob = overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(
    AGENT_SIDEBAR_MIN_HEIGHT,
    Math.min(agentSidebarHeight, AGENT_SIDEBAR_MAX_HEIGHT, workArea.height - 16),
  );
  const rightInset =
    (liveWindowVisible() ? LIVE_WIDTH + MENU_GAP : 0) +
    (panelWindowVisible() ? panelWidth + MENU_GAP : 0);
  let x = ob.x + ob.width + MENU_GAP + rightInset;
  if (x + AGENT_SIDEBAR_WIDTH > workArea.x + workArea.width) {
    x = ob.x - MENU_GAP - AGENT_SIDEBAR_WIDTH;
  }
  x = Math.max(workArea.x, x);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: AGENT_SIDEBAR_WIDTH,
    height: h,
  };
}

function positionAgentSidebarWindow() {
  if (!agentSidebarWindowVisible()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  setFloatingBounds(agentSidebarWindow, agentSidebarTargetBounds());
}

function showAgentSidebarWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!agentSidebarWindow || agentSidebarWindow.isDestroyed()) createAgentSidebarWindow();
  const fire = () => {
    if (!agentSidebarWindow || agentSidebarWindow.isDestroyed()) return;
    setFloatingBounds(agentSidebarWindow, agentSidebarTargetBounds());
    agentSidebarWindow.showInactive();
    agentSidebarWindow.moveTop();
    agentRuntime?.emitList?.();
    positionMenuWindow();
  };
  if (agentSidebarWindow.webContents.isLoading()) {
    agentSidebarWindow.webContents.once("did-finish-load", fire);
  } else fire();
}

function hideAgentSidebarWindow() {
  if (agentSidebarWindowVisible()) agentSidebarWindow.hide();
  positionMenuWindow();
}

// ── Agent browser stage: one Chrome-style window, one WebContentsView tab per agent ─
const AGENT_STAGE_CHROME_DEFAULT = 82;
let agentStageWindow = null;
let agentStageChromeHeight = AGENT_STAGE_CHROME_DEFAULT;
let agentStageActiveId = null;

/**
 * Is the user currently looking at this agent's tab family (its browse tab, a
 * sub-tab it owns, or one of its deliverable subtabs)?
 *
 * This is the gate on stealing the stage. A finishing agent fronting its own
 * tab yanked the user away from whatever they were doing in another tab — the
 * moment a background task completed, their work switched out from under
 * them. Anything that wants to front a tab WITHOUT the user having asked for
 * it right now must check here first.
 */
function agentTabFamilyActive(ownerId) {
  const owner = String(ownerId || "").trim();
  if (!owner) return false;
  const active = String(agentStageActiveId || "").trim();
  if (!active) return false;
  if (active === owner) return true;
  if (agentTabIds.subTabOwner(active) === owner) return true;
  return String(agentBrowserMeta.get(active)?.ownerAgentId || "") === owner;
}
/** Studio agent chat side panel — closed until "Use LYKN" in browser chrome. */
let agentChatOpen = false;
/** Saved-links dropdown open — the chrome surface overlays the page view so
 *  the menu renders in front instead of being buried behind the browser. */
let agentStageMenuOverlay = false;
/** Tab id waiting for Chrome-style omnibox focus after a user-opened new tab.
 *  Cleared once the home page finishes loading (or the user switches away). */
let agentStagePendingOmniboxFocusId = null;
/** @type {Map<string, WebContentsView>} */
const agentBrowserViews = new Map();
// New native page views stay detached until their first document has painted.
// Attaching a blank WebContentsView lets macOS briefly paint its white default
// surface over the browser page, even when its bounds are immediately parked.
const agentBrowserViewsReady = new Set();
const agentBrowserLabels = new Map();
/** Hard ceiling on open browser tabs — matches MAX_WORKER_AGENTS (each
 *  worker agent owns a tab), keeping tab count and agent count capped
 *  together at 20. */
const MAX_AGENT_BROWSER_TABS = 20;

/** Main (agent) tabs only — deliverable subtabs don't count toward the cap. */
function agentBrowserMainTabCount() {
  let n = 0;
  for (const id of agentBrowserViews.keys()) {
    if (!isAgentArtifactTabId(id)) n += 1;
  }
  return n;
}
/** Per-tab incognito (ephemeral session + dark chrome). */
const agentIncognito = new Map();
/** Default for new tabs / empty stage chrome theme. */
let agentStageIncognitoDefault = false;
/**
 * Shared signed-in profile for all non-incognito agent browser tabs.
 * Persist prefix keeps cookies/localStorage across app restarts so Gmail
 * (etc.) stay logged in the next time any agent opens that site.
 * Incognito tabs intentionally use a separate ephemeral partition.
 */
const AGENT_BROWSER_SHARED_PARTITION = "persist:lykn-agent-browser";
/**
 * @type {Map<string, {
 *   url?: string,
 *   pageTitle?: string,
 *   favicon?: string,
 *   kind?: "browse"|"artifact",
 *   artifactKind?: string,
 *   ownerAgentId?: string,
 * }>}
 */
const agentBrowserMeta = new Map();

/** Product icons for Google hosts — S2 returns the same "G" for every *.google.com. */
const AGENT_BRAND_ICON_BY_HOST = {
  "mail.google.com":
    "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
  "calendar.google.com":
    "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
  "drive.google.com":
    "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
  "docs.google.com":
    "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
  "sheets.google.com":
    "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
  "slides.google.com":
    "https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png",
  "keep.google.com":
    "https://www.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png",
  "youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
  "music.youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_music_2020q4_48dp.png",
};

function agentBrandIconFor(url) {
  try {
    const raw = String(url || "");
    const u = new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return "";
    const host = u.hostname.replace(/^www\./i, "");
    if (host === "docs.google.com") {
      if (raw.includes("/document/")) return AGENT_BRAND_ICON_BY_HOST["docs.google.com"];
      if (raw.includes("/spreadsheets/")) return AGENT_BRAND_ICON_BY_HOST["sheets.google.com"];
      if (raw.includes("/presentation/")) return AGENT_BRAND_ICON_BY_HOST["slides.google.com"];
    }
    if (host === "google.com" && raw.includes("/calendar/")) {
      return AGENT_BRAND_ICON_BY_HOST["calendar.google.com"];
    }
    return AGENT_BRAND_ICON_BY_HOST[host] || "";
  } catch {
    return "";
  }
}

/** Favicon for a page host — brand icons for Google products, else S2. */
function agentFaviconFallback(url) {
  const brand = agentBrandIconFor(url);
  if (brand) return brand;
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/i.test(u.protocol)) return "";
    const host = u.hostname.replace(/^www\./i, "");
    if (!host) return "";
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return "";
  }
}

function isAgentArtifactTabId(id) {
  return /^art-/.test(String(id || ""));
}

// ── Studio browser history ──────────────────────────────────────────────────
// Chrome-style: tabs stay open until the user exits them; a closed tab (or a
// deleted agent) drops into the History list the Studio rail shows under its
// Agents section. Persisted to userData so history survives restarts.
const AGENT_BROWSER_HISTORY_MAX = 200;
let agentBrowserHistoryCache = null;

function agentBrowserHistoryFile() {
  return path.join(app.getPath("userData"), "agent-browser-history.json");
}

function readAgentBrowserHistory() {
  if (agentBrowserHistoryCache) return agentBrowserHistoryCache;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(agentBrowserHistoryFile(), "utf8"));
    agentBrowserHistoryCache = Array.isArray(parsed?.items) ? parsed.items : [];
  } catch (_) {
    agentBrowserHistoryCache = [];
  }
  return agentBrowserHistoryCache;
}

function persistAgentBrowserHistory() {
  try {
    fsSync.writeFileSync(
      agentBrowserHistoryFile(),
      JSON.stringify({ items: readAgentBrowserHistory() }),
    );
  } catch (_) {
    /* history is best-effort */
  }
}

function pushAgentBrowserHistory() {
  emitAgentToUi("lykn:agent-browser-history", { items: readAgentBrowserHistory() });
}

/** Capture a closing tab/agent's identity BEFORE its view is torn down.
 *  Returns null for artifact previews (not browsing history). */
function snapshotAgentBrowserHistory(tabId) {
  const id = String(tabId || "").trim();
  if (!id || isAgentArtifactTabId(id)) return null;
  const view = agentBrowserViews.get(id);
  const meta = agentBrowserMeta.get(id) || {};
  let url = meta.url || "";
  let pageTitle = meta.pageTitle || "";
  try {
    if (view?.webContents && !view.webContents.isDestroyed()) {
      url = view.webContents.getURL() || url;
      pageTitle = view.webContents.getTitle() || pageTitle;
    }
  } catch (_) {}
  // Internal pages (welcome/new-tab, data blobs) aren't browsing history.
  if (/^(lykn|data|about|file|chrome):/i.test(url)) url = "";
  let title = agentBrowserLabels.get(id) || "";
  if (!title || /^new (agent|tab)$/i.test(title)) {
    try {
      const a = (agentRuntime?.listPublic?.() || []).find((x) => x.id === id);
      if (a?.title && !/^new agent$/i.test(a.title)) title = a.title;
    } catch (_) {}
  }
  if ((!title || /^new (agent|tab)$/i.test(title)) && pageTitle) title = pageTitle;
  // Capture the agent's conversation so reopening from History restores the
  // full chat, not just the page.
  let history = [];
  try {
    history = (agentRuntime?.getHistory?.(id) || [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-40)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000), at: m.at }));
  } catch (_) {}
  return { tabId: id, title: title || "Agent", pageTitle, url, history };
}

/** Push a captured snapshot into history (call after the close succeeded).
 *  Blank new-tab pages that never navigated anywhere are skipped. */
function commitAgentBrowserHistory(snap) {
  if (!snap) return;
  const hasChat = Array.isArray(snap.history) && snap.history.length > 0;
  // Skip only truly empty tabs (no page AND no conversation).
  if (!snap.url && !hasChat && (!snap.title || /^(new (agent|tab)|agent)$/i.test(snap.title))) {
    return;
  }
  const items = readAgentBrowserHistory();
  items.unshift({
    id: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: snap.title,
    pageTitle: snap.pageTitle || "",
    url: snap.url || "",
    history: hasChat ? snap.history : [],
    closedAt: new Date().toISOString(),
  });
  if (items.length > AGENT_BROWSER_HISTORY_MAX) items.length = AGENT_BROWSER_HISTORY_MAX;
  persistAgentBrowserHistory();
  pushAgentBrowserHistory();
}

function isAgentIncognito(agentId) {
  return !!agentIncognito.get(String(agentId || "").trim());
}

function agentBrowserPartition(agentId) {
  const id = String(agentId || "").trim();
  // A sub-tab lives in its OWNER's partition: an agent that signed in on its
  // first tab must still be signed in on the tab it opens next, and an
  // incognito agent's sub-tabs must share its incognito session rather than
  // each minting their own.
  const owner = agentTabIds.partitionOwner(id);
  return isAgentIncognito(owner)
    ? `lykn-agent-incognito-${owner}`
    : AGENT_BROWSER_SHARED_PARTITION;
}

/**
 * Home page for a fresh agent tab. A real search page (rather than the branded
 * welcome document) means a new tab is immediately a page the agent can act on,
 * which keeps the browser + agent loop straightforward to reason about.
 */
const AGENT_BROWSER_HOME_URL = "https://www.google.com";

/** Bare Google homepage (new-tab home) — omnibox stays empty so typing starts clean. */
function isAgentBrowserHomeUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (!/^https?:$/i.test(u.protocol)) return false;
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "google.com") return false;
    const path = (u.pathname || "/").replace(/\/+$/, "") || "";
    return !path && !u.search && !u.hash;
  } catch (_) {
    return false;
  }
}

function loadAgentBrowserHome(wc) {
  if (!wc || wc.isDestroyed?.()) return;
  applyAgentTabEmulation(wc);
  try {
    void wc.loadURL(AGENT_BROWSER_HOME_URL);
  } catch (_) {}
}

/**
 * What the page sees in JS about the browser it is running in. The UA string
 * (app.userAgentFallback) and the Sec-CH-UA headers (wireAgentSessionClientHints)
 * already read as plain desktop Chrome, but navigator.userAgentData is built
 * from Chromium's own brand list and still names Electron. Brands here mirror
 * the header rewriting so both tell the same story.
 */
function chromeUserAgentOverride() {
  const full = String(process.versions.chrome || "").trim();
  const major = full.split(".")[0] || "";
  const userAgent = String(app.userAgentFallback || "").trim();
  if (!major || !userAgent) return null;
  const brand = (name, version) => ({ brand: name, version });
  let platformVersion = "";
  try {
    platformVersion = String(process.getSystemVersion?.() || "").trim();
  } catch (_) {}
  return {
    userAgent,
    userAgentMetadata: {
      brands: [brand("Chromium", major), brand("Google Chrome", major), brand("Not?A_Brand", "99")],
      fullVersionList: [
        brand("Chromium", full),
        brand("Google Chrome", full),
        brand("Not?A_Brand", "99.0.0.0"),
      ],
      platform:
        process.platform === "win32"
          ? "Windows"
          : process.platform === "darwin"
            ? "macOS"
            : "Linux",
      platformVersion,
      architecture: process.arch === "arm64" ? "arm" : "x86",
      bitness: "64",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
}

/**
 * The two things every agent tab has to be told about itself, both over CDP
 * because Electron has no per-view API for either. Run before the navigation so
 * the first paint and the first request already carry them.
 *
 * Light mode: the shell pins nativeTheme to dark for the glass vibrancy (see
 * themeSource near the top) and there is no per-view theme source, so Google
 * and every other site reading prefers-color-scheme loaded dark.
 *
 * Client hints: navigator.userAgentData hands the page Electron's brand however
 * clean the UA string and the headers are, and that is what "Sign in with
 * Google" reads before it decides whether to open its popup at all. Sites built
 * on Google Identity Services simply do nothing when they see it — no wall, no
 * error, a button that doesn't respond — which is why some logins came up and
 * others never appeared. Overriding the UA here sets the string and the
 * metadata behind navigator.userAgentData together.
 *
 * Idempotent and best-effort: a DevTools session takes over the CDP target and
 * drops all of it, so this is re-asserted on every navigation.
 */
function applyAgentTabEmulation(wc) {
  if (!wc || wc.isDestroyed?.()) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  } catch (_) {
    return;
  }
  // sendCommand rejects rather than throwing, so a try/catch around it catches
  // nothing and the failure surfaces as an unhandled rejection instead. It does
  // fail in normal use: called on a view that has never navigated, before there
  // is a CDP target to talk to, it comes back "target closed".
  const send = (method, params) => {
    try {
      wc.debugger.sendCommand(method, params).catch(() => {});
    } catch (_) {}
  };
  const ua = chromeUserAgentOverride();
  if (ua) send("Emulation.setUserAgentOverride", ua);
  send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
}

/**
 * Chrome-style omnibox: turn whatever the user typed into something loadable.
 * Real URLs (scheme, localhost, IPs, host.tld[/path]) navigate directly;
 * everything else becomes a Google search.
 */
function omniboxToUrl(input) {
  const q = String(input || "").trim();
  if (!q) return "";
  if (/^https?:\/\//i.test(q) || /^about:blank$/i.test(q)) return q;
  const hostish =
    !/\s/.test(q) &&
    (/^localhost(:\d+)?([/?#]|$)/i.test(q) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(q) ||
      /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(q));
  if (hostish) return `https://${q}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function agentStageUrlAllowed(url) {
  const u = String(url || "");
  return (
    /^https?:\/\//i.test(u) ||
    /^about:blank$/i.test(u) ||
    /^lykn-artifact:\/\//i.test(u) ||
    /^data:text\/html/i.test(u)
  );
}

/** Login / SSO URLs that must open as real popups (window.opener + shared cookies). */
function looksLikeAgentAuthPopupUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u || u === "about:blank") return true;
  return (
    /accounts\.google\.|gsi\.google\.|appleid\.apple\.|login\.microsoftonline\.|login\.live\.|facebook\.com\/|login\.yahoo\.|auth0\.|\.okta\.|oauth|openid|sso|saml/i.test(
      u,
    ) ||
    /canva\.com\/.*(login|signup|signin|oauth|sso)/i.test(u) ||
    /\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|register)(\/|\?|#|$)/i.test(u)
  );
}

/**
 * Parent for OAuth / SSO popups. Prefer a *visible* host — when Studio Browser
 * is docked, agentStageWindow is hidden, and parenting to it makes Google /
 * Apple / Microsoft login windows open behind Studio (or never surface).
 */
function agentAuthPopupParentWindow() {
  try {
    if (studioStageEmbedActive()) {
      const studio = studioWindow && !studioWindow.isDestroyed() ? studioWindow : null;
      if (studio) return studio;
    }
  } catch (_) {}
  try {
    if (
      agentStageWindow &&
      !agentStageWindow.isDestroyed() &&
      agentStageWindow.isVisible()
    ) {
      return agentStageWindow;
    }
  } catch (_) {}
  try {
    if (studioWindow && !studioWindow.isDestroyed() && studioWindow.isVisible()) {
      return studioWindow;
    }
  } catch (_) {}
  return undefined;
}

/** Show + focus a sign-in popup over the Studio / stage so login is one click away. */
function presentAgentAuthPopup(childWindow) {
  if (!childWindow || childWindow.isDestroyed?.()) return;
  try {
    childWindow.setMenuBarVisibility?.(false);
  } catch (_) {}
  const parent = agentAuthPopupParentWindow();
  try {
    // Re-parent if Electron attached to a hidden stage while Studio is docked.
    if (parent && typeof childWindow.setParentWindow === "function") {
      const cur = childWindow.getParentWindow?.();
      if (cur !== parent) childWindow.setParentWindow(parent);
    }
  } catch (_) {}
  try {
    const pb =
      parent && !parent.isDestroyed()
        ? typeof parent.getContentBounds === "function"
          ? parent.getContentBounds()
          : parent.getBounds()
        : null;
    if (pb && pb.width > 0 && pb.height > 0) {
      const cb = childWindow.getBounds();
      const w = Math.max(360, cb.width || 560);
      const h = Math.max(480, cb.height || 740);
      childWindow.setBounds({
        x: Math.round(pb.x + Math.max(0, (pb.width - w) / 2)),
        y: Math.round(pb.y + Math.max(0, (pb.height - h) / 2)),
        width: w,
        height: h,
      });
    } else {
      childWindow.center();
    }
  } catch (_) {
    try {
      childWindow.center();
    } catch (_) {}
  }
  try {
    // Raise the host first, then the popup — moveTop on parent after the
    // child can bury the Sign in window under Studio on macOS.
    if (parent && !parent.isDestroyed()) {
      if (!parent.isVisible()) parent.show();
      parent.moveTop();
    }
    if (!childWindow.isVisible()) childWindow.show();
    childWindow.moveTop();
    childWindow.focus();
  } catch (_) {}
}

function wireAgentPopupWindow(childWindow, { parentWc, agentId } = {}) {
  if (!childWindow || childWindow.isDestroyed?.()) return;
  presentAgentAuthPopup(childWindow);
  const childWc = childWindow.webContents;
  if (!childWc || childWc.isDestroyed?.()) return;
  try {
    // Same chrome UA as the rest of the app (strip Electron token).
    if (app.userAgentFallback) childWc.setUserAgent(app.userAgentFallback);
  } catch (_) {}
  // This is the window accounts.google.com actually loads in, and it checks the
  // browser it's running in as hard as the opener did — the "This browser or app
  // may not be secure" wall. Re-asserted per navigation: an OAuth flow crosses
  // several documents in here, some of them in a different process.
  applyAgentTabEmulation(childWc);
  childWc.on("did-navigate", () => applyAgentTabEmulation(childWc));
  childWc.setWindowOpenHandler((details) => {
    const u = String(details?.url || "");
    if (!agentStageUrlAllowed(u)) return { action: "deny" };
    // Nested OAuth steps — keep popping real windows on the same partition.
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 560,
        height: 740,
        autoHideMenuBar: true,
        title: "Sign in",
        parent: agentAuthPopupParentWindow(),
        webPreferences: {
          partition: agentBrowserPartition(agentId),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });
  childWc.on("did-create-window", (nested) => {
    presentAgentAuthPopup(nested);
    wireAgentPopupWindow(nested, { parentWc, agentId });
  });
  childWc.on("will-navigate", (event, url) => {
    if (!agentStageUrlAllowed(url)) event.preventDefault();
  });
  childWc.session?.setPermissionRequestHandler?.((_w, permission, callback) => {
    const allow =
      permission === "fullscreen" ||
      permission === "clipboard-sanitized-write" ||
      permission === "clipboard-read";
    callback(allow);
  });
  // OAuth runs in this popup — it needs the same Chrome-looking client hints.
  wireAgentSessionClientHints(childWc.session);
  // If the opener navigates the popup after about:blank, re-raise it once.
  const raiseOnNavigate = () => {
    try {
      presentAgentAuthPopup(childWindow);
    } catch (_) {}
  };
  childWc.once("did-finish-load", raiseOnNavigate);
  childWc.once("dom-ready", raiseOnNavigate);
  childWindow.on("closed", () => {
    // Parent site finishes auth via postMessage + cookies on the shared partition.
    try {
      pushAgentStageState();
      layoutAgentStageViews();
    } catch (_) {}
    try {
      if (!parentWc || parentWc.isDestroyed?.()) return;
      const cur = String(parentWc.getURL?.() || "");
      const blank =
        !cur ||
        /^about:blank$/i.test(cur) ||
        ownedBrowserAct.isPlaceholderAgentUrl(cur);
      if (!blank) return;
      const meta = agentBrowserMeta.get(agentId) || {};
      const resume = String(meta.lastHttpsUrl || meta.url || "").trim();
      if (/^https?:\/\//i.test(resume)) {
        void parentWc.loadURL(resume);
      }
    } catch (_) {}
  });
}

function agentStageVisible() {
  return !!(
    agentStageWindow &&
    !agentStageWindow.isDestroyed() &&
    agentStageWindow.isVisible()
  );
}

// ── Studio-docked browser ───────────────────────────────────────────────────
// The Studio's "Browser" tab docks the agent stage inside the Studio window:
// the stage chrome (tab strip / toolbar) renders in its own WebContentsView
// and the shared agent browser views are re-parented onto the Studio window
// at the panel bounds the renderer reports via `lykn:studio-browser-set`.
let studioStageChromeView = null;
let studioStageBounds = null; // DIP rect within the studio window's content
let studioStageEmbedded = false;
// True while the Studio Browser window is being fully closed (red traffic
// light). Closing the last tab must not spawn a replacement — the next open
// starts a fresh session. Minimize never sets this.
let studioBrowserDisposing = false;
// The browser docks into the body of the Studio's floating Browser window:
// square along the top, where the window's own title bar sits, and rounded at
// the bottom to sit concentric with the frame's corners. The renderer owns
// that radius (it knows the frame) and reports it with the bounds; this is
// just the fallback until the first report lands.
const STUDIO_DOCK_RADIUS = 14;
let studioStageRadius = STUDIO_DOCK_RADIUS;

function studioStageEmbedActive() {
  return !!(studioStageEmbedded && studioWindow && !studioWindow.isDestroyed());
}

// WebContentsView attach/detach helpers (BrowserWindow.contentView children;
// re-adding an attached view moves it to the top of the stack).
// addChildView re-orders a view that is already attached, which is how the
// active page gets raised above the chrome. Layout runs on every bounds report
// — drag, resize, load event — and re-stacking the hierarchy that often makes
// the browser flicker, so remember what is on top and only restack on change.
// Any attach/detach from anywhere else drops the memo.
let agentStageStackKey = "";

function attachViewToWindow(win, view) {
  if (!win || win.isDestroyed() || !view) return;
  agentStageStackKey = "";
  try {
    win.contentView.addChildView(view);
  } catch (_) {}
}

function detachViewFromWindow(win, view) {
  if (!win || win.isDestroyed() || !view) return;
  agentStageStackKey = "";
  try {
    win.contentView.removeChildView(view);
  } catch (_) {}
}

function setViewVisible(view, visible) {
  try {
    view?.setVisible?.(visible);
  } catch (_) {}
}

function raiseAgentStageView(win, view, key) {
  if (agentStageStackKey === key) return;
  attachViewToWindow(win, view);
  agentStageStackKey = key;
}

function setViewRadius(view, radius) {
  try {
    view?.setBorderRadius?.(Math.max(0, Math.round(Number(radius) || 0)));
  } catch (_) {}
}

/** Place a docked view, then clip it. Electron applies `setBorderRadius`
 *  against the current box and does not restore it on the next `setBounds`,
 *  so parking a page at 0×0 until first paint used to wipe the curve and
 *  leave every later layout square at the window's bottom corners. */
function setDockedViewBounds(view, bounds, { radius = 0 } = {}) {
  if (!view || !bounds) return;
  try {
    view.setBounds(bounds);
  } catch (_) {}
  const w = Math.max(0, Number(bounds.width) || 0);
  const h = Math.max(0, Number(bounds.height) || 0);
  if (w >= 2 && h >= 2 && radius > 0) setViewRadius(view, radius);
}

function ensureStudioStageChromeView() {
  if (
    studioStageChromeView &&
    studioStageChromeView.webContents &&
    !studioStageChromeView.webContents.isDestroyed()
  ) {
    return studioStageChromeView;
  }
  studioStageChromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "agent-stage-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Light chrome from the very first frame — no glass showing through while
  // agent-stage.html loads.
  try {
    studioStageChromeView.setBackgroundColor("#ececeb");
  } catch (_) {}
  // The chrome is the top of the floating window — its tab strip stands in for
  // the title bar — so it wears the frame's corner curve. The matching curve it
  // also cuts along its bottom sits hidden behind the page view.
  setViewRadius(studioStageChromeView, studioStageRadius);
  studioStageChromeView.webContents.loadFile(path.join(__dirname, "agent-stage.html"));
  studioStageChromeView.webContents.on("did-finish-load", () => {
    pushAgentStageState();
    layoutAgentStageViews();
  });
  return studioStageChromeView;
}

// Out of sight, the docked views sit at the panel's exact size but shifted
// clear of the Studio window's right edge, which clips them. They stay visible
// to Chromium there, so each page holds a live frame at the size it will come
// back at and the reveal is a plain move — nothing to re-render, nothing to
// reflow. Hiding them instead (View.setVisible) drops those frames, and the
// page returns as a blurry stretch of the last one until the compositor
// rebuilds it. Detaching them to the standalone stage window is worse again:
// that window's layout pass reflows every page into its size and back out, the
// second reflow landing after the page is on screen, as a jump.
let studioStageRevealed = false;

/** How far right of the window the parked views sit, in DIP. 0 once revealed. */
function studioStageParkShift() {
  if (studioStageRevealed) return 0;
  let contentW = 0;
  try {
    if (studioWindow && !studioWindow.isDestroyed()) {
      [contentW] = studioWindow.getContentSize();
    }
  } catch (_) {}
  const paneRight = studioStageBounds
    ? studioStageBounds.x + studioStageBounds.width
    : 0;
  return Math.max(contentW, paneRight, 0) + 40;
}

// The Studio doesn't hand over its final pane rect in one go: the frame reports
// itself as it opens, and an unplaced frame measures at the desktop's top-left
// before its geometry lands. A page revealed on the first report wears the tail
// of that as a pop up to the corner, so a fresh dock stays parked (the
// renderer's skeleton stands in) until the rect has held still.
const STUDIO_STAGE_REVEAL_SETTLE_MS = 90;
let studioStageRevealTimer = null;

function cancelStudioStageReveal() {
  if (!studioStageRevealTimer) return;
  clearTimeout(studioStageRevealTimer);
  studioStageRevealTimer = null;
}

function revealStudioStageViewsWhenSettled() {
  cancelStudioStageReveal();
  studioStageRevealTimer = setTimeout(() => {
    studioStageRevealTimer = null;
    if (!studioStageEmbedActive()) return;
    studioStageRevealed = true;
    layoutAgentStageViews();
  }, STUDIO_STAGE_REVEAL_SETTLE_MS);
}

/**
 * Hand the views back to the standalone stage window — what happens when the
 * Studio window itself goes away, taking the only window they were attached to
 * with it.
 */
function parkStudioStageViewsOnStage() {
  cancelStudioStageReveal();
  const studio = studioWindow && !studioWindow.isDestroyed() ? studioWindow : null;
  if (studio) {
    detachViewFromWindow(studio, studioStageChromeView);
    for (const view of agentBrowserViews.values()) detachViewFromWindow(studio, view);
  }
  // Square corners again, and visible: nothing hides them over there.
  for (const view of agentBrowserViews.values()) {
    setViewRadius(view, 0);
    setViewVisible(view, true);
    if (agentStageWindow && !agentStageWindow.isDestroyed()) {
      attachViewToWindow(agentStageWindow, view);
    }
  }
  if (agentStageWindow && !agentStageWindow.isDestroyed()) layoutAgentStageViews();
}

/** Dock (open) or undock (close) the agent browser inside the Studio window. */
function setStudioBrowserEmbed({ open, bounds, radius } = {}) {
  if (!open) {
    if (!studioStageEmbedded) return;
    cancelStudioStageReveal();
    // Parked before the dock goes inactive, so this layout still runs the
    // docked branch. Same window, same size, same zoom — only shifted off the
    // edge, ready to move straight back in.
    studioStageRevealed = false;
    layoutAgentStageViews();
    studioStageEmbedded = false;
    return;
  }

  if (!studioWindow || studioWindow.isDestroyed()) return;
  let paneMoved = false;
  if (bounds && typeof bounds === "object") {
    // x/y may be negative: the Browser window can be dragged past the desktop's
    // edges, and the window clips whatever hangs off. Pinning them to 0 would
    // slide the page back out from under its own frame.
    const next = {
      x: Math.round(Number(bounds.x) || 0),
      y: Math.round(Number(bounds.y) || 0),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    paneMoved =
      !studioStageBounds ||
      studioStageBounds.x !== next.x ||
      studioStageBounds.y !== next.y ||
      studioStageBounds.width !== next.width ||
      studioStageBounds.height !== next.height;
    studioStageBounds = next;
    // Before the views are attached below: a Studio resized while the browser
    // was closed re-flows its pages off-screen this way, instead of in front of
    // the user a frame after they reappear.
    fitAgentTabsToPane(studioStageBounds.width);
  }
  // The window frame's radius can only reach the views from the renderer, so
  // pick it up here and repaint any that are already docked.
  if (Number.isFinite(Number(radius))) {
    const next = Math.max(0, Math.round(Number(radius)));
    if (next !== studioStageRadius) {
      studioStageRadius = next;
      if (studioStageEmbedded) {
        for (const view of agentBrowserViews.values()) setViewRadius(view, next);
        setViewRadius(studioStageChromeView, next);
      }
    }
  }
  const freshDock = !studioStageEmbedded;
  if (freshDock) {
    studioStageEmbedded = true;
    // The browser lives in exactly one window at a time — reclaim the views
    // from the standalone stage window.
    if (agentStageWindow && !agentStageWindow.isDestroyed()) {
      if (agentStageWindow.isVisible()) agentStageWindow.hide();
      for (const view of agentBrowserViews.values()) {
        detachViewFromWindow(agentStageWindow, view);
      }
    }
    const chrome = ensureStudioStageChromeView();
    attachViewToWindow(studioWindow, chrome);
    for (const view of agentBrowserViews.values()) {
      setViewRadius(view, studioStageRadius);
      attachViewToWindow(studioWindow, view);
    }
    // Tabs wait on the persisted agent list so a raced load() can't add
    // restored workers on top of the fresh tab warm already created.
    void whenAgentRuntimeLoaded().then(() => {
      if (!studioStageEmbedActive()) return;
      fillEmptyStudioBrowser({ show: false });
      pushAgentStageState();
      layoutAgentStageViews();
    });
    pushAgentStageState();
    // Parked for the layout below, however they arrived: the pages take the new
    // panel size off the edge of the window and are done reflowing to it before
    // anyone sees them. The first dock of the session and every one after it
    // open the same way.
    studioStageRevealed = false;
    // Freshly docked: take a picture as soon as the page has settled, so the
    // close that follows has the browser as it actually looks to animate over.
    scheduleStudioStageShot(600);
  }
  layoutAgentStageViews();
  // Arm the reveal on the dock, and push it back out every time the pane lands
  // somewhere new — the page appears once, already at its final size, however
  // many rects the opening window reports on the way there.
  if (freshDock || (studioStageRevealTimer && paneMoved)) {
    revealStudioStageViewsWhenSettled();
  }
}

/**
 * Put the caret in the stage omnibox (Search or type a URL), like Chrome on
 * a fresh tab. Focuses the chrome WebContents first so keystrokes aren't
 * swallowed by the page view underneath.
 */
function focusAgentStageOmnibox() {
  try {
    if (
      studioStageEmbedActive() &&
      studioStageChromeView?.webContents &&
      !studioStageChromeView.webContents.isDestroyed()
    ) {
      studioStageChromeView.webContents.focus();
      studioStageChromeView.webContents.send("lykn:agent-stage-focus-omnibox");
      return;
    }
  } catch (_) {}
  try {
    if (agentStageWindow && !agentStageWindow.isDestroyed()) {
      agentStageWindow.webContents.focus();
      agentStageWindow.webContents.send("lykn:agent-stage-focus-omnibox");
    }
  } catch (_) {}
}

/** Focus the omnibox now and again when this tab's home page finishes loading
 *  (page views otherwise steal focus once Google paints). */
function requestOmniboxFocusForTab(agentId) {
  const id = String(agentId || "").trim();
  if (!id) return;
  agentStagePendingOmniboxFocusId = id;
  focusAgentStageOmnibox();
  setTimeout(() => {
    if (agentStagePendingOmniboxFocusId === id) focusAgentStageOmnibox();
  }, 250);
}

/** Fresh Studio browser tab. Every tab is agent-backed: a new tab always
 *  brings its own agent into the rail, and closing either side closes both.
 *  Falls back to a plain (agent-less) tab only if the agent cap is hit. */
function openFreshStudioBrowserTab({ show = true, focusOmnibox = false } = {}) {
  if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) return;
  try {
    const rt = initAgentRuntime();
    if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    // Silent so createAgent doesn't raise the standalone stage (and so
    // setAgentMode no longer also spawns a second standby worker).
    const res = rt.createAgent({ title: "New agent", silent: true, activate: true });
    if (res?.ok && res.agentId) {
      ensureAgentBrowserWindow(res.agentId, {
        show,
        focus: true,
        label: res.agent?.title || "New agent",
      });
      if (focusOmnibox) requestOmniboxFocusForTab(res.agentId);
      return;
    }
  } catch (_) {}
  try {
    const id = `studio-tab-${Date.now()}`;
    ensureAgentBrowserWindow(id, {
      show: false,
      focus: true,
      label: "New tab",
    });
    if (focusOmnibox) requestOmniboxFocusForTab(id);
  } catch (_) {}
}

/**
 * Get the browser ready before it is ever shown. The Browser window's open
 * animation runs with the native views undocked, and that is enough time to
 * load the stage chrome and the first tab's home page — so docking reveals a
 * painted page instead of leaving the renderer's underlay up through a cold
 * tab creation plus a network load. Idempotent: warming an already-warm
 * browser does nothing.
 */
function fillEmptyStudioBrowser({ show = false } = {}) {
  try {
    initAgentRuntime().ensureAgentTabs?.();
  } catch (_) {}
  if (!agentBrowserViews.size) openFreshStudioBrowserTab({ show });
}

async function warmStudioBrowser() {
  if (!studioWindow || studioWindow.isDestroyed()) return;
  try {
    ensureStudioStageChromeView();
  } catch (_) {}
  await whenAgentRuntimeLoaded();
  if (agentBrowserViews.size) return;
  fillEmptyStudioBrowser({ show: false });
}

/** Red traffic light: close the Studio Browser window for real. Tabs go to
 *  History, agents are retired, views are destroyed. The next press warms a
 *  fresh session. Minimize never calls this — it only undocks the views. */
function closeStudioBrowserSession() {
  const tabIds = [...agentBrowserViews.keys()];
  const snaps = tabIds.map((id) => snapshotAgentBrowserHistory(id));
  studioBrowserDisposing = true;
  try {
    try {
      setStudioBrowserEmbed({ open: false });
    } catch (_) {}
    try {
      initAgentRuntime().closeAllWorkers?.();
    } catch (_) {}
    for (const id of [...agentBrowserViews.keys()]) {
      destroyAgentBrowserWindow(id);
    }
    for (const snap of snaps) commitAgentBrowserHistory(snap);
    try {
      void initAgentRuntime().persistNow?.();
    } catch (_) {}
    pushAgentStageState();
  } finally {
    studioBrowserDisposing = false;
  }
  return { ok: true };
}

/** Open a manual browser tab already navigated to `url` (used by Chrome sync).
 *  Returns the tab id, or null when at the tab cap / on failure. */
function openStudioBrowserTabWithUrl(url, { focus = false } = {}) {
  if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) return null;
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return null;
  const id = `studio-tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    const wrap = ensureAgentBrowserWindow(id, { show: false, focus, label: "Loading…" });
    const wc = wrap?.webContents;
    if (wc && !wc.isDestroyed()) {
      // Fire-and-forget: the tab strip updates from the view's own load events.
      ownedBrowserAct.navigate(wc, target).catch(() => {});
    }
    return id;
  } catch (_) {
    return null;
  }
}

/** Canonical form for de-duping tabs during Chrome sync: drop scheme/#hash,
 *  strip "www." and trailing slashes, lowercase host. Keeps the query (it
 *  usually distinguishes real pages). Returns "" for non-http(s) URLs. */
function normalizeSyncUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/.test(u.protocol)) return "";
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search || ""}`;
  } catch {
    return "";
  }
}

/** Open a real AGENT tab navigated to `url` — each synced tab becomes its own
 *  agent so the AI can act on it. Returns the agent id, or null on cap/failure.
 *  `show:false` creates the tab without raising the hosting window — for
 *  callers about to dock the browser somewhere else (Studio Browser tab). */
function openAgentBrowserTabWithUrl(url, { title, focus = false, show = true } = {}) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return null;
  if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) return null;
  let label = String(title || "").trim();
  if (!label) {
    try {
      label = new URL(target).hostname.replace(/^www\./, "");
    } catch {
      label = "Tab";
    }
  }
  try {
    const rt = initAgentRuntime();
    if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    // When show is false (Studio about to dock), create the agent quietly so
    // we don't flash the standalone stage + welcome page, then clobber the
    // real navigation when docking re-calls ensure.
    const res = rt.createAgent({ title: label, activate: focus, silent: !show });
    if (!res?.ok || !res.agentId) return null;
    const id = res.agentId;
    // Mark browsing BEFORE ensure/show so a concurrent dock can't reload welcome.
    agentBrowserLabels.set(id, label);
    agentBrowserMeta.set(id, {
      ...(agentBrowserMeta.get(id) || {}),
      kind: "browsing",
      url: target,
      pageTitle: label,
    });
    if (show) {
      showAgentBrowserWindow(id, { focus, label });
    } else {
      ensureAgentBrowserWindow(id, { show: false, focus, label });
    }
    const wc = getAgentBrowserWebContents(id);
    if (wc && !wc.isDestroyed()) {
      // Fire navigate but keep meta.kind=browsing until load settles so docking
      // mid-flight cannot wipe the tab back to the welcome page.
      ownedBrowserAct
        .navigate(wc, target)
        .then((nav) => {
          const meta = agentBrowserMeta.get(id) || {};
          if (meta.kind !== "browsing") return;
          agentBrowserMeta.set(id, {
            ...meta,
            kind: "page",
            url: nav?.url || target,
            pageTitle: label,
          });
          try {
            rt.setAgentUrl?.(id, nav?.url || target);
          } catch (_) {}
          pushAgentStageState();
        })
        .catch((err) => {
          console.warn("[lykn] agent tab navigate failed:", err?.message || err);
        });
    }
    return id;
  } catch (_) {
    return null;
  }
}

// ── Private browsing-habits context (Chrome sync) ────────────────────────────
// Kept for the AGENT only — folded into agent prompts so it knows what the user
// usually does. Never shown to the user as a report/chat turn. Persisted so it
// survives restarts.
let browsingHabitsContext = "";

function browsingContextFile() {
  return path.join(app.getPath("userData"), "browsing-context.json");
}

function loadBrowsingHabitsContext() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(browsingContextFile(), "utf8"));
    browsingHabitsContext = String(parsed?.context || "");
  } catch (_) {
    browsingHabitsContext = "";
  }
  return browsingHabitsContext;
}

function getBrowsingContext() {
  return browsingHabitsContext;
}

/** Build + store a concise, private habits summary from history. Returns true
 *  when something was stored. No AI call, no visible turn. */
function setBrowsingContextFromHistory(history, browserName) {
  const items = Array.isArray(history?.items) ? history.items : [];
  const domains = Array.isArray(history?.domains) ? history.domains : [];
  if (!items.length && !domains.length) return false;
  const topDomains = domains
    .slice(0, 15)
    .map((d) => `${d.domain} (${d.visits})`)
    .join(", ");
  const topPages = items
    .slice(0, 12)
    .map((it) => `- ${it.title ? it.title.slice(0, 80) + " — " : ""}${it.url}`)
    .join("\n");
  browsingHabitsContext = [
    `Most-visited domains from the user's ${browserName || "browser"}: ${topDomains}.`,
    topPages ? `Frequently opened pages:\n${topPages}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    fsSync.writeFileSync(
      browsingContextFile(),
      JSON.stringify({ context: browsingHabitsContext, updatedAt: new Date().toISOString() }),
    );
  } catch (_) {
    /* best-effort persistence */
  }
  return true;
}

function createAgentStageWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  agentStageWindow = new BrowserWindow({
    width: Math.min(1180, workArea.width - 40),
    height: Math.min(780, workArea.height - 40),
    x: Math.round(workArea.x + 48),
    y: Math.round(workArea.y + 48),
    show: false,
    title: "LYKN Agent Browser",
    backgroundColor: "#12151c",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "agent-stage-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    agentStageWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  agentStageWindow.loadFile(path.join(__dirname, "agent-stage.html"));
  agentStageWindow.on("closed", () => {
    // If the views are docked inside the Studio window they outlive the
    // standalone stage window — don't tear them down.
    if (!studioStageEmbedActive()) {
      for (const [id, view] of [...agentBrowserViews.entries()]) {
        try {
          view.webContents?.close?.();
        } catch (_) {}
        agentBrowserViews.delete(id);
      }
      agentStageActiveId = null;
    }
    agentStageWindow = null;
  });
  agentStageWindow.on("resize", () => layoutAgentStageViews());
  agentStageWindow.webContents.on("did-finish-load", () => {
    pushAgentStageState();
    layoutAgentStageViews();
  });
}

function ensureAgentStageWindow() {
  if (!agentStageWindow || agentStageWindow.isDestroyed()) createAgentStageWindow();
  return agentStageWindow;
}

/** Height the tab strip + toolbar occupy above the page, as the stage reports it. */
function agentStageChromeH() {
  return Math.max(60, Math.min(140, agentStageChromeHeight || AGENT_STAGE_CHROME_DEFAULT));
}

// ── A picture of the browser, for the window's own motion ───────────────────
// Native views are not part of the renderer's paint, so CSS can neither scale
// nor fade them: the Studio has to take them away while its Browser window
// flies open or shut. That left the page blinking out of existence at the start
// of a close and appearing whole at the end of an open — an animation with
// nothing in it, which reads as the window simply popping in and out.
//
// So keep a still picture of the browser and let the frame animate that. Chrome
// (tab strip) and page are separate views, hence two images, stacked back
// together in the renderer at the same seam the layout uses.
//
// The picture is also what makes the *next* open animate: the renderer holds on
// to the last one, so a closed browser still has itself to grow back from,
// exactly as the user left it.
let studioStageShotTimer = null;
let studioStageShotAt = 0;
// Pages change in bursts (navigate → title → favicon → load), and this runs off
// that same signal, so it waits out the burst and never repeats too often. A
// picture only has to be about as fresh as the last thing the user looked at.
const STAGE_SHOT_DEBOUNCE = 1200;
const STAGE_SHOT_MIN_GAP = 2500;

async function viewShotDataUrl(view, targetWidth) {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return "";
  try {
    let img = await wc.capturePage();
    if (!img || img.isEmpty()) return "";
    // Down to the size it will actually be drawn at: a Retina capture is four
    // times the pixels for detail that only exists while the window is in
    // motion, and this crosses to the renderer as a string.
    const w = Math.round(Number(targetWidth) || 0);
    if (w > 0 && img.getSize().width > w) img = img.resize({ width: w, quality: "good" });
    // JPEG, not PNG: shown for a couple of hundred milliseconds, in motion,
    // under a fade. Nobody reads text off it, and lossless would be megabytes.
    return `data:image/jpeg;base64,${img.toJPEG(70).toString("base64")}`;
  } catch (_) {
    return "";
  }
}

async function refreshStudioStageShot() {
  if (!studioStageEmbedActive()) return;
  const shotWidth = studioStageBounds?.width || 0;
  const [chrome, page] = await Promise.all([
    viewShotDataUrl(studioStageChromeView, shotWidth),
    viewShotDataUrl(agentBrowserViews.get(agentStageActiveId), shotWidth),
  ]);
  // Nothing captured — keep the previous picture rather than blanking the
  // window's animation.
  if (!chrome && !page) return;
  studioStageShotAt = Date.now();
  try {
    if (studioWindow && !studioWindow.isDestroyed()) {
      studioWindow.webContents.send("lykn:studio-browser-shot", {
        ok: true,
        chrome,
        page,
        chromeHeight: agentStageChromeH(),
      });
    }
  } catch (_) {}
}

function scheduleStudioStageShot(delay = STAGE_SHOT_DEBOUNCE) {
  if (!studioStageEmbedActive()) return;
  // A capture already waiting is never pushed further out: the stage can change
  // several times a second while an agent works, and re-arming on every change
  // would starve the picture for as long as the agent kept working.
  if (studioStageShotTimer) return;
  const since = Date.now() - studioStageShotAt;
  studioStageShotTimer = setTimeout(
    () => {
      studioStageShotTimer = null;
      void refreshStudioStageShot();
    },
    Math.max(delay, STAGE_SHOT_MIN_GAP - since),
  );
}

// Floor for the reference width below, and the room Google and most desktop
// sites lay out for. A pane narrower than its reference scales the page down to
// keep that layout rather than letting it reflow into a cramped breakpoint.
const AGENT_TAB_LAYOUT_WIDTH = 1280;
const AGENT_TAB_MIN_ZOOM = 0.5;
// How much of the pane's shortfall against the reference comes off the zoom. At
// 1 the page is scaled in step with how much of the desktop the window covers —
// a full-screen layout shrunk to fit, which is the intuition, but it reads far
// smaller than it needs to: the window is not trying to show a whole desktop's
// worth of page, only to avoid a cramped one. Well under 1 takes the edge off a
// narrow pane while keeping the text at a comfortable size. A window covering
// three quarters of the desktop lands at 84%, against the 74% a plain ratio
// would give it.
const AGENT_TAB_ZOOM_FALLOFF = 0.6;

/**
 * The width a browser filling the desktop would have — what every narrower pane
 * is judged against. This was a flat 1280, which quietly did nothing on a large
 * display: the floating window's size is restored from where the user last left
 * it, and any window dragged past 1280 landed on exactly 100% no matter how
 * much of the screen it actually covered. Measuring the desktop instead means
 * "floating" is relative to the screen it floats on.
 */
function agentTabReferenceWidth() {
  let deskW = 0;
  try {
    if (studioWindow && !studioWindow.isDestroyed()) [deskW] = studioWindow.getContentSize();
  } catch (_) {}
  if (!(deskW > 0)) {
    try {
      deskW = screen.getPrimaryDisplay().workAreaSize.width;
    } catch (_) {}
  }
  return Math.max(AGENT_TAB_LAYOUT_WIDTH, Math.round(Number(deskW) || 0));
}

/** Zoom that fits a desktop layout into `width` DIP of pane, with room over. */
function agentTabZoomForWidth(width) {
  const w = Math.round(Number(width) || 0);
  // Parked background view — no pane to fit yet, and zoom 0 is not a thing.
  if (w <= 0) return 0;
  const shortfall = Math.max(0, 1 - w / agentTabReferenceWidth());
  const factor = Math.round((1 - shortfall * AGENT_TAB_ZOOM_FALLOFF) * 1000) / 1000;
  // Never magnify past 100%: a pane filling the desktop just shows more.
  return Math.min(1, Math.max(AGENT_TAB_MIN_ZOOM, factor));
}

/** Last zoom logged per tab, so a steady pane doesn't repeat itself. */
const agentTabZoomLogged = new Map();

function applyAgentTabZoom(id, view, width) {
  // Artifact tabs render our own responsive report HTML — it already fits.
  if (isAgentArtifactTabId(id)) return;
  const factor = agentTabZoomForWidth(width);
  if (!factor) return;
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    if (Math.abs(wc.getZoomFactor() - factor) > 0.001) wc.setZoomFactor(factor);
    // The authoritative record of what zoom this view runs at. Input
    // coordinates must be scaled by it (ownedBrowserAct.toInputPoint) —
    // getZoomFactor answers per-origin and can disagree with the view, so the
    // setter writes down what it actually applied.
    wc.__lyknZoomFactor = factor;
  } catch (_) {
    return;
  }
  // Keyed off what we last asked for, not what the view reports: Chromium
  // scopes zoom per origin and getZoomFactor answers for the origin rather than
  // this view, so the read above rarely matches and the set runs on every
  // layout pass — which during a drag is a great many. One line per real change.
  if (agentTabZoomLogged.get(id) === factor) return;
  agentTabZoomLogged.set(id, factor);
  console.log(
    `[agent-browser] zoom ${Math.round(factor * 100)}% — ${Math.round(Number(width) || 0)}px pane of ${agentTabReferenceWidth()}px desktop`,
  );
}

/**
 * Fit every tab to the pane, not just the visible one. Zooming a tab as it is
 * raised means it re-flows in front of whoever just switched to it, and a tab
 * still loading its first document wants the right zoom before it paints, not
 * after. Re-fitting to the same width is a no-op, so this is cheap to call.
 */
function fitAgentTabsToPane(width) {
  if (!(Number(width) > 0)) return;
  for (const [id, view] of agentBrowserViews) applyAgentTabZoom(id, view, width);
}

function layoutAgentStageViews() {
  // Docked in the Studio window — lay everything out inside the panel rect
  // the Studio renderer reported instead of filling the stage window.
  if (studioStageEmbedActive() && studioStageBounds) {
    const shift = studioStageParkShift();
    const b = shift ? { ...studioStageBounds, x: studioStageBounds.x + shift } : studioStageBounds;
    const chromeH = agentStageChromeH();
    const pageH = Math.max(0, b.height - chromeH);
    const r = studioStageRadius;
    // The page view's radius cuts notches into its own top corners at the
    // seam. Extending the chrome view well below the seam (hidden behind the
    // page, which stacks on top) fills those notches with the chrome's light
    // background instead of letting the studio frost bleed through.
    setDockedViewBounds(
      studioStageChromeView,
      {
        x: b.x,
        y: b.y,
        width: b.width,
        // Menu overlay: cover the whole panel so the dropdown can draw over
        // the page (the chrome doc goes transparent outside the bars/menu).
        height: agentStageMenuOverlay
          ? b.height
          : Math.min(chromeH + r * 2, b.height),
      },
      { radius: r },
    );
    fitAgentTabsToPane(b.width);
    for (const [id, view] of agentBrowserViews) {
      try {
        if (!agentBrowserViewsReady.has(id)) {
          view.setBounds({ x: b.x, y: b.y + chromeH, width: 0, height: 0 });
          continue;
        }
        if (id === agentStageActiveId) {
          setDockedViewBounds(
            view,
            { x: b.x, y: b.y + chromeH, width: b.width, height: pageH },
            { radius: r },
          );
          if (!agentStageMenuOverlay) {
            raiseAgentStageView(studioWindow, view, `studio:page:${id}`);
          }
        } else {
          view.setBounds({ x: b.x, y: b.y + chromeH, width: 0, height: 0 });
        }
      } catch (_) {}
    }
    if (agentStageMenuOverlay && studioStageChromeView) {
      raiseAgentStageView(studioWindow, studioStageChromeView, "studio:chrome");
    }
    return;
  }
  if (!agentStageWindow || agentStageWindow.isDestroyed()) return;
  // The views land on this window when the Studio one closes, and it stays
  // hidden. Its size has nothing to do with where they will reappear, so leave
  // them exactly as the Studio left them: laying them out for a window nobody
  // is looking at reflows every page into it and then back out again, and the
  // second reflow lands after the page is on screen, as a jump.
  if (!agentStageWindow.isVisible()) return;
  const [width, height] = agentStageWindow.getContentSize();
  const chromeH = agentStageChromeH();
  const toastPad = Math.max(0, Math.min(120, agentStageToastReserve || 0));
  const pageH = Math.max(0, height - chromeH - toastPad);
  fitAgentTabsToPane(width);
  for (const [id, view] of agentBrowserViews) {
    try {
      if (!agentBrowserViewsReady.has(id)) {
        view.setBounds({ x: 0, y: chromeH, width: 0, height: 0 });
        continue;
      }
      // Standalone window: the chrome doc IS the window content and child
      // views always paint above it — park the page while the saved-links
      // dropdown is open so the menu isn't buried behind the browser.
      if (id === agentStageActiveId && !agentStageMenuOverlay) {
        view.setBounds({ x: 0, y: chromeH, width, height: pageH });
        raiseAgentStageView(agentStageWindow, view, `stage:page:${id}`);
      } else {
        // Keep attached for background loads, but park off-stage.
        view.setBounds({ x: 0, y: chromeH, width: 0, height: 0 });
      }
    } catch (_) {}
  }
}

function pushAgentStageState() {
  const stageAlive = agentStageWindow && !agentStageWindow.isDestroyed();
  const dockAlive =
    studioStageChromeView &&
    studioStageChromeView.webContents &&
    !studioStageChromeView.webContents.isDestroyed();
  if (!stageAlive && !dockAlive) return;
  const tabs = [];
  for (const [id, view] of agentBrowserViews) {
    const meta = agentBrowserMeta.get(id) || {};
    let url = meta.url || "";
    let pageTitle = meta.pageTitle || "";
    try {
      if (view?.webContents && !view.webContents.isDestroyed()) {
        url = view.webContents.getURL() || url;
        pageTitle = view.webContents.getTitle() || pageTitle;
      }
    } catch (_) {}
    const placeholder = ownedBrowserAct.isPlaceholderAgentUrl(url);
    const kind =
      meta.kind === "artifact" || isAgentArtifactTabId(id)
        ? "artifact"
        : placeholder || meta.kind === "welcome"
          ? "welcome"
          : "browse";
    if (placeholder) {
      url = "";
      // Keep the new-tab label — don't blank the title just because the
      // underlying welcome page URL is a placeholder.
      pageTitle =
        meta.pageTitle ||
        (meta.incognito || isAgentIncognito(id) ? "Incognito" : "New tab");
    }
    if (kind === "artifact") {
      if (!url || /^data:/i.test(url) || /^lykn-artifact:/i.test(url)) {
        url = meta.url && /^lykn:\/\//i.test(meta.url) ? meta.url : "lykn://artifact";
      }
      if (!pageTitle) pageTitle = agentBrowserLabels.get(id) || "Artifact";
    }
    // Brand icons beat page favicons — Electron often reports the generic
    // Google "G" for Gmail/Docs/Drive/etc. Empty welcome tabs use the LYKN
    // mark in stage chrome (no remote favicon).
    const favicon = placeholder
      ? ""
      : agentBrandIconFor(url) ||
        (typeof meta.favicon === "string" && meta.favicon) ||
        agentFaviconFallback(url) ||
        "";
    tabs.push({
      id,
      title: agentBrowserLabels.get(id) || (kind === "artifact" ? "Artifact" : "Agent"),
      url,
      pageTitle,
      favicon,
      kind,
      artifactKind: meta.artifactKind || "",
      ownerAgentId: meta.ownerAgentId || "",
    });
  }
  // Group deliverable subtabs directly under their owner tab, in creation
  // order (agentBrowserViews is insertion-ordered). Orphan artifacts (owner
  // tab gone) trail at the end.
  {
    const browse = tabs.filter((t) => t.kind !== "artifact");
    const arts = tabs.filter((t) => t.kind === "artifact");
    const ordered = [];
    for (const t of browse) {
      ordered.push(t);
      for (const a of arts) {
        if (a.ownerAgentId === t.id) ordered.push({ ...a, isSub: true });
      }
    }
    for (const a of arts) {
      if (!browse.some((t) => t.id === a.ownerAgentId)) ordered.push(a);
    }
    tabs.length = 0;
    tabs.push(...ordered);
  }
  const active = agentBrowserViews.get(agentStageActiveId);
  const activeMeta = agentBrowserMeta.get(agentStageActiveId) || {};
  let url = "";
  let title = "";
  try {
    if (active?.webContents && !active.webContents.isDestroyed()) {
      url = active.webContents.getURL() || "";
      title = active.webContents.getTitle() || "";
      if (ownedBrowserAct.isPlaceholderAgentUrl(url)) url = "";
      // New-tab home (Google) still loads in the page view, but the omnibox
      // stays empty so the user can type immediately.
      else if (isAgentBrowserHomeUrl(url)) url = "";
    }
  } catch (_) {}
  if (
    (activeMeta.kind === "artifact" || isAgentArtifactTabId(agentStageActiveId)) &&
    (!url || /^data:/i.test(url) || /^lykn-artifact:/i.test(url))
  ) {
    url = activeMeta.url && /^lykn:\/\//i.test(activeMeta.url) ? activeMeta.url : "lykn://artifact";
    title = title || activeMeta.pageTitle || agentBrowserLabels.get(agentStageActiveId) || "Artifact";
  }
  let recents = [];
  try {
    recents = agentRecentVisits.readRecents(app.getPath("userData")).items || [];
  } catch (_) {
    recents = [];
  }
  const payload = {
    tabs,
    activeAgentId: agentStageActiveId,
    url,
    title,
    incognito: agentStageActiveId
      ? isAgentIncognito(agentStageActiveId)
      : !!agentStageIncognitoDefault,
    recents,
    chatOpen: !!agentChatOpen,
  };
  if (stageAlive) {
    try {
      agentStageWindow.webContents.send("lykn:agent-stage-state", payload);
    } catch (_) {}
    try {
      agentStageWindow.setTitle(
        title
          ? `LYKN · ${agentBrowserLabels.get(agentStageActiveId) || "Agent"} · ${String(title).slice(0, 48)}`
          : "LYKN Agent Browser",
      );
    } catch (_) {}
  }
  if (dockAlive) {
    try {
      // Docked, the chrome is the floating window's title bar: it draws the
      // traffic lights and takes the drag, which it skips when it's the
      // standalone stage window with a real title bar of its own.
      studioStageChromeView.webContents.send("lykn:agent-stage-state", {
        ...payload,
        docked: true,
      });
    } catch (_) {}
  }
  // Whatever just changed about the browser, the picture the Studio animates
  // its window over is now a little out of date.
  scheduleStudioStageShot();
}

function wireAgentBrowserViewEvents(agentId, view) {
  const wc = view.webContents;
  const isArtifact = isAgentArtifactTabId(agentId);
  const bump = () => {
    try {
      const url = wc.getURL();
      const pageTitle = wc.getTitle();
      const prev = agentBrowserMeta.get(agentId) || {};
      // Keep short lykn:// chrome URLs for artifact tabs (data: URLs are huge).
      let shownUrl = url;
      if (isArtifact || prev.kind === "artifact") {
        if (
          prev.url &&
          /^lykn:\/\//i.test(prev.url) &&
          (/^data:/i.test(url) || /^lykn-artifact:/i.test(url) || !url)
        ) {
          shownUrl = prev.url;
        } else if (/^data:/i.test(url) || /^lykn-artifact:/i.test(url)) {
          shownUrl =
            prev.artifactKind === "report"
              ? "lykn://report"
              : prev.artifactKind === "video"
                ? "lykn://video"
                : prev.artifactKind === "image" ||
                    prev.artifactKind === "chart" ||
                    prev.artifactKind === "diagram"
                  ? "lykn://image"
                  : "lykn://artifact";
        }
      }
      const clean = ownedBrowserAct.isPlaceholderAgentUrl(url) ? "" : url;
      const nextKind = isArtifact
        ? "artifact"
        : /^https?:\/\//i.test(clean)
          ? "browse"
          : prev.kind === "artifact"
            ? "artifact"
            : "browse";
      // Drop a stale favicon when the host changes; page-favicon-updated refills.
      let nextFavicon = prev.favicon || "";
      try {
        const prevHost = prev.url ? new URL(prev.url).hostname : "";
        const nextHost = clean ? new URL(clean).hostname : "";
        if (prevHost && nextHost && prevHost !== nextHost) nextFavicon = "";
        if (!clean || !/^https?:\/\//i.test(clean)) nextFavicon = "";
      } catch (_) {
        nextFavicon = "";
      }
      agentBrowserMeta.set(agentId, {
        ...prev,
        url: shownUrl,
        // Remember last real https page so we can recover after a blanked login.
        ...(/^https?:\/\//i.test(clean) ? { lastHttpsUrl: clean } : {}),
        pageTitle: pageTitle || prev.pageTitle || "",
        favicon: nextFavicon,
        kind: nextKind,
        ...(nextKind === "browse" ? { artifactKind: "" } : {}),
      });
      if (!isArtifact && /^https?:\/\//i.test(clean) && !isAgentIncognito(agentId)) {
        try {
          agentRecentVisits.recordRecentVisit(app.getPath("userData"), {
            url: clean,
            title: pageTitle || "",
            favicon: nextFavicon || "",
          });
        } catch (_) {}
      }
      if (!isArtifact) {
        try {
          agentRuntime?.setAgentUrl?.(agentId, clean);
        } catch (_) {}
        emitAgentToUi("lykn:agent-browser", {
          agentId,
          url: clean,
          title: pageTitle || "",
          favicon: nextFavicon || agentFaviconFallback(clean) || "",
        });
      }
      pushAgentStageState();
      if (agentId === agentStageActiveId) layoutAgentStageViews();
    } catch (_) {}
  };
  wc.on("page-favicon-updated", (_event, favicons) => {
    try {
      const list = Array.isArray(favicons) ? favicons : [];
      const pick =
        list.find((f) => typeof f === "string" && /^https?:\/\//i.test(f)) ||
        list.find((f) => typeof f === "string" && f.startsWith("data:")) ||
        "";
      if (!pick) return;
      const prev = agentBrowserMeta.get(agentId) || {};
      if (prev.favicon === pick) return;
      agentBrowserMeta.set(agentId, { ...prev, favicon: pick });
      if (!isArtifact && prev.url && !isAgentIncognito(agentId)) {
        try {
          agentRecentVisits.updateRecentFavicon(app.getPath("userData"), {
            url: prev.url,
            favicon: pick,
          });
        } catch (_) {}
      }
      if (!isArtifact) {
        emitAgentToUi("lykn:agent-browser", {
          agentId,
          url: prev.url || "",
          title: prev.pageTitle || "",
          favicon: pick,
        });
      }
      pushAgentStageState();
    } catch (_) {}
  });
  wc.on("page-title-updated", bump);
  wc.on("did-navigate", bump);
  wc.on("did-navigate-in-page", bump);
  if (!isArtifact) {
    // Ahead of whatever this view was made to load: a tab opened straight onto
    // a URL (omnibox, a link handed over from the app) never passes through the
    // home-page loader that would otherwise set this up.
    applyAgentTabEmulation(wc);
    // A sign-in that fails in here fails quietly — the page catches its own
    // error and the button simply doesn't respond, which from outside is
    // indistinguishable from a click that never landed. Repeat what the page
    // says about its auth libraries and stay out of the way of everything else
    // a busy site logs.
    wc.on("console-message", (...args) => {
      const detail = args.find((a) => a && typeof a === "object" && typeof a.message === "string");
      const text = detail
        ? detail.message
        : String(args.find((a) => typeof a === "string") || "");
      if (!/gsi|fedcm|oauth|one ?tap|popup|accounts\.google|credential/i.test(text)) return;
      console.log(`[agent-browser] page said: ${text.slice(0, 300)}`);
    });
    // Re-assert the two per-view settings a new document resets: our CDP
    // emulation is dropped whenever something else (DevTools, a crashed
    // renderer) takes over the target, and Electron scopes zoom per origin, so
    // a new site starts back at 100% regardless of how wide the pane is.
    // Artifact tabs are excluded — exported reports have their own dark theme
    // and already fit the pane.
    wc.on("did-navigate", () => {
      applyAgentTabEmulation(wc);
      try {
        applyAgentTabZoom(agentId, view, view.getBounds?.().width);
      } catch (_) {}
    });
  }
  wc.on("did-finish-load", () => {
    bump();
    // The document is ready to paint now. Only at this point attach the
    // native page view and let the regular stage layout reveal it.
    agentBrowserViewsReady.add(agentId);
    layoutAgentStageViews();
    // New-tab home just painted — reclaim the caret for the omnibox before
    // the page (e.g. Google) autofocuses its own search box.
    if (agentStagePendingOmniboxFocusId === agentId) {
      agentStagePendingOmniboxFocusId = null;
      setTimeout(() => focusAgentStageOmnibox(), 0);
    }
  });
  // Canva / Google / Apple login use window.open (often about:blank first).
  // NEVER load those into this tab — that blanks the site after sign-in.
  // Real popups keep window.opener + share the agent session partition.
  wc.setWindowOpenHandler((details) => {
    const u = String(details?.url || "");
    const disposition = String(details?.disposition || "");
    if (u && !agentStageUrlAllowed(u)) {
      // The one branch with no visible outcome: the page asked for a window,
      // got null back and carries on as if the click never happened. Say so,
      // or the next sign-in that quietly does nothing has nothing to go on.
      console.log("[agent-browser] refused window.open for", u.slice(0, 200));
      return { action: "deny" };
    }

    const isBlank = !u || /^about:blank$/i.test(u);
    const wantsPopup =
      isBlank ||
      disposition === "new-window" ||
      looksLikeAgentAuthPopupUrl(u);

    if (wantsPopup) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 560,
          height: 740,
          minWidth: 360,
          minHeight: 480,
          autoHideMenuBar: true,
          title: "Sign in",
          // Visible Studio / stage — never the hidden undocked stage window.
          parent: agentAuthPopupParentWindow(),
          webPreferences: {
            partition: agentBrowserPartition(agentId),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }

    // Plain target=_blank https link → stay in this agent tab.
    if (/^https?:\/\//i.test(u)) {
      try {
        wc.loadURL(u);
      } catch (_) {}
    }
    return { action: "deny" };
  });
  wc.on("did-create-window", (childWindow) => {
    wireAgentPopupWindow(childWindow, { parentWc: wc, agentId });
  });
  wc.on("will-navigate", (event, url) => {
    if (!agentStageUrlAllowed(url)) {
      event.preventDefault();
    }
  });
  // "Leave site? Changes you made may not be saved." is a native modal, and a
  // native modal blocks the renderer — so the agent cannot read the page, let
  // alone click the dialog it is trapped behind. Leaving is what was asked for
  // in every case that reaches here: the agent only navigates away on purpose,
  // and the user driving the tab clicked something to get here.
  wc.on("will-prevent-unload", (event) => {
    event.preventDefault();
  });
  try {
    if (app.userAgentFallback) wc.setUserAgent(app.userAgentFallback);
  } catch (_) {}
  wc.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow =
      permission === "fullscreen" ||
      permission === "clipboard-sanitized-write" ||
      permission === "clipboard-read";
    callback(allow);
  });
  wireAgentSessionClientHints(wc.session);
  wireAgentSessionDownloads(wc.session);
}

// Overriding app.userAgentFallback is only half the disguise: Chromium keeps
// advertising "Electron" in the Sec-CH-UA client-hint headers, and that is what
// providers like Google read when they refuse OAuth from embedded app browsers.
// The visible symptom is a "Continue with Google" button that does nothing, or
// the "This browser or app may not be secure" wall. Rewrite the brand hints on
// the agent browser's session so it presents as plain desktop Chrome.
const clientHintsWiredSessions = new WeakSet();
function wireAgentSessionClientHints(sess) {
  if (!sess || clientHintsWiredSessions.has(sess)) return;
  const full = String(process.versions.chrome || "").trim();
  const major = full.split(".")[0] || "";
  if (!major) return;
  clientHintsWiredSessions.add(sess);
  const brands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`;
  const fullVersionList =
    `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not?A_Brand";v="99.0.0.0"`;
  try {
    // Electron allows a single onBeforeSendHeaders listener per session; the
    // agent partition has no other, so this owns it.
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (!lower.startsWith("sec-ch-ua")) continue;
        if (lower === "sec-ch-ua") headers[key] = brands;
        else if (lower === "sec-ch-ua-full-version-list") headers[key] = fullVersionList;
        else if (lower === "sec-ch-ua-full-version") headers[key] = `"${full}"`;
        else if (/electron|lykn/i.test(String(headers[key] || ""))) delete headers[key];
      }
      callback({ requestHeaders: headers });
    });
  } catch (_) {
    /* header rewriting is best-effort — sign-in still works via email/password */
  }
}

// Real downloads in the LYKN browser: save straight into the user's Downloads
// folder with a unique name and reveal the file when it finishes. Sessions are
// per-partition and this wiring runs once per session.
const downloadWiredSessions = new WeakSet();
function wireAgentSessionDownloads(sess) {
  if (!sess || downloadWiredSessions.has(sess)) return;
  downloadWiredSessions.add(sess);
  sess.on("will-download", (_event, item) => {
    try {
      const fsSync = require("node:fs");
      const downloadsDir = app.getPath("downloads");
      const base =
        String(item.getFilename() || "download").replace(/[\\/:*?"<>|]+/g, "_") || "download";
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length) || "download";
      let target = path.join(downloadsDir, base);
      for (let i = 2; fsSync.existsSync(target); i += 1) {
        target = path.join(downloadsDir, `${stem} (${i})${ext}`);
      }
      item.setSavePath(target);
      item.once("done", (_e, state) => {
        if (state === "completed") {
          try {
            shell.showItemInFolder(target);
          } catch (_) {}
        }
      });
    } catch (_) {
      /* download proceeds with Electron defaults */
    }
  });
}

/**
 * A free path in ~/Downloads for this name, Finder style: "report.pdf",
 * then "report (2).pdf". Shared by every route that writes a download, so a
 * second copy never silently overwrites the first.
 */
function uniqueDownloadPath(filename) {
  const fsSync = require("node:fs");
  const dir = app.getPath("downloads");
  const safe =
    String(filename || "download")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 120) || "download";
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || "download";
  let target = path.join(dir, safe);
  for (let i = 2; fsSync.existsSync(target); i += 1) {
    target = path.join(dir, `${stem} (${i})${ext}`);
  }
  return target;
}

/** Save the given HTML to ~/Downloads under a page-title filename. */
function saveHtmlToDownloads(html, title) {
  const fsSync = require("node:fs");
  const stem =
    String(title || "artifact")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "artifact";
  const target = uniqueDownloadPath(`${stem}.html`);
  fsSync.writeFileSync(target, String(html), "utf8");
  return target;
}

/**
 * Raise whichever window should host the agent browser. The browser always
 * lives in the Studio when a Studio window exists: docked embed when active,
 * otherwise the Studio renderer is told to open its Browser tab (the views
 * re-parent into the Studio once it reports bounds). The standalone stage
 * window is only a fallback for when there is no Studio window at all.
 */
function raiseAgentBrowserHost({ focus = true } = {}) {
  const overlayAlive =
    overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
  const overlayTyping = !!(overlayAlive && overlayWindow.isFocused());
  const raiseWin = (win) => {
    try {
      if (win.isMinimized?.()) win.restore();
      if (!win.isVisible()) win.show();
      win.moveTop();
      if (focus && !overlayTyping) win.focus();
      else if (overlayAlive) focusOverlayForTyping();
    } catch (_) {}
  };
  if (studioStageEmbedActive()) {
    raiseWin(studioWindow);
    layoutAgentStageViews();
    return "studio";
  }
  if (studioWindow && !studioWindow.isDestroyed()) {
    // Studio is open but its Browser dock isn't — open the dock there instead
    // of popping the standalone stage window. Layout happens when the Studio
    // renderer reports the dock bounds and the embed activates.
    raiseWin(studioWindow);
    notifyStudioShowBrowser();
    return "studio-pending";
  }
  const stage = ensureAgentStageWindow();
  raiseWin(stage);
  layoutAgentStageViews();
  return "stage";
}

function ensureAgentBrowserWindow(agentId, { show = false, focus = true, label } = {}) {
  const id = String(agentId || "").trim();
  if (!id) return null;
  if (label) agentBrowserLabels.set(id, String(label).trim().slice(0, 40) || "Agent");

  const stage = ensureAgentStageWindow();
  let view = agentBrowserViews.get(id);
  if (!view) {
    if (!agentIncognito.has(id) && agentStageIncognitoDefault) {
      agentIncognito.set(id, true);
    }
    const incognito = isAgentIncognito(id);
    const partition = agentBrowserPartition(id);
    // Warm the shared persist session so cookies/localStorage survive restarts.
    try {
      const { session } = require("electron");
      session.fromPartition(partition, { cache: true });
    } catch (_) {}
    // Huge report/artifact loads may use lykn-artifact:// on this partition.
    try {
      ensureAgentArtifactProtocolForPartition(partition);
    } catch (_) {}
    view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, "agent-browser-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Agent tabs keep loading at full speed while hidden/inactive —
        // throttled timers/rAF leave lazy-loading pages stuck on spinners.
        backgroundThrottling: false,
      },
    });
    try {
      // Match the home page from the very first compositor frame, so the
      // pre-paint fill never reads as a stray strip below the favorites row.
      // Incognito included: page content is pinned light either way.
      view.setBackgroundColor("#ffffff");
    } catch (_) {}
    // A fresh WebContentsView defaults to the window's top-left bounds.
    // Park it before attaching so its initial blank paint cannot flash over
    // the browser chrome while the normal stage layout takes over.
    try {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } catch (_) {}
    try {
      stage.setContentProtection(isContentProtectionEnabled());
    } catch (_) {}
    agentBrowserViews.set(id, view);
    agentBrowserMeta.set(id, {
      url: AGENT_BROWSER_HOME_URL,
      pageTitle: "Google",
      kind: "browse",
      incognito,
    });
    wireAgentBrowserViewEvents(id, view);
    loadAgentBrowserHome(view.webContents);
  } else {
    // Re-show the home page only for truly empty tabs — never clobber a report/artifact
    // (those often load as data: URLs, which used to look like placeholders),
    // and never interrupt an in-flight navigation (Studio docking used to call
    // ensure again mid-load and wipe the artifact URL back to welcome).
    try {
      const meta = agentBrowserMeta.get(id) || {};
      const isDeliverable =
        meta.kind === "artifact" ||
        meta.kind === "browsing" ||
        meta.artifactKind === "report" ||
        meta.artifactKind === "image" ||
        meta.artifactKind === "video" ||
        meta.artifactKind === "chart" ||
        meta.artifactKind === "diagram";
      const wc = view.webContents;
      const loading = !!(wc && !wc.isDestroyed() && wc.isLoading?.());
      if (!isDeliverable && !loading) {
        const cur = wc && !wc.isDestroyed() ? wc.getURL() || "" : "";
        const needsHome =
          !cur ||
          /^about:blank$/i.test(cur) ||
          /^lykn:\/\/new-tab(?:[/?#]|$)/i.test(cur);
        if (needsHome) loadAgentBrowserHome(wc);
      }
    } catch (_) {}
  }

  // Select this tab for layout whenever we're focusing it, or when the stage
  // has no active tab yet. Agent Mode startup uses focus:false so Glass keeps
  // typing focus — but the welcome page must still be the visible tab.
  if (focus !== false || !agentStageActiveId || !agentBrowserViews.has(agentStageActiveId)) {
    agentStageActiveId = id;
  }

  if (show) {
    // Always through the Studio when it exists — never a separate window.
    raiseAgentBrowserHost({ focus: focus !== false });
    pushAgentStageState();
    notifyAgentBrowserVisibility(true);
  }
  return { webContents: view.webContents, view, stage };
}

function destroyAgentBrowserWindow(agentId) {
  const id = String(agentId || "").trim();
  // Closing an agent tab takes every tab it owns with it — deliverable
  // subtabs and browse sub-tabs alike. Ownership is the meta's ownerAgentId,
  // whatever kind of tab it is.
  if (id && !isAgentArtifactTabId(id) && !agentTabIds.isSubTabId(id)) {
    for (const [tabId, meta] of [...agentBrowserMeta.entries()]) {
      if (tabId !== id && meta?.ownerAgentId === id) {
        destroyAgentBrowserWindow(tabId);
      }
    }
  }
  const view = agentBrowserViews.get(id);
  agentBrowserLabels.delete(id);
  agentBrowserMeta.delete(id);
  agentIncognito.delete(id);
  if (!view) return;
  agentBrowserViews.delete(id);
  agentBrowserViewsReady.delete(id);
  agentTabZoomLogged.delete(id);
  detachViewFromWindow(agentStageWindow, view);
  detachViewFromWindow(studioWindow, view);
  try {
    view.webContents?.close?.();
  } catch (_) {}
  if (agentStageActiveId === id) {
    agentStageActiveId = agentBrowserViews.size
      ? [...agentBrowserViews.keys()][0]
      : null;
  }
  if (
    !agentBrowserViews.size &&
    !studioStageEmbedActive() &&
    agentStageWindow &&
    !agentStageWindow.isDestroyed()
  ) {
    agentStageWindow.hide();
  } else {
    // Closing the last docked tab leaves the studio browser open — keep a
    // fresh new-tab in place like a real browser window would. Closing the
    // window itself (not a tab, not minimize) skips that so reopen is empty.
    if (
      !studioBrowserDisposing &&
      !agentBrowserViews.size &&
      studioStageEmbedActive()
    ) {
      openFreshStudioBrowserTab({ focusOmnibox: true });
    }
    layoutAgentStageViews();
    pushAgentStageState();
  }
}

/** Show/focus an agent's tab inside the shared stage window. */
function showAgentBrowserWindow(agentId, opts = {}) {
  const focus = opts.focus !== false;
  const label = opts.label || opts.title;
  return ensureAgentBrowserWindow(agentId, { show: true, focus, label });
}

/**
 * Wait until a WebContents finishes a real main-frame navigation.
 * Ignores about:blank (new WebContents always paints that first).
 */
function waitForWebContentsLoad(wc, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!wc || wc.isDestroyed?.()) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        wc.removeListener("did-finish-load", onOk);
        wc.removeListener("did-fail-load", onFail);
      } catch (_) {}
      clearTimeout(timer);
      resolve(ok);
    };
    const isBlankUrl = (u) => !u || /^about:blank$/i.test(u);
    const onOk = () => {
      let u = "";
      try {
        u = wc.getURL() || "";
      } catch (_) {}
      // New WebContents always finish about:blank first — keep waiting for
      // the real welcome/page navigation we kicked off.
      if (isBlankUrl(u)) return;
      finish(true);
    };
    const onFail = (_e, errorCode, _desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      // -3 ERR_ABORTED is normal when replacing about:blank with the real URL.
      if (errorCode === -3) return;
      finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      wc.on("did-finish-load", onOk);
      wc.on("did-fail-load", onFail);
      // If the intended page already finished before we subscribed, settle now.
      try {
        if (!wc.isLoading?.() && !isBlankUrl(wc.getURL() || "")) finish(true);
      } catch (_) {}
    } catch (_) {
      finish(false);
    }
  });
}

/**
 * Toggle tab incognito: dark chrome + ephemeral session partition.
 * Recreates the BrowserView so private cookies don't mix with the shared
 * signed-in agent browser profile (and vice versa).
 *
 * Keeps the current page on-screen until the replacement session has loaded,
 * then covers it with the new view before tearing the old one down — so the
 * Studio underlay / about:blank never flashes in between.
 */
async function toggleAgentIncognito(agentId) {
  const id = String(agentId || agentStageActiveId || "").trim();
  if (!id || !agentBrowserViews.has(id)) {
    agentStageIncognitoDefault = !agentStageIncognitoDefault;
    pushAgentStageState();
    return { ok: true, incognito: agentStageIncognitoDefault, stageOnly: true };
  }
  const next = !isAgentIncognito(id);
  agentStageIncognitoDefault = next;
  const label = agentBrowserLabels.get(id);
  const prevMeta = agentBrowserMeta.get(id) || {};
  const oldView = agentBrowserViews.get(id);
  let resumeUrl = "";
  try {
    const wc = oldView?.webContents;
    resumeUrl = wc && !wc.isDestroyed() ? wc.getURL() || "" : "";
  } catch (_) {}
  if (
    !resumeUrl ||
    ownedBrowserAct.isPlaceholderAgentUrl(resumeUrl) ||
    /agent-browser-welcome\.html/i.test(resumeUrl)
  ) {
    resumeUrl = "";
  } else if (/^lykn:\/\//i.test(resumeUrl) || prevMeta.kind === "artifact") {
    // Keep artifact/report tabs on their meta URL (data:/lykn-artifact handled below).
    resumeUrl = prevMeta.url && /^https?:\/\//i.test(prevMeta.url) ? prevMeta.url : "";
  }

  // Flip preference first so the new view gets the correct partition.
  agentIncognito.set(id, next);
  if (label) agentBrowserLabels.set(id, label);
  agentStageActiveId = id;

  const partition = agentBrowserPartition(id);
  try {
    const { session } = require("electron");
    session.fromPartition(partition, { cache: true });
  } catch (_) {}
  try {
    ensureAgentArtifactProtocolForPartition(partition);
  } catch (_) {}

  const newView = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    newView.setBackgroundColor("#ffffff");
  } catch (_) {}
  if (studioStageEmbedActive()) {
    try {
      setViewRadius(newView, studioStageRadius);
    } catch (_) {}
    attachViewToWindow(studioWindow, newView);
  } else {
    const stage = ensureAgentStageWindow();
    attachViewToWindow(stage, newView);
  }
  // Park off-stage while loading — old view stays visible in the page slot.
  try {
    newView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } catch (_) {}

  const wc = newView.webContents;
  // Start the intended navigation BEFORE waiting, so about:blank can't win.
  if (wc && resumeUrl && /^https?:\/\//i.test(resumeUrl)) {
    applyAgentTabEmulation(wc);
    try {
      void wc.loadURL(resumeUrl);
    } catch (_) {
      loadAgentBrowserHome(wc);
    }
  } else {
    loadAgentBrowserHome(wc);
  }
  await waitForWebContentsLoad(wc, 4000);

  // Cover first (new view raised into the page slot), then remove the old one
  // so the Studio underlay never peeks through a one-frame gap.
  agentBrowserViews.set(id, newView);
  agentBrowserMeta.set(id, {
    ...prevMeta,
    url: resumeUrl || AGENT_BROWSER_HOME_URL,
    pageTitle: prevMeta.pageTitle || (resumeUrl ? "" : "Google"),
    kind: prevMeta.kind === "artifact" && resumeUrl ? "artifact" : "browse",
    incognito: next,
  });
  wireAgentBrowserViewEvents(id, newView);
  layoutAgentStageViews();
  pushAgentStageState();

  detachViewFromWindow(agentStageWindow, oldView);
  detachViewFromWindow(studioWindow, oldView);
  try {
    oldView?.webContents?.close?.();
  } catch (_) {}

  return { ok: true, agentId: id, incognito: next };
}

function escapeHtmlForStage(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapMediaAsStageHtml({ url, title, kind }) {
  const safeUrl = escapeHtmlForStage(url);
  const safeTitle = escapeHtmlForStage(title || "Preview");
  if (kind === "video") {
    return (
      `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
      `<style>html,body{margin:0;height:100%;background:#0b0d12;display:grid;place-items:center}` +
      `video{max-width:100%;max-height:100%;}</style></head><body>` +
      `<video controls autoplay src="${safeUrl}"></video></body></html>`
    );
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
    `<style>html,body{margin:0;min-height:100%;background:#0b0d12;display:grid;place-items:center}` +
    `img{max-width:100%;max-height:100vh;object-fit:contain}</style></head><body>` +
    `<img src="${safeUrl}" alt="${safeTitle}" /></body></html>`
  );
}

/** BrowserView partitions don't see defaultSession's lykn-artifact handler — use data: URLs. */
function htmlToStageDataUrl(html) {
  const body = String(html || "");
  if (!body.trim()) return "";
  return `data:text/html;charset=utf-8;base64,${Buffer.from(body, "utf8").toString("base64")}`;
}

function resolveLyknArtifactHtml(url) {
  const u = String(url || "").trim();
  if (!/^lykn-artifact:\/\//i.test(u)) return "";
  try {
    const key = new URL(u).hostname.replace(/\/$/, "");
    return artifactHtmlCache.get(key) || "";
  } catch {
    return "";
  }
}

function ensureAgentArtifactProtocolForPartition(partition) {
  const part = String(partition || "persist:lykn-agent-artifact").trim();
  try {
    const ses = session.fromPartition(part, { cache: true });
    if (ses.__lyknArtifactProtocolBound) return;
    ses.__lyknArtifactProtocolBound = true;
    ses.protocol.handle("lykn-artifact", (request) => {
      try {
        const key = new URL(request.url).hostname.replace(/\/$/, "");
        const html = artifactHtmlCache.get(key);
        if (!html) {
          return new Response("Artifact preview expired — run the agent again.", {
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
    console.warn("[agent-stage] artifact protocol:", e?.message || e);
  }
}

function ensureAgentArtifactSessionProtocol() {
  ensureAgentArtifactProtocolForPartition("persist:lykn-agent-artifact");
  // Agent BrowserViews use the shared browse partition — bind there too so
  // huge reports that fall back to lykn-artifact:// actually resolve.
  ensureAgentArtifactProtocolForPartition(AGENT_BROWSER_SHARED_PARTITION);
}

/** Group deliverable kinds into one subtab slot each (charts reuse the image slot). */
function stageDeliverableSlot(kind) {
  if (kind === "report") return "report";
  if (kind === "image" || kind === "chart" || kind === "diagram") return "image";
  if (kind === "video") return "video";
  return "artifact";
}

/**
 * Load a deliverable (artifact / image / report / video) into a SUBTAB under
 * the owning agent's tab. The agent's main tab keeps the live page the user
 * was on, so the agent retains full access to it. One subtab per deliverable
 * kind per agent — a re-run replaces that subtab's content.
 */
function openAgentStageArtifact({
  url,
  html,
  markdown,
  title,
  ownerAgentId,
  kind = "artifact",
  reuseAgentTab = true,
  show = false,
  focus = false,
  // The user asked for this deliverable right now (clicked a step, ran an
  // explicit "open in browser" action) — front it regardless of which tab is
  // visible. Without it, a deliverable arriving from a finished background
  // task only fronts when the user is already looking at that agent's family;
  // otherwise the subtab is created quietly and waits in the strip.
  force = false,
} = {}) {
  void reuseAgentTab; // deliverables always live in their own subtab now
  let loadUrl = String(url || "").trim();
  let pageHtml = typeof html === "string" ? html : "";
  const label = String(title || (kind === "report" ? "Report" : "Artifact"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48) || "Artifact";

  const owner = String(ownerAgentId || "").trim();
  const id = owner
    ? `art-${stageDeliverableSlot(kind)}-${owner}`
    : `art-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  // Subtabs inherit the owner tab's incognito state.
  if (owner && isAgentIncognito(owner) && !agentIncognito.has(id)) {
    agentIncognito.set(id, true);
  }
  const reportTheme = isAgentIncognito(owner || id) ? "incognito" : "light";

  if (!pageHtml && typeof markdown === "string" && markdown.trim()) {
    const mdTitle =
      label || titleFromStageMarkdown(markdown, kind === "report" ? "Report" : "Document");
    pageHtml = wrapReportAsStageHtml(markdown, mdTitle, { theme: reportTheme });
  }

  if (
    loadUrl &&
    /^https?:\/\//i.test(loadUrl) &&
    (kind === "image" || kind === "video" || kind === "chart" || kind === "diagram")
  ) {
    pageHtml = wrapMediaAsStageHtml({
      url: loadUrl,
      title: label,
      kind: kind === "video" ? "video" : "image",
    });
    loadUrl = "";
  }

  // Prefer inlined HTML (data:) so artifact tabs aren't blank — custom
  // partitions don't use defaultSession's lykn-artifact:// handler.
  if (!pageHtml && /^lykn-artifact:\/\//i.test(loadUrl)) {
    pageHtml = resolveLyknArtifactHtml(loadUrl);
  }
  if (!pageHtml && loadUrl && !/^https?:\/\//i.test(loadUrl) && !/^data:/i.test(loadUrl)) {
    pageHtml = resolveLyknArtifactHtml(loadUrl);
  }
  if (pageHtml) {
    // Keep a cache copy for Glass iframe / download helpers.
    try {
      cacheArtifactHtmlForOverlay(pageHtml);
    } catch (_) {}
    const dataUrl = htmlToStageDataUrl(pageHtml);
    if (!dataUrl) return { ok: false, error: "empty" };
    // Huge reports: fall back to session-scoped lykn-artifact://
    if (dataUrl.length > 1_800_000) {
      ensureAgentArtifactSessionProtocol();
      loadUrl = cacheArtifactHtmlForOverlay(pageHtml);
    } else {
      loadUrl = dataUrl;
    }
  }

  if (!loadUrl) return { ok: false, error: "empty" };
  if (!agentStageUrlAllowed(loadUrl) && !/^https?:\/\//i.test(loadUrl)) {
    return { ok: false, error: "blocked_url" };
  }

  if (/^lykn-artifact:\/\//i.test(loadUrl)) {
    ensureAgentArtifactSessionProtocol();
  }

  // Drop stale subtabs of the SAME kind slot under a different id (legacy
  // random art-* ids) — this deliverable reuses one deterministic subtab.
  if (owner) {
    for (const [tabId, meta] of [...agentBrowserMeta.entries()]) {
      if (
        tabId !== id &&
        isAgentArtifactTabId(tabId) &&
        meta?.ownerAgentId === owner &&
        stageDeliverableSlot(meta?.artifactKind || "artifact") === stageDeliverableSlot(kind)
      ) {
        destroyAgentBrowserWindow(tabId);
      }
    }
  }

  const chromeUrl =
    kind === "report"
      ? "lykn://report"
      : kind === "image" || kind === "chart" || kind === "diagram"
        ? "lykn://image"
        : kind === "video"
          ? "lykn://video"
          : "lykn://artifact";

  // Mark deliverable BEFORE ensure/show so welcome-reload guards skip this tab.
  agentBrowserLabels.set(id, label);
  agentBrowserMeta.set(id, {
    kind: "artifact",
    artifactKind: kind,
    ownerAgentId: owner || id,
    url: chromeUrl,
    pageTitle: label,
  });

  // Front the new subtab only when the user's attention is already on this
  // agent's family (or they explicitly asked — `force`, or nothing is on
  // stage at all). A background task finishing must not switch the visible
  // tab out from under whatever the user is doing; its deliverable loads
  // into the parked subtab and waits in the strip.
  const front = !!show && (force || agentTabFamilyActive(owner || id) || !agentStageActiveId);
  if (front) {
    agentStageActiveId = id;
  }

  const wrap = ensureAgentBrowserWindow(id, {
    show: front,
    focus: front && !!focus,
    label: label || agentBrowserLabels.get(id) || "Agent",
  });
  if (front) {
    try {
      showAgentBrowserWindow(id, { focus: focus !== false, label });
    } catch (_) {}
  }
  const view = wrap?.view || agentBrowserViews.get(id);
  const wc = wrap?.webContents || view?.webContents;
  if (!view || !wc || wc.isDestroyed()) {
    return { ok: false, error: "no_browser" };
  }

  // Re-assert meta after ensure (welcome path may have touched it).
  agentBrowserLabels.set(id, label);
  agentBrowserMeta.set(id, {
    kind: "artifact",
    artifactKind: kind,
    ownerAgentId: owner || id,
    url: chromeUrl,
    pageTitle: label,
  });

  const paintHtmlFallback = () => {
    if (!pageHtml || !wc || wc.isDestroyed()) return;
    void wc
      .executeJavaScript(
        `document.open();document.write(${JSON.stringify(pageHtml)});document.close();`,
        true,
      )
      .catch(() => {});
  };

  try {
    // Prefer document.write for report HTML — avoids data: size limits and
    // races with welcome reloads treating data: URLs as empty tabs.
    if (pageHtml && (kind === "report" || /^data:text\/html/i.test(loadUrl))) {
      void wc
        .loadURL("about:blank")
        .then(() => paintHtmlFallback())
        .catch(() => {
          try {
            wc.loadURL(loadUrl);
          } catch (_) {
            paintHtmlFallback();
          }
        });
    } else {
      wc.loadURL(loadUrl);
    }
  } catch (e) {
    paintHtmlFallback();
    if (!pageHtml) return { ok: false, error: e?.message || "load_failed" };
  }
  wc.once("did-finish-load", () => {
    const meta = agentBrowserMeta.get(id) || {};
    agentBrowserMeta.set(id, {
      ...meta,
      url: chromeUrl,
      pageTitle: label,
      kind: "artifact",
      artifactKind: kind,
      ownerAgentId: owner || id,
    });
    // The deliverable lives in its own subtab — the owner agent's tab (and
    // its browse URL) stay untouched, so the agent keeps page access.
    pushAgentStageState();
  });
  wc.once("did-fail-load", (_e, code, desc) => {
    console.warn("[agent-stage] artifact load failed:", code, desc);
    paintHtmlFallback();
  });

  if (front) agentStageActiveId = id;
  layoutAgentStageViews();
  pushAgentStageState();
  return { ok: true, id, url: chromeUrl, title: label, fronted: front };
}

/**
 * Paint an artifact into an existing agent tab. Prefers http(s) navigation so
 * the agent keeps a real URL; falls back to inlined HTML (srcDoc / fetched
 * preview) via document.write when navigation fails or only HTML is available.
 */
async function paintArtifactIntoAgentTab(agentId, { url, html, title, kind = "artifact" } = {}) {
  const id = String(agentId || "").trim();
  if (!id) return { ok: false, error: "no_id" };
  const wc = getAgentBrowserWebContents(id);
  if (!wc || wc.isDestroyed()) return { ok: false, error: "no_browser" };

  const label = String(title || "Artifact").trim().slice(0, 48) || "Artifact";
  let pageHtml = typeof html === "string" && html.trim() ? html : "";
  const target = String(url || "").trim();

  agentBrowserLabels.set(id, label);
  agentBrowserMeta.set(id, {
    kind: "artifact",
    artifactKind: kind,
    ownerAgentId: id,
    url: target || "lykn://artifact",
    pageTitle: label,
  });
  agentStageActiveId = id;

  const paintHtml = (sourceHtml) => {
    if (!sourceHtml || wc.isDestroyed()) return Promise.resolve(false);
    return wc
      .loadURL("about:blank")
      .then(() =>
        wc.executeJavaScript(
          `document.open();document.write(${JSON.stringify(sourceHtml)});document.close();true;`,
          true,
        ),
      )
      .then(() => true)
      .catch(() => false);
  };

  // Try live URL first so the omnibox / agent context show a real address.
  if (/^https?:\/\//i.test(target)) {
    try {
      const nav = await ownedBrowserAct.navigate(wc, target);
      if (nav?.ok) {
        try {
          initAgentRuntime().setAgentUrl?.(id, nav.url || target);
        } catch (_) {}
        pushAgentStageState();
        return { ok: true, via: "url", url: nav.url || target };
      }
    } catch (e) {
      console.warn("[lykn] artifact URL navigate failed:", e?.message || e);
    }
    // Fetch the preview HTML ourselves and paint it — covers expired CDN
    // redirects / intermittent proxy failures while the side panel still works.
    if (!pageHtml) {
      try {
        const res = await electronNet.fetch(target, { redirect: "follow" });
        if (res.ok) {
          const ct = String(res.headers.get("content-type") || "");
          if (/text\/html|application\/xhtml/i.test(ct) || !ct) {
            pageHtml = await res.text();
          }
        }
      } catch (e) {
        console.warn("[lykn] artifact URL fetch failed:", e?.message || e);
      }
    }
  }

  if (pageHtml) {
    const painted = await paintHtml(pageHtml);
    if (painted) {
      try {
        cacheArtifactHtmlForOverlay(pageHtml);
      } catch (_) {}
      pushAgentStageState();
      return { ok: true, via: "html" };
    }
  }

  return { ok: false, error: "paint_failed" };
}

function destroyAgentOwnedArtifactTabs(ownerAgentId) {
  const owner = String(ownerAgentId || "");
  if (!owner) return;
  for (const [id, meta] of [...agentBrowserMeta.entries()]) {
    if ((meta?.kind === "artifact" || isAgentArtifactTabId(id)) && meta?.ownerAgentId === owner) {
      destroyAgentBrowserWindow(id);
    }
  }
}

function resolveToolResultStageUrl(result) {
  if (!result || typeof result !== "object") return "";
  let fileUrl = pickArtifactUrl(result);
  if (!fileUrl && typeof result.preview_html === "string" && result.preview_html.trim()) {
    fileUrl = cacheArtifactHtmlForOverlay(result.preview_html);
  }
  if (
    !fileUrl &&
    typeof result.preview_url === "string" &&
    /^https?:\/\//i.test(result.preview_url)
  ) {
    fileUrl = result.preview_url;
  }
  if (!fileUrl && typeof result.kroki_url === "string" && /^https?:\/\//i.test(result.kroki_url)) {
    fileUrl = result.kroki_url;
  }
  if (!fileUrl && typeof result.chart_url === "string" && /^https?:\/\//i.test(result.chart_url)) {
    fileUrl = result.chart_url;
  }
  return fileUrl;
}

function maybeOpenAgentStageDeliverable(opts, payload) {
  // Only Agent Mode streams — not the normal Glass ask bar.
  if (opts?.agentMode !== true) return null;
  const ownerAgentId =
    String(opts?.agentId || "").trim() || String(agentRuntime?.getActiveId?.() || "");
  try {
    return openAgentStageArtifact({ ...payload, ownerAgentId });
  } catch (e) {
    console.warn("[agent-stage] open artifact:", e?.message || e);
    return null;
  }
}

function hideAgentBrowserWindow(_agentId) {
  // Individual tabs stay in the stage; Agent Mode off hides the whole stage.
}

function notifyAgentBrowserVisibility(visible) {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("lykn:agent-browser-visibility", {
        visible: !!visible,
      });
    }
  } catch (_) {}
}

function hideAllAgentBrowserWindows() {
  if (agentStageWindow && !agentStageWindow.isDestroyed() && agentStageWindow.isVisible()) {
    agentStageWindow.hide();
  }
  notifyAgentBrowserVisibility(false);
}

function agentBrowserWindowExists(agentId) {
  return agentBrowserViews.has(String(agentId || ""));
}

function getAgentBrowserWebContents(agentId) {
  const wrap = ensureAgentBrowserWindow(agentId, { show: false, focus: false });
  return wrap?.webContents || null;
}

function getActiveAgentBrowserWebContents() {
  const id = agentStageActiveId || agentRuntime?.getActiveId?.();
  if (!id) return null;
  const view = agentBrowserViews.get(id);
  return view && view.webContents && !view.webContents.isDestroyed()
    ? view.webContents
    : null;
}

/** Pick a real browse tab (not an artifact/report surface) for source links. */
function resolveAgentBrowseTargetId() {
  const rt = agentRuntime;
  const isBrowseTab = (id) => {
    const tabId = String(id || "").trim();
    if (!tabId || isAgentArtifactTabId(tabId)) return false;
    const meta = agentBrowserMeta.get(tabId) || {};
    return meta.kind !== "artifact";
  };

  if (isBrowseTab(agentStageActiveId)) return agentStageActiveId;

  const linked = String(rt?.getMainLinkedBrowser?.() || "").trim();
  if (isBrowseTab(linked)) return linked;

  const agents = typeof rt?.listPublic === "function" ? rt.listPublic() : [];
  const activeId = String(rt?.getActiveId?.() || "").trim();
  const active = agents.find((a) => a && a.id === activeId);
  if (active && active.role !== "main" && isBrowseTab(active.id)) return active.id;

  const worker = agents.find((a) => a && a.role !== "main" && a.id);
  if (worker?.id) return worker.id;

  for (const id of agentBrowserViews.keys()) {
    if (isBrowseTab(id)) return id;
  }
  return "";
}

/**
 * Open http(s) links inside the LYKN in-app browser (Studio dock or agent
 * stage) as a fresh agent tab per URL — sources, artifacts, and markdown
 * links each get their own agent. Falls back to the OS default for
 * mailto/tel or when the in-app browser cannot take the URL.
 */
async function openUrlPreferAgentBrowser(url, { title } = {}) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "empty" };

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
    /* open as-is through allowlists below */
  }

  // Auth / mailto / tel stay in the OS browser (or dedicated flows).
  if (!/^https?:\/\//i.test(target) || !agentStageUrlAllowed(target)) {
    openExternalSafe(target);
    return { ok: true, via: "external", url: target };
  }

  try {
    const docked = studioStageEmbedActive();
    // If Studio is open, keep the stage quiet — the renderer will switch to
    // the Browser tab and dock the views (avoids flashing the standalone stage).
    const studioOpen = !!(studioWindow && !studioWindow.isDestroyed());
    const quiet = studioOpen && !docked;
    const label = String(title || "").trim().slice(0, 48);

    // Always a new agent per link/artifact so each page is independently
    // actionable in the rail.
    const id =
      openAgentBrowserTabWithUrl(target, {
        title: label || undefined,
        focus: true,
        show: !quiet,
      }) || openStudioBrowserTabWithUrl(target, { focus: !quiet });
    if (id) {
      if (label) agentBrowserLabels.set(id, label);
      notifyStudioShowBrowser();
      if (docked) {
        showAgentBrowserWindow(id, { focus: true, label: label || undefined });
      } else if (studioOpen) {
        agentStageActiveId = id;
        layoutAgentStageViews();
        pushAgentStageState();
      }
      return { ok: true, via: "agent", url: target, agentId: id };
    }
  } catch (e) {
    console.warn("[lykn] LYKN browser open failed, falling back to external:", e?.message || e);
  }

  openExternalSafe(target);
  return { ok: true, via: "external", url: target };
}

/** Tell the Studio renderer to switch to its Browser tab (harmless if not mounted). */
function notifyStudioShowBrowser() {
  try {
    const win = studioWindowRef();
    if (win && !win.isDestroyed()) {
      win.webContents.send("lykn:studio-show-browser");
    }
  } catch (_) {}
}

async function planOwnedBrowserNext(ctx) {
  const token = await getAuthToken().catch(() => null);
  if (!token) {
    return {
      done: false,
      stuck: true,
      answer: "Sign in to LYKN to use agent browsing.",
    };
  }
  // 110-item budget (server accepts 130): on-screen elements first, so the
  // planner always sees what the user (and the screenshot) sees; below-fold
  // items fill the remainder.
  const rawCatalog = Array.isArray(ctx.catalog) ? ctx.catalog : [];
  const catalog = [
    ...rawCatalog.filter((it) => it && it.inView !== false),
    ...rawCatalog.filter((it) => it && it.inView === false),
  ].slice(0, 110);
  // Keep enough of the goal that trailing "…and complete it" clauses survive.
  const rawGoalFull = String(ctx.goal || "").trim();
  const rawGoal =
    rawGoalFull.length <= 1200
      ? rawGoalFull
      : `${rawGoalFull.slice(0, 900)} … ${rawGoalFull.slice(-280)}`;
  const items = catalog.map((it) => ({
    id: it.id,
    tag: it.tag,
    type: it.type,
    role: it.role,
    label: it.label,
    selector: it.selector,
    href: it.href,
    // Viewport coords so the planner / actuator can send real mouse events
    // (Gmail and other SPAs often ignore element.click()).
    clientX: it.clientX,
    clientY: it.clientY,
    // false = below the fold / offscreen right now (actuator scrolls to it).
    inView: it.inView !== false,
  }));
  const conversationHistory = Array.isArray(ctx.conversationHistory)
    ? ctx.conversationHistory.slice(-10).map((m) => ({
        role: m?.role === "assistant" ? "assistant" : "user",
        content: String(m?.content || "").slice(0, 900),
      }))
    : [];
  const body = {
    intent: rawGoal,
    pageText: String(ctx.pageText || "").slice(0, 9000),
    url: String(ctx.url || ""),
    title: String(ctx.title || ""),
    // API contract: plan-next requires `items` (not interactables).
    items,
    interactables: items,
    // Per-round screenshot so the planner can see icons/canvas/iframe targets
    // and click them via click_coord.
    imageUrl: String(ctx.imageUrl || ""),
    conversationHistory,
    // Slim {action, result} entries — the planner needs what was tried and
    // whether it worked, not full selectors/payloads.
    history: (Array.isArray(ctx.history) ? ctx.history.slice(-12) : []).map((h) => ({
      action: {
        type: h?.action?.type || "",
        label: String(h?.action?.label || "").slice(0, 80),
        value: String(h?.action?.value || "").slice(0, 60),
        key: h?.action?.key || undefined,
        url: String(h?.action?.url || "").slice(0, 120) || undefined,
      },
      result: {
        ok: h?.result?.ok !== false,
        error: h?.result?.ok === false ? String(h?.result?.error || "").slice(0, 80) : undefined,
        hitTest: h?.result?.hitTest,
      },
    })),
    round: ctx.round || 0,
    ownedBrowser: true,
    // Progressive WORKING PLAN — rewritten each round from the visible screen.
    taskPlan: String(ctx.taskPlan || "").slice(0, 2000),
    // Holo pipeline memory: steps taken so far (screen reader) + the running
    // agent conversation (Holo) so each round builds on the last one.
    completedSteps: (Array.isArray(ctx.history) ? ctx.history.slice(-25) : []).map((h) => ({
      type: h?.action?.type || "step",
      label: String(h?.action?.label || h?.action?.value || h?.action?.url || "").slice(0, 80),
      ok: h?.result?.ok !== false,
      // Prefer real post-action observation — result.ok alone is not a screen change.
      screenChanged:
        h?.screenChanged === true ||
        h?.result?.screenChanged === true ||
        false,
    })),
  };
  if (Array.isArray(ctx.holoMessages) && ctx.holoMessages.length) {
    body.holoMessages = ctx.holoMessages;
  }
  if (ctx.toolName && ctx.toolOutput != null) {
    body.toolName = String(ctx.toolName);
    body.toolOutput = String(ctx.toolOutput).slice(0, 2000);
  }
  if (ctx.lastActionDiff) {
    // Rich post-click diffs list NEW controls — keep enough for the planner.
    body.lastActionDiff = String(ctx.lastActionDiff).slice(0, 1200);
  }
  // Stall escalation from the adaptive loop — server renders it as MANDATORY.
  if (ctx.stuckHint) {
    body.stuckHint = String(ctx.stuckHint).slice(0, 500);
    body.forceAction = true;
  }
  try {
    const res = await fetch(`${API_BASE}/api/desktop/browser-plan-next`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Fallback: one-shot prose plan over catalog when plan-next rejects owned mode.
      // Always forward the screenshot — holo/screen-reader requires it.
      const res2 = await fetch(`${API_BASE}/api/desktop/browser-plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          intent: body.intent,
          pageText: body.pageText,
          url: body.url,
          title: body.title,
          items: body.items,
          interactables: body.interactables,
          conversationHistory: body.conversationHistory,
          imageUrl: body.imageUrl,
        }),
      });
      const data2 = await res2.json().catch(() => ({}));
      const actions = Array.isArray(data2.actions) ? data2.actions : [];
      if (!actions.length) {
        // Empty fallback ≠ finished — surface planner failure so the loop can stop.
        return {
          done: false,
          stuck: true,
          plannerFailed: true,
          answer: data2.message || data2.summary || data2.error || "Could not plan the next browser step.",
          actions: [],
        };
      }
      return { done: false, actions };
    }
    const data = await res.json().catch(() => ({}));
    const nextPlan = String(data.taskPlan || ctx.taskPlan || "").slice(0, 2000);
    if (data.done || data.answer) {
      return {
        done: true,
        answer:
          data.answer || data.agentResult || data.explanation || data.summary || "Done.",
        forceContinue: !!data.forceContinue,
        taskPlan: nextPlan || undefined,
      };
    }
    return {
      done: false,
      actions: Array.isArray(data.actions) ? data.actions : [],
      holoMessages: Array.isArray(data.holoMessages) ? data.holoMessages : undefined,
      holoToolName: data.holoToolName || undefined,
      forceContinue: !!data.forceContinue,
      taskPlan: nextPlan || undefined,
      // Keep explanation for rejection hints — do NOT set answer (that means done).
      explanation: data.forceContinue
        ? data.explanation || data.reasoning || ""
        : undefined,
      reasoning: data.reasoning || data.explanation || undefined,
    };
  } catch (e) {
    return {
      done: false,
      stuck: true,
      plannerFailed: true,
      answer: e?.message || "Browser planning failed.",
      actions: [],
    };
  }
}

let agentRuntimeLoadPromise = null;

function whenAgentRuntimeLoaded() {
  initAgentRuntime();
  return agentRuntimeLoadPromise || Promise.resolve();
}

function initAgentRuntime() {
  if (agentRuntime) return agentRuntime;
  loadBrowsingHabitsContext();
  // Browser sub-tabs for one agent — the capability behind the modular
  // agent's open_tab / close_tab / switch_tab actions. Each sub-tab is one
  // more entry in agentBrowserViews whose id names its owner
  // (agentTabIds.cjs), sharing the owner's session partition so a sign-in on
  // tab one holds on tab two. Visual selection only follows the agent when
  // the user is already looking at this agent's tab family — an agent working
  // in the background must not steal the stage from whatever the user is
  // watching.
  const agentTabsCapability = {
    open(ownerId, url) {
      const owner = String(ownerId || "").trim();
      if (!owner || !agentBrowserViews.has(owner)) return { ok: false, error: "no_owner_tab" };
      let n = 1;
      while (agentBrowserViews.has(agentTabIds.subTabId(owner, n))) n += 1;
      const id = agentTabIds.subTabId(owner, n);
      // Partition derivation reads the OWNER's incognito flag (see
      // agentBrowserPartition); mirroring it onto the sub-tab keeps the meta
      // and any per-id checks honest too.
      if (isAgentIncognito(owner)) agentIncognito.set(id, true);
      const label = `${agentBrowserLabels.get(owner) || "Agent"} · tab ${n + 1}`;
      const wrap = ensureAgentBrowserWindow(id, { show: false, focus: false, label });
      if (!wrap) return { ok: false, error: "tab_create_failed" };
      const meta = agentBrowserMeta.get(id) || {};
      agentBrowserMeta.set(id, { ...meta, ownerAgentId: owner });
      const target = String(url || "").trim();
      if (target && /^https?:\/\//i.test(target)) {
        try {
          wrap.webContents.loadURL(target);
        } catch (_) {}
      }
      if (agentTabFamilyActive(owner)) agentStageActiveId = id;
      layoutAgentStageViews();
      pushAgentStageState();
      return { ok: true, tabId: id, url: target };
    },
    close(ownerId, tabId) {
      const owner = String(ownerId || "").trim();
      const id = String(tabId || "").trim();
      // Only a sub-tab the agent owns may be closed; the primary tab is the
      // task's anchor and the user's window into it.
      if (!id || agentTabIds.subTabOwner(id) !== owner) {
        return { ok: false, error: id === owner ? "cannot_close_primary_tab" : "not_your_tab" };
      }
      if (!agentBrowserViews.has(id)) return { ok: false, error: "unknown_tab" };
      destroyAgentBrowserWindow(id);
      if (agentStageActiveId === id) agentStageActiveId = owner;
      layoutAgentStageViews();
      pushAgentStageState();
      return { ok: true, tabId: id };
    },
    activate(ownerId, tabId) {
      const owner = String(ownerId || "").trim();
      const id = String(tabId || "").trim();
      const inFamily = id === owner || agentTabIds.subTabOwner(id) === owner;
      if (!inFamily || !agentBrowserViews.has(id)) return { ok: false, error: "unknown_tab" };
      if (agentTabFamilyActive(owner)) {
        agentStageActiveId = id;
        layoutAgentStageViews();
        pushAgentStageState();
      }
      return { ok: true, tabId: id };
    },
    list(ownerId) {
      const owner = String(ownerId || "").trim();
      const rows = [];
      for (const [id, view] of agentBrowserViews) {
        const mine = id === owner || agentTabIds.subTabOwner(id) === owner;
        if (!mine) continue;
        // Deliverable viewers are not pages the agent drives.
        if ((agentBrowserMeta.get(id) || {}).kind === "artifact") continue;
        const wc = view?.webContents;
        rows.push({
          id,
          url: wc && !wc.isDestroyed() ? wc.getURL() || "" : "",
          title: wc && !wc.isDestroyed() ? wc.getTitle() || "" : "",
        });
      }
      return rows;
    },
    getWebContents(tabId) {
      const view = agentBrowserViews.get(String(tabId || "").trim());
      const wc = view?.webContents;
      return wc && !wc.isDestroyed() ? wc : null;
    },
  };

  agentRuntime = createAgentRuntime({
    userDataPath: app.getPath("userData"),
    apiBase: API_BASE,
    getAuthToken,
    readStreamResponse: readOverlayStreamResponse,
    emit: emitAgentToUi,
    ensureBrowserWindow: ensureAgentBrowserWindow,
    destroyBrowserWindow: destroyAgentBrowserWindow,
    showBrowserWindow: showAgentBrowserWindow,
    hideBrowserWindow: hideAgentBrowserWindow,
    hideAllBrowserWindows: hideAllAgentBrowserWindows,
    browserWindowExists: agentBrowserWindowExists,
    getBrowserWebContents: getAgentBrowserWebContents,
    planOwnedBrowserNext,
    isContentProtectionEnabled,
    openStageArtifact: openAgentStageArtifact,
    destroyOwnedArtifactTabs: destroyAgentOwnedArtifactTabs,
    focusOverlayComposer: focusOverlayForTyping,
    notifyAgentFinished,
    getBrowsingContext,
    getActiveBrowseAgentId: () => resolveAgentBrowseTargetId() || agentStageActiveId || null,
    agentTabs: agentTabsCapability,
  });
  agentRuntimeLoadPromise = Promise.resolve(agentRuntime.load()).catch((err) => {
    console.warn("[agent-runtime] load failed:", err?.message || err);
  });
  return agentRuntime;
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
  // Unstick click-through / clipped geometry before the user sees the bar.
  healOverlayGeometry(false);
  // Brief summon wash behind the bar (no persistent outline).
  playOverlayBurst();
  overlayWindow.show();
  // Re-assert the level AFTER show too — ordering a window onto a full-screen
  // Space can drop it again — then bring it above the burst flash.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.moveTop();
  overlayWindow.focus();
  // Heal again after show — Spaces / full-screen can rewrite bounds on map.
  healOverlayGeometry(false);
  // Restore the live meeting notes + side-panel + agent sidebar if still open.
  if (liveCardOpen && !overlayCollapsed) showLiveWindow();
  if (panelCardOpen && !overlayCollapsed) showPanelWindow();
  if (agentSidebarOpen && !overlayCollapsed) showAgentSidebarWindow();
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
function refreshTrayUpdateAffordance() {
  if (tray) {
    const hotkeyLabel = IS_MAC ? "⌘L" : "Ctrl+L";
    if (pendingUpdate) {
      const ver = pendingUpdate.version ? ` ${pendingUpdate.version}` : "";
      tray.setToolTip(`LYKN${ver} is ready — restart to update (${hotkeyLabel})`);
      if (IS_MAC && app.dock) {
        try { app.dock.setBadge("↑"); } catch (_) { /* cosmetic */ }
      }
    } else {
      tray.setToolTip(`LYKN — open the chat overlay (${hotkeyLabel})`);
      if (IS_MAC && app.dock) {
        try { app.dock.setBadge(""); } catch (_) { /* cosmetic */ }
      }
    }
  }
  // Keep the app menu in sync so Restart is findable even without the tray menu.
  try {
    if (app.isReady()) buildAppMenu();
  } catch (_) { /* menu not ready yet */ }
}

function createTray() {
  if (tray) return;
  const trayFile = IS_MAC ? "trayTemplate.png" : "tray-win.png";
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "resources", trayFile),
  );
  if (IS_MAC) icon.setTemplateImage(true);
  tray = new Tray(icon);
  refreshTrayUpdateAffordance();

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
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const items = [];
    if (pendingUpdate && installPendingUpdate) {
      const ver = pendingUpdate.version ? ` (${pendingUpdate.version})` : "";
      items.push({
        label: `Restart to Update${ver}`,
        click: () => installPendingUpdate(),
      });
      items.push({ type: "separator" });
    }
    items.push(
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
          // Opening the window is a natural moment to re-offer a pending update.
          void maybePromptPendingUpdate({ force: false });
        },
      },
      { type: "separator" },
      {
        label: "Set Up LYKN / Permissions…",
        click: () => createOnboardingWindow(),
      },
      { type: "separator" },
      { label: "Quit LYKN Completely", click: () => quitForReal() },
    );
    const menu = Menu.buildFromTemplate(items);
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
// Last page fingerprint for Glass asks — when the screen/URL changes mid-chat,
// keep the screenshot even on text-rich pages so we don't go blind.
let lastOverlayPageFingerprint = "";

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

// macOS share sheet: AirDrop / Photos / Mail want a file, not a signed link.
// Pull the asset into a temp folder once per URL and hand the path to the
// sharing item. Files live in the OS temp dir, so cleanup is the OS's job.
const SHARE_STAGE_MAX_BYTES = 128 * 1024 * 1024;
const shareStagedFiles = new Map();

async function stageNativeShareFile(url, nameHint = "") {
  const cached = shareStagedFiles.get(url);
  if (cached && fsSync.existsSync(cached)) return cached;
  try {
    const res = await fetchOverlayMedia(url);
    if (!res || !res.ok) return "";
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > SHARE_STAGE_MAX_BYTES) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > SHARE_STAGE_MAX_BYTES) return "";
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();

    let filename = String(nameHint || "").trim();
    if (!filename) {
      try {
        filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      } catch {
        /* fall through to the generic name */
      }
    }
    filename =
      filename.replace(/[/\\:*?"<>|]+/g, "-").replace(/^\.+/, "").slice(0, 120) ||
      "LYKN item";
    if (!/\.[a-z0-9]{1,8}$/i.test(filename)) {
      filename += {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "image/heic": ".heic",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/mp4": ".m4a",
        "application/pdf": ".pdf",
        "text/html": ".html",
        "text/csv": ".csv",
        "text/plain": ".txt",
      }[mime] || "";
    }

    const dir = path.join(
      app.getPath("temp"),
      `lykn-share-${crypto.randomBytes(6).toString("hex")}`,
    );
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, filename);
    await fs.writeFile(target, buf);
    shareStagedFiles.set(url, target);
    return target;
  } catch (err) {
    console.warn("[share] staging failed:", err?.message || err);
    return "";
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
  for (const win of [
    overlayWindow,
    burstWindow,
    menuWindow,
    pickerWindow,
    langPickerWindow,
    liveWindow,
    panelWindow,
    agentSidebarWindow,
    agentStageWindow,
  ]) {
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
    width: 440,
    height: 640,
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
  // Don't poke Automation while Screen Recording is still unsettled, or after
  // the user already denied System Events — Live Watch can rely on vision alone.
  if (screenCaptureStatus() !== "granted") return null;
  if (automationOk.systemEvents === false) return null;

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
  if (automationOk.systemEvents === false) return [];

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
  const runPick = () => runOsascript(pickScript, 8000);
  const pick =
    automationOk.systemEvents === true
      ? await runPick()
      : await withPermissionPrompt("automation:system-events", runPick);
  if (pick.error) {
    console.log("[scrape] browser-detect error:", pick.error);
    if (isAutomationDeniedError(pick.error)) {
      automationOk.systemEvents = false;
      console.log(
        "[scrape] → Grant Automation permission: System Settings → Privacy & " +
          "Security → Automation → enable System Events for LYKN/Electron.",
      );
    }
    return [];
  }
  automationOk.systemEvents = true;
  return String(pick.out || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readBrowserFrontTabUrl(appName, { anyScheme = false, allowPrompt = true } = {}) {
  if (automationOk.browsers[appName] === false) return null;

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

  const run = () => runOsascript(script, 6000);
  // Known-allowed browsers skip the mutex; first contact (or unknown) is serialized.
  const r =
    automationOk.browsers[appName] === true || !allowPrompt
      ? await run()
      : await withPermissionPrompt(`automation:${appName}`, run);

  if (r.error) {
    console.log(`[scrape] url-read error (${appName}):`, r.error);
    if (isAutomationDeniedError(r.error)) {
      automationOk.browsers[appName] = false;
      console.log(`[scrape] → Grant Automation permission for ${appName} under LYKN/Electron.`);
    }
    return null;
  }
  automationOk.browsers[appName] = true;
  return accept(r.out);
}

async function readBrowserTabUrl(appName, { anyScheme = false, allowPrompt = true } = {}) {
  if (automationOk.browsers[appName] === false) return null;

  const front = await readBrowserFrontTabUrl(appName, { anyScheme, allowPrompt });
  if (front) return front;
  if (/^Safari/.test(appName)) return null;

  const accept = (u) => {
    const url = String(u || "").trim();
    if (!url) return null;
    if (anyScheme) return url;
    return /^https?:\/\//i.test(url) ? url : null;
  };
  // Follow-up window walk: only after front-tab already marked this browser allowed
  // (or we're retrying without a new prompt). Avoids a second Allow dialog.
  if (automationOk.browsers[appName] !== true && allowPrompt) return null;

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
    if (isAutomationDeniedError(r.error)) {
      automationOk.browsers[appName] = false;
    }
    return null;
  }
  automationOk.browsers[appName] = true;
  const url = accept(r.out);
  if (url) return url;
  if (anyScheme && String(r.out || "").trim()) return String(r.out).trim();
  return null;
}

function rankBrowserCandidates(candidates) {
  let pool = candidates.slice();
  const hasMainBrowser = pool.some((n) => !DEPRIORITIZED_BROWSERS.has(n));
  if (hasMainBrowser) {
    pool = pool.filter((n) => !DEPRIORITIZED_BROWSERS.has(n));
  }
  pool.sort(
    (a, b) => (BROWSER_PICK_PRIORITY[b] ?? 40) - (BROWSER_PICK_PRIORITY[a] ?? 40),
  );
  return pool;
}

function pickBestBrowserTarget(targets) {
  if (!targets.length) return null;
  const ranked = rankBrowserCandidates(targets.map((t) => t.appName));
  const order = new Map(ranked.map((name, i) => [name, i]));
  return targets.slice().sort((a, b) => (order.get(a.appName) ?? 99) - (order.get(b.appName) ?? 99))[0];
}

/**
 * Try at most one not-yet-denied browser for a URL in this action.
 * Prevents Chrome + Safari + Arc each showing their own Allow dialog at once.
 * Known-allowed browsers may be checked without a new dialog; only one unknown
 * browser may prompt per call.
 */
async function resolveOneBrowserHttpTarget(candidates, { frontWindowOnly = false } = {}) {
  const ranked = rankBrowserCandidates(candidates).filter(
    (name) => automationOk.browsers[name] !== false,
  );
  if (!ranked.length) return null;

  // Prefer browsers already allowed this session (no new dialog).
  const known = ranked.filter((name) => automationOk.browsers[name] === true);
  const unknown = ranked.filter((name) => automationOk.browsers[name] !== true);
  const tryOrder = [...known, ...unknown];

  let promptedUnknown = false;
  for (const appName of tryOrder) {
    const alreadyOk = automationOk.browsers[appName] === true;
    if (!alreadyOk && promptedUnknown) break;
    if (!alreadyOk) promptedUnknown = true;

    const url = frontWindowOnly
      ? await readBrowserFrontTabUrl(appName, { allowPrompt: !alreadyOk })
      : await readBrowserTabUrl(appName, { allowPrompt: !alreadyOk });
    if (url) return { appName, url };

    // Denied mid-attempt — do not immediately blast the next browser.
    if (automationOk.browsers[appName] === false) break;
    // Unknown prompt burned with no URL — stop; next user action can try another.
    if (!alreadyOk) break;
  }
  return null;
}

async function listBrowserHttpTargets({ frontWindowOnly = false } = {}) {
  const candidates = await listRunningBrowserApps();
  const one = await resolveOneBrowserHttpTarget(candidates, { frontWindowOnly });
  return one ? [one] : [];
}

async function describeBrowserTabProblem() {
  const candidates = await listRunningBrowserApps();
  if (!candidates.length) {
    return {
      error: "no_browser",
      message: "Open Chrome (or another browser) with a website loaded, then try again.",
    };
  }
  // One browser only — same fan-out guard as Glass scrape.
  const httpTarget = await resolveOneBrowserHttpTarget(candidates, { frontWindowOnly: false });
  if (httpTarget?.url) return null;
  const ranked = rankBrowserCandidates(candidates).filter(
    (name) => automationOk.browsers[name] !== false,
  );
  const probe = ranked.find((name) => automationOk.browsers[name] === true) || ranked[0];
  if (probe) {
    const raw = await readBrowserTabUrl(probe, {
      anyScheme: true,
      allowPrompt: automationOk.browsers[probe] !== true,
    });
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
  //   1) list running browsers (System Events — at most one Automation prompt),
  //   2) read URL from one preferred browser (at most one more Allow dialog).
  if (automationOk.systemEvents === false) {
    console.log("[scrape] System Events Automation previously denied — skip AppleScript");
    return null;
  }
  const candidates = await listRunningBrowserApps();
  if (!candidates.length) {
    console.log("[scrape] no browser frontmost or running");
    return null;
  }
  // Prefer front-window tabs; if those are empty, widen to any window on the
  // same already-allowed browser (no second Allow dialog).
  let best = await resolveOneBrowserHttpTarget(candidates, { frontWindowOnly: true });
  if (!best && candidates.some((n) => automationOk.browsers[n] === true)) {
    best = await resolveOneBrowserHttpTarget(candidates, { frontWindowOnly: false });
  }
  if (!best) {
    console.log("[scrape] browsers running but none have an http(s) tab:", candidates.join(", "));
    return null;
  }
  console.log(`[scrape] active browser URL: ${best.url} (${best.appName})`);
  return best;
}

// Run a small JS snippet in the active browser tab via AppleScript.
// Snippet must NOT contain double quotes or backslashes (AppleScript-safe).
async function evalBrowserJs(appName, js, timeoutMs = 6000) {
  if (!IS_MAC || !appName) return { error: "unsupported" };
  if (automationOk.browsers[appName] === false) return { error: "automation_denied" };
  const isSafari = /^Safari/.test(appName);
  const script = isSafari
    ? `tell application "${appName}" to do JavaScript "${js}" in current tab of front window`
    : `tell application "${appName}" to execute active tab of front window javascript "${js}"`;
  const run = () => runOsascript(script, timeoutMs);
  const r =
    automationOk.browsers[appName] === true
      ? await run()
      : await withPermissionPrompt(`automation-dom:${appName}`, run);
  if (r.error) {
    if (isAutomationDeniedError(r.error)) {
      automationOk.browsers[appName] = false;
    }
    return { error: r.error };
  }
  automationOk.browsers[appName] = true;
  return { out: (r.out || "").trim() };
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

  // No double quotes or backslashes in this JS so it embeds cleanly in the
  // AppleScript double-quoted string (AppleScript treats \n etc. as escapes).
  const js =
    "(function(){var e=document.querySelector('article')||document.querySelector('main')||document.body;" +
    "var t=(document.title||'')+String.fromCharCode(10)+(e?e.innerText:'');return t.slice(0,15000);})()";
  const r = await evalBrowserJs(appName, js, 6000);
  if (r.error) {
    if (/turned off|not allowed|Allow JavaScript|Apple Events/i.test(String(r.error))) {
      console.log(
        `[scrape] live-DOM read off for ${appName} — enable "Allow JavaScript from ` +
          `Apple Events" (Chrome: View → Developer). Falling back to HTTP fetch.`,
      );
    } else if (r.error !== "automation_denied" && r.error !== "unsupported") {
      console.log(`[scrape] live-DOM read error (${appName}):`, r.error);
    }
    return null;
  }
  const out = String(r.out || "").trim();
  return out.length > 40 ? out : null;
}

// Decode base64 JSON payloads from browser JS (same pattern as browserAct).
function decodeBrowserJsPayload(out) {
  if (!out) return null;
  try {
    const json = Buffer.from(String(out).trim(), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Flattened full-document text as base64 JSON — avoids osascript truncating
// multiline return values (the bug behind ~400-char "full page" scrapes).
// No double quotes or backslashes — AppleScript-safe (same rule as browserAct).
const READ_FULL_PAGE_TEXT_JS =
  "(function(){var root=document.querySelector('main')||document.querySelector('article')||document.body;" +
  "var raw=(document.title||'')+String.fromCharCode(10)+(root?(root.innerText||root.textContent||''):'');" +
  "var t=(''+raw).split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ')" +
  ".split(String.fromCharCode(9)).join(' ');" +
  "while(t.indexOf('  ')>=0)t=t.split('  ').join(' ');t=t.trim().slice(0,24000);" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({t:t,y:Math.floor(window.scrollY||0)," +
  "h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)||0," +
  "vh:Math.floor(window.innerHeight||800)}))));})()";

async function readBrowserFullPageTextOnce(appName) {
  const r = await evalBrowserJs(appName, READ_FULL_PAGE_TEXT_JS, 8000);
  if (r.error || !r.out) return { error: r.error || "empty", text: "", y: 0, h: 0, vh: 800 };
  const payload = decodeBrowserJsPayload(r.out);
  if (!payload || typeof payload.t !== "string") {
    // Fallback: plain string (older path / non-base64).
    const plain = String(r.out || "").trim();
    return { text: plain, y: 0, h: 0, vh: 800 };
  }
  return {
    text: String(payload.t || "").trim(),
    y: Number(payload.y) || 0,
    h: Number(payload.h) || 0,
    vh: Math.max(Number(payload.vh) || 800, 400),
  };
}

// Full-page TEXT read of the open tab — no scrolling, no screenshots.
// Page copy is usually already in the DOM (lazy hooks only gate animations /
// heavy demos). Base64 return avoids osascript truncating multiline text.
// HTTP fetch still can't replace this for SPA shells (empty #root).
async function getBrowserFullPageText(appName) {
  if (!IS_MAC || !appName) return null;
  if (automationOk.browsers[appName] === false) return null;

  const snap = await readBrowserFullPageTextOnce(appName);
  if (snap.error && !snap.text) {
    if (snap.error !== "automation_denied" && snap.error !== "unsupported") {
      console.log(`[scrape] full-page read error (${appName}):`, snap.error);
    }
    return getBrowserPageText(appName);
  }
  if (snap.text && snap.text.length > 40) {
    console.log(`[scrape] OK (full-page text) — ${snap.text.length} chars`);
    return snap.text;
  }
  return getBrowserPageText(appName);
}

async function navigateBrowserTab(appName, url) {
  if (!IS_MAC || !appName || !url) return { ok: false, error: "unsupported" };
  if (automationOk.browsers[appName] === false) return { ok: false, error: "automation_denied" };
  const safeUrl = String(url).trim().replace(/"/g, "");
  if (!/^https?:\/\//i.test(safeUrl)) return { ok: false, error: "invalid_url" };
  const isSafari = /^Safari/.test(appName);
  const script = isSafari
    ? `tell application "${appName}" to set URL of current tab of front window to "${safeUrl}"`
    : `tell application "${appName}" to set URL of active tab of front window to "${safeUrl}"`;
  const run = () => runOsascript(script, 6000);
  const r =
    automationOk.browsers[appName] === true
      ? await run()
      : await withPermissionPrompt(`automation-nav:${appName}`, run);
  if (r.error) {
    if (isAutomationDeniedError(r.error)) automationOk.browsers[appName] = false;
    return { ok: false, error: r.error };
  }
  automationOk.browsers[appName] = true;
  return { ok: true };
}

async function waitForBrowserUrl(appName, wantUrl, { timeoutMs = 9000 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let wantPath = "";
  try {
    wantPath = new URL(wantUrl).pathname.replace(/\/$/, "") || "/";
  } catch {
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = await readBrowserFrontTabUrl(appName, { allowPrompt: false });
    if (cur) {
      try {
        const p = new URL(cur).pathname.replace(/\/$/, "") || "/";
        if (p === wantPath) return true;
      } catch {
        /* keep waiting */
      }
    }
    await sleep(250);
  }
  return false;
}

/**
 * If the user asks about another page on the same site (Download, Pricing…),
 * resolve an absolute URL. Uses recent chat history for short "check it" follow-ups.
 */
function resolveLinkedSitePage(userText, currentUrl, history) {
  let t = String(userText || "").trim();
  if (!t) return null;
  if (/^(ok[,.]?\s+)?(check|look at|review|open|see|read)\s+it[.!?]*$/i.test(t) && Array.isArray(history)) {
    const recent = history
      .slice(-8)
      .map((h) => String(h?.content || h?.text || h?.message || ""))
      .join(" ");
    t = `${recent} ${t}`;
  }
  let origin = "";
  let currentPath = "";
  try {
    const u = new URL(String(currentUrl || "").trim());
    if (!/^https?:$/i.test(u.protocol)) return null;
    origin = u.origin;
    currentPath = u.pathname.replace(/\/$/, "") || "/";
  } catch {
    return null;
  }

  const aliases = [
    {
      path: "/download",
      re: /\b(?:download(?:s)?\s+page|page\s+for\s+downloads?|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?download(?:s)?(?:\s+page)?)\b/i,
    },
    {
      path: "/pricing",
      re: /\b(?:pricing\s+page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?pricing(?:\s+page)?)\b/i,
    },
    {
      path: "/news",
      re: /\b(?:news\s+page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?(?:news|blog)(?:\s+page)?)\b/i,
    },
    {
      path: "/support",
      re: /\b(?:support\s+page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?support(?:\s+page)?)\b/i,
    },
    {
      path: "/privacy",
      re: /\b(?:privacy\s+(?:page|policy)|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?privacy(?:\s+(?:page|policy))?)\b/i,
    },
    {
      path: "/terms",
      re: /\b(?:terms(?:\s+of\s+service)?\s+page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?terms(?:\s+of\s+service)?)\b/i,
    },
    {
      path: "/",
      re: /\b(?:home\s*page|landing\s*page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?(?:home|landing)(?:\s+page)?)\b/i,
    },
  ];

  for (const a of aliases) {
    if (!a.re.test(t)) continue;
    const normalized = a.path.replace(/\/$/, "") || "/";
    if (normalized === currentPath) return null;
    return a.path === "/" ? `${origin}/` : `${origin}${a.path}`;
  }

  const pathHit = t.match(
    /\b(?:https?:\/\/(?:www\.)?lykn\.io)?(\/(?:download|pricing|news|support|privacy|terms|product)(?:\/[\w-]*)?)\b/i,
  );
  if (pathHit) {
    const p = pathHit[1].replace(/\/$/, "") || "/";
    if (p === currentPath) return null;
    try {
      return new URL(pathHit[1], origin).toString();
    } catch {
      return null;
    }
  }
  return null;
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

/** Explicit ask to spend Whisper on video audio — not ordinary "what's this about?". */
function overlayMessageWantsVideoTranscribe(msg) {
  const t = String(msg || "");
  if (!t.trim()) return false;
  return (
    /\b(?:transcribe(?:\s+(?:this|the|it|video|audio|that))?|transcription)\b/i.test(t) ||
    /\b(?:full\s+transcript|(?:get|fetch|pull|download|grab)\s+(?:me\s+)?(?:the\s+)?transcript)\b/i.test(t) ||
    /\b(?:from\s+(?:the\s+)?(?:spoken\s+)?audio|whisper\s+(?:it|this|the\s+video))\b/i.test(t)
  );
}

// Captions-only by default (in-tab → timedtext → API fast). Whisper is slow and
// opt-in — only when the user explicitly asks to transcribe.
async function fetchYouTubeTranscriptViaApi(videoId, { onStatus, allowWhisper } = {}) {
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
    // Fast captions-only pass first.
    let data = await pull("&fast=1", "Reading the video transcript…");
    let text = String(data?.transcript || "").trim();
    let source = String(data?.source || "").toLowerCase();

    // Whisper only when the user explicitly asked — never auto on caption miss.
    if (
      allowWhisper &&
      (!text || source === "description_fallback") &&
      source !== "whisper_full"
    ) {
      data = await pull(
        "&retryWhisper=1",
        "No captions found — transcribing the video audio…",
      );
      text = String(data?.transcript || "").trim();
      source = String(data?.source || "").toLowerCase();
    } else if (
      !allowWhisper &&
      (!text || source === "description_fallback")
    ) {
      console.log("[scrape] yt api: no captions — skipping Whisper (not requested)");
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
// LYKN backend captions path. Whisper only when allowWhisper is set.
async function fetchYouTubeTranscript(videoId, appName, { onStatus, allowWhisper } = {}) {
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

  // 3) LYKN backend captions (fast). Whisper only if the user asked to transcribe.
  const viaApi = await fetchYouTubeTranscriptViaApi(videoId, { onStatus, allowWhisper });
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
  // Require an explicit vault/saved cue — bare "my notes" while Notes is open
  // is screen talk, not a Vault surface ask.
  const saved =
    /\b(?:vault|saved|artifact|artifacts|from\s+(?:my\s+)?(?:vault|notion|drive|gmail|readwise)|what\s+(?:have|did)\s+i\s+save|something\s+i\s+saved|what\s+i\s+saved)\b/i.test(
      t,
    );
  const view =
    /\b(show|see|view|open|pull\s*(?:up|in)|bring\s*(?:up|in)|display|load|find|grab)\b/i.test(t);
  if (saved && view) return true;
  if (
    /\b(?:show|see|open|pull|bring|display|load)\b.{0,48}\b(?:vault|saved|artifact|artifacts)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:show|see|open|pull|bring|display|load)\b.{0,48}\b(?:my|the|that|those)\b.{0,24}\b(?:notes?|files?|pics?|pictures?|photos?|images?|docs?|links?|articles?)\b/i.test(
      t,
    ) &&
    /\b(?:vault|saved)\b/i.test(t)
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
        } else if (Array.isArray(j.sources) && j.sources.length) {
          send("lykn:answer-sources", {
            sources: j.sources
              .filter((s) => s && typeof s.url === "string" && s.url.trim())
              .slice(0, 40)
              .map((s) => ({
                title: String(s.title || "Source").trim().slice(0, 160),
                url: String(s.url).trim(),
              })),
          });
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
            maybeOpenAgentStageDeliverable(opts, {
              url: tc.result.image_url,
              title: "Generated image",
              kind: "image",
            });
            try {
              opts.onAgentDeliverable?.({
                kind: "image",
                title: "Generated image",
                url: tc.result.image_url,
              });
            } catch (_) {}
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
            const fileUrl = resolveToolResultStageUrl(tc.result);
            if (fileUrl) {
              accumulated += `\n\n![lykn_artifact:${title}](${fileUrl})\n\n`;
              send("lykn:answer-delta", {
                text: trimPartialControlTagTail(stripHiddenTags(accumulated)),
              });
              maybeOpenAgentStageDeliverable(opts, {
                url: fileUrl,
                title,
                kind: "artifact",
              });
            }
            // Do not auto-vault — user must Save or ask the AI to keep it.
            // Cache source for the next refine turn (surgical edits).
            // Await so Agent Mode can refine this artifact on the next turn.
            try {
              const code = await extractReactArtifactCodeFromResult(tc.result);
              if (code && code.trim()) {
                lastOverlayReactArtifact = {
                  toolName: "lykn_build_react_artifact",
                  title,
                  code,
                };
                try {
                  opts.onAgentDeliverable?.({
                    kind: "artifact",
                    toolName: "lykn_build_react_artifact",
                    title,
                    code,
                    url: fileUrl || "",
                  });
                } catch (_) {}
              }
            } catch (_) {}
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
            maybeOpenAgentStageDeliverable(opts, {
              url: tc.result.file_url,
              title,
              kind: "video",
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
            maybeOpenAgentStageDeliverable(opts, {
              url: tc.result.chart_url,
              title,
              kind: "chart",
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
              maybeOpenAgentStageDeliverable(opts, {
                url: preview,
                title,
                kind: "diagram",
              });
            }
          } else if (
            tc.status === "done" &&
            tc.result &&
            /(build_template|build_spreadsheet|manage_file|process_image)$/.test(
              String(tc.name || ""),
            )
          ) {
            // Other capability artifacts — open in Agent Browser when possible.
            const title = String(tc.result.title || tc.result.filename || "File")
              .replace(/[\]\n\r]/g, " ")
              .trim() || "File";
            const fileUrl = resolveToolResultStageUrl(tc.result);
            if (fileUrl) {
              maybeOpenAgentStageDeliverable(opts, {
                url: fileUrl,
                title,
                kind: "artifact",
              });
            }
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
function overlayMessageWantsScreenTranslate(text) {
  const t = String(text || "").trim().toLowerCase();
  // Empty / whitespace-only in Translate mode means "translate the screen".
  if (!t) return true;
  if (/\b(on (my|the) screen|my screen|the screen|this (screen|page)|on.?screen|what.?s on)\b/.test(t)) {
    return true;
  }
  if (/\btranslat(e|ion|ing)?\b/.test(t) && /\b(this|that|it|here|everything|all|screen|page)\b/.test(t)) {
    return true;
  }
  if (/^(please\s+)?translat(e|ion)(\s+please)?[.!?]*$/.test(t)) return true;
  return false;
}

function overlayMessageWantsVisualGuidance(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  // "do/can you see...", "are you seeing my screen", "look at this".
  if (/\b(do|can|are) you see(ing)?\b/.test(t)) return true;
  if (/\b(on (my|the) screen|look at (my|the|this)|screenshot|read (the |my )?screen)\b/.test(t)) return true;
  // Translate-the-screen phrasing should keep pixels (or rich page text) in play.
  if (/\btranslat(e|ion|ing)\b/.test(t) && /\b(screen|page|this|that|here|it|everything)\b/.test(t)) {
    return true;
  }
  // Naming a concrete UI element ("the run button", "that settings icon") is
  // about LAYOUT — the page text can't answer where it is or whether it shows.
  if (
    /\b(button|icon|tab|toolbar|menu|sidebar|panel|modal|dialog|field|input|toggle|checkbox|dropdown|slider)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // Ads / analytics UI nouns — often charts and creatives the scrape misses.
  if (
    /\bthe (ad|ads|creative|campaign|graph|chart|plot|preview|audience|bid|budget|metric|ctr|cpc)\b/.test(
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

// Short deictic follow-ups mid-chat ("what about this?", "and that one?")
// usually point at the screen after a UI change — keep pixels, don't go text-only.
function overlayMessageLooksScreenDeictic(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t || t.length > 280) return false;
  if (/\b(compare|vs\.?|versus)\b/.test(t)) return true;
  if (
    /\b(this|that|these|those)\b/.test(t) &&
    /\b(ad|ads|creative|campaign|graph|chart|plot|one|metric|number|result|results|preview|audience|bid|budget|option|setting)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // Bare short deixis with history is almost always about the screen.
  if (t.length <= 80 && /\b(this|that|these|those|here)\b/.test(t)) return true;
  return false;
}

function overlayPageFingerprint(pageContext) {
  if (!pageContext) return "";
  const url = String(pageContext.url || "").trim();
  const title = String(pageContext.title || "").trim();
  if (!url && !title) return "";
  // Include a short text head so SPA route changes without URL churn still count.
  const head = String(pageContext.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `${url}|${title}|${head}`;
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

// Site-wide / beyond-viewport asks: the screenshot (and often the live DOM) only
// covers what's on screen. These need a full-page fetch of the open tab URL —
// never "paste the link" or "scroll down" when we already know the URL.
function overlayMessageWantsFullPage(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (
    /\b(?:rest of|remainder of|other (?:parts?|sections?)|below the fold|further down|whole|entire|full)\b.{0,48}\b(?:page|site|website|web\s?page|landing)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:page|site|website|web\s?page|landing)\b.{0,48}\b(?:rest|whole|entire|full|other sections?|below)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:see|read|review|parse|check|look at)\b.{0,32}\b(?:the\s+)?(?:whole|entire|full)\b.{0,32}\b(?:page|site|website)\b/.test(
      t,
    )
  ) {
    return true;
  }
  // Feedback / audit of "the website" — hero screenshot alone is not enough.
  if (
    /\b(?:website|web\s?site|landing\s?page|homepage|home\s?page|(?:my|this|the)\s+site)\b/.test(t) &&
    /\b(?:better|improve|improvement|feedback|review|audit|critique|redesign|sections?|overall|whole|entire|rest)\b/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

// Last successfully scraped Glass tab — used when a follow-up needs the URL
// even if the live browser target briefly fails to resolve.
let lastOverlayPageUrl = "";
let lastOverlayPageTitle = "";

// Pull the live page/video the user is looking at, plus any earlier ⌘L
// conversation about that same page. Factored out of streamScreenAnswer so it can
// run CONCURRENTLY with the screenshot + auth fetch (it was the slowest serial
// step). Returns best-effort; never throws.
async function gatherOverlayPageContext({
  send,
  superseded,
  userText,
  forceTranscribeVideo,
  forceFullPage,
  history,
} = {}) {
  let pageContext = null;
  const wantFullPage = !!forceFullPage || overlayMessageWantsFullPage(userText);
  try {
    const target = await getActiveBrowserTarget();
    console.log(
      "[scrape] active browser URL:",
      target ? `${target.url} (${target.appName})` : "(none detected)",
    );
    // Fall back to the last Glass tab when the live target blips but the user
    // is clearly asking about the rest of that site.
    const fallbackUrl =
      !target?.url && wantFullPage && lastOverlayPageUrl ? lastOverlayPageUrl : "";
    let effectiveUrl = (target && target.url) || fallbackUrl;
    const effectiveApp = target?.appName || null;

    // Same-site page ask ("check the Download page") — navigate, text-scrape,
    // then return the user to where they were. Never invent that page's content.
    const linkedUrl = resolveLinkedSitePage(
      userText,
      effectiveUrl || lastOverlayPageUrl,
      history,
    );
    let restoredUrl = null;
    if (linkedUrl && effectiveApp) {
      restoredUrl = effectiveUrl || lastOverlayPageUrl || null;
      send("lykn:answer-status", { status: "Opening that page…" });
      console.log(`[scrape] navigate for linked page: ${linkedUrl}`);
      const nav = await navigateBrowserTab(effectiveApp, linkedUrl);
      if (nav.ok) {
        const ready = await waitForBrowserUrl(effectiveApp, linkedUrl, { timeoutMs: 9000 });
        if (!ready) await new Promise((r) => setTimeout(r, 600));
        effectiveUrl = linkedUrl;
      } else {
        console.log(`[scrape] navigate failed: ${nav.error}`);
      }
    }

    if (effectiveUrl) {
      // Remember the LYKN project the user is viewing so writes (tasks,
      // events, project state) scope to it — including on later follow-ups
      // that skip this scrape.
      const sniffedProjectId = extractLyknProjectId(effectiveUrl);
      if (sniffedProjectId) overlayActiveProjectId = sniffedProjectId;

      let title = fallbackUrl && !target?.url ? lastOverlayPageTitle : "";
      let text = "";
      let kind = "page";
      let videoTranscriptMissing = false;

      // YouTube: try captions (fast). Whisper audio transcription is opt-in
      // only — "transcribe this" / "get the transcript" — not every ask.
      const ytId = parseYouTubeId(effectiveUrl);
      if (ytId) {
        const allowWhisper =
          !!forceTranscribeVideo || overlayMessageWantsVideoTranscribe(userText);
        send("lykn:answer-status", {
          status: allowWhisper
            ? "Reading / transcribing the video…"
            : "Reading the video transcript…",
        });
        const yt = await fetchYouTubeTranscript(ytId, effectiveApp, {
          allowWhisper,
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
        pageContext = { url: effectiveUrl, title, text: text.slice(0, 16000), kind };
        lastOverlayPageUrl = effectiveUrl;
        lastOverlayPageTitle = title || "";
        send("lykn:page-source", { url: effectiveUrl, title });
      } else {
        const needFullText = wantFullPage || !!linkedUrl;
        send("lykn:answer-status", {
          status: needFullText ? "Reading the page text…" : "Reading the page…",
        });
        // 1) Live rendered DOM from the user's own tab.
        // Site-wide / linked-page asks: scroll + accumulate TEXT only (no
        // screenshots). HTTP fetch of SPA shells like lykn.io is empty.
        if (effectiveApp) {
          const live = needFullText
            ? (await getBrowserFullPageText(effectiveApp)) ||
              (await getBrowserPageText(effectiveApp))
            : await getBrowserPageText(effectiveApp);
          if (live) {
            const nl = live.indexOf("\n");
            title = (title || (nl > 0 ? live.slice(0, nl).trim() : "")).trim();
            text = (nl > 0 ? live.slice(nl + 1) : live)
              .replace(/[ \t]+/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            console.log(
              `[scrape] OK (${needFullText ? "full-page DOM" : "live DOM"}) — "${title || "(no title)"}" (${text.length} chars)`,
            );
          }
        }
        // 2) HTTP fetch — only when live DOM failed, or as a supplement when
        // site-wide text is still thin (SSR sites). SPA shells stay empty.
        const THIN_PAGE_CHARS = 800;
        if (!text || (needFullText && text.length < THIN_PAGE_CHARS)) {
          const page = await scrapePageText(effectiveUrl);
          if (page && page.text) {
            title = title || page.title;
            if (!text || page.text.length > text.length + 200) {
              text = page.text;
              console.log(`[scrape] OK (http) — "${title || "(no title)"}" (${text.length} chars)`);
            } else {
              console.log(
                `[scrape] http shorter than DOM (${page.text.length} vs ${text.length}) — keeping DOM`,
              );
            }
          }
        }
        if (text) {
          pageContext = {
            url: effectiveUrl,
            title,
            text: text.slice(0, needFullText ? 16000 : 12000),
            // So the prompt can say "we only have the page/description" instead
            // of the model inventing a fake "transcript fetch error".
            ...(videoTranscriptMissing ? { videoTranscriptMissing: true } : {}),
            ...(linkedUrl ? { linkedPage: true } : {}),
          };
          lastOverlayPageUrl = effectiveUrl;
          lastOverlayPageTitle = title || "";
          send("lykn:page-source", { url: effectiveUrl, title });
        } else {
          // Still surface the known URL so the model / server can web_fetch it.
          if (needFullText) {
            pageContext = {
              url: effectiveUrl,
              title: title || lastOverlayPageTitle || "",
              text: "",
              ...(linkedUrl ? { linkedPage: true } : {}),
            };
            send("lykn:page-source", { url: effectiveUrl, title: pageContext.title });
          }
          console.log("[scrape] failed to extract text from", effectiveUrl);
        }
      }

      // Put the user back on the page they were viewing.
      if (restoredUrl && effectiveApp && linkedUrl && restoredUrl !== linkedUrl) {
        send("lykn:answer-status", { status: "Returning to your page…" });
        await navigateBrowserTab(effectiveApp, restoredUrl);
        // Keep pageContext.url as the linked page we actually read.
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

async function streamScreenAnswer(event, {
  text,
  history,
  attachments,
  forceImage,
  buildMode,
  deepResearch,
  translateMode,
  translateTargetLang,
  transcribeVideo,
  scopedProjectId,
  scopedProjectName,
}) {
  const targetLang = String(translateTargetLang || "").trim().slice(0, 64);
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
  // Translate-the-screen asks always need fresh page/screen grounding.
  const screenTranslateAsk =
    !!translateMode && overlayMessageWantsScreenTranslate(text);
  // Site-wide / other-page asks need a fresh TEXT scrape — never skip, and
  // never burn Screen Recording on a stack of scroll screenshots.
  const wantsFullPage = overlayMessageWantsFullPage(text);
  const linkedPageHint = resolveLinkedSitePage(
    text,
    lastOverlayPageUrl,
    history,
  );
  const textOnlySiteRead = wantsFullPage || !!linkedPageHint;
  const skipScreenContext =
    !screenTranslateAsk &&
    !textOnlySiteRead &&
    conversationFollowUp &&
    imageAtts.length === 0 &&
    textAtts.length === 0;
  const liveWatchSummary = !skipScreenContext ? getFreshLiveWatchSummary(4000) : "";

  // Screen Recording only when we likely need pixels (explicit visual ask, or
  // page scrape unavailable). Text-rich / full-page site reads stay text-only.
  const explicitVisualAskEarly = overlayMessageWantsVisualGuidance(text);
  const pageScrapeLikelyBlocked =
    imageAtts.length > 0 ||
    skipScreenContext ||
    automationOk.systemEvents === false;
  const likelyNeedsPixels =
    !textOnlySiteRead &&
    !skipScreenContext &&
    imageAtts.length === 0 &&
    (explicitVisualAskEarly || pageScrapeLikelyBlocked || screenTranslateAsk);
  let screenAccess = { ok: true, status: screenCaptureStatus(), prompted: false };
  if (likelyNeedsPixels) {
    screenAccess = await ensureScreenRecordingAccess();
    if (!screenAccess.ok) {
      send("lykn:answer-error", {
        message: screenRecordingDeniedMessage(screenAccess),
      });
      return;
    }
  }

  // Immediate UI feedback while scrape/token run — don't wait for TTFT.
  if (!skipScreenContext) {
    send("lykn:answer-status", {
      status: textOnlySiteRead
        ? "Reading page text…"
        : likelyNeedsPixels
          ? "Reading screen…"
          : "Reading page…",
    });
  } else {
    send("lykn:answer-status", { status: "Thinking…" });
  }

  // Auth + page scrape first. Capture ONLY if we still need pixels after scrape
  // — text-rich browser pages used to pay encode+upload cost for a screenshot
  // we then threw away. Native apps / thin pages still capture as before.
  const skipPageScrape =
    imageAtts.length > 0 ||
    skipScreenContext ||
    (!!screenAccess.prompted && !textOnlySiteRead) ||
    (automationOk.systemEvents === false && !textOnlySiteRead);
  const pageContextPromise = !skipPageScrape
    ? gatherOverlayPageContext({
        send,
        superseded,
        userText: text,
        // Menu → Transcribe video always allows Whisper even if wording is thin.
        forceTranscribeVideo: !!transcribeVideo,
        forceFullPage: textOnlySiteRead,
        history,
      })
    : Promise.resolve({ pageContext: null, pastPageSection: "" });
  const tokenPromise = getAuthToken().catch(() => null);
  const explicitVisualAsk = explicitVisualAskEarly;

  const [pageBundle, token] = await Promise.all([pageContextPromise, tokenPromise]);
  if (superseded()) return;

  const pageContext = pageBundle?.pageContext || null;
  const pastPageSection = pageBundle?.pastPageSection || "";

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
  // nothing — the single biggest "feels instant" win for reading pages.
  const RICH_PAGE_TEXT_CHARS = 600;
  const hasRichPageText =
    !!pageContext &&
    pageContext.kind !== "video" &&
    (pageContext.text?.length || 0) >= RICH_PAGE_TEXT_CHARS;
  // A message that clearly wants VISUAL help ("do you see this?", "how do I
  // run this?", "where do I click?") must keep the pixels even when the page
  // is text-rich — the text-only fast path leaves the model blind to layout.
  // Page fingerprint changes alone do NOT force a screenshot upload anymore;
  // that was a common "every navigation feels slow" tax when page text is enough.
  const pageFingerprint = overlayPageFingerprint(pageContext);
  const hasChatHistory = Array.isArray(history) && history.length > 0;
  // Screen-translate: prefer rich page text when available (more accurate than
  // OCR); otherwise force a screenshot so native apps / thin pages still work.
  const wantsVisualGuidance =
    !textOnlySiteRead &&
    !skipScreenContext &&
    (explicitVisualAsk ||
      (screenTranslateAsk && !hasRichPageText) ||
      (!hasRichPageText && hasChatHistory && overlayMessageLooksScreenDeictic(text)));
  const shouldCapture =
    !textOnlySiteRead &&
    !skipScreenContext &&
    imageAtts.length === 0 &&
    !hasVideoTranscript &&
    !(forceImage && imageAtts.length) &&
    (wantsVisualGuidance ||
      (screenTranslateAsk && !hasRichPageText) ||
      (!hasRichPageText && !liveWatchSummary));

  let dataURL = null;
  if (shouldCapture && screenCaptureStatus() === "granted") {
    if (liveWatchSummary && liveWatchLastFrameUrl && !wantsVisualGuidance) {
      dataURL = liveWatchLastFrameUrl;
    } else {
      send("lykn:answer-status", { status: "Reading screen…" });
      dataURL = await capturePrimaryScreen({
        maxWidth: 1536,
        format: "jpeg",
        quality: 82,
      }).catch(() => null);
    }
  } else if (
    !skipScreenContext &&
    !hasRichPageText &&
    !hasVideoTranscript &&
    liveWatchSummary &&
    liveWatchLastFrameUrl &&
    !wantsVisualGuidance
  ) {
    // Thin page + live watch: reuse last frame without a fresh capture.
    dataURL = liveWatchLastFrameUrl;
  }
  if (superseded()) return;

  // Capture failure is only fatal when we have nothing else to ground on.
  const hasPageGrounding =
    !!(pageContext && (pageContext.text || pageContext.title || pageContext.url)) ||
    !!liveWatchSummary ||
    imageAtts.length > 0 ||
    textAtts.length > 0;
  if (shouldCapture && !dataURL && !hasPageGrounding) {
    send("lykn:answer-error", { message: "Couldn't capture the screen." });
    return;
  }

  // Live Watch already ran a recent vision pass — skip the screenshot upload when
  // there's no scraped page text (games, native apps) to stay fast.
  // Full-page / linked-page site reads are TEXT-ONLY — never attach a scroll
  // of screenshots; the accumulated DOM text is the ground truth.
  let attachScreenshot =
    !textOnlySiteRead &&
    !!dataURL &&
    !hasVideoTranscript &&
    (wantsVisualGuidance || (!hasRichPageText && !liveWatchSummary));
  // Image mode with an attached image: the attachment IS the subject being
  // generated from — a stray screen capture riding along just confuses the
  // model about which image the user means (and could bleed screen content
  // into the generation). Drop it; the attachment carries the pixels.
  if (forceImage && imageAtts.length) attachScreenshot = false;
  if (!skipScreenContext && pageFingerprint) {
    lastOverlayPageFingerprint = pageFingerprint;
  }
  if (hasRichPageText && !attachScreenshot) {
    console.log(
      `[overlay-ask] text-rich page (${pageContext.text.length} chars) — skip screenshot capture/upload, staying on fast model`,
    );
  } else if (hasRichPageText && attachScreenshot) {
    console.log(
      `[overlay-ask] text-rich page (${pageContext.text.length} chars) but message wants visual guidance — keeping screenshot`,
    );
  }
  // Keep this prompt tiny — server injects LYKN_GLASS_STREAM_PERSONA_SLIM
  // (voice, vault/project/build gates, markdown). Here we only name the
  // context modality so the model knows what the attachments/scrapes are.
  let prompt = skipScreenContext
    ? "Glass follow-up. Answer the latest message only — no screen re-brief."
    : hasVideoTranscript
    ? "Glass: video transcript below is authoritative. Answer from it; don't ask for the link."
    : attachScreenshot
    ? "Glass: attached image is the user's screen. Deictic asks ('this'/'that'/'here') → screen. " +
      "General/small-talk → answer normally, don't narrate the screen. " +
      OVERLAY_IGNORE_NOTE
    : hasRichPageText
    ? "Glass: page text below is your view of their screen. Deictic asks → page. General/small-talk → normal answer."
    : "Glass: use attached image(s)/files if relevant; otherwise answer normally.";
  if (deepResearch) {
    prompt +=
      "\n\nRESEARCH MODE: Multi-step deep research with citations. Prefer " +
      "[DEEP_RESEARCH_EVIDENCE] / [RESEARCH_REPORT_INSTRUCTIONS] (or [WEB_SEARCH_RESULTS] " +
      "fallback). Write a structured report with ## headers, key findings, caveats, then " +
      "Sources as markdown links. Never invent URLs. Deliver as markdown in the reply ONLY — " +
      "do NOT call lykn_build_* or create a side-panel artifact/deck. Mentions of pitch/investor " +
      "are topic framing for this written report, not a Build request.";
  }
  if (translateMode) {
    prompt += targetLang
      ? `\n\nTRANSLATE MODE: Target language is ${targetLang} — do not ask which language. ` +
        `If the user typed/dictated text to translate, translate that into ${targetLang}. ` +
        `If they ask to translate the screen/page (or sent little/no text), translate all readable ` +
        `on-screen or page text from the screenshot/page content below into ${targetLang}. ` +
        `Lead with the translation; keep extras minimal.`
      : "\n\nTRANSLATE MODE: Translate typed/dictated text, or on-screen/page content when they " +
        "ask to translate the screen (or send little/no text), into the target language they name. " +
        "If no target language is named, ask once briefly. Lead with the translation; keep extras minimal.";
  }
  if (transcribeVideo) {
    prompt +=
      "\n\nTRANSCRIBE VIDEO: Provide the spoken content from the transcript below (or say " +
      "plainly if unavailable). Offer a clean transcript and a short summary.";
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
      "\n\nVideo transcript (authoritative; ignore if ask is unrelated):\n" +
      `URL: ${pageContext.url}\n` +
      (pageContext.title ? `Title: ${pageContext.title}\n` : "") +
      `--- VIDEO TRANSCRIPT ---\n${pageContext.text}\n--- END ---`;
  } else if (pageContext && pageContext.videoTranscriptMissing) {
    prompt +=
      "\n\nYouTube open but no captions/transcript — answer from title/description only; don't invent spoken content. " +
      "If they need the spoken words, tell them briefly to ask you to \"transcribe\" the video.\n" +
      `URL: ${pageContext.url}\n` +
      (pageContext.title ? `Title: ${pageContext.title}\n` : "") +
      `--- PAGE TEXT (not a transcript) ---\n${pageContext.text}\n--- END ---`;
  } else if (pageContext) {
    // When the screenshot rides along (visual-guidance asks), the image is the
    // primary context — cap the scraped text hard so the prompt stays small
    // and time-to-first-token stays low. Site-wide / full-page asks keep the
    // full scrape so "rest of the website" isn't answered from the hero alone.
    const pageBody =
      attachScreenshot && !textOnlySiteRead
        ? String(pageContext.text || "").slice(0, 3000)
        : pageContext.text;
    prompt += attachScreenshot
      ? "\n\nPage open (screenshot primary; text supporting):\n" +
        `URL: ${pageContext.url}\n` +
        (pageContext.title ? `Title: ${pageContext.title}\n` : "") +
        `--- PAGE TEXT ---\n${pageBody}\n--- END ---`
      : "\n\nPage open (text primary):\n" +
        `URL: ${pageContext.url}\n` +
        (pageContext.title ? `Title: ${pageContext.title}\n` : "") +
        `--- PAGE CONTENT ---\n${pageBody}\n--- END ---`;
    if (pageContext.url) {
      prompt +=
        "\n\nPAGE URL / TEXT above is what you can see. " +
        "Answer ONLY from that text (and any screenshot if attached). " +
        "If they ask about a different page whose text is NOT above, do NOT pretend you opened it — " +
        "say you don't have that page's content yet. Never narrate 'I'm checking X now' without X's text here.";
    }
    if (pageContext.linkedPage) {
      prompt +=
        "\n\nLINKED PAGE: the PAGE CONTENT above was loaded from the page they asked about " +
        `(${pageContext.url}). Treat it as authoritative for that page.`;
    }
  } else if (textOnlySiteRead && lastOverlayPageUrl) {
    prompt +=
      "\n\nOpen tab URL (from earlier Glass scrape — page text unavailable this turn):\n" +
      `URL: ${lastOverlayPageUrl}\n` +
      (lastOverlayPageTitle ? `Title: ${lastOverlayPageTitle}\n` : "") +
      "You do NOT currently have that page's body text. Say so briefly — do not invent the page.";
  }
  if (pastPageSection) {
    prompt +=
      "\n\nEarlier chats on this page (continuity; ignore if unrelated):\n" +
      pastPageSection;
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
    // Web search: Deep research / explicit asks / live-freshness arm Serper.
    // Everything else stays skipWebSearch for latency — the model can still
    // call lykn_web_search via the agent loop when needed.
    // Exclusive Glass composer mode — server locks Create inference in research/
    // image/translate so "report for a pitch" stays a written research report.
    ...(deepResearch
      ? { composerMode: "research" }
      : forceImage
        ? { composerMode: "image" }
        : translateMode
          ? { composerMode: "translate" }
          : buildMode
            ? { composerMode: "create:webapp" }
            : {}),
    ...(deepResearch || overlayShouldForceWebSearch(String(text || ""))
      ? {
          skipWebSearch: false,
          forceWebSearch: true,
          ...(deepResearch ? { deepResearch: true } : {}),
        }
      : { skipWebSearch: true }),
    ...(translateMode
      ? {
          translateMode: true,
          ...(targetLang ? { translateTargetLang: targetLang } : {}),
        }
      : {}),
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
    // Server uses this to strip chart/diagram/webapp builders when the turn
    // has live screen/page context and no explicit Create/Build ask.
    overlayScreenContext: !skipScreenContext,
    // Known open-tab URL + site-wide intent → server keeps web_fetch armed.
    // Skip server HTTP pre-fetch when the scroll scrape already got rich text —
    // SPA shells (lykn.io) return empty HTML over HTTP and confuse the model.
    ...((pageContext?.url || (textOnlySiteRead && lastOverlayPageUrl))
      ? { pageUrl: String(pageContext?.url || lastOverlayPageUrl).trim() }
      : {}),
    ...(textOnlySiteRead
      ? {
          forcePageFetch: true,
          pageTextRich: String(pageContext?.text || "").trim().length >= 800,
        }
      : {}),
    // Explicit project scope from the Glass Projects menu — not ambient URL
    // sniffing. Server only injects [WHAT_IM_ON] / project tools when scoped
    // or the user asked about a project in their message.
    ...(scopedProjectId
      ? {
          scopedProjectId: String(scopedProjectId).trim(),
          projectId: String(scopedProjectId).trim(),
          ...(scopedProjectName
            ? { scopedProjectName: String(scopedProjectName).trim().slice(0, 120) }
            : {}),
        }
      : {}),
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
  // Renderer-initiated summon (Studio desktop right-click → "Open LYKN Glass").
  // Same path as the ⌘/Ctrl+L hotkey: show the bar and focus the composer.
  ipcMain.on("lykn:show-overlay", () => {
    try {
      showOverlay();
      focusOverlayForTyping();
    } catch (_) {}
  });
  ipcMain.on("lykn:focus-overlay-composer", () => focusOverlayForTyping());
  ipcMain.on("lykn:agent-finished-popup-close", () => closeAgentFinishedPopup());
  ipcMain.on("lykn:agent-finished-popup-open", (_e, agentId) => {
    const fallbackId =
      agentFinishedPopup && !agentFinishedPopup.isDestroyed()
        ? String(agentFinishedPopup.__lyknAgentId || "").trim()
        : "";
    const id = String(agentId || fallbackId || "").trim();
    closeAgentFinishedPopup();
    try {
      if (id) {
        const rt = initAgentRuntime();
        const switched = rt.switchAgent?.(id);
        // Always raise that worker's browser tab (even welcome-only tabs).
        // showAgentBrowserWindow raises the right host (Studio dock or,
        // only when no Studio window exists, the standalone stage).
        showAgentBrowserWindow(id, {
          focus: true,
          label: switched?.agent?.title || "Agent",
        });
      }
      showOverlay();
      focusOverlayForTyping();
    } catch (_) {}
  });
  ipcMain.on("lykn:reset-overlay-position", () => {
    resetOverlayPositionToDefault();
    healOverlayGeometry(true);
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("lykn:overlay-shown");
      }
    } catch (_) {}
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
    // Studio replaced the AppSidebar chat shell as the product home.
    void chatId;
    showStudioWindow();
  });
  // ── LYKN Studio (liquid-glass workspace window) ────────────────────────
  ipcMain.on("lykn:studio-set", (_e, { open } = {}) => {
    if (open) showStudioWindow();
    else hideStudioWindow();
  });
  // Fullscreen toggle for the Studio window — plain native fullscreen; the
  // enter/leave events broadcast the new state to the renderer. While the
  // window is in SIMPLE fullscreen (no separate Space), exit that mode
  // instead — setFullScreen(false) wouldn't touch it.
  ipcMain.on("lykn:studio-fullscreen-set", (_e, { fullscreen } = {}) => {
    const win = studioWindowRef();
    if (!win) return;
    try {
      if (typeof win.isSimpleFullScreen === "function" && win.isSimpleFullScreen()) {
        if (!fullscreen) {
          win.setSimpleFullScreen(false);
          broadcastStudioFullscreen();
        }
        return;
      }
    } catch (_) {}
    win.setFullScreen(!!fullscreen);
  });
  ipcMain.handle("lykn:studio-fullscreen-get", () => ({
    fullscreen: studioFullscreenActive(),
  }));
  // Yellow dot — native or in-page: exit fullscreen if needed, then minimize.
  ipcMain.on("lykn:studio-minimize", () => {
    const win = studioWindowRef();
    if (!win) return;
    afterStudioFullscreenExit(win, () => win.minimize());
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
    if (open) {
      hideLangPickerWindow();
      showMenuWindow();
    } else hideMenuWindow();
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
    if (open) {
      hideLangPickerWindow();
      showPickerWindow();
    } else hidePickerWindow();
  });
  ipcMain.on("lykn:picker-close", () => hidePickerWindow());
  // Translate-mode language picker (detached vibrancy card under the To pill).
  ipcMain.on("lykn:lang-picker-set", (_e, { open, anchor } = {}) => {
    if (open) showLangPickerWindow(anchor);
    else hideLangPickerWindow();
  });
  ipcMain.on("lykn:lang-picker-close", () => hideLangPickerWindow());
  ipcMain.on("lykn:lang-picker-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0) {
      langPickerHeight = h;
      positionLangPickerWindow();
    }
  });
  ipcMain.on("lykn:lang-picker-select", (_e, { lang } = {}) => {
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("lykn:lang-picker-select", {
          lang: String(lang || ""),
        });
      }
    } catch (_) {}
  });
  ipcMain.handle("lykn:lang-picker-state", async () => {
    try {
      if (!overlayWindow || overlayWindow.isDestroyed()) return null;
      return await overlayWindow.webContents.executeJavaScript(
        "window.__lyknLangPickerState ? window.__lyknLangPickerState() : null",
        true,
      );
    } catch (_) {
      return null;
    }
  });
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
  // During drag, only move the bar. Repositioning menu/picker/live/panel on
  // every pixel was stalling the cursor; those catch up on lykn:move-end.
  let overlayMoveSideTimer = null;
  const followOverlaySideWindows = () => {
    if (overlayMoveSideTimer) {
      clearTimeout(overlayMoveSideTimer);
      overlayMoveSideTimer = null;
    }
    positionMenuWindow();
    positionPickerWindow();
    positionLangPickerWindow();
    positionLiveWindow();
    positionPanelWindow();
    positionAgentSidebarWindow();
  };
  ipcMain.on("lykn:move-by", (_e, { dx, dy } = {}) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const rdx = Math.round(dx || 0);
    const rdy = Math.round(dy || 0);
    if (!rdx && !rdy) return;
    const b = overlayWindow.getBounds();
    const workArea = overlayWorkArea(b);
    const margin = 8;
    const maxX = workArea.x + workArea.width - b.width;
    const maxY = workArea.y + workArea.height - b.height - margin;
    const nx = Math.max(workArea.x, Math.min(b.x + rdx, maxX));
    const ny = Math.max(workArea.y + margin, Math.min(b.y + rdy, Math.max(workArea.y + margin, maxY)));
    overlayProgrammaticMove = true;
    try {
      overlayWindow.setBounds(
        { x: nx, y: ny, width: b.width, height: b.height },
        false,
      );
    } catch (_) {
      try {
        overlayWindow.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
      } catch (_) {
        /* ignore */
      }
    }
    overlayProgrammaticMove = false;
    overlayUserPositioned = true;
    overlayAnchorLeft = nx;
    overlayAnchorBottomY = ny + b.height;
    // Safety net if the renderer never sends move-end (stuck drag / crash).
    if (overlayMoveSideTimer) clearTimeout(overlayMoveSideTimer);
    overlayMoveSideTimer = setTimeout(() => {
      overlayMoveSideTimer = null;
      followOverlaySideWindows();
    }, 120);
  });
  ipcMain.on("lykn:move-end", () => {
    followOverlaySideWindows();
  });
  ipcMain.on("lykn:ask", (event, args) => {
    streamScreenAnswer(event, args || {});
  });

  // ── Agent Mode IPC (parallel agents; does not share overlayAskGeneration) ─
  const runtime = () => initAgentRuntime();

  ipcMain.handle("lykn:agent-create", async (_e, payload = {}) => {
    // "New agent" from the rail = new tab too: agents and tabs are paired.
    const res = runtime().createAgent(payload || {});
    if (res?.ok && res.agentId) {
      try {
        showAgentBrowserWindow(res.agentId, {
          focus: true,
          label: res.agent?.title || "New agent",
        });
        requestOmniboxFocusForTab(res.agentId);
      } catch (_) {}
    }
    return res;
  });
  ipcMain.handle("lykn:agent-list", async () => {
    const rt = runtime();
    return {
      agents: rt.listPublic(),
      activeAgentId: rt.getActiveId(),
      agentModeOn: rt.isAgentModeOn(),
    };
  });
  ipcMain.handle("lykn:agent-switch", async (_e, agentId) => runtime().switchAgent(agentId));
  ipcMain.handle("lykn:agent-stop", async (_e, agentId) => runtime().stopAgent(agentId));
  ipcMain.handle("lykn:agent-close", async (_e, agentId) => {
    // Deleting an agent from the rail also retires its browser tab — capture
    // it for the History section before teardown wipes the view/meta.
    const snap = snapshotAgentBrowserHistory(agentId);
    const res = runtime().closeAgent(agentId);
    if (res?.ok) commitAgentBrowserHistory(snap);
    return res;
  });
  ipcMain.handle("lykn:agent-reset-main", async () => runtime().resetMainChat());
  ipcMain.handle("lykn:agent-send", async (_e, payload = {}) => {
    const { agentId, text, attachments } = payload || {};
    return runtime().send(agentId, { text, attachments });
  });
  ipcMain.handle("lykn:agent-choice-resolve", async (_e, payload = {}) => {
    const { agentId, choiceId, buttonId } = payload || {};
    return runtime().resolveChoice(agentId, { choiceId, buttonId });
  });
  ipcMain.handle("lykn:agent-mode-set", async (_e, { open } = {}) => {
    const rt = runtime();
    const res = rt.setAgentMode(!!open);
    agentSidebarOpen = !!open;
    if (open) {
      showAgentSidebarWindow();
      // Glass stays on Main; always open the agent browser (standby worker tab).
      const agents = Array.isArray(res.agents) ? res.agents : [];
      const worker =
        agents.find((a) => a && a.role !== "main") ||
        agents.find((a) => a && a.id && a.id !== res.mainAgentId);
      let browserId = worker?.id || res.linkedBrowserId || "";
      if (!browserId) {
        try {
          const created = rt.createAgent?.({
            title: "Agent 1",
            silent: true,
            activate: false,
          });
          browserId = created?.agentId || "";
          if (browserId) {
            agents.push(created.agent);
          }
        } catch (_) {}
      }
      if (browserId) {
        try {
          rt.setMainLinkedBrowser?.(browserId);
        } catch (_) {}
        showAgentBrowserWindow(browserId, {
          focus: false,
          label: (worker && worker.title) || "Agent 1",
        });
      }
    } else {
      hideAgentSidebarWindow();
    }
    return { ...res, browserVisible: open ? agentStageVisible() : false };
  });
  ipcMain.handle("lykn:agent-history", async (_e, agentId) => {
    return runtime().getSwitchSnapshot(agentId);
  });
  ipcMain.handle("lykn:agent-show-browser", async (_e, { agentId, visible } = {}) => {
    const id = agentId || runtime().getActiveId();
    if (!id) return { ok: false, error: "no_agent" };
    if (visible === false) {
      hideAllAgentBrowserWindows();
      return { ok: true, visible: false };
    }
    showAgentBrowserWindow(id, { focus: true });
    return { ok: true, visible: agentStageVisible() };
  });
  ipcMain.handle("lykn:agent-browser-visible", async () => ({
    ok: true,
    visible: agentStageVisible(),
  }));
  ipcMain.handle("lykn:agent-show-step", async (_e, { agentId, stepIndex } = {}) => {
    const id = agentId || runtime().getActiveId();
    if (!id) return { ok: false, error: "no_agent" };
    return runtime().showStepDeliverable(id, stepIndex);
  });
  ipcMain.on("lykn:agent-sidebar-set", (_e, { open } = {}) => {
    agentSidebarOpen = !!open;
    if (open) showAgentSidebarWindow();
    else hideAgentSidebarWindow();
  });
  ipcMain.on("lykn:agent-sidebar-resize", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 0 && h !== agentSidebarHeight) {
      agentSidebarHeight = h;
      positionAgentSidebarWindow();
      positionMenuWindow();
    }
  });
  ipcMain.handle("lykn:agent-stage-navigate", async (_e, { url } = {}) => {
    // Chrome-style omnibox: URLs load directly, plain text Googles it.
    const target = omniboxToUrl(url);
    if (!target) return { ok: false, error: "missing_url" };
    let id = agentStageActiveId || runtime().getActiveId();
    // Typing with no tab open just starts one, like a fresh browser window.
    if (!id) {
      openFreshStudioBrowserTab();
      id = agentStageActiveId || [...agentBrowserViews.keys()].pop();
    }
    if (!id) return { ok: false, error: "no_agent" };
    if (isAgentArtifactTabId(id)) {
      const view = agentBrowserViews.get(id);
      const wc = view?.webContents;
      if (!wc || wc.isDestroyed()) return { ok: false, error: "no_browser" };
      if (!agentStageUrlAllowed(target)) return { ok: false, error: "blocked_url" };
      try {
        await wc.loadURL(target);
        pushAgentStageState();
        return { ok: true, url: target };
      } catch (e) {
        return { ok: false, error: e?.message || "nav_failed" };
      }
    }
    const wc = getAgentBrowserWebContents(id);
    if (!wc) return { ok: false, error: "no_browser" };
    showAgentBrowserWindow(id, { focus: true });
    const nav = await ownedBrowserAct.navigate(wc, target);
    if (nav?.ok && nav.url) {
      pushAgentStageState();
    }
    return nav;
  });
  ipcMain.handle("lykn:agent-stage-back", async () => {
    const wc = getActiveAgentBrowserWebContents();
    if (wc?.canGoBack()) wc.goBack();
    return { ok: true };
  });
  ipcMain.handle("lykn:agent-stage-forward", async () => {
    const wc = getActiveAgentBrowserWebContents();
    if (wc?.canGoForward()) wc.goForward();
    return { ok: true };
  });
  ipcMain.handle("lykn:agent-stage-reload", async () => {
    const wc = getActiveAgentBrowserWebContents();
    if (wc) wc.reload();
    return { ok: true };
  });
  // Download the active tab. Artifact tabs (reports, built apps) save their
  // HTML into ~/Downloads; regular pages download the current URL.
  ipcMain.handle("lykn:agent-stage-download", async () => {
    const id = agentStageActiveId;
    const view = id ? agentBrowserViews.get(id) : null;
    const wc = view?.webContents;
    if (!id || !wc || wc.isDestroyed()) return { ok: false, error: "no_tab" };
    const meta = agentBrowserMeta.get(id) || {};
    const url = String(wc.getURL() || "");
    const isArtifactTab =
      meta.kind === "artifact" ||
      isAgentArtifactTabId(id) ||
      /^data:|^lykn-artifact:/i.test(url);
    if (isArtifactTab) {
      let html = "";
      // Prefer the original source over the rendered DOM.
      const cacheHit = url.match(/^lykn-artifact:\/\/([a-z0-9]+)/i);
      if (cacheHit) html = artifactHtmlCache.get(cacheHit[1]) || "";
      if (!html && /^data:text\/html/i.test(url)) {
        try {
          const [head, payload = ""] = url.split(/,(.+)/s);
          html = /;base64/i.test(head)
            ? Buffer.from(payload, "base64").toString("utf8")
            : decodeURIComponent(payload);
        } catch (_) {}
      }
      if (!html) {
        try {
          html = String(
            (await wc.executeJavaScript("document.documentElement.outerHTML", true)) || "",
          );
          if (html && !/^\s*<!doctype/i.test(html)) html = `<!doctype html>\n${html}`;
        } catch (_) {}
      }
      if (!html.trim()) return { ok: false, error: "no_content" };
      try {
        const target = saveHtmlToDownloads(html, meta.pageTitle || wc.getTitle() || "artifact");
        try {
          shell.showItemInFolder(target);
        } catch (_) {}
        return { ok: true, path: target };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }
    if (/^https?:\/\//i.test(url)) {
      try {
        wc.downloadURL(url);
        return { ok: true, started: true };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }
    return { ok: false, error: "nothing_to_download" };
  });
  ipcMain.handle("lykn:agent-stage-select", async (_e, { agentId } = {}) => {
    const id = String(agentId || "").trim();
    if (!id) return { ok: false, error: "missing_id" };
    if (!agentBrowserViews.has(id)) return { ok: false, error: "not_found" };

    // Switching away cancels a pending new-tab omnibox focus.
    if (agentStagePendingOmniboxFocusId && agentStagePendingOmniboxFocusId !== id) {
      agentStagePendingOmniboxFocusId = null;
    }

    // Correlate stage tab → Glass agent chat. Legacy art-* tabs use ownerAgentId;
    // one-tab-per-agent reuses the agent id even when kind is "artifact".
    const meta = agentBrowserMeta.get(id) || {};
    const tabAgentId = isAgentArtifactTabId(id)
      ? String(meta.ownerAgentId || "").trim()
      : id;

    const rt = runtime();
    const glassId = rt.getActiveId?.();

    // One agent per tab: clicking a tab always selects its agent in the rail.
    let switched = { ok: true, agentId: glassId || tabAgentId || id };
    if (tabAgentId) {
      switched = rt.switchAgent(tabAgentId);
      showAgentBrowserWindow(id, { focus: true });
    }

    // Keep the clicked stage tab visible.
    agentStageActiveId = id;
    raiseAgentBrowserHost({ focus: true });
    layoutAgentStageViews();
    pushAgentStageState();
    return { ...switched, tabId: id, linkedOnly: false };
  });
  ipcMain.handle("lykn:agent-stage-close-tab", async (_e, { agentId } = {}) => {
    const id = String(agentId || "").trim();
    if (!id) return { ok: false, error: "missing_id" };
    // Capture the tab for the rail's History section before teardown.
    const historySnap = snapshotAgentBrowserHistory(id);
    // The PRIMARY tab is the agent: closing it retires the agent entirely
    // (aborts the run, removes it from the agent list, tears down its browser
    // view). Tabs with no agent behind them — artifact previews, agent-owned
    // browse sub-tabs, manual new-tab pages, and the pinned Main agent
    // (closeAgent refuses to delete it) — just close the browser surface.
    const surfaceOnly = isAgentArtifactTabId(id) || agentTabIds.isSubTabId(id);
    let retired = null;
    if (!surfaceOnly) {
      try {
        retired = runtime().closeAgent?.(id);
      } catch (_) {}
    }
    if (!retired?.ok) {
      destroyAgentBrowserWindow(id);
      if (!surfaceOnly) {
        try {
          runtime().clearBrowserSurface?.(id);
        } catch (_) {}
      }
    }
    commitAgentBrowserHistory(historySnap);
    pushAgentStageState();
    return { ok: true };
  });
  // "+" on the stage tab strip — new agent chat + empty browser tab.
  ipcMain.handle("lykn:agent-stage-new-tab", async () => {
    if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) {
      return { ok: false, error: `max_tabs_${MAX_AGENT_BROWSER_TABS}` };
    }
    const rt = runtime();
    if (!rt.isAgentModeOn?.()) {
      rt.setAgentMode?.(true);
      // The Studio has its own agent rail beside the docked browser — only
      // pop the floating glass-chat sidebar when running standalone.
      if (!studioStageEmbedded) {
        agentSidebarOpen = true;
        try {
          showAgentSidebarWindow();
        } catch (_) {}
      }
    }
    const res = rt.createAgent({ title: "New agent" });
    if (!res?.ok || !res.agentId) return res || { ok: false, error: "create_failed" };
    showAgentBrowserWindow(res.agentId, {
      focus: true,
      label: res.agent?.title || "New agent",
    });
    requestOmniboxFocusForTab(res.agentId);
    return res;
  });
  ipcMain.handle("lykn:agent-stage-toggle-incognito", async () => {
    try {
      return await toggleAgentIncognito(agentStageActiveId);
    } catch (e) {
      return { ok: false, error: e?.message || "toggle_failed" };
    }
  });
  // Studio browser history — closed tabs/agents shown under the rail's
  // Agents section. Open = reopen the page in a fresh agent tab.
  ipcMain.handle("lykn:agent-browser-history-list", async () => ({
    ok: true,
    items: readAgentBrowserHistory(),
  }));
  ipcMain.handle("lykn:agent-browser-history-remove", async (_e, { entryId } = {}) => {
    const items = readAgentBrowserHistory();
    const idx = items.findIndex((i) => i.id === entryId);
    if (idx >= 0) {
      items.splice(idx, 1);
      persistAgentBrowserHistory();
      pushAgentBrowserHistory();
    }
    return { ok: true };
  });
  ipcMain.handle("lykn:agent-browser-history-open", async (_e, { entryId } = {}) => {
    const entry = readAgentBrowserHistory().find((i) => i.id === entryId);
    if (!entry) return { ok: false, error: "not_found" };
    if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) {
      return { ok: false, error: `max_tabs_${MAX_AGENT_BROWSER_TABS}` };
    }
    const rt = runtime();
    if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    // Restore the saved conversation with the agent so the rail shows the full
    // chat, and reopen its page in the same tab.
    const res = rt.createAgent({
      title: entry.title || "Agent",
      history: Array.isArray(entry.history) ? entry.history : [],
      activate: true,
    });
    if (!res?.ok || !res.agentId) return res || { ok: false, error: "create_failed" };
    showAgentBrowserWindow(res.agentId, {
      focus: true,
      label: entry.title || "Agent",
    });
    if (entry.url) {
      try {
        const wc = getAgentBrowserWebContents(res.agentId);
        if (wc) ownedBrowserAct.navigate(wc, entry.url).catch(() => {});
      } catch (_) {}
    }
    // Switch so the rail loads the restored thread (switchPayload carries it).
    try {
      rt.switchAgent(res.agentId);
    } catch (_) {}
    pushAgentStageState();
    return { ok: true, agentId: res.agentId };
  });
  // ── Chrome / Chromium sync (Polar-style) ──────────────────────────────────
  // Detect installed browsers + their profiles. No Keychain/Automation prompt
  // here — this only reads plaintext profile metadata so the UI can offer it.
  ipcMain.handle("lykn:chrome-sync-status", async () => {
    if (!chromeSync.IS_MAC) return { ok: true, supported: false, browsers: [] };
    try {
      const browsers = chromeSync.detectBrowsers().map((b) => ({
        id: b.id,
        name: b.name,
        profiles: chromeSync.listProfiles(b).map((p) => ({ dir: p.dir, name: p.name })),
      }));
      return { ok: true, supported: true, browsers };
    } catch (e) {
      return { ok: false, supported: true, browsers: [], error: e?.message || "status_failed" };
    }
  });
  // Import logins (cookies) and/or open tabs from a chosen browser profile.
  // First run triggers the Keychain prompt (cookies) and Automation prompt
  // (tabs) — both are the user's explicit consent.
  ipcMain.handle("lykn:chrome-sync-run", async (_e, opts = {}) => {
    if (!chromeSync.IS_MAC) return { ok: false, error: "unsupported_platform" };
    const browserId = String(opts.browserId || "chrome");
    const wantCookies = opts.importCookies !== false;
    const wantTabs = opts.importTabs !== false;
    const wantHistory = opts.importHistory !== false;
    const browser = chromeSync.detectBrowsers().find((b) => b.id === browserId);
    if (!browser) return { ok: false, error: "browser_not_found" };
    const profiles = chromeSync.listProfiles(browser);
    const profile =
      profiles.find((p) => p.dir === opts.profileDir) || profiles[0] || null;
    if (!profile) return { ok: false, error: "no_profile" };

    const result = {
      ok: true,
      browser: browser.name,
      profile: profile.name,
      cookies: { imported: 0, failed: 0 },
      tabs: { opened: 0, found: 0 },
      habits: { learned: false },
      warnings: [],
    };

    if (wantCookies) {
      const read = await chromeSync.readProfileCookies(browser, profile);
      if (!read.ok) {
        result.warnings.push(read.error || "cookie_read_failed");
        // A declined Keychain prompt means the user declined the sync. Do not
        // continue with tabs/history — opening the agent browser after "Deny"
        // is both surprising and violates the all-or-nothing welcome flow.
        return result;
      } else {
        try {
          const ses = session.fromPartition(AGENT_BROWSER_SHARED_PARTITION);
          // Families with partial decrypt failures are skipped wholesale —
          // importing half of Google's auth cookie set logs the user out.
          const { imported, failed, skipped } = await chromeSync.importCookiesToSession(
            ses,
            read.cookies,
            { skipDomains: read.corruptDomains || [] },
          );
          result.cookies = { imported, failed, skipped: skipped || 0 };
          if ((read.corruptDomains || []).length) {
            result.warnings.push(
              `cookies_kept_existing_login: ${read.corruptDomains.join(", ")}`,
            );
          }
        } catch (e) {
          result.warnings.push(`cookie_import_failed: ${e?.message || e}`);
        }
      }
    }

    if (wantTabs) {
      const open = await chromeSync.getOpenTabs(browser);
      if (!open.ok) {
        result.warnings.push(open.error || "tab_read_failed");
      } else {
        result.tabs.found = open.tabs.length;
        // Build the set of URLs already open, normalized, from LIVE webContents
        // (fresh tabs haven't written meta.url yet) plus stored meta. This makes
        // re-syncing idempotent and collapses trailing-slash / #hash variants.
        const seen = new Set();
        for (const [id, view] of agentBrowserViews) {
          const meta = agentBrowserMeta.get(id) || {};
          let u = meta.url || "";
          try {
            if (view?.webContents && !view.webContents.isDestroyed()) {
              u = view.webContents.getURL() || u;
            }
          } catch (_) {}
          const n = normalizeSyncUrl(u);
          if (n) seen.add(n);
        }
        // De-dupe the incoming Chrome list against itself + what's open, then
        // open the rest (each as its own agent), respecting the tab cap.
        let first = true;
        for (const url of open.tabs) {
          const n = normalizeSyncUrl(url);
          if (!n || seen.has(n)) continue;
          seen.add(n);
          if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) {
            result.warnings.push(`tab_cap_${MAX_AGENT_BROWSER_TABS}`);
            break;
          }
          const id = openAgentBrowserTabWithUrl(url, { focus: first });
          if (id) {
            result.tabs.opened += 1;
            first = false;
          }
        }
        // Active-tab id changed → relayout the view bounds, then refresh strip.
        layoutAgentStageViews();
        pushAgentStageState();
      }
    }

    if (wantHistory) {
      const hist = await chromeSync.readHistory(browser, profile, { limit: 60 });
      if (!hist.ok) {
        result.warnings.push(hist.error || "history_read_failed");
      } else {
        // Store privately as agent context — never shown to the user.
        result.habits.learned = setBrowsingContextFromHistory(hist, browser.name);
        if (!result.habits.learned) result.warnings.push("history_empty");
      }
    }

    return result;
  });
  ipcMain.handle("lykn:agent-recents-list", async () => {
    const items = agentRecentVisits.readRecents(app.getPath("userData")).items || [];
    return { ok: true, items };
  });
  ipcMain.handle("lykn:agent-recents-remove", async (_e, { id, host, url } = {}) => {
    const result = agentRecentVisits.removeRecent(app.getPath("userData"), {
      id,
      host,
      url,
    });
    pushAgentStageState();
    return { ok: !!result?.ok, items: result.items || [] };
  });
  // Local Mode — Vault switch grants file/terminal access to LYKN agents.
  // Device-level setting; tools only ever execute here in main.
  localSystem.configure(app.getPath("userData"));
  const broadcastToAllWindows = (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      } catch (_) {}
    }
  };
  // The Files browser watches whichever folder it's showing, so a change made
  // in Finder relists it here without the user having to hit refresh.
  macFiles.configure({
    userDataPath: app.getPath("userData"),
    onChange: (dirPath) => broadcastToAllWindows("lykn:files-changed", { path: dirPath }),
  });
  // File access for installed apps rides on Local Mode rather than inventing a
  // second allowlist: the user already chose which folders LYKN may touch, and
  // an app should never be able to reach further than LYKN itself can.
  require("./appBridge.cjs").configure({
    onFilesList: async (dirPath) => {
      const { enabled } = localSystem.readLocalMode(app.getPath("userData"));
      if (!enabled) throw new Error("Local mode is off — enable it in the Vault first.");
      const res = await localSystem.run(
        "local_list_dir",
        { path: dirPath || "~" },
        { userDataPath: app.getPath("userData") },
      );
      if (!res?.ok) throw new Error(res?.error || "could not list that folder");
      return { path: res.path, entries: res.entries };
    },
    onFilesRead: async (filePath) => {
      const { enabled } = localSystem.readLocalMode(app.getPath("userData"));
      if (!enabled) throw new Error("Local mode is off — enable it in the Vault first.");
      const res = await localSystem.run(
        "local_read_file",
        { path: filePath },
        { userDataPath: app.getPath("userData") },
      );
      if (!res?.ok) throw new Error(res?.error || "could not read that file");
      return { path: res.path, content: res.content, truncated: res.truncated };
    },
  });

  ipcMain.handle("lykn:local-mode-get", () => {
    const { enabled, syncAll, syncedFolders } = localSystem.readLocalMode(app.getPath("userData"));
    return { ok: true, enabled, syncAll, syncedFolders };
  });
  ipcMain.handle("lykn:local-mode-set", (_e, { enabled } = {}) => {
    const next = localSystem.writeLocalMode(app.getPath("userData"), !!enabled);
    // Every window (main app, Studio, overlay) should see the flip immediately.
    broadcastToAllWindows("lykn:local-mode-changed", { enabled: next.enabled });
    return { ok: true, enabled: next.enabled };
  });
  ipcMain.handle("lykn:local-tool-run", async (_e, { name, args, approved } = {}) => {
    const { enabled } = localSystem.readLocalMode(app.getPath("userData"));
    if (!enabled) {
      return { ok: false, error: "Local mode is off — enable it in the Vault first." };
    }
    return localSystem.run(String(name || ""), args || {}, {
      approved: approved === true,
      userDataPath: app.getPath("userData"),
    });
  });

  // Serve files from this Mac to the Files browser. Independent of the local
  // store below — it gates on Local Mode and the sync allowlist instead — so
  // it binds out here rather than inside that try.
  require("./macFileProtocol.cjs").bind(session.defaultSession);

  // --- Local store: the on-device home for vault, chat, and artifacts -------
  // Unlike Local Mode this is not gated on a user switch — it is the app's own
  // storage, not access to the user's filesystem. The renderer loads a remote
  // origin, so IPC is the only way it can reach the database.
  try {
    const opened = localStore.configure(app.getPath("userData"));
    console.log(`[LYKN] local store ready (schema v${opened.version ?? "?"})`);

    // Serve locally stored media to the window. Bound only once the store is
    // open, because the handler resolves paths through it.
    require("./localStore/blobProtocol.cjs").bind(session.defaultSession);

    // Installed apps. Each app runs in its own session partition, so the
    // protocol is bound there on open rather than only on the default session.
    require("./appProtocol.cjs").bind(session.defaultSession);
    require("./appBridge.cjs").bind();

    // Catch the retrieval index up on anything saved while the model was
    // unavailable, or left over from a previous model version. Deferred and
    // conditional: loading the model costs ~400 MB, so a launch with nothing
    // outstanding must not pay for it. Progress is polled via `index.status`.
    setTimeout(() => {
      try {
        const pending = localStore.indexer.pendingCount();
        const total = pending.items + pending.threads;
        if (!total) return;
        console.log(`[LYKN] embedding backfill: ${total} source(s) outstanding`);
        localStore.indexer.backfill().catch((err) => {
          console.error("[LYKN] backfill failed to start:", err?.message);
        });
      } catch (err) {
        console.error("[LYKN] backfill check failed:", err?.message);
      }
    }, 30_000).unref?.();
  } catch (err) {
    // A store that will not open must not take the whole app down with it —
    // everything still reads from Supabase at this stage.
    console.error("[LYKN] local store failed to open:", err?.message);
  }

  ipcMain.handle("lykn:store-run", async (_e, { op, args } = {}) =>
    localStore.run(String(op || ""), args || {}),
  );

  // --- Installed apps ------------------------------------------------------
  // Managing apps (install, open, uninstall) is the main renderer's job. What
  // an app can do to the user's data is a different surface entirely and lives
  // on lykn:app-bridge, which only frames on a lykn-app:// origin can reach.
  const appHost = require("./appHost.cjs");

  ipcMain.handle("lykn:app-install", async (_e, payload = {}) => {
    const result = await appHost.installApp(payload || {});
    if (result.ok) {
      broadcastToAllWindows("lykn:apps-changed", { id: result.app.id, action: "install" });
    }
    return result;
  });

  ipcMain.handle("lykn:app-open", (_e, { id } = {}) => appHost.openApp(id));

  ipcMain.handle("lykn:app-uninstall", (_e, { id } = {}) => {
    const result = appHost.uninstallApp(id);
    broadcastToAllWindows("lykn:apps-changed", { id: String(id || ""), action: "uninstall" });
    return result;
  });

  ipcMain.handle("lykn:app-verify", async (_e, { id } = {}) => appHost.rebuildAndVerify(id));

  // Picking an icon is a user action, so it sticks: `icon_source` keeps the
  // next rebuild from handing the manifest's icon back.
  ipcMain.handle("lykn:app-set-icon", (_e, { id, icon } = {}) => {
    const record = localStore.apps.getApp(id);
    if (!record) return { ok: false, error: "app not found" };
    const app = localStore.apps.setAppIcon(id, icon);
    broadcastToAllWindows("lykn:apps-changed", { id: String(id), action: "update" });
    return { ok: true, app };
  });

  ipcMain.handle("lykn:app-list", () => ({ ok: true, apps: localStore.apps.listApps() }));

  ipcMain.handle("lykn:app-permissions", (_e, { id } = {}) => {
    const record = localStore.apps.getApp(id);
    if (!record) return { ok: false, error: "app not found" };
    return {
      ok: true,
      capabilities: record.capabilities || [],
      grants: record.grants || {},
      catalog: require("./appBridge.cjs").CAPABILITIES,
    };
  });

  // Revoking is a user action from settings; the app cannot do it to itself.
  ipcMain.handle("lykn:app-set-permission", (_e, { id, capability, allowed } = {}) => {
    const record = localStore.apps.getApp(id);
    if (!record) return { ok: false, error: "app not found" };
    const grants = { ...(record.grants || {}), [String(capability)]: allowed === true };
    localStore.apps.updateApp(id, { grants });
    return { ok: true, grants };
  });

  // --- Sync with Mac: synced-folders allowlist -----------------------------
  const macSyncState = (cfg) => ({
    ok: true,
    enabled: cfg.enabled,
    syncAll: cfg.syncAll,
    syncedFolders: cfg.syncedFolders,
    excludedFolders: cfg.excludedFolders,
  });
  ipcMain.handle("lykn:mac-sync-get", () =>
    macSyncState(localSystem.readLocalMode(app.getPath("userData")))
  );
  ipcMain.handle("lykn:mac-sync-set", (_e, { syncAll, syncedFolders } = {}) => {
    const next = localSystem.writeMacSync(app.getPath("userData"), { syncAll, syncedFolders });
    broadcastToAllWindows("lykn:mac-sync-changed", macSyncState(next));
    return macSyncState(next);
  });
  // One folder's switch, from its page in the Vault. Main works out what that
  // means for the allowlist so the renderer never has to reason about it.
  ipcMain.handle("lykn:mac-sync-folder", (_e, { folder, synced } = {}) => {
    const next = localSystem.writeFolderSync(app.getPath("userData"), { folder, synced });
    broadcastToAllWindows("lykn:mac-sync-changed", macSyncState(next));
    return macSyncState(next);
  });
  ipcMain.handle("lykn:mac-sync-pick-folder", async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(parent, {
      title: "Choose folders to sync with LYKN",
      buttonLabel: "Sync",
      properties: ["openDirectory", "multiSelections", "createDirectory"],
      defaultPath: app.getPath("home"),
    });
    if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, folders: res.filePaths };
  });

  // --- Mac Files browser (renderer-facing, gated on Local Mode + allowlist) -
  ipcMain.handle("lykn:mac-fs-list", async (_e, { path: dirPath } = {}) => {
    const cfg = localSystem.readLocalMode(app.getPath("userData"));
    if (!cfg.enabled) return { ok: false, error: "local_mode_off" };
    return localSystem.run("local_list_dir", { path: dirPath }, {
      userDataPath: app.getPath("userData"),
    });
  });
  ipcMain.handle("lykn:mac-fs-open", async (_e, { path: targetPath, reveal } = {}) => {
    const cfg = localSystem.readLocalMode(app.getPath("userData"));
    if (!cfg.enabled) return { ok: false, error: "local_mode_off" };
    const abs = localSystem.resolveUserPath(targetPath);
    if (!abs || !localSystem.isAllowedPath(abs, cfg)) {
      return { ok: false, error: "Path is not inside a synced folder" };
    }
    try {
      if (reveal) {
        shell.showItemInFolder(abs);
        return { ok: true };
      }
      const err = await shell.openPath(abs);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || "open failed" };
    }
  });
  // --- Files browser (the Vault's Locations sidebar) ------------------------
  // Richer than mac-fs-list above: sorting, hidden files, sidebar roots, the
  // editing operations, and a watcher so the view tracks the real disk. Each
  // op re-checks Local Mode and the allowlist inside macFiles itself.
  ipcMain.handle("lykn:files-list", (_e, args = {}) => macFiles.list(args));
  ipcMain.handle("lykn:files-thumbnail", (_e, args = {}) => macFiles.thumbnail(args));
  ipcMain.handle("lykn:files-roots", () => macFiles.roots());
  ipcMain.handle("lykn:files-mkdir", (_e, args = {}) => macFiles.mkdir(args));
  ipcMain.handle("lykn:files-rename", (_e, args = {}) => macFiles.rename(args));
  ipcMain.handle("lykn:files-move", (_e, args = {}) => macFiles.move(args));
  ipcMain.handle("lykn:files-copy", (_e, args = {}) => macFiles.copy(args));
  ipcMain.handle("lykn:files-duplicate", (_e, args = {}) => macFiles.duplicate(args));
  ipcMain.handle("lykn:files-trash", (_e, args = {}) => macFiles.trash(args));
  ipcMain.handle("lykn:files-watch", (_e, args = {}) => macFiles.watch(args));
  ipcMain.handle("lykn:files-unwatch", (_e, args = {}) => macFiles.unwatch(args));

  /**
   * Write bytes the renderer already holds into ~/Downloads.
   *
   * Chromium's own download plumbing is what an `<a download>` reaches, and
   * where it puts the file depends on the user's browser settings — which is
   * the wrong answer inside a desktop app that promises "it's in Downloads".
   * The bytes come over as a transferable buffer rather than a URL because
   * they're often a `lykn-blob://` or a data URL that only the renderer can
   * read.
   */
  ipcMain.handle("lykn:save-to-downloads", async (_e, { name, bytes } = {}) => {
    try {
      const buf = Buffer.from(bytes || []);
      if (!buf.length) return { ok: false, error: "empty" };
      const target = uniqueDownloadPath(name);
      await fs.writeFile(target, buf);
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err?.message || "write failed" };
    }
  });

  /**
   * The same bytes, but somewhere the user points at. The Mac's own save sheet
   * is the folder picker — it names the file and chooses the folder in one
   * step, and it is the panel people already know for "put this over there".
   */
  ipcMain.handle("lykn:save-file-as", async (e, { name, bytes } = {}) => {
    try {
      const buf = Buffer.from(bytes || []);
      if (!buf.length) return { ok: false, error: "empty" };
      const parent =
        BrowserWindow.fromWebContents(e.sender) ||
        BrowserWindow.getFocusedWindow() ||
        undefined;
      const res = await dialog.showSaveDialog(parent, {
        defaultPath: path.join(app.getPath("downloads"), String(name || "file")),
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      await fs.writeFile(res.filePath, buf);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err?.message || "write failed" };
    }
  });

  // The real, localized locations of the user's folders — Settings needs the
  // absolute Desktop path to mirror it and to add it to the sync allowlist.
  ipcMain.handle("lykn:mac-fs-home", () => {
    try {
      return {
        ok: true,
        home: app.getPath("home"),
        desktop: app.getPath("desktop"),
        documents: app.getPath("documents"),
        downloads: app.getPath("downloads"),
      };
    } catch (err) {
      return { ok: false, error: err?.message || "path lookup failed" };
    }
  });

  // --- Mac app dock: installed apps, launch, running-state ------------------
  ipcMain.handle("lykn:mac-apps-list", async () => {
    try {
      const apps = await appDock.listAppsWithIcons();
      return { ok: true, apps };
    } catch (err) {
      return { ok: false, error: err?.message || "app scan failed", apps: [] };
    }
  });
  ipcMain.handle("lykn:mac-app-launch", (_e, { path: bundlePath } = {}) =>
    appDock.launchApp(bundlePath)
  );
  ipcMain.handle("lykn:mac-app-quit", (_e, { path: bundlePath } = {}) =>
    appDock.quitApp(bundlePath)
  );
  ipcMain.handle("lykn:mac-apps-running", () => appDock.getRunningApps());
  // Studio dock subscribes while visible; polling stops when nobody listens.
  const runningAppWatchers = new Map(); // webContents.id -> unsubscribe
  ipcMain.on("lykn:mac-apps-watch", (e, { on } = {}) => {
    const wc = e.sender;
    const existing = runningAppWatchers.get(wc.id);
    if (!on) {
      if (existing) {
        existing();
        runningAppWatchers.delete(wc.id);
      }
      return;
    }
    if (existing) return;
    const unsubscribe = appDock.subscribeRunningApps((snapshot) => {
      try {
        if (!wc.isDestroyed()) {
          wc.send("lykn:mac-apps-running-changed", snapshot);
        }
      } catch (_) {}
    });
    runningAppWatchers.set(wc.id, unsubscribe);
    wc.once("destroyed", () => {
      const un = runningAppWatchers.get(wc.id);
      if (un) {
        un();
        runningAppWatchers.delete(wc.id);
      }
    });
  });
  ipcMain.on("lykn:agent-stage-chrome-height", (_e, { height } = {}) => {
    const h = Math.round(Number(height) || 0);
    if (h > 40 && h !== agentStageChromeHeight) {
      agentStageChromeHeight = h;
      layoutAgentStageViews();
    }
  });
  // Saved-links dropdown open/closed — overlay the chrome above the page so
  // the menu renders in front of the browser instead of behind it.
  ipcMain.on("lykn:agent-stage-menu-overlay", (_e, { open } = {}) => {
    const next = !!open;
    if (next === agentStageMenuOverlay) return;
    agentStageMenuOverlay = next;
    try {
      // Transparent while overlaying so the page shows through around the
      // dropdown; opaque again once closed (normal seam-filling behavior).
      studioStageChromeView?.setBackgroundColor(next ? "#00000000" : "#ececeb");
    } catch (_) {}
    layoutAgentStageViews();
  });
  // Docked browser chrome → the Studio's floating Browser window. Its tab
  // strip carries the traffic lights and the title-bar drag, and it's a native
  // view, so the clicks land out here rather than in the Studio's DOM.
  ipcMain.on("lykn:studio-window-control", (_e, payload = {}) => {
    try {
      if (studioWindow && !studioWindow.isDestroyed()) {
        studioWindow.webContents.send("lykn:studio-window-control", payload || {});
      }
    } catch (_) {}
  });
  ipcMain.on("lykn:agent-stage-set", (_e, { open } = {}) => {
    if (open) {
      raiseAgentBrowserHost({ focus: true });
      pushAgentStageState();
    } else {
      hideAllAgentBrowserWindows();
    }
  });
  // Use LYKN pill / Studio close — show or hide the agent chat side panel.
  const setAgentChatOpen = (open, agentId = "") => {
    const next = !!open;
    if (next === agentChatOpen) {
      if (agentId) {
        emitAgentToUi("lykn:agent-chat-visibility", { open: next, agentId });
      }
      pushAgentStageState();
      return next;
    }
    agentChatOpen = next;
    emitAgentToUi("lykn:agent-chat-visibility", {
      open: next,
      ...(agentId ? { agentId } : {}),
    });
    pushAgentStageState();
    return next;
  };
  openBrowserTaskChat = (agentId) => setAgentChatOpen(true, agentId);
  ipcMain.handle("lykn:agent-chat-set", (_e, { open, toggle, agentId } = {}) => {
    if (toggle) return setAgentChatOpen(!agentChatOpen, agentId);
    return setAgentChatOpen(!!open, agentId);
  });
  ipcMain.handle("lykn:agent-chat-get", () => ({
    open: !!agentChatOpen,
    agentId: agentStageActiveId || runtime().getActiveId?.() || "",
  }));
  // Studio "Browser" tab — dock/undock the agent browser inside the Studio
  // window at the panel bounds the Studio renderer measured.
  ipcMain.on("lykn:studio-browser-set", (_e, payload = {}) => {
    try {
      setStudioBrowserEmbed(payload);
    } catch (err) {
      console.warn("[studio-browser] embed failed:", err?.message || err);
    }
  });
  // Sent as the Browser window starts opening, before it can report bounds —
  // load the chrome and the first tab while the frame animates.
  ipcMain.on("lykn:studio-browser-warm", () => {
    void warmStudioBrowser().catch((err) => {
      console.warn("[studio-browser] warm failed:", err?.message || err);
    });
  });
  // Red traffic light on the Studio Browser window — tear the session down.
  // Yellow minimize only parks the views via `studio-browser-set { open:false }`.
  ipcMain.handle("lykn:studio-browser-close", async () => {
    try {
      return closeStudioBrowserSession();
    } catch (err) {
      console.warn("[studio-browser] close failed:", err?.message || err);
      return { ok: false, error: err?.message || "close_failed" };
    }
  });
  // Studio artifact "Open" → open the URL in the Studio's own browser
  // (never the OS browser) as a fresh AGENT tab, so a new agent lands in
  // the rail and the AI can act on the page. The renderer switches the
  // Studio to its Browser tab right after this call, which docks the
  // views — so when the browser isn't docked yet the tab is selected
  // quietly instead of flashing the standalone stage window.
  ipcMain.handle("lykn:studio-open-url", async (_e, { url, title } = {}) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: "bad_url" };
    if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) {
      return { ok: false, error: `max_tabs_${MAX_AGENT_BROWSER_TABS}` };
    }
    const label = String(title || "").trim().slice(0, 48);
    const docked = studioStageEmbedActive();
    const studioOpen = !!(studioWindow && !studioWindow.isDestroyed());
    // Quiet create when Studio is open but Browser isn't docked yet — the
    // renderer will switch tabs and dock, and a loud create would flash the
    // standalone stage + race the welcome page over the real navigation.
    const quiet = studioOpen && !docked;
    const id =
      openAgentBrowserTabWithUrl(target, {
        title: label,
        focus: true,
        show: !quiet,
      }) || openStudioBrowserTabWithUrl(target, { focus: docked });
    if (!id) return { ok: false, error: "open_failed" };
    if (label) agentBrowserLabels.set(id, label);
    notifyStudioShowBrowser();
    if (docked) {
      showAgentBrowserWindow(id, { focus: true, label: label || undefined });
    } else {
      agentStageActiveId = id;
      layoutAgentStageViews();
      pushAgentStageState();
    }
    return { ok: true, id };
  });

  // Chat artifact open — same as studio-open-url but prefers inlined HTML when
  // provided (srcDoc) so React/deck artifacts paint even if the signed preview
  // URL is slow/expired, and marks the tab as an artifact so docking can't
  // wipe it back to the welcome page.
  ipcMain.handle("lykn:studio-open-artifact", async (_e, payload = {}) => {
    const url = String(payload.url || "").trim();
    const html = typeof payload.html === "string" ? payload.html : "";
    const label = String(payload.title || "Artifact").trim().slice(0, 48) || "Artifact";
    const kind = String(payload.kind || "artifact").trim() || "artifact";
    if (!url && !html.trim()) return { ok: false, error: "empty" };

    const docked = studioStageEmbedActive();
    const studioOpen = !!(studioWindow && !studioWindow.isDestroyed());
    const quiet = studioOpen && !docked;

    // Prefer a real agent tab (AI can act on the page). Fall back to a bare
    // stage artifact tab only if agent creation fails.
    let ownerId = null;
    try {
      const rt = initAgentRuntime();
      if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
      const res = rt.createAgent({ title: label, activate: true, silent: quiet || !docked });
      if (res?.ok && res.agentId) ownerId = res.agentId;
    } catch (_) {}

    if (ownerId) {
      agentBrowserLabels.set(ownerId, label);
      agentBrowserMeta.set(ownerId, {
        kind: "artifact",
        artifactKind: kind,
        ownerAgentId: ownerId,
        url: url || "lykn://artifact",
        pageTitle: label,
      });
      ensureAgentBrowserWindow(ownerId, {
        show: docked,
        focus: true,
        label,
      });
      const painted = await paintArtifactIntoAgentTab(ownerId, {
        url,
        html,
        title: label,
        kind,
      });
      notifyStudioShowBrowser();
      if (docked) {
        showAgentBrowserWindow(ownerId, { focus: true, label });
      } else {
        agentStageActiveId = ownerId;
        layoutAgentStageViews();
        pushAgentStageState();
      }
      return { ok: !!painted?.ok, id: ownerId, ...(painted || {}) };
    }

    // Last resort: classic deliverable subtab (no paired agent).
    const opened = openAgentStageArtifact({
      url: url || undefined,
      html: html || undefined,
      title: label,
      kind,
      show: docked,
      focus: true,
      // The user clicked "Open" — fronting is the whole point here.
      force: true,
    });
    notifyStudioShowBrowser();
    return opened;
  });
  // Does this prompt belong to the browser agent rather than the chat model?
  //
  // The chat surface cannot answer this itself. Knowing that "open up Mailchimp
  // and build the campaign" is browser work — and that "what is Mailchimp good
  // for?" is not — takes the whole venue table and the skill classifier, which
  // live here in main. Without asking, the chat can only do what a chat can do:
  // it writes the campaign into the conversation and tells the user to paste it
  // into Mailchimp themselves, which is the exact thing they asked not to do.
  ipcMain.handle("lykn:agent-route-check", async (_e, { text } = {}) => {
    try {
      return decideChatRoute(text);
    } catch (_) {
      return { route: "chat" };
    }
  });

  // Studio agent rail chat bar → Main orchestrator. Enables Agent Mode
  // quietly (no floating sidebar window — the rail is already showing).
  ipcMain.handle("lykn:studio-bar-send", async (_e, { text, attachments, agentId, fromSuggestion } = {}) => {
    const rt = runtime();
    try {
      if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    } catch (_) {}
    // Route to the agent the rail currently has selected, falling back to the
    // runtime's active agent. With no target at all, the runtime creates a
    // fresh agent (and its paired tab) for the prompt.
    const target = String(agentId || "").trim() || rt.getActiveId?.() || "";
    return rt.send(target, { text, attachments, fromSuggestion: !!fromSuggestion });
  });

  // Empty browser-tab composer → the browser agent. The preload exists on all
  // agent pages, so verify this is our bundled welcome document and identify
  // its paired agent from the sender before accepting the prompt.
  ipcMain.handle("lykn:agent-browser-welcome-send", async (event, { text, requestId } = {}) => {
    const goal = String(text || "").trim();
    if (!goal) return { ok: false, error: "empty_prompt" };
    const sender = event?.sender;
    const senderUrl = String(sender?.getURL?.() || "");
    if (!/agent-browser-welcome\.html(?:[?#]|$)/i.test(senderUrl)) {
      return { ok: false, error: "invalid_sender" };
    }
    let agentId = "";
    for (const [id, view] of agentBrowserViews) {
      if (view?.webContents === sender) {
        agentId = id;
        break;
      }
    }
    if (!agentId) return { ok: false, error: "unknown_browser_tab" };

    const rt = runtime();
    try {
      if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    } catch (_) {}
    // Use the runtime's own routing logic. Conversational prompts stay in the
    // new-tab thread; browser work opens the established task sidebar.
    // The new-tab composer is a normal chat surface. Keep every submitted
    // turn here and explicitly close any sidebar left open by a prior task.
    // Task handoff remains available from the existing browser chrome while
    // its dedicated inline handoff UI is built separately.
    const skill = "general";
    const task = false;
    setAgentChatOpen(false);
    browserWelcomeChatStreams.set(agentId, {
      sender,
      requestId: String(requestId || ""),
    });
    const run = rt.send(agentId, {
      text: goal,
      attachments: [],
      fromSuggestion: false,
    });
    if (task) {
      // The existing sidebar receives live agent progress for task work.
      void run.catch(() => {});
      return { ok: true, task: true, requestedSkill: skill };
    }
    // Chat remains on the new-tab surface. Return routing immediately, then
    // deliver the final conversational answer to its originating page.
    void run
      .then((result) => {
        browserWelcomeChatStreams.delete(agentId);
        if (!sender.isDestroyed?.()) {
          sender.send("lykn:agent-browser-welcome-result", {
            requestId: String(requestId || ""),
            ok: !!result?.ok,
            text: String(result?.text || ""),
          });
        }
      })
      .catch((error) => {
        browserWelcomeChatStreams.delete(agentId);
        if (!sender.isDestroyed?.()) {
          sender.send("lykn:agent-browser-welcome-result", {
            requestId: String(requestId || ""),
            ok: false,
            error: error?.message || "send_failed",
          });
        }
      });
    return { ok: true, task: false, requestedSkill: skill };
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

  // Studio chat-bar Finder: the ordinary macOS Open panel, parented to the
  // window that asked so it isn't attached to the Glass overlay (which is
  // often hidden, so the picker would appear to do nothing). Returns the
  // chosen files as bytes the renderer can wrap in File objects.
  ipcMain.handle("lykn:pick-open-files", async (e) => {
    try {
      const parent =
        BrowserWindow.fromWebContents(e.sender) ||
        BrowserWindow.getFocusedWindow() ||
        undefined;
      const res = await dialog.showOpenDialog(parent, {
        title: "Choose files",
        buttonLabel: "Add",
        properties: ["openFile", "multiSelections"],
      });
      if (res.canceled || !Array.isArray(res.filePaths) || !res.filePaths.length) {
        return [];
      }
      const out = [];
      for (const p of res.filePaths) {
        try {
          const [buf, st] = await Promise.all([fs.readFile(p), fs.stat(p)]);
          if (st.isDirectory()) continue;
          const ext = path.extname(p).toLowerCase();
          out.push({
            name: path.basename(p),
            type: IMAGE_MIME_BY_EXT[ext] || "",
            lastModified: Math.round(st.mtimeMs) || Date.now(),
            data: buf,
          });
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

  ipcMain.handle("lykn:list-projects", async () => {
    const token = await getAuthToken().catch(() => null);
    if (!token) return { projects: [], error: "not_signed_in" };
    try {
      const res = await fetch(`${API_BASE}/api/v1/synthesis/projects?status=active&limit=40`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return { projects: [], error: "not_signed_in" };
      }
      if (!res.ok) {
        return { projects: [], error: `Could not load projects (${res.status}).` };
      }
      const data = await res.json().catch(() => ({}));
      const projects = Array.isArray(data?.projects) ? data.projects : [];
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name || "Untitled project",
          description: p.description || "",
          last_active_at: p.last_active_at || null,
          is_focus: !!p.is_focus,
        })),
        error: null,
      };
    } catch (err) {
      return { projects: [], error: err?.message || "Could not load projects." };
    }
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
          return await withPermissionPrompt("microphone", () =>
            systemPreferences.askForMediaAccess("microphone"),
          );
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

  // Open a URL from overlay / Studio chat links. Always opens a fresh agent
  // tab in the LYKN browser (never the OS browser for http(s)).
  // Never navigate the overlay window itself.
  ipcMain.on("lykn:open-url", (_e, payload) => {
    // Accept legacy string payloads and { url, title } from newer callers.
    const url =
      typeof payload === "string"
        ? payload
        : String(payload?.url || "");
    const title =
      typeof payload === "object" && payload
        ? String(payload.title || "")
        : "";
    void openUrlPreferAgentBrowser(url, { title });
  });

  // macOS sharing-services picker (AirDrop, Messages, Mail, Notes, Photos…).
  // Electron only exposes it through the native `shareMenu` role, and the
  // services are attached by AppKit when the menu holding that item is built —
  // the item's JS `submenu` is always empty, so it must never be popped on its
  // own (that shows an empty, invisible menu, i.e. "the button does nothing").
  ipcMain.handle("lykn:native-share", async (event, payload = {}) => {
    if (!IS_MAC) return { ok: false, error: "unsupported" };
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no_window" };
    const title = String(payload.title || "").trim().slice(0, 500);
    const text = String(payload.text || "").trim().slice(0, 20_000);
    const rawUrl = String(payload.url || "").trim().slice(0, 8_000);
    let url = "";
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") url = parsed.href;
    } catch {
      /* text-only sharing remains available */
    }

    // Sharing the bytes (not a signed link) is what unlocks AirDrop, Add to
    // Photos, and Mail attachments — the services a Mac user expects to see.
    let filePath = "";
    if (url && payload.asFile) {
      filePath = await stageNativeShareFile(url, payload.filename || title);
    }

    const sharingItem = {};
    if (filePath) sharingItem.filePaths = [filePath];
    const texts = [text || title].filter(Boolean);
    if (texts.length) sharingItem.texts = texts;
    // A signed asset URL alongside the file only duplicates the payload, and
    // some services then offer the link instead of the attachment.
    if (url && !filePath) sharingItem.urls = [url];
    if (!sharingItem.filePaths && !sharingItem.texts && !sharingItem.urls) {
      return { ok: false, error: "empty" };
    }

    const bounds = win.getContentBounds();
    const x = Math.max(0, Math.min(Math.round(Number(payload.x) || 0), Math.max(0, bounds.width - 1)));
    const y = Math.max(0, Math.min(Math.round(Number(payload.y) || 0), Math.max(0, bounds.height - 1)));
    const menu = Menu.buildFromTemplate([{ role: "shareMenu", sharingItem }]);
    // positioningItem puts "Share" itself under the cursor, so the services
    // list is one hover away — same feel as Finder's Share menu.
    menu.popup({ window: win, x, y, positioningItem: 0 });
    // `api` lets the renderer tell this handler apart from an older main
    // process still loaded from before a restart — without it, a stale build
    // answers `ok` while showing nothing and the Share button looks dead.
    return { ok: true, api: 2, sharedFile: !!filePath };
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
        await withPermissionPrompt("accessibility", async () => {
          systemPreferences.isTrustedAccessibilityClient(true);
        });
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

      // Never infer done from "no actions" — only trust an explicit done flag.
      // Empty actions after some steps usually means the planner stalled, not finished.
      const done = typeof data.done === "boolean" ? data.done : false;

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

/**
 * Write a shareable diagnostics report next to wherever the user asks for it.
 *
 * Every browser-agent run already writes a detailed JSONL trace under
 * userData/browser-agent-logs/, and until now there was no way to get anything
 * out of it: nothing in the app referenced the folder, and the bug-report form
 * could not attach it. So the most common support question about the agent —
 * "which runtime did this actually use, and where did it stop?" — had no answer
 * that did not involve talking someone through Finder.
 *
 * What gets written is a summary, never a trace. buildDiagnosticsReport reads
 * the traces and emits counts; the traces themselves stay on the machine. That
 * keeps the user's own task text and page content private, and keeps the plans,
 * skills and models out of a file that is, by design, about to be emailed to
 * someone.
 */
async function saveDiagnosticsReport() {
  let report = "";
  try {
    report = buildDiagnosticsReport({
      userDataPath: app.getPath("userData"),
      env: {
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        packaged: app.isPackaged,
      },
    });
  } catch (e) {
    dialog.showErrorBox(
      "Could not build diagnostics",
      String(e?.message || e).slice(0, 500),
    );
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save LYKN Diagnostics",
    defaultPath: path.join(app.getPath("downloads"), `lykn-diagnostics-${stamp}.txt`),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (canceled || !filePath) return;

  try {
    await fs.writeFile(filePath, report, "utf8");
    // Reveal rather than open: the point is to attach it to something, and a
    // revealed file is one drag away from an email.
    shell.showItemInFolder(filePath);
  } catch (e) {
    dialog.showErrorBox("Could not save diagnostics", String(e?.message || e).slice(0, 500));
  }
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
  // TODO(devtools): we want a developer mode here — a `toggleDevTools` role,
  // gated so it is unreachable on a normal install (an env var we set, or an
  // internal-account check), plus a raw trace viewer for browser-agent runs.
  //
  // It is deliberately absent for now rather than half-built. DevTools on any
  // LYKN window exposes the whole product: the agent's prompt corpus and skill
  // files, the IPC surface, the snapshot format the agent builds from a page,
  // and every request to our own API. Shipping that behind nothing but an
  // obscure shortcut hands the architecture to anyone who goes looking. When it
  // is built, the gate is the feature — not the toggle.
  //
  // "Save Diagnostics…" below is the supported path in the meantime: it answers
  // support questions from the same data without exposing any of it.
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
  // Diagnostics is an internal tool and is not part of the shipped product.
  //
  // Even though the report it writes is counts-only, the menu item itself
  // advertises that the agent has more than one runtime, that runs have rounds,
  // recoveries and grounding — the shape of the architecture, handed to anyone
  // who opens the Help menu. So it exists in dev builds, and in a packaged build
  // only when someone deliberately launches with LYKN_DIAGNOSTICS=1, which is
  // how we would walk an internal tester through producing one.
  //
  // If this ever needs to reach real users for support, gate it on the account
  // (the internal-email list the server already keeps) rather than by making it
  // visible to everybody.
  const diagnosticsEnabled = !app.isPackaged || process.env.LYKN_DIAGNOSTICS === "1";
  const helpMenu = {
    role: "help",
    submenu: [
      { label: "Set Up LYKN / Permissions…", click: () => createOnboardingWindow() },
      ...(diagnosticsEnabled
        ? [
            { type: "separator" },
            { label: "Save Diagnostics…", click: () => saveDiagnosticsReport() },
          ]
        : []),
    ],
  };

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const updateMenuItems =
    pendingUpdate && installPendingUpdate
      ? [
          {
            label: `Restart to Update${pendingUpdate.version ? ` (${pendingUpdate.version})` : ""}`,
            click: () => installPendingUpdate(),
          },
          { type: "separator" },
        ]
      : [];

  /** @type {Electron.MenuItemConstructorOptions[]} */
  let template;
  if (IS_MAC) {
    template = [
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          { type: "separator" },
          ...updateMenuItems,
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
          ...updateMenuItems,
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

/* ------------------------------------------------------------------ */
/*  First-launch welcome splash — a floating glass panel playing the    */
/*  Remotion logo reveal (alpha webm) over native vibrancy. Shows once, */
/*  then never again (marker file). LYKN_FORCE_WELCOME=1 replays it.    */
/* ------------------------------------------------------------------ */

function welcomeMarkerPath() {
  return path.join(app.getPath("userData"), "welcome-shown");
}

function hasSeenWelcomeSplash() {
  try {
    fsSync.accessSync(welcomeMarkerPath());
    return true;
  } catch {
    return false;
  }
}

function showWelcomeSplash() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.show();
    welcomeWindow.focus();
    return;
  }
  // Cover the entire screen (menu bar and dock included) — a full glass
  // sheet over the desktop, like the snip overlay.
  const { bounds } = screen.getPrimaryDisplay();
  welcomeWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    ...floatingGlassChrome(),
    // Full-bleed sheet — no rounded corners at the screen edges.
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, "welcome-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Workspaces first, level last — setVisibleOnAllWorkspaces can reset the
  // window level on macOS (see createOverlayWindow). The main window boots
  // fullscreen (its own Space), so the splash must ride above it; screen-saver
  // level clears the menu bar like the snip overlay.
  welcomeWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  welcomeWindow.setAlwaysOnTop(true, "screen-saver");
  welcomeWindow.once("ready-to-show", () => {
    // showInactive: never steal keyboard focus — the user may be typing while
    // the app boots, and a stray keystroke would land on (and dismiss) the
    // splash. Clicks still skip it; it closes itself when the reveal ends.
    if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.showInactive();
  });
  welcomeWindow.on("closed", () => {
    welcomeWindow = null;
    if (!welcomeGateActive) return;
    // The welcome stages are the whole walkthrough. Its final handoff opens
    // the normal glass Studio, not the retired sign-in surface.
    welcomeGateActive = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      const revealStudio = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        // The window boots windowed while gated (fullscreen would have made
        // it visible behind the welcome glass) — go fullscreen at reveal.
        // macOS uses simple fullscreen so it stays on the regular desktop.
        if (IS_MAC) {
          try {
            if (!mainWindow.isSimpleFullScreen()) mainWindow.setSimpleFullScreen(true);
          } catch (_) {}
        } else if (!mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(true);
        }
        broadcastStudioFullscreen();
      };
      // Normal walkthrough handoff: the studio finished loading behind the
      // welcome loader — reveal it as-is. Reloading here would restart the
      // app boot and flash its loading screen.
      if (welcomeStudioPreloaded) {
        revealStudio();
        return;
      }
      void mainWindow
        .loadURL(`${APP_ORIGIN}/studio?glass=1&walkthrough=1`)
        .then(revealStudio)
        .catch((err) => {
          console.warn("[welcome] Studio handoff:", err?.message || err);
          revealStudio();
        });
    } else {
      createMainWindow();
    }
  });
  void welcomeWindow.loadFile(path.join(__dirname, "welcome.html"));
  try {
    fsSync.writeFileSync(welcomeMarkerPath(), new Date().toISOString(), "utf8");
  } catch {
    /* non-fatal — worst case the splash replays next launch */
  }
}

/** Password is held only until the welcome verification completes. */
let welcomeSignupSecret = null;

function welcomeSupabaseAuthCreds() {
  let url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
  let key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";
  if ((!url || !key) && !app.isPackaged) {
    try {
      for (const line of fsSync.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, "").trim();
        if (!url && ["VITE_SUPABASE_URL", "SUPABASE_URL"].includes(match[1])) url = value;
        if (!key && ["VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"].includes(match[1])) key = value;
      }
    } catch {
      /* development .env is optional */
    }
  }
  return url && key ? { url, key } : null;
}

async function signInWelcomeAccount() {
  const secret = welcomeSignupSecret;
  welcomeSignupSecret = null;
  const creds = welcomeSupabaseAuthCreds();
  if (!secret || !creds) return false;
  try {
    const response = await fetch(`${creds.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: creds.key },
      body: JSON.stringify(secret),
    });
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !session?.access_token || !session?.refresh_token) return false;
    deliverAuthTokensToRenderer(session.access_token, session.refresh_token);
    return true;
  } catch {
    return false;
  }
}

function registerWelcomeIpc() {
  // "Get started" on the essentials page: apply the chosen options. The
  // renderer then completes the walkthrough in the same window.
  ipcMain.handle("lykn:welcome-get-started", (_e, opts = {}) => {
    if (opts.login) {
      setLoginItemEnabled(true);
    }
    if (opts.defaultBrowser) {
      try {
        app.setAsDefaultProtocolClient("http");
        app.setAsDefaultProtocolClient("https");
      } catch (e) {
        console.warn("[welcome] default browser:", e?.message);
      }
    }
    if (opts.dock && IS_MAC && app.isPackaged) {
      // Pin the .app to the Dock (persistent-apps plist + Dock restart).
      // Packaged only — in dev this would pin the bare Electron binary.
      try {
        const appBundle = path.resolve(process.execPath, "..", "..", "..");
        if (appBundle.endsWith(".app")) {
          const entry =
            `<dict><key>tile-data</key><dict><key>file-data</key><dict>` +
            `<key>_CFURLString</key><string>${appBundle}</string>` +
            `<key>_CFURLStringType</key><integer>0</integer>` +
            `</dict></dict></dict>`;
          execFile("defaults", ["write", "com.apple.dock", "persistent-apps", "-array-add", entry], (err) => {
            if (!err) execFile("killall", ["Dock"], () => {});
          });
        }
      } catch (e) {
        console.warn("[welcome] dock pin:", e?.message);
      }
    }
    return { ok: true };
  });

  // Past the reveal, drop from screen-saver level to a normal window. The
  // window still covers the screen; it just stops pinning itself.
  ipcMain.on("lykn:welcome-stage", (_e, stage) => {
    if (Number(stage) < 2) return;
    if (!welcomeWindow || welcomeWindow.isDestroyed()) return;
    welcomeWindow.setAlwaysOnTop(false);
    welcomeWindow.setVisibleOnAllWorkspaces(false);
    // The reveal used showInactive; from here on it's a real form window.
    welcomeWindow.focus();
  });

  ipcMain.handle("lykn:welcome-signup", async (_e, { email, password } = {}) => {
    const normalizedEmail = String(email || "").trim();
    const secret = String(password || "");
    try {
      const response = await fetch(`${API_BASE}/api/auth/signup-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, password: secret }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.ok) {
        return { ok: false, error: result?.error || "Could not create account." };
      }
      welcomeSignupSecret = { email: normalizedEmail, password: secret };
      return { ok: true };
    } catch (error) {
      console.warn("[welcome] signup:", error?.message || error);
      return { ok: false, error: "Couldn't reach LYKN — check your connection and try again." };
    }
  });

  ipcMain.handle("lykn:welcome-signin", async (_e, { email, password } = {}) => {
    const creds = welcomeSupabaseAuthCreds();
    if (!creds) return { ok: false, error: "Sign-in is unavailable. Check your connection and try again." };
    try {
      const response = await fetch(`${creds.url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: creds.key },
        body: JSON.stringify({ email: String(email || "").trim(), password: String(password || "") }),
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok || !session?.access_token || !session?.refresh_token) {
        return { ok: false, error: session?.error_description || "Incorrect email or password." };
      }
      deliverAuthTokensToRenderer(session.access_token, session.refresh_token);
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't reach LYKN — check your connection and try again." };
    }
  });

  // "Continue with Google": Google blocks OAuth in embedded windows, so the
  // round-trip runs in the system browser via /desktop-auth — the same flow
  // the main app uses. The session comes back through the loopback handoff
  // and deliverAuthTokensToRenderer pings the walkthrough to advance.
  ipcMain.handle("lykn:welcome-google", () => {
    const url = mintDesktopAuthUrl(`${APP_ORIGIN}/desktop-auth`);
    void shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("lykn:welcome-resend", async (_e, { email } = {}) => {
    try {
      const response = await fetch(`${API_BASE}/api/auth/signup-resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(email || "").trim() }),
      });
      const result = await response.json().catch(() => ({}));
      return response.ok && result?.ok
        ? { ok: true }
        : { ok: false, error: result?.error || "Could not resend code." };
    } catch {
      return { ok: false, error: "Couldn't reach LYKN — check your connection and try again." };
    }
  });

  ipcMain.handle("lykn:welcome-verify", async (_e, { email, code } = {}) => {
    try {
      const response = await fetch(`${API_BASE}/api/auth/signup-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(email || "").trim(), code: String(code || "").trim() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.ok) {
        return { ok: false, error: result?.error || "Could not verify code." };
      }
      await signInWelcomeAccount();
      return { ok: true };
    } catch (error) {
      console.warn("[welcome] verify:", error?.message || error);
      return { ok: false, error: "Couldn't reach LYKN — check your connection and try again." };
    }
  });

  // Import stage: Chromium browsers whose sessions can be securely synced.
  ipcMain.handle("lykn:welcome-browsers", () => {
    if (IS_MAC) {
      return chromeSync.detectBrowsers().map((browser) => ({
        id: browser.id,
        name: browser.name,
        profiles: chromeSync.listProfiles(browser).length,
      }));
    }
    return [];
  });

  const welcomeProfileFile = () =>
    path.join(app.getPath("userData"), "welcome-profile.json");

  const readWelcomeProfile = () => {
    try {
      const profile = JSON.parse(fsSync.readFileSync(welcomeProfileFile(), "utf8"));
      return profile && typeof profile === "object" ? profile : {};
    } catch {
      return {};
    }
  };

  // Welcome-profile writes are merges — each stage adds what it learned.
  const mergeWelcomeProfile = (patch) => {
    const file = welcomeProfileFile();
    let profile = {};
    try {
      profile = JSON.parse(fsSync.readFileSync(file, "utf8"));
    } catch {
      /* fresh profile */
    }
    try {
      fsSync.writeFileSync(file, JSON.stringify({ ...profile, ...patch }, null, 2), "utf8");
    } catch (e) {
      console.warn("[welcome] profile store:", e?.message);
    }
  };

  // Import stage "Next": remember the chosen source browser — the actual
  // import runs later, once that feature lands.
  ipcMain.handle("lykn:welcome-import", (_e, browser) => {
    mergeWelcomeProfile({ importBrowser: String(browser || "") });
    return { ok: true };
  });

  // Logins stage: the user wants saved passwords brought over too.
  ipcMain.handle("lykn:welcome-import-logins", (_e, wanted) => {
    mergeWelcomeProfile({ importLogins: !!wanted });
    return { ok: true };
  });

  // Studio Mac dock pins — which local apps the user keeps on the dock strip.
  ipcMain.handle("lykn:mac-dock-pins-get", () => {
    try {
      const file = path.join(app.getPath("userData"), "welcome-profile.json");
      const profile = JSON.parse(fsSync.readFileSync(file, "utf8"));
      return { ok: true, pins: Array.isArray(profile.macDockPins) ? profile.macDockPins : [] };
    } catch {
      return { ok: true, pins: [] };
    }
  });
  ipcMain.handle("lykn:mac-dock-pins-set", (_e, { pins } = {}) => {
    const clean = (Array.isArray(pins) ? pins : [])
      .map((p) => String(p || ""))
      .filter(Boolean)
      .slice(0, 30);
    mergeWelcomeProfile({ macDockPins: clean });
    return { ok: true, pins: clean };
  });

  // Mac sync stage: persist the synced-folders allowlist and switch Local
  // Mode on — this is the consent moment for LYKN reading local files.
  ipcMain.handle("lykn:welcome-macsync", (_e, { syncAll, folders } = {}) => {
    const userData = app.getPath("userData");
    const cleanFolders = (Array.isArray(folders) ? folders : [])
      .map((f) => String(f || "").trim())
      .filter(Boolean)
      .slice(0, 100);
    const next = localSystem.writeMacSync(userData, {
      syncAll: syncAll === true,
      syncedFolders: syncAll === true ? [] : cleanFolders,
    });
    localSystem.writeLocalMode(userData, true);
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send("lykn:local-mode-changed", { enabled: true });
          win.webContents.send("lykn:mac-sync-changed", {
            enabled: true,
            syncAll: next.syncAll,
            syncedFolders: next.syncedFolders,
          });
        }
      } catch (_) {}
    }
    mergeWelcomeProfile({ macSync: { syncAll: next.syncAll, folders: next.syncedFolders } });
    return { ok: true };
  });

  // ── Studio background — synced from the Mac ───────────────────────────────
  // The user picks any image (or their current macOS wallpaper) and it becomes
  // the Studio backdrop. Everything is normalized to a JPEG in userData via
  // `sips` because macOS wallpapers are usually HEIC, which Chromium can't
  // render. Renderers get data URLs; live changes broadcast to all windows.
  const studioBgFile = () => path.join(app.getPath("userData"), "studio-background.jpg");
  const bgDataUrl = (file) => {
    try {
      const buf = fsSync.readFileSync(file);
      return buf.length ? "data:image/jpeg;base64," + buf.toString("base64") : "";
    } catch {
      return "";
    }
  };
  // maxPx 0 converts without resampling — sips would otherwise upscale sources
  // that are already smaller than the target.
  const bgConvert = (src, dest, maxPx) =>
    new Promise((resolve) => {
      execFile(
        "sips",
        [
          "-s", "format", "jpeg",
          "-s", "formatOptions", "85",
          ...(maxPx ? ["--resampleHeightWidthMax", String(maxPx)] : []),
          src,
          "--out", dest,
        ],
        { timeout: 15_000 },
        (err) => resolve(!err)
      );
    });
  const runBgOsa = (script) =>
    new Promise((resolve) => {
      execFile("osascript", ["-e", script], { timeout: 5000 }, (err, stdout) =>
        resolve(err ? "" : String(stdout || "").trim())
      );
    });
  const currentWallpaperPath = async () => {
    // System Events first; Finder as fallback (dynamic wallpapers sometimes
    // only answer through one of the two).
    const scripts = [
      'tell application "System Events" to get picture of current desktop',
      'tell application "Finder" to get POSIX path of (desktop picture as alias)',
    ];
    for (const script of scripts) {
      const out = await runBgOsa(script);
      if (out && fsSync.existsSync(out)) {
        try {
          if (fsSync.statSync(out).isFile()) return out;
        } catch (_) {}
      }
    }
    return "";
  };
  const broadcastBackground = (dataUrl, srcPath = "", id = "") => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send("lykn:background-changed", { dataUrl, path: srcPath, id });
        }
      } catch (_) {}
    }
  };
  ipcMain.handle("lykn:background-get", () => {
    // Which source produced it, so the wallpaper picker can mark its tile.
    const profile = readWelcomeProfile();
    return {
      ok: true,
      dataUrl: bgDataUrl(studioBgFile()),
      path: profile.studioBackgroundPath || "",
      id: profile.studioBackgroundId || "",
    };
  });

  // ── The wallpapers macOS ships (System Settings › Wallpaper) ──────────────
  // Apple keeps them in three places, so we read all three:
  //   • full-size stills sitting in /System/Library/Desktop Pictures
  //   • Solid Colors — tiny flat PNGs in a subfolder
  //   • everything else (Big Sur, Catalina, Ventura, the hello set…), which
  //     ships as a .madesktop stub whose only local image is a ~214px
  //     thumbnail. Those masters live in Apple's MobileAsset catalog and are
  //     fetched on demand, which is exactly what System Settings does when you
  //     click one.
  // Grid thumbnails always come from local files, so browsing needs no network.
  const SYSTEM_WALLPAPER_ROOT = "/System/Library/Desktop Pictures";
  const SYSTEM_THUMB_DIR = path.join(SYSTEM_WALLPAPER_ROOT, ".thumbnails");
  const DESKTOP_ASSET_CATALOG =
    "/System/Library/AssetsV2/com_apple_MobileAsset_DesktopPicture/com_apple_MobileAsset_DesktopPicture.xml";
  const WALLPAPER_EXT_RE = /\.(heic|heif|jpe?g|png|tiff?)$/i;
  const MIN_STILL_BYTES = 8 * 1024; // filters stub/preview art, not solid colors

  const wallpaperLabel = (file) => file.replace(WALLPAPER_EXT_RE, "");
  const wallpaperId = (name) =>
    crypto.createHash("sha1").update(String(name)).digest("hex").slice(0, 16);
  const wallpaperCacheFile = (id) =>
    path.join(app.getPath("userData"), "wallpaper-cache", `${id}.jpg`);

  /** id -> item, rebuilt by the list handler. The thumbnail and apply handlers
   *  resolve an id through this, so the renderer never hands us a path to read
   *  or a URL to fetch. */
  let systemWallpapers = new Map();

  const readWallpaperDir = async (dir, group, minBytes = MIN_STILL_BYTES) => {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return []; // folder doesn't exist on this macOS version
    }
    const items = [];
    for (const name of names) {
      if (name.startsWith(".") || !WALLPAPER_EXT_RE.test(name)) continue;
      if (/thumbnail/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile() || stat.size < minBytes) continue;
      } catch {
        continue;
      }
      items.push({
        name: wallpaperLabel(name),
        group,
        source: full,
        thumbSource: full,
        thumbMax: 480,
      });
    }
    return items;
  };

  /* The catalog is an XML plist of flat dicts. plutil can't convert it to JSON
   * (it holds <data> checksums), and a plist library isn't worth shipping for
   * one file, so scan the Assets array directly. */
  const parseAssetCatalog = (xml) => {
    const keyed = xml.indexOf("<key>Assets</key>");
    if (keyed < 0) return [];
    const arrayStart = xml.indexOf("<array>", keyed);
    const arrayEnd = xml.indexOf("</array>", arrayStart);
    if (arrayStart < 0 || arrayEnd < 0) return [];
    const assets = [];
    for (const block of xml.slice(arrayStart, arrayEnd).matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
      const fields = {};
      const pair =
        /<key>([^<]+)<\/key>\s*(?:<(string|integer|real|data)>([\s\S]*?)<\/\2>|<(true|false)\s*\/>)/g;
      for (const m of block[1].matchAll(pair)) {
        fields[m[1]] = m[4] ? m[4] === "true" : m[3].trim();
      }
      assets.push(fields);
    }
    return assets;
  };

  const readCatalogWallpapers = async () => {
    let xml = "";
    try {
      xml = await fs.readFile(DESKTOP_ASSET_CATALOG, "utf8");
    } catch {
      return []; // no catalog: only the on-disk wallpapers are offered
    }
    const items = [];
    for (const asset of parseAssetCatalog(xml)) {
      const name = asset.DesktopPictureID || "";
      const base = asset.__BaseURL || "";
      const rel = asset.__RelativePath || "";
      if (!name || !base || !rel) continue;
      const thumbSource = path.join(SYSTEM_THUMB_DIR, `${name}.heic`);
      items.push({
        name,
        group: "pictures",
        url: `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`,
        sizeBytes: Number(asset._DownloadSize) || 0,
        // Apple's SHA-1 of the zip, so a bad object can't become a wallpaper.
        sha1:
          asset._MeasurementAlgorithm === "SHA-1" && asset._Measurement
            ? Buffer.from(asset._Measurement.replace(/\s+/g, ""), "base64").toString("hex")
            : "",
        thumbSource: fsSync.existsSync(thumbSource) ? thumbSource : "",
      });
    }
    return items;
  };

  const buildSystemWallpapers = async () => {
    // Solid colors are tiny by nature (a 128px flat PNG), hence the lower floor.
    const [pictures, colors, remote] = await Promise.all([
      readWallpaperDir(SYSTEM_WALLPAPER_ROOT, "pictures"),
      readWallpaperDir(path.join(SYSTEM_WALLPAPER_ROOT, "Solid Colors"), "colors", 0),
      readCatalogWallpapers(),
    ]);

    // Newer releases tuck a few full-size stills (e.g. Sonoma Horizon) inside
    // the hidden .wallpapers bundle alongside the .mov versions.
    const bundled = [];
    const bundleRoot = path.join(SYSTEM_WALLPAPER_ROOT, ".wallpapers");
    try {
      for (const dir of await fs.readdir(bundleRoot)) {
        bundled.push(
          ...(await readWallpaperDir(path.join(bundleRoot, dir), "pictures", 512 * 1024)),
        );
      }
    } catch {
      /* no bundle on this macOS version */
    }

    // Local first: a wallpaper already on disk needs no download, and several
    // (the iMac colors, Sonoma) appear in both places.
    const byName = new Map();
    for (const item of [...pictures, ...bundled, ...colors, ...remote]) {
      if (!byName.has(item.name)) byName.set(item.name, item);
    }
    // Colors last, pictures alphabetical — one grid, like System Settings.
    const ordered = [...byName.values()].sort((a, b) =>
      a.group === b.group
        ? a.name.localeCompare(b.name, undefined, { numeric: true })
        : a.group === "colors"
          ? 1
          : -1,
    );
    systemWallpapers = new Map(
      ordered.map((item) => [wallpaperId(item.name), { ...item, id: wallpaperId(item.name) }]),
    );
    return systemWallpapers;
  };

  const systemWallpaperById = async (id) => {
    if (!systemWallpapers.size) await buildSystemWallpapers();
    return systemWallpapers.get(String(id || "")) || null;
  };

  ipcMain.handle("lykn:background-system-list", async () => {
    const map = await buildSystemWallpapers();
    return {
      ok: true,
      items: [...map.values()]
        // A wallpaper with neither a local file nor a thumbnail has nothing to
        // show in the grid (light/dark variants of the dynamic sets).
        .filter((item) => item.source || item.thumbSource)
        .map((item) => ({
          id: item.id,
          name: item.name,
          group: item.group,
          needsDownload: !item.source && !fsSync.existsSync(wallpaperCacheFile(item.id)),
          sizeBytes: item.sizeBytes || 0,
        })),
    };
  });

  // Grid-sized preview, cached in userData: HEIC needs a sips pass before
  // Chromium can show it, and that pass is the slow part.
  ipcMain.handle("lykn:background-system-thumb", async (_e, id) => {
    const item = await systemWallpaperById(id);
    const src = item?.thumbSource || "";
    if (!src || !fsSync.existsSync(src)) return { ok: false, error: "no_thumbnail" };
    const cacheDir = path.join(app.getPath("userData"), "wallpaper-thumbs");
    const dest = path.join(cacheDir, `${item.id}.jpg`);
    if (!fsSync.existsSync(dest)) {
      try {
        await fs.mkdir(cacheDir, { recursive: true });
      } catch {
        /* the convert below will fail and the tile stays a placeholder */
      }
      // Apple's own preview art is already tile-sized; only full-size stills
      // need scaling down.
      if (!(await bgConvert(src, dest, item.thumbMax || 0))) {
        return { ok: false, error: "convert_failed" };
      }
    }
    return { ok: true, dataUrl: bgDataUrl(dest) };
  });

  // Stream Apple's asset zip to disk, hashing as it lands.
  const downloadWallpaperAsset = async (item, dest, onProgress) => {
    let res;
    try {
      res = await electronNet.fetch(item.url, { redirect: "follow" });
    } catch {
      return { ok: false, error: "offline" };
    }
    if (!res.ok || !res.body) return { ok: false, error: `http_${res.status || 0}` };
    const total = Number(res.headers.get("content-length")) || item.sizeBytes || 0;
    const hash = crypto.createHash("sha1");
    const handle = await fs.open(dest, "w");
    let received = 0;
    let lastTick = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await handle.write(value);
        received += value.byteLength;
        const now = Date.now();
        if (now - lastTick > 200) {
          lastTick = now;
          onProgress(received, total);
        }
      }
    } finally {
      await handle.close();
    }
    if (item.sha1 && hash.digest("hex") !== item.sha1) {
      return { ok: false, error: "checksum_mismatch" };
    }
    return { ok: true };
  };

  /** Unpack the asset and return its largest image — the master still sits at
   *  AssetData/<name>.heic, but the layout is Apple's to change. */
  const extractWallpaperImage = async (zipFile, dir) => {
    await new Promise((resolve) => {
      // ditto, not unzip: it's the tool that understands Apple's archives.
      execFile("ditto", ["-x", "-k", zipFile, dir], { timeout: 120_000 }, () => resolve());
    });
    let best = null;
    const walk = async (current, depth) => {
      if (depth > 3) return;
      let entries = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!WALLPAPER_EXT_RE.test(entry.name)) continue;
        try {
          const stat = await fs.stat(full);
          if (!best || stat.size > best.size) best = { path: full, size: stat.size };
        } catch {
          /* skip unreadable entries */
        }
      }
    };
    await walk(dir, 0);
    return best?.path || "";
  };

  ipcMain.handle("lykn:background-system-apply", async (e, id) => {
    const item = await systemWallpaperById(id);
    if (!item) return { ok: false, error: "unknown_wallpaper" };
    const send = (payload) => {
      try {
        if (!e.sender.isDestroyed()) {
          e.sender.send("lykn:background-progress", { id: item.id, ...payload });
        }
      } catch (_) {}
    };
    let workDir = "";
    try {
      if (item.source) {
        send({ phase: "applying" });
        if (!(await bgConvert(item.source, studioBgFile(), 2560))) {
          send({ phase: "error" });
          return { ok: false, error: "convert_failed" };
        }
      } else {
        // Downloaded masters are converted once and kept as a ready backdrop,
        // so picking the same wallpaper again never re-downloads 30MB.
        const cached = wallpaperCacheFile(item.id);
        if (!fsSync.existsSync(cached)) {
          workDir = path.join(app.getPath("temp"), `lykn-wallpaper-${item.id}`);
          await fs.rm(workDir, { recursive: true, force: true });
          await fs.mkdir(workDir, { recursive: true });
          const zip = path.join(workDir, "asset.zip");
          send({ phase: "downloading", received: 0, total: item.sizeBytes || 0 });
          const got = await downloadWallpaperAsset(item, zip, (received, total) =>
            send({ phase: "downloading", received, total }),
          );
          if (!got.ok) {
            send({ phase: "error" });
            return got;
          }
          send({ phase: "applying" });
          const image = await extractWallpaperImage(zip, path.join(workDir, "asset"));
          if (!image) {
            send({ phase: "error" });
            return { ok: false, error: "asset_empty" };
          }
          await fs.mkdir(path.dirname(cached), { recursive: true });
          if (!(await bgConvert(image, cached, 2560))) {
            send({ phase: "error" });
            return { ok: false, error: "convert_failed" };
          }
        } else {
          send({ phase: "applying" });
        }
        fsSync.copyFileSync(cached, studioBgFile());
      }
      const dataUrl = bgDataUrl(studioBgFile());
      mergeWelcomeProfile({
        studioBackground: "system",
        studioBackgroundPath: item.source || "",
        studioBackgroundId: item.id,
      });
      broadcastBackground(dataUrl, item.source || "", item.id);
      send({ phase: "done" });
      return { ok: true, dataUrl };
    } catch (err) {
      send({ phase: "error" });
      return { ok: false, error: err?.message || "apply_failed" };
    } finally {
      if (workDir) fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  // Small preview of the user's current macOS wallpaper (welcome stage card).
  ipcMain.handle("lykn:background-wallpaper-preview", async () => {
    const src = await currentWallpaperPath();
    if (!src) return { ok: false, error: "wallpaper_unavailable" };
    const tmp = path.join(app.getPath("temp"), "lykn-bg-wallpaper-preview.jpg");
    if (!(await bgConvert(src, tmp, 640))) return { ok: false, error: "convert_failed" };
    return { ok: true, dataUrl: bgDataUrl(tmp) };
  });
  // Native image picker; returns the chosen path plus a small preview.
  ipcMain.handle("lykn:background-pick-file", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: "Choose a background image",
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "heic", "heif", "webp", "tiff", "gif", "bmp"] },
      ],
    });
    if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
    const src = res.filePaths[0];
    const tmp = path.join(app.getPath("temp"), "lykn-bg-pick-preview.jpg");
    const preview = (await bgConvert(src, tmp, 640)) ? bgDataUrl(tmp) : "";
    return { ok: true, path: src, dataUrl: preview };
  });
  // Persist: source is "wallpaper" or an explicit image path.
  ipcMain.handle("lykn:background-set", async (_e, { source, path: srcPath } = {}) => {
    const src =
      source === "wallpaper" ? await currentWallpaperPath() : String(srcPath || "");
    if (!src || !fsSync.existsSync(src)) return { ok: false, error: "source_missing" };
    if (!(await bgConvert(src, studioBgFile(), 2560))) {
      return { ok: false, error: "convert_failed" };
    }
    const dataUrl = bgDataUrl(studioBgFile());
    mergeWelcomeProfile({
      studioBackground: source === "wallpaper" ? "wallpaper" : "custom",
      // Kept so the wallpaper picker can highlight the tile in use — the
      // converted JPEG itself says nothing about where it came from.
      studioBackgroundPath: src,
      studioBackgroundId: "",
    });
    broadcastBackground(dataUrl, src);
    return { ok: true, dataUrl };
  });
  ipcMain.handle("lykn:background-clear", () => {
    try {
      fsSync.unlinkSync(studioBgFile());
    } catch (_) {}
    mergeWelcomeProfile({
      studioBackground: "",
      studioBackgroundPath: "",
      studioBackgroundId: "",
    });
    broadcastBackground("");
    return { ok: true };
  });

  // Widgets stage: which widgets the Home desktop shows. The studio keeps
  // widget state in its own settings, so the picks travel with a stamp — the
  // renderer applies them once and later Settings edits stay put.
  const readHomeWidgets = () => {
    try {
      const file = path.join(app.getPath("userData"), "welcome-profile.json");
      const profile = JSON.parse(fsSync.readFileSync(file, "utf8"));
      const widgets =
        profile.homeWidgets && typeof profile.homeWidgets === "object"
          ? profile.homeWidgets
          : {};
      return { ok: true, widgets, stamp: Number(profile.homeWidgetsStamp) || 0 };
    } catch {
      return { ok: true, widgets: {}, stamp: 0 };
    }
  };
  ipcMain.handle("lykn:home-widgets-get", () => readHomeWidgets());
  ipcMain.handle("lykn:welcome-widgets", (_e, widgets = {}) => {
    const clean = {};
    for (const [id, on] of Object.entries(widgets || {})) {
      if (/^[a-zA-Z]{1,40}$/.test(id)) clean[id] = on === true;
    }
    const stamp = Date.now();
    mergeWelcomeProfile({ homeWidgets: clean, homeWidgetsStamp: stamp });
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send("lykn:home-widgets-changed", { widgets: clean, stamp });
        }
      } catch (_) {}
    }
    return { ok: true };
  });

  // Apps stage: the user's favorite apps as ready-made hot links for the
  // browser — { id, name, url, icon } each.
  ipcMain.handle("lykn:welcome-apps", (_e, apps) => {
    const clean = (Array.isArray(apps) ? apps : [])
      .filter((a) => a && typeof a === "object")
      .map((a) => ({
        id: String(a.id || "").slice(0, 100),
        name: String(a.name || "").slice(0, 80),
        url: String(a.url || ""),
        icon: String(a.icon || ""),
      }))
      .filter((a) => a.name && /^https:\/\//.test(a.url) && (!a.icon || /^https:\/\//.test(a.icon)))
      .slice(0, 24);
    mergeWelcomeProfile({ favoriteApps: clean, hotLinks: clean });
    return { ok: true };
  });

  // Privacy stage: tracker blocking + content-data sharing choices.
  ipcMain.handle("lykn:welcome-privacy", (_e, privacy = {}) => {
    mergeWelcomeProfile({
      blockTrackers: !!privacy.blockTrackers,
      shareContentData: !!privacy.shareContentData,
    });
    return { ok: true };
  });

  // Make LYKN Yours: theme + layout picks from the customization slides.
  ipcMain.handle("lykn:welcome-prefs", (_e, prefs = {}) => {
    const patch = {};
    if (typeof prefs.accent === "string" && /^#[0-9a-f]{6}$/i.test(prefs.accent)) patch.accent = prefs.accent;
    if (["dark", "light", "auto"].includes(prefs.appearance)) patch.appearance = prefs.appearance;
    if (["top", "sidebar"].includes(prefs.tabLayout)) patch.tabLayout = prefs.tabLayout;
    if (["studio", "chat", "browser"].includes(prefs.startView)) patch.startView = prefs.startView;
    mergeWelcomeProfile(patch);
    return { ok: true };
  });

  // Done with the welcome stages. The studio has been loading hidden behind
  // the walkthrough since launch (createMainWindow boots
  // /studio?glass=1&walkthrough=1 and the walkthrough sign-in hands it the
  // session live) — DON'T reload it here: a reload restarts the whole app
  // boot and the reveal lands on the app's own loading screen. Just wait for
  // the existing load to settle (20s worst case), keep the loader up for at
  // least one full spinner cycle, then fade out — the closed handler reveals
  // the already-rendered studio.
  ipcMain.handle("lykn:welcome-finish", async () => {
    // The finish-stage logo reveal (lyknReveal*) runs a 4.5s cycle — never
    // fade out before one full pass, even if the studio is already ready.
    const MIN_LOADER_MS = 4650;
    const loaderShownAt = Date.now();
    try {
      const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
      if (wc && (wc.isLoading() || !wc.getURL())) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 20000);
          wc.once("did-finish-load", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (wc) {
        welcomeStudioPreloaded = true;
        console.log("[welcome] finish: revealing", wc.getURL() || "(no url)");
      }
    } catch {
      /* reveal whatever we have */
    }
    const hold = MIN_LOADER_MS - (Date.now() - loaderShownAt);
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      try {
        await welcomeWindow.webContents.executeJavaScript(
          'document.body.classList.add("leaving")',
          true,
        );
      } catch {
        /* fade is cosmetic */
      }
      setTimeout(() => {
        if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.close();
      }, 520);
    }
    return { ok: true };
  });

  ipcMain.on("lykn:welcome-open-privacy", () => {
    void shell.openExternal(`${APP_ORIGIN}/privacy`);
  });

  ipcMain.on("lykn:welcome-open-terms", () => {
    void shell.openExternal(`${APP_ORIGIN}/terms`);
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
      screenProbeCache = dataUrl ? "granted" : "denied";
      return screenProbeCache;
    } catch {
      screenProbeCache = "denied";
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
  ipcMain.handle("lykn:reveal-extension-folder", async (_e, { reveal = true } = {}) => {
    try {
      const extPath = await prepareExtensionInstallDir({
        userDataPath: app.getPath("userData"),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appDir: __dirname,
        writeBridgeConfig: (dir) => extensionBridge?.writeBridgeConfigToExtensionDir?.(dir),
      });
      clipboard.writeText(extPath);
      if (!reveal) {
        return { ok: true, path: extPath, folderName: path.basename(extPath) };
      }
      const revealed = await revealExtensionInstallFolder(shell, extPath);
      return {
        ok: !!revealed?.ok,
        path: extPath,
        folderName: path.basename(extPath),
        error: revealed?.error,
      };
    } catch (e) {
      console.warn("[extension-install] reveal:", e?.message || e);
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
  // (Unless the first-launch walkthrough is still on screen.)
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else if (!welcomeGateActive) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  // User deliberately re-opened the app — good moment to surface a pending update.
  void maybePromptPendingUpdate({ force: Boolean(pendingUpdate) });
});

// Silent background auto-update via GitHub Releases (electron-updater). Only
// runs in the packaged app — in dev there's no update feed. Downloads new
// versions in the background and, once ready, offers a one-click restart.
//
// Menu-bar mode: the Dock is often hidden and there may be no main window
// (login launch / always-on Mac mini). A parentless dialog is easy to miss,
// so we surface Dock + window, parent the dialog, fire a Notification, keep a
// tray "Restart to Update" item, and re-prompt on activate / resume.
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
  autoUpdater.autoInstallOnAppQuit = true;

  installPendingUpdate = () => {
    // Installing an update is a legitimate exit — don't reroute it to
    // background mode via before-quit.
    allowQuit = true;
    try {
      autoUpdater.quitAndInstall();
    } catch (e) {
      console.log("[update] quitAndInstall failed:", e && e.message ? e.message : e);
      quitForReal();
    }
  };

  autoUpdater.on("error", (err) => {
    console.log("[update] error:", err && err.message ? err.message : err);
  });
  autoUpdater.on("update-available", (info) => {
    console.log("[update] available:", info && info.version);
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[update] up to date");
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log("[update] downloaded:", info && info.version);
    pendingUpdate = { version: (info && info.version) || "" };
    refreshTrayUpdateAffordance();
    // Force the first prompt so always-on / background launches still see it.
    void maybePromptPendingUpdate({ force: true });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log("[update] check failed:", err && err.message ? err.message : err);
    });
  };

  // Check on launch, every 6 hours while alive, and again after sleep/wake
  // (Mac mini / laptop lids often skip the interval until the process wakes).
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
  try {
    powerMonitor.on("resume", () => {
      setTimeout(check, 15_000);
      void maybePromptPendingUpdate({ force: false });
    });
  } catch (_) {
    /* older Electron */
  }
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

  claimLyknProtocol();
  startAuthHandoffServer();
  // Start the agent list load before anyone can open Browser, so a click
  // doesn't race createAgent against a later restore of leftover workers.
  try {
    initAgentRuntime();
  } catch (_) {}

  installPermissionHandler();
  setupSystemAudioCapture();
  buildAppMenu();
  registerOverlayIpc();
  registerWelcomeIpc();
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
  if (!backgroundLaunch) {
    // Very first launch: the glass welcome walkthrough owns the screen while
    // the app loads hidden behind it, then reveals the Studio when it finishes.
    // Marker-gated so it only ever runs once.
    if (process.env.LYKN_FORCE_WELCOME === "1" || !hasSeenWelcomeSplash()) {
      welcomeGateActive = true;
      showWelcomeSplash();
    }
    createMainWindow();
  } else ensureAuthKeeper();
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

  // The optional permissions walkthrough stays reachable from the tray menu
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
    // First-launch gate: the welcome splash / walkthrough owns the screen —
    // don't let a dock click reveal the home screen early.
    if (welcomeGateActive) return;
    // The hidden overlay/burst windows always exist, so check the main window
    // itself — otherwise the dock icon does nothing after a background launch.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    void maybePromptPendingUpdate({ force: false });
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
  macFiles.closeWatchers();
  globalShortcut.unregisterAll();
  // Checkpoints the WAL so the database file on disk is complete on its own —
  // matters for snapshots and for anything the user copies out.
  localStore.shutdown();
});

app.on("window-all-closed", () => {
  // Tray app on every platform: stay alive so the hotkey + tray keep working.
  // Real exits go through quitForReal() / allowQuit.
});
