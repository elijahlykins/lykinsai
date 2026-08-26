"use strict";

function attachBrowserAutomation(d) {
  if (d.__attached_attachBrowserAutomation) return;
  d.__attached_attachBrowserAutomation = true;
  const {
    app, BrowserWindow, WebContentsView, shell, globalShortcut, Menu, ipcMain,
    desktopCapturer, screen, systemPreferences, dialog, nativeImage, clipboard,
    Tray, session, Notification, powerMonitor, nativeTheme, protocol,
    net: electronNet,
  } = d.electron;
  const path = d.node.path;
  const { pathToFileURL } = d.node.url;
  const fs = d.node.fs;
  const fsSync = d.node.fsSync;
  const crypto = d.node.crypto;
  const http = d.node.http;
  const { execFile } = d.node.childProcess;
  const { IS_MAC, IS_WIN, GLASS_FALLBACK, APP_URL, APP_ORIGIN, API_BASE } = d.env;
  const localStore = d.localStore;
  const macFiles = d.macFiles;
  const chromeSync = d.chromeSync;
  const localSystem = d.localSystem;
  const appDock = d.appDock;
  const localApprovals = d.localApprovals;
  const ownedBrowserAct = d.ownedBrowserAct;
  const agentRecentVisits = d.agentRecentVisits;
  const { broadcastToAllWindows } = require("../services/initializeElectronServices.cjs");
  const overlayConstants = d.constants;
  const {
    OVERLAY_WIDTH, OVERLAY_SIDE_WIDTH, OVERLAY_WATCH_SIDE_WIDTH, OVERLAY_MAX_WIDTH,
    OVERLAY_MIN_HEIGHT, OVERLAY_BOTTOM_MARGIN, GLASS_CORNER_RADIUS, OVERLAY_BUBBLE,
    OVERLAY_ACTIVATABLE_FOR_DROPS, MENU_WIDTH, MENU_GAP, MENU_MIN_HEIGHT, MENU_MAX_HEIGHT,
    PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT, LIVE_WIDTH, LIVE_HEIGHT,
    PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, UPDATE_REPROMPT_MS,
  } = overlayConstants;
  const ELECTRON_DIR = path.join(__dirname, "..");
  const safeFetchMain = (...a) => d.safeFetchMain(...a);
  const assertPublicHttpUrl = (...a) => d.assertPublicHttpUrl(...a);
  const openExternalSafe = (...a) => d.openExternalSafe(...a);
  const getAuthToken = (...a) => d.getAuthToken(...a);
  const isAutomationDeniedError = (...a) => d.isAutomationDeniedError(...a);
  const withPermissionPrompt = (...a) => d.withPermissionPrompt(...a);

const READ_FULL_PAGE_TEXT_JS =
  "(function(){var root=document.querySelector('main')||document.querySelector('article')||document.body;" +
  "var raw=(document.title||'')+String.fromCharCode(10)+(root?(root.innerText||root.textContent||''):'');" +
  "var t=(''+raw).split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(13)).join(' ')" +
  ".split(String.fromCharCode(9)).join(' ');" +
  "while(t.indexOf('  ')>=0)t=t.split('  ').join(' ');t=t.trim().slice(0,24000);" +
  "return btoa(unescape(encodeURIComponent(JSON.stringify({t:t,y:Math.floor(window.scrollY||0)," +
  "h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)||0," +
  "vh:Math.floor(window.innerHeight||800)}))));})()";

function runOsascript(script, timeout = 4000) {
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

async function listRunningBrowserApps() {
  if (d.automationOk.systemEvents === false) return [];

  const listLiteral = `{${d.BROWSER_APP_NAMES.map((n) => `"${n}"`).join(", ")}}`;
  // Match running *process* names — never `tell application "Arc"` unless Arc is
  // actually open. Probing every app in the allowlist triggers macOS "Where is Arc?"
  // file-picker dialogs for browsers that aren't installed.
  const pickScript = `
tell application "System Events"
  set procNames to name of every process
end tell
set allBrowsers to ${listLiteral}
set out to ""
repeat with b in allBrowsers
  if procNames contains (b as string) then
    if out is "" then
      set out to (b as string)
    else
      set out to out & "|" & (b as string)
    end if
  end if
end repeat
return out
`;
  const runPick = () => runOsascript(pickScript, 8000);
  const pick =
    d.automationOk.systemEvents === true
      ? await runPick()
      : await withPermissionPrompt("automation:system-events", runPick);
  if (pick.error) {
    console.log("[scrape] browser-detect error:", pick.error);
    if (isAutomationDeniedError(pick.error)) {
      d.automationOk.systemEvents = false;
      console.log(
        "[scrape] → Grant Automation permission: System Settings → Privacy & " +
          "Security → Automation → enable System Events for LYKN/Electron.",
      );
    }
    return [];
  }
  d.automationOk.systemEvents = true;
  return String(pick.out || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readBrowserFrontTabUrl(appName, { anyScheme = false, allowPrompt = true } = {}) {
  if (d.automationOk.browsers[appName] === false) return null;

  const accept = (u) => {
    const url = String(u || "").trim();
    if (!url) return null;
    if (anyScheme) return url;
    return /^https?:\/\//i.test(url) ? url : null;
  };
  const isSafari = /^Safari/.test(appName);
  const script = isSafari
    ? `tell application "${appName}" to get URL of current tab of front window`
    : `tell application "${appName}" to get URL of active tab of front window`;

  const run = () => runOsascript(script, 6000);
  // Known-allowed browsers skip the mutex; first contact (or unknown) is serialized.
  const r =
    d.automationOk.browsers[appName] === true || !allowPrompt
      ? await run()
      : await withPermissionPrompt(`automation:${appName}`, run);

  if (r.error) {
    console.log(`[scrape] url-read error (${appName}):`, r.error);
    if (isAutomationDeniedError(r.error)) {
      d.automationOk.browsers[appName] = false;
      console.log(`[scrape] → Grant Automation permission for ${appName} under LYKN/Electron.`);
    }
    return null;
  }
  d.automationOk.browsers[appName] = true;
  return accept(r.out);
}

async function readBrowserTabUrl(appName, { anyScheme = false, allowPrompt = true } = {}) {
  if (d.automationOk.browsers[appName] === false) return null;

  const front = await readBrowserFrontTabUrl(appName, { anyScheme, allowPrompt });
  if (front) return front;
  if (/^Safari/.test(appName)) return null;

  const accept = (u) => {
    const url = String(u || "").trim();
    if (!url) return null;
    if (anyScheme) return url;
    return /^https?:\/\//i.test(url) ? url : null;
  };
  // Follow-up window walk: only after front-tab already marked this browser allowed
  // (or we're retrying without a new prompt). Avoids a second Allow dialog.
  if (d.automationOk.browsers[appName] !== true && allowPrompt) return null;

  const r = await runOsascript(
    `tell application "${appName}"
      if (count of windows) is 0 then return ""
      repeat with w in windows
        try
          set u to URL of active tab of w
          if u is not "" then return u
        end try
      end repeat
      return ""
    end tell`,
    6000,
  );
  if (r.error) {
    console.log(`[scrape] url-read error (${appName}):`, r.error);
    if (isAutomationDeniedError(r.error)) {
      d.automationOk.browsers[appName] = false;
    }
    return null;
  }
  d.automationOk.browsers[appName] = true;
  const url = accept(r.out);
  if (url) return url;
  if (anyScheme && String(r.out || "").trim()) return String(r.out).trim();
  return null;
}

function rankBrowserCandidates(candidates) {
  let pool = candidates.slice();
  const hasMainBrowser = pool.some((n) => !d.DEPRIORITIZED_BROWSERS.has(n));
  if (hasMainBrowser) {
    pool = pool.filter((n) => !d.DEPRIORITIZED_BROWSERS.has(n));
  }
  pool.sort(
    (a, b) => (d.BROWSER_PICK_PRIORITY[b] ?? 40) - (d.BROWSER_PICK_PRIORITY[a] ?? 40),
  );
  return pool;
}

function pickBestBrowserTarget(targets) {
  if (!targets.length) return null;
  const ranked = rankBrowserCandidates(targets.map((t) => t.appName));
  const order = new Map(ranked.map((name, i) => [name, i]));
  return targets.slice().sort((a, b) => (order.get(a.appName) ?? 99) - (order.get(b.appName) ?? 99))[0];
}

async function resolveOneBrowserHttpTarget(candidates, { frontWindowOnly = false } = {}) {
  const ranked = rankBrowserCandidates(candidates).filter(
    (name) => d.automationOk.browsers[name] !== false,
  );
  if (!ranked.length) return null;

  // Prefer browsers already allowed this session (no new dialog).
  const known = ranked.filter((name) => d.automationOk.browsers[name] === true);
  const unknown = ranked.filter((name) => d.automationOk.browsers[name] !== true);
  const tryOrder = [...known, ...unknown];

  let promptedUnknown = false;
  for (const appName of tryOrder) {
    const alreadyOk = d.automationOk.browsers[appName] === true;
    if (!alreadyOk && promptedUnknown) break;
    if (!alreadyOk) promptedUnknown = true;

    const url = frontWindowOnly
      ? await readBrowserFrontTabUrl(appName, { allowPrompt: !alreadyOk })
      : await readBrowserTabUrl(appName, { allowPrompt: !alreadyOk });
    if (url) return { appName, url };

    // Denied mid-attempt — do not immediately blast the next browser.
    if (d.automationOk.browsers[appName] === false) break;
    // Unknown prompt burned with no URL — stop; next user action can try another.
    if (!alreadyOk) break;
  }
  return null;
}

async function listBrowserHttpTargets({ frontWindowOnly = false } = {}) {
  const candidates = await listRunningBrowserApps();
  const one = await resolveOneBrowserHttpTarget(candidates, { frontWindowOnly });
  return one ? [one] : [];
}

async function describeBrowserTabProblem() {
  const candidates = await listRunningBrowserApps();
  if (!candidates.length) {
    return {
      error: "no_browser",
      message: "Open Chrome (or another browser) with a website loaded, then try again.",
    };
  }
  // One browser only — same fan-out guard as Glass scrape.
  const httpTarget = await resolveOneBrowserHttpTarget(candidates, { frontWindowOnly: false });
  if (httpTarget?.url) return null;
  const ranked = rankBrowserCandidates(candidates).filter(
    (name) => d.automationOk.browsers[name] !== false,
  );
  const probe = ranked.find((name) => d.automationOk.browsers[name] === true) || ranked[0];
  if (probe) {
    const raw = await readBrowserTabUrl(probe, {
      anyScheme: true,
      allowPrompt: d.automationOk.browsers[probe] !== true,
    });
    if (raw && /^(chrome|about|edge|brave|arc):/i.test(raw)) {
      return {
        error: "new_tab",
        message:
          "This tab is a blank new-tab page, so there's nothing to click or type on yet. " +
          "Go to a real site first (e.g. youtube.com or google.com), then try again.",
      };
    }
  }
  return {
    error: "no_browser",
    message:
      "No usable browser tab found. Open an https:// page (not chrome://newtab), then try again.",
  };
}

async function getActiveBrowserTarget() {
  const ext = d.extensionBridge?.getSnapshot?.(12_000);
  if (ext?.url && /^https?:/i.test(ext.url)) {
    console.log(`[scrape] active tab via extension: ${ext.url}`);
    return {
      appName: "Google Chrome",
      url: ext.url,
      title: ext.title || "",
      source: "extension",
    };
  }

  if (!IS_MAC) {
    console.log("[scrape] no extension tab (Windows needs Chrome Live Feed for live page text)");
    return null;
  }

  // Two-step so the AppleScript always compiles:
  //   1) list running browsers (System Events — at most one Automation prompt),
  //   2) read URL from one preferred browser (at most one more Allow dialog).
  if (d.automationOk.systemEvents === false) {
    console.log("[scrape] System Events Automation previously denied — skip AppleScript");
    return null;
  }
  const candidates = await listRunningBrowserApps();
  if (!candidates.length) {
    console.log("[scrape] no browser frontmost or running");
    return null;
  }
  // Prefer front-window tabs; if those are empty, widen to any window on the
  // same already-allowed browser (no second Allow dialog).
  let best = await resolveOneBrowserHttpTarget(candidates, { frontWindowOnly: true });
  if (!best && candidates.some((n) => d.automationOk.browsers[n] === true)) {
    best = await resolveOneBrowserHttpTarget(candidates, { frontWindowOnly: false });
  }
  if (!best) {
    console.log("[scrape] browsers running but none have an http(s) tab:", candidates.join(", "));
    return null;
  }
  console.log(`[scrape] active browser URL: ${best.url} (${best.appName})`);
  return best;
}

async function evalBrowserJs(appName, js, timeoutMs = 6000) {
  if (!IS_MAC || !appName) return { error: "unsupported" };
  if (d.automationOk.browsers[appName] === false) return { error: "automation_denied" };
  const isSafari = /^Safari/.test(appName);
  const script = isSafari
    ? `tell application "${appName}" to do JavaScript "${js}" in current tab of front window`
    : `tell application "${appName}" to execute active tab of front window javascript "${js}"`;
  const run = () => runOsascript(script, timeoutMs);
  const r =
    d.automationOk.browsers[appName] === true
      ? await run()
      : await withPermissionPrompt(`automation-dom:${appName}`, run);
  if (r.error) {
    if (isAutomationDeniedError(r.error)) {
      d.automationOk.browsers[appName] = false;
    }
    return { error: r.error };
  }
  d.automationOk.browsers[appName] = true;
  return { out: (r.out || "").trim() };
}

async function getBrowserPageText(appName) {
  const ext = d.extensionBridge?.getSnapshot?.(12_000);
  if (ext?.text && ext.text.length > 40) {
    const title = String(ext.title || "").trim();
    const body = String(ext.text || "").trim();
    return title ? `${title}\n${body}` : body;
  }

  // No double quotes or backslashes in this JS so it embeds cleanly in the
  // AppleScript double-quoted string (AppleScript treats \n etc. as escapes).
  const js =
    "(function(){var e=document.querySelector('article')||document.querySelector('main')||document.body;" +
    "var t=(document.title||'')+String.fromCharCode(10)+(e?e.innerText:'');return t.slice(0,15000);})()";
  const r = await evalBrowserJs(appName, js, 6000);
  if (r.error) {
    if (/turned off|not allowed|Allow JavaScript|Apple Events/i.test(String(r.error))) {
      console.log(
        `[scrape] live-DOM read off for ${appName} — enable "Allow JavaScript from ` +
          `Apple Events" (Chrome: View → Developer). Falling back to HTTP fetch.`,
      );
    } else if (r.error !== "automation_denied" && r.error !== "unsupported") {
      console.log(`[scrape] live-DOM read error (${appName}):`, r.error);
    }
    return null;
  }
  const out = String(r.out || "").trim();
  return out.length > 40 ? out : null;
}

function decodeBrowserJsPayload(out) {
  if (!out) return null;
  try {
    const json = Buffer.from(String(out).trim(), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function readBrowserFullPageTextOnce(appName) {
  const r = await evalBrowserJs(appName, READ_FULL_PAGE_TEXT_JS, 8000);
  if (r.error || !r.out) return { error: r.error || "empty", text: "", y: 0, h: 0, vh: 800 };
  const payload = decodeBrowserJsPayload(r.out);
  if (!payload || typeof payload.t !== "string") {
    // Fallback: plain string (older path / non-base64).
    const plain = String(r.out || "").trim();
    return { text: plain, y: 0, h: 0, vh: 800 };
  }
  return {
    text: String(payload.t || "").trim(),
    y: Number(payload.y) || 0,
    h: Number(payload.h) || 0,
    vh: Math.max(Number(payload.vh) || 800, 400),
  };
}

async function getBrowserFullPageText(appName) {
  if (!IS_MAC || !appName) return null;
  if (d.automationOk.browsers[appName] === false) return null;

  const snap = await readBrowserFullPageTextOnce(appName);
  if (snap.error && !snap.text) {
    if (snap.error !== "automation_denied" && snap.error !== "unsupported") {
      console.log(`[scrape] full-page read error (${appName}):`, snap.error);
    }
    return getBrowserPageText(appName);
  }
  if (snap.text && snap.text.length > 40) {
    console.log(`[scrape] OK (full-page text) — ${snap.text.length} chars`);
    return snap.text;
  }
  return getBrowserPageText(appName);
}

async function navigateBrowserTab(appName, url) {
  if (!IS_MAC || !appName || !url) return { ok: false, error: "unsupported" };
  if (d.automationOk.browsers[appName] === false) return { ok: false, error: "automation_denied" };
  const safeUrl = String(url).trim().replace(/"/g, "");
  if (!/^https?:\/\//i.test(safeUrl)) return { ok: false, error: "invalid_url" };
  const isSafari = /^Safari/.test(appName);
  const script = isSafari
    ? `tell application "${appName}" to set URL of current tab of front window to "${safeUrl}"`
    : `tell application "${appName}" to set URL of active tab of front window to "${safeUrl}"`;
  const run = () => runOsascript(script, 6000);
  const r =
    d.automationOk.browsers[appName] === true
      ? await run()
      : await withPermissionPrompt(`automation-nav:${appName}`, run);
  if (r.error) {
    if (isAutomationDeniedError(r.error)) d.automationOk.browsers[appName] = false;
    return { ok: false, error: r.error };
  }
  d.automationOk.browsers[appName] = true;
  return { ok: true };
}

async function waitForBrowserUrl(appName, wantUrl, { timeoutMs = 9000 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let wantPath = "";
  try {
    wantPath = new URL(wantUrl).pathname.replace(/\/$/, "") || "/";
  } catch {
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = await readBrowserFrontTabUrl(appName, { allowPrompt: false });
    if (cur) {
      try {
        const p = new URL(cur).pathname.replace(/\/$/, "") || "/";
        if (p === wantPath) return true;
      } catch {
        /* keep waiting */
      }
    }
    await sleep(250);
  }
  return false;
}

function resolveLinkedSitePage(userText, currentUrl, history) {
  let t = String(userText || "").trim();
  if (!t) return null;
  if (/^(ok[,.]?\s+)?(check|look at|review|open|see|read)\s+it[.!?]*$/i.test(t) && Array.isArray(history)) {
    const recent = history
      .slice(-8)
      .map((h) => String(h?.content || h?.text || h?.message || ""))
      .join(" ");
    t = `${recent} ${t}`;
  }
  let origin = "";
  let currentPath = "";
  try {
    const u = new URL(String(currentUrl || "").trim());
    if (!/^https?:$/i.test(u.protocol)) return null;
    origin = u.origin;
    currentPath = u.pathname.replace(/\/$/, "") || "/";
  } catch {
    return null;
  }

  const aliases = [
    {
      path: "/download",
      re: /\b(?:download(?:s)?\s+page|page\s+for\s+downloads?|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?download(?:s)?(?:\s+page)?)\b/i,
    },
    {
      path: "/pricing",
      re: /\b(?:pricing\s+page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?pricing(?:\s+page)?)\b/i,
    },
    {
      path: "/news",
      re: /\b(?:news\s+page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?(?:news|blog)(?:\s+page)?)\b/i,
    },
    {
      path: "/support",
      re: /\b(?:support\s+page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?support(?:\s+page)?)\b/i,
    },
    {
      path: "/privacy",
      re: /\b(?:privacy\s+(?:page|policy)|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?privacy(?:\s+(?:page|policy))?)\b/i,
    },
    {
      path: "/terms",
      re: /\b(?:terms(?:\s+of\s+service)?\s+page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?terms(?:\s+of\s+service)?)\b/i,
    },
    {
      path: "/",
      re: /\b(?:home\s*page|landing\s*page|(?:check|review|open|visit|go to|look at|see|read)\s+(?:the\s+)?(?:home|landing)(?:\s+page)?)\b/i,
    },
  ];

  for (const a of aliases) {
    if (!a.re.test(t)) continue;
    const normalized = a.path.replace(/\/$/, "") || "/";
    if (normalized === currentPath) return null;
    return a.path === "/" ? `${origin}/` : `${origin}${a.path}`;
  }

  const pathHit = t.match(
    /\b(?:https?:\/\/(?:www\.)?lykn\.io)?(\/(?:download|pricing|news|support|privacy|terms|product)(?:\/[\w-]*)?)\b/i,
  );
  if (pathHit) {
    const p = pathHit[1].replace(/\/$/, "") || "/";
    if (p === currentPath) return null;
    try {
      return new URL(pathHit[1], origin).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function decodeHtmlEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return "";
      }
    });
}

async function scrapePageText(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    let res;
    try {
      // SSRF-safe: DNS + private-IP deny, re-check every redirect hop.
      res = await safeFetchMain(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return null;
    const ctype = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null;

    let html = await res.text();
    const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleM ? decodeHtmlEntities(titleM[1]).replace(/\s+/g, " ").trim() : "";

    // Strip non-content elements before extracting text.
    html = html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");

    // Prefer the main article body when the page marks one up.
    const main =
      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
      html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const source = main ? main[1] : html;

    const text = decodeHtmlEntities(
      source
        .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .replace(/^[ \t]+|[ \t]+$/gm, "")
      .trim();

    if (!text) return null;
    return { url, title, text: text.slice(0, 12000) };
  } catch {
    return null;
  }
}

function parseYouTubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) return m[2];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

async function getBrowserYouTubeTranscript(appName) {
  if (!appName) return null;
  const isSafari = /^Safari/.test(appName);
  const wrap = (js) =>
    isSafari
      ? `tell application "${appName}" to do JavaScript "${js}" in current tab of front window`
      : `tell application "${appName}" to execute active tab of front window javascript "${js}"`;

  // No double quotes or backslashes in this JS (it embeds in an AppleScript
  // double-quoted string). json3 captions parse cleanly into events[].segs[].
  const kick =
    "(function(){try{var r=window.ytInitialPlayerResponse;" +
    "var tt=r&&r.captions&&r.captions.playerCaptionsTracklistRenderer&&r.captions.playerCaptionsTracklistRenderer.captionTracks;" +
    "if(!tt||!tt.length){window.__lyknYT={status:'notracks'};return 'notracks';}" +
    "var en=tt.filter(function(t){return /^en/i.test(t.languageCode||'')&&t.kind!=='asr';});" +
    "var en2=tt.filter(function(t){return /^en/i.test(t.languageCode||'');});" +
    "var pick=en[0]||en2[0]||tt[0];var u=pick.baseUrl;" +
    "if(u.indexOf('fmt=')<0){u+=(u.indexOf('?')<0?'?':'&')+'fmt=json3';}" +
    "window.__lyknYT={status:'loading',title:document.title};" +
    "fetch(u).then(function(x){return x.text();}).then(function(txt){var out='';" +
    "try{var j=JSON.parse(txt);if(j&&j.events){out=j.events.map(function(e){return (e.segs||[]).map(function(s){return s.utf8||'';}).join('');}).join(' ');}}catch(e){out=txt;}" +
    "window.__lyknYT={status:'done',title:document.title,text:(out||'').slice(0,20000)};})" +
    ".catch(function(e){window.__lyknYT={status:'error'};});return 'started';}" +
    "catch(e){window.__lyknYT={status:'error'};return 'error';}})()";

  const start = await runOsascript(wrap(kick), 6000);
  if (start.error) {
    if (/turned off|Allow JavaScript|Apple Events/i.test(start.error)) {
      console.log(
        `[scrape] yt: live-DOM JS off for ${appName} — enable "Allow JavaScript from Apple Events".`,
      );
    } else {
      console.log("[scrape] yt kick error:", start.error);
    }
    return null;
  }
  if (/notracks|^error$/.test((start.out || "").trim())) return null;

  const pollJs =
    "(function(){try{return JSON.stringify(window.__lyknYT||null);}catch(e){return '';}})()";
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 350));
    const p = await runOsascript(wrap(pollJs), 4000);
    if (p.error || !p.out) continue;
    let obj = null;
    try {
      obj = JSON.parse(p.out);
    } catch {
      continue;
    }
    if (!obj) continue;
    if (obj.status === "done" && obj.text) {
      const text = String(obj.text).replace(/\s+/g, " ").trim();
      if (text) return { title: obj.title || "", text: text.slice(0, 16000) };
      return null;
    }
    if (obj.status === "error" || obj.status === "notracks") return null;
  }
  return null;
}

function parseYouTubeCaptionBody(body) {
  const raw = String(body || "").trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.events)) {
      const text = j.events
        .map((e) => (e.segs || []).map((s) => s.utf8 || "").join(""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text;
    }
  } catch {
    /* not json3 — try XML below */
  }
  const parts = [...raw.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
    decodeHtmlEntities(m[1].replace(/<[^>]+>/g, " ")),
  );
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function overlayMessageWantsVideoTranscribe(msg) {
  const t = String(msg || "");
  if (!t.trim()) return false;
  return (
    /\b(?:transcribe(?:\s+(?:this|the|it|video|audio|that))?|transcription)\b/i.test(t) ||
    /\b(?:full\s+transcript|(?:get|fetch|pull|download|grab)\s+(?:me\s+)?(?:the\s+)?transcript)\b/i.test(t) ||
    /\b(?:from\s+(?:the\s+)?(?:spoken\s+)?audio|whisper\s+(?:it|this|the\s+video))\b/i.test(t)
  );
}

async function fetchYouTubeTranscriptViaApi(videoId, { onStatus, allowWhisper } = {}) {
  const token = await getAuthToken().catch(() => null);
  if (!token) {
    console.log("[scrape] yt api transcript skipped — no auth token");
    return null;
  }
  const headers = { Authorization: `Bearer ${token}` };
  const pull = async (qs, status) => {
    if (status) {
      try { onStatus?.(status); } catch { /* ignore */ }
    }
    const res = await fetch(
      `${API_BASE}/api/youtube/transcript?id=${encodeURIComponent(videoId)}${qs}`,
      { headers },
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.log(
        `[scrape] yt api transcript HTTP ${res.status}:`,
        errBody?.error || res.statusText,
      );
      return null;
    }
    return res.json().catch(() => null);
  };

  try {
    // Fast captions-only pass first.
    let data = await pull("&fast=1", "Reading the video transcript…");
    let text = String(data?.transcript || "").trim();
    let source = String(data?.source || "").toLowerCase();

    // Whisper only when the user explicitly asked — never auto on caption miss.
    if (
      allowWhisper &&
      (!text || source === "description_fallback") &&
      source !== "whisper_full"
    ) {
      data = await pull(
        "&retryWhisper=1",
        "No captions found — transcribing the video audio…",
      );
      text = String(data?.transcript || "").trim();
      source = String(data?.source || "").toLowerCase();
    } else if (
      !allowWhisper &&
      (!text || source === "description_fallback")
    ) {
      console.log("[scrape] yt api: no captions — skipping Whisper (not requested)");
    }

    // Still only a description → don't pretend we have spoken content.
    if (!text || source === "description_fallback") return null;

    return {
      title: "",
      text: text.slice(0, 16000),
      source,
    };
  } catch (e) {
    console.log("[scrape] yt api transcript error:", e?.message || e);
    return null;
  }
}

async function fetchYouTubeTranscript(videoId, appName, { onStatus, allowWhisper } = {}) {
  const inPage = await getBrowserYouTubeTranscript(appName);
  if (inPage && inPage.text) {
    console.log("[scrape] yt transcript via live tab");
    return inPage;
  }

  let title = "";
  let tracks = null;

  // 1) Live tab — most reliable (bypasses YouTube's bot checks).
  if (appName && !/^Safari/.test(appName)) {
    const js =
      "(function(){try{var r=window.ytInitialPlayerResponse;" +
      "var t=r&&r.captions&&r.captions.playerCaptionsTracklistRenderer&&r.captions.playerCaptionsTracklistRenderer.captionTracks;" +
      "return JSON.stringify({title:document.title,tracks:t||[]});}catch(e){return '';}})()";
    const r = await runOsascript(
      `tell application "${appName}" to execute active tab of front window javascript "${js}"`,
      6000,
    );
    if (!r.error && r.out) {
      try {
        const parsed = JSON.parse(r.out);
        title = parsed.title || "";
        if (Array.isArray(parsed.tracks) && parsed.tracks.length) tracks = parsed.tracks;
      } catch {
        /* ignore */
      }
    }
  }

  // 2) Fallback: fetch the watch page HTML and regex out the caption tracks.
  if (!tracks) {
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      const html = await res.text();
      if (!title) {
        const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (tm) title = decodeHtmlEntities(tm[1]).replace(/\s*-\s*YouTube\s*$/, "").trim();
      }
      const m = html.match(/"captionTracks":(\[.*?\])(?:,"audioTracks"|,"translationLanguages"|\})/);
      if (m) {
        try {
          tracks = JSON.parse(m[1].replace(/\\u0026/g, "&"));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (Array.isArray(tracks) && tracks.length) {
    // Prefer a manually-authored English track, then any English, then the first.
    const pick =
      tracks.find((t) => /^en/i.test(t.languageCode || "") && t.kind !== "asr") ||
      tracks.find((t) => /^en/i.test(t.languageCode || "")) ||
      tracks[0];
    let baseUrl = pick && pick.baseUrl;
    if (baseUrl) {
      baseUrl = baseUrl.replace(/\\u0026/g, "&");
      if (baseUrl.indexOf("fmt=") < 0) {
        baseUrl += (baseUrl.indexOf("?") < 0 ? "?" : "&") + "fmt=json3";
      }
      try {
        const res = await fetch(baseUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        const text = parseYouTubeCaptionBody(await res.text());
        if (text) {
          console.log("[scrape] yt transcript via timedtext");
          return { title, text: text.slice(0, 16000) };
        }
      } catch {
        /* fall through to API */
      }
    }
  }

  // 3) LYKN backend captions (fast). Whisper only if the user asked to transcribe.
  const viaApi = await fetchYouTubeTranscriptViaApi(videoId, { onStatus, allowWhisper });
  if (viaApi && viaApi.text) {
    console.log(`[scrape] yt transcript via API (${viaApi.source || "unknown"})`);
    if (title && !viaApi.title) viaApi.title = title;
    return viaApi;
  }

  return title ? { title, text: "" } : null;
}

  d.runOsascript = runOsascript;
  d.listRunningBrowserApps = listRunningBrowserApps;
  d.readBrowserFrontTabUrl = readBrowserFrontTabUrl;
  d.readBrowserTabUrl = readBrowserTabUrl;
  d.rankBrowserCandidates = rankBrowserCandidates;
  d.pickBestBrowserTarget = pickBestBrowserTarget;
  d.resolveOneBrowserHttpTarget = resolveOneBrowserHttpTarget;
  d.listBrowserHttpTargets = listBrowserHttpTargets;
  d.describeBrowserTabProblem = describeBrowserTabProblem;
  d.getActiveBrowserTarget = getActiveBrowserTarget;
  d.evalBrowserJs = evalBrowserJs;
  d.getBrowserPageText = getBrowserPageText;
  d.decodeBrowserJsPayload = decodeBrowserJsPayload;
  d.readBrowserFullPageTextOnce = readBrowserFullPageTextOnce;
  d.getBrowserFullPageText = getBrowserFullPageText;
  d.navigateBrowserTab = navigateBrowserTab;
  d.waitForBrowserUrl = waitForBrowserUrl;
  d.resolveLinkedSitePage = resolveLinkedSitePage;
  d.decodeHtmlEntities = decodeHtmlEntities;
  d.scrapePageText = scrapePageText;
  d.parseYouTubeId = parseYouTubeId;
  d.getBrowserYouTubeTranscript = getBrowserYouTubeTranscript;
  d.parseYouTubeCaptionBody = parseYouTubeCaptionBody;
  d.overlayMessageWantsVideoTranscribe = overlayMessageWantsVideoTranscribe;
  d.fetchYouTubeTranscriptViaApi = fetchYouTubeTranscriptViaApi;
  d.fetchYouTubeTranscript = fetchYouTubeTranscript;
}

module.exports = { attachBrowserAutomation };
