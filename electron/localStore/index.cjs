/**
 * Local store facade — the single entry point the Electron main process uses.
 *
 * Everything on-device lives behind this module: vault items, chat threads and
 * messages, generated artifacts, the retrieval index, and binaries. The
 * renderer reaches it only over IPC (`lykn:store-run`), because the app window
 * loads a remote origin and has no filesystem access of its own.
 *
 * Operations are dispatched by name through `run()`, matching how
 * localSystem.cjs exposes its tools, so main.cjs needs one handler rather than
 * one per method.
 */

const db = require("./db.cjs");
const store = require("./store.cjs");
const search = require("./search.cjs");
const blobs = require("./blobs.cjs");
const backup = require("./backup.cjs");
const embedder = require("./embedder.cjs");
const indexer = require("./indexer.cjs");
const importer = require("./importer.cjs");
const apps = require("./apps.cjs");

let ready = false;

/**
 * Open the store and start the snapshot timer. Call once at app startup.
 * @param {string} userDataPath app.getPath("userData")
 */
function configure(userDataPath) {
  if (ready) return { ok: true, alreadyOpen: true, path: db.dbPath() };
  db.open(userDataPath);
  backup.start();
  // The model is not loaded here — that costs ~400 MB and most launches never
  // search. embedder.js spawns its worker on first use and drops it when idle.
  embedder.configure({ userDataPath });
  ready = true;
  return { ok: true, path: db.dbPath(), version: db.LATEST_VERSION };
}

/**
 * Close the store. Stays synchronous on purpose: it runs from `will-quit`,
 * which does not await, and the WAL checkpoint in `db.close()` has to finish
 * before the process goes away. `embedder.shutdown()` kills its worker
 * synchronously and only returns a promise for the non-Electron path, so it is
 * deliberately not awaited here.
 */
function shutdown() {
  if (!ready) return;
  backup.stop();
  embedder.shutdown();
  // Uploads in flight have a `.part` file open; drop them rather than leaving
  // debris behind for the next launch to wonder about.
  blobs.closeWriters().catch(() => {});
  db.close();
  ready = false;
}

function isReady() {
  return ready;
}

/** Counts and sizes for the settings storage readout. */
async function stats() {
  const [blobTotals, orphans, embedStatus] = await Promise.all([
    blobs.totalBytes(),
    blobs.findOrphans(),
    embedder.status(),
  ]);
  return {
    ok: true,
    path: db.dbPath(),
    schemaVersion: db.LATEST_VERSION,
    items: store.countItems(),
    vaultItems: store.countItems({ kind: "vault" }),
    threads: store.countThreads(),
    apps: apps.listApps().length,
    chunks: search.chunkStats(),
    blobs: blobTotals,
    orphans: { files: orphans.missingFiles.length, directories: orphans.orphanDirs.length },
    lastSnapshotAt: store.getMeta("last_snapshot_at", null),
    embedding: embedStatus,
    indexing: indexer.backfillStatus(),
  };
}

/**
 * Delete an item, its chunks, and its files in one call — the common path the
 * vault UI needs, and the one place ordering matters.
 */
async function deleteItemCompletely(id) {
  const result = store.hardDeleteItem(id);
  indexer.removeSource("item", id);
  search.invalidateCache();
  await blobs.removeAllForItem(id);
  return result;
}

/**
 * Save an item and index it. The write is committed before embedding starts,
 * so a slow or unavailable model can never block the user's save — the row is
 * durable either way and the backfill will pick up anything that failed here.
 */
async function saveAndIndexItem(item = {}) {
  const saved = store.putItem(item);
  try {
    await indexer.indexItem(saved.id);
  } catch (err) {
    console.error("[LYKN] index after save failed:", err?.message);
  }
  return saved;
}

/** Named operations reachable from the renderer. */
const OPERATIONS = {
  // items
  "item.put": (a) => store.putItem(a?.item || {}),
  "item.save": (a) => saveAndIndexItem(a?.item || {}),
  "item.get": (a) => store.getItem(a?.id),
  "item.getMany": (a) => store.getItems(a?.ids || []),
  "item.update": (a) =>
    store.updateItem(a?.id, a?.patch || {}, { ifUpdatedAt: a?.ifUpdatedAt || null }),
  "item.list": (a) => store.listItems(a || {}),
  "item.softDelete": (a) => store.softDeleteItem(a?.id),
  "item.restore": (a) => store.restoreItem(a?.id),
  "item.delete": (a) => deleteItemCompletely(a?.id),
  "item.count": (a) => store.countItems(a || {}),
  "item.tagCounts": () => store.tagCounts(),

  // threads + messages
  "thread.put": (a) => store.putThread(a?.thread || {}),
  "thread.get": (a) => store.getThread(a?.id),
  "thread.list": (a) => store.listThreads(a || {}),
  "thread.count": (a) => store.countThreads(a || {}),
  "thread.delete": (a) => store.deleteThread(a?.id, { hard: a?.hard === true }),
  "message.append": (a) => store.appendMessage(a?.threadId, a?.message || {}),
  "message.list": (a) => store.listMessages(a?.threadId, a || {}),

  // retrieval
  "search.lexical": (a) => search.lexicalSearch(a?.query, a || {}),
  "search.semantic": (a) => search.semanticSearch(a?.embedding, a || {}),
  "search.hybrid": (a) => search.hybridSearch(a?.query, a || {}),
  // The one the UI should call: embeds the query on-device, then fuses.
  "search.local": (a) => indexer.searchLocal(a?.query, a || {}),
  "search.messages": (a) => search.searchMessages(a?.query, a || {}),
  "chunks.put": (a) => search.putChunks(a?.sourceKind, a?.sourceId, a?.chunks || [], a?.model),
  "chunks.delete": (a) => search.deleteChunks(a?.sourceKind, a?.sourceId),
  "chunks.stale": (a) => search.staleSources(a?.model),
  "chunks.stats": () => search.chunkStats(),

  // embedding + indexing
  "embed.status": () => embedder.status(),
  "embed.warmup": () => embedder.warmup(),
  "embed.query": async (a) => {
    const vec = await embedder.embedQuery(a?.text);
    // Float32Array does not survive Electron's IPC serialization intact;
    // hand the renderer a plain array.
    return vec ? Array.from(vec) : null;
  },
  "index.item": (a) => indexer.indexItem(a?.id, { force: a?.force === true }),
  "index.thread": (a) => indexer.indexThread(a?.id, { force: a?.force === true }),
  "index.remove": (a) => indexer.removeSource(a?.sourceKind || "item", a?.sourceId || a?.id),
  "index.pending": () => indexer.pendingCount(),
  "index.backfill": (a) => indexer.backfill(a || {}),
  "index.status": () => indexer.backfillStatus(),
  "index.cancel": () => indexer.cancelBackfill(),

  // Migration from Supabase. Read-only against the cloud, so it is safe to
  // point at the production project — that is where the user's data is.
  "import.configure": (a) =>
    importer.configure({
      url: a?.url,
      accessToken: a?.accessToken,
      apiKey: a?.apiKey,
      userId: a?.userId,
    }),
  "import.preflight": () => importer.preflight(),
  "import.start": (a) => importer.start(a || {}),
  "import.status": () => importer.status(),
  "import.cancel": () => importer.cancel(),
  "import.verify": (a) => importer.verify(a || {}),
  "import.reset": () => importer.resetProgress(),

  // blobs
  "blob.write": (a) =>
    blobs.write(a?.itemId, a?.data, {
      filename: a?.filename,
      mimeType: a?.mimeType,
      variant: a?.variant,
    }),
  // Chunked upload path. The renderer holds the file; these move it across in
  // pieces so a large video never exists twice in memory at once.
  "blob.beginWrite": (a) =>
    blobs.beginWrite(a?.itemId, {
      filename: a?.filename,
      mimeType: a?.mimeType,
      variant: a?.variant,
    }),
  "blob.appendWrite": (a) => blobs.appendWrite(a?.token, a?.data),
  "blob.finishWrite": (a) => blobs.finishWrite(a?.token),
  "blob.abortWrite": (a) => blobs.abortWrite(a?.token),

  "blob.read": (a) => blobs.read(a?.path),
  "blob.stat": (a) => blobs.stat(a?.path),
  "blob.remove": (a) => blobs.remove(a?.path),
  "blob.absolutePath": (a) => blobs.absolutePath(a?.path),
  "blob.orphans": () => blobs.findOrphans(),
  "blob.pruneGenerations": (a) => blobs.pruneGenerations(a || {}),

  // Apps built by LYKN and installed on this device.
  //
  // `app.data.*` is intentionally absent from this map. Those operations are
  // reachable only through the app bridge in main, which derives the app id
  // from the calling frame's origin — exposing them here would let the main
  // renderer (and anything that reaches it) pass an arbitrary id and read
  // every installed app's data.
  "app.create": (a) => apps.createApp(a?.app || {}),
  "app.get": (a) => apps.getApp(a?.id),
  "app.list": (a) => apps.listApps(a || {}),
  "app.update": (a) => apps.updateApp(a?.id, a?.patch || {}),
  "app.touch": (a) => apps.touchApp(a?.id),
  "app.softDelete": (a) => apps.softDeleteApp(a?.id),
  "app.restore": (a) => apps.restoreApp(a?.id),
  "app.delete": (a) => apps.hardDeleteApp(a?.id),
  "app.stats": (a) => apps.appStats(a?.id),

  "app.files.put": (a) => apps.putFiles(a?.id, a?.files || []),
  "app.files.write": (a) => apps.writeFile(a?.id, a?.path, a?.content),
  "app.files.read": (a) => apps.readFile(a?.id, a?.path),
  "app.files.list": (a) => apps.listFiles(a?.id),
  "app.files.delete": (a) => apps.deleteFile(a?.id, a?.path),

  "app.version.snapshot": (a) => apps.snapshotVersion(a?.id, a?.note),
  "app.version.list": (a) => apps.listVersions(a?.id),
  "app.version.rollback": (a) => apps.rollback(a?.id, a?.version),

  // Clearing an app's data is a user action from settings, not something the
  // app can do to itself, so it lives on this side of the boundary.
  "app.data.clear": (a) => apps.dataClear(a?.id, a?.collection ?? null),
  "app.data.collections": (a) => apps.dataCollections(a?.id),

  // maintenance
  "store.stats": () => stats(),
  "store.meta.get": (a) => store.getMeta(a?.key, a?.fallback ?? null),
  "store.meta.set": (a) => store.setMeta(a?.key, a?.value),
  "backup.snapshot": () => backup.snapshot(),
  "backup.list": () => backup.list(),
};

/**
 * Dispatch a named operation.
 *
 * Always resolves to `{ ok, data }` or `{ ok: false, error }` — a rejected IPC
 * promise loses its stack across the bridge and surfaces as an unhelpful
 * "Error invoking remote method" in the renderer.
 */
async function run(operation, args = {}) {
  const name = String(operation || "");
  const handler = OPERATIONS[name];
  if (!handler) return { ok: false, error: `unknown store operation: ${name}` };
  if (!ready) return { ok: false, error: "local store is not open" };

  try {
    const data = await handler(args);
    return { ok: true, data };
  } catch (err) {
    console.error(`[LYKN] store op ${name} failed:`, err?.message);
    return { ok: false, error: err?.message || "store operation failed" };
  }
}

module.exports = {
  configure,
  shutdown,
  isReady,
  run,
  stats,
  deleteItemCompletely,
  saveAndIndexItem,
  OPERATION_NAMES: Object.keys(OPERATIONS),
  db,
  store,
  search,
  blobs,
  backup,
  embedder,
  indexer,
  importer,
  apps,
};
