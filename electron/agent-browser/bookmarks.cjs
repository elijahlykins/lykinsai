"use strict";

/**
 * User-saved bookmarks for the agent browser — only what the user stars.
 * Nothing lands here automatically; browsing history lives in
 * visitHistory.cjs.
 */

const fs = require("fs");
const path = require("path");

const MAX_BOOKMARKS = 200;

function bookmarksPath(userDataPath) {
  return path.join(String(userDataPath || ""), "agent-browser-bookmarks.json");
}

/** Stable identity for a bookmarked URL: no hash, no trailing slash. */
function bookmarkKey(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "";
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function shortLabel(url, title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  if (t && t.length <= 24 && !/^https?:\/\//i.test(t)) return t;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    const leaf = host.split(".")[0];
    return leaf ? leaf.charAt(0).toUpperCase() + leaf.slice(1) : host || "Site";
  } catch {
    return "Site";
  }
}

function normalizeBookmark(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = String(raw.url || "").trim();
  const key = bookmarkKey(url);
  if (!key) return null;
  const title = String(raw.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    url,
    key,
    title,
    label: shortLabel(url, raw.label || title),
    favicon: String(raw.favicon || "").slice(0, 2000),
    addedAt: Number(raw.addedAt) || Date.now(),
  };
}

function readBookmarks(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(bookmarksPath(userDataPath), "utf8"));
    const items = Array.isArray(data?.items) ? data.items : [];
    return { items: items.map(normalizeBookmark).filter(Boolean).slice(0, MAX_BOOKMARKS) };
  } catch {
    return { items: [] };
  }
}

function writeBookmarks(userDataPath, store) {
  const items = (Array.isArray(store?.items) ? store.items : [])
    .map(normalizeBookmark)
    .filter(Boolean)
    .slice(0, MAX_BOOKMARKS);
  const next = { items, updatedAt: Date.now() };
  try {
    fs.writeFileSync(bookmarksPath(userDataPath), JSON.stringify(next), "utf8");
  } catch (e) {
    console.error("[LYKN] failed to write bookmarks:", e?.message);
  }
  return next;
}

function isBookmarked(userDataPath, url) {
  const key = bookmarkKey(url);
  if (!key) return false;
  return readBookmarks(userDataPath).items.some((b) => b.key === key);
}

/** Star / unstar a URL. Returns { ok, bookmarked, items }. */
function toggleBookmark(userDataPath, { url, title, favicon } = {}) {
  const key = bookmarkKey(url);
  const store = readBookmarks(userDataPath);
  if (!key) return { ok: false, bookmarked: false, items: store.items };
  const existing = store.items.find((b) => b.key === key);
  if (existing) {
    const next = writeBookmarks(userDataPath, {
      items: store.items.filter((b) => b.key !== key),
    });
    return { ok: true, bookmarked: false, items: next.items };
  }
  const item = normalizeBookmark({ url, title, favicon });
  if (!item) return { ok: false, bookmarked: false, items: store.items };
  const next = writeBookmarks(userDataPath, { items: [item, ...store.items] });
  return { ok: true, bookmarked: true, items: next.items };
}

function removeBookmark(userDataPath, { url } = {}) {
  const key = bookmarkKey(url);
  const store = readBookmarks(userDataPath);
  if (!key) return { ok: false, items: store.items };
  const before = store.items.length;
  const kept = store.items.filter((b) => b.key !== key);
  if (kept.length === before) return { ok: false, items: store.items };
  const next = writeBookmarks(userDataPath, { items: kept });
  return { ok: true, items: next.items };
}

module.exports = {
  MAX_BOOKMARKS,
  bookmarksPath,
  bookmarkKey,
  readBookmarks,
  isBookmarked,
  toggleBookmark,
  removeBookmark,
};
