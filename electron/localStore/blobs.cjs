/**
 * Binary storage for the local store — the replacement for the `user-files`
 * Supabase bucket.
 *
 * Files live beside the database rather than inside it. Keeping BLOBs out of
 * SQLite means the database file stays small enough to snapshot cheaply, and
 * the OS can memory-map and page media without going through the driver.
 *
 * Layout mirrors what the bucket used, minus the user prefix — one device,
 * one user:
 *     localStore/blobs/<item-id>/original.<ext>
 *     localStore/blobs/<item-id>/thumb.webp
 *
 * Rows store the path relative to `blobs/`, so the whole tree can be moved or
 * restored without rewriting the database.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const db = require("./db.cjs");

const BLOBS_DIRNAME = "blobs";

function blobsDir() {
  return path.join(db.storeDir(), BLOBS_DIRNAME);
}

/**
 * Resolve a stored relative path to an absolute one, refusing anything that
 * escapes the blobs directory. Paths come from the database, but the database
 * is a file the user can edit, so this stays a hard boundary.
 */
function absolutePath(relativePath) {
  const rel = String(relativePath || "");
  if (!rel) return null;
  const root = blobsDir();
  const abs = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(prefix)) return null;
  return abs;
}

function extensionFor(filename, mimeType) {
  const fromName = path.extname(String(filename || "")).replace(/^\./, "").toLowerCase();
  if (fromName) return fromName;
  const mime = String(mimeType || "").toLowerCase();
  const guess = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
  }[mime];
  return guess || "bin";
}

/**
 * Write bytes for an item and return the relative path to store on the row.
 *
 * @param {string} itemId
 * @param {Buffer|Uint8Array} data
 * @param {object} [opts]
 * @param {string} [opts.filename]  Original name, used for the extension.
 * @param {string} [opts.mimeType]  Fallback when the name has no extension.
 * @param {string} [opts.variant]   "original" (default), "thumb", "medium".
 */
async function write(itemId, data, { filename, mimeType, variant = "original" } = {}) {
  const id = String(itemId || "");
  if (!id) throw new Error("write requires an item id");

  const dir = path.join(blobsDir(), id);
  await fsp.mkdir(dir, { recursive: true });

  const ext = extensionFor(filename, mimeType);
  const name = `${variant}.${ext}`;
  const abs = path.join(dir, name);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);

  // Write to a temp name and rename: a crash mid-write leaves the previous
  // file intact rather than a truncated one the UI would try to render.
  const tmp = `${abs}.part`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, abs);

  return {
    ok: true,
    path: path.posix.join(id, name),
    bytes: bytes.byteLength,
    absolutePath: abs,
  };
}

// ---------------------------------------------------------------------------
// Streaming writes
// ---------------------------------------------------------------------------

/**
 * Open writers, keyed by an opaque token handed to the renderer.
 *
 * Uploads arrive from a renderer that cannot touch the filesystem, so the bytes
 * have to cross IPC. Sending a whole file in one message means the buffer
 * exists twice — once being serialized, once deserialized — and a phone video
 * is comfortably large enough for that to matter. Chunked writes keep the peak
 * at one chunk instead of one file.
 */
const writers = new Map();
let writerSeq = 0;

/**
 * Begin a streaming write. Bytes land in a `.part` file and only become the
 * real one on finish, so an abandoned or crashed upload cannot leave a
 * truncated file that the UI would happily try to render.
 */
async function beginWrite(itemId, { filename, mimeType, variant = "original" } = {}) {
  const id = String(itemId || "");
  if (!id) throw new Error("beginWrite requires an item id");

  const dir = path.join(blobsDir(), id);
  await fsp.mkdir(dir, { recursive: true });

  const ext = extensionFor(filename, mimeType);
  const name = `${variant}.${ext}`;
  const abs = path.join(dir, name);
  const tmp = `${abs}.part`;

  writerSeq += 1;
  const token = `w${writerSeq}-${id}-${variant}`;
  const handle = await fsp.open(tmp, "w");

  writers.set(token, {
    handle,
    tmp,
    abs,
    bytes: 0,
    relativePath: path.posix.join(id, name),
  });

  return { ok: true, token, path: path.posix.join(id, name) };
}

async function appendWrite(token, data) {
  const writer = writers.get(String(token));
  if (!writer) throw new Error("unknown write token");

  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  if (bytes.byteLength) {
    await writer.handle.write(bytes);
    writer.bytes += bytes.byteLength;
  }
  return { ok: true, bytes: writer.bytes };
}

async function finishWrite(token) {
  const key = String(token);
  const writer = writers.get(key);
  if (!writer) throw new Error("unknown write token");

  writers.delete(key);
  await writer.handle.close();
  await fsp.rename(writer.tmp, writer.abs);

  return {
    ok: true,
    path: writer.relativePath,
    bytes: writer.bytes,
    absolutePath: writer.abs,
  };
}

/** Give up on a write and remove the partial file. Never throws. */
async function abortWrite(token) {
  const key = String(token);
  const writer = writers.get(key);
  if (!writer) return { ok: true };

  writers.delete(key);
  try {
    await writer.handle.close();
  } catch {
    /* already closed */
  }
  try {
    await fsp.rm(writer.tmp, { force: true });
  } catch {
    /* nothing to remove */
  }
  return { ok: true };
}

/** Drop every open writer — used on shutdown so no `.part` files survive. */
async function closeWriters() {
  const tokens = [...writers.keys()];
  await Promise.all(tokens.map((token) => abortWrite(token)));
  return { ok: true, aborted: tokens.length };
}

async function read(relativePath) {
  const abs = absolutePath(relativePath);
  if (!abs) throw new Error("blob path escapes the store");
  return fsp.readFile(abs);
}

function existsSync(relativePath) {
  const abs = absolutePath(relativePath);
  return abs ? fs.existsSync(abs) : false;
}

async function stat(relativePath) {
  const abs = absolutePath(relativePath);
  if (!abs) return null;
  try {
    const info = await fsp.stat(abs);
    return { bytes: info.size, modifiedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Remove one file. Missing files are not an error — deletion is idempotent. */
async function remove(relativePath) {
  const abs = absolutePath(relativePath);
  if (!abs) return { ok: false, error: "blob path escapes the store" };
  try {
    await fsp.rm(abs, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || "remove failed" };
  }
}

/** Remove every variant for an item, then the directory itself. */
async function removeAllForItem(itemId) {
  const dir = absolutePath(String(itemId || ""));
  if (!dir) return { ok: false, error: "invalid item id" };
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || "remove failed" };
  }
}

/**
 * Total bytes on disk, for the storage readout in settings.
 */
async function totalBytes() {
  const root = blobsDir();
  let total = 0;
  let files = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const info = await fsp.stat(full);
          total += info.size;
          files += 1;
        } catch {
          /* file vanished mid-walk */
        }
      }
    }
  }

  await walk(root);
  return { bytes: total, files };
}

/**
 * Find blob directories with no surviving row, and rows pointing at missing
 * files. The local equivalent of jobs/vaultReconcilerJob.js, minus the network.
 */
async function findOrphans() {
  const rows = db.get().prepare("SELECT id, blob_path FROM items WHERE blob_path IS NOT NULL").all();
  const known = new Set(rows.map((r) => String(r.id)));

  const missingFiles = [];
  for (const row of rows) {
    if (!existsSync(row.blob_path)) missingFiles.push({ id: row.id, path: row.blob_path });
  }

  const orphanDirs = [];
  try {
    const entries = await fsp.readdir(blobsDir(), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !known.has(entry.name)) orphanDirs.push(entry.name);
    }
  } catch {
    /* no blobs directory yet */
  }

  return { missingFiles, orphanDirs };
}

/** How long an unsaved generation is kept before the sweep collects it. */
const GENERATION_TTL_DAYS = 30;

/**
 * Collect generated images nobody kept.
 *
 * Imagine writes four images per prompt and the user saves at most one, so
 * without this the store grows by every variation ever rendered. A saved image
 * is no longer `kind = 'generation'` — saving promotes the row in place — so
 * the sweep can key on kind alone and never has to reason about references.
 *
 * Age is the only other guard, and it has to be generous: the chat turn that
 * shows a generation is stored in the cloud, not in the local `messages`
 * table, so there is nothing on this device that says "still on screen". A
 * long window is what keeps the sweep from deleting an image out from under a
 * conversation the user still has open.
 */
async function pruneGenerations({ olderThanDays = GENERATION_TTL_DAYS } = {}) {
  const days = Math.max(0, Number(olderThanDays));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const doomed = db
    .get()
    .prepare(
      `SELECT id FROM items
        WHERE kind = 'generation'
          AND COALESCE(updated_at, created_at) < ?`,
    )
    .all(cutoff);

  let removed = 0;
  for (const row of doomed) {
    const id = String(row.id);
    // Files first: a row without its blob is invisible garbage, whereas a blob
    // without its row is what findOrphans is for.
    const gone = await removeAllForItem(id);
    if (!gone.ok) continue;
    db.get().prepare("DELETE FROM chunks WHERE source_kind = 'item' AND source_id = ?").run(id);
    db.get().prepare("DELETE FROM index_state WHERE source_kind = 'item' AND source_id = ?").run(id);
    db.get().prepare("DELETE FROM items WHERE id = ?").run(id);
    removed += 1;
  }

  return { removed, examined: doomed.length, cutoff };
}

module.exports = {
  blobsDir,
  absolutePath,
  extensionFor,
  write,
  beginWrite,
  appendWrite,
  finishWrite,
  abortWrite,
  closeWriters,
  read,
  stat,
  existsSync,
  remove,
  removeAllForItem,
  totalBytes,
  findOrphans,
  pruneGenerations,
  BLOBS_DIRNAME,
  GENERATION_TTL_DAYS,
};
