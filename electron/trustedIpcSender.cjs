/**
 * Sender attestation for high-risk Electron IPC.
 *
 * Local Mode, shell, filesystem, and app-launch handlers must not run for a
 * random agent tab that happens to share the process. The trusted set is:
 *   - packaged `file:` documents under explicit app electron/ roots
 *   - the `lykn:` app scheme
 *   - the Studio web origin (APP_ORIGIN / APP_URL)
 *
 * A remote https page that is not the LYKN app origin is rejected.
 * file: trust is path-containment under trustedFileRoots, not a substring
 * match for "/electron/" anywhere on disk.
 */

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

function originOf(url) {
  try {
    return new URL(String(url || "")).origin;
  } catch {
    return "";
  }
}

function canonicalPath(absPath) {
  const abs = path.resolve(String(absPath || ""));
  if (!abs) return "";
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function isInsideRoot(absPath, root) {
  const target = canonicalPath(absPath);
  const base = canonicalPath(root);
  if (!target || !base) return false;
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function filePathFromUrl(parsed) {
  try {
    return fileURLToPath(parsed);
  } catch {
    return decodeURIComponent(parsed.pathname || "");
  }
}

function trustedFileRootsFromOpts(opts = {}) {
  if (Array.isArray(opts.trustedFileRoots) && opts.trustedFileRoots.length) {
    return opts.trustedFileRoots.map((r) => String(r || "")).filter(Boolean);
  }
  if (opts.app && typeof opts.app.getAppPath === "function") {
    const pathMod = opts.path || path;
    try {
      return [pathMod.join(opts.app.getAppPath(), "electron")];
    } catch {
      return [];
    }
  }
  return [];
}

function isTrustedLyknIpcUrl(url, opts = {}) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === "lykn:") return true;
  if (parsed.protocol === "file:") {
    const filePath = filePathFromUrl(parsed);
    if (!filePath) return false;
    if (!/\.html?$/i.test(filePath)) return false;
    const roots = trustedFileRootsFromOpts(opts);
    if (!roots.length) return false;
    return roots.some((root) => isInsideRoot(filePath, root));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const allowed = new Set();
  const fromOrigin = originOf(opts.appOrigin || "");
  const fromApp = originOf(opts.appUrl || "");
  if (fromOrigin) allowed.add(fromOrigin);
  if (fromApp) allowed.add(fromApp);
  return allowed.has(parsed.origin);
}

function isTrustedLyknIpcSender(event, opts = {}) {
  const url = event?.sender?.getURL?.() || "";
  return isTrustedLyknIpcUrl(url, opts);
}

function untrustedSenderResult(event, opts = {}) {
  if (isTrustedLyknIpcSender(event, opts)) return null;
  return { ok: false, error: "untrusted_sender" };
}

function trustedLyknIpcOpts({ app, path: pathMod, appOrigin = "", appUrl = "" } = {}) {
  return {
    appOrigin,
    appUrl,
    app,
    path: pathMod || path,
    trustedFileRoots: trustedFileRootsFromOpts({ app, path: pathMod || path }),
  };
}

module.exports = {
  isTrustedLyknIpcUrl,
  isTrustedLyknIpcSender,
  untrustedSenderResult,
  trustedLyknIpcOpts,
};
