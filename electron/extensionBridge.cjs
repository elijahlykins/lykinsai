// Local HTTP bridge — receives live page text from the LYKN browser extension.
// Binds 127.0.0.1 only.
//
// SECURITY: binding to loopback does NOT stop other web pages from reaching
// this server — any site the user visits can `fetch('http://127.0.0.1:PORT/…')`.
// So we gate every request on two checks:
//   1. Host header must be loopback (127.0.0.1 / localhost). A DNS-rebinding
//      page connects to 127.0.0.1 but carries its own hostname in Host, so
//      this rejects rebinding attacks.
//   2. If an Origin header is present it must be a browser-extension origin
//      (chrome-extension:// / moz-extension:// / safari-web-extension://).
//      Normal http(s) web pages carry an http(s) Origin and are rejected —
//      this stops arbitrary sites from reading captured page text or POSTing
//      attacker-controlled text into LYKN's AI grounding.
// CORS is reflected only back to an allowed extension origin, never `*`.

const http = require("node:http");

const DEFAULT_PORT = Number(process.env.LYKN_BRIDGE_PORT) || 38471;
const EXTENSION_ORIGIN_RE = /^(chrome-extension|moz-extension|safari-web-extension):\/\//i;
const UI_CONNECTED_MS = 120_000; // show "connected" in UI if seen in last 2 min
const LIVE_DATA_MS = 12_000; // use extension text for live watch if seen in last 12s

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

function startExtensionBridge({ port = DEFAULT_PORT, onUpdate } = {}) {
  if (server) {
    return {
      port: listenPort,
      getSnapshot: getExtensionPageSnapshot,
      isConnected: isExtensionConnected,
      isLive: isExtensionLive,
      stop: () => {},
    };
  }

  listenPort = port;

  server = http.createServer((req, res) => {
    // --- Anti-DNS-rebinding: require a loopback Host header. ---
    const hostHeader = String(req.headers.host || "").split(":")[0].toLowerCase();
    const hostOk = hostHeader === "127.0.0.1" || hostHeader === "localhost" || hostHeader === "[::1]";

    // --- Origin gate: allow only browser-extension origins (or no Origin,
    // which is what the extension's service-worker fetch and the /welcome tab
    // send). Any http(s) Origin means a normal web page is calling us. ---
    // We deliberately do NOT accept the opaque "null" origin: sandboxed iframes
    // (`<iframe sandbox>` without allow-same-origin), data:/blob: documents, and
    // similar contexts send `Origin: null` and could otherwise POST poisoned
    // page text into LYKN's AI grounding. The real extension sends an EMPTY
    // Origin (verified against background.js), so blocking "null" costs nothing.
    const origin = String(req.headers.origin || "");
    const originOk = origin === "" || EXTENSION_ORIGIN_RE.test(origin);

    if (origin && originOk) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    const path = (req.url || "").split("?")[0];

    // The /welcome page is a same-tab navigation (no Origin, benign HTML) and
    // must stay reachable; everything else requires loopback Host + an allowed
    // (extension or empty) Origin.
    const isWelcome = req.method === "GET" && path === "/welcome";
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

    if (req.method === "GET" && path === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          connected: isExtensionConnected(),
          live: isExtensionLive(),
          at: extensionLastSeenAt,
          port: listenPort,
        }),
      );
      return;
    }

    // NOTE: there is deliberately no HTTP `GET /page`. Captured page text is
    // read only in-process (getExtensionPageSnapshot); exposing it over the
    // socket let any loopback client with an empty Origin read live page text.

    if (req.method === "GET" && path === "/welcome") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(WELCOME_HTML);
      return;
    }

    if (req.method === "POST" && path === "/ping") {
      markExtensionSeen();
      onUpdate?.({ ping: true, at: extensionLastSeenAt });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    if (req.method === "POST" && path === "/page") {
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
              url: String(data.url || ""),
              title: String(data.title || ""),
              text: text.slice(0, 15000),
              sig: String(data.sig || ""),
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
    console.log(`[extension-bridge] listening on 127.0.0.1:${listenPort}`);
  });

  server.on("error", (err) => {
    console.warn("[extension-bridge] server error:", err?.message || err);
  });

  return {
    port: listenPort,
    getSnapshot: getExtensionPageSnapshot,
    isConnected: isExtensionConnected,
    isLive: isExtensionLive,
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
};
