/**
 * Apps built by LYKN and installed on this device.
 *
 * Three concerns kept deliberately apart:
 *   - the manifest (`apps`)        — what the app is and what it may do
 *   - the project (`app_files`)    — the source an edit round-trip patches
 *   - the data (`app_data`)        — what the app writes while the user uses it
 *
 * Runtime data lives in its own table rather than in `items` because the vault
 * lists items: a to-do app writing a thousand rows would otherwise become a
 * thousand notes in the user's vault.
 *
 * Every read and write here is scoped by `appId` in SQL. The bridge in the main
 * process resolves that id from the calling frame's origin and never from an
 * argument, so an app cannot address another app's rows even if it lies.
 */

const crypto = require("crypto");

const db = require("./db.cjs");

const now = () => new Date().toISOString();

/** One value the bridge will accept. Generous for documents, far below "fill the disk". */
const MAX_VALUE_BYTES = 1_000_000;
/** A single source file. Matches the artifact builder's own per-project ceiling. */
const MAX_FILE_BYTES = 400_000;
/** Snapshots kept per app before the oldest is dropped. */
const MAX_VERSIONS = 20;

const APP_COLUMNS = [
  "name",
  "icon",
  "icon_source",
  "description",
  "version",
  "entry",
  "capabilities",
  "grants",
  "source_chat",
  "created_at",
  "updated_at",
  "opened_at",
  "deleted_at",
];

const APP_JSON_COLUMNS = new Set(["capabilities", "grants"]);

function encodeJson(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function decodeJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToApp(row) {
  if (!row) return null;
  return {
    ...row,
    capabilities: decodeJson(row.capabilities, []),
    grants: decodeJson(row.grants, {}),
  };
}

/**
 * Turn a name into an id that is safe to use as the hostname of
 * `lykn-app://<id>/`. A standard scheme lowercases its hostname, so an id that
 * differed only by case would resolve to a different row than the one the
 * origin maps back to — hence lowercase-only, enforced here rather than trusted
 * from callers. A short random suffix keeps two apps called "Notes" apart.
 */
function slugifyAppId(name) {
  const base = String(name || "app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base || "app"}-${suffix}`;
}

/** Reject anything that could not round-trip through a URL hostname. */
function isValidAppId(id) {
  const s = String(id || "");
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) && !s.endsWith("-");
}

function assertAppId(id) {
  const s = String(id || "");
  if (!isValidAppId(s)) throw new Error(`invalid app id: ${JSON.stringify(s)}`);
  return s;
}

/**
 * Project-relative path check. Rejects absolute paths and any `..` segment so a
 * crafted path cannot climb out of the app when the protocol handler resolves
 * it against the file table.
 */
function normalizeFilePath(input) {
  const raw = String(input || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw) throw new Error("file path is required");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`file path must be relative: ${raw}`);
  }
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`file path may not contain "..": ${raw}`);
  const joined = parts.join("/");
  if (!joined) throw new Error("file path is required");
  if (joined.length > 400) throw new Error("file path is too long");
  return joined;
}

/**
 * An icon is the name of a lucide component, resolved in the renderer. Anything
 * that could not be one is dropped rather than stored: a bad name renders as
 * the fallback anyway, and keeping it would make the picker show a selection
 * the user can never see.
 */
function normalizeIconName(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  return /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(s) ? s : null;
}

/** Collection names become part of a primary key, so keep them boring. */
function normalizeCollection(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("collection is required");
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s)) {
    throw new Error(`invalid collection name: ${JSON.stringify(s)}`);
  }
  return s;
}

function normalizeKey(input) {
  const s = String(input ?? "").trim();
  if (!s) throw new Error("key is required");
  if (s.length > 200) throw new Error("key is too long");
  return s;
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/**
 * Install an app. `id` is generated from the name unless one is supplied (the
 * rebuild path passes the existing id so an update keeps the app's origin —
 * and therefore its IndexedDB and its data — intact).
 */
function createApp(input = {}) {
  const handle = db.get();
  const id = input.id ? assertAppId(input.id) : slugifyAppId(input.name);
  const created = input.created_at || now();

  handle
    .prepare(
      `INSERT INTO apps (id, name, icon, icon_source, description, version, entry, capabilities, grants, source_chat, created_at, updated_at, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         icon = excluded.icon,
         icon_source = excluded.icon_source,
         description = excluded.description,
         entry = excluded.entry,
         capabilities = excluded.capabilities,
         updated_at = excluded.updated_at,
         deleted_at = NULL`,
    )
    .run(
      id,
      String(input.name || "Untitled app").slice(0, 120),
      normalizeIconName(input.icon),
      input.icon_source === "user" ? "user" : null,
      input.description ? String(input.description).slice(0, 500) : null,
      Number(input.version) || 1,
      String(input.entry || "App.jsx"),
      encodeJson(input.capabilities ?? []),
      encodeJson(input.grants ?? {}),
      input.source_chat ? String(input.source_chat) : null,
      created,
      created,
    );

  return getApp(id);
}

function getApp(id) {
  const row = db.get().prepare("SELECT * FROM apps WHERE id = ?").get(String(id));
  return rowToApp(row);
}

function listApps(opts = {}) {
  const { includeDeleted = false, limit = 200 } = opts;
  const clause = includeDeleted ? "" : "WHERE deleted_at IS NULL";
  const capped = Math.max(1, Math.min(Number(limit) || 200, 500));
  const rows = db
    .get()
    .prepare(
      `SELECT * FROM apps ${clause}
       ORDER BY (opened_at IS NULL), opened_at DESC, created_at DESC
       LIMIT ?`,
    )
    .all(capped);
  return rows.map(rowToApp);
}

function updateApp(id, patch = {}) {
  const handle = db.get();
  const appId = String(id);
  const next = { ...patch, updated_at: patch.updated_at || now() };

  const columns = [];
  const values = [];
  for (const key of APP_COLUMNS) {
    if (!(key in next)) continue;
    let value = next[key];
    if (APP_JSON_COLUMNS.has(key)) value = encodeJson(value);
    if (value === undefined) value = null;
    columns.push(key);
    values.push(value);
  }
  if (!columns.length) return getApp(appId);

  handle
    .prepare(`UPDATE apps SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .run(...values, appId);

  return getApp(appId);
}

/**
 * The user's own icon choice.
 *
 * Marked as theirs even when they clear it back to the default, so a later
 * rebuild does not hand the manifest's icon back to someone who just removed
 * it. `null` means "whatever the app derives", not "unset".
 */
function setAppIcon(id, icon) {
  return updateApp(id, { icon: normalizeIconName(icon), icon_source: "user" });
}

/** Record a launch so the dock can order by most recently used. */
function touchApp(id) {
  db.get().prepare("UPDATE apps SET opened_at = ? WHERE id = ?").run(now(), String(id));
  return getApp(id);
}

/** Recoverable. The app's files and data stay until it is hard-deleted. */
function softDeleteApp(id) {
  db.get().prepare("UPDATE apps SET deleted_at = ? WHERE id = ?").run(now(), String(id));
  return { ok: true, id: String(id) };
}

function restoreApp(id) {
  db.get().prepare("UPDATE apps SET deleted_at = NULL WHERE id = ?").run(String(id));
  return getApp(id);
}

/** Removes the app, its files, its versions, and everything it ever stored. */
function hardDeleteApp(id) {
  const appId = String(id);
  return db.transaction((handle) => {
    // Explicit deletes rather than relying on cascade: `PRAGMA foreign_keys`
    // is per-connection, and this must remove the data even if some future
    // caller opens the file without it.
    handle.prepare("DELETE FROM app_data WHERE app_id = ?").run(appId);
    handle.prepare("DELETE FROM app_versions WHERE app_id = ?").run(appId);
    handle.prepare("DELETE FROM app_files WHERE app_id = ?").run(appId);
    handle.prepare("DELETE FROM apps WHERE id = ?").run(appId);
    return { ok: true, id: appId };
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function writeFile(appId, filePath, content) {
  const id = String(appId);
  const path = normalizeFilePath(filePath);
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new Error(`file ${path} exceeds ${MAX_FILE_BYTES} bytes`);
  }

  db.get()
    .prepare(
      `INSERT INTO app_files (app_id, path, content, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    )
    .run(id, path, text, now());

  return { ok: true, path };
}

/** Replace the whole project in one transaction. Used by install and rollback. */
function putFiles(appId, files = []) {
  const id = String(appId);
  const list = (Array.isArray(files) ? files : []).map((f) => ({
    path: normalizeFilePath(f?.path),
    content: String(f?.content ?? ""),
  }));

  for (const f of list) {
    if (Buffer.byteLength(f.content, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`file ${f.path} exceeds ${MAX_FILE_BYTES} bytes`);
    }
  }

  return db.transaction((handle) => {
    handle.prepare("DELETE FROM app_files WHERE app_id = ?").run(id);
    const stmt = handle.prepare(
      "INSERT INTO app_files (app_id, path, content, updated_at) VALUES (?, ?, ?, ?)",
    );
    const stamp = now();
    for (const f of list) stmt.run(id, f.path, f.content, stamp);
    return { ok: true, count: list.length };
  });
}

function readFile(appId, filePath) {
  let path;
  try {
    path = normalizeFilePath(filePath);
  } catch {
    return null;
  }
  const row = db
    .get()
    .prepare("SELECT content FROM app_files WHERE app_id = ? AND path = ?")
    .get(String(appId), path);
  return row ? String(row.content) : null;
}

function listFiles(appId) {
  return db
    .get()
    .prepare("SELECT path, content, updated_at FROM app_files WHERE app_id = ? ORDER BY path")
    .all(String(appId));
}

function deleteFile(appId, filePath) {
  const path = normalizeFilePath(filePath);
  db.get().prepare("DELETE FROM app_files WHERE app_id = ? AND path = ?").run(String(appId), path);
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Snapshot the current project and bump the app's version. Called before a
 * rebuild writes over the files, so a build that breaks the app is undoable.
 */
function snapshotVersion(appId, note = null) {
  const id = String(appId);
  return db.transaction((handle) => {
    const app = handle.prepare("SELECT version FROM apps WHERE id = ?").get(id);
    if (!app) throw new Error(`unknown app: ${id}`);

    const files = handle
      .prepare("SELECT path, content FROM app_files WHERE app_id = ? ORDER BY path")
      .all(id);
    const version = Number(app.version) || 1;

    handle
      .prepare(
        `INSERT INTO app_versions (app_id, version, files, note, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app_id, version) DO UPDATE SET files = excluded.files, note = excluded.note`,
      )
      .run(id, version, JSON.stringify(files), note ? String(note).slice(0, 300) : null, now());

    handle.prepare("UPDATE apps SET version = ?, updated_at = ? WHERE id = ?").run(version + 1, now(), id);

    // Keep history bounded — an app rebuilt fifty times should not carry fifty
    // full copies of itself around in the user's database.
    handle
      .prepare(
        `DELETE FROM app_versions WHERE app_id = ? AND version NOT IN (
           SELECT version FROM app_versions WHERE app_id = ? ORDER BY version DESC LIMIT ?
         )`,
      )
      .run(id, id, MAX_VERSIONS);

    return { ok: true, version, next: version + 1 };
  });
}

function listVersions(appId) {
  return db
    .get()
    .prepare(
      "SELECT version, note, created_at FROM app_versions WHERE app_id = ? ORDER BY version DESC",
    )
    .all(String(appId));
}

/** Restore a snapshot's files. The app's data is untouched. */
function rollback(appId, version) {
  const id = String(appId);
  const row = db
    .get()
    .prepare("SELECT files FROM app_versions WHERE app_id = ? AND version = ?")
    .get(id, Number(version));
  if (!row) throw new Error(`no version ${version} for app ${id}`);

  const files = decodeJson(row.files, []);
  putFiles(id, files);
  updateApp(id, {});
  return { ok: true, version: Number(version), files: files.length };
}

// ---------------------------------------------------------------------------
// App data — the store the bridge exposes as lykn.db
// ---------------------------------------------------------------------------

function dataSet(appId, collection, key, value) {
  const id = String(appId);
  const col = normalizeCollection(collection);
  const k = normalizeKey(key);
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded, "utf8") > MAX_VALUE_BYTES) {
    throw new Error(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  }
  const stamp = now();

  db.get()
    .prepare(
      `INSERT INTO app_data (app_id, collection, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, collection, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(id, col, k, encoded, stamp, stamp);

  return { ok: true, key: k, collection: col, updated_at: stamp };
}

/** Write many rows in one transaction — an app importing or syncing a list. */
function dataSetMany(appId, collection, entries = []) {
  const id = String(appId);
  const col = normalizeCollection(collection);
  const rows = (Array.isArray(entries) ? entries : []).map((e) => {
    const encoded = JSON.stringify(e?.value ?? null);
    if (Buffer.byteLength(encoded, "utf8") > MAX_VALUE_BYTES) {
      throw new Error(`value for key ${e?.key} exceeds ${MAX_VALUE_BYTES} bytes`);
    }
    return { key: normalizeKey(e?.key), value: encoded };
  });

  return db.transaction((handle) => {
    const stmt = handle.prepare(
      `INSERT INTO app_data (app_id, collection, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, collection, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const stamp = now();
    for (const r of rows) stmt.run(id, col, r.key, r.value, stamp, stamp);
    return { ok: true, count: rows.length };
  });
}

function dataGet(appId, collection, key) {
  const row = db
    .get()
    .prepare("SELECT value FROM app_data WHERE app_id = ? AND collection = ? AND key = ?")
    .get(String(appId), normalizeCollection(collection), normalizeKey(key));
  return row ? decodeJson(row.value, null) : null;
}

/**
 * Page through a collection, newest first. Keyset on (updated_at, key) so a
 * list that changes underneath the caller does not skip or repeat rows.
 */
function dataList(appId, collection, opts = {}) {
  const { limit = 100, after } = opts;
  const capped = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const params = [String(appId), normalizeCollection(collection)];
  let cursor = "";

  if (after?.updated_at && after?.key) {
    cursor = " AND (updated_at < ? OR (updated_at = ? AND key < ?))";
    params.push(String(after.updated_at), String(after.updated_at), String(after.key));
  }

  const rows = db
    .get()
    .prepare(
      `SELECT key, value, created_at, updated_at FROM app_data
       WHERE app_id = ? AND collection = ?${cursor}
       ORDER BY updated_at DESC, key DESC
       LIMIT ?`,
    )
    .all(...params, capped);

  return rows.map((r) => ({
    key: r.key,
    value: decodeJson(r.value, null),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

function dataDelete(appId, collection, key) {
  db.get()
    .prepare("DELETE FROM app_data WHERE app_id = ? AND collection = ? AND key = ?")
    .run(String(appId), normalizeCollection(collection), normalizeKey(key));
  return { ok: true };
}

function dataClear(appId, collection) {
  const id = String(appId);
  if (collection == null) {
    db.get().prepare("DELETE FROM app_data WHERE app_id = ?").run(id);
    return { ok: true, collection: null };
  }
  const col = normalizeCollection(collection);
  db.get().prepare("DELETE FROM app_data WHERE app_id = ? AND collection = ?").run(id, col);
  return { ok: true, collection: col };
}

function dataCount(appId, collection) {
  const params = [String(appId)];
  let clause = "";
  if (collection != null) {
    clause = " AND collection = ?";
    params.push(normalizeCollection(collection));
  }
  const row = db
    .get()
    .prepare(`SELECT COUNT(*) AS n FROM app_data WHERE app_id = ?${clause}`)
    .get(...params);
  return Number(row?.n || 0);
}

/** Collections this app has written, with row counts — powers the storage readout. */
function dataCollections(appId) {
  return db
    .get()
    .prepare(
      `SELECT collection, COUNT(*) AS count, MAX(updated_at) AS updated_at
       FROM app_data WHERE app_id = ? GROUP BY collection ORDER BY collection`,
    )
    .all(String(appId));
}

/**
 * Substring search across a collection's raw JSON.
 *
 * Deliberately not wired into the shared `chunks` index: retrieval there is a
 * brute-force cosine pass over every vector in the store, so letting an app
 * embed unbounded rows would slow the user's own vault search down. Apps that
 * genuinely need semantic recall go through the gated vault capability instead.
 */
function dataSearch(appId, collection, query, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 500));
  const q = String(query || "").trim();
  if (!q) return [];

  const params = [String(appId), normalizeCollection(collection)];
  // LIKE with an escaped pattern: the value column holds JSON, so this matches
  // any field without the app having to declare a schema up front.
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  params.push(pattern);

  const rows = db
    .get()
    .prepare(
      `SELECT key, value, created_at, updated_at FROM app_data
       WHERE app_id = ? AND collection = ? AND value LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(...params, limit);

  return rows.map((r) => ({
    key: r.key,
    value: decodeJson(r.value, null),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/** Per-app footprint for the settings storage readout. */
function appStats(appId) {
  const id = String(appId);
  const files = db
    .get()
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM app_files WHERE app_id = ?")
    .get(id);
  const data = db
    .get()
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM app_data WHERE app_id = ?")
    .get(id);
  return {
    files: Number(files?.n || 0),
    fileBytes: Number(files?.bytes || 0),
    rows: Number(data?.n || 0),
    dataBytes: Number(data?.bytes || 0),
  };
}

module.exports = {
  MAX_VALUE_BYTES,
  MAX_FILE_BYTES,
  slugifyAppId,
  isValidAppId,
  normalizeFilePath,
  normalizeCollection,
  normalizeIconName,

  createApp,
  getApp,
  listApps,
  updateApp,
  setAppIcon,
  touchApp,
  softDeleteApp,
  restoreApp,
  hardDeleteApp,

  writeFile,
  putFiles,
  readFile,
  listFiles,
  deleteFile,

  snapshotVersion,
  listVersions,
  rollback,

  dataSet,
  dataSetMany,
  dataGet,
  dataList,
  dataDelete,
  dataClear,
  dataCount,
  dataCollections,
  dataSearch,
  appStats,
};
