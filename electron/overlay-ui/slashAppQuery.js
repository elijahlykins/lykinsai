/**
 * `/app` in the Glass composer. Keep in lockstep with
 * src/lib/chat/slashAppQuery.ts — that file is the tested copy.
 */

import { slashNameMatchRank } from "./slashPathQuery.js";

const LIST_CAP = 80;
const PATH_RESERVED =
  /^(documents|desktop|downloads|users|applications|library|movies|pictures|public|volumes|private|system|home|tmp|var|usr|opt|etc|bin)$/i;
const APP_FAMILY =
  /^(gmail|googlemail|spotify|slack|notion|github|gitlab|bitbucket|outlook|discord|figma|linear|twitter|youtube|gdrive|gdocs|gsheets|gcal|zoom|teams|dropbox|asana|jira|trello|airtable|hubspot|salesforce|stripe|twilio|shopify|mailchimp|intercom|zendesk|clickup|monday|canva|miro|pinterest|reddit|linkedin|instagram|facebook|whatsapp|telegram|signal|icloud|1password|lastpass|chrome|firefox|arc|brave|vscode|cursor|xcode|photoshop|illustrator|sketch|framer|webflow|superhuman|obsidian|todoist|calendly|supabase|firebase|vercel|netlify|datadog|sentry|confluence|pagerduty|googlecalendar|googledrive|googledocs|googlesheets|googletasks|googlemeet|meet)$/i;
const COMPOSIO_LOGO = "https://logos.composio.dev/api/";

export function looksLikeAppShortcut(query) {
  const q = String(query || "").trim();
  if (!q || /^app$/i.test(q)) return false;
  if (PATH_RESERVED.test(q)) return false;
  return APP_FAMILY.test(q);
}

export function findSlashAppToken(text, cursor) {
  const pos = Math.max(0, Math.min(Number(cursor) || 0, String(text || "").length));
  const before = String(text || "").slice(0, pos);
  const appCmd = /(?:^|[\s])(\/app(?:\s+([^/\n]*))?)$/i.exec(before);
  if (appCmd) {
    const raw = appCmd[1];
    const query = String(appCmd[2] || "").trim();
    const start = before.length - raw.length;
    return { start, end: pos, raw, query, kind: query ? "search" : "picker" };
  }
  const match = /(?:^|[\s])(\/[^\s/]+)$/.exec(before);
  if (!match) return null;
  const raw = match[1];
  if (raw.startsWith("//")) return null;
  const query = raw.slice(1);
  if (!looksLikeAppShortcut(query)) return null;
  const start = before.length - raw.length;
  return { start, end: pos, raw, query, kind: "search" };
}

export function logoUrlForCatalogId(catalogId) {
  const slug = String(catalogId || "")
    .replace(/^composio:/i, "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(slug)) return "";
  return `${COMPOSIO_LOGO}${encodeURIComponent(slug)}`;
}

export function slashAppFromMcp(row) {
  if (!row || String(row.status || "").toLowerCase() !== "connected") return null;
  const name = String(row.name || "").trim();
  const id = String(row.id || "").trim();
  if (!name || !id) return null;
  const catalogId = String(row.catalogId || "").trim();
  const account = String(row.accountLabel || row.accountIdentity || "").trim();
  return {
    id: `connected:${id}`,
    name,
    source: "connected",
    subtitle: account ? `Connected · ${account}` : "Connected",
    logoUrl: logoUrlForCatalogId(catalogId) || "",
    catalogId,
    connectionId: id,
  };
}

export function slashAppFromManaged(row) {
  if (!row || (row.connected !== true && String(row.status || "") !== "connected")) return null;
  const provider = String(row.provider || "").trim().toLowerCase();
  const name = String(row.label || provider).trim();
  if (!provider || !name) return null;
  return {
    id: `managed:${provider}`,
    name,
    source: "connected",
    subtitle: "Connected",
    logoUrl: String(row.iconUrl || "").trim() || logoUrlForCatalogId(provider),
    catalogId: provider,
    connectionId: String(row.connectionId || provider),
  };
}

export function slashAppFromMac(app) {
  const name = String(app?.name || "").trim();
  const path = String(app?.path || "").trim();
  if (!name || !path) return null;
  return {
    id: `mac:${path}`,
    name,
    source: "mac",
    subtitle: "Mac app",
    logoUrl: "",
    path,
  };
}

export function mergeSlashAppOptions(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const option of list || []) {
      if (!option?.id || seen.has(option.id)) continue;
      const alias =
        option.source === "connected"
          ? `connected:${String(option.catalogId || option.name).toLowerCase()}`
          : option.id;
      if (seen.has(alias) && alias !== option.id) continue;
      seen.add(option.id);
      seen.add(alias);
      out.push(option);
    }
  }
  return out;
}

function optionRank(option, q) {
  const parts = [
    String(option.name || ""),
    String(option.catalogId || "").replace(/^composio:/i, ""),
    String(option.subtitle || ""),
    String(option.path || "").split("/").pop()?.replace(/\.app$/i, "") || "",
  ];
  let best = -1;
  for (const part of parts) {
    const rank = slashNameMatchRank(part.toLowerCase(), q);
    if (rank < 0) continue;
    if (best < 0 || rank < best) best = rank;
  }
  return best;
}

export function rankSlashAppOptions(options, query) {
  const q = String(query || "").toLowerCase();
  const rows = (Array.isArray(options) ? options : [])
    .map((option, index) => ({
      option,
      index,
      rank: q ? optionRank(option, q) : 0,
      name: String(option.name || "").toLowerCase(),
      connected: option.source === "connected" ? 0 : 1,
    }))
    .filter((row) => row.rank >= 0);
  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (!q && a.connected !== b.connected) return a.connected - b.connected;
    if (!q && a.index !== b.index) return a.index - b.index;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    const alpha = a.name.localeCompare(b.name);
    if (alpha) return alpha;
    return a.index - b.index;
  });
  return rows.slice(0, LIST_CAP).map((row) => row.option);
}
