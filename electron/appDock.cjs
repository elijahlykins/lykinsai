/**
 * Mac app dock backend — installed applications, launch, quit, and running-state.
 *
 * Powers the Studio dock strip (list/launch/quit/running indicators) and the
 * `local_running_apps` AI tool. Runs only in the Electron main process.
 * Running-state uses lsappinfo; listing, launching, and running-state need no
 * TCC permission. Only quit (an explicit user action) speaks AppleScript.
 */

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const APP_ROOTS = [
  "/Applications",
  "/Applications/Utilities",
  path.join(os.homedir(), "Applications"),
  "/System/Applications",
];

// Apps that clutter a dock without being things users launch from LYKN.
const HIDDEN_APP_NAMES = new Set([
  "Utilities",
  "LYKN",
  "Electron",
]);

const APP_LIST_TTL_MS = 5 * 60 * 1000;
const ICON_CACHE_MAX = 300;

let appListCache = { at: 0, apps: [] };
const iconCache = new Map(); // bundlePath -> data URL

function displayNameFor(bundleName) {
  return bundleName.replace(/\.app$/i, "");
}

async function scanRoot(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const apps = [];
  for (const ent of entries) {
    if (!ent.name.endsWith(".app")) continue;
    const name = displayNameFor(ent.name);
    if (HIDDEN_APP_NAMES.has(name)) continue;
    apps.push({ name, path: path.join(root, ent.name) });
  }
  return apps;
}

/** Enumerate installed .app bundles (cached; deduped by display name). */
async function listInstalledApps({ force = false } = {}) {
  const now = Date.now();
  if (!force && appListCache.apps.length && now - appListCache.at < APP_LIST_TTL_MS) {
    return appListCache.apps;
  }
  const seen = new Set();
  const apps = [];
  for (const root of APP_ROOTS) {
    for (const app of await scanRoot(root)) {
      const key = app.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      apps.push(app);
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  appListCache = { at: now, apps };
  return apps;
}

// app.getFileIcon is BANNED here: Electron 42's icon loader trips an
// EXC_BREAKPOINT inside macOS 26's IconServices and takes the whole app
// down — first seen with parallel calls, then reproduced with a single
// serialized call. Instead we read the bundle's .icns straight off disk
// and convert it with `sips` in a child process, which can't crash LYKN.

const ICON_CMD_TIMEOUT_MS = 5000;
const iconInFlight = new Map(); // bundlePath -> Promise<dataUrl>

function execFileText(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: ICON_CMD_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ""));
    });
  });
}

/** Locate the .icns file a bundle declares (or any .icns in Resources). */
async function findIcnsPath(bundlePath) {
  const resources = path.join(bundlePath, "Contents", "Resources");
  const candidates = [];
  try {
    const declared = (
      await execFileText("plutil", [
        "-extract", "CFBundleIconFile", "raw", "-o", "-",
        path.join(bundlePath, "Contents", "Info.plist"),
      ])
    ).trim();
    if (declared) {
      candidates.push(
        path.join(resources, declared.endsWith(".icns") ? declared : `${declared}.icns`)
      );
    }
  } catch {
    /* no CFBundleIconFile (asset-catalog icons) — fall back to scanning */
  }
  try {
    for (const entry of await fsp.readdir(resources)) {
      if (entry.endsWith(".icns")) candidates.push(path.join(resources, entry));
    }
  } catch {
    /* unreadable Resources dir */
  }
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return "";
}

async function extractIcon(bundlePath) {
  const icns = await findIcnsPath(bundlePath);
  if (!icns) return "";
  const tmp = path.join(
    os.tmpdir(),
    `lykn-appicon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
  try {
    await execFileText("sips", [
      "-s", "format", "png",
      "--resampleHeightWidthMax", "128",
      icns, "--out", tmp,
    ]);
    const buf = await fsp.readFile(tmp);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return ""; // corrupt/exotic icns — dock shows a letter tile
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
}

/** Icon for a bundle as a PNG data URL (cached; in-flight deduped). */
async function getAppIcon(bundlePath) {
  if (iconCache.has(bundlePath)) return iconCache.get(bundlePath);
  if (iconInFlight.has(bundlePath)) return iconInFlight.get(bundlePath);
  const pending = extractIcon(bundlePath)
    .catch(() => "")
    .then((dataUrl) => {
      if (iconCache.size >= ICON_CACHE_MAX) iconCache.clear();
      iconCache.set(bundlePath, dataUrl);
      iconInFlight.delete(bundlePath);
      return dataUrl;
    });
  iconInFlight.set(bundlePath, pending);
  return pending;
}

/** Installed apps with icons attached — payload for the dock UI. */
const ICON_WORKERS = 4; // a few sips child processes at once, never in-process
let listWithIconsInFlight = null;
async function listAppsWithIcons(opts = {}) {
  // Dedupe concurrent callers (e.g. two windows mounting the dock at once)
  // so each icon is only extracted once.
  if (listWithIconsInFlight) return listWithIconsInFlight;
  listWithIconsInFlight = (async () => {
    const apps = await listInstalledApps(opts);
    const out = new Array(apps.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: ICON_WORKERS }, async () => {
        while (next < apps.length) {
          const idx = next++;
          const a = apps[idx];
          out[idx] = { ...a, icon: await getAppIcon(a.path) };
        }
      })
    );
    return out;
  })();
  try {
    return await listWithIconsInFlight;
  } finally {
    listWithIconsInFlight = null;
  }
}

/**
 * Launch (or focus, if already running) an app. Only bundles we discovered
 * ourselves are launchable — the renderer can't pass arbitrary paths.
 */
async function launchApp(bundlePath) {
  const apps = await listInstalledApps();
  const target = apps.find((a) => a.path === String(bundlePath || ""));
  if (!target) return { ok: false, error: "Unknown application" };
  return new Promise((resolve) => {
    execFile("open", [target.path], { timeout: 15_000 }, (err) => {
      if (err) resolve({ ok: false, error: err.message || "launch failed" });
      else resolve({ ok: true, name: target.name });
    });
  });
}

function runOsascript(script, timeout = 8000) {
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

function runCmd(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String((stderr || "") + " " + (err.message || "")).trim();
        resolve({ error: msg || String(err.code || err) });
        return;
      }
      resolve({ out: String(stdout || "") });
    });
  });
}

/**
 * Running (non-background) apps + the frontmost one, read via `lsappinfo`.
 *
 * Unlike the previous System Events AppleScript, lsappinfo needs no macOS
 * Automation permission — so the Studio dock's passive running-state polling
 * never pops the "LYKN wants access to control System Events" consent dialog.
 * That dialog must only ever appear from an explicit user action.
 *
 * Returns { ok, frontmost, running: string[] } or { ok: false, error }.
 */
async function getRunningApps() {
  const [frontRes, listRes] = await Promise.all([
    runCmd("/usr/bin/lsappinfo", ["front"]),
    runCmd("/usr/bin/lsappinfo", ["list"]),
  ]);
  if (listRes.error) {
    return { ok: false, error: "Could not read running apps. " + listRes.error };
  }
  const frontAsn = (String(frontRes.out || "").match(/ASN:([0-9a-fx-]+)/i) || [])[1] || "";
  const running = [];
  let frontmost = "";
  let current = null; // { name, asn }
  for (const line of String(listRes.out || "").split("\n")) {
    const head = line.match(/^\s*\d+\)\s+"(.*)"\s+ASN:([0-9a-fx-]+)/i);
    if (head) {
      current = { name: head[1].trim(), asn: head[2] };
      continue;
    }
    if (!current) continue;
    const type = line.match(/\btype="([^"]+)"/);
    if (type) {
      if (type[1] === "Foreground" && current.name) {
        running.push(current.name);
        if (frontAsn && current.asn === frontAsn) frontmost = current.name;
      }
      current = null;
    }
  }
  return { ok: true, frontmost, running };
}

/** Result shape for the `local_running_apps` AI tool. */
async function getRunningAppsResult() {
  const res = await getRunningApps();
  if (!res.ok) return res;
  return {
    ok: true,
    frontmostApp: res.frontmost,
    runningApps: res.running,
    note: "Apps currently open on the user's Mac. The frontmost app is what they are looking at right now.",
  };
}

// ---------------------------------------------------------------------------
// Running-state polling (only while a subscriber — the Studio dock — is live)
// ---------------------------------------------------------------------------

let pollTimer = null;
let lastSnapshotKey = "";
const subscribers = new Set();

async function pollOnce() {
  const res = await getRunningApps();
  if (!res.ok) return;
  const key = res.frontmost + "::" + res.running.join("|");
  if (key === lastSnapshotKey) return;
  lastSnapshotKey = key;
  for (const fn of subscribers) {
    try {
      fn(res);
    } catch {
      /* subscriber gone */
    }
  }
}

/** Subscribe to running-app changes; returns an unsubscribe fn. */
function subscribeRunningApps(fn, intervalMs = 5000) {
  subscribers.add(fn);
  if (!pollTimer) {
    pollTimer = setInterval(pollOnce, intervalMs);
    pollOnce();
  }
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      lastSnapshotKey = "";
    }
  };
}

/**
 * Quit an app the user launched from the dock. Same allowlist as launch —
 * only bundles we discovered ourselves, never an arbitrary path.
 */
async function quitApp(bundlePath) {
  const apps = await listInstalledApps();
  const target = apps.find((a) => a.path === String(bundlePath || ""));
  if (!target) return { ok: false, error: "Unknown application" };
  const quoted = String(target.name).replace(/"/g, '""');
  const res = await runOsascript(`tell application "${quoted}" to quit`);
  lastSnapshotKey = "";
  pollOnce();
  if (res.error) return { ok: false, error: res.error };
  return { ok: true, name: target.name };
}

module.exports = {
  listInstalledApps,
  listAppsWithIcons,
  getAppIcon,
  launchApp,
  quitApp,
  getRunningApps,
  getRunningAppsResult,
  subscribeRunningApps,
};
