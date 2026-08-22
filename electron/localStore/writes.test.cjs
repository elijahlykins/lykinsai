/**
 * Streaming blob writes and the compare-and-set guard on item updates.
 *
 * Both exist for the upload path: bytes arrive from the renderer in chunks,
 * and the row that describes them is written separately, so the interesting
 * cases are the ones where those two things disagree — a write that never
 * finishes, a row that changed while a background pass was thinking.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const localStore = require("./index.cjs");
const blobs = require("./blobs.cjs");
const store = require("./store.cjs");

/**
 * Fresh store rooted in a temp directory. Returns the blobs directory too,
 * since most of these assertions are about what is and isn't on disk.
 */
function freshStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-writes-"));
  localStore.configure(root);
  t.after(() => {
    try {
      localStore.shutdown();
    } catch {
      /* already down */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, blobsDir: blobs.blobsDir() };
}

test("streaming write lands the file only once finished", async (t) => {
  const { blobsDir } = freshStore(t);

  const begun = await blobs.beginWrite("item-1", {
    filename: "clip.mp4",
    mimeType: "video/mp4",
  });
  assert.equal(begun.path, "item-1/original.mp4");

  const partial = path.join(blobsDir, "item-1", "original.mp4");
  await blobs.appendWrite(begun.token, Buffer.from("abc"));

  // Mid-write, the real filename must not exist yet: a reader that found it
  // would get a truncated file and no way to tell.
  assert.equal(fs.existsSync(partial), false, "real file exists before finish");
  assert.equal(fs.existsSync(`${partial}.part`), true, "no partial file");

  await blobs.appendWrite(begun.token, Buffer.from("def"));
  const done = await blobs.finishWrite(begun.token);

  assert.equal(done.bytes, 6);
  assert.equal(done.path, "item-1/original.mp4");
  assert.equal(fs.existsSync(partial), true);
  assert.equal(fs.existsSync(`${partial}.part`), false, "partial file survived");
  assert.equal(await fsp.readFile(partial, "utf8"), "abcdef");
});

test("aborted write leaves nothing behind", async (t) => {
  const { blobsDir } = freshStore(t);

  const begun = await blobs.beginWrite("item-2", { filename: "a.png" });
  await blobs.appendWrite(begun.token, Buffer.from("partial data"));
  await blobs.abortWrite(begun.token);

  const dir = path.join(blobsDir, "item-2");
  const entries = fs.existsSync(dir) ? await fsp.readdir(dir) : [];
  assert.deepEqual(entries, [], "abort left files behind");

  // The token is spent; appending after abort must fail loudly rather than
  // silently recreating the file.
  await assert.rejects(() => blobs.appendWrite(begun.token, Buffer.from("x")));
});

test("variants share the item directory with the original", async (t) => {
  const { blobsDir } = freshStore(t);

  for (const variant of ["original", "medium", "thumb"]) {
    const begun = await blobs.beginWrite("item-3", {
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      variant,
    });
    await blobs.appendWrite(begun.token, Buffer.from(variant));
    await blobs.finishWrite(begun.token);
  }

  const entries = (await fsp.readdir(path.join(blobsDir, "item-3"))).sort();
  assert.deepEqual(entries, ["medium.jpg", "original.jpg", "thumb.jpg"]);
});

test("closeWriters cleans up uploads still open at shutdown", async (t) => {
  const { blobsDir } = freshStore(t);

  await blobs.beginWrite("item-4", { filename: "a.bin" });
  await blobs.beginWrite("item-5", { filename: "b.bin" });
  const result = await blobs.closeWriters();

  assert.equal(result.aborted, 2);
  assert.deepEqual(await fsp.readdir(path.join(blobsDir, "item-4")), []);
});

test("guarded update refuses to overwrite a row that moved on", async (t) => {
  freshStore(t);

  const created = store.putItem({ id: "note-1", title: "First", content: "original" });
  const seenAt = created.updated_at;

  // A background pass reads the row, then the user edits it before the pass
  // gets around to writing its result back.
  const edited = store.updateItem("note-1", { content: "user edit" });
  assert.notEqual(edited.updated_at, seenAt);

  const stale = store.updateItem(
    "note-1",
    { content: "stale background result" },
    { ifUpdatedAt: seenAt },
  );
  assert.equal(stale, null, "stale write was not rejected");
  assert.equal(store.getItem("note-1").content, "user edit");

  // The same write against the current timestamp succeeds.
  const fresh = store.updateItem(
    "note-1",
    { content: "fresh background result" },
    { ifUpdatedAt: edited.updated_at },
  );
  assert.equal(fresh.content, "fresh background result");
});

test("unguarded update still writes unconditionally", async (t) => {
  freshStore(t);

  store.putItem({ id: "note-2", title: "T", content: "a" });
  store.updateItem("note-2", { content: "b" });
  assert.equal(store.getItem("note-2").content, "b");
});
