"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ELECTRON_ROOT = path.resolve(__dirname, "..", "..", "electron");
const overlayConstants = require(path.join(ELECTRON_ROOT, "windows/overlayConstants.cjs"));
const { attachDesktopAuth } = require(path.join(ELECTRON_ROOT, "auth/desktopAuth.cjs"));
const { getBundledExtensionDir } = require(path.join(ELECTRON_ROOT, "extensionInstaller.cjs"));

function read(rel) {
  return fs.readFileSync(path.join(ELECTRON_ROOT, rel), "utf8");
}

function attachAuthHost() {
  const app = {
    on() {},
    isReady: () => false,
    isPackaged: false,
    getPath: () => path.join(process.cwd(), "tmp-auth-host"),
    isDefaultProtocolClient: () => false,
    setAsDefaultProtocolClient() {},
    removeAsDefaultProtocolClient() {},
    focus() {},
  };
  const d = {
    electron: {
      app,
      BrowserWindow: class {},
      WebContentsView: class {},
      shell: {},
      globalShortcut: {},
      Menu: {},
      ipcMain: { handle() {}, on() {} },
      desktopCapturer: {},
      screen: {},
      systemPreferences: {},
      dialog: {},
      nativeImage: {},
      clipboard: {},
      Tray: class {},
      session: {},
      Notification: class {},
      powerMonitor: { on() {} },
      nativeTheme: {},
      protocol: {},
      net: {},
    },
    node: {
      path,
      url: require("node:url"),
      fs: require("node:fs/promises"),
      fsSync: fs,
      crypto: require("node:crypto"),
      http: require("node:http"),
      childProcess: { execFile() {} },
    },
    env: {
      IS_MAC: true,
      IS_WIN: false,
      GLASS_FALLBACK: false,
      APP_URL: "https://lykn.io",
      APP_ORIGIN: "https://lykn.io",
      API_BASE: "https://lykn.io",
    },
    constants: overlayConstants,
    localStore: {},
    macFiles: {},
    chromeSync: {},
    localSystem: {},
    appDock: {},
    localApprovals: {},
    ownedBrowserAct: {},
    agentRecentVisits: {},
    createMainWindow() {},
  };
  attachDesktopAuth(d);
  return d;
}

test("overlay constants export lang picker and agent sidebar sizes", () => {
  assert.equal(overlayConstants.LANG_PICKER_WIDTH, 180);
  assert.equal(overlayConstants.LANG_PICKER_MIN_HEIGHT, 72);
  assert.equal(overlayConstants.LANG_PICKER_MAX_HEIGHT, 180);
  assert.equal(overlayConstants.LANG_PICKER_GAP, 6);
  assert.equal(overlayConstants.AGENT_SIDEBAR_WIDTH, 280);
});

test("desktop auth classifies OAuth hosts without throwing", () => {
  const d = attachAuthHost();
  assert.equal(d.isAuthNavigation("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(d.isAuthNavigation("https://appleid.apple.com/auth/authorize"), true);
  assert.equal(d.isAuthNavigation("https://github.com/login"), true);
  assert.equal(d.isAuthNavigation("https://github.com/lykn-ai/lykn/releases"), false);
  assert.equal(d.isAuthNavigation("https://example.com/login"), false);
});

test("desktop auth source still owns the OAuth and token bindings", () => {
  const src = read("auth/desktopAuth.cjs");
  assert.match(src, /const AUTH_HOST_SUFFIXES = \[/);
  assert.match(src, /const SUPABASE_AUTH_HOST =/);
  assert.match(src, /const GITHUB_AUTH_PATH_RE =/);
  assert.match(src, /const DESKTOP_AUTH_STATE_TTL_MS =/);
  assert.match(src, /const AUTH_HANDOFF_PORT_CANDIDATES =/);
  assert.match(src, /const LYKN_PROTOCOL =/);
  assert.match(src, /const READ_SUPABASE_TOKEN_JS =/);
  assert.match(src, /const HAS_SUPABASE_SESSION_JS =/);
});

test("extracted hosts require the bindings they lost in the Electron split", () => {
  const liveWatch = read("overlay/liveWatch.cjs");
  assert.match(liveWatch, /require\("\.\.\/browserAct\.cjs"\)/);
  assert.match(liveWatch, /screenFingerprint/);

  const host = read("agent-browser/host.cjs");
  assert.match(host, /require\("\.\.\/browserAct\.cjs"\)/);
  assert.match(host, /screenFingerprint/);

  const welcome = read("windows/welcomeOnboarding.cjs");
  assert.match(welcome, /require\("\.\.\/extensionInstaller\.cjs"\)/);
  assert.match(welcome, /require\("\.\.\/diagnostics\.cjs"\)/);

  const satellites = read("windows/overlaySatellites.cjs");
  assert.match(satellites, /LANG_PICKER_WIDTH/);
  assert.match(satellites, /AGENT_SIDEBAR_WIDTH/);

  const extensionIpc = read("ipc/extensionInstall.cjs");
  assert.match(extensionIpc, /require\("\.\.\/extensionInstaller\.cjs"\)/);
  assert.match(extensionIpc, /appDir: ELECTRON_DIR/);
  assert.doesNotMatch(extensionIpc, /appDir: __dirname/);
});

test("unpackaged extension install resolves from electron/, not electron/ipc", () => {
  const electronDir = ELECTRON_ROOT;
  const ipcDir = path.join(ELECTRON_ROOT, "ipc");
  const expected = path.resolve(electronDir, "..", "extensions", "save-to-lykn");
  const fromElectron = getBundledExtensionDir({
    packaged: false,
    resourcesPath: "/unused",
    appDir: electronDir,
  });
  const fromIpc = getBundledExtensionDir({
    packaged: false,
    resourcesPath: "/unused",
    appDir: ipcDir,
  });
  assert.equal(fromElectron, expected);
  assert.notEqual(fromIpc, expected);
});
