import {
  findSlashPathToken,
  rankSlashPathItems,
  replaceSlashPathToken,
  slashPathDisplay,
  splitSlashPathQuery,
} from "./slashPathQuery.js";
import { findSlashModelToken } from "./slashModelQuery.js";
import { findSlashAppToken } from "./slashAppQuery.js";

const LIST_CAP = 80;
const POOL_CAP = 400;
const LOOKUP_MS = 32;
const ROOTS_TTL_MS = 15_000;
const LIST_TTL_MS = 12_000;

let rootsCache = null;
const listCache = new Map();

function filesApi() {
  const overlay = typeof window !== "undefined" ? window.lyknOverlay : null;
  if (overlay?.files && typeof overlay.files.list === "function") return overlay.files;
  return null;
}

function asFolder(entry) {
  return entry.type === "dir" && !entry.package;
}

function fromListing(listing, home) {
  const items = [];
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

function fromRoots(roots) {
  const items = [];
  const seen = new Set();
  const add = (name, path, synced) => {
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
  for (const row of roots.favorites || []) add(row.label, row.path, row.synced !== false);
  for (const row of roots.synced || []) add(row.label, row.path, row.synced !== false);
  return items;
}

function mergeItems(first, second) {
  const seen = new Set(first.map((i) => i.path));
  const out = first.slice();
  for (const item of second) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
  }
  return out;
}

async function listDir(api, dir) {
  try {
    return (await api.list({ path: dir })) || { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

async function cachedRoots(api) {
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

async function cachedList(api, dir) {
  const key = dir || "~";
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
  const listing = await listDir(api, dir);
  if (listing.ok) listCache.set(key, { at: Date.now(), value: listing });
  return listing;
}

async function searchNames(api, query) {
  if (!query || query.length < 2 || typeof api.search !== "function") {
    return { ok: true, entries: [] };
  }
  try {
    return (await api.search({ query, limit: LIST_CAP })) || { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

function universeKey(raw) {
  const split = splitSlashPathQuery(raw);
  return `${split.useRoots ? "1" : "0"}:${split.dir}`;
}

function mergePool(prev, incoming) {
  const seen = new Set(prev.map((item) => item.path));
  const out = prev.slice();
  for (const item of incoming) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
    if (out.length >= POOL_CAP) break;
  }
  return out;
}

async function lookup(raw) {
  const api = filesApi();
  if (!api) return { items: [], pool: [], error: "unavailable" };
  const split = splitSlashPathQuery(raw);
  let home = "";
  let rootsItems = [];
  const roots = await cachedRoots(api);
  if (roots?.error === "local_mode_off") {
    rootsCache = null;
    return { items: [], pool: [], error: "local_mode_off" };
  }
  if (roots?.ok) {
    home = String(roots.home || "");
    rootsItems = fromRoots(roots);
  }
  const [listing, found] = await Promise.all([
    cachedList(api, split.dir),
    split.useRoots && split.filter.length >= 2
      ? searchNames(api, split.filter)
      : Promise.resolve({ ok: true, entries: [] }),
  ]);
  if (listing.error === "local_mode_off") {
    listCache.delete(split.dir || "~");
    return { items: [], pool: [], error: "local_mode_off" };
  }
  let pool = listing.ok ? fromListing(listing, home) : [];
  if (split.useRoots) pool = mergeItems(rootsItems, pool);
  if (found.ok) pool = mergeItems(pool, fromListing(found, home));
  pool = pool.slice(0, POOL_CAP);
  if (!pool.length && !listing.ok) {
    return { items: [], pool: [], error: listing.error || "unavailable" };
  }
  return { items: rankSlashPathItems(pool, split.filter).slice(0, LIST_CAP), pool };
}

function hintFor(error, empty) {
  if (error === "local_mode_off") return "Turn on Local Mode in Settings to link files from this Mac.";
  if (error === "not_synced") return "That folder is not in LYKN's synced locations.";
  if (error === "unavailable") return "File linking needs Local Mode on this Mac.";
  if (empty) return "No matching files or folders.";
  return "";
}

export function attachSlashPath(host) {
  const askEl = host.askEl;
  const menuEl = document.getElementById("slash-path-menu");
  if (!askEl || !menuEl) {
    return {
      handleKeyDown: () => false,
      close: () => false,
      isOpen: () => false,
    };
  }

  let items = [];
  let pool = [];
  let poolKey = "";
  let index = 0;
  let token = null;
  let seq = 0;
  let timer = 0;
  let open = false;

  function isOpen() {
    return open;
  }

  function close() {
    window.clearTimeout(timer);
    seq += 1;
    open = false;
    token = null;
    items = [];
    index = 0;
    menuEl.hidden = true;
    menuEl.innerHTML = "";
    host.reportHeight?.();
    return true;
  }

  function paintActive() {
    const rows = menuEl.querySelectorAll(".slash-path-row");
    rows.forEach((row, i) => {
      const on = i === index;
      row.classList.toggle("active", on);
      row.setAttribute("aria-selected", on ? "true" : "false");
      if (on) row.scrollIntoView({ block: "nearest" });
    });
  }

  function showRanked(nextPool, filter) {
    items = rankSlashPathItems(nextPool, filter).slice(0, LIST_CAP);
    if (items.length) index = Math.min(index, items.length - 1);
    else index = 0;
    open = true;
    render();
  }

  function render() {
    menuEl.innerHTML = "";
    if (!open) {
      menuEl.hidden = true;
      host.reportHeight?.();
      return;
    }
    menuEl.hidden = false;
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "slash-path-hint";
      empty.textContent = menuEl.dataset.hint || "Type a file or folder on this Mac";
      menuEl.appendChild(empty);
      host.reportHeight?.();
      return;
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slash-path-row" + (i === index ? " active" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", i === index ? "true" : "false");
      const ico = document.createElement("span");
      ico.className = "slash-path-ico";
      ico.textContent = item.kind === "folder" ? "▸" : "·";
      const label = document.createElement("span");
      label.className = "slash-path-label";
      const name = document.createElement("span");
      name.className = "slash-path-name";
      name.textContent = item.name;
      label.appendChild(name);
      if (item.subtitle && item.subtitle !== item.name) {
        const sub = document.createElement("span");
        sub.className = "slash-path-sub";
        sub.textContent = item.subtitle;
        label.appendChild(sub);
      }
      btn.appendChild(ico);
      btn.appendChild(label);
      if (item.kind === "folder") {
        const tag = document.createElement("span");
        tag.className = "slash-path-tag";
        tag.textContent = "folder";
        btn.appendChild(tag);
      }
      btn.addEventListener("mouseenter", () => {
        index = i;
        paintActive();
      });
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", () => pick(item, "attach"));
      menuEl.appendChild(btn);
    }
    host.reportHeight?.();
    const active = menuEl.querySelector(".slash-path-row.active");
    if (active instanceof HTMLElement) active.scrollIntoView({ block: "nearest" });
  }

  async function runLookup(nextToken) {
    const id = ++seq;
    const result = await lookup(nextToken.raw);
    if (id !== seq) return;
    token = nextToken;
    const key = universeKey(nextToken.raw);
    const incoming = result.pool ?? result.items;
    if (poolKey === key) pool = mergePool(pool, incoming);
    else {
      poolKey = key;
      pool = incoming.slice(0, POOL_CAP);
    }
    if (result.error === "local_mode_off") {
      pool = [];
      poolKey = "";
    }
    menuEl.dataset.hint = hintFor(result.error, !result.items.length);
    const split = splitSlashPathQuery(nextToken.raw);
    showRanked(pool, split.filter);
  }

  function onInput() {
    if (!filesApi() || typeof window.lyknOverlay?.attachPaths !== "function") {
      close();
      return;
    }
    const cursor = askEl.selectionStart ?? askEl.value.length;
    const next = findSlashPathToken(askEl.value, cursor);
    if (!next || findSlashModelToken(askEl.value, cursor) || findSlashAppToken(askEl.value, cursor)) {
      close();
      return;
    }
    token = next;
    const split = splitSlashPathQuery(next.raw);
    const key = universeKey(next.raw);
    if (poolKey === key && pool.length) {
      menuEl.dataset.hint = "";
      showRanked(pool, split.filter);
    } else {
      open = true;
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runLookup(next), LOOKUP_MS);
  }

  function writeValue(next, cursor) {
    askEl.value = next;
    askEl.setSelectionRange(cursor, cursor);
    host.autoGrowAsk?.();
  }

  function pick(item, mode) {
    if (!token) return;
    if (mode === "descend" && item.kind === "folder") {
      const insert = item.path.endsWith("/") ? item.path : `${item.path}/`;
      const next = replaceSlashPathToken(askEl.value, token, insert);
      writeValue(next, token.start + insert.length);
      const nextToken = { start: token.start, end: token.start + insert.length, raw: insert };
      token = nextToken;
      pool = [];
      poolKey = "";
      void runLookup(nextToken);
      return;
    }
    const next = replaceSlashPathToken(askEl.value, token, "");
    writeValue(next, Math.min(token.start, next.length));
    close();
    void window.lyknOverlay.attachPaths([item.path]).then((rows) => {
      host.addAttachmentObjects?.(rows);
      askEl.focus();
    });
  }

  function handleKeyDown(event) {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    if (event.key === "ArrowDown") {
      if (!items.length) return false;
      event.preventDefault();
      index = (index + 1) % items.length;
      paintActive();
      return true;
    }
    if (event.key === "ArrowUp") {
      if (!items.length) return false;
      event.preventDefault();
      index = (index - 1 + items.length) % items.length;
      paintActive();
      return true;
    }
    if (event.key === "Tab") {
      const item = items[index];
      if (!item) return false;
      event.preventDefault();
      pick(item, item.kind === "folder" ? "descend" : "attach");
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const item = items[index];
      if (!item) return false;
      event.preventDefault();
      pick(item, "attach");
      return true;
    }
    return false;
  }

  askEl.addEventListener("input", onInput);
  askEl.addEventListener("click", onInput);
  document.addEventListener("pointerdown", (event) => {
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (askEl.contains(target) || menuEl.contains(target)) return;
    close();
  });

  return { handleKeyDown, close, isOpen };
}
