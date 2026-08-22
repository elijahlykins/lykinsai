import { useEffect, useState } from "react";

/**
 * Which folders on this Mac were made inside LYKN.
 *
 * A folder LYKN made is a real folder on disk — there is nothing about it the
 * filesystem records differently, so the only place that knowledge can live is
 * here. It buys one thing: those folders are drawn white, the way AI Drive's
 * own folders are, while the ones that were already on the Mac keep Finder's
 * blue. Home and the Files browser both mix the two in a single grid.
 *
 * The record is a convenience, not a source of truth. A folder renamed in
 * Finder, or on a machine that never had this list, simply reads as one of the
 * Mac's own — which is why nothing here throws and no caller waits on it.
 */

const KEY = "lykn_made_folders";
const EVENT = "lykn_made_folders_changed";

// Enough for any plausible amount of hand-made folders, and small enough that
// a list left behind by folders long since deleted can't grow without end.
const LIMIT = 512;

/** Trailing slashes make the same folder look like two entries. */
function normalize(path) {
  const p = String(path || "").trim();
  if (!p) return "";
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function inside(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}

function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (Array.isArray(saved)) return saved.filter((p) => typeof p === "string" && p);
  } catch {
    /* start empty */
  }
  return [];
}

function write(paths) {
  const kept = paths.slice(-LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* the folders stay white for this session */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The paths, as a set to test membership against. */
export function readLyknFolders() {
  return new Set(read());
}

/** Whether `path` is one of the folders LYKN made. */
export function isLyknFolder(made, path) {
  const p = normalize(path);
  return Boolean(p) && made.has(p);
}

/** Live view of the set, so a folder made in one window whitens in the other. */
export function useLyknFolders() {
  const [made, setMade] = useState(readLyknFolders);
  useEffect(() => {
    const sync = () => setMade(readLyknFolders());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return made;
}

/** Record folders made in LYKN. */
export function rememberLyknFolders(paths) {
  const stored = read();
  const made = new Set(stored);
  const added = [];
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    const p = normalize(path);
    if (!p || made.has(p)) continue;
    made.add(p);
    added.push(p);
  }
  if (added.length) write([...stored, ...added]);
}

/** Record a folder the user just made in LYKN. */
export function rememberLyknFolder(path) {
  rememberLyknFolders([path]);
}

/**
 * Drop folders that are gone — and anything that was nested inside them, since
 * trashing a folder takes the ones it held with it.
 */
export function forgetLyknFolders(paths) {
  const gone = (Array.isArray(paths) ? paths : [paths]).map(normalize).filter(Boolean);
  if (!gone.length) return;
  const kept = read().filter((p) => !gone.some((g) => inside(p, g)));
  write(kept);
}

/** A copy of a folder LYKN made is one LYKN made too. */
export function copyLyknFolders(moves) {
  const paths = read();
  const made = new Set(paths);
  const added = [];
  for (const [from, to] of Array.isArray(moves) ? moves : []) {
    const source = normalize(from);
    const copy = normalize(to);
    if (!source || !copy || made.has(copy) || !made.has(source)) continue;
    made.add(copy);
    added.push(copy);
  }
  if (added.length) write([...paths, ...added]);
}

/**
 * Follow folders that moved or were renamed. Descendants come along: renaming
 * a folder rewrites the path of every folder underneath it too.
 */
export function relocateLyknFolders(moves) {
  const pairs = (Array.isArray(moves) ? moves : [])
    .map(([from, to]) => [normalize(from), normalize(to)])
    .filter(([from, to]) => from && to && from !== to);
  if (!pairs.length) return;

  const paths = read();
  let changed = false;
  const next = paths.map((p) => {
    const hit = pairs.find(([from]) => inside(p, from));
    if (!hit) return p;
    changed = true;
    const [from, to] = hit;
    return p === from ? to : to + p.slice(from.length);
  });
  if (changed) write(next);
}

/**
 * Sources paired with where a batch move, copy or duplicate put them. The shell
 * reports what landed and what failed in source order, so the ones that made it
 * can be lined back up with where they came from.
 */
export function transferredPairs(sources, result) {
  const failed = new Set((result?.failed || []).map((f) => f?.path));
  const landed = Array.isArray(result?.paths) ? result.paths : [];
  const pairs = [];
  let i = 0;
  for (const from of Array.isArray(sources) ? sources : []) {
    if (failed.has(from)) continue;
    const to = landed[i];
    i += 1;
    if (to) pairs.push([from, to]);
  }
  return pairs;
}
