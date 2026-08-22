/**
 * Data operations for the local store — items, threads, messages.
 *
 * Rows go out to the renderer shaped like the Supabase rows it already knows:
 * JSON columns are parsed, timestamps stay ISO strings. That keeps the eventual
 * swap in Vault.jsx a change of transport rather than a change of data model.
 */

const crypto = require("crypto");

const db = require("./db.cjs");

/** Columns a caller may write. Anything else in a patch is ignored. */
const ITEM_COLUMNS = [
  "kind",
  "thread_id",
  "title",
  "content",
  "why",
  "tags",
  "source",
  "folder",
  "att_type",
  "platform",
  "url",
  "blob_path",
  "mime_type",
  "byte_size",
  "duration_seconds",
  "page_count",
  "host_name",
  "media_width",
  "media_height",
  "variant_thumb",
  "variant_med",
  "preview",
  "comments",
  "ai_summary",
  "ai_signals",
  "origin",
  "created_at",
  "updated_at",
  "deleted_at",
];

/** Columns holding JSON, parsed on read and stringified on write. */
const ITEM_JSON_COLUMNS = new Set(["tags", "preview", "comments", "ai_signals"]);
const MESSAGE_JSON_COLUMNS = new Set(["blocks"]);

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

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

function rowToItem(row) {
  if (!row) return null;
  return {
    ...row,
    tags: decodeJson(row.tags, []),
    preview: decodeJson(row.preview, null),
    comments: decodeJson(row.comments, []),
    ai_signals: decodeJson(row.ai_signals, null),
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return { ...row, blocks: decodeJson(row.blocks, null) };
}

/** Normalize a caller-supplied patch into column/value pairs ready to bind. */
function prepareItemValues(patch, jsonColumns = ITEM_JSON_COLUMNS) {
  const columns = [];
  const values = [];
  for (const key of ITEM_COLUMNS) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (jsonColumns.has(key)) value = encodeJson(value);
    if (value === undefined) value = null;
    columns.push(key);
    values.push(value);
  }
  return { columns, values };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Insert or replace an item. Pass an existing `id` to keep identity across an
 * import from Supabase; omit it for a fresh local row.
 */
function putItem(input = {}) {
  const handle = db.get();
  const id = String(input.id || newId());
  const created = input.created_at || now();

  const patch = { ...input, created_at: created, updated_at: input.updated_at || created };
  const { columns, values } = prepareItemValues(patch);

  const cols = ["id", ...columns];
  const placeholders = cols.map(() => "?").join(", ");
  // ON CONFLICT rather than INSERT OR REPLACE: replace would delete and
  // reinsert, which fires the FTS delete/insert triggers twice and drops any
  // column the caller did not supply.
  const updates = columns.filter((c) => c !== "created_at").map((c) => `${c} = excluded.${c}`);

  handle
    .prepare(
      `INSERT INTO items (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`,
    )
    .run(id, ...values);

  return getItem(id);
}

function getItem(id) {
  const row = db.get().prepare("SELECT * FROM items WHERE id = ?").get(String(id));
  return rowToItem(row);
}

/**
 * Partial update. Unlisted columns keep their current value.
 *
 * @param {string} id
 * @param {object} patch
 * @param {object} [opts]
 * @param {string} [opts.ifUpdatedAt]
 *   Compare-and-set on `updated_at`. Background passes — image dimensions, AI
 *   descriptions — read a row, think for a while, then write a derived value
 *   back. Without this guard they would overwrite whatever the user typed in
 *   the meantime. Returns null when the row moved on, which is the caller's
 *   signal to drop the stale result rather than retry.
 */
function updateItem(id, patch = {}, opts = {}) {
  const handle = db.get();
  const next = { ...patch, updated_at: patch.updated_at || now() };
  const { columns, values } = prepareItemValues(next);
  if (!columns.length) return getItem(id);

  const assignments = columns.map((c) => `${c} = ?`).join(", ");
  const guard = opts?.ifUpdatedAt ? " AND updated_at = ?" : "";
  const guardValues = opts?.ifUpdatedAt ? [String(opts.ifUpdatedAt)] : [];

  const result = handle
    .prepare(`UPDATE items SET ${assignments} WHERE id = ?${guard}`)
    .run(...values, String(id), ...guardValues);

  if (opts?.ifUpdatedAt && Number(result?.changes || 0) === 0) return null;
  return getItem(id);
}

/**
 * Keyset pagination, newest first — the same ordering the vault grid uses
 * against PostgREST today, so infinite scroll behaves identically.
 *
 * @param {object} [opts]
 * @param {string} [opts.kind]            Filter by item kind.
 * @param {string} [opts.threadId]        Only assets belonging to a thread.
 * @param {number} [opts.limit=50]
 * @param {{created_at: string, id: string}} [opts.after] Cursor: last row seen.
 * @param {boolean} [opts.includeDeleted=false]
 */
function listItems(opts = {}) {
  const { kind, threadId, limit = 50, after, includeDeleted = false } = opts;
  const where = [];
  const params = [];

  if (!includeDeleted) where.push("deleted_at IS NULL");
  if (kind) {
    where.push("kind = ?");
    params.push(String(kind));
  }
  if (threadId) {
    where.push("thread_id = ?");
    params.push(String(threadId));
  }
  if (after?.created_at && after?.id) {
    // Compound cursor keeps pagination stable when several rows share a
    // timestamp, which bulk imports produce constantly.
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(String(after.created_at), String(after.created_at), String(after.id));
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const capped = Math.max(1, Math.min(Number(limit) || 50, 500));

  const rows = db
    .get()
    .prepare(
      `SELECT * FROM items ${clause}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, capped);

  return rows.map(rowToItem);
}

/**
 * Fetch many items by id in one call. The pickers and the synthesis graph ask
 * for dozens at a time, and one IPC round trip per id would dominate the cost.
 * Order follows the ids given, so callers can rely on it.
 */
function getItems(ids = []) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!list.length) return [];

  const found = new Map();
  // SQLite caps bound parameters; chunk rather than risk a long id list.
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const holes = chunk.map(() => "?").join(",");
    const rows = db
      .get()
      .prepare(`SELECT * FROM items WHERE id IN (${holes})`)
      .all(...chunk);
    for (const row of rows) found.set(String(row.id), rowToItem(row));
  }

  return list.map((id) => found.get(id)).filter(Boolean);
}

/** Recoverable delete. Hard removal is a separate, explicit call. */
function softDeleteItem(id) {
  db.get().prepare("UPDATE items SET deleted_at = ? WHERE id = ?").run(now(), String(id));
  return { ok: true, id: String(id) };
}

function restoreItem(id) {
  db.get().prepare("UPDATE items SET deleted_at = NULL WHERE id = ?").run(String(id));
  return getItem(id);
}

/**
 * Permanently remove an item and its chunks. Returns the blob path so the
 * caller can unlink the file — the store never touches the filesystem itself.
 */
function hardDeleteItem(id) {
  return db.transaction((handle) => {
    const row = handle.prepare("SELECT blob_path, variant_thumb, variant_med FROM items WHERE id = ?").get(String(id));
    handle.prepare("DELETE FROM chunks WHERE source_kind = 'item' AND source_id = ?").run(String(id));
    handle.prepare("DELETE FROM items WHERE id = ?").run(String(id));
    return {
      ok: true,
      id: String(id),
      blobs: [row?.blob_path, row?.variant_thumb, row?.variant_med].filter(Boolean),
    };
  });
}

function countItems({ kind, includeDeleted = false } = {}) {
  const where = [];
  const params = [];
  if (!includeDeleted) where.push("deleted_at IS NULL");
  if (kind) {
    where.push("kind = ?");
    params.push(String(kind));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const row = db.get().prepare(`SELECT COUNT(*) AS n FROM items ${clause}`).get(...params);
  return Number(row?.n || 0);
}

/** Tag histogram — the local replacement for the vault_tag_counts() RPC. */
function tagCounts() {
  const rows = db
    .get()
    .prepare("SELECT tags FROM items WHERE deleted_at IS NULL AND tags IS NOT NULL")
    .all();
  const counts = new Map();
  for (const row of rows) {
    for (const tag of decodeJson(row.tags, [])) {
      const key = String(tag || "").trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ---------------------------------------------------------------------------
// Threads and messages
// ---------------------------------------------------------------------------

function putThread(input = {}) {
  const handle = db.get();
  const id = String(input.id || newId());
  const created = input.created_at || now();
  handle
    .prepare(
      `INSERT INTO threads (id, title, mode, state, origin, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         mode = excluded.mode,
         state = excluded.state,
         origin = excluded.origin,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at`,
    )
    .run(
      id,
      input.title ?? null,
      input.mode || "chat",
      encodeJson(input.state),
      input.origin ?? null,
      created,
      input.updated_at || created,
      input.deleted_at ?? null,
    );
  return getThread(id);
}

function rowToThread(row) {
  if (!row) return null;
  return { ...row, state: decodeJson(row.state, null) };
}

function getThread(id) {
  return rowToThread(db.get().prepare("SELECT * FROM threads WHERE id = ?").get(String(id)));
}

function countThreads({ includeDeleted = false } = {}) {
  const clause = includeDeleted ? "" : "WHERE deleted_at IS NULL";
  const row = db.get().prepare(`SELECT COUNT(*) AS n FROM threads ${clause}`).get();
  return Number(row?.n || 0);
}

function listThreads({ limit = 50, includeDeleted = false } = {}) {
  const clause = includeDeleted ? "" : "WHERE deleted_at IS NULL";
  return db
    .get()
    .prepare(
      `SELECT * FROM threads ${clause}
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(Number(limit) || 50, 500)))
    .map(rowToThread);
}

/**
 * Append a message. `seq` is assigned from the current tail when omitted, so
 * callers streaming a conversation do not have to track ordering.
 */
function appendMessage(threadId, input = {}) {
  return db.transaction((handle) => {
    const tid = String(threadId);
    const tail = handle
      .prepare("SELECT COALESCE(MAX(seq), -1) AS last FROM messages WHERE thread_id = ?")
      .get(tid);
    const seq = Number.isFinite(input.seq) ? Number(input.seq) : Number(tail?.last ?? -1) + 1;
    const id = String(input.id || newId());
    const created = input.created_at || now();

    handle
      .prepare(
        `INSERT INTO messages (id, thread_id, seq, role, content, blocks, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           role = excluded.role,
           content = excluded.content,
           blocks = excluded.blocks`,
      )
      .run(
        id,
        tid,
        seq,
        String(input.role || "user"),
        input.content ?? null,
        encodeJson(input.blocks),
        created,
      );

    handle.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(created, tid);
    return rowToMessage(handle.prepare("SELECT * FROM messages WHERE id = ?").get(id));
  });
}

function listMessages(threadId, { limit = 500, afterSeq } = {}) {
  const params = [String(threadId)];
  let clause = "WHERE thread_id = ?";
  if (Number.isFinite(afterSeq)) {
    clause += " AND seq > ?";
    params.push(Number(afterSeq));
  }
  const rows = db
    .get()
    .prepare(`SELECT * FROM messages ${clause} ORDER BY seq ASC LIMIT ?`)
    .all(...params, Math.max(1, Math.min(Number(limit) || 500, 5000)));
  return rows.map(rowToMessage);
}

function deleteThread(id, { hard = false } = {}) {
  const handle = db.get();
  if (!hard) {
    handle.prepare("UPDATE threads SET deleted_at = ? WHERE id = ?").run(now(), String(id));
    return { ok: true, id: String(id), hard: false };
  }
  return db.transaction((h) => {
    h.prepare("DELETE FROM chunks WHERE source_kind = 'thread' AND source_id = ?").run(String(id));
    // messages cascade via the foreign key
    h.prepare("DELETE FROM threads WHERE id = ?").run(String(id));
    return { ok: true, id: String(id), hard: true };
  });
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

function getMeta(key, fallback = null) {
  const row = db.get().prepare("SELECT v FROM meta WHERE k = ?").get(String(key));
  return row ? row.v : fallback;
}

function setMeta(key, value) {
  db.get()
    .prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(String(key), value == null ? null : String(value));
  return { ok: true };
}

module.exports = {
  putItem,
  getItem,
  getItems,
  updateItem,
  listItems,
  softDeleteItem,
  restoreItem,
  hardDeleteItem,
  countItems,
  tagCounts,
  putThread,
  getThread,
  listThreads,
  countThreads,
  appendMessage,
  listMessages,
  deleteThread,
  getMeta,
  setMeta,
  newId,
};
