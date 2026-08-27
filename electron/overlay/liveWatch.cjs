"use strict";

function attachLiveWatch(d) {
  if (d.__attached_attachLiveWatch) return;
  d.__attached_attachLiveWatch = true;
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
  const { screenFingerprint } = require("../browserAct.cjs");
  const overlayConstants = d.constants;
  const {
    OVERLAY_WIDTH, OVERLAY_SIDE_WIDTH, OVERLAY_WATCH_SIDE_WIDTH, OVERLAY_MAX_WIDTH,
    OVERLAY_MIN_HEIGHT, OVERLAY_BOTTOM_MARGIN, GLASS_CORNER_RADIUS, OVERLAY_BUBBLE,
    OVERLAY_ACTIVATABLE_FOR_DROPS, MENU_WIDTH, MENU_GAP, MENU_MIN_HEIGHT, MENU_MAX_HEIGHT,
    PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT, LIVE_WIDTH, LIVE_HEIGHT,
    PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT, UPDATE_REPROMPT_MS,
  } = overlayConstants;
  const ELECTRON_DIR = path.join(__dirname, "..");
  const capturePrimaryScreen = (...a) => d.capturePrimaryScreen(...a);
  const ensureScreenRecordingAccess = (...a) => d.ensureScreenRecordingAccess(...a);
  const getActiveBrowserTarget = (...a) => d.getActiveBrowserTarget(...a);
  const getAuthToken = (...a) => d.getAuthToken(...a);
  const getBrowserPageText = (...a) => d.getBrowserPageText(...a);
  const readOverlaySettings = (...a) => d.readOverlaySettings(...a);
  const screenCaptureStatus = (...a) => d.screenCaptureStatus(...a);
  const stripHiddenTags = (...a) => d.stripHiddenTags(...a);
  const writeOverlaySettings = (...a) => d.writeOverlaySettings(...a);
  const { screenDiffRatio, textSimilarity } = require("../../lib/browserScreen.cjs");
  const OVERLAY_IGNORE_NOTE = d.OVERLAY_IGNORE_NOTE;
  const LIVE_WATCH_STATIC_MS = 2000;
  const LIVE_WATCH_ACTIVE_MS = 500;
  const LIVE_WATCH_BURST_MS = 200;
  const LIVE_WATCH_BURST_DURATION_MS = 4000;
  const LIVE_WATCH_VISION_MIN_MS = 2500;
  const LIVE_WATCH_DIFF_VISION = 0.04;
  const LIVE_WATCH_DIFF_MOTION = 0.02;
  const LIVE_WATCH_DIFF_BURST = 0.12;
  const LIVE_WATCH_SUMMARY_MAX_AGE_MS = 45000;
  const LIVE_WATCH_SNAPSHOT_NOTE =
    "CRITICAL — HOW CAPTURE WORKS: You receive still screenshots every 1–2 seconds, NOT " +
    "live video. A frame that looks frozen or unchanged does NOT mean the user paused — " +
    "active games, videos, and apps often look static between snapshots. Only say paused, " +
    "idle, or stopped if you clearly see an explicit pause menu, pause icon, or PAUSED text " +
    "on screen. Never infer pause from a static-looking image alone.";
  const LIVE_WATCH_SCRAPE_MIN_MS = 3000;
  const LIVE_WATCH_TEXT_MIN_MS = 2000;
  const LIVE_WATCH_TEXT_CHANGE = 0.08;
  const LIVE_WATCH_RULE_CHECK_MS = 3500;
  const LIVE_WATCH_MAX_RULES = 8;
  const LIVE_WATCH_CAPTURE_TIMEOUT_MS = 6000;
  const LIVE_WATCH_VISION_TIMEOUT_MS = 35000;
  const LIVE_WATCH_NAV_DIFF = 0.55;
  const LIVE_WATCH_NAV_SETTLE_MS = 1400;

function parseWatchRuleIntent(text) {
  const t = String(text || "").trim();
  const patterns = [
    /^(?:tell me|let me know|notify me|alert me|warn me|ping me)\s+when\s+(.+)$/i,
    /^watch\s+(?:for|out for)\s+(.+)$/i,
    /^(?:alert|notify)\s+(?:me\s+)?when\s+(.+)$/i,
    /^let me know if\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) return m[1].trim().replace(/[.?!]+$/, "");
  }
  return null;
}

function looksLikeClearWatchRules(text) {
  const t = String(text || "").trim().toLowerCase();
  return (
    /\b(clear|stop|cancel|remove|delete)\b.*\b(watch rules?|alerts?|notifications?)\b/.test(t) ||
    /^stop watching for\b/.test(t) ||
    /^clear watch\b/.test(t)
  );
}

function addLiveWatchRule(ruleText) {
  const text = String(ruleText || "").trim().slice(0, 200);
  if (!text) return null;
  const dupe = d.liveWatchState.rules.some((r) => textSimilarity(r.text, text) > 0.85);
  if (dupe) return d.liveWatchState.rules.find((r) => textSimilarity(r.text, text) > 0.85);
  const entry = { id: crypto.randomUUID(), text, createdAt: Date.now() };
  d.liveWatchState.rules.push(entry);
  if (d.liveWatchState.rules.length > LIVE_WATCH_MAX_RULES) {
    d.liveWatchState.rules = d.liveWatchState.rules.slice(-LIVE_WATCH_MAX_RULES);
  }
  d.liveWatchForceVision = true;
  scheduleLiveWatchTick(100);
  notifyLiveWatchUpdate();
  return entry;
}

function clearLiveWatchRules() {
  d.liveWatchState.rules = [];
  notifyLiveWatchUpdate();
}

function parseLiveWatchResponse(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed || /^\[unchanged\]$/i.test(trimmed)) return { type: "unchanged" };
  const alertBracket = trimmed.match(/^\[alert:\s*(.+?)\]$/is);
  if (alertBracket) return { type: "alert", text: alertBracket[1].trim() };
  const alertTag = trimmed.match(/^\[alert\]\s*(.+)/is);
  if (alertTag) return { type: "alert", text: alertTag[1].trim() };
  const noteBracket = trimmed.match(/^\[note:\s*(.+?)\]$/is);
  if (noteBracket) return { type: "note", text: noteBracket[1].trim() };
  return { type: "note", text: trimmed };
}

function buildLiveWatchRulesSection() {
  if (!d.liveWatchState.rules.length) return "";
  const lines = d.liveWatchState.rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n");
  return (
    "\n\nUSER WATCH RULES — check the screenshot against EACH rule. " +
    "If one is clearly true RIGHT NOW, output [alert: one short sentence] " +
    "describing what happened (under 15 words). Rules:\n" +
    lines
  );
}

function isLiveWatchEnabled() {
  return !!readOverlaySettings().liveWatch;
}

function getLiveWatchStatus() {
  return {
    enabled: d.liveWatchState.enabled,
    summary: d.liveWatchState.summary,
    commentary: d.liveWatchState.commentary,
    commentaryKind: d.liveWatchState.commentaryKind,
    at: d.liveWatchState.at,
    motionLevel: d.liveWatchState.motionLevel,
    lastDiff: d.liveWatchState.lastDiff,
    capturing: d.liveWatchState.capturing,
    isNewCommentary: d.liveWatchState.isNewCommentary,
    rules: d.liveWatchState.rules.map((r) => r.text),
    contextSource: d.liveWatchState.contextSource,
    extensionConnected: !!d.extensionBridge?.isConnected?.(),
    pageTitle: d.liveWatchState.pageTitle || "",
    pageUrl: d.liveWatchState.pageUrl || "",
  };
}

function getFreshLiveWatchSummary(maxAgeMs = LIVE_WATCH_SUMMARY_MAX_AGE_MS) {
  const text = String(d.liveWatchState.summary || "").trim();
  if (!text || !d.liveWatchState.at) return "";
  if (Date.now() - d.liveWatchState.at > maxAgeMs) return "";
  return text;
}

function getLiveWatchContextSection() {
  const text = getFreshLiveWatchSummary();
  if (!text) return "";
  const ageSec = Math.max(0, Math.round((Date.now() - d.liveWatchState.at) / 1000));
  return (
    "\n\n[LIVE SCREEN WATCH] LYKN has been continuously watching the user's screen " +
    `(last updated ${ageSec}s ago). Use this rolling summary as your live view — ` +
    "it may be more current than a single screenshot for fast-moving apps and games.\n" +
    `--- LIVE SCREEN SUMMARY ---\n${text}\n--- END LIVE SCREEN SUMMARY ---`
  );
}

function notifyLiveWatchUpdate() {
  if (d.overlayWindow && !d.overlayWindow.isDestroyed()) {
    d.overlayWindow.webContents.send("lykn:live-watch-update", getLiveWatchStatus());
  }
}

function setLiveWatchCapturing(on) {
  const next = !!on;
  if (d.liveWatchState.capturing === next) return;
  d.liveWatchState.capturing = next;
  notifyLiveWatchUpdate();
}

function setLiveWatchSummary(text, { motionLevel, diff, kind = "note" } = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  const prev = d.liveWatchState.commentary || d.liveWatchState.summary;
  const isNew = kind === "alert" || !prev || textSimilarity(prev, trimmed) < 0.62;
  d.liveWatchState.summary = trimmed.slice(0, 4000);
  d.liveWatchState.commentary = trimmed.slice(0, 1200);
  d.liveWatchState.commentaryKind = kind === "alert" ? "alert" : "note";
  d.liveWatchState.isNewCommentary = isNew;
  d.liveWatchState.at = Date.now();
  if (motionLevel) d.liveWatchState.motionLevel = motionLevel;
  if (typeof diff === "number") d.liveWatchState.lastDiff = diff;
  notifyLiveWatchUpdate();
  d.liveWatchState.isNewCommentary = false;
}

function liveWatchIntervalMs() {
  const now = Date.now();
  // Slow down while a vision/text call is in flight — prevents pile-up on page switches.
  if (d.liveWatchVisionInFlight || d.liveWatchTextInFlight) return LIVE_WATCH_STATIC_MS;
  if (now < d.liveWatchSettleUntil) return 400;
  if (now < d.liveWatchBurstUntil || d.liveWatchState.motionLevel === "burst") {
    return LIVE_WATCH_BURST_MS;
  }
  if (d.liveWatchState.motionLevel === "active") return LIVE_WATCH_ACTIVE_MS;
  return LIVE_WATCH_STATIC_MS;
}

async function captureForLiveWatch() {
  try {
    return await Promise.race([
      capturePrimaryScreen({ maxWidth: 960, format: "jpeg", quality: 72 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("capture_timeout")), LIVE_WATCH_CAPTURE_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    console.warn("[live-watch] capture failed:", e?.message);
    return null;
  }
}

async function postAiStreamTextWithTimeout(body, token, timeoutMs = LIVE_WATCH_VISION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/ai/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return "";
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      const data = await res.json().catch(() => null);
      return stripHiddenTags(data?.response || data?.answer || data?.text || "").trim();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accumulated = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(t.indexOf(":") + 1).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (typeof j.t === "string") accumulated += j.t;
        } catch {
          /* ignore keepalive */
        }
      }
    }
    return stripHiddenTags(accumulated).trim();
  } catch (e) {
    if (e?.name === "AbortError") console.warn("[live-watch] vision timed out");
    else console.warn("[live-watch] vision fetch failed:", e?.message);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function scheduleLiveWatchTick(delayMs) {
  if (d.liveWatchTimer) clearTimeout(d.liveWatchTimer);
  if (!d.liveWatchState.enabled) {
    d.liveWatchTimer = null;
    return;
  }
  d.liveWatchTimer = setTimeout(() => void liveWatchTick(), Math.max(50, delayMs || liveWatchIntervalMs()));
}

function stopLiveWatch() {
  d.liveWatchState.enabled = false;
  if (d.liveWatchTimer) {
    clearTimeout(d.liveWatchTimer);
    d.liveWatchTimer = null;
  }
  d.liveWatchCaptureInFlight = false;
  d.liveWatchForceVision = false;
  d.liveWatchState.motionLevel = "static";
  setLiveWatchCapturing(false);
  d.liveWatchState.commentary = "";
  d.liveWatchState.summary = "";
  d.liveWatchState.rules = [];
  d.liveWatchSettleUntil = 0;
  d.liveWatchPendingNavVision = false;
  d.liveWatchConsecutiveBurstFrames = 0;
  d.liveWatchTextInFlight = false;
  d.liveWatchForceTextPass = false;
  d.liveWatchPendingTextPass = false;
  d.liveWatchLastPageText = "";
  d.liveWatchLastPageSig = "";
  d.liveWatchLastPageUrl = "";
  d.liveWatchLastScrapeAt = 0;
  d.liveWatchState.contextSource = "vision";
  d.liveWatchState.pageTitle = "";
  d.liveWatchState.pageUrl = "";
  notifyLiveWatchUpdate();
}

async function startLiveWatch() {
  const access = await ensureScreenRecordingAccess();
  if (!access.ok) {
    return { ok: false, error: "no_permission", ...access };
  }
  d.liveWatchState.enabled = true;
  d.liveWatchForceVision = true;
  d.liveWatchLastFingerprint = "";
  d.liveWatchLastFrameUrl = "";
  d.liveWatchSettleUntil = 0;
  d.liveWatchPendingNavVision = false;
  d.liveWatchConsecutiveBurstFrames = 0;
  notifyLiveWatchUpdate();
  scheduleLiveWatchTick(100);
  return { ok: true, ...getLiveWatchStatus() };
}

async function setLiveWatchEnabled(on) {
  const enabled = !!on;
  if (enabled) {
    const result = await startLiveWatch();
    if (!result.ok) return result;
    writeOverlaySettings({ liveWatch: true });
    return { ...result, needsExtension: !d.extensionBridge?.isConnected?.() };
  }
  writeOverlaySettings({ liveWatch: false });
  stopLiveWatch();
  return { ok: true, enabled: false, ...getLiveWatchStatus() };
}

async function describeLiveWatchFrame(dataURL, previousSummary, { diff = 1, motionLevel = "static", rulesOnly = false } = {}) {
  const token = await getAuthToken();
  if (!token) return { error: "not_authenticated" };

  const prev = String(previousSummary || "").trim();
  const hasRules = d.liveWatchState.rules.length > 0;
  const rulesSection = buildLiveWatchRulesSection();
  const changePct = Math.round(Math.min(1, Math.max(0, diff)) * 100);
  const changeLine =
    diff >= 0.99
      ? ""
      : `\n\nSnapshot metadata: ~${changePct}% of screen pixels changed since the last capture ` +
        `(motion: ${motionLevel}).`;

  const outputRules =
    "OUTPUT (pick exactly one):\n" +
    "- [unchanged] — nothing new" +
    (hasRules ? ", no watch rules triggered" : "") +
    "\n" +
    (hasRules ? "- [alert: message] — a USER WATCH RULE is true on screen now (max 15 words)\n" : "") +
    (rulesOnly
      ? "- Rules-only check: output [alert: …] or [unchanged] only.\n"
      : "- [note: message] — one brief basic line if something changed (max 12 words)\n");

  const prompt = prev
    ? "You are LYKN watching the user's screen via still snapshots every 1–2 seconds.\n\n" +
      `LAST UPDATE:\n${prev.slice(0, 800)}\n\n` +
      outputRules +
      rulesSection +
      LIVE_WATCH_SNAPSHOT_NOTE +
      changeLine +
      "\n" +
      OVERLAY_IGNORE_NOTE
    : "You are LYKN watching the user's screen via still snapshots every 1–2 seconds.\n\n" +
      outputRules +
      rulesSection +
      "If nothing to say yet, output [unchanged]. Otherwise one short [note: …] about what they're doing (max 12 words).\n" +
      LIVE_WATCH_SNAPSHOT_NOTE +
      "\n" +
      OVERLAY_IGNORE_NOTE;

  const text = await postAiStreamTextWithTimeout(
    {
      model: "lykn",
      intent: "ask",
      text: "Live screen watch.",
      prompt,
      imageUrls: [dataURL],
      useTools: false,
      skipWebSearch: true,
      overlayAsk: true,
      liveWatch: true,
    },
    token,
  );
  const parsed = parseLiveWatchResponse(text);
  if (parsed.type === "unchanged") return { error: "unchanged" };
  const out = parsed.text.trim();
  if (!out) return { error: "unchanged" };
  if (parsed.type === "alert") return { text: out, kind: "alert" };
  // Reject pause/idling guesses when pixels barely moved — classic snapshot artifact.
  if (diff < 0.05 && /\b(paused?|on pause|you(?:'re| are) idle|standing still|not moving|game is paused)\b/i.test(out)) {
    return { error: "unchanged" };
  }
  // Skip long general chatter — keep live feed basic.
  if (out.split(/\s+/).length > 18) {
    return { text: out.split(/\s+/).slice(0, 15).join(" ") + "…", kind: "note" };
  }
  return { text: out, kind: "note" };
}

async function describeLiveWatchPageText(snap, previousSummary, { textSim = 0, rulesOnly = false } = {}) {
  const token = await getAuthToken();
  if (!token) return { error: "not_authenticated" };

  const prev = String(previousSummary || "").trim();
  const hasRules = d.liveWatchState.rules.length > 0;
  const rulesSection = buildLiveWatchRulesSection();
  const changePct = Math.round(Math.min(100, Math.max(0, (1 - textSim) * 100)));
  const pageBlock =
    `PAGE: ${snap.title || "Untitled"}\nURL: ${snap.url || ""}\n\n` +
    `VISIBLE TEXT (live DOM from browser — not a screenshot):\n${String(snap.text || "").slice(0, 8000)}`;

  const outputRules =
    "OUTPUT (pick exactly one):\n" +
    "- [unchanged] — nothing new" +
    (hasRules ? ", no watch rules triggered" : "") +
    "\n" +
    (hasRules ? "- [alert: message] — a USER WATCH RULE is true on this page now (max 15 words)\n" : "") +
    (rulesOnly
      ? "- Rules-only check: output [alert: …] or [unchanged] only.\n"
      : "- [note: message] — one brief basic line if something changed (max 12 words)\n");

  const prompt = prev
    ? "You are LYKN watching the user's browser via live page text (DOM, not screenshots).\n\n" +
      `LAST UPDATE:\n${prev.slice(0, 800)}\n\n` +
      `${pageBlock}\n\n` +
      `Page text ~${changePct}% changed since last check.\n\n` +
      outputRules +
      rulesSection +
      "\n" +
      OVERLAY_IGNORE_NOTE
    : "You are LYKN watching the user's browser via live page text (DOM, not screenshots).\n\n" +
      `${pageBlock}\n\n` +
      outputRules +
      rulesSection +
      "If nothing to say yet, output [unchanged]. Otherwise one short [note: …] about what they're reading or doing (max 12 words).\n" +
      "\n" +
      OVERLAY_IGNORE_NOTE;

  const text = await postAiStreamTextWithTimeout(
    {
      model: "lykn",
      intent: "ask",
      text: "Live browser watch.",
      prompt,
      useTools: false,
      skipWebSearch: true,
      overlayAsk: true,
      liveWatch: true,
    },
    token,
  );
  const parsed = parseLiveWatchResponse(text);
  if (parsed.type === "unchanged") return { error: "unchanged" };
  const out = parsed.text.trim();
  if (!out) return { error: "unchanged" };
  if (parsed.type === "alert") return { text: out, kind: "alert" };
  if (out.split(/\s+/).length > 18) {
    return { text: out.split(/\s+/).slice(0, 15).join(" ") + "…", kind: "note" };
  }
  return { text: out, kind: "note" };
}

async function liveWatchTextPass(snap, { textSim = 0, rulesOnly = false } = {}) {
  if (d.liveWatchTextInFlight) return;
  const now = Date.now();
  const force = d.liveWatchForceTextPass;
  if (!force && now - d.liveWatchLastVisionAt < LIVE_WATCH_TEXT_MIN_MS) return;

  d.liveWatchTextInFlight = true;
  d.liveWatchForceTextPass = false;
  d.liveWatchLastVisionAt = now;
  if (rulesOnly) d.liveWatchLastRuleCheckAt = now;
  try {
    const result = await describeLiveWatchPageText(snap, d.liveWatchState.summary, { textSim, rulesOnly });
    if (result?.text) {
      setLiveWatchSummary(result.text, {
        motionLevel: d.liveWatchState.motionLevel,
        diff: 1 - textSim,
        kind: result.kind || "note",
      });
    }
  } catch (e) {
    console.warn("[live-watch] text pass failed:", e?.message);
  } finally {
    d.liveWatchTextInFlight = false;
  }
}

async function tryLiveWatchBrowserScrape() {
  // Don't poke Automation while Screen Recording is still unsettled, or after
  // the user already denied System Events — Live Watch can rely on vision alone.
  if (screenCaptureStatus() !== "granted") return null;
  if (d.automationOk.systemEvents === false) return null;

  const now = Date.now();
  if (now - d.liveWatchLastScrapeAt < LIVE_WATCH_SCRAPE_MIN_MS) return null;
  d.liveWatchLastScrapeAt = now;
  try {
    const target = await getActiveBrowserTarget();
    if (!target?.appName) return null;
    const live = await getBrowserPageText(target.appName);
    const text = String(live?.text || live?.pageText || "").trim();
    if (text.length < 80) return null;
    const url = String(live?.url || target.url || "");
    const title = String(live?.title || target.title || "");
    const sig = `${url}|${text.length}|${text.slice(0, 240)}|${text.slice(-120)}`;
    return { url, title, text: text.slice(0, 15000), sig, at: Date.now(), source: "scrape" };
  } catch {
    return null;
  }
}

async function liveWatchPageTextTick(snap, source) {
  d.liveWatchState.contextSource = source;
  d.liveWatchState.extensionConnected = source === "extension" || !!d.extensionBridge?.isConnected?.();
  d.liveWatchState.pageTitle = String(snap.title || "").trim();
  d.liveWatchState.pageUrl = String(snap.url || "").trim();

  const textSim =
    snap.sig && snap.sig === d.liveWatchLastPageSig
      ? 1
      : d.liveWatchLastPageText
        ? textSimilarity(d.liveWatchLastPageText, snap.text)
        : 0;
  const textChanged = 1 - textSim >= LIVE_WATCH_TEXT_CHANGE;
  d.liveWatchState.lastDiff = 1 - textSim;

  const now = Date.now();
  const urlChanged = d.liveWatchLastPageUrl && snap.url && d.liveWatchLastPageUrl !== snap.url;

  if (urlChanged) {
    d.liveWatchSettleUntil = now + 800;
    d.liveWatchPendingTextPass = true;
    d.liveWatchLastPageUrl = snap.url;
    d.liveWatchLastPageText = snap.text;
    d.liveWatchLastPageSig = snap.sig || "";
    return Math.max(300, d.liveWatchSettleUntil - now + 50);
  }

  if (now < d.liveWatchSettleUntil) {
    return Math.max(200, d.liveWatchSettleUntil - now + 50);
  }

  if (d.liveWatchPendingTextPass) {
    d.liveWatchPendingTextPass = false;
    d.liveWatchForceTextPass = true;
  }

  d.liveWatchState.motionLevel = textChanged ? "active" : "static";

  const hasRules = d.liveWatchState.rules.length > 0;
  const ruleCheckDue = hasRules && now - d.liveWatchLastRuleCheckAt >= LIVE_WATCH_RULE_CHECK_MS;
  const shouldPass =
    d.liveWatchForceTextPass || !d.liveWatchState.summary || textChanged || ruleCheckDue;
  const skipNearDuplicate =
    !d.liveWatchForceTextPass && !ruleCheckDue && d.liveWatchState.summary && textSim > 0.97;

  if (shouldPass && !skipNearDuplicate && !d.liveWatchTextInFlight) {
    void liveWatchTextPass(snap, { textSim, rulesOnly: ruleCheckDue && !textChanged });
  }

  d.liveWatchLastPageText = snap.text;
  d.liveWatchLastPageSig = snap.sig || "";
  d.liveWatchLastPageUrl = snap.url || "";

  notifyLiveWatchUpdate();
  return textChanged ? LIVE_WATCH_ACTIVE_MS : LIVE_WATCH_STATIC_MS;
}

async function liveWatchVisionPass(dataURL, diff, { rulesOnly = false } = {}) {
  if (d.liveWatchVisionInFlight) return;
  const now = Date.now();
  const force = d.liveWatchForceVision;
  if (!force && now - d.liveWatchLastVisionAt < LIVE_WATCH_VISION_MIN_MS) return;

  d.liveWatchVisionInFlight = true;
  d.liveWatchForceVision = false;
  d.liveWatchLastVisionAt = now;
  if (rulesOnly) d.liveWatchLastRuleCheckAt = now;
  try {
    const result = await describeLiveWatchFrame(dataURL, d.liveWatchState.summary, {
      diff,
      motionLevel: d.liveWatchState.motionLevel,
      rulesOnly,
    });
    if (result?.text) {
      setLiveWatchSummary(result.text, {
        motionLevel: d.liveWatchState.motionLevel,
        diff,
        kind: result.kind || "note",
      });
    }
  } catch (e) {
    console.warn("[live-watch] vision pass failed:", e?.message);
  } finally {
    d.liveWatchVisionInFlight = false;
  }
}

async function liveWatchTick() {
  if (!d.liveWatchState.enabled) return;
  if (screenCaptureStatus() !== "granted") {
    stopLiveWatch();
    return;
  }
  if (d.liveWatchCaptureInFlight) {
    scheduleLiveWatchTick(liveWatchIntervalMs());
    return;
  }

  d.liveWatchCaptureInFlight = true;
  let nextDelay = null;

  try {
    // Text-first: browser extension (cheapest — no screenshot, no vision).
    const extSnap = d.extensionBridge?.getSnapshot?.(6000);
    if (extSnap?.text && extSnap.text.length >= 80) {
      nextDelay = await liveWatchPageTextTick(extSnap, "extension");
      return;
    }

    // Text fallback: AppleScript DOM scrape when extension not connected.
    const scrapeSnap = await tryLiveWatchBrowserScrape();
    if (scrapeSnap?.text && scrapeSnap.text.length >= 80) {
      nextDelay = await liveWatchPageTextTick(scrapeSnap, "scrape");
      return;
    }

    d.liveWatchState.extensionConnected = !!d.extensionBridge?.isConnected?.();
    d.liveWatchState.contextSource = "vision";

    setLiveWatchCapturing(true);
    const dataURL = await captureForLiveWatch();
    if (!d.liveWatchState.enabled) return;
    if (!dataURL) {
      nextDelay = LIVE_WATCH_STATIC_MS;
      return;
    }

    d.liveWatchLastFrameUrl = dataURL;
    const fp = screenFingerprint(dataURL);
    const diff = d.liveWatchLastFingerprint ? screenDiffRatio(d.liveWatchLastFingerprint, fp) : 1;
    d.liveWatchLastFingerprint = fp;
    d.liveWatchState.lastDiff = diff;

    const now = Date.now();
    const navigated = diff >= LIVE_WATCH_NAV_DIFF;

    if (navigated) {
      // Page/app switch — wait for the new screen to settle instead of burst-flooding vision.
      d.liveWatchSettleUntil = now + LIVE_WATCH_NAV_SETTLE_MS;
      d.liveWatchPendingNavVision = true;
      d.liveWatchBurstUntil = 0;
      d.liveWatchConsecutiveBurstFrames = 0;
      d.liveWatchState.motionLevel = "static";
      nextDelay = Math.max(200, d.liveWatchSettleUntil - now + 50);
      return;
    }

    if (now < d.liveWatchSettleUntil) {
      nextDelay = Math.max(200, d.liveWatchSettleUntil - now + 50);
      return;
    }

    if (d.liveWatchPendingNavVision) {
      d.liveWatchPendingNavVision = false;
      d.liveWatchForceVision = true;
    }

    if (diff >= LIVE_WATCH_DIFF_BURST) {
      d.liveWatchConsecutiveBurstFrames += 1;
      if (d.liveWatchConsecutiveBurstFrames >= 2) {
        d.liveWatchState.motionLevel = "burst";
        d.liveWatchBurstUntil = now + LIVE_WATCH_BURST_DURATION_MS;
      } else {
        d.liveWatchState.motionLevel = "active";
      }
    } else if (diff >= LIVE_WATCH_DIFF_MOTION) {
      d.liveWatchConsecutiveBurstFrames = 0;
      d.liveWatchState.motionLevel = "active";
    } else if (now >= d.liveWatchBurstUntil) {
      d.liveWatchConsecutiveBurstFrames = 0;
      d.liveWatchState.motionLevel = "static";
    }

    const hasRules = d.liveWatchState.rules.length > 0;
    const ruleCheckDue = hasRules && now - d.liveWatchLastRuleCheckAt >= LIVE_WATCH_RULE_CHECK_MS;
    const shouldVision =
      d.liveWatchForceVision ||
      !d.liveWatchState.summary ||
      diff >= LIVE_WATCH_DIFF_VISION ||
      ruleCheckDue;
    const skipNearDuplicate =
      !d.liveWatchForceVision && !ruleCheckDue && d.liveWatchState.summary && diff < 0.03;
    if (shouldVision && !skipNearDuplicate && !d.liveWatchVisionInFlight) {
      void liveWatchVisionPass(dataURL, diff, { rulesOnly: ruleCheckDue && diff < LIVE_WATCH_DIFF_VISION });
    }
  } catch (e) {
    console.warn("[live-watch] capture tick failed:", e?.message);
    nextDelay = LIVE_WATCH_STATIC_MS;
  } finally {
    d.liveWatchCaptureInFlight = false;
    setLiveWatchCapturing(false);
    if (d.liveWatchState.enabled) {
      scheduleLiveWatchTick(nextDelay != null ? nextDelay : liveWatchIntervalMs());
    }
  }
}

  d.addLiveWatchRule = addLiveWatchRule;
  d.buildLiveWatchRulesSection = buildLiveWatchRulesSection;
  d.captureForLiveWatch = captureForLiveWatch;
  d.clearLiveWatchRules = clearLiveWatchRules;
  d.describeLiveWatchFrame = describeLiveWatchFrame;
  d.describeLiveWatchPageText = describeLiveWatchPageText;
  d.getFreshLiveWatchSummary = getFreshLiveWatchSummary;
  d.getLiveWatchContextSection = getLiveWatchContextSection;
  d.getLiveWatchStatus = getLiveWatchStatus;
  d.isLiveWatchEnabled = isLiveWatchEnabled;
  d.liveWatchIntervalMs = liveWatchIntervalMs;
  d.liveWatchPageTextTick = liveWatchPageTextTick;
  d.liveWatchTextPass = liveWatchTextPass;
  d.liveWatchTick = liveWatchTick;
  d.liveWatchVisionPass = liveWatchVisionPass;
  d.looksLikeClearWatchRules = looksLikeClearWatchRules;
  d.notifyLiveWatchUpdate = notifyLiveWatchUpdate;
  d.parseLiveWatchResponse = parseLiveWatchResponse;
  d.parseWatchRuleIntent = parseWatchRuleIntent;
  d.postAiStreamTextWithTimeout = postAiStreamTextWithTimeout;
  d.scheduleLiveWatchTick = scheduleLiveWatchTick;
  d.setLiveWatchCapturing = setLiveWatchCapturing;
  d.setLiveWatchEnabled = setLiveWatchEnabled;
  d.setLiveWatchSummary = setLiveWatchSummary;
  d.startLiveWatch = startLiveWatch;
  d.stopLiveWatch = stopLiveWatch;
  d.tryLiveWatchBrowserScrape = tryLiveWatchBrowserScrape;
}

module.exports = { attachLiveWatch };
