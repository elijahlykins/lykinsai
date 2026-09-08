/**
 * Resolve a `/path` query against Local Mode's file browser.
 * Listing stays behind the synced-folders allowlist (`window.lykn.files`).
 */

import {
  rankSlashPathItems,
  slashPathDisplay,
  splitSlashPathQuery,
  type SlashPathItem,
} from "./slashPathQuery";

type FilesApi = {
  list?: (args: { path?: string }) => Promise<FilesListResult>;
  search?: (args: { query?: string; limit?: number }) => Promise<FilesListResult>;
  roots?: () => Promise<FilesRootsResult>;
};

type FilesListResult = {
  ok?: boolean;
  error?: string;
  path?: string;
  entries?: Array<{
    name?: string;
    path?: string;
    type?: string;
    package?: boolean;
  }>;
};

type FilesRootsResult = {
  ok?: boolean;
  error?: string;
  home?: string;
  favorites?: Array<{ label?: string; path?: string; synced?: boolean }>;
  synced?: Array<{ label?: string; path?: string; synced?: boolean }>;
};

export type SlashPathLookup = {
  items: SlashPathItem[];
  /** Unranked listing + search hits for instant local filtering while typing. */
  pool: SlashPathItem[];
  error?: "unavailable" | "local_mode_off" | "not_synced" | string;
  dir?: string;
  home?: string;
};

const LIST_CAP = 80;
const POOL_CAP = 400;
const ROOTS_TTL_MS = 15_000;
const LIST_TTL_MS = 12_000;

let rootsCache: { at: number; value: FilesRootsResult } | null = null;
const listCache = new Map<string, { at: number; value: FilesListResult }>();

function filesApi(): FilesApi | null {
  if (typeof window === "undefined") return null;
  const lykn = (window as Window & { lykn?: { files?: FilesApi } }).lykn;
  if (lykn?.files && typeof lykn.files.list === "function") return lykn.files;
  const overlay = (window as Window & { lyknOverlay?: { files?: FilesApi } }).lyknOverlay;
  if (overlay?.files && typeof overlay.files.list === "function") return overlay.files;
  return null;
}

export function slashPathAvailable(): boolean {
  return filesApi() != null;
}

function asFolder(entry: { type?: string; package?: boolean }): boolean {
  return entry.type === "dir" && !entry.package;
}

function fromListing(listing: FilesListResult, home: string): SlashPathItem[] {
  const items: SlashPathItem[] = [];
  for (const entry of listing.entries || []) {
    const name = String(entry.name || "").trim();
    const path = String(entry.path || "").trim();
    if (!name || !path) continue;
    items.push({
      name,
      path,
      kind: asFolder(entry) ? "folder" : "file",
      subtitle: slashPathDisplay(path, home),
    });
  }
  return items;
}

function fromRoots(roots: FilesRootsResult): SlashPathItem[] {
  const items: SlashPathItem[] = [];
  const seen = new Set<string>();
  const add = (name: string, path: string, synced: boolean) => {
    const abs = String(path || "").replace(/\/+$/, "");
    if (!abs || seen.has(abs) || synced === false) return;
    seen.add(abs);
    items.push({
      name: String(name || abs.split("/").pop() || abs),
      path: abs,
      kind: "folder",
      subtitle: slashPathDisplay(abs, String(roots.home || "")),
    });
  };
  for (const row of roots.favorites || []) add(String(row.label || ""), String(row.path || ""), row.synced !== false);
  for (const row of roots.synced || []) add(String(row.label || ""), String(row.path || ""), row.synced !== false);
  return items;
}

function mergeItems(first: SlashPathItem[], second: SlashPathItem[]): SlashPathItem[] {
  const seen = new Set(first.map((i) => i.path));
  const out = first.slice();
  for (const item of second) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
  }
  return out;
}

async function listDir(api: FilesApi, dir: string): Promise<FilesListResult> {
  try {
    return (await api.list?.({ path: dir })) || { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

async function cachedRoots(api: FilesApi): Promise<FilesRootsResult | null> {
  if (rootsCache && Date.now() - rootsCache.at < ROOTS_TTL_MS) return rootsCache.value;
  if (typeof api.roots !== "function") return null;
  try {
    const roots = await api.roots();
    if (roots?.error === "local_mode_off") return roots;
    if (roots?.ok) rootsCache = { at: Date.now(), value: roots };
    return roots || null;
  } catch {
    return null;
  }
}

async function cachedList(api: FilesApi, dir: string): Promise<FilesListResult> {
  const key = dir || "~";
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
  const listing = await listDir(api, dir);
  if (listing.ok) listCache.set(key, { at: Date.now(), value: listing });
  return listing;
}

async function searchNames(api: FilesApi, query: string): Promise<FilesListResult> {
  if (!query || query.length < 2 || typeof api.search !== "function") {
    return { ok: true, entries: [] };
  }
  try {
    return (await api.search({ query, limit: LIST_CAP })) || { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/**
 * Look up files and folders for the current `/query` token.
 * A bare `/name` also searches nested folders inside Local Mode's allowlist.
 */
export async function lookupSlashPath(raw: string): Promise<SlashPathLookup> {
  const api = filesApi();
  if (!api) return { items: [], pool: [], error: "unavailable" };

  const split = splitSlashPathQuery(raw);
  let home = "";
  let rootsItems: SlashPathItem[] = [];

  const roots = await cachedRoots(api);
  if (roots?.error === "local_mode_off") {
    rootsCache = null;
    return { items: [], pool: [], error: "local_mode_off" };
  }
  if (roots?.ok) {
    home = String(roots.home || "");
    rootsItems = fromRoots(roots);
  }

  const listingPromise = cachedList(api, split.dir);
  const searchPromise =
    split.useRoots && split.filter.length >= 2
      ? searchNames(api, split.filter)
      : Promise.resolve({ ok: true, entries: [] } as FilesListResult);
  const [listing, found] = await Promise.all([listingPromise, searchPromise]);
  if (listing.error === "local_mode_off") {
    listCache.delete(split.dir || "~");
    return { items: [], pool: [], error: "local_mode_off" };
  }

  let pool: SlashPathItem[] = [];
  if (listing.ok) pool = fromListing(listing, home);
  if (split.useRoots) pool = mergeItems(rootsItems, pool);
  if (found.ok) pool = mergeItems(pool, fromListing(found, home));
  pool = pool.slice(0, POOL_CAP);

  if (!pool.length && !listing.ok) {
    return {
      items: [],
      pool: [],
      error: listing.error === "not_synced" ? "not_synced" : listing.error || "unavailable",
      dir: split.dir,
      home,
    };
  }

  return {
    items: rankSlashPathItems(pool, split.filter).slice(0, LIST_CAP),
    pool,
    dir: listing.path || split.dir,
    home,
  };
}
