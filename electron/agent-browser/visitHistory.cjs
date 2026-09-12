"use strict";

/**
 * Chrome-style browsing history for the agent browser: every page visit,
 * newest first, persisted to userData. Distinct from the closed-tab history
 * (host.cjs, restores whole agents) and from recent-site chips
 * (agentRecentVisits.cjs, one per host, now superseded by bookmarks).
 */

const fs = require("fs");
const path = require("path");

const MAX_VISITS = 500;
/** Same-URL revisits inside this window update the entry instead of stacking. */
const REVISIT_WINDOW_MS = 5 * 60 * 1000;

function visitsPath(userDataPath) {
  return path.join(String(userDataPath || ""), "agent-browser-visits.json");
}

function isRecordableUrl(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (/agent-browser-(home|welcome)\.html/i.test(u)) return false;
  return true;
}

function normalizeVisit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = String(raw.url || "").trim();
  if (!isRecordableUrl(url)) return null;
  return {
    url,
    title: String(raw.title || "").replace(/\s+/g, " ").trim().slice(0, 200),
    favicon: String(raw.favicon || "").slice(0, 2000),
    at: Number(raw.at) || Date.now(),
  };
}

function readVisits(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(visitsPath(userDataPath), "utf8"));
    const items = Array.isArray(data?.items) ? data.items : [];
    return { items: items.map(normalizeVisit).filter(Boolean).slice(0, MAX_VISITS) };
  } catch {
    return { items: [] };
  }
}

function writeVisits(userDataPath, store) {
  const items = (Array.isArray(store?.items) ? store.items : [])
    .map(normalizeVisit)
    .filter(Boolean)
    .slice(0, MAX_VISITS);
  const next = { items, updatedAt: Date.now() };
  try {
    fs.writeFileSync(visitsPath(userDataPath), JSON.stringify(next), "utf8");
  } catch (e) {
    console.error("[LYKN] failed to write browser visits:", e?.message);
  }
  return next;
}

function recordVisit(userDataPath, { url, title, favicon } = {}) {
  const visit = normalizeVisit({ url, title, favicon });
  if (!visit) return readVisits(userDataPath);
  const store = readVisits(userDataPath);
  const [head, ...rest] = store.items || [];
  // Reload / SPA hop on the same URL — refresh the entry, don't stack dupes.
  if (head && head.url === visit.url && visit.at - head.at < REVISIT_WINDOW_MS) {
    const merged = {
      ...head,
      title: visit.title || head.title,
      favicon: visit.favicon || head.favicon,
      at: visit.at,
    };
    return writeVisits(userDataPath, { items: [merged, ...rest] });
  }
  return writeVisits(userDataPath, { items: [visit, ...(store.items || [])] });
}

function removeVisit(userDataPath, { url, at } = {}) {
  const store = readVisits(userDataPath);
  const target = String(url || "");
  const t = Number(at) || 0;
  const before = store.items.length;
  store.items = store.items.filter((v) => !(v.url === target && (!t || v.at === t)));
  if (store.items.length === before) return { ok: false, ...store };
  return { ok: true, ...writeVisits(userDataPath, store) };
}

function clearVisits(userDataPath) {
  return { ok: true, ...writeVisits(userDataPath, { items: [] }) };
}

module.exports = {
  MAX_VISITS,
  REVISIT_WINDOW_MS,
  visitsPath,
  isRecordableUrl,
  readVisits,
  recordVisit,
  removeVisit,
  clearVisits,
};
