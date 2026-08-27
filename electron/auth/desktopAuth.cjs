"use strict";

function attachDesktopAuth(d) {
  if (d.__attached_attachDesktopAuth) return;
  d.__attached_attachDesktopAuth = true;
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
  const createMainWindow = (...a) => d.createMainWindow(...a);

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

  const DESKTOP_AUTH_STATE_TTL_MS = 15 * 60 * 1000;

  // Loopback auth handoff: after Google finishes in the system browser,
  // /desktop-auth POSTs tokens to 127.0.0.1 so the Mac app can sign in without
  // requiring a click on "Open LYKN". lykn://auth remains a manual fallback.
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

  const LYKN_PROTOCOL = "lykn";
  const LYKN_BUNDLE_ID = "ai.lykn.desktop";

  // Reads the Supabase access token straight from the web app's localStorage.
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

function desktopAuthStatePath() {
  return path.join(app.getPath("userData"), "pending-desktop-auth-state.json");
}

function persistDesktopAuthState(record) {
  d.pendingDesktopAuthState = record;
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
  if (d.pendingDesktopAuthState && d.pendingDesktopAuthState.expiresAt > Date.now()) {
    return d.pendingDesktopAuthState;
  }
  try {
    const raw = fsSync.readFileSync(desktopAuthStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.state && parsed.expiresAt > Date.now()) {
      d.pendingDesktopAuthState = parsed;
      return parsed;
    }
  } catch {
    /* none */
  }
  d.pendingDesktopAuthState = null;
  return null;
}

function clearDesktopAuthState() {
  d.pendingDesktopAuthState = null;
  try {
    fsSync.unlinkSync(desktopAuthStatePath());
  } catch {
    /* ignore */
  }
}

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
    d.lastAcceptedAuthHandoff &&
      d.lastAcceptedAuthHandoff.expiresAt > Date.now() &&
      d.lastAcceptedAuthHandoff.access_token === access_token &&
      d.lastAcceptedAuthHandoff.refresh_token === refresh_token,
  );
}

function deliverAuthTokensToRenderer(access_token, refresh_token) {
  d.pendingAuthTokens = { access_token, refresh_token };
  if (!app.isReady()) return;
  if (!d.mainWindow || d.mainWindow.isDestroyed()) {
    createMainWindow();
  } else if (d.welcomeGateActive) {
    // First-launch walkthrough owns the screen: hand the session to the
    // hidden window but let the walkthrough decide when to reveal it.
    flushPendingAuthTokens();
    // Google round-trips through the system browser — tell the walkthrough
    // the session landed so it can advance, and take the screen back.
    if (d.welcomeWindow && !d.welcomeWindow.isDestroyed()) {
      d.welcomeWindow.webContents.send("lykn:welcome-google-signed-in");
      d.welcomeWindow.show();
      d.welcomeWindow.focus();
    }
  } else {
    if (d.mainWindow.isMinimized()) d.mainWindow.restore();
    d.mainWindow.show();
    d.mainWindow.focus();
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
    d.lastAcceptedAuthHandoff = {
      access_token,
      refresh_token,
      expiresAt: Date.now() + DESKTOP_AUTH_STATE_TTL_MS,
    };
  }
  deliverAuthTokensToRenderer(access_token, refresh_token);
  return { ok: true };
}

function startAuthHandoffServer(attempt = 0) {
  if (d.authHandoffServer) return;
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
      d.authHandoffServer = null;
      d.authHandoffPort = 0;
      if (!bound && err?.code === "EADDRINUSE") {
        startAuthHandoffServer(attempt + 1);
        return;
      }
      console.warn("[auth] localhost handoff server error:", err?.message || err);
    });
    server.listen(port, "127.0.0.1", () => {
      bound = true;
      d.authHandoffPort = port;
      console.log(`[auth] localhost handoff listening on http://127.0.0.1:${port}/auth-handoff`);
    });
    d.authHandoffServer = server;
  } catch (err) {
    console.warn("[auth] failed to start localhost handoff server:", err?.message || err);
    d.authHandoffServer = null;
    d.authHandoffPort = 0;
  }
}

function mintDesktopAuthUrl(baseUrl) {
  // The instance that blocked us at launch may have quit since — try again so
  // this round-trip can use loopback instead of the lykn:// fallback.
  if (!d.authHandoffPort) startAuthHandoffServer();
  const state = crypto.randomBytes(24).toString("base64url");
  // New Google round-trip — don't accept replays from a prior attempt.
  d.lastAcceptedAuthHandoff = null;
  persistDesktopAuthState({ state, expiresAt: Date.now() + DESKTOP_AUTH_STATE_TTL_MS });
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("desktop_state", state);
    // Prefer loopback POST so /desktop-auth can auto-handoff without a click.
    // lykn://auth stays available as the Open LYKN button fallback.
    if (d.authHandoffPort) u.searchParams.set("handoff_port", String(d.authHandoffPort));
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function flushPendingAuthTokens() {
  if (!d.pendingAuthTokens) return;
  if (!d.mainWindow || d.mainWindow.isDestroyed()) return;
  const wc = d.mainWindow.webContents;
  if (wc.isLoading()) return; // did-finish-load will re-flush
  wc.send("lykn:auth-tokens", d.pendingAuthTokens);
  d.pendingAuthTokens = null;
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
      if (app.isReady() && d.mainWindow && !d.mainWindow.isDestroyed()) {
        if (d.mainWindow.isMinimized()) d.mainWindow.restore();
        d.mainWindow.show();
        d.mainWindow.focus();
      }
      return;
    }
    // Consume immediately; same-token retries use d.lastAcceptedAuthHandoff.
    clearDesktopAuthState();
    d.lastAcceptedAuthHandoff = {
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

function findLyknUrlInArgv(argv) {
  for (const arg of argv || []) {
    if (typeof arg === "string" && arg.startsWith("lykn:")) return arg;
  }
  return null;
}

function findPackagedLyknApp() {
  const candidates = [
    "/Applications/LYKN.app",
    path.join(ELECTRON_DIR, "../release/mac-universal/LYKN.app"),
    path.join(ELECTRON_DIR, "../release/mac/LYKN.app"),
    path.join(ELECTRON_DIR, "../release/mac-arm64/LYKN.app"),
    path.join(ELECTRON_DIR, "../release/mac-x64/LYKN.app"),
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
  d.cachedAuthToken = token;
  // Unknown expiry → assume 5 minutes so we re-verify soon rather than serve
  // a possibly-dead token for an hour.
  d.cachedAuthTokenExpMs = jwtExpiryMs(token) || Date.now() + 5 * 60 * 1000;
}

async function readTokenFromWebContents(webContents) {
  const raw = await webContents.executeJavaScript(READ_SUPABASE_TOKEN_JS, true);
  return typeof raw === "string" && raw ? raw : null;
}

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

function tokenIsStale(token, marginMs = 60_000) {
  const expMs = jwtExpiryMs(token);
  return !expMs || expMs <= Date.now() + marginMs;
}

function liveAuthWebContents() {
  if (d.mainWindow && !d.mainWindow.isDestroyed()) return d.mainWindow.webContents;
  if (d.authKeeperWindow && !d.authKeeperWindow.isDestroyed()) {
    return d.authKeeperWindow.webContents;
  }
  return null;
}

function ensureAuthKeeper() {
  if (d.mainWindow && !d.mainWindow.isDestroyed()) return;
  if (d.authKeeperWindow && !d.authKeeperWindow.isDestroyed()) return;
  try {
    d.authKeeperWindow = new BrowserWindow({
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
        // Same reason as d.mainWindow: the refresh timer must keep firing.
        backgroundThrottling: false,
      },
    });
    d.authKeeperWindow.loadURL(APP_URL);
    d.authKeeperWindow.on("closed", () => {
      d.authKeeperWindow = null;
    });
  } catch (e) {
    console.warn("[auth-keeper] failed to create:", e?.message || e);
    d.authKeeperWindow = null;
  }
}

function destroyAuthKeeper() {
  try {
    if (d.authKeeperWindow && !d.authKeeperWindow.isDestroyed()) d.authKeeperWindow.destroy();
  } catch (_) { /* ignore */ }
  d.authKeeperWindow = null;
}

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
    d.cachedAuthToken = null;
    d.cachedAuthTokenExpMs = 0;
    return null;
  }
  return null;
}

function readTokenViaHiddenWindow() {
  if (d.hiddenAuthReadPromise) return d.hiddenAuthReadPromise;
  d.hiddenAuthReadPromise = (async () => {
    try {
      ensureAuthKeeper();
      const win = d.authKeeperWindow;
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
      d.hiddenAuthReadPromise = null;
    }
  })();
  return d.hiddenAuthReadPromise;
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
  if (!forceRefresh && d.cachedAuthToken && Date.now() < d.cachedAuthTokenExpMs - 60_000) {
    return d.cachedAuthToken;
  }

  // 3. Ensure an auth keeper exists and refresh through it (login-item
  //    launch, crash recovery, or forceRefresh after a 401 with no live win).
  return readTokenViaHiddenWindow();
}

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleAuthDeepLink(url);
  });
  {
    const cold = findLyknUrlInArgv(process.argv);
    if (cold) handleAuthDeepLink(cold);
  }

  d.acceptAuthHandoffPayload = acceptAuthHandoffPayload;
  d.authHandoffAllowedOrigin = authHandoffAllowedOrigin;
  d.cacheAuthToken = cacheAuthToken;
  d.claimLyknProtocol = claimLyknProtocol;
  d.clearDesktopAuthState = clearDesktopAuthState;
  d.deliverAuthTokensToRenderer = deliverAuthTokensToRenderer;
  d.desktopAuthStatePath = desktopAuthStatePath;
  d.destroyAuthKeeper = destroyAuthKeeper;
  d.ensureAuthKeeper = ensureAuthKeeper;
  d.findLyknUrlInArgv = findLyknUrlInArgv;
  d.findPackagedLyknApp = findPackagedLyknApp;
  d.flushPendingAuthTokens = flushPendingAuthTokens;
  d.getAuthToken = getAuthToken;
  d.handleAuthDeepLink = handleAuthDeepLink;
  d.isAuthNavigation = isAuthNavigation;
  d.isReplayOfLastAuthHandoff = isReplayOfLastAuthHandoff;
  d.jwtExpiryMs = jwtExpiryMs;
  d.liveAuthWebContents = liveAuthWebContents;
  d.loadDesktopAuthState = loadDesktopAuthState;
  d.mintDesktopAuthUrl = mintDesktopAuthUrl;
  d.persistDesktopAuthState = persistDesktopAuthState;
  d.preferPackagedLyknUrlHandler = preferPackagedLyknUrlHandler;
  d.readTokenFromLiveAuth = readTokenFromLiveAuth;
  d.readTokenFromWebContents = readTokenFromWebContents;
  d.readTokenViaHiddenWindow = readTokenViaHiddenWindow;
  d.refreshTokenViaWebContents = refreshTokenViaWebContents;
  d.startAuthHandoffServer = startAuthHandoffServer;
  d.tokenIsStale = tokenIsStale;
}

module.exports = { attachDesktopAuth };
