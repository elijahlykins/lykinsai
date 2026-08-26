"use strict";

function attachOverlaySessions(d) {
  if (d.__attached_attachOverlaySessions) return;
  d.__attached_attachOverlaySessions = true;
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
  const getAuthToken = (...a) => d.getAuthToken(...a);

function overlaySessionsPath() {
  return path.join(app.getPath("userData"), "overlay-sessions.json");
}

async function readOverlaySessionsStore() {
  try {
    const raw = await fs.readFile(overlaySessionsPath(), "utf8");
    const data = JSON.parse(raw);
    return {
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      currentSessionId: data.currentSessionId || null,
    };
  } catch {
    return { sessions: [], currentSessionId: null };
  }
}

async function writeOverlaySessionsStore(store) {
  await fs.writeFile(overlaySessionsPath(), JSON.stringify(store, null, 2), "utf8");
}

function overlaySessionTitle(messages) {
  const firstUser = (messages || []).find((m) => m && m.role === "user" && String(m.content || "").trim());
  if (firstUser) return String(firstUser.content).trim().slice(0, 72);
  return IS_MAC ? "⌘L chat" : "Ctrl+L chat";
}

function overlaySessionPreview(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const text = String(m?.content || "").trim();
    if (text) return text.slice(0, 140);
  }
  return "";
}

function normalizeUrlForMatch(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./i, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return raw
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[#?].*$/, "")
      .replace(/\/+$/, "");
  }
}

async function buildPastPageConversationSection(normalizedUrl, excludeSessionId) {
  if (!normalizedUrl) return "";
  let store;
  try {
    store = await readOverlaySessionsStore();
  } catch {
    return "";
  }
  const matches = (store.sessions || [])
    .filter((s) => s && s.id !== excludeSessionId && Array.isArray(s.messages) && s.messages.length)
    .filter((s) => {
      const pages = Array.isArray(s.pages) ? s.pages : [];
      if (pages.includes(normalizedUrl)) return true;
      if (s.pageUrl && normalizeUrlForMatch(s.pageUrl) === normalizedUrl) return true;
      return false;
    })
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, 3);
  if (!matches.length) return "";

  const blocks = [];
  let budget = 4000;
  for (const s of matches) {
    const when = s.updatedAt
      ? new Date(s.updatedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
    const turns = s.messages
      .slice(-6)
      .map((m) => {
        const role = m && m.role === "assistant" ? "LYKN" : "User";
        const content = String((m && m.content) || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 600);
        return content ? `${role}: ${content}` : "";
      })
      .filter(Boolean)
      .join("\n");
    if (!turns) continue;
    const entry = `Earlier conversation${when ? ` (${when})` : ""}:\n${turns}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    blocks.push(entry);
  }
  return blocks.join("\n\n");
}

async function fetchAppChatsForOverlay() {
  const token = await getAuthToken();
  if (!token) return { chats: [], error: "not_signed_in" };
  try {
    const res = await fetch(`${API_BASE}/api/desktop/chats?limit=40`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { chats: [], error: body || `http_${res.status}` };
    }
    const data = await res.json();
    return { chats: Array.isArray(data.chats) ? data.chats : [] };
  } catch (e) {
    return { chats: [], error: e && e.message ? e.message : "fetch_failed" };
  }
}

async function pushOverlaySessionToApp(sessionId, title, messages) {
  try {
    const token = await getAuthToken();
    if (!token) return false;
    if (!sessionId || !Array.isArray(messages) || !messages.length) return false;
    const res = await fetch(`${API_BASE}/api/desktop/chats/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ chatId: sessionId, title, messages }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

  d.buildPastPageConversationSection = buildPastPageConversationSection;
  d.fetchAppChatsForOverlay = fetchAppChatsForOverlay;
  d.normalizeUrlForMatch = normalizeUrlForMatch;
  d.overlaySessionPreview = overlaySessionPreview;
  d.overlaySessionTitle = overlaySessionTitle;
  d.overlaySessionsPath = overlaySessionsPath;
  d.pushOverlaySessionToApp = pushOverlaySessionToApp;
  d.readOverlaySessionsStore = readOverlaySessionsStore;
  d.writeOverlaySessionsStore = writeOverlaySessionsStore;
}

module.exports = { attachOverlaySessions };
