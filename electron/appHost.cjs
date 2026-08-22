/**
 * Installing, opening, and verifying apps LYKN built.
 *
 * The verify pass is the piece that makes the build agent behave like a coding
 * agent rather than a code generator: the app is actually loaded in a real
 * (hidden) window, and whatever it reports — a compile failure, a crash on
 * mount, a console error — comes back as text the model can act on. Without it
 * the model is writing code it never sees run.
 */

const path = require("node:path");
const { BrowserWindow, session } = require("electron");

const apps = require("./localStore/apps.cjs");
const appBridge = require("./appBridge.cjs");
const appProtocol = require("./appProtocol.cjs");
const { compileApp, BUNDLE_PATH } = require("./appRuntime/compile.cjs");

const PRELOAD = path.join(__dirname, "appPreload.cjs");

/** Manifest file the model writes alongside its source. */
const MANIFEST_PATH = "app.json";

/** Windows currently showing an app, keyed by app id. */
const openWindows = new Map();

/**
 * Console output that is about the runtime rather than about the app.
 * Feeding these back to the model would send it editing code to fix something
 * its code did not cause.
 */
const RUNTIME_NOISE = [
  /cdn\.tailwindcss\.com should not be used in production/i,
  /Electron Security Warning/i,
  /Content-Security-Policy/i,
  /DevTools/i,
];

function isRuntimeNoise(message) {
  return RUNTIME_NOISE.some((re) => re.test(message));
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Read `app.json` out of a project.
 *
 * Everything is optional and everything is clamped: the manifest is written by
 * a language model, so it is treated as a suggestion to be validated rather
 * than as configuration to be trusted.
 */
function parseManifest(files = [], fallbackTitle = "App") {
  const raw = files.find((f) => f.path === MANIFEST_PATH)?.content;
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) || {};
    } catch {
      parsed = {};
    }
  }

  const known = new Set(Object.keys(appBridge.CAPABILITIES));
  const capabilities = (Array.isArray(parsed.capabilities) ? parsed.capabilities : [])
    .filter((c) => typeof c === "string")
    // `net:<host>` entries name an allowed host and ride alongside `net`.
    .filter((c) => known.has(c) || /^net:[a-z0-9.-]+$/i.test(c))
    .slice(0, 20);

  return {
    name: String(parsed.name || fallbackTitle || "App").slice(0, 120),
    icon: parsed.icon ? String(parsed.icon).slice(0, 80) : null,
    description: parsed.description ? String(parsed.description).slice(0, 500) : null,
    entry: String(parsed.entry || "App.jsx"),
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Which icon an install lands on.
 *
 * The user outranks the model: a pick made in the install sheet wins outright,
 * and one made earlier from the dock survives every later rebuild. Only an app
 * whose icon nobody has touched follows its manifest.
 */
function resolveIcon(chosen, manifestIcon, existing) {
  const picked = apps.normalizeIconName(chosen);
  if (picked) return { icon: picked, icon_source: "user" };
  if (existing?.icon_source === "user") return { icon: existing.icon, icon_source: "user" };
  return { icon: apps.normalizeIconName(manifestIcon), icon_source: null };
}

/**
 * Install (or update) an app from a built project.
 *
 * Passing an existing `id` updates in place, which matters more than it looks:
 * the id is the app's origin, so reusing it is what lets an update keep the
 * data the user has already put into the app.
 */
async function installApp({
  id = null,
  title = "App",
  files = [],
  entry = null,
  icon = null,
  sourceChat = null,
} = {}) {
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === "string")
    .map((f) => ({ path: String(f.path), content: String(f.content ?? "") }));

  if (!list.length) return { ok: false, error: "no_files", hint: "The app has no source files." };

  const manifest = parseManifest(list, title);
  if (entry) manifest.entry = String(entry);

  const existing = id ? apps.getApp(id) : null;
  const chosenIcon = resolveIcon(icon, manifest.icon, existing);

  // Compile before anything is written. An app that cannot build must not
  // land in the user's dock as a broken icon.
  const built = await compileApp(list.filter((f) => f.path !== BUNDLE_PATH), manifest.entry);
  if (!built.ok) return { ok: false, error: built.error, hint: built.hint };

  let app;
  if (existing) {
    apps.snapshotVersion(existing.id, `before update to "${manifest.name}"`);
    // Capabilities move to whatever the new manifest declares, but grants are
    // NOT carried over for anything newly requested: consent given to the old,
    // narrower manifest must not silently cover a wider one.
    const keptGrants = {};
    for (const [cap, value] of Object.entries(existing.grants || {})) {
      if (manifest.capabilities.includes(cap)) keptGrants[cap] = value;
    }
    apps.updateApp(existing.id, {
      name: manifest.name,
      ...chosenIcon,
      description: manifest.description,
      entry: manifest.entry,
      capabilities: manifest.capabilities,
      grants: keptGrants,
    });
    app = apps.getApp(existing.id);
  } else {
    app = apps.createApp({
      name: manifest.name,
      ...chosenIcon,
      description: manifest.description,
      entry: manifest.entry,
      capabilities: manifest.capabilities,
      source_chat: sourceChat,
    });
  }

  apps.putFiles(app.id, list);
  apps.writeFile(app.id, BUNDLE_PATH, built.code);

  return { ok: true, app: apps.getApp(app.id), bytes: built.bytes };
}

/** Remove an app and everything it stored. */
function uninstallApp(id) {
  const win = openWindows.get(String(id));
  if (win && !win.isDestroyed()) win.destroy();
  openWindows.delete(String(id));
  return apps.hardDeleteApp(id);
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Each app gets its own session partition, and a protocol handler is per
 * session — so the scheme has to be bound on that partition before the window
 * tries to load from it, or the app opens to a failed navigation.
 */
function partitionFor(appId) {
  const name = `persist:lykn-app-${appId}`;
  try {
    appProtocol.bind(session.fromPartition(name));
  } catch (err) {
    console.warn(`[LYKN] could not bind app protocol for ${appId}:`, err?.message);
  }
  return name;
}

function windowOptions(app, extra = {}) {
  return {
    width: 1000,
    height: 720,
    minWidth: 420,
    minHeight: 360,
    title: app.name,
    backgroundColor: "#fafafa",
    // Frameless-adjacent chrome to match the rest of the desktop.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: PRELOAD,
      // Non-negotiable for AI-written code: no Node in the app's renderer, and
      // context isolation so the bridge is the only reachable surface.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      // Each app already has its own origin; a separate partition additionally
      // keeps its cookies and caches out of the main app's session.
      partition: partitionFor(app.id),
    },
    ...extra,
  };
}

/** Open an installed app in its own window, focusing it if already open. */
function openApp(id) {
  const appId = String(id);
  const app = apps.getApp(appId);
  if (!app || app.deleted_at) return { ok: false, error: "app not found" };

  const existing = openWindows.get(appId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { ok: true, id: appId, focused: true };
  }

  const win = new BrowserWindow(windowOptions(app));
  openWindows.set(appId, win);
  win.on("closed", () => openWindows.delete(appId));

  // An app must not be able to navigate itself out of its own origin, and
  // window.open should go to the user's browser rather than an unsandboxed
  // Electron window.
  win.webContents.on("will-navigate", (event, url) => {
    if (appProtocol.appIdFromOrigin(url) !== appId) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.loadURL(appProtocol.urlFor(appId));
  apps.touchApp(appId);
  return { ok: true, id: appId };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Load the app for real in a hidden window and collect whatever goes wrong.
 *
 * Resolves on the app's own "ready" report, on the first hard error, or on
 * timeout — whichever comes first. The window is always destroyed.
 *
 * @returns {Promise<{ok: boolean, ready: boolean, errors: {type: string, message: string}[]}>}
 */
function verifyApp(id, { timeoutMs = 12000 } = {}) {
  const appId = String(id);
  const app = apps.getApp(appId);
  if (!app) return Promise.resolve({ ok: false, ready: false, errors: [{ type: "error", message: "app not found" }] });

  return new Promise((resolve) => {
    const errors = [];
    let settled = false;

    const win = new BrowserWindow(
      windowOptions(app, { show: false, width: 1000, height: 720, titleBarStyle: "default" }),
    );

    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Anything the bridge recorded (the app called __report because it had
      // no opener) belongs in the same list, minus the same runtime noise.
      for (const e of appBridge.takeRuntimeErrors(appId)) {
        if (!isRuntimeNoise(e.message)) errors.push(e);
      }
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        /* already gone */
      }
      resolve({ ok: ready && errors.length === 0, ready, errors: errors.slice(0, 20) });
    };

    const timer = setTimeout(() => {
      errors.push({
        type: "timeout",
        message: `The app did not finish rendering within ${Math.round(timeoutMs / 1000)}s.`,
      });
      finish(false);
    }, timeoutMs);

    // Only real errors (level 3) count. Warnings would otherwise fail every
    // single app: Tailwind's CDN build and Electron's own security notice both
    // log one on every load, and reporting those back to the model would send
    // it chasing "bugs" it did not write and cannot fix.
    win.webContents.on("console-message", (_event, level, message) => {
      const text = String(message || "");
      if (level >= 3 && !isRuntimeNoise(text)) {
        errors.push({ type: "console", message: text.slice(0, 800) });
      }
    });

    win.webContents.on("did-fail-load", (_event, code, description) => {
      errors.push({ type: "load", message: `${description} (${code})` });
      finish(false);
    });

    win.webContents.on("render-process-gone", (_event, details) => {
      errors.push({ type: "crash", message: `renderer gone: ${details?.reason || "unknown"}` });
      finish(false);
    });

    // The shell posts progress through the bridge; poll for its "ready" record
    // rather than injecting a listener into the app's world.
    win.webContents.on("ipc-message", (_event, channel, payload) => {
      if (channel !== "lykn:app-report") return;
      if (payload?.type === "ready") {
        // Mounted, but an effect that throws immediately after is still the
        // app being broken. A short grace period catches that class of bug.
        setTimeout(() => finish(errors.length === 0), 400);
      } else if (payload?.type && !isRuntimeNoise(String(payload.message || ""))) {
        errors.push({ type: payload.type, message: String(payload.message || "") });
      }
    });

    win.webContents.once("did-finish-load", () => {
      // Give the app a beat to mount and throw before calling it healthy.
      setTimeout(() => finish(errors.length === 0), 1200);
    });

    win.loadURL(appProtocol.urlFor(appId));
  });
}

/**
 * Recompile after an edit and confirm the app still runs.
 * Returns a shape the build tool can hand straight back to the model.
 */
async function rebuildAndVerify(id) {
  const appId = String(id);
  const app = apps.getApp(appId);
  if (!app) return { ok: false, error: "app_not_found", hint: "That app is not installed." };

  const files = apps.listFiles(appId).filter((f) => f.path !== BUNDLE_PATH);
  const built = await compileApp(files, app.entry);
  if (!built.ok) {
    appProtocol.invalidateBundle(appId);
    return { ok: false, error: built.error, hint: built.hint };
  }
  apps.writeFile(appId, BUNDLE_PATH, built.code);

  const verified = await verifyApp(appId);
  if (!verified.ok && verified.errors.length) {
    return {
      ok: false,
      error: "runtime_error",
      hint:
        "The app compiled but failed when it ran. Fix these and try again: " +
        verified.errors.map((e) => `[${e.type}] ${e.message}`).join(" | ").slice(0, 900),
      errors: verified.errors,
    };
  }
  return { ok: true, bytes: built.bytes };
}

module.exports = {
  MANIFEST_PATH,
  PRELOAD,
  partitionFor,
  parseManifest,
  installApp,
  uninstallApp,
  openApp,
  verifyApp,
  rebuildAndVerify,
  openWindows,
};
