/**
 * Finder-equivalent filesystem layer for the Vault's Locations sidebar.
 *
 * Deliberately separate from localSystem.cjs. That module is the AI agent's
 * capability layer, where a write is something the model asked for and has to
 * be approved before it runs. Here the person is the one clicking, so the
 * click is the consent and there's no approval round-trip.
 *
 * What still applies is the synced-folders allowlist, because that's the
 * user's own standing statement about which parts of the disk LYKN may touch.
 * With "sync my whole Mac" on, that's everything; otherwise it's the folders
 * they picked, and both browsing and editing stay inside them.
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const localSystem = require("./localSystem.cjs");

const execFileAsync = promisify(execFile);

// Required lazily so everything except trashing can be exercised outside a
// running Electron app, which is what the tests do.
function electronShell() {
  return require("electron").shell;
}

// Finder shows a whole Downloads folder without complaint, so the agent's
// 500-entry cap is far too low here. Past a few thousand the UI is the
// bottleneck anyway, and we tell the caller when we've clipped the tail.
const MAX_ENTRIES = 5000;
// Bursty writes (an app saving, an unarchive) fire many events for one logical
// change. Coalesce them so the renderer relists once.
const WATCH_DEBOUNCE_MS = 150;

// Directories macOS treats as opaque documents rather than folders to descend
// into. Double-clicking one should launch it, not show its guts.
const PACKAGE_EXTS = new Set([
  "app",
  "bundle",
  "framework",
  "kext",
  "photoslibrary",
  "musiclibrary",
  "tvlibrary",
  "rtfd",
  "xcodeproj",
  "xcworkspace",
  "playground",
  "pkg",
  "mpkg",
  "scptd",
  "download",
]);

let userDataPath = "";
let emitChange = () => {};

function configure(options = {}) {
  if (typeof options.userDataPath === "string") userDataPath = options.userDataPath;
  if (typeof options.onChange === "function") emitChange = options.onChange;
}

function readConfig() {
  return localSystem.readLocalMode(userDataPath);
}

function extOf(name) {
  const ext = path.extname(String(name || ""));
  return ext ? ext.slice(1).toLowerCase() : "";
}

/**
 * Every entry point runs this first. Local Mode is the master switch, and the
 * allowlist decides whether this particular path is in bounds. Returning the
 * config too saves callers a second read.
 */
function gate(...paths) {
  const config = readConfig();
  if (!config.enabled) return { ok: false, error: "local_mode_off" };
  for (const p of paths) {
    if (!p) return { ok: false, error: "bad_path" };
    if (!localSystem.isAllowedPath(p, config)) {
      return { ok: false, error: "not_synced", path: p };
    }
  }
  return { ok: true, config };
}

function resolve(p) {
  return localSystem.resolveUserPath(p);
}

/**
 * Whether an absolute path may be read right now. Same rule as gate(), exposed
 * for the lykn-mac:// protocol handler, which has a URL rather than an op.
 */
function canRead(absPath) {
  if (!absPath) return false;
  const config = readConfig();
  if (!config.enabled) return false;
  return localSystem.isAllowedPath(absPath, config);
}

/** Reject names that would escape the directory or upset the filesystem. */
function badName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "empty_name";
  if (raw === "." || raw === "..") return "reserved_name";
  if (raw.includes("/") || raw.includes("\0")) return "illegal_name";
  if (raw.length > 255) return "name_too_long";
  return "";
}

async function exists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** "report.pdf" → "report 2.pdf" → "report 3.pdf", the way Finder disambiguates. */
async function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  let n = 2;
  while (await exists(path.join(dir, candidate))) {
    candidate = `${base} ${n}${ext}`;
    n += 1;
  }
  return candidate;
}

/** Finder's duplicate naming: "report copy.pdf", then "report copy 2.pdf". */
async function duplicateName(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = `${base} copy${ext}`;
  let n = 2;
  while (await exists(path.join(dir, candidate))) {
    candidate = `${base} copy ${n}${ext}`;
    n += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

async function describe(dir, dirent) {
  const name = dirent.name;
  const full = path.join(dir, name);
  const ext = extOf(name);
  const entry = {
    name,
    path: full,
    ext,
    hidden: name.startsWith("."),
    type: dirent.isDirectory() ? "dir" : dirent.isSymbolicLink() ? "symlink" : "file",
    size: null,
    modifiedAt: null,
    createdAt: null,
    package: false,
  };

  try {
    // stat, not lstat: a symlink should report the thing it points at, which
    // is what Finder shows and what decides whether it opens as a folder.
    const st = await fsp.stat(full);
    entry.size = st.isFile() ? st.size : null;
    entry.modifiedAt = st.mtimeMs;
    entry.createdAt = st.birthtimeMs || null;
    if (st.isDirectory()) {
      entry.package = PACKAGE_EXTS.has(ext);
      if (entry.type === "symlink") entry.type = "dir";
    }
  } catch {
    /* permission denied or a broken symlink — still worth listing the name */
  }
  return entry;
}

function compareEntries(a, b, sort, order) {
  // Folders lead regardless of direction, like Finder's "keep folders on top".
  // Packages sort with files because that's what they behave like.
  const aDir = a.type === "dir" && !a.package;
  const bDir = b.type === "dir" && !b.package;
  if (aDir !== bDir) return aDir ? -1 : 1;

  const byName = () =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

  let result;
  switch (sort) {
    case "size":
      result = (a.size || 0) - (b.size || 0) || byName();
      break;
    case "kind":
      result = (a.ext || "").localeCompare(b.ext || "") || byName();
      break;
    case "created":
      result = (a.createdAt || 0) - (b.createdAt || 0) || byName();
      break;
    case "modified":
      result = (a.modifiedAt || 0) - (b.modifiedAt || 0) || byName();
      break;
    default:
      result = byName();
  }
  return order === "desc" ? -result : result;
}

async function list(args = {}) {
  const dir = resolve(args.path || "~");
  const allowed = gate(dir);
  if (!allowed.ok) return allowed;

  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: e?.code === "EACCES" ? "permission_denied" : e?.message };
  }

  const showHidden = args.showHidden === true;
  const wanted = showHidden ? dirents : dirents.filter((d) => !d.name.startsWith("."));
  const clipped = wanted.slice(0, MAX_ENTRIES);
  const entries = await Promise.all(clipped.map((d) => describe(dir, d)));
  entries.sort((a, b) => compareEntries(a, b, args.sort || "name", args.order || "asc"));

  return {
    ok: true,
    path: dir,
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    entries,
    total: wanted.length,
    truncated: wanted.length > clipped.length,
  };
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------
//
// What Finder puts in an icon view: the first page of a PDF, a frame from a
// video, an app's real icon. macOS generates all of those through QuickLook,
// so this asks the system instead of decoding formats in the renderer — which
// is also the only way HEIC and RAW get previews, since Chromium can't decode
// either. Whatever QuickLook has no generator for falls back to the file's
// icon, the same badge Finder draws for a document it can't preview.
//
// Electron's createThumbnailFromPath wraps the QuickLook image in an NSImage
// of exactly the Size we pass, which stretches a landscape photo into a
// square. We always ask for a size that matches the file's real ratio.

const THUMB_CACHE_MAX = 400;
// Keyed by path + size + mtime, so editing a file re-renders it rather than
// serving the picture of what it used to be.
const thumbCache = new Map();

// Generation isn't free and opening a folder asks for every tile at once, so
// only a handful run at a time and the rest wait their turn.
const THUMB_CONCURRENCY = 6;
let thumbsInFlight = 0;
const thumbQueue = [];

// A generator that never returns would hold its slot forever, and six of them
// would stall every tile in the app rather than just their own. Giving up on
// one is always better than that: the caller draws its kind icon instead.
const THUMB_TIMEOUT_MS = 10000;

function pumpThumbs() {
  while (thumbsInFlight < THUMB_CONCURRENCY && thumbQueue.length) {
    const { job, settle } = thumbQueue.shift();
    thumbsInFlight += 1;
    let timer;
    const guarded = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), THUMB_TIMEOUT_MS);
      job().then(resolve, () => resolve(null));
    });
    guarded.then((value) => {
      clearTimeout(timer);
      settle(value);
      thumbsInFlight -= 1;
      pumpThumbs();
    });
  }
}

function scheduleThumb(job) {
  return new Promise((settle) => {
    thumbQueue.push({ job, settle });
    pumpThumbs();
  });
}

function rememberThumb(key, value) {
  thumbCache.set(key, value);
  if (thumbCache.size > THUMB_CACHE_MAX) {
    thumbCache.delete(thumbCache.keys().next().value);
  }
}

// Electron's QuickLook wrapper draws the CGImage into the requested Size, so
// asking for 128×128 turns a landscape photo (or a portrait PDF page) into a
// square. Fit the long edge to `size` and keep the real ratio instead.
function fitWithin(width, height, size) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!(w > 0 && h > 0)) return { width: size, height: size };
  const scale = size / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function dataUrlFrom(image) {
  return image && !image.isEmpty() ? image.toDataURL() : null;
}

async function probePixelSize(abs, fileSize) {
  // Decoding a huge original just to stamp a 128px tile is the cost the
  // renderer already refuses to pay (see canThumbnail). QuickLook / sips
  // still know the ratio without loading every pixel.
  if (!(fileSize > 12 * 1024 * 1024)) {
    try {
      const { nativeImage } = require("electron");
      const fromFile = nativeImage.createFromPath(abs);
      if (fromFile && !fromFile.isEmpty()) {
        const { width, height } = fromFile.getSize();
        if (width > 0 && height > 0) return { width, height, image: fromFile };
      }
    } catch {
      /* HEIC/RAW/PDF won't decode here — that's what QuickLook is for */
    }
  }

  try {
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs], {
      timeout: 2000,
    });
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    /* sips only knows images */
  }

  try {
    const { stdout } = await execFileAsync(
      "mdls",
      ["-raw", "-name", "kMDItemPixelWidth", "-name", "kMDItemPixelHeight", abs],
      { timeout: 1500 },
    );
    const lines = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim());
    const width = Number(lines[0]);
    const height = Number(lines[1]);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    /* Spotlight hasn't indexed this file, or it has no pixels */
  }

  if (extOf(path.basename(abs)) === "pdf") return { width: 85, height: 110 };
  return null;
}

async function qlmanageThumb(abs, size) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lykn-thumb-"));
  try {
    await execFileAsync("qlmanage", ["-t", "-s", String(size), "-o", dir, abs], {
      timeout: 8000,
    });
    const names = await fsp.readdir(dir);
    const file = names.find((name) => /\.(png|jpe?g)$/i.test(name));
    if (!file) return null;
    const { nativeImage } = require("electron");
    return dataUrlFrom(nativeImage.createFromPath(path.join(dir, file)));
  } catch {
    return null;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderThumb(abs, size, isPackage, fileSize) {
  const { nativeImage } = require("electron");
  // An .app is a directory, and QuickLook would preview the bundle's contents
  // rather than hand back the icon that identifies it. Bundles read their .icns
  // off disk in a child process instead — see the ban note in appDock.cjs.
  if (isPackage) {
    return (await require("./appDock.cjs").getAppIcon(abs)) || null;
  }

  const probed = await probePixelSize(abs, fileSize);
  if (probed?.image) {
    const fitted = fitWithin(probed.width, probed.height, size);
    return dataUrlFrom(probed.image.resize(fitted));
  }

  const thumbSize = probed ? fitWithin(probed.width, probed.height, size) : null;
  if (thumbSize) {
    try {
      const image = await nativeImage.createThumbnailFromPath(abs, thumbSize);
      const url = dataUrlFrom(image);
      if (url) return url;
    } catch {
      /* fall through to qlmanage, which keeps the real aspect ratio */
    }
  }

  const fromQl = await qlmanageThumb(abs, size);
  if (fromQl) return fromQl;

  try {
    const image = await nativeImage.createThumbnailFromPath(abs, {
      width: size,
      height: size,
    });
    return dataUrlFrom(image);
  } catch {
    /* no generator for this type — the renderer keeps its own kind icon */
  }
  return null;
}

async function thumbnail(args = {}) {
  if (!args.path) return { ok: false, error: "no_path" };
  const abs = resolve(args.path);
  const allowed = gate(abs);
  if (!allowed.ok) return allowed;

  const size = Math.min(512, Math.max(32, Number(args.size) || 128));

  let st;
  try {
    st = await fsp.stat(abs);
  } catch (e) {
    return { ok: false, error: e?.code === "EACCES" ? "permission_denied" : "not_found" };
  }

  // Plain folders are drawn by the UI. Packages are the exception: their icon
  // is the whole point of showing one.
  const isPackage = st.isDirectory() && PACKAGE_EXTS.has(extOf(path.basename(abs)));
  if (st.isDirectory() && !isPackage) return { ok: false, error: "no_thumbnail" };

  const key = `${abs}|${size}|${st.mtimeMs}`;
  if (thumbCache.has(key)) {
    const cached = thumbCache.get(key);
    // Re-insert to refresh recency, so a folder being browsed can't evict
    // its own tiles while the user scrolls.
    thumbCache.delete(key);
    thumbCache.set(key, cached);
    return cached ? { ok: true, dataUrl: cached } : { ok: false, error: "no_thumbnail" };
  }

  // A null result is cached too: a file with no preview shouldn't be asked
  // about again every time its folder is opened.
  const dataUrl = await scheduleThumb(() => renderThumb(abs, size, isPackage, st.size));
  rememberThumb(key, dataUrl);
  return dataUrl ? { ok: true, dataUrl } : { ok: false, error: "no_thumbnail" };
}

// ---------------------------------------------------------------------------
// Sidebar roots
// ---------------------------------------------------------------------------

const FAVORITE_DIRS = [
  { id: "home", label: "Home", dir: () => os.homedir() },
  { id: "desktop", label: "Desktop", dir: () => path.join(os.homedir(), "Desktop") },
  { id: "documents", label: "Documents", dir: () => path.join(os.homedir(), "Documents") },
  { id: "downloads", label: "Downloads", dir: () => path.join(os.homedir(), "Downloads") },
  { id: "pictures", label: "Pictures", dir: () => path.join(os.homedir(), "Pictures") },
  { id: "music", label: "Music", dir: () => path.join(os.homedir(), "Music") },
  { id: "movies", label: "Movies", dir: () => path.join(os.homedir(), "Movies") },
  { id: "applications", label: "Applications", dir: () => "/Applications" },
];

/**
 * What the sidebar should offer, each entry carrying whether it's synced.
 *
 * Every location is listed whether or not it's shared, because each one has its
 * own sync switch on its page and a location that's been switched off still
 * needs somewhere to switch back on. What the allowlist decides is the flag, not
 * whether the row exists — the page reads as a switch instead of a listing.
 */
async function roots() {
  const config = readConfig();
  if (!config.enabled) return { ok: false, error: "local_mode_off" };

  const reachable = (p) => localSystem.isAllowedPath(p, config);

  const favorites = [];
  for (const fav of FAVORITE_DIRS) {
    const dir = fav.dir();
    if (!(await exists(dir))) continue;
    favorites.push({ id: fav.id, label: fav.label, path: dir, synced: reachable(dir) });
  }

  const volumes = [];
  try {
    for (const name of await fsp.readdir("/Volumes")) {
      const dir = path.join("/Volumes", name);
      volumes.push({ id: `volume:${name}`, label: name, path: dir, synced: reachable(dir) });
    }
  } catch {
    /* no /Volumes, or not readable — just show no volumes */
  }

  // When the user narrowed LYKN to specific folders, those ARE the sidebar's
  // main event, so they get their own section rather than hiding among the
  // favorites they happen to overlap.
  const synced = config.syncAll
    ? []
    : config.syncedFolders.map((dir) => ({
        id: `synced:${dir}`,
        label: path.basename(dir) || dir,
        path: dir,
        synced: reachable(dir),
      }));

  return {
    ok: true,
    syncAll: config.syncAll !== false,
    home: os.homedir(),
    favorites,
    volumes,
    synced,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function mkdir(args = {}) {
  const parent = resolve(args.path);
  const allowed = gate(parent);
  if (!allowed.ok) return allowed;

  const requested = String(args.name || "untitled folder").trim() || "untitled folder";
  const bad = badName(requested);
  if (bad) return { ok: false, error: bad };

  const name = await uniqueName(parent, requested);
  const full = path.join(parent, name);
  try {
    await fsp.mkdir(full);
  } catch (e) {
    return { ok: false, error: e?.message || "mkdir_failed" };
  }
  return { ok: true, path: full, name };
}

async function rename(args = {}) {
  const target = resolve(args.path);
  const allowed = gate(target);
  if (!allowed.ok) return allowed;

  const requested = String(args.name || "").trim();
  const bad = badName(requested);
  if (bad) return { ok: false, error: bad };

  const parent = path.dirname(target);
  const full = path.join(parent, requested);
  if (full === target) return { ok: true, path: target, name: requested };
  // Case-only renames look like a collision on a case-insensitive volume, so
  // let those through to the filesystem instead of refusing them.
  if (requested.toLowerCase() !== path.basename(target).toLowerCase()) {
    if (await exists(full)) return { ok: false, error: "name_taken" };
  }

  try {
    await fsp.rename(target, full);
  } catch (e) {
    return { ok: false, error: e?.message || "rename_failed" };
  }
  return { ok: true, path: full, name: requested };
}

/** rename() is atomic but can't cross volumes; copy-then-delete is the fallback. */
async function relocate(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/**
 * Shared body of move and copy: both take a set of sources into one folder and
 * should report per-item failures rather than abandoning the whole batch when
 * one file is locked.
 */
async function transfer(args, apply) {
  const dest = resolve(args.dest);
  const sources = (Array.isArray(args.paths) ? args.paths : [args.paths])
    .map((p) => resolve(p))
    .filter(Boolean);
  if (!sources.length) return { ok: false, error: "no_sources" };

  const allowed = gate(dest, ...sources);
  if (!allowed.ok) return allowed;

  const moved = [];
  const failed = [];
  for (const from of sources) {
    // Dropping a folder into itself or its own child would eat the source.
    if (dest === from || dest.startsWith(from + path.sep)) {
      failed.push({ path: from, error: "into_itself" });
      continue;
    }
    try {
      const name = await uniqueName(dest, path.basename(from));
      const to = path.join(dest, name);
      await apply(from, to);
      moved.push(to);
    } catch (e) {
      failed.push({ path: from, error: e?.message || "failed" });
    }
  }
  return { ok: failed.length === 0, paths: moved, failed };
}

function move(args = {}) {
  return transfer(args, relocate);
}

function copy(args = {}) {
  return transfer(args, (from, to) =>
    fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true }),
  );
}

async function duplicate(args = {}) {
  const sources = (Array.isArray(args.paths) ? args.paths : [args.paths])
    .map((p) => resolve(p))
    .filter(Boolean);
  if (!sources.length) return { ok: false, error: "no_sources" };

  const allowed = gate(...sources);
  if (!allowed.ok) return allowed;

  const made = [];
  const failed = [];
  for (const from of sources) {
    try {
      const parent = path.dirname(from);
      const to = path.join(parent, await duplicateName(parent, path.basename(from)));
      await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: true });
      made.push(to);
    } catch (e) {
      failed.push({ path: from, error: e?.message || "failed" });
    }
  }
  return { ok: failed.length === 0, paths: made, failed };
}

/**
 * Always the Trash, never rm. A mis-click in a file browser has to be
 * recoverable, and macOS already has the place for that.
 */
async function trash(args = {}) {
  const targets = (Array.isArray(args.paths) ? args.paths : [args.paths])
    .map((p) => resolve(p))
    .filter(Boolean);
  if (!targets.length) return { ok: false, error: "no_sources" };

  const allowed = gate(...targets);
  if (!allowed.ok) return allowed;

  const gone = [];
  const failed = [];
  for (const target of targets) {
    try {
      await electronShell().trashItem(target);
      gone.push(target);
    } catch (e) {
      failed.push({ path: target, error: e?.message || "failed" });
    }
  }
  return { ok: failed.length === 0, paths: gone, failed };
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

// One watcher per directory no matter how many windows are looking at it,
// refcounted so the last one to leave turns the lights off.
const watchers = new Map();

function watch(args = {}) {
  const dir = resolve(args.path);
  const allowed = gate(dir);
  if (!allowed.ok) return allowed;

  const existing = watchers.get(dir);
  if (existing) {
    existing.count += 1;
    return { ok: true, path: dir };
  }

  let handle;
  try {
    // Non-recursive on purpose: the browser only ever shows one directory, and
    // a recursive watch on a deep tree is a needless firehose.
    handle = fs.watch(dir, { persistent: false }, () => {
      const record = watchers.get(dir);
      if (!record) return;
      clearTimeout(record.timer);
      record.timer = setTimeout(() => emitChange(dir), WATCH_DEBOUNCE_MS);
    });
  } catch (e) {
    return { ok: false, error: e?.message || "watch_failed" };
  }

  // A watcher whose directory is deleted shouldn't take the process with it.
  handle.on("error", () => unwatchAll(dir));
  watchers.set(dir, { handle, count: 1, timer: null });
  return { ok: true, path: dir };
}

function unwatch(args = {}) {
  const dir = resolve(args.path);
  const record = watchers.get(dir);
  if (!record) return { ok: true };
  record.count -= 1;
  if (record.count > 0) return { ok: true };
  unwatchAll(dir);
  return { ok: true };
}

function unwatchAll(dir) {
  const record = watchers.get(dir);
  if (!record) return;
  clearTimeout(record.timer);
  try {
    record.handle.close();
  } catch {
    /* already closed */
  }
  watchers.delete(dir);
}

function closeWatchers() {
  for (const dir of [...watchers.keys()]) unwatchAll(dir);
}

module.exports = {
  configure,
  canRead,
  list,
  thumbnail,
  roots,
  mkdir,
  rename,
  move,
  copy,
  duplicate,
  trash,
  watch,
  unwatch,
  closeWatchers,
};
