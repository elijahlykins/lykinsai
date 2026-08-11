/**
 * Recently visited sites for the agent browser — Chrome-style circles under
 * the omnibox. Deduped by host; most recent first.
 */

const fs = require("fs");
const path = require("path");

const MAX_RECENTS = 12;

function recentsPath(userDataPath) {
  return path.join(String(userDataPath || ""), "agent-browser-recents.json");
}

function hostKey(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/i.test(u.protocol)) return "";
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function siteHomeUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/^https?:$/i.test(u.protocol)) return "";
    return `${u.protocol}//${u.host}/`;
  } catch {
    return "";
  }
}

/** Skip SERPs / blank / internal chrome — keep real sites only. */
function isUsefulRecentUrl(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (/^(about:|lykn:|lykn-artifact:|data:|chrome:|devtools:)/i.test(u)) return false;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const pathName = parsed.pathname || "/";
    if (/google\.(com|[a-z.]+)\/search/i.test(u)) return false;
    if (/bing\.com\/search/i.test(u)) return false;
    if (/duckduckgo\.com\/\?/i.test(u)) return false;
    if (/youtube\.com\/results/i.test(u)) return false;
    if (!host || host === "localhost") return false;
    // Bare product homes are fine; skip auth walls that aren't destinations.
    if (/accounts\.google\.com|login\.microsoftonline|appleid\.apple/i.test(host)) {
      return false;
    }
    if (pathName === "/" || pathName.length < 2) return true;
    return true;
  } catch {
    return false;
  }
}

function shortLabel(url, title) {
  const t = String(title || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t && t.length <= 24 && !/^https?:\/\//i.test(t) && !/untitled/i.test(t)) {
    return t;
  }
  const host = hostKey(url);
  if (!host) return "Site";
  const leaf = host.split(".")[0];
  return leaf ? leaf.charAt(0).toUpperCase() + leaf.slice(1) : host;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lastUrl = String(raw.lastUrl || raw.url || "").trim();
  const url = String(raw.url || lastUrl || "").trim();
  if (!isUsefulRecentUrl(lastUrl) && !isUsefulRecentUrl(url)) return null;
  const host = hostKey(lastUrl || url) || String(raw.host || "");
  if (!host) return null;
  const openUrl =
    lastUrl && /\/(d|document|spreadsheets|presentation|mail|watch)\b/i.test(lastUrl)
      ? lastUrl
      : url && /\/(d|document|spreadsheets|presentation|mail|watch)\b/i.test(url)
        ? url
        : siteHomeUrl(lastUrl || url) || lastUrl || url;
  return {
    id: String(raw.id || host),
    host,
    url: openUrl,
    lastUrl: lastUrl || openUrl,
    title: String(raw.title || "").slice(0, 120),
    label: shortLabel(openUrl, raw.title || raw.label),
    favicon: String(raw.favicon || "").slice(0, 2000),
    visitedAt: Number(raw.visitedAt) || Date.now(),
  };
}

function readRecents(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(recentsPath(userDataPath), "utf8"));
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.map(normalizeItem).filter(Boolean).slice(0, MAX_RECENTS),
    };
  } catch {
    return { items: [] };
  }
}

function writeRecents(userDataPath, store) {
  const items = (Array.isArray(store?.items) ? store.items : [])
    .map(normalizeItem)
    .filter(Boolean)
    .slice(0, MAX_RECENTS);
  const next = { items, updatedAt: Date.now() };
  try {
    fs.writeFileSync(recentsPath(userDataPath), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("[LYKN] failed to write agent recents:", e?.message);
  }
  return next;
}

function recordRecentVisit(userDataPath, { url, title, favicon } = {}) {
  if (!isUsefulRecentUrl(url)) {
    return readRecents(userDataPath);
  }
  const store = readRecents(userDataPath);
  const host = hostKey(url);
  if (!host) return store;
  const rest = (store.items || []).filter((it) => it.host !== host);
  const prev = (store.items || []).find((it) => it.host === host);
  const now = Date.now();
  // Same host revisited within a few seconds (SPA / in-page) — skip disk write.
  if (prev && now - Number(prev.visitedAt || 0) < 4000 && !favicon) {
    return store;
  }
  const item = normalizeItem({
    id: host,
    host,
    url,
    title: title || prev?.title || "",
    favicon: favicon || prev?.favicon || "",
    visitedAt: now,
  });
  if (!item) return store;
  // Prefer the deepest real page URL for reopen, but keep site home for chip target
  // when it's a one-off deep link — lastUrl holds the latest.
  item.lastUrl = String(url || item.url);
  item.url = prev?.url && prev.host === host ? prev.url : item.url;
  // If they visited a specific doc/page, reopen that — not just the host home.
  if (/\/(d|document|spreadsheets|presentation|mail|watch)\b/i.test(item.lastUrl)) {
    item.url = item.lastUrl;
  }
  store.items = [item, ...rest].slice(0, MAX_RECENTS);
  return writeRecents(userDataPath, store);
}

function updateRecentFavicon(userDataPath, { url, favicon } = {}) {
  const host = hostKey(url);
  if (!host || !favicon) return readRecents(userDataPath);
  const store = readRecents(userDataPath);
  let changed = false;
  store.items = (store.items || []).map((it) => {
    if (it.host !== host) return it;
    changed = true;
    return { ...it, favicon: String(favicon).slice(0, 2000), visitedAt: it.visitedAt };
  });
  if (!changed) return store;
  return writeRecents(userDataPath, store);
}

function removeRecent(userDataPath, { id, host, url } = {}) {
  const store = readRecents(userDataPath);
  const h = host || hostKey(url) || String(id || "");
  const before = store.items.length;
  store.items = (store.items || []).filter((it) => it.host !== h && it.id !== id);
  if (store.items.length === before) return { ok: false, ...store };
  return { ok: true, ...writeRecents(userDataPath, store) };
}

module.exports = {
  MAX_RECENTS,
  hostKey,
  isUsefulRecentUrl,
  readRecents,
  writeRecents,
  recordRecentVisit,
  updateRecentFavicon,
  removeRecent,
};
