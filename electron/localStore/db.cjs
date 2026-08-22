/**
 * SQLite connection + migration runner for the local store.
 *
 * Uses `node:sqlite`, which ships inside Electron's bundled Node — there is no
 * native module to compile, rebuild per Electron ABI, or add to the
 * electron-builder `files` allowlist.
 *
 * One connection for the whole main process. Every renderer touches this
 * through IPC, so there is no concurrency to coordinate beyond WAL.
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { MIGRATIONS, LATEST_VERSION } = require("./schema.cjs");

const DB_FILENAME = "lykn.db";

let db = null;
let rootDir = "";

/** Absolute path of the store directory (userData/localStore). */
function storeDir() {
  return rootDir;
}

function dbPath() {
  return path.join(rootDir, DB_FILENAME);
}

/**
 * Apply any migrations the file has not seen. `user_version` is a SQLite
 * header field, so this costs nothing to read and cannot drift from the file.
 */
function migrate(handle) {
  const current = Number(handle.prepare("PRAGMA user_version").get()?.user_version || 0);
  if (current >= LATEST_VERSION) return { from: current, to: current, applied: [] };

  const applied = [];
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue;
    // Each migration is its own transaction: a failure half-way leaves the
    // file on the last good version rather than in an undefined state.
    handle.exec("BEGIN");
    try {
      handle.exec(step.sql);
      handle.exec(`PRAGMA user_version = ${step.version}`);
      handle.exec("COMMIT");
      applied.push(step.name);
    } catch (err) {
      handle.exec("ROLLBACK");
      throw new Error(`migration ${step.version} (${step.name}) failed: ${err.message}`);
    }
  }
  return { from: current, to: LATEST_VERSION, applied };
}

/**
 * Open (creating if needed) the store. Idempotent — later calls return the
 * live handle.
 *
 * @param {string} userDataPath app.getPath("userData")
 */
function open(userDataPath) {
  if (db) return db;

  rootDir = path.join(String(userDataPath || ""), "localStore");
  fs.mkdirSync(rootDir, { recursive: true });

  const handle = new DatabaseSync(dbPath());

  // WAL lets reads proceed during writes, which matters once the renderer is
  // paginating the vault while an import or embed pass is running.
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA foreign_keys = ON");
  // NORMAL is the documented safe pairing with WAL: a power loss can cost the
  // last transaction but cannot corrupt the file.
  handle.exec("PRAGMA synchronous = NORMAL");

  migrate(handle);

  db = handle;
  return db;
}

/** The live handle. Throws rather than silently opening an unconfigured path. */
function get() {
  if (!db) throw new Error("local store is not open — call open(userDataPath) first");
  return db;
}

function isOpen() {
  return db !== null;
}

function close() {
  if (!db) return;
  try {
    // Fold the WAL back into the main file so a copy of lykn.db is complete
    // on its own (matters for export and for the backup snapshots).
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* checkpoint is best-effort */
  }
  db.close();
  db = null;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
function transaction(fn) {
  const handle = get();
  handle.exec("BEGIN");
  try {
    const result = fn(handle);
    handle.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      handle.exec("ROLLBACK");
    } catch {
      /* the outer error is the useful one */
    }
    throw err;
  }
}

module.exports = {
  open,
  get,
  close,
  isOpen,
  transaction,
  migrate,
  storeDir,
  dbPath,
  DB_FILENAME,
  LATEST_VERSION,
};
