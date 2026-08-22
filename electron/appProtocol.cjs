/**
 * `lykn-app://` — how an installed app reaches the screen.
 *
 * URLs look like:
 *     lykn-app://<app-id>/            the boot document
 *     lykn-app://<app-id>/app.js      the compiled bundle
 *     lykn-app://<app-id>/vendor/…    React, ReactDOM, Tailwind
 *     lykn-app://<app-id>/<path>      any other file in the project
 *
 * The app id is the HOSTNAME rather than a path segment, and that is the whole
 * security model: Chromium treats each host as a separate origin, so app A's
 * IndexedDB, localStorage, cookies, and caches are invisible to app B without
 * a line of isolation code from us. It is also how the bridge knows which app
 * is calling — the id is read back off the frame's origin, never from an
 * argument the app supplies.
 *
 * The scheme is registered `standard` + `secure` so Chromium treats it as a
 * trustworthy origin. That is what makes DOM storage work at all; a plain
 * custom scheme gets an opaque origin where localStorage throws, which is
 * exactly the problem the chat preview has.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const apps = require("./localStore/apps.cjs");
const { compileApp, BUNDLE_PATH } = require("./appRuntime/compile.cjs");
const { buildAppShellHtml } = require("./appRuntime/shell.cjs");

const SCHEME = "lykn-app";

const PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  // Must travel with supportFetchAPI: the network service refuses a fetch on a
  // scheme it was not told is CORS-aware, so an app calling fetch() on its own
  // assets fails before the handler ever runs. Cross-origin reads are still
  // blocked — nothing grants lykn-app:// access to another origin.
  corsEnabled: true,
  stream: true,
};

const VENDOR_DIR = path.join(__dirname, "appRuntime", "vendor");

const MIME_BY_EXT = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

function contentType(p) {
  const ext = String(p).split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** The URL an installed app is opened at. */
function urlFor(appId, subPath = "") {
  const clean = String(subPath || "").replace(/^\/+/, "");
  return `${SCHEME}://${String(appId).toLowerCase()}/${clean}`;
}

/** Read the app id back out of an origin. Returns null for anything else. */
function appIdFromOrigin(origin) {
  try {
    const parsed = new URL(String(origin));
    if (parsed.protocol !== `${SCHEME}:`) return null;
    const host = parsed.hostname.toLowerCase();
    return apps.isValidAppId(host) ? host : null;
  } catch {
    return null;
  }
}

function parseRequestUrl(requestUrl) {
  let parsed;
  try {
    parsed = new URL(String(requestUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${SCHEME}:`) return null;

  const appId = parsed.hostname.toLowerCase();
  if (!apps.isValidAppId(appId)) return null;

  let filePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  // Reject traversal before it can reach either the vendor directory on disk
  // or the project's file table.
  if (filePath.split("/").some((seg) => seg === "..")) return null;

  return { appId, filePath };
}

/** Libraries the shell loads after React, in dependency order. */
const VENDOR_LIBRARIES = ["lucide-react.js", "recharts.js", "framer-motion.js"];

/**
 * What is actually on disk. Checked per request rather than cached at import so
 * a dev who re-runs the vendor script does not have to restart the app.
 */
function vendorRuntime() {
  return {
    hasTailwind: fs.existsSync(path.join(VENDOR_DIR, "tailwind.js")),
    libraries: VENDOR_LIBRARIES.filter((f) => fs.existsSync(path.join(VENDOR_DIR, f))),
  };
}

const NO_STORE = {
  // App source changes whenever the user asks for an edit, and a stale bundle
  // after a rebuild looks exactly like "the AI ignored me". Correctness beats
  // the few milliseconds a cache would save on a local read.
  "Cache-Control": "no-store",
};

function textResponse(body, type, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": type, ...NO_STORE, ...extraHeaders },
  });
}

/**
 * Serve the compiled bundle, compiling on demand when the cache is cold.
 *
 * The cache lives in the app's own file table under a reserved path rather
 * than in a temp directory, so it travels with the database backup and cannot
 * drift away from the source it was built from.
 */
async function serveBundle(appId) {
  const cached = apps.readFile(appId, BUNDLE_PATH);
  if (cached) return textResponse(cached, MIME_BY_EXT.js);

  const app = apps.getApp(appId);
  if (!app) return textResponse("// app not found", MIME_BY_EXT.js, 404);

  const files = apps.listFiles(appId).filter((f) => f.path !== BUNDLE_PATH);
  const built = await compileApp(files, app.entry);

  if (!built.ok) {
    console.warn(`[LYKN] app ${appId} failed to compile:`, built.hint);
    // Throwing inside the bundle surfaces the real compiler message in the
    // app's own error overlay, which is also what the verify pass reads.
    const message = JSON.stringify(built.hint || built.error);
    return textResponse(`throw new Error(${message});`, MIME_BY_EXT.js);
  }

  try {
    apps.writeFile(appId, BUNDLE_PATH, built.code);
  } catch (err) {
    console.warn(`[LYKN] could not cache bundle for ${appId}:`, err?.message);
  }
  return textResponse(built.code, MIME_BY_EXT.js);
}

async function serveVendor(filePath) {
  const name = filePath.slice("vendor/".length);
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return new Response("Forbidden", { status: 403 });

  const absolute = path.join(VENDOR_DIR, name);
  if (!absolute.startsWith(VENDOR_DIR)) return new Response("Forbidden", { status: 403 });

  try {
    const body = await fsp.readFile(absolute);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType(name),
        // Vendored libraries are pinned at build time and never change under a
        // given filename, so these can cache hard.
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/** Exported separately from the Electron wiring so tests can drive it directly. */
async function handleRequest(request) {
  const parsed = parseRequestUrl(request?.url);
  if (!parsed) return new Response("Bad app URL", { status: 400 });

  const { appId, filePath } = parsed;

  if (filePath.startsWith("vendor/")) return serveVendor(filePath);

  const app = apps.getApp(appId);
  if (!app || app.deleted_at) return new Response("App not found", { status: 404 });

  if (!filePath || filePath === "index.html") {
    return textResponse(buildAppShellHtml(app, vendorRuntime()), MIME_BY_EXT.html);
  }

  if (filePath === "app.js") return serveBundle(appId);

  // The compiled bundle is an implementation detail; serving it under its
  // storage path too would let an app fetch and eval its own cache.
  if (filePath === BUNDLE_PATH) return new Response("Forbidden", { status: 403 });

  const content = apps.readFile(appId, filePath);
  if (content == null) return new Response("Not found", { status: 404 });
  return textResponse(content, contentType(filePath));
}

/** Drop the cached bundle so the next load recompiles. Call after any edit. */
function invalidateBundle(appId) {
  try {
    apps.deleteFile(appId, BUNDLE_PATH);
  } catch {
    /* nothing cached is the same outcome */
  }
}

/** Must run before app-ready, alongside the other privileged registrations. */
function schemeRegistration() {
  return { scheme: SCHEME, privileges: PRIVILEGES };
}

function bind(session) {
  if (!session || session.__lyknAppProtocolBound) return false;
  try {
    session.protocol.handle(SCHEME, handleRequest);
    session.__lyknAppProtocolBound = true;
    return true;
  } catch (err) {
    console.warn("[LYKN] lykn-app protocol bind failed:", err?.message);
    return false;
  }
}

module.exports = {
  SCHEME,
  PRIVILEGES,
  VENDOR_DIR,
  urlFor,
  appIdFromOrigin,
  parseRequestUrl,
  handleRequest,
  invalidateBundle,
  schemeRegistration,
  bind,
};
