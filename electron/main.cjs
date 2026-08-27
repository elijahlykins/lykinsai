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

const {
  IS_MAC,
  IS_WIN,
  GLASS_FALLBACK,
  APP_URL,
  APP_ORIGIN,
  API_BASE,
} = require("./shell/appEnv.cjs");
const {
  assertPublicHttpUrl,
  safeFetchMain,
  openExternalSafe,
} = require("./net/safeFetch.cjs");
const overlayConstants = require("./windows/overlayConstants.cjs");
const { initializeElectronServices } = require("./services/initializeElectronServices.cjs");
const { registerAllIpc } = require("./ipc/index.cjs");
const { attachDesktopAuth } = require("./auth/desktopAuth.cjs");
const { attachAutoUpdate } = require("./updater/autoUpdate.cjs");
const { attachGlassChrome } = require("./windows/glassChrome.cjs");
const { attachOverlayFamily } = require("./windows/overlayFamily.cjs");
const { attachScreenCapture } = require("./windows/screenCapture.cjs");
const { attachOverlaySatellites } = require("./windows/overlaySatellites.cjs");
const { attachMainStudio } = require("./windows/mainStudio.cjs");
const { attachTray } = require("./tray/tray.cjs");
const { attachOverlaySettings } = require("./overlay/settings.cjs");
const { attachLiveWatch } = require("./overlay/liveWatch.cjs");
const { attachOverlaySessions } = require("./overlay/sessions.cjs");
const { attachWelcomeOnboarding } = require("./windows/welcomeOnboarding.cjs");
const { attachBrowserAutomation } = require("./os/browserAutomation.cjs");
const { attachAskPipeline } = require("./overlay/askPipeline.cjs");

// Intel-Mac glass fallback: see GLASS_FALLBACK in shell/appEnv.cjs.

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
const { pathToFileURL } = require("node:url");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
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
const { createLocalApprovalRegistry } = require("./localToolApproval.cjs");
// Main-issued, single-use approval tokens for renderer-invoked risky local
// tools. Approval can only come from a token main minted for the exact tool +
// args — never from a renderer-asserted `approved` flag.
const localApprovals = createLocalApprovalRegistry();
const macFiles = require("./macFiles.cjs");
const localStore = require("./localStore/index.cjs");
const appDock = require("./appDock.cjs");
const chromeSync = require("./chromeSync.cjs");
const { attachAgentBrowser } = require("./agent-browser/host.cjs");
const { buildDiagnosticsReport } = require("./diagnostics.cjs");
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

// Auth host allowlists and handoff-port constants live with their logic in
// electron/auth/desktopAuth.cjs.

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





// Loopback auth handoff server state (the port candidates and the server
// itself live in electron/auth/desktopAuth.cjs; these locals back the shared
// d.authHandoffServer / d.authHandoffPort accessors).
/** @type {import('node:http').Server | null} */
let authHandoffServer = null;
// 0 until listen() succeeds — mintDesktopAuthUrl only advertises a port we own.
let authHandoffPort = 0;









// Windows (and Linux) deliver lykn:// URLs via process argv — cold start and
// second-instance. Scan an argv-like list for the first lykn: URL.


/** Best-effort: make Launch Services prefer LYKN.app for lykn:// (macOS). */

// Claim lykn:// for desktop OAuth return. Packaged builds also declare the
// scheme via electron-builder "protocols".
//
// CRITICAL (macOS + unpackaged): never call setAsDefaultProtocolClient here.
// It registers node_modules Electron.app (com.github.Electron), Launch Services
// relaunches that binary with no main script, and the user sees Electron's
// default "path-to-app" page instead of LYKN. Same reason we refuse to register
// login items while unpackaged.

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


/** Bring Dock + main window forward so a modal update dialog can actually appear. */


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

// Menu-bar-app dock behaviour: the Dock icon appears only while the main
// window is VISIBLE; with just the tray + hotkey running (main window hidden
// but still alive as the auth keeper) we stay out of the Dock and the
// ⌘-Tab switcher like any other background companion.
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


// ── LYKN Studio ──────────────────────────────────────────────────────────────
// Studio IS the main window (vibrancy + `/studio?glass=1`). These helpers
// stay so older IPC (`lykn:studio-set`, browser dock) keeps working without
// opening a second window.

// Studio fullscreen: simple fullscreen on macOS (fills the screen with no
// separate Space), plain native fullscreen elsewhere.




// Runs `then` once the window is out of fullscreen — immediately when it
// already is, otherwise after macOS's animated exit lands (hiding or
// minimizing a fullscreen window mid-animation gets ignored).


// Grant the renderer the permissions the web app already uses (microphone for
// voice mode, etc.) but only for our own origin. Everything else is denied.

// Enable system ("loopback") audio capture for the overlay's live-listen mode.
// When the overlay calls navigator.mediaDevices.getDisplayMedia({audio:true}),
// this handler hands back a screen video source plus loopback audio:
//   • Windows — Chromium loopback (supported natively)
//   • macOS 13+ — ScreenCaptureKit path in Electron (no virtual device)
// The overlay only uses the audio track (to transcribe meetings/conversations).

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

/** Approximate a rounded rect as 1px scanlines for win.setShape (Win/Linux). */

/** Clip floating glass HWND to CSS radius so Win11 can't paint square corner stubs. */

/** Re-assert transparent glass chrome after create (some Win11 builds re-enable DWM). */

/** setBounds without animation — animated resizes flicker on Win transparent HWNDs. */

/** Work area for the display that currently holds (or will hold) the glass bar. */


/** True when most of the bar (esp. the bottom/composer) is off the work area. */


/** Unstick click-through + snap a clipped/tiny bar back to bottom-center. */


// Grow/shrink the bar as the answer streams in. By default it stays pinned
// bottom-center; once the user has dragged it, we keep their X and anchor the
// bottom edge so it grows upward in place.
// Collapse the whole panel down to a small LYKN icon "bubble" (and back). The
// bubble stays centered on where the panel was and keeps its bottom edge, so it
// doesn't jump across the screen. While collapsed we ignore height reports.
const OVERLAY_BUBBLE = 54;
let overlayCollapsed = false;


// Size the window to the renderer-reported content. Width varies with side panels;
// we anchor the chat column's left edge so it never shifts when panels open.
// Always keep the BOTTOM (composer / buttons) on-screen — never clip under the dock.



/** Re-key the glass bar for typing after another app (or the agent stage) stole focus. */


// Windows/Linux have no Screen Recording TCC pane — we cache an onboarding
// probe so the walkthrough can show "Test screen capture". Feature gates use
// screenCaptureStatus() which stays allowed unless a probe explicitly failed.
/** @type {"granted"|"denied"|null} */
let screenProbeCache = null;

// Serialize macOS TCC / Automation Allow dialogs so one Glass ask never stacks
// Screen Recording + System Events + N browser prompts at once.
let permissionPromptChain = Promise.resolve();

// Session cache for Apple Events / Automation. macOS has no query API; we learn
// from osascript success / errAEEventNotPermitted (-1743) and avoid re-probing
// denied targets (and stop fanning out to every open browser in one action).
const automationOk = {
  /** @type {null|boolean} */
  systemEvents: null,
  /** @type {Record<string, boolean>} */
  browsers: Object.create(null),
};


// Returns 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'.
// Used to gate overlay asks / live watch — on Windows defaults to allowed.

// Onboarding UI status — Windows starts as not-determined until the user tests.

// Microphone privacy status. Works on macOS + Windows via Chromium.


/**
 * Open System Settings → Screen Recording.
 *
 * macOS only adds LYKN to that list after a real capture/TCC probe. Opening the
 * pane too early (or before TCC has flushed) shows an empty/stale list until the
 * user closes and reopens Settings — so callers should probe first, then pass
 * `{ afterTccRegister: true }` so we wait a beat before opening.
 */

/** Tiny capture so TCC registers LYKN under Screen Recording before Settings opens. */

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


/** @type {BrowserWindow | null} */
let snipWindow = null;
/** @type {((rect: {x:number,y:number,width:number,height:number}|null) => void) | null} */
let snipResolver = null;


// Interactive region select for Windows (and as a mac fallback). Full-screen
// dimmed overlay → drag a rectangle → crop from a fresh primary-display capture.

// Display the overlay (or cursor) is on — so capture / burst cover the screen
// the user is actually looking at, not always the primary (external monitors,
// Sidecar, resolution changes).

// Capture the full target display and return a data URL. Always scales the
// WHOLE screen (never a cropped sub-rectangle). desktopCapturer fails
// ("Failed to get sources") when asked for a very large thumbnail (e.g. full
// Retina resolution), so we try a ladder of decreasing sizes and take the
// first that succeeds — sharp when possible, reliable always. Sizes are based
// on physical pixels (bounds × scaleFactor) so Retina / HiDPI / ultrawide
// Macs still yield a full-frame image.


// ── Summon burst ─────────────────────────────────────────────────────────
// A full-screen, transparent, click-through window that plays a brief color
// wash across the WHOLE screen when the overlay is summoned. No persistent
// outline — capture reads the full display on its own. The window covers the
// display the overlay is on (not always primary) and hides after the anim.


// Stop the summon animation and hide its window. Called after the one-shot
// wash finishes, or immediately when the overlay is dismissed.

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


// Bottom-aligned with the bar, hanging off its right edge (flips to the left
// edge when there's no room on the right).





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


// Bottom-aligned with the bar, hanging off its left edge (flips to the right
// edge when there's no room on the left).





// ── Detached Translate-mode language picker ─────────────────────────────
// Same vibrancy-window pattern as menu/picker: can't hang inside the overlay
// HWND or macOS paints a blurred slab under the list.
// (Layout constants live in windows/overlayConstants.cjs, shared with the
// extracted overlaySatellites module.)
let langPickerWindow = null;
let langPickerHeight = 160;
/** Pill rect relative to the overlay window content (from renderer). */
let langPickerAnchor = null;







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



// Bottom-aligned with the bar, hanging off its right edge (flips to the left
// edge when there's no room on the right).





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



// Bottom-aligned with the bar on its right flank; stacks past the live
// meeting notes card when that's open, and flips left when out of room.









// ── Tray icon ───────────────────────────────────────────────────────────────
// Lives in the macOS menu bar / Windows notification area for as long as the
// app runs (including silent login launches). Click toggles the glass overlay
// chat — same as ⌘/Ctrl+L; right-click opens a small utility menu.
//
// macOS: TEMPLATE image (black + alpha) so the system recolors it.
//   node scripts/generate-tray-icon.mjs
// Windows: colored glyph (template images aren't used in the Win tray).
//   node scripts/generate-windows-icons.mjs


// Strip the hidden control tags the chat models emit so they never leak into
// the overlay bubble (the web app strips these too, server-side prompt aside).

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


/** Classify a vault attachment for Glass view mode (image / html / video / other). */

/** In-memory HTML for lykn-artifact:// iframe previews in Glass. */



/** Fetch media bytes; allow our own API/localhost (file-proxy in dev). */

// macOS share sheet: AirDrop / Photos / Mail want a file, not a signed link.
// Pull the asset into a temp folder once per URL and hand the path to the
// sharing item. Files live in the OS temp dir, so cleanup is the OS's job.





/**
 * HTML artifacts must NOT use raw Supabase signed URLs in an iframe (wrong
 * MIME / frame-ancestors → blank). Prefer a public file-proxy URL; in local
 * API / private-proxy cases, fetch the HTML in main and serve via lykn-artifact://.
 */

/** Fresh signed / file-proxy URL so Glass can iframe/img vault media. */


/**
 * Build Glass view-mode markers from lykn_loadNeuron / lykn_loadNeurons.
 * Vault images → md-img, HTML → lykn_artifact iframe, else Open card.
 * Also seeds lastOverlayReactArtifact when an editable React source is found.
 */

// While streaming, a control tag can arrive split across deltas. Trim any
// unfinished "[[..." tail so raw markup never flashes in the bubble.



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

// (READ_SUPABASE_TOKEN_JS / HAS_SUPABASE_SESSION_JS live with their callers in
// electron/auth/desktopAuth.cjs.)

let cachedAuthToken = null;
let cachedAuthTokenExpMs = 0;
/** @type {Promise<string | null> | null} */
let hiddenAuthReadPromise = null;
/** @type {BrowserWindow | null} */
// Persistent hidden window that keeps the web app's Supabase client alive
// when there's no main window (login-item launch, or main window crashed).
// Same default session / localStorage as the main window — just never shown.
let authKeeperWindow = null;




// Ask the web app's own Supabase client (installAuthFetch exposes
// window.__lyknGetFreshToken) to refresh and hand back a valid access token.
// This is the only reliable way to recover from an EXPIRED token in storage:
// the renderer owns the rotating refresh token, so refreshing must happen
// through its client, not by re-reading localStorage from out here.

// True when a JWT is missing its expiry or expires within `marginMs`.

// Prefer the (possibly hidden) main window; otherwise the dedicated auth
// keeper. Both share the default session and keep backgroundThrottling off
// so Supabase's refresh timer keeps firing.

// Keep a hidden lykn.io window alive whenever there's no main window, so
// login-item launches (and crash recovery) still have a live Supabase client
// for Glass asks. Idempotent.


// Read + optionally refresh through a live auth webContents. Returns null when
// the window has no session (signed out) so the caller can drop the cache.

// Boot (or reuse) a hidden window on the shared default session to refresh
// the stored Supabase session. Kept around as the auth keeper afterwards so
// the next ask doesn't pay another cold boot. Deduplicated across parallel
// overlay asks.


// ── Overlay settings (small, synchronous JSON store) ───────────────────────
// Persists user toggles that must be known the instant the window is created
// (before any async IPC), so we read/write it synchronously. Currently holds
// `contentProtection` — whether the overlay is excluded from screen capture.




// ── Launch at login ─────────────────────────────────────────────────────────
// LYKN is a background companion: it must already be running for ⌘+L to work,
// so the packaged app registers itself as a login item on first run. We only
// auto-enable ONCE (marker in overlay settings) — if the user later disables
// LYKN in System Settings › Login Items, we respect that and never re-add it.




// True when macOS launched us at login (SMAppService). In that case we start
// silently in the background — no main window — and just arm the ⌘+L hotkey.

// Default ON: the overlay stays out of the user's own screen recordings/shares
// unless they explicitly turn it off.

// Apply the current content-protection setting to every capture-excludable
// window. Safe to call repeatedly (we re-assert it on show).

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




































// Normalize a URL to a stable "page key" so we can recognize when the user is
// back on the same page across sessions. Drops protocol, www, query, hash, and
// trailing slashes — host + path is a good balance between "same page" and not
// over-merging different articles on one site.

// Find earlier ⌘L conversations that happened on the same page (matched by
// normalized URL) and format the most recent excerpts. Lets the overlay AI
// remember what it already discussed when the user returns to a page.


// Mirror an overlay conversation into the app's durable chat store so it shows
// up in the actual app's "previous chats" alongside chats started in-app. The
// overlay sessionId is already a UUID, so it doubles as the lykn_chats row id —
// repeated saves of the same conversation upsert the same row. Best-effort.

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
// Shared AppleScript browser scrape. Used by overlay ask, live watch, and
// browser-execute. Left here because extracting it requires a brace-safe
// splitter (destructured params + regex literals) and it is shared with the
// Agent Harness browser-execute path.

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






/**
 * Try at most one not-yet-denied browser for a URL in this action.
 * Prevents Chrome + Safari + Arc each showing their own Allow dialog at once.
 * Known-allowed browsers may be checked without a new dialog; only one unknown
 * browser may prompt per call.
 */



// Prefer the Chrome Live Feed extension (works on macOS + Windows). Fall back
// to AppleScript tab discovery on macOS when the extension isn't connected.

// Run a small JS snippet in the active browser tab via AppleScript.
// Snippet must NOT contain double quotes or backslashes (AppleScript-safe).

// Read LIVE rendered text from the active tab. Extension bridge first (cross-
// platform); AppleScript JS injection on macOS as fallback.
// Returns "title\n<body text>" or null.

// Decode base64 JSON payloads from browser JS (same pattern as browserAct).

// Flattened full-document text as base64 JSON — avoids osascript truncating
// multiline return values (the bug behind ~400-char "full page" scrapes).
// No double quotes or backslashes — AppleScript-safe (same rule as browserAct).



// Full-page TEXT read of the open tab — no scrolling, no screenshots.
// Page copy is usually already in the DOM (lazy hooks only gate animations /
// heavy demos). Base64 return avoids osascript truncating multiline text.
// HTTP fetch still can't replace this for SPA shells (empty #root).



/**
 * If the user asks about another page on the same site (Download, Pricing…),
 * resolve an absolute URL. Uses recent chat history for short "check it" follow-ups.
 */


// Fetch a web page and extract its readable text. Best-effort HTML→text with no
// dependencies: drop scripts/styles/nav chrome, prefer <article>/<main> content,
// strip tags, decode entities, collapse whitespace, and cap the length.

// Pull the YouTube video id from a watch / youtu.be / shorts / embed URL.

// Fetch the transcript from INSIDE the user's tab. YouTube now binds timedtext
// URLs to the originating session/IP, so a server fetch returns empty — but an
// in-page fetch uses the user's own session and works. AppleScript can't await a
// promise, so we kick off the fetch (stashing the result on window.__lyknYT) and
// then poll for it.

// Parse YouTube timedtext payloads — json3 (preferred) or legacy XML.

/** Explicit ask to spend Whisper on video audio — not ordinary "what's this about?". */

// Captions-only by default (in-tab → timedtext → API fast). Whisper is slow and
// opt-in — only when the user explicitly asks to transcribe.

// Fetch a YouTube video's caption transcript. Tries the in-page method first
// (reliable, uses the user's session), then a local timedtext fetch, then the
// LYKN backend captions path. Whisper only when allowWhisper is set.

let overlayAskGeneration = 0;
let overlayAskAbort = null;
// The LYKN project the user is currently working in, sniffed from the active
// browser tab's URL (…/projects/<uuid>). We remember the last one seen so a
// conversational follow-up ("add a task", "put that on my calendar") — which
// deliberately skips the page scrape for speed — still scopes its writes to
// the project the user was just looking at, instead of landing unfiled.
let overlayActiveProjectId = null;



// Pull a LYKN project UUID out of a workspace URL like
// "https://lykn.io/projects/<uuid>" or "http://localhost:5174/projects/<uuid>".
// Returns null for any other page (vault, settings, non-LYKN sites).



/** Turn a non-OK /api/ai/* response into an Error with a useful message. */

/** Glass: only render vault Open/image cards when the user asked for saved stuff. */



// Much NARROWER than overlayMessageLooksScreenRelated (which is broad on
// purpose for the "don't skip the screen" decision): this matches only when
// the message clearly needs the actual PIXELS — the user is asking what we
// can see, or asking to be pointed at / walked through something in the UI
// in front of them. Used to force the screenshot back on for text-rich pages,
// which otherwise go text-only for speed — without a screenshot the model
// can't answer visual / layout questions.


// Short deictic follow-ups mid-chat ("what about this?", "and that one?")
// usually point at the screen after a UI change — keep pixels, don't go text-only.




// Site-wide / beyond-viewport asks: the screenshot (and often the live DOM) only
// covers what's on screen. These need a full-page fetch of the open tab URL —
// never "paste the link" or "scroll down" when we already know the URL.

// Last successfully scraped Glass tab — used when a follow-up needs the URL
// even if the live browser target briefly fails to resolve.
let lastOverlayPageUrl = "";
let lastOverlayPageTitle = "";

// Pull the live page/video the user is looking at, plus any earlier ⌘L
// conversation about that same page. Factored out of streamScreenAnswer so it can
// run CONCURRENTLY with the screenshot + auth fetch (it was the slowest serial
// step). Returns best-effort; never throws.

// Overlay ask pipeline. Deferred from this pass: the function signature uses
// a destructured parameter object, and a naive brace matcher truncates it.

// Capture the current screen and ask the vision model for a short text
// description. Voice Mode can't receive images, so we feed this summary into the
// live agent as contextual text — giving voice the same "sees your screen"
// ability the typed overlay chat has.

// Persist raw bytes to the vault via /api/vault/save-file. Best-effort.

// Fetch a generated artifact URL and persist it to the vault. Used when the
// overlay finishes an image / React build / video tool so artifacts land in
// the vault without requiring a manual Download click. Best-effort.

/** Pick the best downloadable URL from a capability tool result. */


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


/* ------------------------------------------------------------------ */
/*  First-run setup — guide the user through the two permissions LYKN   */
/*  needs (Screen Recording + "Allow JavaScript from Apple Events").    */
/* ------------------------------------------------------------------ */




/* ------------------------------------------------------------------ */
/*  First-launch welcome splash — a floating glass panel playing the    */
/*  Remotion logo reveal (alpha webm) over native vibrancy. Shows once, */
/*  then never again (marker file). LYKN_FORCE_WELCOME=1 replays it.    */
/* ------------------------------------------------------------------ */




/** Password is held only until the welcome verification completes. */
let welcomeSignupSecret = null;






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
  const deepLink = d.findLyknUrlInArgv(commandLine);
  if (deepLink) {
    d.handleAuthDeepLink(deepLink);
    return;
  }
  // Re-opening LYKN while it's already running in the background (e.g. after
  // a silent login launch) should surface the main window, not do nothing.
  // (Unless the first-launch walkthrough is still on screen.)
  if (!mainWindow || mainWindow.isDestroyed()) {
    d.createMainWindow();
  } else if (!welcomeGateActive) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  // User deliberately re-opened the app — good moment to surface a pending update.
  void d.maybePromptPendingUpdate({ force: Boolean(pendingUpdate) });
});

// Silent background auto-update via GitHub Releases (electron-updater). Only
// runs in the packaged app — in dev there's no update feed. Downloads new
// versions in the background and, once ready, offers a one-click restart.
//
// Menu-bar mode: the Dock is often hidden and there may be no main window
// (login launch / always-on Mac mini). A parentless dialog is easy to miss,
// so we surface Dock + window, parent the dialog, fire a Notification, keep a
// tray "Restart to Update" item, and re-prompt on activate / resume.

const d = {
  electron: {
    app, BrowserWindow, WebContentsView, shell, globalShortcut, Menu, ipcMain,
    desktopCapturer, screen, systemPreferences, dialog, nativeImage, clipboard,
    Tray, session, Notification, powerMonitor, nativeTheme, protocol,
    net: electronNet,
  },
  node: {
    path,
    url: require("node:url"),
    fs,
    fsSync,
    crypto,
    http,
    childProcess: require("node:child_process"),
  },
  env: { IS_MAC, IS_WIN, GLASS_FALLBACK, APP_URL, APP_ORIGIN, API_BASE },
  constants: overlayConstants,
  ipcMain,
  app,
  safeFetchMain,
  assertPublicHttpUrl,
  openExternalSafe,
};

attachDesktopAuth(d);

function bindShellContext() {
  d.localStore = localStore;
  d.macFiles = macFiles;
  d.chromeSync = chromeSync;
  d.localSystem = localSystem;
  d.appDock = appDock;
  d.localApprovals = localApprovals;
  d.ownedBrowserAct = ownedBrowserAct;
  d.agentRecentVisits = agentRecentVisits;
  d.OVERLAY_IGNORE_NOTE = OVERLAY_IGNORE_NOTE;
  d.OVERLAY_REDESIGN_INTENT_RE = OVERLAY_REDESIGN_INTENT_RE;
  attachDesktopAuth(d);
  attachAutoUpdate(d);
  attachGlassChrome(d);
  attachOverlayFamily(d);
  attachScreenCapture(d);
  attachOverlaySatellites(d);
  attachMainStudio(d);
  attachTray(d);
  attachOverlaySettings(d);
  attachLiveWatch(d);
  attachOverlaySessions(d);
  attachBrowserAutomation(d);
  attachAskPipeline(d);
  attachWelcomeOnboarding(d);
  attachAgentBrowser(d);
  Object.defineProperty(d, "pendingAuthTokens", { enumerable: true, get: () => pendingAuthTokens, set: (v) => { pendingAuthTokens = v; } });
  Object.defineProperty(d, "pendingDesktopAuthState", { enumerable: true, get: () => pendingDesktopAuthState, set: (v) => { pendingDesktopAuthState = v; } });
  Object.defineProperty(d, "lastAcceptedAuthHandoff", { enumerable: true, get: () => lastAcceptedAuthHandoff, set: (v) => { lastAcceptedAuthHandoff = v; } });
  Object.defineProperty(d, "authHandoffServer", { enumerable: true, get: () => authHandoffServer, set: (v) => { authHandoffServer = v; } });
  Object.defineProperty(d, "authHandoffPort", { enumerable: true, get: () => authHandoffPort, set: (v) => { authHandoffPort = v; } });
  Object.defineProperty(d, "mainWindow", { enumerable: true, get: () => mainWindow, set: (v) => { mainWindow = v; } });
  Object.defineProperty(d, "studioWindow", { enumerable: true, get: () => studioWindow, set: (v) => { studioWindow = v; } });
  Object.defineProperty(d, "overlayWindow", { enumerable: true, get: () => overlayWindow, set: (v) => { overlayWindow = v; } });
  Object.defineProperty(d, "burstWindow", { enumerable: true, get: () => burstWindow, set: (v) => { burstWindow = v; } });
  Object.defineProperty(d, "burstHideTimer", { enumerable: true, get: () => burstHideTimer, set: (v) => { burstHideTimer = v; } });
  Object.defineProperty(d, "burstWindowWarmed", { enumerable: true, get: () => burstWindowWarmed, set: (v) => { burstWindowWarmed = v; } });
  Object.defineProperty(d, "tray", { enumerable: true, get: () => tray, set: (v) => { tray = v; } });
  Object.defineProperty(d, "allowQuit", { enumerable: true, get: () => allowQuit, set: (v) => { allowQuit = v; } });
  Object.defineProperty(d, "pendingUpdate", { enumerable: true, get: () => pendingUpdate, set: (v) => { pendingUpdate = v; } });
  Object.defineProperty(d, "installPendingUpdate", { enumerable: true, get: () => installPendingUpdate, set: (v) => { installPendingUpdate = v; } });
  Object.defineProperty(d, "updatePromptOpen", { enumerable: true, get: () => updatePromptOpen, set: (v) => { updatePromptOpen = v; } });
  Object.defineProperty(d, "lastUpdatePromptAt", { enumerable: true, get: () => lastUpdatePromptAt, set: (v) => { lastUpdatePromptAt = v; } });
  Object.defineProperty(d, "updateNotifiedForVersion", { enumerable: true, get: () => updateNotifiedForVersion, set: (v) => { updateNotifiedForVersion = v; } });
  Object.defineProperty(d, "browserExecuteInFlight", { enumerable: true, get: () => browserExecuteInFlight, set: (v) => { browserExecuteInFlight = v; } });
  Object.defineProperty(d, "onboardingWindow", { enumerable: true, get: () => onboardingWindow, set: (v) => { onboardingWindow = v; } });
  Object.defineProperty(d, "extensionInstallWindow", { enumerable: true, get: () => extensionInstallWindow, set: (v) => { extensionInstallWindow = v; } });
  Object.defineProperty(d, "welcomeWindow", { enumerable: true, get: () => welcomeWindow, set: (v) => { welcomeWindow = v; } });
  Object.defineProperty(d, "welcomeGateActive", { enumerable: true, get: () => welcomeGateActive, set: (v) => { welcomeGateActive = v; } });
  Object.defineProperty(d, "welcomeStudioPreloaded", { enumerable: true, get: () => welcomeStudioPreloaded, set: (v) => { welcomeStudioPreloaded = v; } });
  Object.defineProperty(d, "overlayVisibleBeforeExtensionInstall", { enumerable: true, get: () => overlayVisibleBeforeExtensionInstall, set: (v) => { overlayVisibleBeforeExtensionInstall = v; } });
  Object.defineProperty(d, "overlayUserPositioned", { enumerable: true, get: () => overlayUserPositioned, set: (v) => { overlayUserPositioned = v; } });
  Object.defineProperty(d, "overlayAnchorLeft", { enumerable: true, get: () => overlayAnchorLeft, set: (v) => { overlayAnchorLeft = v; } });
  Object.defineProperty(d, "overlayAnchorBottomY", { enumerable: true, get: () => overlayAnchorBottomY, set: (v) => { overlayAnchorBottomY = v; } });
  Object.defineProperty(d, "overlayProgrammaticMove", { enumerable: true, get: () => overlayProgrammaticMove, set: (v) => { overlayProgrammaticMove = v; } });
  Object.defineProperty(d, "mainWindowDeferred", { enumerable: true, get: () => mainWindowDeferred, set: (v) => { mainWindowDeferred = v; } });
  Object.defineProperty(d, "overlayCollapsed", { enumerable: true, get: () => overlayCollapsed, set: (v) => { overlayCollapsed = v; } });
  Object.defineProperty(d, "screenProbeCache", { enumerable: true, get: () => screenProbeCache, set: (v) => { screenProbeCache = v; } });
  Object.defineProperty(d, "permissionPromptChain", { enumerable: true, get: () => permissionPromptChain, set: (v) => { permissionPromptChain = v; } });
  Object.defineProperty(d, "snipWindow", { enumerable: true, get: () => snipWindow, set: (v) => { snipWindow = v; } });
  Object.defineProperty(d, "snipResolver", { enumerable: true, get: () => snipResolver, set: (v) => { snipResolver = v; } });
  Object.defineProperty(d, "menuWindow", { enumerable: true, get: () => menuWindow, set: (v) => { menuWindow = v; } });
  Object.defineProperty(d, "menuHeight", { enumerable: true, get: () => menuHeight, set: (v) => { menuHeight = v; } });
  Object.defineProperty(d, "pickerWindow", { enumerable: true, get: () => pickerWindow, set: (v) => { pickerWindow = v; } });
  Object.defineProperty(d, "pickerHeight", { enumerable: true, get: () => pickerHeight, set: (v) => { pickerHeight = v; } });
  Object.defineProperty(d, "langPickerWindow", { enumerable: true, get: () => langPickerWindow, set: (v) => { langPickerWindow = v; } });
  Object.defineProperty(d, "langPickerHeight", { enumerable: true, get: () => langPickerHeight, set: (v) => { langPickerHeight = v; } });
  Object.defineProperty(d, "langPickerAnchor", { enumerable: true, get: () => langPickerAnchor, set: (v) => { langPickerAnchor = v; } });
  Object.defineProperty(d, "liveWindow", { enumerable: true, get: () => liveWindow, set: (v) => { liveWindow = v; } });
  Object.defineProperty(d, "lastLiveState", { enumerable: true, get: () => lastLiveState, set: (v) => { lastLiveState = v; } });
  Object.defineProperty(d, "liveCardOpen", { enumerable: true, get: () => liveCardOpen, set: (v) => { liveCardOpen = v; } });
  Object.defineProperty(d, "panelWindow", { enumerable: true, get: () => panelWindow, set: (v) => { panelWindow = v; } });
  Object.defineProperty(d, "panelWidth", { enumerable: true, get: () => panelWidth, set: (v) => { panelWidth = v; } });
  Object.defineProperty(d, "panelHeight", { enumerable: true, get: () => panelHeight, set: (v) => { panelHeight = v; } });
  Object.defineProperty(d, "lastPanelState", { enumerable: true, get: () => lastPanelState, set: (v) => { lastPanelState = v; } });
  Object.defineProperty(d, "panelCardOpen", { enumerable: true, get: () => panelCardOpen, set: (v) => { panelCardOpen = v; } });
  Object.defineProperty(d, "lastOverlayReactArtifact", { enumerable: true, get: () => lastOverlayReactArtifact, set: (v) => { lastOverlayReactArtifact = v; } });
  Object.defineProperty(d, "lastOverlayVaultImage", { enumerable: true, get: () => lastOverlayVaultImage, set: (v) => { lastOverlayVaultImage = v; } });
  Object.defineProperty(d, "lastOverlayPageFingerprint", { enumerable: true, get: () => lastOverlayPageFingerprint, set: (v) => { lastOverlayPageFingerprint = v; } });
  Object.defineProperty(d, "cachedAuthToken", { enumerable: true, get: () => cachedAuthToken, set: (v) => { cachedAuthToken = v; } });
  Object.defineProperty(d, "cachedAuthTokenExpMs", { enumerable: true, get: () => cachedAuthTokenExpMs, set: (v) => { cachedAuthTokenExpMs = v; } });
  Object.defineProperty(d, "hiddenAuthReadPromise", { enumerable: true, get: () => hiddenAuthReadPromise, set: (v) => { hiddenAuthReadPromise = v; } });
  Object.defineProperty(d, "authKeeperWindow", { enumerable: true, get: () => authKeeperWindow, set: (v) => { authKeeperWindow = v; } });
  Object.defineProperty(d, "liveWatchTimer", { enumerable: true, get: () => liveWatchTimer, set: (v) => { liveWatchTimer = v; } });
  Object.defineProperty(d, "liveWatchCaptureInFlight", { enumerable: true, get: () => liveWatchCaptureInFlight, set: (v) => { liveWatchCaptureInFlight = v; } });
  Object.defineProperty(d, "liveWatchVisionInFlight", { enumerable: true, get: () => liveWatchVisionInFlight, set: (v) => { liveWatchVisionInFlight = v; } });
  Object.defineProperty(d, "liveWatchLastFingerprint", { enumerable: true, get: () => liveWatchLastFingerprint, set: (v) => { liveWatchLastFingerprint = v; } });
  Object.defineProperty(d, "liveWatchLastFrameUrl", { enumerable: true, get: () => liveWatchLastFrameUrl, set: (v) => { liveWatchLastFrameUrl = v; } });
  Object.defineProperty(d, "liveWatchLastVisionAt", { enumerable: true, get: () => liveWatchLastVisionAt, set: (v) => { liveWatchLastVisionAt = v; } });
  Object.defineProperty(d, "liveWatchBurstUntil", { enumerable: true, get: () => liveWatchBurstUntil, set: (v) => { liveWatchBurstUntil = v; } });
  Object.defineProperty(d, "liveWatchForceVision", { enumerable: true, get: () => liveWatchForceVision, set: (v) => { liveWatchForceVision = v; } });
  Object.defineProperty(d, "liveWatchState", { enumerable: true, get: () => liveWatchState, set: (v) => { liveWatchState = v; } });
  Object.defineProperty(d, "liveWatchTextInFlight", { enumerable: true, get: () => liveWatchTextInFlight, set: (v) => { liveWatchTextInFlight = v; } });
  Object.defineProperty(d, "liveWatchForceTextPass", { enumerable: true, get: () => liveWatchForceTextPass, set: (v) => { liveWatchForceTextPass = v; } });
  Object.defineProperty(d, "liveWatchPendingTextPass", { enumerable: true, get: () => liveWatchPendingTextPass, set: (v) => { liveWatchPendingTextPass = v; } });
  Object.defineProperty(d, "liveWatchLastPageText", { enumerable: true, get: () => liveWatchLastPageText, set: (v) => { liveWatchLastPageText = v; } });
  Object.defineProperty(d, "liveWatchLastPageSig", { enumerable: true, get: () => liveWatchLastPageSig, set: (v) => { liveWatchLastPageSig = v; } });
  Object.defineProperty(d, "liveWatchLastPageUrl", { enumerable: true, get: () => liveWatchLastPageUrl, set: (v) => { liveWatchLastPageUrl = v; } });
  Object.defineProperty(d, "liveWatchLastScrapeAt", { enumerable: true, get: () => liveWatchLastScrapeAt, set: (v) => { liveWatchLastScrapeAt = v; } });
  Object.defineProperty(d, "extensionBridge", { enumerable: true, get: () => extensionBridge, set: (v) => { extensionBridge = v; } });
  Object.defineProperty(d, "liveWatchLastRuleCheckAt", { enumerable: true, get: () => liveWatchLastRuleCheckAt, set: (v) => { liveWatchLastRuleCheckAt = v; } });
  Object.defineProperty(d, "liveWatchSettleUntil", { enumerable: true, get: () => liveWatchSettleUntil, set: (v) => { liveWatchSettleUntil = v; } });
  Object.defineProperty(d, "liveWatchPendingNavVision", { enumerable: true, get: () => liveWatchPendingNavVision, set: (v) => { liveWatchPendingNavVision = v; } });
  Object.defineProperty(d, "liveWatchConsecutiveBurstFrames", { enumerable: true, get: () => liveWatchConsecutiveBurstFrames, set: (v) => { liveWatchConsecutiveBurstFrames = v; } });
  Object.defineProperty(d, "overlayAskGeneration", { enumerable: true, get: () => overlayAskGeneration, set: (v) => { overlayAskGeneration = v; } });
  Object.defineProperty(d, "overlayAskAbort", { enumerable: true, get: () => overlayAskAbort, set: (v) => { overlayAskAbort = v; } });
  Object.defineProperty(d, "overlayActiveProjectId", { enumerable: true, get: () => overlayActiveProjectId, set: (v) => { overlayActiveProjectId = v; } });
  Object.defineProperty(d, "lastOverlayPageUrl", { enumerable: true, get: () => lastOverlayPageUrl, set: (v) => { lastOverlayPageUrl = v; } });
  Object.defineProperty(d, "lastOverlayPageTitle", { enumerable: true, get: () => lastOverlayPageTitle, set: (v) => { lastOverlayPageTitle = v; } });
  Object.defineProperty(d, "welcomeSignupSecret", { enumerable: true, get: () => welcomeSignupSecret, set: (v) => { welcomeSignupSecret = v; } });
  d.toolStatusLabel = toolStatusLabel;
  d.notifyMainProjectsChanged = notifyMainProjectsChanged;
  d.maybeNotifyProjectsChangedFromTool = maybeNotifyProjectsChangedFromTool;
  d.recordTeachEventIfActive = (event) =>
    d.teachService?.session?.active
      ? d.teachService.record(event)
      : { accepted: false, reason: "no_active_teach_session" };
  d.IMAGE_MIME_BY_EXT = IMAGE_MIME_BY_EXT;
  d.TEXT_FILE_RE = TEXT_FILE_RE;
  d.BROWSER_APP_NAMES = BROWSER_APP_NAMES;
  d.BROWSER_PICK_PRIORITY = BROWSER_PICK_PRIORITY;
  d.DEPRIORITIZED_BROWSERS = DEPRIORITIZED_BROWSERS;
  d.automationOk = automationOk;
  d.agentRecentVisits = agentRecentVisits;
  d.localStore = localStore;
  d.macFiles = macFiles;
  d.chromeSync = chromeSync;
  d.localSystem = localSystem;
  d.appDock = appDock;
  d.localApprovals = localApprovals;
  d.ownedBrowserAct = ownedBrowserAct;
}

function createCoreServices() {
  initializeElectronServices({
    app,
    session,
    localStore,
    localSystem,
    macFiles,
  });
  bindShellContext();
}

function registerArtifactProtocol() {
  // Serve vault HTML artifacts to Glass iframes from memory (see
  // resolveVaultHtmlDisplayUrl). Avoids localhost file-proxy iframe failures.
  try {
    protocol.handle("lykn-artifact", (request) => {
      try {
        const key = new URL(request.url).hostname.replace(/\/$/, "");
        const html = d.artifactHtmlCache.get(key);
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
    console.warn("[main] lykn-artifact protocol:", e?.message || e);
  }
}

function applyShellChrome() {
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
}

function createExecutionRuntimes() {
  // Start the agent list load before anyone can open Browser, so a click
  // doesn't race createAgent against a later restore of leftover workers.
  try {
    d.initAgentRuntime();
  } catch (err) {
    console.warn("[main] agent runtime failed to start:", err?.message || err);
  }
}

function createElectronWindows() {
  // When macOS starts LYKN at login, stay silent in the background: no main
  // window, just the armed ⌘+L hotkey. The dock icon / ⌘+L bring the UI up.
  // Boot a hidden auth keeper so Glass can refresh the stored session without
  // the user opening the main window first.
  const backgroundLaunch = d.launchedAtLogin();
  if (!backgroundLaunch) {
    // Very first launch: the glass welcome walkthrough owns the screen while
    // the app loads hidden behind it, then reveals the Studio when it finishes.
    // Marker-gated so it only ever runs once.
    if (process.env.LYKN_FORCE_WELCOME === "1" || !d.hasSeenWelcomeSplash()) {
      welcomeGateActive = true;
      d.showWelcomeSplash();
    }
    d.createMainWindow();
  } else d.ensureAuthKeeper();
  // Menu-bar icon: present for the whole app lifetime, on every launch mode —
  // it's the always-there affordance for pulling up the overlay chat.
  d.createTray();
  d.createOverlayWindow();
  // Pre-create + warm the full-screen glass/burst window now so the FIRST ⌘+L
  // doesn't hitch while it loads + rasterizes its blurred layers and noise.
  d.createBurstWindow();
}

function registerProcessLifecycle() {
  d.registerGlobalHotkey();
  d.initAutoUpdate();
  if (d.isLiveWatchEnabled()) void d.startLiveWatch();
  d.updateDockVisibility();

  // Bot Routines live for the whole app lifetime (tray-resident included):
  // schedules must fire with no window open.
  d.initRoutineRuntime();

  // Timers don't run while the machine sleeps; on wake, reconcile every
  // schedule against the real clock (missed-run policies) and take one
  // honest observation per active monitor.
  powerMonitor.on("resume", () => {
    try {
      d.routineRuntime?.reconcile("wake");
    } catch (err) {
      console.warn("[main] wake reconcile failed:", err?.message || err);
    }
  });

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
      d.createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    void d.maybePromptPendingUpdate({ force: false });
  });
}

function shutdownServices() {
  d.stopLiveWatch();
  extensionBridge?.stop?.();
  macFiles.closeWatchers();
  globalShortcut.unregisterAll();
  // Stop routine timers/watchers and flush the store synchronously — will-quit
  // cannot await, and routine state must be durable across the restart.
  if (d.routineRuntime) {
    void d.routineRuntime.shutdown();
    d.routineRuntime.store.persistNowSync();
  }
  d.teachService?.shutdown?.();
  // Checkpoints the WAL so the database file on disk is complete on its own —
  // matters for snapshots and for anything the user copies out.
  localStore.shutdown();
}

app.whenReady().then(() => {
  createCoreServices();
  registerArtifactProtocol();
  applyShellChrome();

  d.claimLyknProtocol();
  d.startAuthHandoffServer();
  createExecutionRuntimes();

  d.installPermissionHandler();
  d.setupSystemAudioCapture();
  d.buildAppMenu();
  registerAllIpc(d);
  extensionBridge = startExtensionBridge({
    userDataPath: app.getPath("userData"),
    onUpdate: () => {
      d.liveWatchState.extensionConnected = !!extensionBridge?.isConnected?.();
      d.writeOverlaySettings({ chromeLiveFeedLinked: true });
      d.notifyLiveWatchUpdate();
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
  d.setupLaunchAtLogin();
  createElectronWindows();
  registerProcessLifecycle();
});

// ⌘Q / Alt+F4 / app.quit() → dismiss the windows but stay resident in the
// tray, so the tray icon and ⌘/Ctrl+L keep working. Real exits (tray/app-menu
// "Quit LYKN Completely", update install, OS shutdown) set allowQuit first.
app.on("before-quit", (event) => {
  if (allowQuit) return;
  event.preventDefault();
  try {
    if (overlayWindow && overlayWindow.isVisible()) d.hideOverlay();
  } catch (_) { /* keep going */ }
  // Hide the main window — do NOT destroy it. Destroying drops the live
  // Supabase session client and the next Glass ask 401s with "session
  // expired" until the user reopens the window and signs in again.
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  } catch (_) { /* keep going */ }
  d.updateDockVisibility();
});

app.on("will-quit", () => {
  shutdownServices();
});

app.on("window-all-closed", () => {
  // Tray app on every platform: stay alive so the hotkey + tray keep working.
  // Real exits go through quitForReal() / allowQuit.
});
