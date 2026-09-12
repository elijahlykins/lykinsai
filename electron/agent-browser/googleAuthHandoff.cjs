"use strict";

/**
 * Google sign-in for the in-app browser.
 *
 * Google refuses accounts.google.com OAuth inside Electron ("This browser or
 * app may not be secure"). Real Chrome / Edge are allowlisted. So interactive
 * Google sign-in is completed in a short-lived system Chrome/Edge window, then
 * the resulting cookies are copied into the agent-browser session and the tab
 * is reloaded already signed in.
 *
 * Cookie-refresh iframes (CheckCookie, RotateCookies, ListAccounts) stay in
 * Electron so a working Gmail session is not yanked out from under the page.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const chromeSync = require("../chromeSync.cjs");

const WAITING_MARK = "lykn-google-auth-waiting";
const AUTH_TIMEOUT_MS = 30 * 60 * 1000;
const CDP_BOOT_MS = 20_000;

function googleAuthHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      /(^|\.)accounts\.google\./.test(host) ||
      /^gsi\.google\./.test(host) ||
      /(^|\.)accounts\.youtube\.com$/.test(host)
    );
  } catch {
    return false;
  }
}

function pathAndQuery(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return String(url || "");
  }
}

/** Background Google cookie plumbing - never a user-facing sign-in. */
function isGoogleAuthPlumbing(url) {
  const p = pathAndQuery(url);
  return /\/(?:CheckCookie|RotateCookies|ListAccounts|PassiveLogin|ServiceLoginAuth)|[?&]passive=true\b|\/gsi\/(?:status|log|iframe)\b/i.test(
    p,
  );
}

function looksLikeInteractiveGoogleSignIn(url) {
  if (!googleAuthHost(url) || isGoogleAuthPlumbing(url)) return false;
  const p = pathAndQuery(url);
  return /\/signin|\/ServiceLogin|\/v3\/signin|\/o\/oauth2|\/gsi\/|\/AccountChooser|\/signin\/oauth|\/lifecycle\/steps|embedded=1|flowName=/i.test(
    p,
  );
}

function isGoogleAuthBlockedPage({ url = "", title = "" } = {}) {
  const u = String(url || "");
  const t = String(title || "");
  if (/\/signin\/rejected|disallowed_useragent/i.test(u)) return true;
  return /may not be secure|couldn'?t sign you in|try using a different browser/i.test(
    `${t}\n${u}`,
  );
}

function isWaitingPage(url) {
  return String(url || "").includes(WAITING_MARK);
}

/**
 * Main-frame / popup interactive Google sign-in (or the explicit rejection
 * page) is handed off. Hidden iframes are not.
 */
function shouldHandoff(url, { isMainFrame = true, isPopup = false } = {}) {
  const u = String(url || "").trim();
  if (!u || isWaitingPage(u) || /^about:blank$/i.test(u) || /^data:/i.test(u)) {
    return false;
  }
  if (isGoogleAuthBlockedPage({ url: u })) return true;
  if (!looksLikeInteractiveGoogleSignIn(u)) return false;
  if (isPopup) return true;
  return isMainFrame !== false;
}

function continueParam(url) {
  try {
    const u = new URL(url);
    for (const key of ["continue", "redirect_uri", "return", "RelayState"]) {
      const raw = u.searchParams.get(key);
      if (!raw) continue;
      const decoded = raw;
      if (/^https?:\/\//i.test(decoded) && !googleAuthHost(decoded)) return decoded;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function returnUrlFor({ authUrl = "", currentUrl = "" } = {}) {
  const cur = String(currentUrl || "").trim();
  if (
    cur &&
    /^https?:\/\//i.test(cur) &&
    !googleAuthHost(cur) &&
    !isWaitingPage(cur)
  ) {
    return cur;
  }
  return continueParam(authUrl) || "";
}

function cdpSameSiteToElectron(v) {
  const s = String(v || "").toLowerCase();
  if (s === "none") return "no_restriction";
  if (s === "lax") return "lax";
  if (s === "strict") return "strict";
  return "unspecified";
}

function cdpCookieToElectron(c) {
  const domain = String(c?.domain || "");
  const bareHost = domain.replace(/^\./, "");
  if (!bareHost || !c?.name) return null;
  const secure = !!c.secure;
  const cookiePath = c.path || "/";
  const out = {
    url: `${secure ? "https" : "http"}://${bareHost}${cookiePath}`,
    name: String(c.name),
    value: String(c.value ?? ""),
    path: cookiePath,
    secure,
    httpOnly: !!c.httpOnly,
    sameSite: cdpSameSiteToElectron(c.sameSite),
  };
  if (domain.startsWith(".")) out.domain = domain;
  const expires = Number(c.expires);
  if (Number.isFinite(expires) && expires > 0) out.expirationDate = expires;
  return out;
}

function waitingPageDataUrl({ missingBrowser = false } = {}) {
  const title = missingBrowser
    ? "Google sign-in needs Chrome or Edge"
    : "Finish signing in with Google";
  const body = missingBrowser
    ? "Google does not allow signing in inside an app browser. Install Chrome or Edge, then try again - or use email and password on this site."
    : "A Chrome window opened. Sign in there - we will bring you back automatically.";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
html,body{height:100%;margin:0;background:#fff;color:#111;
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}
.wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:32px;text-align:center}
h1{font-size:22px;font-weight:600;margin:0 0 8px;letter-spacing:-.02em}
p{margin:0;color:#5c5c5c;max-width:28em}
</style></head>
<body data-${WAITING_MARK}="1"><div class="wrap"><div><h1>${title}</h1><p>${body}</p></div></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function chromiumCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") {
    return [
      {
        name: "Google Chrome",
        binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      {
        name: "Microsoft Edge",
        binary: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      },
      {
        name: "Brave Browser",
        binary: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      },
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || "";
    const pfs = [
      env.PROGRAMFILES || "C:\\Program Files",
      env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
    ];
    const bins = (rel) => [
      local ? path.join(local, ...rel) : "",
      ...pfs.map((pf) => path.join(pf, ...rel)),
    ].filter(Boolean);
    return [
      {
        name: "Google Chrome",
        binaries: bins(["Google", "Chrome", "Application", "chrome.exe"]),
      },
      {
        name: "Microsoft Edge",
        binaries: bins(["Microsoft", "Edge", "Application", "msedge.exe"]),
      },
      {
        name: "Brave Browser",
        binaries: bins(["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
      },
    ];
  }
  return [
    { name: "Google Chrome", binaries: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"] },
    { name: "Microsoft Edge", binaries: ["/usr/bin/microsoft-edge"] },
    { name: "Brave Browser", binaries: ["/usr/bin/brave-browser"] },
  ];
}

function findSystemChromium({ exists = (p) => fs.existsSync(p), platform, env } = {}) {
  for (const cand of chromiumCandidates({ platform, env })) {
    const paths = cand.binary ? [cand.binary] : cand.binaries || [];
    for (const p of paths) {
      if (p && exists(p)) return { name: cand.name, binary: p };
    }
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function sleep(ms, fn = (n) => new Promise((r) => setTimeout(r, n))) {
  return fn(ms);
}

function fetchJson(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        raw += c;
      });
      res.on("end", () => {
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(`cdp http ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("cdp http timeout"));
    });
  });
}

function attachWsMessage(ws, fn) {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener("message", (ev) => fn(String(ev.data || "")));
    return;
  }
  if (typeof ws.on === "function") ws.on("message", (data) => fn(String(data)));
}

function waitWsOpen(ws, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("cdp websocket timeout")), timeoutMs);
    const ok = () => {
      clearTimeout(timer);
      resolve();
    };
    const fail = (err) => {
      clearTimeout(timer);
      reject(err || new Error("cdp websocket error"));
    };
    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", fail, { once: true });
      return;
    }
    if (typeof ws.once === "function") {
      ws.once("open", ok);
      ws.once("error", fail);
      return;
    }
    fail(new Error("cdp websocket unsupported"));
  });
}

async function cdpCall(ws, method, params = {}) {
  const id = (cdpCall.nextId = (cdpCall.nextId || 0) + 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp ${method} timeout`)), 10_000);
    const onMsg = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || `cdp ${method} failed`));
      else resolve(msg.result || {});
    };
    attachWsMessage(ws, onMsg);
    const payload = JSON.stringify({ id, method, params });
    if (typeof ws.send === "function") ws.send(payload);
    else reject(new Error("cdp websocket send missing"));
  });
}

async function readCookiesViaCdp(webSocketDebuggerUrl, deps = {}) {
  if (typeof deps.readCookies === "function") return deps.readCookies();
  const WS = deps.WebSocket || globalThis.WebSocket;
  if (!WS) throw new Error("cdp websocket unavailable");
  const ws = new WS(webSocketDebuggerUrl);
  await waitWsOpen(ws);
  try {
    const result = await cdpCall(ws, "Network.getAllCookies");
    return Array.isArray(result.cookies) ? result.cookies : [];
  } finally {
    try {
      ws.close?.();
    } catch {
      /* ignore */
    }
  }
}

function pickPageTarget(targets) {
  const list = Array.isArray(targets) ? targets : [];
  return (
    list.find((t) => t && t.type === "page" && t.webSocketDebuggerUrl) ||
    list.find((t) => t && t.webSocketDebuggerUrl) ||
    null
  );
}

function stillOnGoogleAuth(url) {
  return googleAuthHost(url) || isGoogleAuthBlockedPage({ url });
}

function stopChromium(child, { platform = process.platform, spawnFn = spawn } = {}) {
  if (!child || child.killed || child.exitCode != null) return;
  try {
    if (platform === "win32" && child.pid) {
      spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

function safeLoad(wc, url) {
  if (!wc || wc.isDestroyed?.() || !url) return;
  try {
    wc.loadURL(url);
  } catch {
    /* ignore */
  }
}

function safeReload(wc) {
  if (!wc || wc.isDestroyed?.()) return;
  try {
    if (typeof wc.reload === "function") wc.reload();
  } catch {
    /* ignore */
  }
}

function createHandoffRuntime(deps = {}) {
  const state = {
    running: false,
    waiters: [],
    idle: Promise.resolve(),
    coolUntil: 0,
  };

  function reset() {
    state.running = false;
    state.waiters = [];
    state.idle = Promise.resolve();
    state.coolUntil = 0;
  }

  function loadWaiting(waiter, { missingBrowser = false } = {}) {
    const page = waitingPageDataUrl({ missingBrowser });
    const target = waiter?.popupWindow?.webContents || waiter?.wc;
    safeLoad(target, page);
  }

  async function finishWaiters({ ok, returnUrl, missingBrowser }) {
    const waiters = state.waiters.splice(0, state.waiters.length);
    for (const w of waiters) {
      if (missingBrowser) loadWaiting(w, { missingBrowser: true });
      try {
        w.popupWindow?.close?.();
      } catch {
        /* ignore */
      }
      if (!ok) continue;
      const dest = w.returnUrl || returnUrl;
      if (dest) safeLoad(w.wc, dest);
      else safeReload(w.wc);
    }
  }

  async function waitForAuthPage(port, child, startedAt) {
    const fetchList = deps.fetchJson || fetchJson;
    const pause = (ms) => sleep(ms, deps.sleep);
    let sawAuth = false;
    while (Date.now() - startedAt < AUTH_TIMEOUT_MS) {
      if (child.exitCode != null || child.killed) return { closed: true };
      let targets = [];
      try {
        targets = await fetchList(`http://127.0.0.1:${port}/json/list`);
      } catch {
        await pause(400);
        continue;
      }
      const page = pickPageTarget(targets);
      const url = String(page?.url || "");
      if (stillOnGoogleAuth(url)) sawAuth = true;
      const landed =
        page?.webSocketDebuggerUrl &&
        /^https?:\/\//i.test(url) &&
        !stillOnGoogleAuth(url);
      // Already-signed-in profiles can skip the Google UI entirely.
      if (landed && (sawAuth || Date.now() - startedAt > 2500)) {
        return { ok: true, url, webSocketDebuggerUrl: page.webSocketDebuggerUrl };
      }
      await pause(500);
    }
    return { timeout: true };
  }

  async function run(opts) {
    const authUrl = String(opts.authUrl || "").trim();
    const session = opts.session;
    const userDataPath = String(opts.userDataPath || "");
    const findBinary = deps.findBinary || findSystemChromium;
    const spawnFn = deps.spawn || spawn;
    const portFn = deps.getFreePort || getFreePort;

    const browser = findBinary();
    if (!browser?.binary) {
      await finishWaiters({ ok: false, missingBrowser: true });
      return { ok: false, error: "no_chromium" };
    }

    for (const w of state.waiters) {
      const cur = String(w.currentUrl || opts.currentUrl || "");
      if (
        w.popupWindow ||
        looksLikeInteractiveGoogleSignIn(cur) ||
        isGoogleAuthBlockedPage({ url: cur })
      ) {
        loadWaiting(w);
      }
    }

    const port = await portFn();
    const profileDir = path.join(
      userDataPath || path.join(os.tmpdir(), "lykn-google-auth"),
      "google-auth-browser",
    );
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      `--window-size=560,740`,
      authUrl,
    ];
    const child = spawnFn(browser.binary, args, {
      stdio: "ignore",
      windowsHide: false,
    });
    const startedAt = Date.now();
    try {
      const bootDeadline = Date.now() + CDP_BOOT_MS;
      const fetchList = deps.fetchJson || fetchJson;
      let ready = false;
      while (Date.now() < bootDeadline) {
        try {
          await fetchList(`http://127.0.0.1:${port}/json/version`);
          ready = true;
          break;
        } catch {
          if (child.exitCode != null) break;
          await sleep(250, deps.sleep);
        }
      }
      if (!ready) {
        await finishWaiters({ ok: false, missingBrowser: false });
        return { ok: false, error: "cdp_unavailable" };
      }

      const done = await waitForAuthPage(port, child, startedAt);
      if (!done?.ok || !done.webSocketDebuggerUrl) {
        await finishWaiters({ ok: false });
        return { ok: false, error: done?.closed ? "cancelled" : "timeout" };
      }

      const rawCookies = await readCookiesViaCdp(done.webSocketDebuggerUrl, deps);
      const cookies = rawCookies.map(cdpCookieToElectron).filter(Boolean);
      const importFn = deps.importCookies || ((sess, list) =>
        chromeSync.importCookiesToSession(sess, list, { replaceGoogle: true }));
      const imported = session
        ? await importFn(session, cookies)
        : { imported: 0 };
      console.log(
        `[google-auth-handoff] imported ${imported?.imported || 0} cookies from ${browser.name}`,
      );
      await finishWaiters({ ok: true, returnUrl: done.url });
      state.coolUntil = Date.now() + 12_000;
      return { ok: true, imported: imported?.imported || 0 };
    } catch (err) {
      console.warn("[google-auth-handoff]", err?.message || err);
      await finishWaiters({ ok: false });
      return { ok: false, error: String(err?.message || err) };
    } finally {
      stopChromium(child, { spawnFn: deps.killSpawn || spawnFn, platform: deps.platform });
    }
  }

  function start(opts) {
    const blocked = isGoogleAuthBlockedPage({ url: opts?.authUrl });
    if (!blocked && Date.now() < state.coolUntil) return false;
    const waiter = opts?.waiter;
    if (waiter) {
      waiter.currentUrl = waiter.currentUrl || opts.currentUrl || "";
      state.waiters.push(waiter);
    }
    if (state.running) return true;
    state.running = true;
    state.idle = run(opts)
      .catch((err) => {
        console.warn("[google-auth-handoff]", err?.message || err);
        return { ok: false, error: String(err?.message || err) };
      })
      .finally(() => {
        state.running = false;
      });
    return true;
  }

  return {
    start,
    reset,
    waitForIdle: () => state.idle,
    get running() {
      return state.running;
    },
  };
}

const defaultRuntime = createHandoffRuntime();

function start(opts) {
  return defaultRuntime.start(opts);
}

function resetForTests() {
  defaultRuntime.reset();
}

module.exports = {
  WAITING_MARK,
  googleAuthHost,
  isGoogleAuthPlumbing,
  looksLikeInteractiveGoogleSignIn,
  isGoogleAuthBlockedPage,
  isWaitingPage,
  shouldHandoff,
  continueParam,
  returnUrlFor,
  cdpCookieToElectron,
  waitingPageDataUrl,
  chromiumCandidates,
  findSystemChromium,
  createHandoffRuntime,
  start,
  resetForTests,
};
