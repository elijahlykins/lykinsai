// Install the LYKN browser extension into the user's normal Chrome/Edge/Brave
// profile. Cross-platform: macOS uses /Applications + optional AppleScript;
// Windows uses Program Files / LocalAppData binaries and shell open.

const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

const CHROME_EXTENSION_STORE_URL = String(
  process.env.LYKN_CHROME_EXTENSION_URL || "",
).trim();

const SKIP_COPY = new Set(["README.md", "icons/generate-icons.html", "icons/build-icons.sh"]);
const EXTENSIONS_URL = "chrome://extensions/";

function winLocalAppData() {
  return process.env.LOCALAPPDATA || "";
}

function winProgramFiles() {
  return [
    process.env["PROGRAMFILES"] || "C:\\Program Files",
    process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
  ];
}

/** Candidate install locations per browser key. */
function browserCandidates() {
  if (IS_MAC) {
    return {
      chrome: {
        name: "Google Chrome",
        appPath: "/Applications/Google Chrome.app",
        binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      arc: {
        name: "Arc",
        appPath: "/Applications/Arc.app",
        binary: "/Applications/Arc.app/Contents/MacOS/Arc",
      },
      brave: {
        name: "Brave Browser",
        appPath: "/Applications/Brave Browser.app",
        binary: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      },
      edge: {
        name: "Microsoft Edge",
        appPath: "/Applications/Microsoft Edge.app",
        binary: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      },
    };
  }
  if (IS_WIN) {
    const local = winLocalAppData();
    const pfs = winProgramFiles();
    const chromeBins = [
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      ...pfs.map((pf) => path.join(pf, "Google", "Chrome", "Application", "chrome.exe")),
    ];
    const edgeBins = [
      ...pfs.map((pf) => path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe")),
      path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    const braveBins = [
      path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ...pfs.map((pf) => path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")),
    ];
    return {
      chrome: { name: "Google Chrome", binaries: chromeBins },
      edge: { name: "Microsoft Edge", binaries: edgeBins },
      brave: { name: "Brave Browser", binaries: braveBins },
    };
  }
  // Linux — best-effort PATH names
  return {
    chrome: { name: "Google Chrome", binaries: ["google-chrome", "google-chrome-stable", "chromium"] },
    brave: { name: "Brave Browser", binaries: ["brave-browser", "brave"] },
    edge: { name: "Microsoft Edge", binaries: ["microsoft-edge", "microsoft-edge-stable"] },
  };
}

function getBundledExtensionDir({ packaged, resourcesPath, appDir }) {
  if (packaged) {
    return path.join(resourcesPath, "extensions", "save-to-lykn");
  }
  return path.join(appDir, "..", "extensions", "save-to-lykn");
}

function getUserExtensionDir(userDataPath) {
  return path.join(userDataPath, "browser-extension", "save-to-lykn");
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowserBinary(info) {
  if (info.binary && (await pathExists(info.binary))) return info.binary;
  for (const b of info.binaries || []) {
    if (path.isAbsolute(b)) {
      if (await pathExists(b)) return b;
    } else {
      // On PATH — try invoking via `where`/`which` later; keep as name.
      return b;
    }
  }
  return null;
}

async function pickInstalledBrowser(preferred = "chrome") {
  const apps = browserCandidates();
  const order = [preferred, "chrome", "edge", "brave", "arc"].filter(
    (k, i, a) => a.indexOf(k) === i && apps[k],
  );
  for (const key of order) {
    const info = apps[key];
    if (IS_MAC) {
      if (info.appPath && (await pathExists(info.appPath))) {
        return { key, name: info.name, binary: info.binary, appPath: info.appPath };
      }
    } else {
      const binary = await resolveBrowserBinary(info);
      if (binary) return { key, name: info.name, binary };
    }
  }
  const fallback = apps.chrome || apps.edge || Object.values(apps)[0];
  return {
    key: "chrome",
    name: fallback.name,
    binary: fallback.binary || (fallback.binaries && fallback.binaries[0]) || null,
  };
}

async function copyExtensionTree(src, dest) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });

  async function walk(rel = "") {
    const abs = path.join(src, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (SKIP_COPY.has(relPath.replace(/\\/g, "/"))) continue;
      const from = path.join(src, relPath);
      const to = path.join(dest, relPath);
      if (entry.isDirectory()) {
        await fs.mkdir(to, { recursive: true });
        await walk(relPath);
      } else {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
      }
    }
  }

  await walk();
}

async function ensureExtensionIcons(extDir) {
  const icon128 = path.join(extDir, "icons", "icon-128.png");
  if (await pathExists(icon128)) return;
  const buildSh = path.join(extDir, "icons", "build-icons.sh");
  if (!(await pathExists(buildSh)) || !IS_MAC) return;
  try {
    await execFileAsync("sh", [buildSh], { cwd: path.join(extDir, "icons") });
  } catch {
    /* optional */
  }
}

async function prepareExtensionInstallDir({
  userDataPath,
  packaged,
  resourcesPath,
  appDir,
  writeBridgeConfig,
}) {
  const bundled = getBundledExtensionDir({ packaged, resourcesPath, appDir });
  if (!(await pathExists(bundled))) {
    throw new Error("extension_not_found");
  }
  const dest = getUserExtensionDir(userDataPath);
  await copyExtensionTree(bundled, dest);
  await ensureExtensionIcons(dest);
  // Per-install bridge token so localhost POST /page can't be forged by curl.
  try {
    writeBridgeConfig?.(dest);
  } catch (err) {
    console.warn("[extension-install] bridge-config write:", err?.message || err);
  }
  return dest;
}

async function openViaBinary(binary, args) {
  if (!binary) throw new Error("no_binary");
  await execFileAsync(binary, args, { windowsHide: true });
}

async function openExtensionsPage(picked) {
  const url = EXTENSIONS_URL;

  if (IS_MAC && picked.name === "Google Chrome") {
    try {
      await execFileAsync("osascript", [
        "-e",
        `tell application "Google Chrome"
          activate
          if (count of windows) = 0 then make new window
          set URL of active tab of front window to "${url}"
        end tell`,
      ]);
      return;
    } catch (e) {
      console.warn("[extension-install] Chrome AppleScript:", e?.message);
    }
  }

  if (IS_MAC && picked.name === "Arc") {
    try {
      await execFileAsync("osascript", [
        "-e",
        `tell application "Arc"
          activate
          tell front window
            make new tab with properties {URL:"${url}"}
          end tell
        end tell`,
      ]);
      return;
    } catch (e) {
      console.warn("[extension-install] Arc AppleScript:", e?.message);
    }
  }

  if (picked.binary) {
    try {
      await openViaBinary(picked.binary, ["--new-window", url]);
      return;
    } catch (e) {
      console.warn("[extension-install] binary launch:", e?.message);
    }
  }

  if (IS_MAC) {
    await execFileAsync("open", ["-a", picked.name, "--new", url]);
    return;
  }

  if (IS_WIN) {
    // start requires an empty title arg when the first arg is quoted.
    await execFileAsync("cmd", ["/c", "start", "", url], { windowsHide: true });
  }
}

async function launchBrowserWithExtension(picked, extPath) {
  if (!picked.binary) return;
  try {
    await openViaBinary(picked.binary, [`--load-extension=${extPath}`]);
  } catch (e) {
    console.warn("[extension-install] load-extension launch:", e?.message);
  }
}

async function installExtensionOneClick(
  {
    browser = "chrome",
    userDataPath,
    packaged,
    resourcesPath,
    appDir,
    shell,
    clipboard,
    dialog,
    writeBridgeConfig,
  },
  { storeUrl = CHROME_EXTENSION_STORE_URL } = {},
) {
  if (storeUrl) {
    // Store builds can't receive a per-machine bridge-config.json; users pair
    // via the extension options token field (Electron Settings shows the value).
    if (/^https?:\/\//i.test(String(storeUrl))) {
      await shell.openExternal(storeUrl);
    }
    return { ok: true, mode: "store" };
  }

  const extPath = await prepareExtensionInstallDir({
    userDataPath,
    packaged,
    resourcesPath,
    appDir,
    writeBridgeConfig,
  });
  const picked = await pickInstalledBrowser(browser);
  clipboard?.writeText?.(extPath);

  if (IS_MAC && picked.name) {
    try {
      await execFileAsync("open", ["-a", picked.name, "--args", `--load-extension=${extPath}`]);
    } catch {
      await launchBrowserWithExtension(picked, extPath);
    }
  } else {
    await launchBrowserWithExtension(picked, extPath);
  }

  // Open Chrome's Extensions page + reveal the folder. Guided steps live in
  // the LYKN install window — a second OS dialog here felt like a random
  // "weird screen" on top of chrome://extensions.
  await openExtensionsPage(picked);
  try {
    shell.showItemInFolder(path.join(extPath, "manifest.json"));
  } catch (e) {
    console.warn("[extension-install] showItemInFolder:", e?.message || e);
  }

  return { ok: true, mode: "manual", path: extPath, browser: picked.name };
}

function getExtensionInstallMode(storeUrl = CHROME_EXTENSION_STORE_URL) {
  return {
    storeUrl,
    mode: storeUrl ? "store" : "manual",
    buttonLabel: "Add Chrome Live Feed",
  };
}

module.exports = {
  installExtensionOneClick,
  getExtensionInstallMode,
  getBundledExtensionDir,
  getUserExtensionDir,
  prepareExtensionInstallDir,
  pickInstalledBrowser,
  CHROME_EXTENSION_STORE_URL,
};
