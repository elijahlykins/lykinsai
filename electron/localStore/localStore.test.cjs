// Run: node --test electron/localStore/localStore.test.cjs
//
// Exercises the local store against a real SQLite file in a temp directory —
// no mocks, because the parts most likely to break (FTS5 triggers, BLOB
// round-trips, keyset pagination) are exactly the parts a mock would hide.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const localStore = require("./index.cjs");
const { store, search, blobs, backup, db } = localStore;

let userDataPath;

before(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-store-test-"));
  localStore.configure(userDataPath);
});

after(() => {
  localStore.shutdown();
  fs.rmSync(userDataPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test("opens at the expected path and runs every migration", () => {
  assert.ok(localStore.isReady());
  assert.ok(fs.existsSync(db.dbPath()));

  const version = db.get().prepare("PRAGMA user_version").get().user_version;
  assert.equal(Number(version), db.LATEST_VERSION);

  const tables = db
    .get()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

  for (const expected of ["items", "threads", "messages", "chunks", "meta"]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
});

test("migrations are idempotent", () => {
  const result = db.migrate(db.get());
  assert.deepEqual(result.applied, []);
  assert.equal(result.to, db.LATEST_VERSION);
});

test("round-trips an item including its JSON columns", () => {
  const saved = store.putItem({
    id: "11111111-1111-4111-8111-111111111111",
    kind: "vault",
    title: "Local first storage",
    content: "Notes about moving the vault onto the device.",
    tags: ["architecture", "local"],
    comments: [{ body: "revisit this" }],
    source: "manual",
  });

  assert.equal(saved.title, "Local first storage");
  assert.deepEqual(saved.tags, ["architecture", "local"]);
  assert.deepEqual(saved.comments, [{ body: "revisit this" }]);
  assert.ok(saved.created_at);

  const fetched = store.getItem(saved.id);
  assert.deepEqual(fetched.tags, ["architecture", "local"]);
});

test("keeps a caller-supplied id so Supabase rows survive import", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const saved = store.putItem({ id, title: "Imported" });
  assert.equal(saved.id, id);
});

test("partial update leaves untouched columns alone", () => {
  const item = store.putItem({ title: "Original", content: "body", source: "manual" });
  const updated = store.updateItem(item.id, { title: "Renamed" });

  assert.equal(updated.title, "Renamed");
  assert.equal(updated.content, "body", "content should be preserved");
  assert.equal(updated.source, "manual");
  assert.notEqual(updated.updated_at, null);
});

test("ignores unknown columns in a patch", () => {
  const item = store.putItem({ title: "Guarded" });
  const updated = store.updateItem(item.id, { title: "Still fine", bogus_column: "x" });
  assert.equal(updated.title, "Still fine");
});

test("paginates newest first with a stable compound cursor", () => {
  const stamp = "2026-01-01T00:00:00.000Z";
  // Same timestamp on every row — the case a created_at-only cursor drops rows on.
  for (let i = 0; i < 10; i += 1) {
    store.putItem({ id: `page-${String(i).padStart(2, "0")}`, kind: "page", created_at: stamp });
  }

  const first = store.listItems({ kind: "page", limit: 4 });
  assert.equal(first.length, 4);

  const second = store.listItems({
    kind: "page",
    limit: 4,
    after: { created_at: first.at(-1).created_at, id: first.at(-1).id },
  });
  assert.equal(second.length, 4);

  const overlap = first.map((r) => r.id).filter((id) => second.some((s) => s.id === id));
  assert.deepEqual(overlap, [], "pages must not repeat rows");

  const third = store.listItems({
    kind: "page",
    limit: 10,
    after: { created_at: second.at(-1).created_at, id: second.at(-1).id },
  });
  assert.equal(third.length, 2, "should drain to exactly the remaining rows");
});

test("soft delete hides an item but keeps it recoverable", () => {
  const item = store.putItem({ kind: "trashcan", title: "Delete me" });
  store.softDeleteItem(item.id);

  assert.equal(store.listItems({ kind: "trashcan" }).length, 0);
  assert.equal(store.listItems({ kind: "trashcan", includeDeleted: true }).length, 1);

  const restored = store.restoreItem(item.id);
  assert.equal(restored.deleted_at, null);
  assert.equal(store.listItems({ kind: "trashcan" }).length, 1);
});

test("counts tags across items", () => {
  store.putItem({ kind: "tagged", title: "a", tags: ["alpha", "beta"] });
  store.putItem({ kind: "tagged", title: "b", tags: ["alpha"] });

  const counts = store.tagCounts();
  const alpha = counts.find((c) => c.tag === "alpha");
  assert.ok(alpha);
  assert.ok(alpha.count >= 2);
});

// --- full text -------------------------------------------------------------

test("full-text search ranks by bm25 and follows updates", () => {
  const item = store.putItem({
    kind: "fts",
    title: "Embedding pipeline",
    content: "The quick brown fox jumps over the lazy dog",
  });

  let hits = search.lexicalSearch("brown fox", { kind: "fts" });
  assert.ok(
    hits.some((h) => h.id === item.id),
    "should find the item by its body",
  );

  // The FTS triggers have to keep the external-content index in step.
  store.updateItem(item.id, { content: "Completely different text about pelicans" });

  hits = search.lexicalSearch("brown fox", { kind: "fts" });
  assert.ok(!hits.some((h) => h.id === item.id), "stale text must not match after update");

  hits = search.lexicalSearch("pelicans", { kind: "fts" });
  assert.ok(hits.some((h) => h.id === item.id), "new text must match after update");
});

test("full-text search survives punctuation that is FTS5 syntax", () => {
  store.putItem({ kind: "punct", title: "Quoting", content: "sqlite fts5 tokenizer" });

  for (const query of ['what is "sqlite"?', "sqlite -fts5", "sqlite: fts5*", "(sqlite)", "  "]) {
    assert.doesNotThrow(() => search.lexicalSearch(query, { kind: "punct" }), `threw on ${query}`);
  }

  assert.deepEqual(search.lexicalSearch("", { kind: "punct" }), []);
});

test("falls back from AND to OR when a strict query finds nothing", () => {
  store.putItem({ kind: "fallback", title: "Solitary", content: "kangaroo" });

  const strict = search.lexicalSearch("kangaroo aardvark", { kind: "fallback" });
  assert.ok(strict.length >= 1, "OR fallback should still surface the partial match");
});

test("deleted items are excluded from search results", () => {
  const item = store.putItem({ kind: "hidden", title: "Findable", content: "wombat" });
  assert.ok(search.lexicalSearch("wombat", { kind: "hidden" }).some((h) => h.id === item.id));

  store.softDeleteItem(item.id);
  assert.ok(!search.lexicalSearch("wombat", { kind: "hidden" }).some((h) => h.id === item.id));
});

// --- vectors ---------------------------------------------------------------

function vec(values, dims = 8) {
  const out = new Float32Array(dims);
  values.forEach((v, i) => {
    out[i] = v;
  });
  return out;
}

test("stores embeddings and finds the nearest by cosine similarity", () => {
  const near = store.putItem({ kind: "vec", title: "Near" });
  const far = store.putItem({ kind: "vec", title: "Far" });

  search.putChunks("item", near.id, [{ text: "near chunk", embedding: vec([1, 0, 0]) }], "test-model");
  search.putChunks("item", far.id, [{ text: "far chunk", embedding: vec([0, 1, 0]) }], "test-model");

  const hits = search.semanticSearch(vec([0.9, 0.1, 0]), { limit: 5 });
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].sourceId, near.id, "closest vector should rank first");
  assert.ok(hits[0].score > hits[1].score);
});

test("embeddings are normalized on write so magnitude does not skew ranking", () => {
  const item = store.putItem({ kind: "norm", title: "Scaled" });
  // A vector 100x longer but pointing the same way must score the same.
  search.putChunks("item", item.id, [{ text: "scaled", embedding: vec([100, 0, 0]) }], "test-model");

  const hits = search.semanticSearch(vec([1, 0, 0]), { limit: 10 });
  const hit = hits.find((h) => h.sourceId === item.id);
  assert.ok(hit);
  assert.ok(Math.abs(hit.score - 1) < 1e-5, `expected ~1, got ${hit.score}`);
});

test("replacing chunks for a source removes the previous ones", () => {
  const item = store.putItem({ kind: "replace", title: "Rechunked" });

  search.putChunks(
    "item",
    item.id,
    [
      { text: "one", embedding: vec([1, 0, 0]) },
      { text: "two", embedding: vec([0, 1, 0]) },
    ],
    "test-model",
  );
  search.putChunks("item", item.id, [{ text: "only", embedding: vec([0, 0, 1]) }], "test-model");

  const rows = db
    .get()
    .prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id = ?")
    .get(item.id);
  assert.equal(Number(rows.n), 1);
});

test("rejects a query whose dimensions do not match the index", () => {
  const item = store.putItem({ kind: "dims", title: "Dims" });
  search.putChunks("item", item.id, [{ text: "x", embedding: vec([1, 0, 0], 8) }], "test-model");

  const hits = search.semanticSearch(new Float32Array(4), { limit: 5 });
  assert.deepEqual(hits, [], "a dimension mismatch should return nothing, not noise");
});

test("reports sources embedded with a superseded model", () => {
  const item = store.putItem({ kind: "stale", title: "Old model" });
  search.putChunks("item", item.id, [{ text: "x", embedding: vec([1, 0, 0]) }], "old-model");

  const stale = search.staleSources("new-model");
  assert.ok(stale.some((s) => s.source_id === item.id));
});

test("hybrid search fuses lexical and semantic hits", () => {
  const lexicalOnly = store.putItem({
    kind: "hybrid",
    title: "Platypus notes",
    content: "platypus",
  });
  const semanticOnly = store.putItem({ kind: "hybrid", title: "Unrelated wording" });

  search.putChunks(
    "item",
    semanticOnly.id,
    [{ text: "semantic", embedding: vec([1, 0, 0]) }],
    "test-model",
  );

  const fused = search.hybridSearch("platypus", {
    queryEmbedding: vec([1, 0, 0]),
    kind: "hybrid",
    limit: 10,
  });

  const ids = fused.map((r) => r.id);
  assert.ok(ids.includes(lexicalOnly.id), "lexical hit should appear");
  assert.ok(ids.includes(semanticOnly.id), "semantic hit should appear");
  assert.ok(fused.every((r) => typeof r._score === "number"));
});

test("hybrid search degrades to lexical when no embedding is supplied", () => {
  store.putItem({ kind: "nolexemb", title: "Narwhal", content: "narwhal" });
  const results = search.hybridSearch("narwhal", { kind: "nolexemb", limit: 5 });
  assert.ok(results.length >= 1);
  assert.deepEqual(results[0]._sources, ["lexical"]);
});

// --- threads and messages --------------------------------------------------

test("appends messages with an auto-incrementing sequence", () => {
  const thread = store.putThread({ title: "Design chat" });

  store.appendMessage(thread.id, { role: "user", content: "how should this work" });
  store.appendMessage(thread.id, { role: "assistant", content: "sqlite in main", blocks: [{ t: 1 }] });

  const messages = store.listMessages(thread.id);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((m) => m.seq), [0, 1]);
  assert.deepEqual(messages[1].blocks, [{ t: 1 }]);
});

test("appending a message bumps the thread's updated_at", () => {
  const thread = store.putThread({ title: "Bumped", created_at: "2020-01-01T00:00:00.000Z" });
  store.appendMessage(thread.id, { role: "user", content: "hello" });

  const after = store.getThread(thread.id);
  assert.notEqual(after.updated_at, "2020-01-01T00:00:00.000Z");
});

test("hard-deleting a thread cascades to its messages", () => {
  const thread = store.putThread({ title: "Doomed" });
  store.appendMessage(thread.id, { role: "user", content: "transient" });

  store.deleteThread(thread.id, { hard: true });

  assert.equal(store.getThread(thread.id), null);
  assert.equal(store.listMessages(thread.id).length, 0);
});

test("searches message text", () => {
  const thread = store.putThread({ title: "Searchable" });
  store.appendMessage(thread.id, { role: "user", content: "tell me about capybaras" });

  const hits = search.searchMessages("capybaras");
  assert.ok(hits.some((h) => h.thread_id === thread.id));
});

// --- blobs -----------------------------------------------------------------

test("writes and reads a blob, returning a relative path", async () => {
  const item = store.putItem({ kind: "blob", title: "With a file" });
  const payload = Buffer.from("hello local vault");

  const written = await blobs.write(item.id, payload, {
    filename: "note.txt",
    mimeType: "text/plain",
  });

  assert.equal(written.path, `${item.id}/original.txt`);
  assert.equal(written.bytes, payload.byteLength);

  const readBack = await blobs.read(written.path);
  assert.equal(readBack.toString(), "hello local vault");

  const info = await blobs.stat(written.path);
  assert.equal(info.bytes, payload.byteLength);
});

test("infers an extension from the mime type when the name has none", async () => {
  const item = store.putItem({ kind: "blob", title: "No extension" });
  const written = await blobs.write(item.id, Buffer.from([1, 2, 3]), {
    filename: "screenshot",
    mimeType: "image/png",
  });
  assert.ok(written.path.endsWith("original.png"));
});

test("refuses blob paths that escape the store directory", async () => {
  assert.equal(blobs.absolutePath("../../etc/passwd"), null);
  assert.equal(blobs.absolutePath("/etc/passwd"), null);
  await assert.rejects(() => blobs.read("../../etc/passwd"));
});

test("deleting an item removes its chunks and its files", async () => {
  const item = store.putItem({ kind: "cascade", title: "Everything goes" });
  const written = await blobs.write(item.id, Buffer.from("bytes"), { filename: "f.bin" });
  store.updateItem(item.id, { blob_path: written.path });
  search.putChunks("item", item.id, [{ text: "x", embedding: vec([1, 0, 0]) }], "test-model");

  await localStore.deleteItemCompletely(item.id);

  assert.equal(store.getItem(item.id), null);
  assert.equal(blobs.existsSync(written.path), false);
  const remaining = db
    .get()
    .prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id = ?")
    .get(item.id);
  assert.equal(Number(remaining.n), 0);
});

test("finds rows whose file is missing and directories with no row", async () => {
  const item = store.putItem({ kind: "orphan", title: "Dangling", blob_path: "nope/original.bin" });
  const orphans = await blobs.findOrphans();
  assert.ok(orphans.missingFiles.some((m) => m.id === item.id));
});

// --- generation sweep ------------------------------------------------------

test("sweeps stale generations and leaves saved ones alone", async () => {
  const stale = store.putItem({
    kind: "generation",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
  });
  const staleBlob = await blobs.write(stale.id, Buffer.from("old bytes"), {
    filename: "generation.png",
  });
  store.updateItem(stale.id, { blob_path: staleBlob.path, updated_at: "2020-01-01T00:00:00.000Z" });

  const fresh = store.putItem({ kind: "generation" });
  const freshBlob = await blobs.write(fresh.id, Buffer.from("new bytes"), {
    filename: "generation.png",
  });
  store.updateItem(fresh.id, { blob_path: freshBlob.path });

  // A generation the user saved is a vault row by then, so kind alone protects
  // it — even with a created_at well past the window.
  const promoted = store.putItem({
    kind: "vault",
    title: "Kept this one",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
  });
  const promotedBlob = await blobs.write(promoted.id, Buffer.from("kept bytes"), {
    filename: "original.png",
  });
  store.updateItem(promoted.id, {
    blob_path: promotedBlob.path,
    updated_at: "2020-01-01T00:00:00.000Z",
  });

  const result = await blobs.pruneGenerations();

  assert.equal(result.removed, 1);
  assert.equal(store.getItem(stale.id), null);
  assert.equal(blobs.existsSync(staleBlob.path), false);

  assert.ok(store.getItem(fresh.id), "a generation inside the window survives");
  assert.equal(blobs.existsSync(freshBlob.path), true);

  assert.ok(store.getItem(promoted.id), "a saved image is never swept");
  assert.equal(blobs.existsSync(promotedBlob.path), true);
});

test("a zero-day window collects generations but still spares saved rows", async () => {
  const doomed = store.putItem({ kind: "generation" });
  const written = await blobs.write(doomed.id, Buffer.from("bytes"), {
    filename: "generation.png",
  });
  // A second in the past, not "now": the cutoff is exclusive, and a row
  // written in the same millisecond as the sweep would survive it.
  store.updateItem(doomed.id, {
    blob_path: written.path,
    updated_at: new Date(Date.now() - 1000).toISOString(),
  });

  await blobs.pruneGenerations({ olderThanDays: 0 });

  assert.equal(store.getItem(doomed.id), null);
  assert.equal(blobs.existsSync(written.path), false);
  const vaultRows = db
    .get()
    .prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'vault'")
    .get();
  assert.ok(Number(vaultRows.n) > 0, "vault rows are untouched by the sweep");
});

// --- backups ---------------------------------------------------------------

test("takes a consistent snapshot that opens as a valid database", async () => {
  store.putItem({ id: "snapshot-canary", kind: "backup", title: "Canary" });

  const snap = await backup.snapshot();
  assert.ok(snap.ok);
  assert.ok(fs.existsSync(snap.path));
  assert.ok(snap.bytes > 0);

  const { DatabaseSync } = require("node:sqlite");
  const copy = new DatabaseSync(snap.path);
  const row = copy.prepare("SELECT title FROM items WHERE id = ?").get("snapshot-canary");
  copy.close();

  assert.equal(row.title, "Canary", "snapshot must contain committed rows");

  const listed = await backup.list();
  assert.ok(listed.length >= 1);
});

test("prunes old snapshots beyond the keep window", async () => {
  await backup.snapshot();
  await backup.prune(1);
  const listed = await backup.list();
  assert.equal(listed.length, 1);
});

// --- dispatcher ------------------------------------------------------------

test("run() wraps results and never rejects", async () => {
  const ok = await localStore.run("item.put", { item: { title: "Through IPC" } });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.title, "Through IPC");

  const unknown = await localStore.run("does.not.exist", {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown store operation/);

  // A handler that throws should surface as ok:false, not a rejected promise.
  const bad = await localStore.run("blob.read", { path: "../escape" });
  assert.equal(bad.ok, false);
});

test("exposes the operation catalogue for the preload bridge", () => {
  assert.ok(localStore.OPERATION_NAMES.includes("item.list"));
  assert.ok(localStore.OPERATION_NAMES.includes("search.hybrid"));
  assert.ok(localStore.OPERATION_NAMES.includes("backup.snapshot"));
});

test("reports storage statistics", async () => {
  const result = await localStore.stats();
  assert.equal(result.ok, true);
  assert.ok(result.items > 0);
  assert.ok(result.chunks.chunks >= 0);
  assert.ok(typeof result.blobs.bytes === "number");
  assert.equal(result.schemaVersion, db.LATEST_VERSION);
});
