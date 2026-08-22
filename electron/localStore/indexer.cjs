/**
 * Keeps the retrieval index in step with what the user has saved.
 *
 * This is the on-device replacement for the reindex bridge
 * (src/lib/synthesis/queueReindex.ts) and the server's embed-and-store path:
 * row in, text out, chunked, embedded, written to `chunks`. The difference is
 * that nothing is queued to a backend — it happens locally, and the whole
 * corpus can be rebuilt at any time because the model is on the machine.
 *
 * Two things every call goes through:
 *   - `index_state` records the attempt, including attempts that legitimately
 *     produce nothing, so "how much is left to index" has a truthful answer.
 *   - The text is hashed. Re-saving a note without changing its words is the
 *     common case in an editor with autosave, and it must not re-embed.
 */

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const db = require("./db.cjs");
const store = require("./store.cjs");
const search = require("./search.cjs");
const chunker = require("./chunker.cjs");
const sourceText = require("./sourceText.cjs");
const embedder = require("./embedder.cjs");

const events = new EventEmitter();

const now = () => new Date().toISOString();

function hashText(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

// ---------------------------------------------------------------------------
// index_state
// ---------------------------------------------------------------------------

function getState(sourceKind, sourceId) {
  return (
    db
      .get()
      .prepare("SELECT * FROM index_state WHERE source_kind = ? AND source_id = ?")
      .get(String(sourceKind), String(sourceId)) || null
  );
}

function setState(sourceKind, sourceId, { model, textHash, chunkCount }) {
  db.get()
    .prepare(
      `INSERT INTO index_state (source_kind, source_id, model, text_hash, chunk_count, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_kind, source_id) DO UPDATE SET
         model = excluded.model,
         text_hash = excluded.text_hash,
         chunk_count = excluded.chunk_count,
         indexed_at = excluded.indexed_at`,
    )
    .run(
      String(sourceKind),
      String(sourceId),
      String(model),
      textHash == null ? null : String(textHash),
      Number(chunkCount || 0),
      now(),
    );
}

function clearState(sourceKind, sourceId) {
  db.get()
    .prepare("DELETE FROM index_state WHERE source_kind = ? AND source_id = ?")
    .run(String(sourceKind), String(sourceId));
}

// ---------------------------------------------------------------------------
// Source text
// ---------------------------------------------------------------------------

/** Build the embeddable text and per-chunk context prefix for one row. */
function resolveSource(sourceKind, sourceId) {
  if (sourceKind === "item") {
    const item = store.getItem(sourceId);
    if (!item || item.deleted_at) return null;
    return { text: sourceText.itemText(item), prefix: sourceText.contextPrefix(item) };
  }
  if (sourceKind === "thread") {
    const thread = store.getThread(sourceId);
    if (!thread || thread.deleted_at) return null;
    const messages = store.listMessages(sourceId, { limit: 5000 });
    return {
      text: sourceText.threadText(thread, messages),
      prefix: thread.title ? `Conversation: ${thread.title}` : "",
    };
  }
  throw new Error(`unknown source kind: ${sourceKind}`);
}

/**
 * Situate each chunk before embedding. The stored `text` stays raw so the UI
 * can quote it verbatim; only the vector sees the prefix.
 */
function withContext(chunks, prefix) {
  if (!prefix || chunks.length <= 1) return chunks.slice();
  return chunks.map((c) => (c.startsWith(prefix) ? c : `${prefix}\n\n${c}`));
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Bring one source's vectors up to date.
 *
 * @param {"item"|"thread"} sourceKind
 * @param {string} sourceId
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] Re-embed even if the text is unchanged.
 * @returns {Promise<{ok: boolean, status: string, chunks?: number, reason?: string}>}
 */
async function indexSource(sourceKind, sourceId, { force = false } = {}) {
  const id = String(sourceId || "");
  if (!id) return { ok: false, status: "skipped", reason: "missing id" };

  const resolved = resolveSource(sourceKind, id);
  if (!resolved) {
    // Deleted between being queued and being picked up.
    search.deleteChunks(sourceKind, id);
    clearState(sourceKind, id);
    return { ok: true, status: "removed" };
  }

  const model = embedder.MODEL_TAG;
  const textHash = hashText(resolved.text);
  const state = getState(sourceKind, id);

  if (!force && state && state.model === model && state.text_hash === textHash) {
    return { ok: true, status: "unchanged", chunks: Number(state.chunk_count || 0) };
  }

  const chunks = chunker.chunkText(resolved.text);
  if (!chunks.length) {
    // Nothing embeddable — an image with no description yet, or an empty note.
    // Record it so the backfill stops considering it outstanding.
    search.deleteChunks(sourceKind, id);
    setState(sourceKind, id, { model, textHash, chunkCount: 0 });
    return { ok: true, status: "empty", chunks: 0 };
  }

  if (!(await embedder.isAvailable())) {
    const { reason } = await embedder.status();
    return { ok: false, status: "unavailable", reason: reason || "no local embedding runtime" };
  }

  const vectors = await embedder.embedPassages(withContext(chunks, resolved.prefix));
  if (vectors.length !== chunks.length) {
    throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`);
  }

  search.putChunks(
    sourceKind,
    id,
    chunks.map((text, i) => ({ text, embedding: vectors[i] })),
    model,
  );
  setState(sourceKind, id, { model, textHash, chunkCount: chunks.length });

  events.emit("indexed", { sourceKind, sourceId: id, chunks: chunks.length });
  return { ok: true, status: "indexed", chunks: chunks.length };
}

const indexItem = (id, opts) => indexSource("item", id, opts);
const indexThread = (id, opts) => indexSource("thread", id, opts);

/** Forget a source entirely — used when a row is hard-deleted. */
function removeSource(sourceKind, sourceId) {
  search.deleteChunks(sourceKind, sourceId);
  clearState(sourceKind, sourceId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Rows whose vectors are missing, stale, or built by a different model.
 *
 * The timestamp comparison is a pre-filter, not the decision: it can select a
 * row whose text did not really change, and `indexSource` will notice the hash
 * matches and skip the expensive part.
 */
function pendingSources({ kind = "item", limit = 500 } = {}) {
  const model = embedder.MODEL_TAG;
  const capped = Math.max(1, Math.min(Number(limit) || 500, 5000));

  if (kind === "thread") {
    return db
      .get()
      .prepare(
        `SELECT t.id AS source_id, 'thread' AS source_kind
           FROM threads t
           LEFT JOIN index_state s
             ON s.source_kind = 'thread' AND s.source_id = t.id
          WHERE t.deleted_at IS NULL
            AND (s.source_id IS NULL
                 OR s.model <> ?
                 OR s.indexed_at < COALESCE(t.updated_at, t.created_at))
          ORDER BY COALESCE(t.updated_at, t.created_at) DESC
          LIMIT ?`,
      )
      .all(model, capped);
  }

  return db
    .get()
    .prepare(
      `SELECT i.id AS source_id, 'item' AS source_kind
         FROM items i
         LEFT JOIN index_state s
           ON s.source_kind = 'item' AND s.source_id = i.id
        WHERE i.deleted_at IS NULL
          AND (s.source_id IS NULL
               OR s.model <> ?
               OR s.indexed_at < COALESCE(i.updated_at, i.created_at))
        ORDER BY i.created_at DESC
        LIMIT ?`,
    )
    .all(model, capped);
}

function pendingCount() {
  const model = embedder.MODEL_TAG;
  const items = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM items i
         LEFT JOIN index_state s
           ON s.source_kind = 'item' AND s.source_id = i.id
        WHERE i.deleted_at IS NULL
          AND (s.source_id IS NULL
               OR s.model <> ?
               OR s.indexed_at < COALESCE(i.updated_at, i.created_at))`,
    )
    .get(model);
  const threads = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM threads t
         LEFT JOIN index_state s
           ON s.source_kind = 'thread' AND s.source_id = t.id
        WHERE t.deleted_at IS NULL
          AND (s.source_id IS NULL
               OR s.model <> ?
               OR s.indexed_at < COALESCE(t.updated_at, t.created_at))`,
    )
    .get(model);
  return { items: Number(items?.n || 0), threads: Number(threads?.n || 0) };
}

/** Live backfill state, polled by the settings UI. */
let run = null;

function backfillStatus() {
  const pending = pendingCount();
  return {
    running: Boolean(run && !run.finishedAt),
    model: embedder.MODEL_TAG,
    done: run?.done || 0,
    total: run?.total || 0,
    failed: run?.failed || 0,
    startedAt: run?.startedAt || null,
    finishedAt: run?.finishedAt || null,
    error: run?.error || null,
    pending,
    remaining: pending.items + pending.threads,
  };
}

function cancelBackfill() {
  if (run) run.cancelled = true;
  return backfillStatus();
}

/**
 * Embed everything outstanding, oldest work first, in the background.
 *
 * Resumable by construction: progress is committed per source, so quitting
 * mid-pass costs at most one source's work and the next start picks up where
 * this one stopped.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeThreads=true]
 * @param {number} [opts.maxSources] Stop after this many (used by tests).
 */
async function backfill({ includeThreads = true, maxSources = Infinity } = {}) {
  if (run && !run.finishedAt) return backfillStatus();

  if (!(await embedder.isAvailable())) {
    const { reason } = await embedder.status();
    return { ...backfillStatus(), running: false, error: reason || "no local embedding runtime" };
  }

  const counts = pendingCount();
  run = {
    startedAt: now(),
    finishedAt: null,
    done: 0,
    failed: 0,
    total: Math.min(counts.items + (includeThreads ? counts.threads : 0), maxSources),
    cancelled: false,
    error: null,
  };
  events.emit("backfill:start", backfillStatus());

  (async () => {
    try {
      const kinds = includeThreads ? ["item", "thread"] : ["item"];
      for (const kind of kinds) {
        // Re-query each batch: the previous one changed index_state, and the
        // user may have saved more while this was running.
        for (;;) {
          if (run.cancelled || run.done >= maxSources) break;
          const batch = pendingSources({ kind, limit: 50 });
          if (!batch.length) break;

          for (const row of batch) {
            if (run.cancelled || run.done >= maxSources) break;
            try {
              await indexSource(kind, row.source_id);
            } catch (err) {
              run.failed += 1;
              console.error(`[LYKN] index ${kind} ${row.source_id} failed:`, err?.message);
            }
            run.done += 1;
            events.emit("backfill:progress", backfillStatus());
          }
        }
      }
    } catch (err) {
      run.error = err?.message || String(err);
      console.error("[LYKN] backfill failed:", run.error);
    } finally {
      run.finishedAt = now();
      store.setMeta("last_backfill_at", run.finishedAt);
      events.emit("backfill:done", backfillStatus());
    }
  })();

  return backfillStatus();
}

/**
 * Retrieval with a locally embedded query.
 *
 * Falls back to lexical-only whenever the query cannot be embedded — no model
 * on this platform, still loading, or a transient failure. Degraded search is
 * always better than an error dialog.
 */
async function searchLocal(query, opts = {}) {
  const queryEmbedding = await embedder.tryEmbedQuery(query);
  return search.hybridSearch(query, { ...opts, queryEmbedding });
}

module.exports = {
  events,
  indexSource,
  indexItem,
  indexThread,
  removeSource,
  pendingSources,
  pendingCount,
  backfill,
  backfillStatus,
  cancelBackfill,
  searchLocal,
  getState,
  setState,
  clearState,
  hashText,
  withContext,
  resolveSource,
};
