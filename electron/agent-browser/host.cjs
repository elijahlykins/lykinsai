"use strict";

/**
 * Agent browser host: sidebar, stage, tab views, artifacts, and runtime wiring.
 * Owns Electron window/view maps for Agent Mode. Not Task execution authority.
 */
function attachAgentBrowser(d) {
  if (d.__attached_attachAgentBrowser) return;
  d.__attached_attachAgentBrowser = true;
  const {
    app, BrowserWindow, WebContentsView, shell, ipcMain, Menu, screen,
    session, nativeImage, Notification, net: electronNet,
  } = d.electron;
  const path = d.node.path;
  const { pathToFileURL } = d.node.url;
  const fs = d.node.fs;
  const fsSync = d.node.fsSync;
  const crypto = d.node.crypto;
  const { IS_MAC, IS_WIN, APP_URL, APP_ORIGIN, API_BASE } = d.env;
  const overlayConstants = d.constants;
  const { AGENT_SIDEBAR_WIDTH } = overlayConstants;
  const { screenFingerprint } = require("../browserAct.cjs");
  const ownedBrowserAct = d.ownedBrowserAct;
  const agentRecentVisits = d.agentRecentVisits;
  const localStore = d.localStore;
  const createAgentRuntime = require("../agentRuntime.cjs").createAgentRuntime;
  const { createRoutineRuntime } = require("../bot-routines/routineRuntime.cjs");
  const { createTeachService } = require("../teach/service.cjs");
  const agentTabIds = require("../agentTabIds.cjs");
  const botTabVisibility = require("./botTabVisibility.cjs");
  const tabChatLineage = require("./tabChatLineage.cjs");
  const { dockedPageBoundsForOverlay } = require("./menuOverlayLayout.cjs");
  const {
    applyViewRadius,
    normalizeViewRadius,
    pageClipRadius,
    viewRadiiEqual,
    viewRadiusMax,
  } = require("./viewRadius.cjs");
  const { createAgentHomeIdentity } = require("../agentHomeIdentity.cjs");
  const agentHomeIdentity = createAgentHomeIdentity(path.join(__dirname, ".."));
  const {
    wrapReportAsStageHtml,
    titleFromMarkdown: titleFromStageMarkdown,
  } = require("../markdownToStageHtml.cjs");

  const mintDesktopAuthUrl = (...a) => d.mintDesktopAuthUrl(...a);
  const createMainWindow = (...a) => d.createMainWindow(...a);
  const studioWindowRef = (...a) => d.studioWindowRef(...a);
  const floatingGlassChrome = (...a) => d.floatingGlassChrome(...a);
  const hardenFloatingGlass = (...a) => d.hardenFloatingGlass(...a);
  const setFloatingBounds = (...a) => d.setFloatingBounds(...a);
  const focusOverlayForTyping = (...a) => d.focusOverlayForTyping(...a);
  const positionMenuWindow = (...a) => d.positionMenuWindow(...a);
  const liveWindowVisible = (...a) => d.liveWindowVisible(...a);
  const panelWindowVisible = (...a) => d.panelWindowVisible(...a);
  const cacheArtifactHtmlForOverlay = (...a) => d.cacheArtifactHtmlForOverlay(...a);
  const getAuthToken = (...a) => d.getAuthToken(...a);
  const isContentProtectionEnabled = (...a) => d.isContentProtectionEnabled(...a);
  const readOverlayStreamResponse = (...a) => d.readOverlayStreamResponse(...a);
  const pickArtifactUrl = (...a) => d.pickArtifactUrl(...a);
  const hideMenuWindow = (...a) => d.hideMenuWindow(...a);
  const applyContentProtection = (...a) => d.applyContentProtection(...a);
  const applyFloatingGlassShape = (...a) => d.applyFloatingGlassShape(...a);

  const ELECTRON_DIR = path.join(__dirname, "..");
  const artifactHtmlCache = new Map();
  let agentFinishedPopup = null;
  let agentFinishedPopupTimer = null;
  let agentStageToastReserve = 0;
  const { broadcastToAllWindows } = require("../services/initializeElectronServices.cjs");

function showAgentFinishedPopup(payload) {
  const agentId = String(payload?.agentId || "").trim();
  const prompt = String(payload?.prompt || payload?.name || "Agent task")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  const status = String(payload?.status || payload?.label || "Finished")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  const ok = payload?.ok !== false;
  // Prefer anchoring to the agent stage if it's already open — never raise it.
  const stage =
    agentStageWindow && !agentStageWindow.isDestroyed() ? agentStageWindow : null;

  // Recreate if an older transparent popup is still around — need vibrancy chrome.
  if (agentFinishedPopup && !agentFinishedPopup.isDestroyed()) {
    try {
      const usingGlass = !!agentFinishedPopup.__lyknGlassFinish;
      if (!usingGlass) {
        agentFinishedPopup.destroy();
        agentFinishedPopup = null;
      }
    } catch (_) {
      agentFinishedPopup = null;
    }
  }

  if (!agentFinishedPopup || agentFinishedPopup.isDestroyed()) {
    agentFinishedPopup = new BrowserWindow({
      width: 340,
      height: 96,
      show: false,
      frame: false,
      ...floatingGlassChrome(),
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      acceptFirstMouse: true,
      ...(IS_MAC ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(ELECTRON_DIR, "agent-finished-popup-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    agentFinishedPopup.__lyknGlassFinish = true;
    try {
      agentFinishedPopup.setContentProtection(isContentProtectionEnabled());
    } catch (_) {}
    hardenFloatingGlass(agentFinishedPopup);
    try {
      agentFinishedPopup.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    } catch (_) {}
    try {
      agentFinishedPopup.setAlwaysOnTop(true, "screen-saver");
    } catch (_) {
      try {
        agentFinishedPopup.setAlwaysOnTop(true, "floating");
      } catch (_) {}
    }
    agentFinishedPopup.on("closed", () => {
      agentFinishedPopup = null;
    });
  }

  const w = 340;
  const h = 96;
  const pad = 12;
  let anchor = null;
  try {
    if (stage && stage.isVisible()) {
      anchor =
        typeof stage.getContentBounds === "function"
          ? stage.getContentBounds()
          : stage.getBounds();
    }
  } catch (_) {}
  if (!anchor) {
    try {
      if (d.overlayWindow && !d.overlayWindow.isDestroyed() && d.overlayWindow.isVisible()) {
        anchor = d.overlayWindow.getBounds();
      }
    } catch (_) {}
  }
  if (!anchor) {
    const { workArea } = screen.getPrimaryDisplay();
    anchor = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
  }
  agentFinishedPopup.__lyknAgentId = agentId;
  setFloatingBounds(agentFinishedPopup, {
    x: Math.round(anchor.x + Math.max(pad, anchor.width - w - pad)),
    y: Math.round(anchor.y + pad),
    width: w,
    height: h,
  });
  applyFloatingGlassShape(agentFinishedPopup);
  const qs = new URLSearchParams({
    prompt: prompt || "Agent task",
    status: status || (ok ? "Finished" : "Failed"),
    ok: ok ? "1" : "0",
    agentId,
  });
  try {
    agentFinishedPopup.loadFile(path.join(ELECTRON_DIR, "agent-finished-popup.html"), {
      query: Object.fromEntries(qs),
    });
  } catch (_) {
    try {
      agentFinishedPopup.loadURL(
        "file://" +
          path.join(ELECTRON_DIR, "agent-finished-popup.html") +
          "?" +
          qs.toString(),
      );
    } catch (_) {}
  }
  try {
    if (typeof agentFinishedPopup.setOpacity === "function") agentFinishedPopup.setOpacity(1);
  } catch (_) {}
  try {
    agentFinishedPopup.showInactive();
    agentFinishedPopup.moveTop();
  } catch (_) {
    try {
      agentFinishedPopup.show();
    } catch (_) {}
  }
  if (agentFinishedPopupTimer) clearTimeout(agentFinishedPopupTimer);
  // Hide the whole window at once — no content-only fade (that left a glass ghost).
  agentFinishedPopupTimer = setTimeout(() => {
    closeAgentFinishedPopup();
  }, 5500);

  agentStageToastReserve = 0;
  layoutAgentStageViews();
}

function closeAgentFinishedPopup() {
  if (agentFinishedPopupTimer) {
    clearTimeout(agentFinishedPopupTimer);
    agentFinishedPopupTimer = null;
  }
  try {
    if (agentFinishedPopup && !agentFinishedPopup.isDestroyed()) {
      agentFinishedPopup.hide();
      if (typeof agentFinishedPopup.setOpacity === "function") agentFinishedPopup.setOpacity(1);
    }
  } catch (_) {}
  agentStageToastReserve = 0;
  try {
    layoutAgentStageViews();
  } catch (_) {}
}

/** Agent finish notices are off — the result already lands in chat. */
function notifyAgentFinished(_payload) {}

// ── Agent Mode: sidebar + owned browser sessions ───────────────────────────
// AGENT_SIDEBAR_WIDTH is shared with overlaySatellites via overlayConstants.
const AGENT_SIDEBAR_MIN_HEIGHT = 180;
const AGENT_SIDEBAR_MAX_HEIGHT = 560;
let agentSidebarWindow = null;
let agentSidebarHeight = 360;
let agentSidebarOpen = false;
let agentRuntime = null;
let routineRuntime = null;
let teachService = null;
// Inline browser-new-tab conversations receive the same live agent events as
// the regular LYKN chat, scoped to their paired browser agent.
const browserWelcomeChatStreams = new Map();
let openBrowserTaskChat = null;

// ── AGENT-HARNESS BRIDGE ──────────────────────────────────────────────────
// Browser-view Maps, runtime DI, stage embedding, and agent IPC implementation
// stay in this file until the dedicated Agent Harness redesign. Do not relocate
// these without a separate architecture discussion.
function emitAgentToUi(channel, payload) {
  try {
    if (d.overlayWindow && !d.overlayWindow.isDestroyed()) {
      d.overlayWindow.webContents.send(channel, payload);
    }
  } catch (_) {}
  try {
    if (agentSidebarWindow && !agentSidebarWindow.isDestroyed()) {
      agentSidebarWindow.webContents.send(channel, payload);
    }
  } catch (_) {}
  // The Studio's browser tab renders an agent rail beside the docked
  // browser — mirror agent events there too.
  try {
    if (d.studioWindow && !d.studioWindow.isDestroyed()) {
      d.studioWindow.webContents.send(channel, payload);
    }
  } catch (_) {}
  const agentId = String(payload?.agentId || "");
  const stream = agentId ? browserWelcomeChatStreams.get(agentId) : null;
  if (
    stream &&
    ["lykn:agent-status", "lykn:agent-delta", "lykn:agent-done", "lykn:agent-error"].includes(
      channel,
    )
  ) {
    try {
      if (!stream.sender.isDestroyed?.()) {
        stream.sender.send("lykn:agent-browser-welcome-stream", {
          requestId: stream.requestId,
          channel,
          ...payload,
        });
      }
    } catch (_) {}
    if (channel === "lykn:agent-done" || channel === "lykn:agent-error") {
      browserWelcomeChatStreams.delete(agentId);
    }
  }
}

function createAgentSidebarWindow() {
  agentSidebarWindow = new BrowserWindow({
    width: AGENT_SIDEBAR_WIDTH,
    height: agentSidebarHeight,
    show: false,
    frame: false,
    ...floatingGlassChrome(),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    ...(IS_MAC ? { type: "panel" } : {}),
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "agent-sidebar-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    agentSidebarWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  hardenFloatingGlass(agentSidebarWindow);
  agentSidebarWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  agentSidebarWindow.setFullScreenable(false);
  agentSidebarWindow.setAlwaysOnTop(true, "screen-saver");
  agentSidebarWindow.loadFile(path.join(ELECTRON_DIR, "agent-sidebar.html"));
  agentSidebarWindow.on("closed", () => {
    agentSidebarWindow = null;
  });
}

function agentSidebarWindowVisible() {
  return !!(
    agentSidebarWindow &&
    !agentSidebarWindow.isDestroyed() &&
    agentSidebarWindow.isVisible()
  );
}

function agentSidebarTargetBounds() {
  const ob = d.overlayWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.max(
    AGENT_SIDEBAR_MIN_HEIGHT,
    Math.min(agentSidebarHeight, AGENT_SIDEBAR_MAX_HEIGHT, workArea.height - 16),
  );
  const rightInset =
    (liveWindowVisible() ? LIVE_WIDTH + MENU_GAP : 0) +
    (panelWindowVisible() ? panelWidth + MENU_GAP : 0);
  let x = ob.x + ob.width + MENU_GAP + rightInset;
  if (x + AGENT_SIDEBAR_WIDTH > workArea.x + workArea.width) {
    x = ob.x - MENU_GAP - AGENT_SIDEBAR_WIDTH;
  }
  x = Math.max(workArea.x, x);
  let y = ob.y + ob.height - h;
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - h));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: AGENT_SIDEBAR_WIDTH,
    height: h,
  };
}

function positionAgentSidebarWindow() {
  if (!agentSidebarWindowVisible()) return;
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  setFloatingBounds(agentSidebarWindow, agentSidebarTargetBounds());
}

function showAgentSidebarWindow() {
  if (!d.overlayWindow || d.overlayWindow.isDestroyed()) return;
  if (!agentSidebarWindow || agentSidebarWindow.isDestroyed()) createAgentSidebarWindow();
  const fire = () => {
    if (!agentSidebarWindow || agentSidebarWindow.isDestroyed()) return;
    setFloatingBounds(agentSidebarWindow, agentSidebarTargetBounds());
    agentSidebarWindow.showInactive();
    agentSidebarWindow.moveTop();
    agentRuntime?.emitList?.();
    positionMenuWindow();
  };
  if (agentSidebarWindow.webContents.isLoading()) {
    agentSidebarWindow.webContents.once("did-finish-load", fire);
  } else fire();
}

function hideAgentSidebarWindow() {
  if (agentSidebarWindowVisible()) agentSidebarWindow.hide();
  positionMenuWindow();
}

// ── Agent browser stage: one Chrome-style window, one WebContentsView tab per agent ─
const AGENT_STAGE_CHROME_DEFAULT = 82;
let agentStageWindow = null;
let agentStageChromeHeight = AGENT_STAGE_CHROME_DEFAULT;
let agentStageActiveId = null;

/**
 * Is the user currently looking at this agent's tab family (its browse tab, a
 * sub-tab it owns, or one of its deliverable subtabs)?
 *
 * This is the gate on stealing the stage. A finishing agent fronting its own
 * tab yanked the user away from whatever they were doing in another tab — the
 * moment a background task completed, their work switched out from under
 * them. Anything that wants to front a tab WITHOUT the user having asked for
 * it right now must check here first.
 */
function agentTabFamilyActive(ownerId) {
  const owner = String(ownerId || "").trim();
  if (!owner) return false;
  const active = String(agentStageActiveId || "").trim();
  if (!active) return false;
  if (active === owner) return true;
  if (agentTabIds.subTabOwner(active) === owner) return true;
  return String(agentBrowserMeta.get(active)?.ownerAgentId || "") === owner;
}
/** Studio agent chat side panel — closed until "Ask LYKN" in browser chrome. */
let agentChatOpen = false;
/** Tab ids destroyed since the last Studio tab-chat projection. */
let pendingClosedTabIds = [];
/** Saved-links dropdown open — the chrome surface overlays the page view so
 *  the menu renders in front instead of being buried behind the browser. */
let agentStageMenuOverlay = false;
/** Tab id waiting for Chrome-style omnibox focus after a user-opened new tab.
 *  Cleared once the home page finishes loading (or the user switches away). */
let agentStagePendingOmniboxFocusId = null;
/** @type {Map<string, WebContentsView>} */
const agentBrowserViews = new Map();
// New native page views stay detached until their first document has painted.
// Attaching a blank WebContentsView lets macOS briefly paint its white default
// surface over the browser page, even when its bounds are immediately parked.
const agentBrowserViewsReady = new Set();
// Bots currently armed for a user-approved browser run. Their hidden tabs must
// keep a REAL-sized, attached surface (parked fully offscreen) — a detached or
// zero-sized WebContentsView stops producing compositor frames, and frames are
// exactly what the tiny live viewport above the chat bar captures every beat.
// Updated by the agent runtime via setBotShotAgents.
const agentBotShotIds = new Set();
const agentBrowserLabels = new Map();
/** Hard ceiling on open browser tabs — matches MAX_WORKER_AGENTS (each
 *  worker agent owns a tab), keeping tab count and agent count capped
 *  together at 20. */
const MAX_AGENT_BROWSER_TABS = 20;

/** Main (agent) tabs only — deliverable subtabs don't count toward the cap. */
function agentBrowserMainTabCount() {
  let n = 0;
  for (const id of agentBrowserViews.keys()) {
    if (isAgentArtifactTabId(id) || isHiddenBotTab(id)) continue;
    n += 1;
  }
  return n;
}
/** Per-tab incognito (ephemeral session + dark chrome). */
const agentIncognito = new Map();
/** Default for new tabs / empty stage chrome theme. */
let agentStageIncognitoDefault = false;
/**
 * Shared signed-in profile for all non-incognito agent browser tabs.
 * Persist prefix keeps cookies/localStorage across app restarts so Gmail
 * (etc.) stay logged in the next time any agent opens that site.
 * Incognito tabs intentionally use a separate ephemeral partition.
 */
const AGENT_BROWSER_SHARED_PARTITION = "persist:lykn-agent-browser";
/**
 * @type {Map<string, {
 *   url?: string,
 *   pageTitle?: string,
 *   favicon?: string,
 *   kind?: "browse"|"artifact",
 *   artifactKind?: string,
 *   ownerAgentId?: string,
 * }>}
 */
const agentBrowserMeta = new Map();

/** Product icons for Google hosts — S2 returns the same "G" for every *.google.com. */
const AGENT_BRAND_ICON_BY_HOST = {
  "mail.google.com":
    "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
  "calendar.google.com":
    "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
  "drive.google.com":
    "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
  "docs.google.com":
    "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
  "sheets.google.com":
    "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
  "slides.google.com":
    "https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png",
  "keep.google.com":
    "https://www.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png",
  "youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
  "music.youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_music_2020q4_48dp.png",
};

function agentBrandIconFor(url) {
  try {
    const raw = String(url || "");
    const u = new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return "";
    const host = u.hostname.replace(/^www\./i, "");
    if (host === "docs.google.com") {
      if (raw.includes("/document/")) return AGENT_BRAND_ICON_BY_HOST["docs.google.com"];
      if (raw.includes("/spreadsheets/")) return AGENT_BRAND_ICON_BY_HOST["sheets.google.com"];
      if (raw.includes("/presentation/")) return AGENT_BRAND_ICON_BY_HOST["slides.google.com"];
    }
    if (host === "google.com" && raw.includes("/calendar/")) {
      return AGENT_BRAND_ICON_BY_HOST["calendar.google.com"];
    }
    return AGENT_BRAND_ICON_BY_HOST[host] || "";
  } catch {
    return "";
  }
}

/** Favicon for a page host — brand icons for Google products, else S2. */
function agentFaviconFallback(url) {
  const brand = agentBrandIconFor(url);
  if (brand) return brand;
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/i.test(u.protocol)) return "";
    const host = u.hostname.replace(/^www\./i, "");
    if (!host) return "";
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return "";
  }
}

function isAgentArtifactTabId(id) {
  return /^art-/.test(String(id || ""));
}

// ── Studio browser history ──────────────────────────────────────────────────
// Chrome-style: tabs stay open until the user exits them; a closed tab (or a
// deleted agent) drops into the History list the Studio rail shows under its
// Agents section. Persisted to userData so history survives restarts.
const AGENT_BROWSER_HISTORY_MAX = 200;
let agentBrowserHistoryCache = null;

function agentBrowserHistoryFile() {
  return path.join(app.getPath("userData"), "agent-browser-history.json");
}

function readAgentBrowserHistory() {
  if (agentBrowserHistoryCache) return agentBrowserHistoryCache;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(agentBrowserHistoryFile(), "utf8"));
    agentBrowserHistoryCache = Array.isArray(parsed?.items) ? parsed.items : [];
  } catch (_) {
    agentBrowserHistoryCache = [];
  }
  return agentBrowserHistoryCache;
}

function persistAgentBrowserHistory() {
  try {
    fsSync.writeFileSync(
      agentBrowserHistoryFile(),
      JSON.stringify({ items: readAgentBrowserHistory() }),
    );
  } catch (_) {
    /* history is best-effort */
  }
}

function pushAgentBrowserHistory() {
  emitAgentToUi("lykn:agent-browser-history", { items: readAgentBrowserHistory() });
}

/** Capture a closing tab/agent's identity BEFORE its view is torn down.
 *  Returns null for artifact previews (not browsing history). */
function snapshotAgentBrowserHistory(tabId) {
  const id = String(tabId || "").trim();
  if (!id || isAgentArtifactTabId(id)) return null;
  const view = agentBrowserViews.get(id);
  const meta = agentBrowserMeta.get(id) || {};
  let url = meta.url || "";
  let pageTitle = meta.pageTitle || "";
  try {
    if (view?.webContents && !view.webContents.isDestroyed()) {
      url = view.webContents.getURL() || url;
      pageTitle = view.webContents.getTitle() || pageTitle;
    }
  } catch (_) {}
  // Internal pages (welcome/new-tab, data blobs) aren't browsing history.
  if (/^(lykn|data|about|file|chrome):/i.test(url)) url = "";
  let title = agentBrowserLabels.get(id) || "";
  if (!title || /^new (agent|tab)$/i.test(title)) {
    try {
      const a = (agentRuntime?.listPublic?.() || []).find((x) => x.id === id);
      if (a?.title && !/^new agent$/i.test(a.title)) title = a.title;
    } catch (_) {}
  }
  if ((!title || /^new (agent|tab)$/i.test(title)) && pageTitle) title = pageTitle;
  // Capture the agent's conversation so reopening from History restores the
  // full chat, not just the page.
  let history = [];
  try {
    history = (agentRuntime?.getHistory?.(id) || [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-40)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000), at: m.at }));
  } catch (_) {}
  return { tabId: id, title: title || "Agent", pageTitle, url, history };
}

/** Push a captured snapshot into history (call after the close succeeded).
 *  Blank new-tab pages that never navigated anywhere are skipped. */
function commitAgentBrowserHistory(snap) {
  if (!snap) return;
  const hasChat = Array.isArray(snap.history) && snap.history.length > 0;
  // Skip only truly empty tabs (no page AND no conversation).
  if (!snap.url && !hasChat && (!snap.title || /^(new (agent|tab)|agent)$/i.test(snap.title))) {
    return;
  }
  const items = readAgentBrowserHistory();
  items.unshift({
    id: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: snap.title,
    pageTitle: snap.pageTitle || "",
    url: snap.url || "",
    history: hasChat ? snap.history : [],
    closedAt: new Date().toISOString(),
  });
  if (items.length > AGENT_BROWSER_HISTORY_MAX) items.length = AGENT_BROWSER_HISTORY_MAX;
  persistAgentBrowserHistory();
  pushAgentBrowserHistory();
}

function isAgentIncognito(agentId) {
  return !!agentIncognito.get(String(agentId || "").trim());
}

function agentBrowserPartition(agentId) {
  const id = String(agentId || "").trim();
  // A sub-tab lives in its OWNER's partition: an agent that signed in on its
  // first tab must still be signed in on the tab it opens next, and an
  // incognito agent's sub-tabs must share its incognito session rather than
  // each minting their own.
  const owner = agentTabIds.partitionOwner(id);
  return isAgentIncognito(owner)
    ? `lykn-agent-incognito-${owner}`
    : AGENT_BROWSER_SHARED_PARTITION;
}

/**
 * Home page for a fresh agent tab. The LYKN start page looks like a classic
 * search landing and keeps the omnibox empty so typing starts clean.
 */
const AGENT_BROWSER_HOME_URL = pathToFileURL(
  path.join(ELECTRON_DIR, "agent-browser-home.html"),
).href;

// Exact identity of the bundled home/welcome documents, for the home-only
// privileged IPC gates. The preload is on every agent tab, so these handlers
// must confirm the EXACT packaged document rather than a URL that merely looks
// like it (a remote https page whose path ends in the filename must fail).
const isTrustedAgentBrowserHomeUrl = (url) =>
  agentHomeIdentity.isTrustedAgentBrowserHomeUrl(url);

/** LYKN start page (new-tab home) — omnibox stays empty so typing starts clean. */
function isAgentBrowserHomeUrl(url) {
  return ownedBrowserAct.isAgentBrowserHomeDocument(url);
}

/** Home-page IPC only — the same preload is injected into every agent tab. */
function agentBrowserHomeSender(event) {
  const sender = event?.sender;
  if (!sender || sender.isDestroyed?.()) return null;
  try {
    // Exact packaged-document identity — not a filename suffix match.
    if (!isTrustedAgentBrowserHomeUrl(sender.getURL?.() || "")) {
      return null;
    }
  } catch {
    return null;
  }
  return sender;
}

function sanitizeHomeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 6)) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || "file").slice(0, 200);
    if (item.kind === "image") {
      const dataUrl = String(item.dataUrl || "");
      if (!/^data:image\/[\w+.-]+;base64,/i.test(dataUrl)) continue;
      if (dataUrl.length > 8_000_000) continue;
      out.push({ kind: "image", name, dataUrl });
      continue;
    }
    const text = String(item.text || "").slice(0, 200_000);
    if (!text) continue;
    out.push({ kind: "text", name, text });
  }
  return out;
}

async function attachmentsFromPickedPaths(filePaths) {
  const out = [];
  for (const p of (filePaths || []).slice(0, 6)) {
    try {
      const name = path.basename(p);
      const ext = path.extname(p).toLowerCase();
      const imgMime = IMAGE_MIME_BY_EXT[ext];
      if (imgMime) {
        const buf = await fs.readFile(p);
        out.push({
          kind: "image",
          name,
          dataUrl: `data:${imgMime};base64,${buf.toString("base64")}`,
        });
      } else if (TEXT_FILE_RE.test(name)) {
        const text = await fs.readFile(p, "utf8");
        out.push({ kind: "text", name, text });
      } else {
        out.push({ kind: "text", name, text: `(Attached file: ${name})` });
      }
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

/** Tabs that were still sitting on the old Google homepage should become LYKN home. */
function isLegacyGoogleHomeUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (!/^https?:$/i.test(u.protocol)) return false;
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "google.com") return false;
    const rest = (u.pathname || "/").replace(/\/+$/, "") || "";
    return !rest && !u.search && !u.hash;
  } catch (_) {
    return false;
  }
}

function loadAgentBrowserHome(wc) {
  if (!wc || wc.isDestroyed?.()) return;
  applyAgentTabEmulation(wc);
  try {
    void wc.loadURL(AGENT_BROWSER_HOME_URL);
  } catch (_) {}
}

/**
 * What the page sees in JS about the browser it is running in. The UA string
 * (app.userAgentFallback) and the Sec-CH-UA headers (wireAgentSessionClientHints)
 * already read as plain desktop Chrome, but navigator.userAgentData is built
 * from Chromium's own brand list and still names Electron. Brands here mirror
 * the header rewriting so both tell the same story.
 */
function chromeUserAgentOverride() {
  const full = String(process.versions.chrome || "").trim();
  const major = full.split(".")[0] || "";
  const userAgent = String(app.userAgentFallback || "").trim();
  if (!major || !userAgent) return null;
  const brand = (name, version) => ({ brand: name, version });
  let platformVersion = "";
  try {
    platformVersion = String(process.getSystemVersion?.() || "").trim();
  } catch (_) {}
  return {
    userAgent,
    userAgentMetadata: {
      brands: [brand("Chromium", major), brand("Google Chrome", major), brand("Not?A_Brand", "99")],
      fullVersionList: [
        brand("Chromium", full),
        brand("Google Chrome", full),
        brand("Not?A_Brand", "99.0.0.0"),
      ],
      platform:
        process.platform === "win32"
          ? "Windows"
          : process.platform === "darwin"
            ? "macOS"
            : "Linux",
      platformVersion,
      architecture: process.arch === "arm64" ? "arm" : "x86",
      bitness: "64",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
}

/**
 * The two things every agent tab has to be told about itself, both over CDP
 * because Electron has no per-view API for either. Run before the navigation so
 * the first paint and the first request already carry them.
 *
 * Light mode: the shell pins nativeTheme to dark for the glass vibrancy (see
 * themeSource near the top) and there is no per-view theme source, so Google
 * and every other site reading prefers-color-scheme loaded dark.
 *
 * Client hints: navigator.userAgentData hands the page Electron's brand however
 * clean the UA string and the headers are, and that is what "Sign in with
 * Google" reads before it decides whether to open its popup at all. Sites built
 * on Google Identity Services simply do nothing when they see it — no wall, no
 * error, a button that doesn't respond — which is why some logins came up and
 * others never appeared. Overriding the UA here sets the string and the
 * metadata behind navigator.userAgentData together.
 *
 * Idempotent and best-effort: a DevTools session takes over the CDP target and
 * drops all of it, so this is re-asserted on every navigation.
 */
function applyAgentTabEmulation(wc) {
  if (!wc || wc.isDestroyed?.()) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  } catch (_) {
    return;
  }
  // sendCommand rejects rather than throwing, so a try/catch around it catches
  // nothing and the failure surfaces as an unhandled rejection instead. It does
  // fail in normal use: called on a view that has never navigated, before there
  // is a CDP target to talk to, it comes back "target closed".
  const send = (method, params) => {
    try {
      wc.debugger.sendCommand(method, params).catch(() => {});
    } catch (_) {}
  };
  const ua = chromeUserAgentOverride();
  if (ua) send("Emulation.setUserAgentOverride", ua);
  send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
}

/**
 * Chrome-style omnibox: turn whatever the user typed into something loadable.
 * Real URLs (scheme, localhost, IPs, host.tld[/path]) navigate directly;
 * everything else becomes a Google search.
 */
function omniboxToUrl(input) {
  const q = String(input || "").trim();
  if (!q) return "";
  if (/^https?:\/\//i.test(q) || /^about:blank$/i.test(q)) return q;
  const hostish =
    !/\s/.test(q) &&
    (/^localhost(:\d+)?([/?#]|$)/i.test(q) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(q) ||
      /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(q));
  if (hostish) return `https://${q}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function agentStageUrlAllowed(url) {
  const u = String(url || "");
  return (
    /^https?:\/\//i.test(u) ||
    /^about:blank$/i.test(u) ||
    /^lykn-artifact:\/\//i.test(u) ||
    /^data:text\/html/i.test(u)
  );
}

/** Login / SSO URLs that must open as real popups (window.opener + shared cookies). */
function looksLikeAgentAuthPopupUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u || u === "about:blank") return true;
  return (
    /accounts\.google\.|gsi\.google\.|appleid\.apple\.|login\.microsoftonline\.|login\.live\.|facebook\.com\/|login\.yahoo\.|auth0\.|\.okta\.|oauth|openid|sso|saml/i.test(
      u,
    ) ||
    /canva\.com\/.*(login|signup|signin|oauth|sso)/i.test(u) ||
    /\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|register)(\/|\?|#|$)/i.test(u)
  );
}

/**
 * Parent for OAuth / SSO popups. Prefer a *visible* host — when Studio Browser
 * is docked, agentStageWindow is hidden, and parenting to it makes Google /
 * Apple / Microsoft login windows open behind Studio (or never surface).
 */
function agentAuthPopupParentWindow() {
  try {
    if (studioStageEmbedActive()) {
      const studio = d.studioWindow && !d.studioWindow.isDestroyed() ? d.studioWindow : null;
      if (studio) return studio;
    }
  } catch (_) {}
  try {
    if (
      agentStageWindow &&
      !agentStageWindow.isDestroyed() &&
      agentStageWindow.isVisible()
    ) {
      return agentStageWindow;
    }
  } catch (_) {}
  try {
    if (d.studioWindow && !d.studioWindow.isDestroyed() && d.studioWindow.isVisible()) {
      return d.studioWindow;
    }
  } catch (_) {}
  return undefined;
}

/** Show + focus a sign-in popup over the Studio / stage so login is one click away. */
function presentAgentAuthPopup(childWindow) {
  if (!childWindow || childWindow.isDestroyed?.()) return;
  try {
    childWindow.setMenuBarVisibility?.(false);
  } catch (_) {}
  const parent = agentAuthPopupParentWindow();
  try {
    // Re-parent if Electron attached to a hidden stage while Studio is docked.
    if (parent && typeof childWindow.setParentWindow === "function") {
      const cur = childWindow.getParentWindow?.();
      if (cur !== parent) childWindow.setParentWindow(parent);
    }
  } catch (_) {}
  try {
    const pb =
      parent && !parent.isDestroyed()
        ? typeof parent.getContentBounds === "function"
          ? parent.getContentBounds()
          : parent.getBounds()
        : null;
    if (pb && pb.width > 0 && pb.height > 0) {
      const cb = childWindow.getBounds();
      const w = Math.max(360, cb.width || 560);
      const h = Math.max(480, cb.height || 740);
      childWindow.setBounds({
        x: Math.round(pb.x + Math.max(0, (pb.width - w) / 2)),
        y: Math.round(pb.y + Math.max(0, (pb.height - h) / 2)),
        width: w,
        height: h,
      });
    } else {
      childWindow.center();
    }
  } catch (_) {
    try {
      childWindow.center();
    } catch (_) {}
  }
  try {
    // Raise the host first, then the popup — moveTop on parent after the
    // child can bury the Sign in window under Studio on macOS.
    if (parent && !parent.isDestroyed()) {
      if (!parent.isVisible()) parent.show();
      parent.moveTop();
    }
    if (!childWindow.isVisible()) childWindow.show();
    childWindow.moveTop();
    childWindow.focus();
  } catch (_) {}
}

function wireAgentPopupWindow(childWindow, { parentWc, agentId } = {}) {
  if (!childWindow || childWindow.isDestroyed?.()) return;
  presentAgentAuthPopup(childWindow);
  const childWc = childWindow.webContents;
  if (!childWc || childWc.isDestroyed?.()) return;
  try {
    // Same chrome UA as the rest of the app (strip Electron token).
    if (app.userAgentFallback) childWc.setUserAgent(app.userAgentFallback);
  } catch (_) {}
  // This is the window accounts.google.com actually loads in, and it checks the
  // browser it's running in as hard as the opener did — the "This browser or app
  // may not be secure" wall. Re-asserted per navigation: an OAuth flow crosses
  // several documents in here, some of them in a different process.
  applyAgentTabEmulation(childWc);
  childWc.on("did-navigate", () => applyAgentTabEmulation(childWc));
  childWc.setWindowOpenHandler((details) => {
    const u = String(details?.url || "");
    if (!agentStageUrlAllowed(u)) return { action: "deny" };
    // Nested OAuth steps — keep popping real windows on the same partition.
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 560,
        height: 740,
        autoHideMenuBar: true,
        title: "Sign in",
        parent: agentAuthPopupParentWindow(),
        webPreferences: {
          partition: agentBrowserPartition(agentId),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });
  childWc.on("did-create-window", (nested) => {
    presentAgentAuthPopup(nested);
    wireAgentPopupWindow(nested, { parentWc, agentId });
  });
  childWc.on("will-navigate", (event, url) => {
    if (!agentStageUrlAllowed(url)) event.preventDefault();
  });
  wireAgentSessionPermissions(childWc.session);
  // OAuth runs in this popup — it needs the same Chrome-looking client hints.
  wireAgentSessionClientHints(childWc.session);
  // If the opener navigates the popup after about:blank, re-raise it once.
  const raiseOnNavigate = () => {
    try {
      presentAgentAuthPopup(childWindow);
    } catch (_) {}
  };
  childWc.once("did-finish-load", raiseOnNavigate);
  childWc.once("dom-ready", raiseOnNavigate);
  childWindow.on("closed", () => {
    // Parent site finishes auth via postMessage + cookies on the shared partition.
    try {
      pushAgentStageState();
      layoutAgentStageViews();
    } catch (_) {}
    try {
      if (!parentWc || parentWc.isDestroyed?.()) return;
      const cur = String(parentWc.getURL?.() || "");
      const blank =
        !cur ||
        /^about:blank$/i.test(cur) ||
        ownedBrowserAct.isPlaceholderAgentUrl(cur);
      if (!blank) return;
      const meta = agentBrowserMeta.get(agentId) || {};
      const resume = String(meta.lastHttpsUrl || meta.url || "").trim();
      if (/^https?:\/\//i.test(resume)) {
        void parentWc.loadURL(resume);
      }
    } catch (_) {}
  });
}

function agentStageVisible() {
  return !!(
    agentStageWindow &&
    !agentStageWindow.isDestroyed() &&
    agentStageWindow.isVisible()
  );
}

// ── Studio-docked browser ───────────────────────────────────────────────────
// The Studio's "Browser" tab docks the agent stage inside the Studio window:
// the stage chrome (tab strip / toolbar) renders in its own WebContentsView
// and the shared agent browser views are re-parented onto the Studio window
// at the panel bounds the renderer reports via `lykn:studio-browser-set`.
let studioStageChromeView = null;
let studioStageBounds = null; // DIP rect within the studio window's content
let studioStageEmbedded = false;
// True while the Studio Browser window is being fully closed (red traffic
// light). Closing the last tab must not spawn a replacement — the next open
// starts a fresh session. Minimize never sets this.
let studioBrowserDisposing = false;
// The browser docks into the body of the Studio's floating Browser window.
// Chrome wears the frame's corner curve. The live page stays square so it
// meets the tab strip flush — Electron cannot round only the bottom. The
// renderer owns that chrome radius and reports it with the bounds; this is
// just the fallback until the first report lands.
const STUDIO_DOCK_RADIUS = 14;
let studioStageRadius = STUDIO_DOCK_RADIUS;

function studioStageEmbedActive() {
  return !!(studioStageEmbedded && d.studioWindow && !d.studioWindow.isDestroyed());
}

// WebContentsView attach/detach helpers (BrowserWindow.contentView children;
// re-adding an attached view moves it to the top of the stack).
// addChildView re-orders a view that is already attached, which is how the
// active page gets raised above the chrome. Layout runs on every bounds report
// — drag, resize, load event — and re-stacking the hierarchy that often makes
// the browser flicker, so remember what is on top and only restack on change.
// Any attach/detach from anywhere else drops the memo.
let agentStageStackKey = "";

function attachViewToWindow(win, view) {
  if (!win || win.isDestroyed() || !view) return;
  agentStageStackKey = "";
  try {
    win.contentView.addChildView(view);
  } catch (_) {}
}

function detachViewFromWindow(win, view) {
  if (!win || win.isDestroyed() || !view) return;
  agentStageStackKey = "";
  try {
    win.contentView.removeChildView(view);
  } catch (_) {}
}

function setViewVisible(view, visible) {
  try {
    view?.setVisible?.(visible);
  } catch (_) {}
}

function raiseAgentStageView(win, view, key) {
  if (agentStageStackKey === key) return;
  attachViewToWindow(win, view);
  agentStageStackKey = key;
}

function setViewRadius(view, radius) {
  applyViewRadius(view, radius);
}

/** Place a docked view, then clip it. Electron applies `setBorderRadius`
 *  against the current box and does not restore it on the next `setBounds`,
 *  so parking a page at 0×0 until first paint used to wipe the curve and
 *  leave every later layout square at the window's bottom corners. */
function setDockedViewBounds(view, bounds, { radius = 0 } = {}) {
  if (!view || !bounds) return;
  try {
    view.setBounds(bounds);
  } catch (_) {}
  const w = Math.max(0, Number(bounds.width) || 0);
  const h = Math.max(0, Number(bounds.height) || 0);
  if (w >= 2 && h >= 2) setViewRadius(view, radius);
}

function ensureStudioStageChromeView() {
  if (
    studioStageChromeView &&
    studioStageChromeView.webContents &&
    !studioStageChromeView.webContents.isDestroyed()
  ) {
    return studioStageChromeView;
  }
  studioStageChromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "agent-stage-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Light chrome from the very first frame — no glass showing through while
  // agent-stage.html loads.
  try {
    studioStageChromeView.setBackgroundColor("#ececeb");
  } catch (_) {}
  // The chrome is the top of the floating window — its tab strip stands in for
  // the title bar — so it wears the frame's corner curve. The matching curve it
  // also cuts along its bottom sits hidden behind the page view.
  setViewRadius(studioStageChromeView, studioStageRadius);
  studioStageChromeView.webContents.loadFile(path.join(ELECTRON_DIR, "agent-stage.html"));
  studioStageChromeView.webContents.on("did-finish-load", () => {
    pushAgentStageState();
    layoutAgentStageViews();
  });
  return studioStageChromeView;
}

// Out of sight, the docked views sit at the panel's exact size but shifted
// clear of the Studio window's right edge, which clips them. They stay visible
// to Chromium there, so each page holds a live frame at the size it will come
// back at and the reveal is a plain move — nothing to re-render, nothing to
// reflow. Hiding them instead (View.setVisible) drops those frames, and the
// page returns as a blurry stretch of the last one until the compositor
// rebuilds it. Detaching them to the standalone stage window is worse again:
// that window's layout pass reflows every page into its size and back out, the
// second reflow landing after the page is on screen, as a jump.
let studioStageRevealed = false;

/** How far right of the window the parked views sit, in DIP. 0 once revealed. */
function studioStageParkShift() {
  if (studioStageRevealed) return 0;
  let contentW = 0;
  try {
    if (d.studioWindow && !d.studioWindow.isDestroyed()) {
      [contentW] = d.studioWindow.getContentSize();
    }
  } catch (_) {}
  const paneRight = studioStageBounds
    ? studioStageBounds.x + studioStageBounds.width
    : 0;
  return Math.max(contentW, paneRight, 0) + 40;
}

// The Studio doesn't hand over its final pane rect in one go: the frame reports
// itself as it opens, and an unplaced frame measures at the desktop's top-left
// before its geometry lands. A page revealed on the first report wears the tail
// of that as a pop up to the corner, so a fresh dock stays parked (the
// renderer's skeleton stands in) until the rect has held still.
const STUDIO_STAGE_REVEAL_SETTLE_MS = 90;
let studioStageRevealTimer = null;

function cancelStudioStageReveal() {
  if (!studioStageRevealTimer) return;
  clearTimeout(studioStageRevealTimer);
  studioStageRevealTimer = null;
}

function revealStudioStageViewsWhenSettled() {
  cancelStudioStageReveal();
  studioStageRevealTimer = setTimeout(() => {
    studioStageRevealTimer = null;
    if (!studioStageEmbedActive()) return;
    studioStageRevealed = true;
    layoutAgentStageViews();
  }, STUDIO_STAGE_REVEAL_SETTLE_MS);
}

/**
 * Hand the views back to the standalone stage window — what happens when the
 * Studio window itself goes away, taking the only window they were attached to
 * with it.
 */
function parkStudioStageViewsOnStage() {
  cancelStudioStageReveal();
  const studio = d.studioWindow && !d.studioWindow.isDestroyed() ? d.studioWindow : null;
  if (studio) {
    detachViewFromWindow(studio, studioStageChromeView);
    for (const view of agentBrowserViews.values()) detachViewFromWindow(studio, view);
  }
  // Square corners again, and visible: nothing hides them over there.
  for (const view of agentBrowserViews.values()) {
    setViewRadius(view, 0);
    setViewVisible(view, true);
    if (agentStageWindow && !agentStageWindow.isDestroyed()) {
      attachViewToWindow(agentStageWindow, view);
    }
  }
  if (agentStageWindow && !agentStageWindow.isDestroyed()) layoutAgentStageViews();
}

/** Dock (open) or undock (close) the agent browser inside the Studio window. */
function setStudioBrowserEmbed({ open, bounds, radius } = {}) {
  if (!open) {
    if (!studioStageEmbedded) return;
    cancelStudioStageReveal();
    // Parked before the dock goes inactive, so this layout still runs the
    // docked branch. Same window, same size, same zoom — only shifted off the
    // edge, ready to move straight back in.
    studioStageRevealed = false;
    layoutAgentStageViews();
    studioStageEmbedded = false;
    return;
  }

  if (!d.studioWindow || d.studioWindow.isDestroyed()) return;
  let paneMoved = false;
  if (bounds && typeof bounds === "object") {
    // x/y may be negative: the Browser window can be dragged past the desktop's
    // edges, and the window clips whatever hangs off. Pinning them to 0 would
    // slide the page back out from under its own frame.
    const next = {
      x: Math.round(Number(bounds.x) || 0),
      y: Math.round(Number(bounds.y) || 0),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    paneMoved =
      !studioStageBounds ||
      studioStageBounds.x !== next.x ||
      studioStageBounds.y !== next.y ||
      studioStageBounds.width !== next.width ||
      studioStageBounds.height !== next.height;
    studioStageBounds = next;
    // Before the views are attached below: a Studio resized while the browser
    // was closed re-flows its pages off-screen this way, instead of in front of
    // the user a frame after they reappear.
    fitAgentTabsToPane(studioStageBounds.width);
  }
  // The window frame's radius can only reach the views from the renderer, so
  // pick it up here and repaint any that are already docked. Open rail uses
  // per-corner radii so the page meets the chat on a straight edge.
  const nextRadius = normalizeViewRadius(radius);
  if (nextRadius != null && !viewRadiiEqual(nextRadius, studioStageRadius)) {
    studioStageRadius = nextRadius;
    if (studioStageEmbedded) {
      for (const view of agentBrowserViews.values()) setViewRadius(view, pageClipRadius());
      setViewRadius(studioStageChromeView, nextRadius);
    }
  }
  const freshDock = !studioStageEmbedded;
  if (freshDock) {
    studioStageEmbedded = true;
    // The browser lives in exactly one window at a time — reclaim the views
    // from the standalone stage window.
    if (agentStageWindow && !agentStageWindow.isDestroyed()) {
      if (agentStageWindow.isVisible()) agentStageWindow.hide();
      for (const view of agentBrowserViews.values()) {
        detachViewFromWindow(agentStageWindow, view);
      }
    }
    const chrome = ensureStudioStageChromeView();
    attachViewToWindow(d.studioWindow, chrome);
    for (const view of agentBrowserViews.values()) {
      setViewRadius(view, pageClipRadius());
      attachViewToWindow(d.studioWindow, view);
    }
    // Tabs wait on the persisted agent list so a raced load() can't add
    // restored workers on top of the fresh tab warm already created.
    void whenAgentRuntimeLoaded().then(() => {
      if (!studioStageEmbedActive()) return;
      fillEmptyStudioBrowser({ show: false });
      pushAgentStageState();
      layoutAgentStageViews();
    });
    pushAgentStageState();
    // Parked for the layout below, however they arrived: the pages take the new
    // panel size off the edge of the window and are done reflowing to it before
    // anyone sees them. The first dock of the session and every one after it
    // open the same way.
    studioStageRevealed = false;
    // Freshly docked: take a picture as soon as the page has settled, so the
    // close that follows has the browser as it actually looks to animate over.
    scheduleStudioStageShot(600);
  }
  layoutAgentStageViews();
  // Arm the reveal on the dock, and push it back out every time the pane lands
  // somewhere new — the page appears once, already at its final size, however
  // many rects the opening window reports on the way there.
  if (freshDock || (studioStageRevealTimer && paneMoved)) {
    revealStudioStageViewsWhenSettled();
  }
}

/**
 * Put the caret in the stage omnibox (Search or type a URL), like Chrome on
 * a fresh tab. Focuses the chrome WebContents first so keystrokes aren't
 * swallowed by the page view underneath.
 */
function focusAgentStageOmnibox() {
  try {
    if (
      studioStageEmbedActive() &&
      studioStageChromeView?.webContents &&
      !studioStageChromeView.webContents.isDestroyed()
    ) {
      studioStageChromeView.webContents.focus();
      studioStageChromeView.webContents.send("lykn:agent-stage-focus-omnibox");
      return;
    }
  } catch (_) {}
  try {
    if (agentStageWindow && !agentStageWindow.isDestroyed()) {
      agentStageWindow.webContents.focus();
      agentStageWindow.webContents.send("lykn:agent-stage-focus-omnibox");
    }
  } catch (_) {}
}

/** Focus the omnibox now and again when this tab's home page finishes loading
 *  (page views otherwise steal focus once Google paints). */
function requestOmniboxFocusForTab(agentId) {
  const id = String(agentId || "").trim();
  if (!id) return;
  agentStagePendingOmniboxFocusId = id;
  focusAgentStageOmnibox();
  setTimeout(() => {
    if (agentStagePendingOmniboxFocusId === id) focusAgentStageOmnibox();
  }, 250);
}

/** Fresh Studio browser tab. Every tab is agent-backed: a new tab always
 *  brings its own agent into the rail, and closing either side closes both.
 *  Falls back to a plain (agent-less) tab only if the agent cap is hit. */
function openFreshStudioBrowserTab({ show = true, focusOmnibox = false } = {}) {
  if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) return;
  try {
    const rt = initAgentRuntime();
    if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    // Silent so createAgent doesn't raise the standalone stage (and so
    // setAgentMode no longer also spawns a second standby worker).
    const res = rt.createAgent({ title: "New agent", silent: true, activate: true });
    if (res?.ok && res.agentId) {
      ensureAgentBrowserWindow(res.agentId, {
        show,
        focus: true,
        label: res.agent?.title || "New agent",
      });
      if (focusOmnibox) requestOmniboxFocusForTab(res.agentId);
      return;
    }
  } catch (_) {}
  try {
    const id = `studio-tab-${Date.now()}`;
    ensureAgentBrowserWindow(id, {
      show: false,
      focus: true,
      label: "New tab",
    });
    if (focusOmnibox) requestOmniboxFocusForTab(id);
  } catch (_) {}
}

/**
 * Get the browser ready before it is ever shown. The Browser window's open
 * animation runs with the native views undocked, and that is enough time to
 * load the stage chrome and the first tab's home page — so docking reveals a
 * painted page instead of leaving the renderer's underlay up through a cold
 * tab creation plus a network load. Idempotent: warming an already-warm
 * browser does nothing.
 */
function fillEmptyStudioBrowser({ show = false } = {}) {
  try {
    initAgentRuntime().ensureAgentTabs?.();
  } catch (_) {}
  if (!hasUserBrowserTab()) openFreshStudioBrowserTab({ show });
}

async function warmStudioBrowser() {
  if (!d.studioWindow || d.studioWindow.isDestroyed()) return;
  try {
    ensureStudioStageChromeView();
  } catch (_) {}
  await whenAgentRuntimeLoaded();
  if (hasUserBrowserTab()) return;
  fillEmptyStudioBrowser({ show: false });
}

/** Click-to-reveal set: Bot work surfaces the user opened from the peek.
 *  Cleared when the Studio Browser session closes or the user hides that tab. */
const revealedBotTabs = new Set();

function botVisibilityOpts() {
  return {
    isHeadless: (id) => {
      try {
        return !!initAgentRuntime().isHeadless?.(id);
      } catch {
        return false;
      }
    },
    isRevealed: (id) => revealedBotTabs.has(String(id || "").trim()),
    partitionOwner: (id) => agentTabIds.partitionOwner(id) || id,
  };
}

function isHeadlessBotTab(id) {
  return botTabVisibility.isHeadlessBotTab(id, botVisibilityOpts());
}

/** Hidden until the user opens the peek. Revealed Bot tabs are user tabs. */
function isHiddenBotTab(id) {
  return botTabVisibility.isHiddenBotTab(id, botVisibilityOpts());
}

function tabChatProjection(extra = {}) {
  const activeId = extra.activeAgentId || extra.agentId || agentStageActiveId;
  return {
    ...tabChatLineage.projectTabChatBindings({
      metaById: agentBrowserMeta,
      activeId,
      chatOpen: extra.open ?? agentChatOpen,
      isHiddenTab: isHiddenBotTab,
      closedTabIds: extra.closedTabIds || [],
    }),
    ...extra,
  };
}

function notifyStudioTabChatState(extra = {}) {
  const win = d.studioWindow;
  if (!win || win.isDestroyed()) return;
  const closed = pendingClosedTabIds.splice(0);
  const payload = tabChatProjection({
    ...extra,
    closedTabIds: [...closed, ...(extra.closedTabIds || [])],
  });
  try {
    win.webContents.send("lykn:agent-chat-visibility", payload);
  } catch (_) {}
}

function clearTabSourceChatIds() {
  tabChatLineage.stripSourceChatIds(agentBrowserMeta);
  notifyStudioTabChatState();
}

function noteClosedTabChat(tabId) {
  const id = String(tabId || "").trim();
  if (id) pendingClosedTabIds.push(id);
}

function revealBotBrowserTab(id) {
  const owner = botTabVisibility.botTabOwner(id, botVisibilityOpts().partitionOwner);
  if (owner) revealedBotTabs.add(owner);
}

function concealBotBrowserTab(id) {
  const raw = String(id || "").trim();
  const owner = botTabVisibility.botTabOwner(id, botVisibilityOpts().partitionOwner);
  if (raw) revealedBotTabs.delete(raw);
  if (owner) revealedBotTabs.delete(owner);
  if (agentStageActiveId === raw || (owner && agentStageActiveId === owner)) {
    agentStageActiveId = userBrowserTabIds().find((tabId) => tabId !== raw && tabId !== owner) || null;
  }
  if (!hasUserBrowserTab() && studioStageEmbedActive() && !studioBrowserDisposing) {
    openFreshStudioBrowserTab({ focusOmnibox: true });
  }
  if (owner && agentBotShotIds.has(owner)) {
    try {
      prepareBotShotSurface(owner);
    } catch {
      /* peek park is best-effort */
    }
  }
  layoutAgentStageViews();
  pushAgentStageState();
}

/** Tabs the user can see and switch. Hidden Bot shot surfaces stay off-strip. */
function userBrowserTabIds() {
  return [...agentBrowserViews.keys()].filter((id) => !isHiddenBotTab(id));
}

function hasUserBrowserTab() {
  return userBrowserTabIds().length > 0;
}

/** Red traffic light: close the Studio Browser window for real. Tabs go to
 *  History, agents are retired, views are destroyed. The next press warms a
 *  fresh session. Minimize never calls this — it only undocks the views. */
function closeStudioBrowserSession() {
  // Closing the Studio Browser is a fresh *browser* session. Headless Bots
  // are teammates, not tabs - keep their agents and work surfaces alive so
  // a mid-task research/browse run does not die as `agent_closed`.
  const tabIds = [...agentBrowserViews.keys()].filter((id) => !isHeadlessBotTab(id));
  revealedBotTabs.clear();
  const snaps = tabIds.map((id) => snapshotAgentBrowserHistory(id));
  studioBrowserDisposing = true;
  try {
    try {
      setStudioBrowserEmbed({ open: false });
    } catch (_) {}
    try {
      initAgentRuntime().closeAllWorkers?.();
    } catch (_) {}
    for (const id of tabIds) {
      destroyAgentBrowserWindow(id);
    }
    for (const snap of snaps) commitAgentBrowserHistory(snap);
    try {
      void initAgentRuntime().persistNow?.();
    } catch (_) {}
    pushAgentStageState();
  } finally {
    studioBrowserDisposing = false;
  }
  return { ok: true };
}

/** Open a manual browser tab already navigated to `url` (used by Chrome sync).
 *  Returns the tab id, or null when at the tab cap / on failure. */
function openStudioBrowserTabWithUrl(url, { focus = false, sourceChatId } = {}) {
  if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) return null;
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return null;
  const id = `studio-tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const chat = String(sourceChatId || "").trim();
  try {
    const wrap = ensureAgentBrowserWindow(id, { show: false, focus, label: "Loading…" });
    if (chat) {
      agentBrowserMeta.set(id, {
        ...(agentBrowserMeta.get(id) || {}),
        sourceChatId: chat,
      });
    }
    const wc = wrap?.webContents;
    if (wc && !wc.isDestroyed()) {
      // Fire-and-forget: the tab strip updates from the view's own load events.
      ownedBrowserAct.navigate(wc, target).catch(() => {});
    }
    return id;
  } catch (_) {
    return null;
  }
}

/** Canonical form for de-duping tabs during Chrome sync: drop scheme/#hash,
 *  strip "www." and trailing slashes, lowercase host. Keeps the query (it
 *  usually distinguishes real pages). Returns "" for non-http(s) URLs. */
function normalizeSyncUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/.test(u.protocol)) return "";
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search || ""}`;
  } catch {
    return "";
  }
}

/** Open a real AGENT tab navigated to `url` — each synced tab becomes its own
 *  agent so the AI can act on it. Returns the agent id, or null on cap/failure.
 *  `show:false` creates the tab without raising the hosting window — for
 *  callers about to dock the browser somewhere else (Studio Browser tab). */
function openAgentBrowserTabWithUrl(url, { title, focus = false, show = true, sourceChatId } = {}) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return null;
  if (agentBrowserMainTabCount() >= MAX_AGENT_BROWSER_TABS) return null;
  let label = String(title || "").trim();
  if (!label) {
    try {
      label = new URL(target).hostname.replace(/^www\./, "");
    } catch {
      label = "Tab";
    }
  }
  const chat = String(sourceChatId || "").trim();
  try {
    const rt = initAgentRuntime();
    if (!rt.isAgentModeOn?.()) rt.setAgentMode?.(true);
    // When show is false (Studio about to dock), create the agent quietly so
    // we don't flash the standalone stage + welcome page, then clobber the
    // real navigation when docking re-calls ensure.
    const res = rt.createAgent({ title: label, activate: focus, silent: !show });
    if (!res?.ok || !res.agentId) return null;
    const id = res.agentId;
    // Mark browsing BEFORE ensure/show so a concurrent dock can't reload welcome.
    agentBrowserLabels.set(id, label);
    agentBrowserMeta.set(id, {
      ...(agentBrowserMeta.get(id) || {}),
      kind: "browsing",
      url: target,
      pageTitle: label,
      ...(chat ? { sourceChatId: chat } : {}),
    });
    if (show) {
      showAgentBrowserWindow(id, { focus, label });
    } else {
      ensureAgentBrowserWindow(id, { show: false, focus, label });
    }
    const wc = getAgentBrowserWebContents(id);
    if (wc && !wc.isDestroyed()) {
      // Fire navigate but keep meta.kind=browsing until load settles so docking
      // mid-flight cannot wipe the tab back to the welcome page.
      ownedBrowserAct
        .navigate(wc, target)
        .then((nav) => {
          const meta = agentBrowserMeta.get(id) || {};
          if (meta.kind !== "browsing") return;
          agentBrowserMeta.set(id, {
            ...meta,
            kind: "page",
            url: nav?.url || target,
            pageTitle: label,
          });
          try {
            rt.setAgentUrl?.(id, nav?.url || target);
          } catch (_) {}
          pushAgentStageState();
        })
        .catch((err) => {
          console.warn("[lykn] agent tab navigate failed:", err?.message || err);
        });
    }
    return id;
  } catch (_) {
    return null;
  }
}

// ── Private browsing-habits context (Chrome sync) ────────────────────────────
// Kept for the AGENT only — folded into agent prompts so it knows what the user
// usually does. Never shown to the user as a report/chat turn. Persisted so it
// survives restarts.
let browsingHabitsContext = "";

function browsingContextFile() {
  return path.join(app.getPath("userData"), "browsing-context.json");
}

function loadBrowsingHabitsContext() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(browsingContextFile(), "utf8"));
    browsingHabitsContext = String(parsed?.context || "");
  } catch (_) {
    browsingHabitsContext = "";
  }
  return browsingHabitsContext;
}

function getBrowsingContext() {
  return browsingHabitsContext;
}

/** Build + store a concise, private habits summary from history. Returns true
 *  when something was stored. No AI call, no visible turn. */
function setBrowsingContextFromHistory(history, browserName) {
  const items = Array.isArray(history?.items) ? history.items : [];
  const domains = Array.isArray(history?.domains) ? history.domains : [];
  if (!items.length && !domains.length) return false;
  const topDomains = domains
    .slice(0, 15)
    .map((d) => `${d.domain} (${d.visits})`)
    .join(", ");
  const topPages = items
    .slice(0, 12)
    .map((it) => `- ${it.title ? it.title.slice(0, 80) + " — " : ""}${it.url}`)
    .join("\n");
  browsingHabitsContext = [
    `Most-visited domains from the user's ${browserName || "browser"}: ${topDomains}.`,
    topPages ? `Frequently opened pages:\n${topPages}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    fsSync.writeFileSync(
      browsingContextFile(),
      JSON.stringify({ context: browsingHabitsContext, updatedAt: new Date().toISOString() }),
    );
  } catch (_) {
    /* best-effort persistence */
  }
  return true;
}

function createAgentStageWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  agentStageWindow = new BrowserWindow({
    width: Math.min(1180, workArea.width - 40),
    height: Math.min(780, workArea.height - 40),
    x: Math.round(workArea.x + 48),
    y: Math.round(workArea.y + 48),
    show: false,
    title: "LYKN Agent Browser",
    backgroundColor: "#12151c",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ELECTRON_DIR, "agent-stage-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    agentStageWindow.setContentProtection(isContentProtectionEnabled());
  } catch (_) {}
  agentStageWindow.loadFile(path.join(ELECTRON_DIR, "agent-stage.html"));
  agentStageWindow.on("closed", () => {
    // If the views are docked inside the Studio window they outlive the
    // standalone stage window — don't tear them down.
    if (!studioStageEmbedActive()) {
      for (const [id, view] of [...agentBrowserViews.entries()]) {
        try {
          view.webContents?.close?.();
        } catch (_) {}
        agentBrowserViews.delete(id);
      }
      agentStageActiveId = null;
    }
    agentStageWindow = null;
  });
  agentStageWindow.on("resize", () => layoutAgentStageViews());
  agentStageWindow.webContents.on("did-finish-load", () => {
    pushAgentStageState();
    layoutAgentStageViews();
  });
}

function ensureAgentStageWindow() {
  if (!agentStageWindow || agentStageWindow.isDestroyed()) createAgentStageWindow();
  return agentStageWindow;
}

/** Height the tab strip + toolbar occupy above the page, as the stage reports it. */
function agentStageChromeH() {
  return Math.max(60, Math.min(140, agentStageChromeHeight || AGENT_STAGE_CHROME_DEFAULT));
}

// ── A picture of the browser, for the window's own motion ───────────────────
// Native views are not part of the renderer's paint, so CSS can neither scale
// nor fade them: the Studio has to take them away while its Browser window
// flies open or shut. That left the page blinking out of existence at the start
// of a close and appearing whole at the end of an open — an animation with
// nothing in it, which reads as the window simply popping in and out.
//
// So keep a still picture of the browser and let the frame animate that. Chrome
// (tab strip) and page are separate views, hence two images, stacked back
// together in the renderer at the same seam the layout uses.
//
// The picture is also what makes the *next* open animate: the renderer holds on
// to the last one, so a closed browser still has itself to grow back from,
// exactly as the user left it.
let studioStageShotTimer = null;
let studioStageShotAt = 0;
// Pages change in bursts (navigate → title → favicon → load), and this runs off
// that same signal, so it waits out the burst and never repeats too often. A
// picture only has to be about as fresh as the last thing the user looked at.
const STAGE_SHOT_DEBOUNCE = 1200;
const STAGE_SHOT_MIN_GAP = 2500;

async function viewShotDataUrl(view, targetWidth) {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return "";
  try {
    let img = await wc.capturePage();
    if (!img || img.isEmpty()) return "";
    // Down to the size it will actually be drawn at: a Retina capture is four
    // times the pixels for detail that only exists while the window is in
    // motion, and this crosses to the renderer as a string.
    const w = Math.round(Number(targetWidth) || 0);
    if (w > 0 && img.getSize().width > w) img = img.resize({ width: w, quality: "good" });
    // JPEG, not PNG: shown for a couple of hundred milliseconds, in motion,
    // under a fade. Nobody reads text off it, and lossless would be megabytes.
    return `data:image/jpeg;base64,${img.toJPEG(70).toString("base64")}`;
  } catch (_) {
    return "";
  }
}

async function refreshStudioStageShot() {
  if (!studioStageEmbedActive()) return;
  const shotWidth = studioStageBounds?.width || 0;
  const [chrome, page] = await Promise.all([
    viewShotDataUrl(studioStageChromeView, shotWidth),
    viewShotDataUrl(agentBrowserViews.get(agentStageActiveId), shotWidth),
  ]);
  // Nothing captured — keep the previous picture rather than blanking the
  // window's animation.
  if (!chrome && !page) return;
  studioStageShotAt = Date.now();
  try {
    if (d.studioWindow && !d.studioWindow.isDestroyed()) {
      d.studioWindow.webContents.send("lykn:studio-browser-shot", {
        ok: true,
        chrome,
        page,
        chromeHeight: agentStageChromeH(),
      });
    }
  } catch (_) {}
}

function scheduleStudioStageShot(delay = STAGE_SHOT_DEBOUNCE) {
  if (!studioStageEmbedActive()) return;
  // A capture already waiting is never pushed further out: the stage can change
  // several times a second while an agent works, and re-arming on every change
  // would starve the picture for as long as the agent kept working.
  if (studioStageShotTimer) return;
  const since = Date.now() - studioStageShotAt;
  studioStageShotTimer = setTimeout(
    () => {
      studioStageShotTimer = null;
      void refreshStudioStageShot();
    },
    Math.max(delay, STAGE_SHOT_MIN_GAP - since),
  );
}

// Floor for the reference width below, and the room Google and most desktop
// sites lay out for. A pane narrower than its reference scales the page down to
// keep that layout rather than letting it reflow into a cramped breakpoint.
const AGENT_TAB_LAYOUT_WIDTH = 1280;
const AGENT_TAB_MIN_ZOOM = 0.5;
// How much of the pane's shortfall against the reference comes off the zoom. At
// 1 the page is scaled in step with how much of the desktop the window covers —
// a full-screen layout shrunk to fit, which is the intuition, but it reads far
// smaller than it needs to: the window is not trying to show a whole desktop's
// worth of page, only to avoid a cramped one. Well under 1 takes the edge off a
// narrow pane while keeping the text at a comfortable size. A window covering
// three quarters of the desktop lands at 84%, against the 74% a plain ratio
// would give it.
const AGENT_TAB_ZOOM_FALLOFF = 0.6;

/**
 * The width a browser filling the desktop would have — what every narrower pane
 * is judged against. This was a flat 1280, which quietly did nothing on a large
 * display: the floating window's size is restored from where the user last left
 * it, and any window dragged past 1280 landed on exactly 100% no matter how
 * much of the screen it actually covered. Measuring the desktop instead means
 * "floating" is relative to the screen it floats on.
 */
function agentTabReferenceWidth() {
  let deskW = 0;
  try {
    if (d.studioWindow && !d.studioWindow.isDestroyed()) [deskW] = d.studioWindow.getContentSize();
  } catch (_) {}
  if (!(deskW > 0)) {
    try {
      deskW = screen.getPrimaryDisplay().workAreaSize.width;
    } catch (_) {}
  }
  return Math.max(AGENT_TAB_LAYOUT_WIDTH, Math.round(Number(deskW) || 0));
}

/** Zoom that fits a desktop layout into `width` DIP of pane, with room over. */
function agentTabZoomForWidth(width) {
  const w = Math.round(Number(width) || 0);
  // Parked background view — no pane to fit yet, and zoom 0 is not a thing.
  if (w <= 0) return 0;
  const shortfall = Math.max(0, 1 - w / agentTabReferenceWidth());
  const factor = Math.round((1 - shortfall * AGENT_TAB_ZOOM_FALLOFF) * 1000) / 1000;
  // Never magnify past 100%: a pane filling the desktop just shows more.
  return Math.min(1, Math.max(AGENT_TAB_MIN_ZOOM, factor));
}

/** Last zoom logged per tab, so a steady pane doesn't repeat itself. */
const agentTabZoomLogged = new Map();

function applyAgentTabZoom(id, view, width) {
  // Artifact tabs render our own responsive report HTML — it already fits.
  if (isAgentArtifactTabId(id)) return;
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) return;
  // The start page is our layout, not a 1280-wide website. Scaling it with
  // the pane is what made a floating window look like a tiny Google clone
  // in the middle of a lot of white. Keep it at 100% and let the page size
  // itself; real sites still get the fit-to-pane zoom below.
  let home = false;
  try {
    const url = wc.getURL?.() || "";
    home =
      isAgentBrowserHomeUrl(url) ||
      ownedBrowserAct.isPlaceholderAgentUrl(url);
  } catch (_) {}
  const factor = home ? 1 : agentTabZoomForWidth(width);
  if (!factor) return;
  try {
    if (Math.abs(wc.getZoomFactor() - factor) > 0.001) wc.setZoomFactor(factor);
    // The authoritative record of what zoom this view runs at. Input
    // coordinates must be scaled by it (ownedBrowserAct.toInputPoint) —
    // getZoomFactor answers per-origin and can disagree with the view, so the
    // setter writes down what it actually applied.
    wc.__lyknZoomFactor = factor;
  } catch (_) {
    return;
  }
  // Keyed off what we last asked for, not what the view reports: Chromium
  // scopes zoom per origin and getZoomFactor answers for the origin rather than
  // this view, so the read above rarely matches and the set runs on every
  // layout pass — which during a drag is a great many. One line per real change.
  if (agentTabZoomLogged.get(id) === factor) return;
  agentTabZoomLogged.set(id, factor);
  console.log(
    `[agent-browser] zoom ${Math.round(factor * 100)}% — ${Math.round(Number(width) || 0)}px pane of ${agentTabReferenceWidth()}px desktop`,
  );
}

/**
 * Fit every tab to the pane, not just the visible one. Zooming a tab as it is
 * raised means it re-flows in front of whoever just switched to it, and a tab
 * still loading its first document wants the right zoom before it paints, not
 * after. Re-fitting to the same width is a no-op, so this is cheap to call.
 */
function fitAgentTabsToPane(width) {
  if (!(Number(width) > 0)) return;
  for (const [id, view] of agentBrowserViews) applyAgentTabZoom(id, view, width);
}

/**
 * Where a Bot's hidden-but-working tab parks: hanging off the host window's
 * bottom-right corner at a real page size, with a 2×2 px corner of the
 * surface still ON the window.
 *
 * The overlap is the load-bearing part. A view with NO on-window
 * intersection stops being composited by macOS if it has never been shown —
 * capturePage returns empty images and even CDP Page.captureScreenshot gets
 * no frame, which left the mini viewport on "Opening the browser…" until the
 * user revealed the tab by hand. (Fully-offscreen parks at edge+40 and at
 * x=20000 were both tried and both starved; the docked pane's own edge+40
 * park survives only because that view was already on screen once.) Two
 * pixels of the page's top-left corner peeking into the window corner keep
 * the layer live for a view straight from creation, and are imperceptible.
 *
 * The measurement must come from the window the view is ATTACHED to: an
 * earlier version measured the hidden stage window while the view sat on the
 * (wider) Studio window, and the "offscreen" park landed inside it as a big
 * floating page. Callers pass the host; the park is also re-asserted on
 * every shot tick, so a window resize can misplace it for at most one
 * capture beat before it is pushed back into the corner.
 */
function botShotParkBounds(host) {
  let hostW = 0;
  let hostH = 0;
  try {
    if (host && !host.isDestroyed()) [hostW, hostH] = host.getContentSize();
  } catch (_) {}
  const width = Math.max(720, Math.min(1280, studioStageBounds?.width || hostW || 1024));
  const height = Math.max(520, Math.min(960, studioStageBounds?.height || hostH || 720));
  return { x: Math.max(hostW - 2, 0), y: Math.max(hostH - 2, 0), width, height };
}

/** The window a hidden Bot tab should live on for capture. */
function botShotHostWindow() {
  if (studioStageEmbedActive()) return d.studioWindow;
  if (agentStageWindow && !agentStageWindow.isDestroyed() && agentStageWindow.isVisible()) {
    return agentStageWindow;
  }
  if (d.studioWindow && !d.studioWindow.isDestroyed()) return d.studioWindow;
  if (agentStageWindow && !agentStageWindow.isDestroyed()) return agentStageWindow;
  return null;
}

/**
 * Make a Bot's hidden tab capturable right now: attach it to a live window
 * and park it offscreen at real size. ensureAgentBrowserWindow creates
 * headless tabs detached and zero-sized ("park before attaching"), and a view
 * in that state never paints — capturePage returns empty images forever,
 * which is why the mini viewport used to sit on "Opening the browser…" until
 * the user revealed the tab once by hand. Called when a run arms and on every
 * shot tick (cheap: attach happens only when the view is not already on the
 * host; re-parking tracks the live window size across resizes and the
 * dock/undock transfers that re-parent every view).
 */
function prepareBotShotSurface(agentId) {
  const id = String(agentId || "").trim();
  const view = agentBotShotView(id);
  if (!view) return;
  const host = botShotHostWindow();
  if (!host) return;
  let attached = false;
  try {
    attached = host.contentView?.children?.includes?.(view) === true;
  } catch (_) {}
  if (!attached) {
    // Views live on one window at a time — release the other host first, the
    // same way the dock/undock transfers do. Top-of-stack is fine: all but a
    // 2×2 px corner of the park sits outside the window's content.
    if (host !== agentStageWindow) detachViewFromWindow(agentStageWindow, view);
    if (host !== d.studioWindow) detachViewFromWindow(d.studioWindow, view);
    attachViewToWindow(host, view);
    setViewVisible(view, true);
  }
  try {
    view.setBounds(botShotParkBounds(host));
  } catch (_) {}
}

/** The armed tab's view — unless that tab is actually on screen right now,
 *  in which case the real layout owns it and we must not touch it. */
function agentBotShotView(id) {
  const view = agentBrowserViews.get(id);
  if (!view) return null;
  const onScreen =
    id === agentStageActiveId &&
    ((studioStageEmbedActive() && studioStageRevealed) ||
      (agentStageWindow && !agentStageWindow.isDestroyed() && agentStageWindow.isVisible()));
  return onScreen ? null : view;
}

/** The agent runtime reports which Bots hold a browser go-ahead; layout keeps
 *  those tabs' surfaces alive offscreen instead of parking them at zero size. */
function setBotShotAgents(ids = []) {
  const next = new Set(
    (Array.isArray(ids) ? ids : []).map((x) => String(x || "").trim()).filter(Boolean),
  );
  let changed = next.size !== agentBotShotIds.size;
  if (!changed) {
    for (const id of next) {
      if (!agentBotShotIds.has(id)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  agentBotShotIds.clear();
  for (const id of next) agentBotShotIds.add(id);
  for (const id of next) prepareBotShotSurface(id);
  // Disarmed tabs fall back to the regular 0×0 park on this pass.
  layoutAgentStageViews();
}

function layoutAgentStageViews() {
  // Docked in the Studio window — lay everything out inside the panel rect
  // the Studio renderer reported instead of filling the stage window.
  if (studioStageEmbedActive() && studioStageBounds) {
    const shift = studioStageParkShift();
    const b = shift ? { ...studioStageBounds, x: studioStageBounds.x + shift } : studioStageBounds;
    const chromeH = agentStageChromeH();
    const pageH = Math.max(0, b.height - chromeH);
    const r = viewRadiusMax(studioStageRadius);
    // Chrome is clipped with the frame curve, which also rounds its bottom.
    // Extending it below the seam (hidden behind the square page, which stacks
    // on top) keeps that bottom curve off the tab strip.
    setDockedViewBounds(
      studioStageChromeView,
      {
        x: b.x,
        y: b.y,
        width: b.width,
        // Menu overlay: cover the whole panel so the dropdown can draw over
        // the page (the chrome doc goes transparent outside the bars/menu).
        height: agentStageMenuOverlay
          ? b.height
          : Math.min(chromeH + r * 2, b.height),
      },
      { radius: studioStageRadius },
    );
    fitAgentTabsToPane(b.width);
    for (const [id, view] of agentBrowserViews) {
      try {
        // A Bot working an approved browser run keeps a real-sized surface
        // parked outside the window, so the mini viewport keeps getting
        // frames — the 0×0 park below stops the compositor cold.
        if (id !== agentStageActiveId && agentBotShotIds.has(id)) {
          view.setBounds(botShotParkBounds(d.studioWindow));
          continue;
        }
        if (!agentBrowserViewsReady.has(id)) {
          view.setBounds({ x: b.x, y: b.y + chromeH, width: 0, height: 0 });
          continue;
        }
        if (id === agentStageActiveId) {
          const pageBounds = dockedPageBoundsForOverlay({
            overlay: agentStageMenuOverlay,
            x: b.x,
            y: b.y,
            chromeH,
            width: b.width,
            pageH,
          });
          if (agentStageMenuOverlay) {
            // Park like the standalone stage: the Sync / omnibox menus overflow
            // the toolbar into this rect. Leaving a live page here swallows clicks.
            view.setBounds(pageBounds);
          } else {
            setDockedViewBounds(view, pageBounds, { radius: pageClipRadius() });
            raiseAgentStageView(d.studioWindow, view, `studio:page:${id}`);
          }
        } else {
          view.setBounds({ x: b.x, y: b.y + chromeH, width: 0, height: 0 });
        }
      } catch (_) {}
    }
    if (agentStageMenuOverlay && studioStageChromeView) {
      raiseAgentStageView(d.studioWindow, studioStageChromeView, "studio:chrome");
    }
    return;
  }
  if (!agentStageWindow || agentStageWindow.isDestroyed()) return;
  // The views land on this window when the Studio one closes, and it stays
  // hidden. Its size has nothing to do with where they will reappear, so leave
  // them exactly as the Studio left them: laying them out for a window nobody
  // is looking at reflows every page into it and then back out again, and the
  // second reflow lands after the page is on screen, as a jump.
  if (!agentStageWindow.isVisible()) return;
  const [width, height] = agentStageWindow.getContentSize();
  const chromeH = agentStageChromeH();
  const toastPad = Math.max(0, Math.min(120, agentStageToastReserve || 0));
  const pageH = Math.max(0, height - chromeH - toastPad);
  fitAgentTabsToPane(width);
  for (const [id, view] of agentBrowserViews) {
    try {
      // Armed Bot tab: real-sized offscreen park so its shot feed keeps
      // painting (see the docked branch above).
      if (id !== agentStageActiveId && agentBotShotIds.has(id)) {
        view.setBounds(botShotParkBounds(agentStageWindow));
        continue;
      }
      if (!agentBrowserViewsReady.has(id)) {
        view.setBounds({ x: 0, y: chromeH, width: 0, height: 0 });
        continue;
      }
      // Standalone window: the chrome doc IS the window content and child
      // views always paint above it — park the page while the saved-links
      // dropdown is open so the menu isn't buried behind the browser.
      if (id === agentStageActiveId && !agentStageMenuOverlay) {
        view.setBounds({ x: 0, y: chromeH, width, height: pageH });
        raiseAgentStageView(agentStageWindow, view, `stage:page:${id}`);
      } else {
        // Keep attached for background loads, but park off-stage.
        view.setBounds({ x: 0, y: chromeH, width: 0, height: 0 });
      }
    } catch (_) {}
  }
}

function pushAgentStageState() {
  const stageAlive = agentStageWindow && !agentStageWindow.isDestroyed();
  const dockAlive =
    studioStageChromeView &&
    studioStageChromeView.webContents &&
    !studioStageChromeView.webContents.isDestroyed();
  if (!stageAlive && !dockAlive) {
    notifyStudioTabChatState();
    return;
  }
  const tabs = [];
  for (const [id, view] of agentBrowserViews) {
    if (isHiddenBotTab(id)) continue;
    const meta = agentBrowserMeta.get(id) || {};
    let url = meta.url || "";
    let pageTitle = meta.pageTitle || "";
    try {
      if (view?.webContents && !view.webContents.isDestroyed()) {
        url = view.webContents.getURL() || url;
        pageTitle = view.webContents.getTitle() || pageTitle;
      }
    } catch (_) {}
    const placeholder = ownedBrowserAct.isPlaceholderAgentUrl(url);
    const kind =
      meta.kind === "artifact" || isAgentArtifactTabId(id)
        ? "artifact"
        : placeholder || meta.kind === "welcome"
          ? "welcome"
          : "browse";
    if (placeholder) {
      url = "";
      // Keep the new-tab label — don't blank the title just because the
      // underlying welcome page URL is a placeholder.
      pageTitle =
        meta.pageTitle ||
        (meta.incognito || isAgentIncognito(id) ? "Incognito" : "New tab");
    }
    if (kind === "artifact") {
      if (!url || /^data:/i.test(url) || /^lykn-artifact:/i.test(url)) {
        url = meta.url && /^lykn:\/\//i.test(meta.url) ? meta.url : "lykn://artifact";
      }
      if (!pageTitle) pageTitle = agentBrowserLabels.get(id) || "Artifact";
    }
    // Brand icons beat page favicons — Electron often reports the generic
    // Google "G" for Gmail/Docs/Drive/etc. Empty welcome tabs use the LYKN
    // mark in stage chrome (no remote favicon).
    const favicon = placeholder
      ? ""
      : agentBrandIconFor(url) ||
        (typeof meta.favicon === "string" && meta.favicon) ||
        agentFaviconFallback(url) ||
        "";
    const sourceChatId = String(meta.sourceChatId || "").trim();
    tabs.push({
      id,
      title: agentBrowserLabels.get(id) || (kind === "artifact" ? "Artifact" : "Agent"),
      url,
      pageTitle,
      favicon,
      kind,
      artifactKind: meta.artifactKind || "",
      ownerAgentId: meta.ownerAgentId || "",
      sourceChatId: sourceChatId || undefined,
    });
  }
  // Group deliverable subtabs directly under their owner tab, in creation
  // order (agentBrowserViews is insertion-ordered). Orphan artifacts (owner
  // tab gone) trail at the end.
  {
    const browse = tabs.filter((t) => t.kind !== "artifact");
    const arts = tabs.filter((t) => t.kind === "artifact");
    const ordered = [];
    for (const t of browse) {
      ordered.push(t);
      for (const a of arts) {
        if (a.ownerAgentId === t.id) ordered.push({ ...a, isSub: true });
      }
    }
    for (const a of arts) {
      if (!browse.some((t) => t.id === a.ownerAgentId)) ordered.push(a);
    }
    tabs.length = 0;
    tabs.push(...ordered);
  }
  const active = agentBrowserViews.get(agentStageActiveId);
  const activeMeta = agentBrowserMeta.get(agentStageActiveId) || {};
  let url = "";
  let title = "";
  try {
    if (active?.webContents && !active.webContents.isDestroyed()) {
      url = active.webContents.getURL() || "";
      title = active.webContents.getTitle() || "";
      if (ownedBrowserAct.isPlaceholderAgentUrl(url)) url = "";
      // New-tab home still loads in the page view, but the omnibox stays
      // empty so the user can type immediately.
      else if (isAgentBrowserHomeUrl(url)) url = "";
    }
  } catch (_) {}
  if (
    (activeMeta.kind === "artifact" || isAgentArtifactTabId(agentStageActiveId)) &&
    (!url || /^data:/i.test(url) || /^lykn-artifact:/i.test(url))
  ) {
    url = activeMeta.url && /^lykn:\/\//i.test(activeMeta.url) ? activeMeta.url : "lykn://artifact";
    title = title || activeMeta.pageTitle || agentBrowserLabels.get(agentStageActiveId) || "Artifact";
  }
  let recents = [];
  try {
    recents = agentRecentVisits.readRecents(app.getPath("userData")).items || [];
  } catch (_) {
    recents = [];
  }
  const payload = {
    tabs,
    activeAgentId: agentStageActiveId,
    url,
    title,
    incognito: agentStageActiveId
      ? isAgentIncognito(agentStageActiveId)
      : !!agentStageIncognitoDefault,
    recents,
    chatOpen: !!agentChatOpen,
    sourceChatId: String(activeMeta.sourceChatId || "").trim() || undefined,
  };
  if (stageAlive) {
    try {
      agentStageWindow.webContents.send("lykn:agent-stage-state", payload);
    } catch (_) {}
    try {
      agentStageWindow.setTitle(
        title
          ? `LYKN · ${agentBrowserLabels.get(agentStageActiveId) || "Agent"} · ${String(title).slice(0, 48)}`
          : "LYKN Agent Browser",
      );
    } catch (_) {}
  }
  if (dockAlive) {
    try {
      // Docked, the chrome is the floating window's title bar: it draws the
      // traffic lights and takes the drag, which it skips when it's the
      // standalone stage window with a real title bar of its own.
      studioStageChromeView.webContents.send("lykn:agent-stage-state", {
        ...payload,
        docked: true,
      });
    } catch (_) {}
  }
  // Whatever just changed about the browser, the picture the Studio animates
  // its window over is now a little out of date.
  scheduleStudioStageShot();
  notifyStudioTabChatState();
}

function wireAgentBrowserViewEvents(agentId, view) {
  const wc = view.webContents;
  const isArtifact = isAgentArtifactTabId(agentId);
  const bump = () => {
    try {
      const url = wc.getURL();
      const pageTitle = wc.getTitle();
      const prev = agentBrowserMeta.get(agentId) || {};
      // Keep short lykn:// chrome URLs for artifact tabs (data: URLs are huge).
      let shownUrl = url;
      if (isArtifact || prev.kind === "artifact") {
        if (
          prev.url &&
          /^lykn:\/\//i.test(prev.url) &&
          (/^data:/i.test(url) || /^lykn-artifact:/i.test(url) || !url)
        ) {
          shownUrl = prev.url;
        } else if (/^data:/i.test(url) || /^lykn-artifact:/i.test(url)) {
          shownUrl =
            prev.artifactKind === "report"
              ? "lykn://report"
              : prev.artifactKind === "video"
                ? "lykn://video"
                : prev.artifactKind === "image" ||
                    prev.artifactKind === "chart" ||
                    prev.artifactKind === "diagram"
                  ? "lykn://image"
                  : "lykn://artifact";
        }
      }
      const clean = ownedBrowserAct.isPlaceholderAgentUrl(url) ? "" : url;
      const nextKind = isArtifact
        ? "artifact"
        : /^https?:\/\//i.test(clean)
          ? "browse"
          : prev.kind === "artifact"
            ? "artifact"
            : "browse";
      // Drop a stale favicon when the host changes; page-favicon-updated refills.
      let nextFavicon = prev.favicon || "";
      try {
        const prevHost = prev.url ? new URL(prev.url).hostname : "";
        const nextHost = clean ? new URL(clean).hostname : "";
        if (prevHost && nextHost && prevHost !== nextHost) nextFavicon = "";
        if (!clean || !/^https?:\/\//i.test(clean)) nextFavicon = "";
      } catch (_) {
        nextFavicon = "";
      }
      agentBrowserMeta.set(agentId, {
        ...prev,
        url: shownUrl,
        // Remember last real https page so we can recover after a blanked login.
        ...(/^https?:\/\//i.test(clean) ? { lastHttpsUrl: clean } : {}),
        pageTitle: pageTitle || prev.pageTitle || "",
        favicon: nextFavicon,
        kind: nextKind,
        ...(nextKind === "browse" ? { artifactKind: "" } : {}),
      });
      if (!isArtifact && /^https?:\/\//i.test(clean) && !isAgentIncognito(agentId)) {
        try {
          agentRecentVisits.recordRecentVisit(app.getPath("userData"), {
            url: clean,
            title: pageTitle || "",
            favicon: nextFavicon || "",
          });
        } catch (_) {}
      }
      if (!isArtifact) {
        try {
          agentRuntime?.setAgentUrl?.(agentId, clean);
        } catch (_) {}
        emitAgentToUi("lykn:agent-browser", {
          agentId,
          url: clean,
          title: pageTitle || "",
          favicon: nextFavicon || agentFaviconFallback(clean) || "",
        });
      }
      pushAgentStageState();
      if (agentId === agentStageActiveId) layoutAgentStageViews();
    } catch (_) {}
  };
  wc.on("page-favicon-updated", (_event, favicons) => {
    try {
      const list = Array.isArray(favicons) ? favicons : [];
      const pick =
        list.find((f) => typeof f === "string" && /^https?:\/\//i.test(f)) ||
        list.find((f) => typeof f === "string" && f.startsWith("data:")) ||
        "";
      if (!pick) return;
      const prev = agentBrowserMeta.get(agentId) || {};
      if (prev.favicon === pick) return;
      agentBrowserMeta.set(agentId, { ...prev, favicon: pick });
      if (!isArtifact && prev.url && !isAgentIncognito(agentId)) {
        try {
          agentRecentVisits.updateRecentFavicon(app.getPath("userData"), {
            url: prev.url,
            favicon: pick,
          });
        } catch (_) {}
      }
      if (!isArtifact) {
        emitAgentToUi("lykn:agent-browser", {
          agentId,
          url: prev.url || "",
          title: prev.pageTitle || "",
          favicon: pick,
        });
      }
      pushAgentStageState();
    } catch (_) {}
  });
  wc.on("page-title-updated", bump);
  wc.on("did-navigate", bump);
  wc.on("did-navigate-in-page", bump);
  if (!isArtifact) {
    // Ahead of whatever this view was made to load: a tab opened straight onto
    // a URL (omnibox, a link handed over from the app) never passes through the
    // home-page loader that would otherwise set this up.
    applyAgentTabEmulation(wc);
    // A sign-in that fails in here fails quietly — the page catches its own
    // error and the button simply doesn't respond, which from outside is
    // indistinguishable from a click that never landed. Repeat what the page
    // says about its auth libraries and stay out of the way of everything else
    // a busy site logs.
    wc.on("console-message", (...args) => {
      const detail = args.find((a) => a && typeof a === "object" && typeof a.message === "string");
      const text = detail
        ? detail.message
        : String(args.find((a) => typeof a === "string") || "");
      if (!/gsi|fedcm|oauth|one ?tap|popup|accounts\.google|credential/i.test(text)) return;
      console.log(`[agent-browser] page said: ${text.slice(0, 300)}`);
    });
    // Re-assert the two per-view settings a new document resets: our CDP
    // emulation is dropped whenever something else (DevTools, a crashed
    // renderer) takes over the target, and Electron scopes zoom per origin, so
    // a new site starts back at 100% regardless of how wide the pane is.
    // Artifact tabs are excluded — exported reports have their own dark theme
    // and already fit the pane.
    wc.on("did-navigate", () => {
      applyAgentTabEmulation(wc);
      try {
        applyAgentTabZoom(agentId, view, view.getBounds?.().width);
      } catch (_) {}
    });
  }
  wc.on("did-finish-load", () => {
    bump();
    // The document is ready to paint now. Only at this point attach the
    // native page view and let the regular stage layout reveal it.
    agentBrowserViewsReady.add(agentId);
    layoutAgentStageViews();
    // New-tab home just painted. Leave the caret in the page search box
    // (Google-style). Only reclaim the omnibox after leaving the start page.
    if (agentStagePendingOmniboxFocusId === agentId) {
      agentStagePendingOmniboxFocusId = null;
      let pageUrl = "";
      try {
        pageUrl = wc.getURL() || "";
      } catch (_) {}
      if (!isAgentBrowserHomeUrl(pageUrl)) {
        setTimeout(() => focusAgentStageOmnibox(), 0);
      }
    }
  });
  // Canva / Google / Apple login use window.open (often about:blank first).
  // NEVER load those into this tab — that blanks the site after sign-in.
  // Real popups keep window.opener + share the agent session partition.
  wc.setWindowOpenHandler((details) => {
    const u = String(details?.url || "");
    const disposition = String(details?.disposition || "");
    if (u && !agentStageUrlAllowed(u)) {
      // The one branch with no visible outcome: the page asked for a window,
      // got null back and carries on as if the click never happened. Say so,
      // or the next sign-in that quietly does nothing has nothing to go on.
      console.log("[agent-browser] refused window.open for", u.slice(0, 200));
      return { action: "deny" };
    }

    const isBlank = !u || /^about:blank$/i.test(u);
    const wantsPopup =
      isBlank ||
      disposition === "new-window" ||
      looksLikeAgentAuthPopupUrl(u);

    if (wantsPopup) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 560,
          height: 740,
          minWidth: 360,
          minHeight: 480,
          autoHideMenuBar: true,
          title: "Sign in",
          // Visible Studio / stage — never the hidden undocked stage window.
          parent: agentAuthPopupParentWindow(),
          webPreferences: {
            partition: agentBrowserPartition(agentId),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }

    // Plain target=_blank https link → stay in this agent tab.
    if (/^https?:\/\//i.test(u)) {
      try {
        wc.loadURL(u);
      } catch (_) {}
    }
    return { action: "deny" };
  });
  wc.on("did-create-window", (childWindow) => {
    wireAgentPopupWindow(childWindow, { parentWc: wc, agentId });
  });
  wc.on("will-navigate", (event, url) => {
    if (!agentStageUrlAllowed(url)) {
      event.preventDefault();
    }
  });
  // "Leave site? Changes you made may not be saved." is a native modal, and a
  // native modal blocks the renderer — so the agent cannot read the page, let
  // alone click the dialog it is trapped behind. Leaving is what was asked for
  // in every case that reaches here: the agent only navigates away on purpose,
  // and the user driving the tab clicked something to get here.
  wc.on("will-prevent-unload", (event) => {
    event.preventDefault();
  });
  // OAuth-style pages end with window.close(). For a tab's WebContentsView
  // Electron destroys the contents outright, and with no BrowserWindow around
  // it there is no 'close' event — the strip would keep a dead tab painting a
  // blank surface. If the host did not initiate the teardown (the tab is
  // still registered when the destruction lands), close the tab for real:
  // the same flow as the tab-strip x, except a web page must never retire an
  // agent, so only the browser surface goes.
  wc.on("destroyed", () => {
    setImmediate(() => {
      try {
        if (agentBrowserViews.get(agentId) !== view) return;
        const historySnap = snapshotAgentBrowserHistory(agentId);
        destroyAgentBrowserWindow(agentId);
        if (!isAgentArtifactTabId(agentId) && !agentTabIds.isSubTabId(agentId)) {
          try {
            agentRuntime?.clearBrowserSurface?.(agentId);
          } catch (_) {}
        }
        commitAgentBrowserHistory(historySnap);
        pushAgentStageState();
      } catch (_) {}
    });
  });
  try {
    if (app.userAgentFallback) wc.setUserAgent(app.userAgentFallback);
  } catch (_) {}
  wireAgentSessionPermissions(wc.session);
  wireAgentSessionClientHints(wc.session);
  wireAgentSessionDownloads(wc.session);
}

// Agent tabs share a partition. One session handler so a later OAuth popup
// cannot strip microphone access from the start page. Media is allowed only
// while that tab is actually on the bundled home document.
const permissionWiredSessions = new WeakSet();
function agentBrowserAllowsPermission(webContents, permission) {
  if (
    permission === "fullscreen" ||
    permission === "clipboard-sanitized-write" ||
    permission === "clipboard-read"
  ) {
    return true;
  }
  if (permission === "media") {
    try {
      // Mic/camera only on the EXACT bundled home/welcome document (dictation),
      // never a page that merely looks like it.
      return isTrustedAgentBrowserHomeUrl(webContents?.getURL?.());
    } catch {
      return false;
    }
  }
  return false;
}
function wireAgentSessionPermissions(sess) {
  if (!sess || permissionWiredSessions.has(sess)) return;
  permissionWiredSessions.add(sess);
  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(agentBrowserAllowsPermission(webContents, permission));
  });
  sess.setPermissionCheckHandler((webContents, permission) =>
    agentBrowserAllowsPermission(webContents, permission),
  );
}

// Overriding app.userAgentFallback is only half the disguise: Chromium keeps
// advertising "Electron" in the Sec-CH-UA client-hint headers, and that is what
// providers like Google read when they refuse OAuth from embedded app browsers.
// The visible symptom is a "Continue with Google" button that does nothing, or
// the "This browser or app may not be secure" wall. Rewrite the brand hints on
// the agent browser's session so it presents as plain desktop Chrome.
const clientHintsWiredSessions = new WeakSet();
function wireAgentSessionClientHints(sess) {
  if (!sess || clientHintsWiredSessions.has(sess)) return;
  const full = String(process.versions.chrome || "").trim();
  const major = full.split(".")[0] || "";
  if (!major) return;
  clientHintsWiredSessions.add(sess);
  const brands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`;
  const fullVersionList =
    `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not?A_Brand";v="99.0.0.0"`;
  try {
    // Electron allows a single onBeforeSendHeaders listener per session; the
    // agent partition has no other, so this owns it.
    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (!lower.startsWith("sec-ch-ua")) continue;
        if (lower === "sec-ch-ua") headers[key] = brands;
        else if (lower === "sec-ch-ua-full-version-list") headers[key] = fullVersionList;
        else if (lower === "sec-ch-ua-full-version") headers[key] = `"${full}"`;
        else if (/electron|lykn/i.test(String(headers[key] || ""))) delete headers[key];
      }
      callback({ requestHeaders: headers });
    });
  } catch (_) {
    /* header rewriting is best-effort — sign-in still works via email/password */
  }
}

// Real downloads in the LYKN browser: save straight into the user's Downloads
// folder with a unique name and reveal the file when it finishes. Sessions are
// per-partition and this wiring runs once per session.
const downloadWiredSessions = new WeakSet();
function wireAgentSessionDownloads(sess) {
  if (!sess || downloadWiredSessions.has(sess)) return;
  downloadWiredSessions.add(sess);
  sess.on("will-download", (_event, item) => {
    try {
      const fsSync = require("node:fs");
      const downloadsDir = app.getPath("downloads");
      const base =
        String(item.getFilename() || "download").replace(/[\\/:*?"<>|]+/g, "_") || "download";
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length) || "download";
      let target = path.join(downloadsDir, base);
      for (let i = 2; fsSync.existsSync(target); i += 1) {
        target = path.join(downloadsDir, `${stem} (${i})${ext}`);
      }
      item.setSavePath(target);
      item.once("done", (_e, state) => {
        if (state === "completed") {
          try {
            shell.showItemInFolder(target);
          } catch (_) {}
        }
      });
    } catch (_) {
      /* download proceeds with Electron defaults */
    }
  });
}

/**
 * A free path in ~/Downloads for this name, Finder style: "report.pdf",
 * then "report (2).pdf". Shared by every route that writes a download, so a
 * second copy never silently overwrites the first.
 */
function uniqueDownloadPath(filename) {
  const fsSync = require("node:fs");
  const dir = app.getPath("downloads");
  const safe =
    String(filename || "download")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 120) || "download";
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || "download";
  let target = path.join(dir, safe);
  for (let i = 2; fsSync.existsSync(target); i += 1) {
    target = path.join(dir, `${stem} (${i})${ext}`);
  }
  return target;
}

/** Save the given HTML to ~/Downloads under a page-title filename. */
function saveHtmlToDownloads(html, title) {
  const fsSync = require("node:fs");
  const stem =
    String(title || "artifact")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "artifact";
  const target = uniqueDownloadPath(`${stem}.html`);
  fsSync.writeFileSync(target, String(html), "utf8");
  return target;
}

/**
 * Raise whichever window should host the agent browser. The browser always
 * lives in the Studio when a Studio window exists: docked embed when active,
 * otherwise the Studio renderer is told to open its Browser tab (the views
 * re-parent into the Studio once it reports bounds). The standalone stage
 * window is only a fallback for when there is no Studio window at all.
 */
function raiseAgentBrowserHost({ focus = true, agentId } = {}) {
  const overlayAlive =
    d.overlayWindow && !d.overlayWindow.isDestroyed() && d.overlayWindow.isVisible();
  const overlayTyping = !!(overlayAlive && d.overlayWindow.isFocused());
  const raiseWin = (win) => {
    try {
      if (win.isMinimized?.()) win.restore();
      if (!win.isVisible()) win.show();
      win.moveTop();
      if (focus && !overlayTyping) win.focus();
      else if (overlayAlive) focusOverlayForTyping();
    } catch (_) {}
  };
  if (studioStageEmbedActive()) {
    raiseWin(d.studioWindow);
    layoutAgentStageViews();
    return "studio";
  }
  if (d.studioWindow && !d.studioWindow.isDestroyed()) {
    // Studio is open but its Browser dock isn't — open the dock there instead
    // of popping the standalone stage window. Layout happens when the Studio
    // renderer reports the dock bounds and the embed activates.
    raiseWin(d.studioWindow);
    notifyStudioShowBrowser({ agentId });
    return "studio-pending";
  }
  const stage = ensureAgentStageWindow();
  raiseWin(stage);
  layoutAgentStageViews();
  return "stage";
}

function applyTabSourceChatId(tabId, chatId) {
  const result = tabChatLineage.applySourceChatId(agentBrowserMeta, tabId, chatId);
  if (result.changed) notifyStudioTabChatState();
  return result.ok;
}

function ensureAgentBrowserWindow(agentId, { show = false, focus = true, label, sourceChatId } = {}) {
  const id = String(agentId || "").trim();
  if (!id) return null;
  if (label) agentBrowserLabels.set(id, String(label).trim().slice(0, 40) || "Agent");

  const stage = ensureAgentStageWindow();
  let view = agentBrowserViews.get(id);
  if (!view) {
    if (!agentIncognito.has(id) && agentStageIncognitoDefault) {
      agentIncognito.set(id, true);
    }
    const incognito = isAgentIncognito(id);
    const partition = agentBrowserPartition(id);
    // Warm the shared persist session so cookies/localStorage survive restarts.
    try {
      const { session } = require("electron");
      session.fromPartition(partition, { cache: true });
    } catch (_) {}
    // Huge report/artifact loads may use lykn-artifact:// on this partition.
    try {
      ensureAgentArtifactProtocolForPartition(partition);
    } catch (_) {}
    view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(ELECTRON_DIR, "agent-browser-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Agent tabs keep loading at full speed while hidden/inactive —
        // throttled timers/rAF leave lazy-loading pages stuck on spinners.
        backgroundThrottling: false,
      },
    });
    try {
      // Match the home page from the very first compositor frame, so the
      // pre-paint fill never reads as a stray strip below the favorites row.
      // Incognito included: page content is pinned light either way.
      view.setBackgroundColor("#ffffff");
    } catch (_) {}
    // A fresh WebContentsView defaults to the window's top-left bounds.
    // Park it before attaching so its initial blank paint cannot flash over
    // the browser chrome while the normal stage layout takes over.
    try {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } catch (_) {}
    try {
      stage.setContentProtection(isContentProtectionEnabled());
    } catch (_) {}
    agentBrowserViews.set(id, view);
    const chat = String(sourceChatId || "").trim();
    agentBrowserMeta.set(id, {
      url: AGENT_BROWSER_HOME_URL,
      pageTitle: "New tab",
      kind: "browse",
      incognito,
      ...(chat ? { sourceChatId: chat } : {}),
    });
    wireAgentBrowserViewEvents(id, view);
    loadAgentBrowserHome(view.webContents);
  } else {
    applyTabSourceChatId(id, sourceChatId);
    // Re-show the home page only for truly empty tabs — never clobber a report/artifact
    // (those often load as data: URLs, which used to look like placeholders),
    // and never interrupt an in-flight navigation (Studio docking used to call
    // ensure again mid-load and wipe the artifact URL back to welcome).
    try {
      const meta = agentBrowserMeta.get(id) || {};
      const isDeliverable =
        meta.kind === "artifact" ||
        meta.kind === "browsing" ||
        meta.artifactKind === "report" ||
        meta.artifactKind === "image" ||
        meta.artifactKind === "video" ||
        meta.artifactKind === "chart" ||
        meta.artifactKind === "diagram";
      const wc = view.webContents;
      const loading = !!(wc && !wc.isDestroyed() && wc.isLoading?.());
      if (!isDeliverable && !loading) {
        const cur = wc && !wc.isDestroyed() ? wc.getURL() || "" : "";
        const needsHome =
          !cur ||
          /^about:blank$/i.test(cur) ||
          /^lykn:\/\/new-tab(?:[/?#]|$)/i.test(cur) ||
          isLegacyGoogleHomeUrl(cur);
        if (needsHome) loadAgentBrowserHome(wc);
      }
    } catch (_) {}
  }

  // A click on the Bot peek (show:true) reveals that live tab. Hidden Bot
  // shot surfaces must never become the visible tab on their own.
  if (show && isHeadlessBotTab(id)) revealBotBrowserTab(id);
  if (
    !isHiddenBotTab(id) &&
    (focus !== false ||
      !agentStageActiveId ||
      isHiddenBotTab(agentStageActiveId) ||
      !agentBrowserViews.has(agentStageActiveId))
  ) {
    agentStageActiveId = id;
  }

  if (show) {
    // Always through the Studio when it exists — never a separate window.
    raiseAgentBrowserHost({ focus: focus !== false, agentId: id });
    pushAgentStageState();
    notifyAgentBrowserVisibility(true);
  }
  return { webContents: view.webContents, view, stage };
}

function destroyAgentBrowserWindow(agentId) {
  const id = String(agentId || "").trim();
  // Closing an agent tab takes every tab it owns with it — deliverable
  // subtabs and browse sub-tabs alike. Ownership is the meta's ownerAgentId,
  // whatever kind of tab it is.
  if (id && !isAgentArtifactTabId(id) && !agentTabIds.isSubTabId(id)) {
    for (const [tabId, meta] of [...agentBrowserMeta.entries()]) {
      if (tabId !== id && meta?.ownerAgentId === id) {
        destroyAgentBrowserWindow(tabId);
      }
    }
  }
  const view = agentBrowserViews.get(id);
  agentBrowserLabels.delete(id);
  agentBrowserMeta.delete(id);
  noteClosedTabChat(id);
  agentIncognito.delete(id);
  revealedBotTabs.delete(id);
  {
    const owner = botTabVisibility.botTabOwner(id, botVisibilityOpts().partitionOwner);
    if (owner) revealedBotTabs.delete(owner);
  }
  if (!view) {
    notifyStudioTabChatState();
    return;
  }
  agentBrowserViews.delete(id);
  agentBrowserViewsReady.delete(id);
  agentBotShotIds.delete(id);
  agentTabZoomLogged.delete(id);
  detachViewFromWindow(agentStageWindow, view);
  detachViewFromWindow(d.studioWindow, view);
  try {
    view.webContents?.close?.();
  } catch (_) {}
  if (agentStageActiveId === id) {
    agentStageActiveId = userBrowserTabIds().find((tabId) => tabId !== id) || null;
  }
  if (
    !hasUserBrowserTab() &&
    !studioStageEmbedActive() &&
    agentStageWindow &&
    !agentStageWindow.isDestroyed()
  ) {
    agentStageWindow.hide();
  } else {
    // Closing the last docked tab leaves the studio browser open — keep a
    // fresh new-tab in place like a real browser window would. Closing the
    // window itself (not a tab, not minimize) skips that so reopen is empty.
    // Headless Bot shot surfaces do not count as user tabs.
    if (
      !studioBrowserDisposing &&
      !hasUserBrowserTab() &&
      studioStageEmbedActive()
    ) {
      openFreshStudioBrowserTab({ focusOmnibox: true });
    }
    layoutAgentStageViews();
    pushAgentStageState();
  }
}

/** Show/focus an agent's tab inside the shared stage window. */
function showAgentBrowserWindow(agentId, opts = {}) {
  const focus = opts.focus !== false;
  const label = opts.label || opts.title;
  return ensureAgentBrowserWindow(agentId, { show: true, focus, label });
}

/**
 * Wait until a WebContents finishes a real main-frame navigation.
 * Ignores about:blank (new WebContents always paints that first).
 */
function waitForWebContentsLoad(wc, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!wc || wc.isDestroyed?.()) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        wc.removeListener("did-finish-load", onOk);
        wc.removeListener("did-fail-load", onFail);
      } catch (_) {}
      clearTimeout(timer);
      resolve(ok);
    };
    const isBlankUrl = (u) => !u || /^about:blank$/i.test(u);
    const onOk = () => {
      let u = "";
      try {
        u = wc.getURL() || "";
      } catch (_) {}
      // New WebContents always finish about:blank first — keep waiting for
      // the real welcome/page navigation we kicked off.
      if (isBlankUrl(u)) return;
      finish(true);
    };
    const onFail = (_e, errorCode, _desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      // -3 ERR_ABORTED is normal when replacing about:blank with the real URL.
      if (errorCode === -3) return;
      finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      wc.on("did-finish-load", onOk);
      wc.on("did-fail-load", onFail);
      // If the intended page already finished before we subscribed, settle now.
      try {
        if (!wc.isLoading?.() && !isBlankUrl(wc.getURL() || "")) finish(true);
      } catch (_) {}
    } catch (_) {
      finish(false);
    }
  });
}

/**
 * Toggle tab incognito: dark chrome + ephemeral session partition.
 * Recreates the BrowserView so private cookies don't mix with the shared
 * signed-in agent browser profile (and vice versa).
 *
 * Keeps the current page on-screen until the replacement session has loaded,
 * then covers it with the new view before tearing the old one down — so the
 * Studio underlay / about:blank never flashes in between.
 */
async function toggleAgentIncognito(agentId) {
  const id = String(agentId || agentStageActiveId || "").trim();
  if (!id || !agentBrowserViews.has(id)) {
    agentStageIncognitoDefault = !agentStageIncognitoDefault;
    pushAgentStageState();
    return { ok: true, incognito: agentStageIncognitoDefault, stageOnly: true };
  }
  const next = !isAgentIncognito(id);
  agentStageIncognitoDefault = next;
  const label = agentBrowserLabels.get(id);
  const prevMeta = agentBrowserMeta.get(id) || {};
  const oldView = agentBrowserViews.get(id);
  let resumeUrl = "";
  try {
    const wc = oldView?.webContents;
    resumeUrl = wc && !wc.isDestroyed() ? wc.getURL() || "" : "";
  } catch (_) {}
  if (
    !resumeUrl ||
    ownedBrowserAct.isPlaceholderAgentUrl(resumeUrl) ||
    ownedBrowserAct.isAgentBrowserHomeDocument(resumeUrl) ||
    isLegacyGoogleHomeUrl(resumeUrl)
  ) {
    resumeUrl = "";
  } else if (/^lykn:\/\//i.test(resumeUrl) || prevMeta.kind === "artifact") {
    // Keep artifact/report tabs on their meta URL (data:/lykn-artifact handled below).
    resumeUrl = prevMeta.url && /^https?:\/\//i.test(prevMeta.url) ? prevMeta.url : "";
  }

  // Flip preference first so the new view gets the correct partition.
  agentIncognito.set(id, next);
  if (label) agentBrowserLabels.set(id, label);
  agentStageActiveId = id;

  const partition = agentBrowserPartition(id);
  try {
    const { session } = require("electron");
    session.fromPartition(partition, { cache: true });
  } catch (_) {}
  try {
    ensureAgentArtifactProtocolForPartition(partition);
  } catch (_) {}

  const newView = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    newView.setBackgroundColor("#ffffff");
  } catch (_) {}
  if (studioStageEmbedActive()) {
    try {
      setViewRadius(newView, pageClipRadius());
    } catch (_) {}
    attachViewToWindow(d.studioWindow, newView);
  } else {
    const stage = ensureAgentStageWindow();
    attachViewToWindow(stage, newView);
  }
  // Park off-stage while loading — old view stays visible in the page slot.
  try {
    newView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } catch (_) {}

  const wc = newView.webContents;
  // Start the intended navigation BEFORE waiting, so about:blank can't win.
  if (wc && resumeUrl && /^https?:\/\//i.test(resumeUrl)) {
    applyAgentTabEmulation(wc);
    try {
      void wc.loadURL(resumeUrl);
    } catch (_) {
      loadAgentBrowserHome(wc);
    }
  } else {
    loadAgentBrowserHome(wc);
  }
  await waitForWebContentsLoad(wc, 4000);

  // Cover first (new view raised into the page slot), then remove the old one
  // so the Studio underlay never peeks through a one-frame gap.
  agentBrowserViews.set(id, newView);
  agentBrowserMeta.set(id, {
    ...prevMeta,
    url: resumeUrl || AGENT_BROWSER_HOME_URL,
    pageTitle: prevMeta.pageTitle || (resumeUrl ? "" : "New tab"),
    kind: prevMeta.kind === "artifact" && resumeUrl ? "artifact" : "browse",
    incognito: next,
  });
  wireAgentBrowserViewEvents(id, newView);
  layoutAgentStageViews();
  pushAgentStageState();

  detachViewFromWindow(agentStageWindow, oldView);
  detachViewFromWindow(d.studioWindow, oldView);
  try {
    oldView?.webContents?.close?.();
  } catch (_) {}

  return { ok: true, agentId: id, incognito: next };
}

function escapeHtmlForStage(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapMediaAsStageHtml({ url, title, kind }) {
  const safeUrl = escapeHtmlForStage(url);
  const safeTitle = escapeHtmlForStage(title || "Preview");
  if (kind === "video") {
    return (
      `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
      `<style>html,body{margin:0;height:100%;background:#0b0d12;display:grid;place-items:center}` +
      `video{max-width:100%;max-height:100%;}</style></head><body>` +
      `<video controls autoplay src="${safeUrl}"></video></body></html>`
    );
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
    `<style>html,body{margin:0;min-height:100%;background:#0b0d12;display:grid;place-items:center}` +
    `img{max-width:100%;max-height:100vh;object-fit:contain}</style></head><body>` +
    `<img src="${safeUrl}" alt="${safeTitle}" /></body></html>`
  );
}

/** BrowserView partitions don't see defaultSession's lykn-artifact handler — use data: URLs. */
function htmlToStageDataUrl(html) {
  const body = String(html || "");
  if (!body.trim()) return "";
  return `data:text/html;charset=utf-8;base64,${Buffer.from(body, "utf8").toString("base64")}`;
}

function resolveLyknArtifactHtml(url) {
  const u = String(url || "").trim();
  if (!/^lykn-artifact:\/\//i.test(u)) return "";
  try {
    const key = new URL(u).hostname.replace(/\/$/, "");
    return artifactHtmlCache.get(key) || "";
  } catch {
    return "";
  }
}

function ensureAgentArtifactProtocolForPartition(partition) {
  const part = String(partition || "persist:lykn-agent-artifact").trim();
  try {
    const ses = session.fromPartition(part, { cache: true });
    if (ses.__lyknArtifactProtocolBound) return;
    ses.__lyknArtifactProtocolBound = true;
    ses.protocol.handle("lykn-artifact", (request) => {
      try {
        const key = new URL(request.url).hostname.replace(/\/$/, "");
        const html = artifactHtmlCache.get(key);
        if (!html) {
          return new Response("Artifact preview expired. Run the agent again.", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      } catch {
        return new Response("Bad artifact URL", { status: 400 });
      }
    });
  } catch (e) {
    console.warn("[agent-stage] artifact protocol:", e?.message || e);
  }
}

function ensureAgentArtifactSessionProtocol() {
  ensureAgentArtifactProtocolForPartition("persist:lykn-agent-artifact");
  // Agent BrowserViews use the shared browse partition — bind there too so
  // huge reports that fall back to lykn-artifact:// actually resolve.
  ensureAgentArtifactProtocolForPartition(AGENT_BROWSER_SHARED_PARTITION);
}

/** Group deliverable kinds into one subtab slot each (charts reuse the image slot). */
function stageDeliverableSlot(kind) {
  if (kind === "report") return "report";
  if (kind === "image" || kind === "chart" || kind === "diagram") return "image";
  if (kind === "video") return "video";
  return "artifact";
}

/**
 * Load a deliverable (artifact / image / report / video) into a SUBTAB under
 * the owning agent's tab. The agent's main tab keeps the live page the user
 * was on, so the agent retains full access to it. One subtab per deliverable
 * kind per agent — a re-run replaces that subtab's content.
 */
function openAgentStageArtifact({
  url,
  html,
  markdown,
  title,
  ownerAgentId,
  kind = "artifact",
  reuseAgentTab = true,
  show = false,
  focus = false,
  // The user asked for this deliverable right now (clicked a step, ran an
  // explicit "open in browser" action) — front it regardless of which tab is
  // visible. Without it, a deliverable arriving from a finished background
  // task only fronts when the user is already looking at that agent's family;
  // otherwise the subtab is created quietly and waits in the strip.
  force = false,
} = {}) {
  void reuseAgentTab; // deliverables always live in their own subtab now
  let loadUrl = String(url || "").trim();
  let pageHtml = typeof html === "string" ? html : "";
  const label = String(title || (kind === "report" ? "Report" : "Artifact"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48) || "Artifact";

  const owner = String(ownerAgentId || "").trim();
  const id = owner
    ? `art-${stageDeliverableSlot(kind)}-${owner}`
    : `art-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  // Subtabs inherit the owner tab's incognito state.
  if (owner && isAgentIncognito(owner) && !agentIncognito.has(id)) {
    agentIncognito.set(id, true);
  }
  const reportTheme = isAgentIncognito(owner || id) ? "incognito" : "light";

  if (!pageHtml && typeof markdown === "string" && markdown.trim()) {
    const mdTitle =
      label || titleFromStageMarkdown(markdown, kind === "report" ? "Report" : "Document");
    pageHtml = wrapReportAsStageHtml(markdown, mdTitle, { theme: reportTheme });
  }

  if (
    loadUrl &&
    /^https?:\/\//i.test(loadUrl) &&
    (kind === "image" || kind === "video" || kind === "chart" || kind === "diagram")
  ) {
    pageHtml = wrapMediaAsStageHtml({
      url: loadUrl,
      title: label,
      kind: kind === "video" ? "video" : "image",
    });
    loadUrl = "";
  }

  // Prefer inlined HTML (data:) so artifact tabs aren't blank — custom
  // partitions don't use defaultSession's lykn-artifact:// handler.
  if (!pageHtml && /^lykn-artifact:\/\//i.test(loadUrl)) {
    pageHtml = resolveLyknArtifactHtml(loadUrl);
  }
  if (!pageHtml && loadUrl && !/^https?:\/\//i.test(loadUrl) && !/^data:/i.test(loadUrl)) {
    pageHtml = resolveLyknArtifactHtml(loadUrl);
  }
  if (pageHtml) {
    // Keep a cache copy for Glass iframe / download helpers.
    try {
      cacheArtifactHtmlForOverlay(pageHtml);
    } catch (_) {}
    const dataUrl = htmlToStageDataUrl(pageHtml);
    if (!dataUrl) return { ok: false, error: "empty" };
    // Huge reports: fall back to session-scoped lykn-artifact://
    if (dataUrl.length > 1_800_000) {
      ensureAgentArtifactSessionProtocol();
      loadUrl = cacheArtifactHtmlForOverlay(pageHtml);
    } else {
      loadUrl = dataUrl;
    }
  }

  if (!loadUrl) return { ok: false, error: "empty" };
  if (!agentStageUrlAllowed(loadUrl) && !/^https?:\/\//i.test(loadUrl)) {
    return { ok: false, error: "blocked_url" };
  }

  if (/^lykn-artifact:\/\//i.test(loadUrl)) {
    ensureAgentArtifactSessionProtocol();
  }

  // Drop stale subtabs of the SAME kind slot under a different id (legacy
  // random art-* ids) — this deliverable reuses one deterministic subtab.
  if (owner) {
    for (const [tabId, meta] of [...agentBrowserMeta.entries()]) {
      if (
        tabId !== id &&
        isAgentArtifactTabId(tabId) &&
        meta?.ownerAgentId === owner &&
        stageDeliverableSlot(meta?.artifactKind || "artifact") === stageDeliverableSlot(kind)
      ) {
        destroyAgentBrowserWindow(tabId);
      }
    }
  }

  const chromeUrl =
    kind === "report"
      ? "lykn://report"
      : kind === "image" || kind === "chart" || kind === "diagram"
        ? "lykn://image"
        : kind === "video"
          ? "lykn://video"
          : "lykn://artifact";

  // Mark deliverable BEFORE ensure/show so welcome-reload guards skip this tab.
  agentBrowserLabels.set(id, label);
  agentBrowserMeta.set(id, {
    kind: "artifact",
    artifactKind: kind,
    ownerAgentId: owner || id,
    url: chromeUrl,
    pageTitle: label,
  });

  // Front the new subtab only when the user's attention is already on this
  // agent's family (or they explicitly asked — `force`, or nothing is on
  // stage at all). A background task finishing must not switch the visible
  // tab out from under whatever the user is doing; its deliverable loads
  // into the parked subtab and waits in the strip.
  const front = !!show && (force || agentTabFamilyActive(owner || id) || !agentStageActiveId);
  if (front) {
    agentStageActiveId = id;
  }

  const wrap = ensureAgentBrowserWindow(id, {
    show: front,
    focus: front && !!focus,
    label: label || agentBrowserLabels.get(id) || "Agent",
  });
  if (front) {
    try {
      showAgentBrowserWindow(id, { focus: focus !== false, label });
    } catch (_) {}
  }
  const view = wrap?.view || agentBrowserViews.get(id);
  const wc = wrap?.webContents || view?.webContents;
  if (!view || !wc || wc.isDestroyed()) {
    return { ok: false, error: "no_browser" };
  }

  // Re-assert meta after ensure (welcome path may have touched it).
  agentBrowserLabels.set(id, label);
  agentBrowserMeta.set(id, {
    kind: "artifact",
    artifactKind: kind,
    ownerAgentId: owner || id,
    url: chromeUrl,
    pageTitle: label,
  });

  const paintHtmlFallback = () => {
    if (!pageHtml || !wc || wc.isDestroyed()) return;
    void wc
      .executeJavaScript(
        `document.open();document.write(${JSON.stringify(pageHtml)});document.close();`,
        true,
      )
      .catch(() => {});
  };

  try {
    // Prefer document.write for report HTML — avoids data: size limits and
    // races with welcome reloads treating data: URLs as empty tabs.
    if (pageHtml && (kind === "report" || /^data:text\/html/i.test(loadUrl))) {
      void wc
        .loadURL("about:blank")
        .then(() => paintHtmlFallback())
        .catch(() => {
          try {
            wc.loadURL(loadUrl);
          } catch (_) {
            paintHtmlFallback();
          }
        });
    } else {
      wc.loadURL(loadUrl);
    }
  } catch (e) {
    paintHtmlFallback();
    if (!pageHtml) return { ok: false, error: e?.message || "load_failed" };
  }
  wc.once("did-finish-load", () => {
    const meta = agentBrowserMeta.get(id) || {};
    agentBrowserMeta.set(id, {
      ...meta,
      url: chromeUrl,
      pageTitle: label,
      kind: "artifact",
      artifactKind: kind,
      ownerAgentId: owner || id,
    });
    // The deliverable lives in its own subtab — the owner agent's tab (and
    // its browse URL) stay untouched, so the agent keeps page access.
    pushAgentStageState();
  });
  wc.once("did-fail-load", (_e, code, desc) => {
    console.warn("[agent-stage] artifact load failed:", code, desc);
    paintHtmlFallback();
  });

  if (front) agentStageActiveId = id;
  layoutAgentStageViews();
  pushAgentStageState();
  return { ok: true, id, url: chromeUrl, title: label, fronted: front };
}

/**
 * Paint an artifact into an existing agent tab. Prefers http(s) navigation so
 * the agent keeps a real URL; falls back to inlined HTML (srcDoc / fetched
 * preview) via document.write when navigation fails or only HTML is available.
 */
async function paintArtifactIntoAgentTab(agentId, { url, html, title, kind = "artifact" } = {}) {
  const id = String(agentId || "").trim();
  if (!id) return { ok: false, error: "no_id" };
  const wc = getAgentBrowserWebContents(id);
  if (!wc || wc.isDestroyed()) return { ok: false, error: "no_browser" };

  const label = String(title || "Artifact").trim().slice(0, 48) || "Artifact";
  let pageHtml = typeof html === "string" && html.trim() ? html : "";
  const target = String(url || "").trim();

  agentBrowserLabels.set(id, label);
  agentBrowserMeta.set(id, {
    kind: "artifact",
    artifactKind: kind,
    ownerAgentId: id,
    url: target || "lykn://artifact",
    pageTitle: label,
  });
  agentStageActiveId = id;

  const paintHtml = (sourceHtml) => {
    if (!sourceHtml || wc.isDestroyed()) return Promise.resolve(false);
    return wc
      .loadURL("about:blank")
      .then(() =>
        wc.executeJavaScript(
          `document.open();document.write(${JSON.stringify(sourceHtml)});document.close();true;`,
          true,
        ),
      )
      .then(() => true)
      .catch(() => false);
  };

  // Try live URL first so the omnibox / agent context show a real address.
  if (/^https?:\/\//i.test(target)) {
    try {
      const nav = await ownedBrowserAct.navigate(wc, target);
      if (nav?.ok) {
        try {
          initAgentRuntime().setAgentUrl?.(id, nav.url || target);
        } catch (_) {}
        pushAgentStageState();
        return { ok: true, via: "url", url: nav.url || target };
      }
    } catch (e) {
      console.warn("[lykn] artifact URL navigate failed:", e?.message || e);
    }
    // Fetch the preview HTML ourselves and paint it — covers expired CDN
    // redirects / intermittent proxy failures while the side panel still works.
    if (!pageHtml) {
      try {
        const res = await electronNet.fetch(target, { redirect: "follow" });
        if (res.ok) {
          const ct = String(res.headers.get("content-type") || "");
          if (/text\/html|application\/xhtml/i.test(ct) || !ct) {
            pageHtml = await res.text();
          }
        }
      } catch (e) {
        console.warn("[lykn] artifact URL fetch failed:", e?.message || e);
      }
    }
  }

  if (pageHtml) {
    const painted = await paintHtml(pageHtml);
    if (painted) {
      try {
        cacheArtifactHtmlForOverlay(pageHtml);
      } catch (_) {}
      pushAgentStageState();
      return { ok: true, via: "html" };
    }
  }

  return { ok: false, error: "paint_failed" };
}

function destroyAgentOwnedArtifactTabs(ownerAgentId) {
  const owner = String(ownerAgentId || "");
  if (!owner) return;
  for (const [id, meta] of [...agentBrowserMeta.entries()]) {
    if ((meta?.kind === "artifact" || isAgentArtifactTabId(id)) && meta?.ownerAgentId === owner) {
      destroyAgentBrowserWindow(id);
    }
  }
}

function resolveToolResultStageUrl(result) {
  if (!result || typeof result !== "object") return "";
  let fileUrl = pickArtifactUrl(result);
  if (!fileUrl && typeof result.preview_html === "string" && result.preview_html.trim()) {
    fileUrl = cacheArtifactHtmlForOverlay(result.preview_html);
  }
  if (
    !fileUrl &&
    typeof result.preview_url === "string" &&
    /^https?:\/\//i.test(result.preview_url)
  ) {
    fileUrl = result.preview_url;
  }
  if (!fileUrl && typeof result.kroki_url === "string" && /^https?:\/\//i.test(result.kroki_url)) {
    fileUrl = result.kroki_url;
  }
  if (!fileUrl && typeof result.chart_url === "string" && /^https?:\/\//i.test(result.chart_url)) {
    fileUrl = result.chart_url;
  }
  return fileUrl;
}

function maybeOpenAgentStageDeliverable(opts, payload) {
  // Only Agent Mode streams — not the normal Glass ask bar.
  if (opts?.agentMode !== true) return null;
  const ownerAgentId =
    String(opts?.agentId || "").trim() || String(agentRuntime?.getActiveId?.() || "");
  try {
    return openAgentStageArtifact({ ...payload, ownerAgentId });
  } catch (e) {
    console.warn("[agent-stage] open artifact:", e?.message || e);
    return null;
  }
}

function hideAgentBrowserWindow(_agentId) {
  // Individual tabs stay in the stage; Agent Mode off hides the whole stage.
}

function notifyAgentBrowserVisibility(visible) {
  try {
    if (d.overlayWindow && !d.overlayWindow.isDestroyed()) {
      d.overlayWindow.webContents.send("lykn:agent-browser-visibility", {
        visible: !!visible,
      });
    }
  } catch (_) {}
}

function hideAllAgentBrowserWindows() {
  if (agentStageWindow && !agentStageWindow.isDestroyed() && agentStageWindow.isVisible()) {
    agentStageWindow.hide();
  }
  notifyAgentBrowserVisibility(false);
}

function agentBrowserWindowExists(agentId) {
  return agentBrowserViews.has(String(agentId || ""));
}

function getAgentBrowserWebContents(agentId) {
  const wrap = ensureAgentBrowserWindow(agentId, { show: false, focus: false });
  return wrap?.webContents || null;
}

function getActiveAgentBrowserWebContents() {
  const id = agentStageActiveId || agentRuntime?.getActiveId?.();
  if (!id) return null;
  const view = agentBrowserViews.get(id);
  return view && view.webContents && !view.webContents.isDestroyed()
    ? view.webContents
    : null;
}

/** Pick a real browse tab (not an artifact/report surface) for source links. */
function resolveAgentBrowseTargetId() {
  const rt = agentRuntime;
  const isBrowseTab = (id) => {
    const tabId = String(id || "").trim();
    if (!tabId || isAgentArtifactTabId(tabId) || isHiddenBotTab(tabId)) return false;
    const meta = agentBrowserMeta.get(tabId) || {};
    return meta.kind !== "artifact";
  };

  if (isBrowseTab(agentStageActiveId)) return agentStageActiveId;

  const linked = String(rt?.getMainLinkedBrowser?.() || "").trim();
  if (isBrowseTab(linked)) return linked;

  const agents = typeof rt?.listPublic === "function" ? rt.listPublic() : [];
  const activeId = String(rt?.getActiveId?.() || "").trim();
  const active = agents.find((a) => a && a.id === activeId);
  if (active && active.role !== "main" && isBrowseTab(active.id)) return active.id;

  const worker = agents.find(
    (a) => a && a.role !== "main" && a.id && isBrowseTab(a.id),
  );
  if (worker?.id) return worker.id;

  for (const id of agentBrowserViews.keys()) {
    if (isBrowseTab(id)) return id;
  }
  return "";
}

/**
 * Open http(s) links inside the LYKN in-app browser (Studio dock or agent
 * stage) as a fresh agent tab per URL — sources, artifacts, and markdown
 * links each get their own agent. Falls back to the OS default for
 * mailto/tel or when the in-app browser cannot take the URL.
 */
async function openUrlPreferAgentBrowser(url, { title, sourceChatId } = {}) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "empty" };

  let target = u;
  try {
    const parsed = new URL(u);
    if (
      (parsed.pathname === "/desktop-auth" || parsed.pathname.endsWith("/desktop-auth")) &&
      (parsed.origin === APP_ORIGIN || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      target = mintDesktopAuthUrl(parsed.toString());
    }
  } catch {
    /* open as-is through allowlists below */
  }

  // Auth / mailto / tel stay in the OS browser (or dedicated flows).
  if (!/^https?:\/\//i.test(target) || !agentStageUrlAllowed(target)) {
    openExternalSafe(target);
    return { ok: true, via: "external", url: target };
  }

  try {
    const docked = studioStageEmbedActive();
    // If Studio is open, keep the stage quiet — the renderer will switch to
    // the Browser tab and dock the views (avoids flashing the standalone stage).
    const studioOpen = !!(d.studioWindow && !d.studioWindow.isDestroyed());
    const quiet = studioOpen && !docked;
    const label = String(title || "").trim().slice(0, 48);

    // Always a new agent per link/artifact so each page is independently
    // actionable in the rail.
    const chat = String(sourceChatId || "").trim();
    const id =
      openAgentBrowserTabWithUrl(target, {
        title: label || undefined,
        focus: true,
        show: !quiet,
        ...(chat ? { sourceChatId: chat } : {}),
      }) || openStudioBrowserTabWithUrl(target, {
        focus: !quiet,
        ...(chat ? { sourceChatId: chat } : {}),
      });
    if (id) {
      if (label) agentBrowserLabels.set(id, label);
      notifyStudioShowBrowser();
      if (docked) {
        showAgentBrowserWindow(id, { focus: true, label: label || undefined });
      } else if (studioOpen) {
        agentStageActiveId = id;
        layoutAgentStageViews();
        pushAgentStageState();
      }
      return { ok: true, via: "agent", url: target, agentId: id };
    }
  } catch (e) {
    console.warn("[lykn] LYKN browser open failed, falling back to external:", e?.message || e);
  }

  openExternalSafe(target);
  return { ok: true, via: "external", url: target };
}

/** Tell the Studio renderer to switch to its Browser tab (harmless if not mounted). */
function notifyStudioShowBrowser(detail = {}) {
  try {
    const win = studioWindowRef();
    if (win && !win.isDestroyed()) {
      win.webContents.send("lykn:studio-show-browser", detail || {});
    }
  } catch (_) {}
}

let agentRuntimeLoadPromise = null;

function whenAgentRuntimeLoaded() {
  initAgentRuntime();
  return agentRuntimeLoadPromise || Promise.resolve();
}

// AGENT-HARNESS BRIDGE: runtime construction and ownedBrowserAct wiring.
function initAgentRuntime() {
  if (agentRuntime) return agentRuntime;
  loadBrowsingHabitsContext();
  // Browser sub-tabs for one agent — the capability behind the modular
  // agent's open_tab / close_tab / switch_tab actions. Each sub-tab is one
  // more entry in agentBrowserViews whose id names its owner
  // (agentTabIds.cjs), sharing the owner's session partition so a sign-in on
  // tab one holds on tab two. Visual selection only follows the agent when
  // the user is already looking at this agent's tab family — an agent working
  // in the background must not steal the stage from whatever the user is
  // watching.
  const agentTabsCapability = {
    open(ownerId, url) {
      const owner = String(ownerId || "").trim();
      if (!owner || !agentBrowserViews.has(owner)) return { ok: false, error: "no_owner_tab" };
      let n = 1;
      while (agentBrowserViews.has(agentTabIds.subTabId(owner, n))) n += 1;
      const id = agentTabIds.subTabId(owner, n);
      // Partition derivation reads the OWNER's incognito flag (see
      // agentBrowserPartition); mirroring it onto the sub-tab keeps the meta
      // and any per-id checks honest too.
      if (isAgentIncognito(owner)) agentIncognito.set(id, true);
      const label = `${agentBrowserLabels.get(owner) || "Agent"} · tab ${n + 1}`;
      const inherit = tabChatLineage.sourceChatIdOf(agentBrowserMeta.get(owner));
      const wrap = ensureAgentBrowserWindow(id, {
        show: false,
        focus: false,
        label,
        sourceChatId: inherit || undefined,
      });
      if (!wrap) return { ok: false, error: "tab_create_failed" };
      const meta = agentBrowserMeta.get(id) || {};
      agentBrowserMeta.set(id, {
        ...meta,
        ownerAgentId: owner,
        ...(inherit ? { sourceChatId: inherit } : {}),
      });
      const target = String(url || "").trim();
      if (target && /^https?:\/\//i.test(target)) {
        try {
          wrap.webContents.loadURL(target);
        } catch (_) {}
      }
      if (agentTabFamilyActive(owner)) agentStageActiveId = id;
      layoutAgentStageViews();
      pushAgentStageState();
      return { ok: true, tabId: id, url: target };
    },
    close(ownerId, tabId) {
      const owner = String(ownerId || "").trim();
      const id = String(tabId || "").trim();
      // Only a sub-tab the agent owns may be closed; the primary tab is the
      // task's anchor and the user's window into it.
      if (!id || agentTabIds.subTabOwner(id) !== owner) {
        return { ok: false, error: id === owner ? "cannot_close_primary_tab" : "not_your_tab" };
      }
      if (!agentBrowserViews.has(id)) return { ok: false, error: "unknown_tab" };
      destroyAgentBrowserWindow(id);
      if (agentStageActiveId === id) agentStageActiveId = owner;
      layoutAgentStageViews();
      pushAgentStageState();
      return { ok: true, tabId: id };
    },
    activate(ownerId, tabId) {
      const owner = String(ownerId || "").trim();
      const id = String(tabId || "").trim();
      const inFamily = id === owner || agentTabIds.subTabOwner(id) === owner;
      if (!inFamily || !agentBrowserViews.has(id)) return { ok: false, error: "unknown_tab" };
      if (agentTabFamilyActive(owner)) {
        agentStageActiveId = id;
        layoutAgentStageViews();
        pushAgentStageState();
      }
      return { ok: true, tabId: id };
    },
    list(ownerId) {
      const owner = String(ownerId || "").trim();
      const rows = [];
      for (const [id, view] of agentBrowserViews) {
        const mine = id === owner || agentTabIds.subTabOwner(id) === owner;
        if (!mine) continue;
        // Deliverable viewers are not pages the agent drives.
        if ((agentBrowserMeta.get(id) || {}).kind === "artifact") continue;
        const wc = view?.webContents;
        rows.push({
          id,
          url: wc && !wc.isDestroyed() ? wc.getURL() || "" : "",
          title: wc && !wc.isDestroyed() ? wc.getTitle() || "" : "",
        });
      }
      return rows;
    },
    getWebContents(tabId) {
      const view = agentBrowserViews.get(String(tabId || "").trim());
      const wc = view?.webContents;
      return wc && !wc.isDestroyed() ? wc : null;
    },
  };

  agentRuntime = createAgentRuntime({
    userDataPath: app.getPath("userData"),
    apiBase: API_BASE,
    getAuthToken,
    readStreamResponse: readOverlayStreamResponse,
    emit: emitAgentToUi,
    ensureBrowserWindow: ensureAgentBrowserWindow,
    destroyBrowserWindow: destroyAgentBrowserWindow,
    showBrowserWindow: showAgentBrowserWindow,
    hideBrowserWindow: hideAgentBrowserWindow,
    hideAllBrowserWindows: hideAllAgentBrowserWindows,
    browserWindowExists: agentBrowserWindowExists,
    getBrowserWebContents: getAgentBrowserWebContents,
    isContentProtectionEnabled,
    openStageArtifact: openAgentStageArtifact,
    destroyOwnedArtifactTabs: destroyAgentOwnedArtifactTabs,
    focusOverlayComposer: focusOverlayForTyping,
    notifyAgentFinished,
    getBrowsingContext,
    getActiveBrowseAgentId: () => resolveAgentBrowseTargetId() || agentStageActiveId || null,
    agentTabs: agentTabsCapability,
    onStructuredEvent: (event) => teachService?.recordTaskEvent(event),
    // Bot mini-viewport support: which hidden tabs must keep painting for
    // capturePage, and a nudge to rebuild a surface when a capture comes
    // back empty (fresh tab, or a dock/undock re-parented the view).
    setBotShotAgents,
    prepareBotShotSurface,
  });
  agentRuntimeLoadPromise = Promise.resolve(agentRuntime.load()).catch((err) => {
    console.warn("[agent-runtime] load failed:", err?.message || err);
  });
  return agentRuntime;
}

// BOT ROUTINES: durable schedules/monitors that spawn canonical Tasks.
// The routine runtime owns WHEN (store + scheduler + monitors + notifications);
// the agent runtime stays the execution authority for each occurrence.
function initRoutineRuntime() {
  if (routineRuntime) return routineRuntime;
  const runtime = initAgentRuntime();
  routineRuntime = createRoutineRuntime({
    userDataPath: app.getPath("userData"),
    emit: emitAgentToUi,
    native: {
      isSupported: () => Notification.isSupported(),
      create: (opts) => new Notification(opts),
    },
    // Notification click: surface the app and let the renderer route to the
    // bot's board / routine (App-level listener on lykn:activity-open).
    onOpenNotification: (deepLink) => {
      try {
        if (!d.mainWindow || d.mainWindow.isDestroyed()) createMainWindow();
        else {
          d.mainWindow.show();
          d.mainWindow.focus();
        }
      } catch (_) {
        /* window may be tearing down */
      }
      emitAgentToUi("lykn:activity-open", deepLink || {});
    },
    executeTask: async ({ routine, runId, triggerContext, onTaskCreated }) => {
      if (routine?.workflowId) {
        const workflow = initTeachService().getWorkflow(
          routine.workflowId,
          routine.workflowVersion ? { version: routine.workflowVersion } : undefined,
        );
        if (!workflow) return { status: "failed", error: "workflow_not_found" };
        return runtime.runLearnedWorkflow({
          workflow,
          bot: routine.bot,
          onTaskCreated,
          runId,
          interactiveApproval: false,
          origin: {
            type: "bot",
            routine: {
              id: String(routine.id),
              name: String(routine.name || "").slice(0, 80),
              triggerType: String(routine.trigger?.type || ""),
              workflowId: workflow.id,
              workflowVersion: workflow.version,
            },
          },
          association: {
            botId: String(routine.botId || ""),
            routineId: String(routine.id),
            routineRunId: String(runId || ""),
            workflowId: workflow.id,
            workflowVersion: workflow.version,
          },
          onApprovalRequired: (request) => {
            routineRuntime?.notifications?.notify({
              botId: routine.botId,
              routineId: routine.id,
              runId,
              title: `${routine.bot?.name || "Bot"} needs approval: ${routine.name}`,
              body: String(
                request?.question || "A consequential action needs your approval.",
              ).slice(0, 240),
              urgency: "high",
            });
          },
        });
      }
      return runtime.runRoutineOccurrence({
        routine,
        runId,
        triggerContext,
        onTaskCreated,
        // Consequential actions inside an unattended run park the task as
        // waiting_for_approval — this is the "come approve it" ping.
        onApprovalRequired: (request) => {
          routineRuntime?.notifications?.notify({
            botId: routine.botId,
            routineId: routine.id,
            runId,
            title: `${routine.bot?.name || "Bot"} needs approval: ${routine.name}`,
            body: String(request?.question || "A consequential action needs your approval.").slice(0, 240),
            urgency: "high",
          });
        },
      });
    },
    monitorDeps: {
      observeBrowser: (trigger) => runtime.observeRoutineBrowser(trigger),
      subscribePageEvents: (trigger, onEvent) => runtime.subscribeRoutineBrowser(trigger, onEvent),
      callModel: (opts) => runtime.callMonitorModel(opts),
      observeScreen: async (trigger) => {
        const capture = d.captureTargetedWindow;
        if (typeof capture !== "function") {
          return { found: false, appRunning: true, status: "waiting_for_target" };
        }
        const shot = await capture({
          appName: trigger.appName,
          titlePattern: trigger.titlePattern,
          region: trigger.region,
          maxWidth: 320,
        });
        if (!shot?.ok) {
          return {
            found: false,
            appName: trigger.appName || "",
            title: "",
            appRunning: shot?.status !== "target_unavailable",
            status: shot?.status || "target_unavailable",
          };
        }
        const fp = screenFingerprint(shot.imageUrl);
        shot.imageUrl = "";
        return {
          found: true,
          appName: shot.appName || trigger.appName || "",
          title: shot.title || "",
          fingerprint: fp,
        };
      },
      captureScreenForVision: async (trigger) => {
        const capture = d.captureTargetedWindow;
        if (typeof capture !== "function") return { imageUrl: "" };
        const shot = await capture({
          appName: trigger.appName,
          titlePattern: trigger.titlePattern,
          region: trigger.region,
          maxWidth: 640,
        });
        return { imageUrl: shot?.ok ? shot.imageUrl : "" };
      },
    },
  });
  // The harness's create_routine tool reaches routines through this seam.
  runtime.setRoutineBridge({
    createFromInstruction: (instruction, opts) =>
      routineRuntime.createRoutineFromInstruction(instruction, opts),
  });
  routineRuntime.start();
  return routineRuntime;
}

// TEACH-BY-DEMONSTRATION: explicit temporary observation + durable normalized
// workflows. This service owns neither Task execution nor scheduling.
function initTeachService() {
  if (teachService) return teachService;
  const runtime = initAgentRuntime();
  teachService = createTeachService({
    userDataPath: app.getPath("userData"),
    emit: emitAgentToUi,
    getBrowserWebContents: (input) => runtime.ensureTeachingBrowser(input) || null,
    runWorkflow: (input) => runtime.runLearnedWorkflow(input),
    createRoutine: (input) => initRoutineRuntime().createRoutine(input),
  });
  return teachService;
}

  // Publish host API onto the shell context.
  d.showAgentFinishedPopup = showAgentFinishedPopup;
  d.closeAgentFinishedPopup = closeAgentFinishedPopup;
  d.notifyAgentFinished = notifyAgentFinished;
  d.emitAgentToUi = emitAgentToUi;
  d.createAgentSidebarWindow = createAgentSidebarWindow;
  d.agentSidebarWindowVisible = agentSidebarWindowVisible;
  d.agentSidebarTargetBounds = agentSidebarTargetBounds;
  d.positionAgentSidebarWindow = positionAgentSidebarWindow;
  d.showAgentSidebarWindow = showAgentSidebarWindow;
  d.hideAgentSidebarWindow = hideAgentSidebarWindow;
  d.agentTabFamilyActive = agentTabFamilyActive;
  d.agentBrowserMainTabCount = agentBrowserMainTabCount;
  d.agentBrandIconFor = agentBrandIconFor;
  d.agentFaviconFallback = agentFaviconFallback;
  d.isAgentArtifactTabId = isAgentArtifactTabId;
  d.MAX_AGENT_BROWSER_TABS = MAX_AGENT_BROWSER_TABS;
  d.agentBrowserHistoryFile = agentBrowserHistoryFile;
  d.readAgentBrowserHistory = readAgentBrowserHistory;
  d.persistAgentBrowserHistory = persistAgentBrowserHistory;
  d.pushAgentBrowserHistory = pushAgentBrowserHistory;
  d.snapshotAgentBrowserHistory = snapshotAgentBrowserHistory;
  d.commitAgentBrowserHistory = commitAgentBrowserHistory;
  d.isAgentIncognito = isAgentIncognito;
  d.agentBrowserPartition = agentBrowserPartition;
  d.isAgentBrowserHomeUrl = isAgentBrowserHomeUrl;
  d.agentBrowserHomeSender = agentBrowserHomeSender;
  d.sanitizeHomeAttachments = sanitizeHomeAttachments;
  d.attachmentsFromPickedPaths = attachmentsFromPickedPaths;
  d.isLegacyGoogleHomeUrl = isLegacyGoogleHomeUrl;
  d.loadAgentBrowserHome = loadAgentBrowserHome;
  d.chromeUserAgentOverride = chromeUserAgentOverride;
  d.applyAgentTabEmulation = applyAgentTabEmulation;
  d.omniboxToUrl = omniboxToUrl;
  d.agentStageUrlAllowed = agentStageUrlAllowed;
  d.looksLikeAgentAuthPopupUrl = looksLikeAgentAuthPopupUrl;
  d.agentAuthPopupParentWindow = agentAuthPopupParentWindow;
  d.presentAgentAuthPopup = presentAgentAuthPopup;
  d.wireAgentPopupWindow = wireAgentPopupWindow;
  d.agentStageVisible = agentStageVisible;
  d.studioStageEmbedActive = studioStageEmbedActive;
  d.attachViewToWindow = attachViewToWindow;
  d.detachViewFromWindow = detachViewFromWindow;
  d.setViewVisible = setViewVisible;
  d.raiseAgentStageView = raiseAgentStageView;
  d.setViewRadius = setViewRadius;
  d.setDockedViewBounds = setDockedViewBounds;
  d.ensureStudioStageChromeView = ensureStudioStageChromeView;
  d.studioStageParkShift = studioStageParkShift;
  d.cancelStudioStageReveal = cancelStudioStageReveal;
  d.revealStudioStageViewsWhenSettled = revealStudioStageViewsWhenSettled;
  d.parkStudioStageViewsOnStage = parkStudioStageViewsOnStage;
  d.setStudioBrowserEmbed = setStudioBrowserEmbed;
  d.focusAgentStageOmnibox = focusAgentStageOmnibox;
  d.requestOmniboxFocusForTab = requestOmniboxFocusForTab;
  d.openFreshStudioBrowserTab = openFreshStudioBrowserTab;
  d.fillEmptyStudioBrowser = fillEmptyStudioBrowser;
  d.warmStudioBrowser = warmStudioBrowser;
  d.closeStudioBrowserSession = closeStudioBrowserSession;
  d.openStudioBrowserTabWithUrl = openStudioBrowserTabWithUrl;
  d.normalizeSyncUrl = normalizeSyncUrl;
  d.openAgentBrowserTabWithUrl = openAgentBrowserTabWithUrl;
  d.browsingContextFile = browsingContextFile;
  d.loadBrowsingHabitsContext = loadBrowsingHabitsContext;
  d.getBrowsingContext = getBrowsingContext;
  d.setBrowsingContextFromHistory = setBrowsingContextFromHistory;
  d.createAgentStageWindow = createAgentStageWindow;
  d.ensureAgentStageWindow = ensureAgentStageWindow;
  d.agentStageChromeH = agentStageChromeH;
  d.viewShotDataUrl = viewShotDataUrl;
  d.refreshStudioStageShot = refreshStudioStageShot;
  d.scheduleStudioStageShot = scheduleStudioStageShot;
  d.agentTabReferenceWidth = agentTabReferenceWidth;
  d.agentTabZoomForWidth = agentTabZoomForWidth;
  d.applyAgentTabZoom = applyAgentTabZoom;
  d.fitAgentTabsToPane = fitAgentTabsToPane;
  d.botShotParkBounds = botShotParkBounds;
  d.botShotHostWindow = botShotHostWindow;
  d.prepareBotShotSurface = prepareBotShotSurface;
  d.agentBotShotView = agentBotShotView;
  d.setBotShotAgents = setBotShotAgents;
  d.layoutAgentStageViews = layoutAgentStageViews;
  d.pushAgentStageState = pushAgentStageState;
  d.tabChatProjection = tabChatProjection;
  d.applyTabSourceChatId = applyTabSourceChatId;
  d.clearTabSourceChatIds = clearTabSourceChatIds;
  d.wireAgentBrowserViewEvents = wireAgentBrowserViewEvents;
  d.agentBrowserAllowsPermission = agentBrowserAllowsPermission;
  d.wireAgentSessionPermissions = wireAgentSessionPermissions;
  d.wireAgentSessionClientHints = wireAgentSessionClientHints;
  d.wireAgentSessionDownloads = wireAgentSessionDownloads;
  d.uniqueDownloadPath = uniqueDownloadPath;
  d.saveHtmlToDownloads = saveHtmlToDownloads;
  d.raiseAgentBrowserHost = raiseAgentBrowserHost;
  d.ensureAgentBrowserWindow = ensureAgentBrowserWindow;
  d.destroyAgentBrowserWindow = destroyAgentBrowserWindow;
  d.showAgentBrowserWindow = showAgentBrowserWindow;
  d.revealBotBrowserTab = revealBotBrowserTab;
  d.concealBotBrowserTab = concealBotBrowserTab;
  d.isHiddenBotTab = isHiddenBotTab;
  d.waitForWebContentsLoad = waitForWebContentsLoad;
  d.toggleAgentIncognito = toggleAgentIncognito;
  d.escapeHtmlForStage = escapeHtmlForStage;
  d.wrapMediaAsStageHtml = wrapMediaAsStageHtml;
  d.htmlToStageDataUrl = htmlToStageDataUrl;
  d.resolveLyknArtifactHtml = resolveLyknArtifactHtml;
  d.ensureAgentArtifactProtocolForPartition = ensureAgentArtifactProtocolForPartition;
  d.ensureAgentArtifactSessionProtocol = ensureAgentArtifactSessionProtocol;
  d.stageDeliverableSlot = stageDeliverableSlot;
  d.openAgentStageArtifact = openAgentStageArtifact;
  d.paintArtifactIntoAgentTab = paintArtifactIntoAgentTab;
  d.destroyAgentOwnedArtifactTabs = destroyAgentOwnedArtifactTabs;
  d.resolveToolResultStageUrl = resolveToolResultStageUrl;
  d.maybeOpenAgentStageDeliverable = maybeOpenAgentStageDeliverable;
  d.hideAgentBrowserWindow = hideAgentBrowserWindow;
  d.notifyAgentBrowserVisibility = notifyAgentBrowserVisibility;
  d.hideAllAgentBrowserWindows = hideAllAgentBrowserWindows;
  d.agentBrowserWindowExists = agentBrowserWindowExists;
  d.getAgentBrowserWebContents = getAgentBrowserWebContents;
  d.getActiveAgentBrowserWebContents = getActiveAgentBrowserWebContents;
  d.resolveAgentBrowseTargetId = resolveAgentBrowseTargetId;
  d.openUrlPreferAgentBrowser = openUrlPreferAgentBrowser;
  d.notifyStudioShowBrowser = notifyStudioShowBrowser;
  d.whenAgentRuntimeLoaded = whenAgentRuntimeLoaded;
  d.initAgentRuntime = initAgentRuntime;
  d.initRoutineRuntime = initRoutineRuntime;
  d.initTeachService = initTeachService;
  d.getRoutineRuntime = initRoutineRuntime;
  d.getTeachService = initTeachService;
  d.agentBrowserViews = agentBrowserViews;
  d.agentBrowserMeta = agentBrowserMeta;
  d.agentBrowserLabels = agentBrowserLabels;
  d.agentIncognito = agentIncognito;
  d.agentBrowserViewsReady = agentBrowserViewsReady;
  d.agentBotShotIds = agentBotShotIds;
  d.artifactHtmlCache = artifactHtmlCache;
  const bindLet = (name, get, set) => {
    Object.defineProperty(d, name, { enumerable: true, get, set });
  };
  bindLet("agentRuntime", () => agentRuntime, (v) => { agentRuntime = v; });
  bindLet("routineRuntime", () => routineRuntime, (v) => { routineRuntime = v; });
  bindLet("teachService", () => teachService, (v) => { teachService = v; });
  bindLet("openBrowserTaskChat", () => openBrowserTaskChat, (v) => { openBrowserTaskChat = v; });
  bindLet("agentSidebarWindow", () => agentSidebarWindow, (v) => { agentSidebarWindow = v; });
  bindLet("agentStageWindow", () => agentStageWindow, (v) => { agentStageWindow = v; });
  bindLet("agentStageActiveId", () => agentStageActiveId, (v) => { agentStageActiveId = v; });
  bindLet("agentChatOpen", () => agentChatOpen, (v) => { agentChatOpen = v; });
  bindLet("agentSidebarOpen", () => agentSidebarOpen, (v) => { agentSidebarOpen = v; });
  bindLet("agentStageMenuOverlay", () => agentStageMenuOverlay, (v) => { agentStageMenuOverlay = v; });
  bindLet("agentStageChromeHeight", () => agentStageChromeHeight, (v) => { agentStageChromeHeight = v; });
  bindLet("studioStageChromeView", () => studioStageChromeView, (v) => { studioStageChromeView = v; });
  bindLet("agentFinishedPopup", () => agentFinishedPopup, (v) => { agentFinishedPopup = v; });
  bindLet("agentRuntimeLoadPromise", () => agentRuntimeLoadPromise, (v) => { agentRuntimeLoadPromise = v; });
}

module.exports = { attachAgentBrowser };
