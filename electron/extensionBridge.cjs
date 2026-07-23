// Local HTTP bridge — receives live page text from the LYKN browser extension.
// Binds 127.0.0.1 only.
//
// SECURITY: binding to loopback does NOT stop other local processes (or web
// pages via DNS rebinding) from reaching this server. Gates:
//   1. Host header must be loopback (anti-DNS-rebinding).
//   2. Origin must be a browser-extension scheme (or empty for SW). Never http(s).
//   3. POST /page and /ping require X-Lykn-Bridge-Token matching the per-install
//      secret written into the unpacked extension as bridge-config.json.
// Without (3), an empty Origin + Host: 127.0.0.1 lets any local curl poison
// Glass page grounding.

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PORT = Number(process.env.LYKN_BRIDGE_PORT) || 38471;
const EXTENSION_ORIGIN_RE = /^(chrome-extension|moz-extension|safari-web-extension):\/\//i;
const UI_CONNECTED_MS = 120_000;
const LIVE_DATA_MS = 12_000;
const TOKEN_HEADER = "x-lykn-bridge-token";

function bridgeWelcomeUrl(port = listenPort || DEFAULT_PORT) {
  return `http://127.0.0.1:${port}/welcome`;
}

const WELCOME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>LYKN connected</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:#0b0b0f;color:#f4f4f6;text-align:center;padding:32px}
  .card{max-width:420px;padding:28px 32px;border-radius:16px;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}
  h1{font-size:22px;margin:0 0 8px} p{color:rgba(244,244,246,.6);margin:0;line-height:1.5}
  .ok{color:#3ecf8e;font-weight:600;margin-top:12px}
</style></head><body><div class="card">
<h1>LYKN extension is working</h1>
<p>This tab confirms your browser is sending page text to the LYKN app.</p>
<p class="ok">You can close this tab and return to LYKN.</p>
</div></body></html>`;

let latest = null;
let extensionLastSeenAt = 0;
let server = null;
let listenPort = DEFAULT_PORT;
let bridgeToken = "";

function markExtensionSeen() {
  extensionLastSeenAt = Date.now();
}

function isExtensionConnected(maxAgeMs = UI_CONNECTED_MS) {
  return extensionLastSeenAt > 0 && Date.now() - extensionLastSeenAt <= maxAgeMs;
}

function isExtensionLive(maxAgeMs = LIVE_DATA_MS) {
  return isExtensionConnected(maxAgeMs);
}

function getExtensionPageSnapshot(maxAgeMs = LIVE_DATA_MS) {
  if (!latest || Date.now() - latest.at > maxAgeMs) return null;
  return latest;
}

function getBridgeToken() {
  return bridgeToken;
}

function timingSafeEqualStr(a, b) {
  try {
    const bufA = Buffer.from(String(a ?? ""), "utf8");
    const bufB = Buffer.from(String(b ?? ""), "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function loadOrCreateBridgeToken(userDataPath) {
  if (!userDataPath) {
    bridgeToken = crypto.randomBytes(32).toString("base64url");
    return bridgeToken;
  }
  const tokenPath = path.join(userDataPath, "bridge-token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 32) {
      bridgeToken = existing;
      return bridgeToken;
    }
  } catch {
    /* create below */
  }
  bridgeToken = crypto.randomBytes(32).toString("base64url");
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(tokenPath, bridgeToken, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn("[extension-bridge] could not persist bridge token:", err?.message || err);
  }
  return bridgeToken;
}

/** Write bridge-config.json into an unpacked extension directory so the SW can auth. */
function writeBridgeConfigToExtensionDir(extensionDir) {
  if (!bridgeToken || !extensionDir) return false;
  try {
    fs.writeFileSync(
      path.join(extensionDir, "bridge-config.json"),
      JSON.stringify({ token: bridgeToken, port: listenPort || DEFAULT_PORT }),
      { encoding: "utf8", mode: 0o600 },
    );
    return true;
  } catch (err) {
    console.warn("[extension-bridge] could not write bridge-config.json:", err?.message || err);
    return false;
  }
}

function requestHasValidToken(req) {
  if (!bridgeToken) return false;
  const presented = String(req.headers[TOKEN_HEADER] || "").trim();
  return timingSafeEqualStr(presented, bridgeToken);
}

function startExtensionBridge({ port = DEFAULT_PORT, onUpdate, userDataPath } = {}) {
  if (server) {
    return {
      port: listenPort,
      getSnapshot: getExtensionPageSnapshot,
      isConnected: isExtensionConnected,
      isLive: isExtensionLive,
      getToken: getBridgeToken,
      writeBridgeConfigToExtensionDir,
      stop: () => {},
    };
  }

  loadOrCreateBridgeToken(userDataPath);
  listenPort = port;

  server = http.createServer((req, res) => {
    const hostHeader = String(req.headers.host || "").split(":")[0].toLowerCase();
    const hostOk =
      hostHeader === "127.0.0.1" || hostHeader === "localhost" || hostHeader === "[::1]";

    const origin = String(req.headers.origin || "");
    // Reject opaque "null" and any http(s) page. Extension SW often sends ""
    // or chrome-extension://… — both OK only when paired with the bridge token
    // on mutating routes.
    const originOk = origin === "" || EXTENSION_ORIGIN_RE.test(origin);

    if (origin && EXTENSION_ORIGIN_RE.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      `Content-Type, ${TOKEN_HEADER}, X-Lykn-Bridge-Token`,
    );

    const pathName = (req.url || "").split("?")[0];
    const isWelcome = req.method === "GET" && pathName === "/welcome";
    if (!isWelcome && (!hostOk || !originOk)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"ok":false,"error":"forbidden"}');
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && pathName === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          connected: isExtensionConnected(),
          live: isExtensionLive(),
          at: extensionLastSeenAt,
          port: listenPort,
          // Never echo the token on this public-ish status endpoint.
          authRequired: true,
        }),
      );
      return;
    }

    if (req.method === "GET" && pathName === "/welcome") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(WELCOME_HTML);
      return;
    }

    // Mutating routes: require the per-install bridge token. Empty Origin alone
    // is no longer enough (stops local curl poisoning).
    if (req.method === "POST" && (pathName === "/ping" || pathName === "/page")) {
      if (!requestHasValidToken(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"ok":false,"error":"unauthorized"}');
        return;
      }
    }

    if (req.method === "POST" && pathName === "/ping") {
      markExtensionSeen();
      onUpdate?.({ ping: true, at: extensionLastSeenAt });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    if (req.method === "POST" && pathName === "/page") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 200_000) req.destroy();
      });
      req.on("end", () => {
        try {
          const data = JSON.parse(body || "{}");
          const text = typeof data.text === "string" ? data.text.trim() : "";
          if (text) {
            markExtensionSeen();
            latest = {
              url: String(data.url || "").slice(0, 2048),
              title: String(data.title || "").slice(0, 500),
              text: text.slice(0, 15000),
              sig: String(data.sig || "").slice(0, 128),
              charCount: Number(data.charCount) || text.length,
              at: Date.now(),
              source: "extension",
            };
            onUpdate?.(latest);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"ok":false}');
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(listenPort, "127.0.0.1", () => {
    console.log(`[extension-bridge] listening on 127.0.0.1:${listenPort} (token auth on)`);
  });

  server.on("error", (err) => {
    console.warn("[extension-bridge] server error:", err?.message || err);
  });

  return {
    port: listenPort,
    getSnapshot: getExtensionPageSnapshot,
    isConnected: isExtensionConnected,
    isLive: isExtensionLive,
    getToken: getBridgeToken,
    writeBridgeConfigToExtensionDir,
    stop: () => {
      server?.close();
      server = null;
      latest = null;
      extensionLastSeenAt = 0;
    },
  };
}

module.exports = {
  startExtensionBridge,
  DEFAULT_PORT,
  bridgeWelcomeUrl,
  getExtensionPageSnapshot,
  isExtensionConnected,
  loadOrCreateBridgeToken,
  writeBridgeConfigToExtensionDir,
  getBridgeToken,
};
