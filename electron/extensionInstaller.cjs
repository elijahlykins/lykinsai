// Install the LYKN browser extension into the user's normal Chrome profile.

const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const CHROME_EXTENSION_STORE_URL = String(
  process.env.LYKN_CHROME_EXTENSION_URL || "",
).trim();

const BROWSER_APPS = {
  chrome: { name: "Google Chrome", binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  arc: { name: "Arc", binary: "/Applications/Arc.app/Contents/MacOS/Arc" },
  brave: { name: "Brave Browser", binary: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
  edge: { name: "Microsoft Edge", binary: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
};

const SKIP_COPY = new Set(["README.md", "icons/generate-icons.html", "icons/build-icons.sh"]);
const EXTENSIONS_URL = "chrome://extensions/";

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

async function pickInstalledBrowser(preferred = "chrome") {
  const order = [preferred, "chrome", "arc", "brave", "edge"].filter(
    (k, i, a) => a.indexOf(k) === i,
  );
  for (const key of order) {
    const info = BROWSER_APPS[key];
    if (!info) continue;
    if (await pathExists(`/Applications/${info.name}.app`)) return { key, ...info };
  }
  return { key: "chrome", ...BROWSER_APPS.chrome };
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
  if (!(await pathExists(buildSh))) return;
  try {
    await execFileAsync("sh", [buildSh], { cwd: path.join(extDir, "icons") });
  } catch {
    /* optional */
  }
}

async function prepareExtensionInstallDir({ userDataPath, packaged, resourcesPath, appDir }) {
  const bundled = getBundledExtensionDir({ packaged, resourcesPath, appDir });
  if (!(await pathExists(bundled))) {
    throw new Error("extension_not_found");
  }
  const dest = getUserExtensionDir(userDataPath);
  await copyExtensionTree(bundled, dest);
  await ensureExtensionIcons(dest);
  return dest;
}

function execOpen(args) {
  return new Promise((resolve, reject) => {
    execFile("open", args, (err) => (err ? reject(err) : resolve()));
  });
}

async function openExtensionsPage(appName) {
  const url = EXTENSIONS_URL;

  if (appName === "Google Chrome") {
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

  if (appName === "Arc") {
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

  const info = Object.values(BROWSER_APPS).find((b) => b.name === appName);
  if (info?.binary && (await pathExists(info.binary))) {
    try {
      await execFileAsync(info.binary, ["--new-window", url]);
      return;
    } catch (e) {
      console.warn("[extension-install] binary launch:", e?.message);
    }
  }

  await execOpen(["-a", appName, "--new", url]);
}

async function installExtensionOneClick(
  { browser = "chrome", userDataPath, packaged, resourcesPath, appDir, shell, clipboard, dialog },
  { storeUrl = CHROME_EXTENSION_STORE_URL } = {},
) {
  if (storeUrl) {
    await shell.openExternal(storeUrl);
    return { ok: true, mode: "store" };
  }

  const extPath = await prepareExtensionInstallDir({
    userDataPath,
    packaged,
    resourcesPath,
    appDir,
  });
  const picked = await pickInstalledBrowser(browser);
  clipboard?.writeText?.(extPath);

  try {
    await execFileAsync("open", ["-a", picked.name, "--args", `--load-extension=${extPath}`]);
  } catch {
    /* optional — manual load is the reliable path */
  }

  await openExtensionsPage(picked.name);
  shell.showItemInFolder(path.join(extPath, "manifest.json"));

  if (dialog) {
    await dialog.showMessageBox({
      type: "info",
      buttons: ["OK"],
      defaultId: 0,
      title: "Load LYKN Chrome Live Feed",
      message: `In ${picked.name}, load the extension folder from Finder.`,
      detail:
        `1. Turn on Developer mode (top-right on Extensions)\n` +
        `2. Click Load unpacked\n` +
        `3. Select the folder that opened in Finder\n\n` +
        `Folder path (copied to clipboard):\n${extPath}`,
    });
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
  CHROME_EXTENSION_STORE_URL,
};
