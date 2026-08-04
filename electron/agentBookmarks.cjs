/**
 * Per-user saved links for the agent browser (star / bookmarks).
 * Stored as JSON under userData; aliases feed ownedBrowserAct deep-link resolution.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_BOOKMARKS = 80;
const MAX_ALIASES = 12;

function bookmarksPath(userDataPath) {
  return path.join(String(userDataPath || ""), "agent-browser-bookmarks.json");
}

function normalizeUrlKey(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^(about:|lykn:|lykn-artifact:|data:|chrome:|devtools:)/i.test(raw)) return "";
  try {
    const u = new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return "";
    const pathPart = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host}${pathPart}${u.search}${u.hash}`;
  } catch {
    return "";
  }
}

function cleanAlias(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function aliasKey(s) {
  return cleanAlias(s)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestAliases({ url, title, name } = {}) {
  const out = [];
  const push = (v) => {
    const a = cleanAlias(v);
    const k = aliasKey(a);
    if (!k || k.length < 2) return;
    if (!out.some((x) => aliasKey(x) === k)) out.push(a);
  };
  push(name);
  push(title);
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.replace(/^www\./i, "");
    push(host);
    const leaf = host.split(".")[0];
    if (leaf && leaf.length >= 3) push(leaf);
    // Path hint: /spreadsheets/d/xxx → "sheets"
    if (/docs\.google\.com\/spreadsheets/i.test(u.href)) push("sheets");
    if (/docs\.google\.com\/document/i.test(u.href)) push("docs");
    if (/drive\.google\.com/i.test(u.href)) push("drive");
  } catch {
    /* ignore */
  }
  // "my …" convenience for AI ("open my budget")
  for (const a of [...out]) {
    if (!/^my\s+/i.test(a) && a.split(/\s+/).length <= 5) push(`my ${a}`);
  }
  return out.slice(0, MAX_ALIASES);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = String(raw.url || "").trim();
  const key = normalizeUrlKey(url);
  if (!key) return null;
  const title = cleanAlias(raw.title) || cleanAlias(raw.name) || key;
  const name = cleanAlias(raw.name) || title;
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.map(cleanAlias).filter(Boolean).slice(0, MAX_ALIASES)
    : [];
  const suggested = suggestAliases({ url: key, title, name });
  const merged = [];
  for (const a of [...aliases, ...suggested, name, title]) {
    const k = aliasKey(a);
    if (!k) continue;
    if (!merged.some((x) => aliasKey(x) === k)) merged.push(cleanAlias(a));
  }
  return {
    id: String(raw.id || crypto.randomUUID()),
    url: key,
    title,
    name,
    aliases: merged.slice(0, MAX_ALIASES),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function readBookmarks(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(bookmarksPath(userDataPath), "utf8"));
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items
        .map(normalizeItem)
        .filter(Boolean)
        .slice(0, MAX_BOOKMARKS),
    };
  } catch {
    return { items: [] };
  }
}

function writeBookmarks(userDataPath, store) {
  const items = (Array.isArray(store?.items) ? store.items : [])
    .map(normalizeItem)
    .filter(Boolean)
    .slice(0, MAX_BOOKMARKS);
  const next = { items, updatedAt: Date.now() };
  try {
    fs.writeFileSync(bookmarksPath(userDataPath), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("[LYKN] failed to write agent bookmarks:", e?.message);
  }
  return next;
}

function findByUrl(store, url) {
  const key = normalizeUrlKey(url);
  if (!key) return null;
  return (store.items || []).find((it) => normalizeUrlKey(it.url) === key) || null;
}

function isBookmarked(store, url) {
  return !!findByUrl(store, url);
}

function toggleBookmark(userDataPath, { url, title, name } = {}) {
  const store = readBookmarks(userDataPath);
  const key = normalizeUrlKey(url);
  if (!key) return { ok: false, error: "bad_url", ...store, saved: false };

  const existing = findByUrl(store, key);
  if (existing) {
    store.items = store.items.filter((it) => it.id !== existing.id);
    const next = writeBookmarks(userDataPath, store);
    return { ok: true, saved: false, item: null, ...next };
  }

  const item = normalizeItem({
    url: key,
    title: title || name || key,
    name: name || title || key,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.items = [item, ...(store.items || [])].slice(0, MAX_BOOKMARKS);
  const next = writeBookmarks(userDataPath, store);
  return { ok: true, saved: true, item, ...next };
}

function removeBookmark(userDataPath, { id, url } = {}) {
  const store = readBookmarks(userDataPath);
  const before = store.items.length;
  store.items = store.items.filter((it) => {
    if (id && it.id === id) return false;
    if (url && normalizeUrlKey(it.url) === normalizeUrlKey(url)) return false;
    return true;
  });
  if (store.items.length === before) {
    return { ok: false, error: "not_found", ...store };
  }
  const next = writeBookmarks(userDataPath, store);
  return { ok: true, ...next };
}

function renameBookmark(userDataPath, { id, name, aliases } = {}) {
  const store = readBookmarks(userDataPath);
  const item = store.items.find((it) => it.id === id);
  if (!item) return { ok: false, error: "not_found", ...store };
  if (name != null) item.name = cleanAlias(name) || item.name;
  if (Array.isArray(aliases)) {
    item.aliases = aliases.map(cleanAlias).filter(Boolean).slice(0, MAX_ALIASES);
  }
  item.updatedAt = Date.now();
  const next = writeBookmarks(userDataPath, {
    items: store.items.map((it) => (it.id === id ? item : it)),
  });
  return { ok: true, item: next.items.find((it) => it.id === id) || item, ...next };
}

/** Build alias → url map for ownedBrowserAct (longer keys win via sort at use site). */
function buildAliasMap(store) {
  const map = {};
  for (const item of store?.items || []) {
    const url = normalizeUrlKey(item.url);
    if (!url) continue;
    const keys = new Set();
    for (const a of [item.name, item.title, ...(item.aliases || [])]) {
      const k = aliasKey(a);
      if (k && k.length >= 2) keys.add(k);
    }
    for (const k of keys) {
      // First bookmark wins for a given alias (most recently saved is first in list).
      if (!map[k]) map[k] = url;
    }
  }
  return map;
}

module.exports = {
  bookmarksPath,
  normalizeUrlKey,
  aliasKey,
  suggestAliases,
  normalizeItem,
  readBookmarks,
  writeBookmarks,
  findByUrl,
  isBookmarked,
  toggleBookmark,
  removeBookmark,
  renameBookmark,
  buildAliasMap,
};
