/**
 * One-way migration: Supabase → this device.
 *
 * Reads the user's vault items, their files, and their chat history out of the
 * cloud and writes them into the local store. Nothing is ever written back;
 * cloudSource.cjs refuses any method but GET and HEAD, so a bug here cannot
 * damage the account this is reading from.
 *
 * Three properties matter more than speed, because this runs once against data
 * the user cannot re-create:
 *
 *   Resumable. Progress is committed per page and the cursor only advances
 *   after that page's rows *and* files are on disk. Quitting mid-migration
 *   costs one page, and re-running skips everything already present.
 *
 *   Idempotent. Rows upsert by their cloud id, so identity survives and a
 *   second run is a no-op rather than a duplicate vault.
 *
 *   Honest. A row whose file 404s is recorded as missing rather than silently
 *   imported pointing at nothing, and `verify()` re-reads both sides afterwards
 *   instead of trusting the counters this module kept while running.
 *
 * Embeddings are not migrated. The cloud vectors are 1536-dimensional OpenAI
 * ones and the local model produces 384; they are not interchangeable. Imported
 * rows simply arrive with no `index_state`, which is exactly what the Phase 2
 * backfill looks for, so retrieval rebuilds itself locally afterwards.
 */

const { EventEmitter } = require("node:events");
const path = require("node:path");

const store = require("./store.cjs");
const blobs = require("./blobs.cjs");
const search = require("./search.cjs");
const indexer = require("./indexer.cjs");
const cloud = require("./cloudSource.cjs");
const map = require("./importMap.cjs");
const db = require("./db.cjs");

const events = new EventEmitter();

const VAULT_TABLE = "vault_items";
const CHATS_TABLE = "lykn_chats";
const CHAT_STATES_TABLE = "lykn_chat_states";

const CURSOR_ITEMS = "import_cursor_items";
const CURSOR_CHATS = "import_cursor_chats";
const LAST_RUN = "import_last_run_at";

const PAGE_SIZE = 200;

const now = () => new Date().toISOString();

let run = null;
let controller = null;

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function freshRun(options) {
  return {
    startedAt: now(),
    finishedAt: null,
    phase: "preflight",
    dryRun: options.dryRun === true,
    cancelled: false,
    error: null,
    items: { seen: 0, imported: 0, failed: 0, total: 0 },
    blobs: { downloaded: 0, skipped: 0, missing: 0, failed: 0, bytes: 0 },
    chats: { seen: 0, imported: 0, failed: 0, total: 0, messages: 0 },
  };
}

function status() {
  return {
    running: Boolean(run && !run.finishedAt),
    configured: cloud.isConfigured(),
    lastRunAt: store.getMeta(LAST_RUN, null),
    resumable: Boolean(store.getMeta(CURSOR_ITEMS, null) || store.getMeta(CURSOR_CHATS, null)),
    ...(run || freshRun({})),
  };
}

function emit() {
  events.emit("progress", status());
}

function cancel() {
  if (run) run.cancelled = true;
  controller?.abort();
  return status();
}

function readCursor(key) {
  const raw = store.getMeta(key, null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.created_at && parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

function writeCursor(key, row) {
  if (!row?.created_at || !row?.id) return;
  store.setMeta(key, JSON.stringify({ created_at: row.created_at, id: row.id }));
}

/** Forget where the last run got to, so the next one starts from the top. */
function resetProgress() {
  store.setMeta(CURSOR_ITEMS, null);
  store.setMeta(CURSOR_CHATS, null);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Check the credentials and report how much there is to move, without
 * importing anything. This is what the UI should show before asking the user
 * to commit to a migration.
 */
async function preflight() {
  const access = await cloud.checkAccess();
  if (!access.ok) return { ok: false, reason: access.reason || "access check failed", access };

  const [items, chats] = await Promise.all([
    cloud.count(VAULT_TABLE),
    cloud.count(CHATS_TABLE),
  ]);

  const local = {
    items: store.countItems(),
    imported: Number(
      db.get().prepare("SELECT COUNT(*) AS n FROM items WHERE origin = ?").get(map.ORIGIN)?.n || 0,
    ),
    threads: store.countThreads(),
  };

  return {
    ok: true,
    access: { userId: access.userId, email: access.email },
    cloud: { items, chats },
    local,
    resumable: Boolean(readCursor(CURSOR_ITEMS) || readCursor(CURSOR_CHATS)),
  };
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

/**
 * Where a downloaded object will land. Computed the same way blobs.write()
 * names it, so an interrupted run can tell what it already has without keeping
 * a manifest.
 */
function expectedLocalPath(itemId, spec, mimeType) {
  const filename = String(spec.path).split("/").pop() || "";
  const ext = blobs.extensionFor(filename, mimeType);
  return path.posix.join(String(itemId), `${spec.variant}.${ext}`);
}

/**
 * Fetch every file for one item and return the patch that repoints the row at
 * this device — both the normalized columns and the `[ATTACHMENTS_JSON:…]`
 * marker inside `content`, which is what the vault UI actually reads.
 *
 * Missing objects are counted and skipped: a 404 means the row outlived its
 * upload, which is a pre-existing condition in the cloud data rather than a
 * failure of the migration. Those attachments keep their cloud paths so the
 * gap stays visible instead of being rewritten into a local path with no file.
 */
async function importBlobsFor(item, specs, { dryRun, signal }) {
  const patch = {};
  const localByKey = new Map();
  const bucket = specs[0]?.bucket || "user-files";

  for (const spec of specs) {
    if (run?.cancelled) break;

    const local = expectedLocalPath(item.id, spec, item.mime_type);

    if (blobs.existsSync(local)) {
      localByKey.set(spec.key, local);
      run.blobs.skipped += 1;
    } else if (dryRun) {
      run.blobs.downloaded += 1;
      continue;
    } else {
      try {
        const bytes = await cloud.downloadObject(spec.bucket, spec.path, { signal });
        if (!bytes) {
          run.blobs.missing += 1;
          continue;
        }
        const written = await blobs.write(item.id, bytes, {
          filename: String(spec.path).split("/").pop(),
          mimeType: item.mime_type,
          variant: spec.variant,
        });
        localByKey.set(spec.key, written.path);
        run.blobs.downloaded += 1;
        run.blobs.bytes += written.bytes;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        run.blobs.failed += 1;
        console.error(`[LYKN] blob ${spec.path} failed:`, err?.message);
        continue;
      }
    }

    // One downloaded file can satisfy both a column and a marker entry.
    for (const target of spec.targets) {
      if (target.type === "column") patch[target.field] = localByKey.get(spec.key);
    }
  }

  if (localByKey.size && item.content) {
    const rewritten = map.localizeAttachments(item.content, localByKey, bucket);
    if (rewritten !== item.content) patch.content = rewritten;
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function importItems({ dryRun, includeBlobs, signal }) {
  run.phase = "items";
  let cursor = readCursor(CURSOR_ITEMS);

  for (;;) {
    if (run.cancelled) return;

    const rows = await cloud.page(VAULT_TABLE, { after: cursor, limit: PAGE_SIZE, signal });
    if (!rows.length) return;

    for (const row of rows) {
      if (run.cancelled) return;
      run.items.seen += 1;

      try {
        const { item, blobs: specs } = map.mapVaultItem(row);

        if (dryRun) {
          run.items.imported += 1;
          if (includeBlobs && specs.length) {
            await importBlobsFor(item, specs, { dryRun, signal });
          }
          continue;
        }

        // The row lands first, without file paths. If the download half fails
        // the note still exists locally with its text — the part that cannot
        // be re-fetched from anywhere else.
        store.putItem(item);

        if (includeBlobs && specs.length) {
          const patch = await importBlobsFor(item, specs, { dryRun, signal });
          if (Object.keys(patch).length) store.updateItem(item.id, patch);
        }

        run.items.imported += 1;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        run.items.failed += 1;
        console.error(`[LYKN] import item ${row?.id} failed:`, err?.message);
      }
    }

    // Only now is the page genuinely done, files included.
    cursor = { created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id };
    if (!dryRun) writeCursor(CURSOR_ITEMS, cursor);
    emit();

    if (rows.length < PAGE_SIZE) return;
  }
}

async function importChats({ dryRun, signal }) {
  run.phase = "chats";
  let cursor = readCursor(CURSOR_CHATS);

  for (;;) {
    if (run.cancelled) return;

    const rows = await cloud.page(CHATS_TABLE, { after: cursor, limit: PAGE_SIZE, signal });
    if (!rows.length) return;

    // The conversation lives in a sibling table; fetch the whole page's worth
    // in one request rather than one per chat.
    const states = await cloud.byIds(
      CHAT_STATES_TABLE,
      "chat_id",
      rows.map((r) => r.id),
      { signal },
    );
    const stateById = new Map(states.map((s) => [String(s.chat_id), s]));

    for (const row of rows) {
      if (run.cancelled) return;
      run.chats.seen += 1;

      try {
        const { thread, messages } = map.mapChat(row, stateById.get(String(row.id)) || null);

        if (!dryRun) {
          store.putThread(thread);
          for (const message of messages) store.appendMessage(thread.id, message);
          // appendMessage advances the thread's updated_at to the message's
          // timestamp, which for imported chats is synthesized. Re-writing the
          // thread restores the real cloud value so the sidebar keeps its
          // original ordering.
          if (messages.length) store.putThread(thread);
        }

        run.chats.imported += 1;
        run.chats.messages += messages.length;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        run.chats.failed += 1;
        console.error(`[LYKN] import chat ${row?.id} failed:`, err?.message);
      }
    }

    cursor = { created_at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id };
    if (!dryRun) writeCursor(CURSOR_CHATS, cursor);
    emit();

    if (rows.length < PAGE_SIZE) return;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Start a migration. Returns as soon as the run is scheduled; poll `status()`
 * or listen on `events` for progress.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]       Read and count, write nothing.
 * @param {boolean} [options.includeBlobs=true]  Download files as well as rows.
 * @param {boolean} [options.includeChats=true]
 * @param {boolean} [options.reindex=true]       Build embeddings when done.
 * @param {boolean} [options.restart=false]      Ignore a saved cursor.
 */
async function start(options = {}) {
  if (run && !run.finishedAt) return status();
  if (!cloud.isConfigured()) return { ...status(), error: "cloud source is not configured" };

  const {
    dryRun = false,
    includeBlobs = true,
    includeChats = true,
    reindex = true,
    restart = false,
  } = options;

  if (restart) resetProgress();

  const check = await cloud.checkAccess();
  if (!check.ok) return { ...status(), error: check.reason || "access check failed" };

  run = freshRun({ dryRun });
  controller = new AbortController();
  const signal = controller.signal;

  const [itemTotal, chatTotal] = await Promise.all([
    cloud.count(VAULT_TABLE).catch(() => 0),
    includeChats ? cloud.count(CHATS_TABLE).catch(() => 0) : Promise.resolve(0),
  ]);
  run.items.total = itemTotal;
  run.chats.total = chatTotal;
  emit();

  (async () => {
    try {
      await importItems({ dryRun, includeBlobs, signal });
      if (includeChats && !run.cancelled) await importChats({ dryRun, signal });

      if (!run.cancelled && !dryRun) {
        store.setMeta(LAST_RUN, now());
        // Imported rows have no vectors — the cloud's are a different model and
        // a different width. Hand them to the local embedder.
        search.invalidateCache();
        if (reindex) {
          indexer.backfill().catch((err) => {
            console.error("[LYKN] post-import backfill failed:", err?.message);
          });
        }
      }
    } catch (err) {
      if (err?.name === "AbortError" || run.cancelled) {
        run.cancelled = true;
      } else {
        run.error = err?.message || String(err);
        console.error("[LYKN] import failed:", run.error);
      }
    } finally {
      run.phase = run.cancelled ? "cancelled" : "done";
      run.finishedAt = now();
      controller = null;
      emit();
      events.emit("done", status());
    }
  })();

  return status();
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Re-read both sides and report what did not make it.
 *
 * Deliberately independent of the counters the run kept: those describe what
 * the importer believes it did, and the point of verifying is to catch the
 * cases where that belief is wrong.
 *
 * @param {object} [opts]
 * @param {number} [opts.sampleLimit=200] Cap on ids listed back per category.
 */
async function verify({ sampleLimit = 200, signal } = {}) {
  const missingItems = [];
  const missingBlobs = [];
  let cloudItems = 0;

  const localIds = new Set(
    db.get().prepare("SELECT id FROM items").all().map((r) => String(r.id)),
  );

  for await (const rows of cloud.pages(VAULT_TABLE, {
    limit: PAGE_SIZE,
    select: "id,created_at,storage_path,variant_medium_path,variant_thumb_path,storage_bucket,mime_type",
    signal,
  })) {
    for (const row of rows) {
      cloudItems += 1;
      const id = String(row.id);
      if (!localIds.has(id)) {
        if (missingItems.length < sampleLimit) missingItems.push(id);
        continue;
      }
      const { item, blobs: specs } = map.mapVaultItem(row);
      for (const spec of specs) {
        if (blobs.existsSync(expectedLocalPath(id, spec, item.mime_type))) continue;
        if (missingBlobs.length < sampleLimit) missingBlobs.push({ id, path: spec.path });
      }
    }
  }

  const cloudChats = await cloud.count(CHATS_TABLE).catch(() => 0);
  const localChats = store.countThreads();

  return {
    ok: missingItems.length === 0 && missingBlobs.length === 0,
    items: { cloud: cloudItems, local: localIds.size, missing: missingItems.length },
    blobs: { missing: missingBlobs.length },
    chats: { cloud: cloudChats, local: localChats },
    missingItems,
    missingBlobs,
    truncated: missingItems.length >= sampleLimit || missingBlobs.length >= sampleLimit,
  };
}

module.exports = {
  events,
  configure: cloud.configure,
  isConfigured: cloud.isConfigured,
  preflight,
  start,
  status,
  cancel,
  verify,
  resetProgress,
  expectedLocalPath,
  VAULT_TABLE,
  CHATS_TABLE,
  CHAT_STATES_TABLE,
};
