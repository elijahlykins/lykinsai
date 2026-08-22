/**
 * Snapshots of the local store.
 *
 * Once the device is the only copy of a user's vault, an untended laptop is a
 * data-loss event. This keeps a rolling set of consistent database snapshots
 * under userData, taken with SQLite's own `backup()` — an online copy that is
 * transactionally consistent, so it is safe to run while the app is writing.
 *
 * Snapshots cover the database only. Blobs are already plain files on disk and
 * are covered by whatever the user backs up (Time Machine, etc.); a full
 * user-facing export bundling both arrives with the import/export work.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { backup } = require("node:sqlite");

const db = require("./db.cjs");
const store = require("./store.cjs");
const blobs = require("./blobs.cjs");

const BACKUPS_DIRNAME = "backups";
const KEEP_SNAPSHOTS = 7;
// Daily. Checked on an hourly tick so a machine that sleeps through the
// scheduled moment still catches up on wake rather than skipping a day.
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LAST_SNAPSHOT_KEY = "last_snapshot_at";

let timer = null;

function backupsDir() {
  return path.join(db.storeDir(), BACKUPS_DIRNAME);
}

function snapshotName(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `lykn-${stamp}.db`;
}

/** Take one snapshot now. Returns the path written. */
async function snapshot() {
  const dir = backupsDir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, snapshotName());

  await backup(db.get(), target);
  store.setMeta(LAST_SNAPSHOT_KEY, new Date().toISOString());
  await prune();

  const info = await fsp.stat(target).catch(() => null);
  return { ok: true, path: target, bytes: info?.size ?? 0 };
}

/** Newest first. */
async function list() {
  try {
    const names = await fsp.readdir(backupsDir());
    const files = names.filter((n) => n.startsWith("lykn-") && n.endsWith(".db"));
    const stats = await Promise.all(
      files.map(async (name) => {
        const full = path.join(backupsDir(), name);
        const info = await fsp.stat(full).catch(() => null);
        return info ? { name, path: full, bytes: info.size, createdAt: info.mtime.toISOString() } : null;
      }),
    );
    return stats.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** Drop everything past the newest `keep`. */
async function prune(keep = KEEP_SNAPSHOTS) {
  const all = await list();
  const doomed = all.slice(Math.max(0, keep));
  for (const entry of doomed) {
    await fsp.rm(entry.path, { force: true }).catch(() => {});
  }
  return { removed: doomed.length };
}

function dueForSnapshot() {
  const last = store.getMeta(LAST_SNAPSHOT_KEY, null);
  if (!last) return true;
  const elapsed = Date.now() - Date.parse(last);
  return !Number.isFinite(elapsed) || elapsed >= SNAPSHOT_INTERVAL_MS;
}

/**
 * Start the rolling snapshot timer. Idempotent; safe to call on every boot.
 * The timer is unref'd so it never holds the process open on quit.
 */
function start() {
  if (timer) return;

  const tick = async () => {
    if (!db.isOpen()) return;
    try {
      if (dueForSnapshot()) await snapshot();
    } catch (err) {
      console.error("[LYKN] local store snapshot failed:", err?.message);
    }
    // Riding the same tick rather than owning a timer: both are slow janitorial
    // passes with no reason to run more often than hourly, and the sweep is
    // cheap when there is nothing old enough to collect.
    try {
      await blobs.pruneGenerations();
    } catch (err) {
      console.error("[LYKN] generation sweep failed:", err?.message);
    }
  };

  timer = setInterval(tick, CHECK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();

  // Not on the boot path — a first-run snapshot would race the import that is
  // about to write everything anyway.
  setTimeout(tick, 5 * 60 * 1000).unref?.();
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Copy a snapshot over the live database. The caller must close the store
 * first and reopen after; this deliberately does not do it implicitly, because
 * every renderer holding local state needs to be told to refetch.
 */
async function restore(snapshotPath) {
  if (db.isOpen()) throw new Error("close the store before restoring");
  const source = String(snapshotPath || "");
  if (!fs.existsSync(source)) throw new Error("snapshot not found");

  const target = db.dbPath();
  // Keep whatever is currently there until the copy lands.
  const salvage = `${target}.replaced-${Date.now()}`;
  if (fs.existsSync(target)) await fsp.rename(target, salvage);

  try {
    await fsp.copyFile(source, target);
    // WAL and shm belong to the replaced database, not the restored one.
    await fsp.rm(`${target}-wal`, { force: true });
    await fsp.rm(`${target}-shm`, { force: true });
    return { ok: true, restoredFrom: source, previous: salvage };
  } catch (err) {
    if (fs.existsSync(salvage)) await fsp.rename(salvage, target).catch(() => {});
    throw err;
  }
}

module.exports = {
  snapshot,
  list,
  prune,
  restore,
  start,
  stop,
  backupsDir,
  dueForSnapshot,
  KEEP_SNAPSHOTS,
};
