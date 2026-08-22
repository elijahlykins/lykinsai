// Run: node --test electron/localStore/import.test.cjs
//
// Exercises the Supabase → local migration against a stub server that speaks
// enough PostgREST and Storage to be a real test: keyset pagination, exact
// counts, in() filters, 404s on missing objects, and a 500 that has to be
// retried.
//
// The stub matters more than a mock of the client would. The failure modes
// this migration actually has are pagination that skips rows, cursors that do
// not resume, and files that 404 — all of which live in the seam between the
// two systems, which is exactly what a mocked client would paper over.

const { test, before, after, beforeEach, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

process.env.LYKN_EMBED_IN_PROCESS = "1";

const localStore = require("./index.cjs");
const { store, blobs, importer, db } = localStore;
const cloud = require("./cloudSource.cjs");
const map = require("./importMap.cjs");

const USER_ID = "00000000-0000-4000-8000-00000000user";
const TOKEN = "test-access-token";

let server;
let baseUrl;
let userDataPath;

/** Mutable fixture state, reset per test. */
let cloudData;

function resetCloudData() {
  cloudData = {
    vault_items: [],
    lykn_chats: [],
    lykn_chat_states: [],
    objects: new Map(), // "bucket/path" -> Buffer
    failuresRemaining: 0, // how many requests should 500 before succeeding
    requests: [],
  };
}

function makeItem(index, overrides = {}) {
  const id = `11111111-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    user_id: USER_ID,
    title: `Cloud note ${index}`,
    content: `Body of note ${index} with enough words to be worth embedding later on.`,
    why: null,
    tags: ["imported", `n${index}`],
    source: "manual",
    folder: null,
    att_type: "note",
    platform: null,
    url: null,
    storage_path: null,
    storage_bucket: "user-files",
    mime_type: null,
    byte_size: null,
    duration_seconds: null,
    page_count: null,
    host_name: null,
    media_width: null,
    media_height: null,
    variant_medium_path: null,
    variant_thumb_path: null,
    attachment_preview: null,
    comments: [],
    ai_summary: null,
    ai_signals: {},
    ai_content_hash: null,
    created_at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
    updated_at: new Date(Date.UTC(2024, 0, 2, 0, 0, index)).toISOString(),
    ...overrides,
  };
}

// --- PostgREST-ish stub -----------------------------------------------------

/** Apply the subset of PostgREST filters the importer actually sends. */
function applyFilters(rows, params) {
  let out = rows.slice();

  for (const [key, value] of params.entries()) {
    if (["select", "order", "limit", "offset", "or"].includes(key)) continue;
    if (value.startsWith("eq.")) {
      const wanted = value.slice(3);
      out = out.filter((r) => String(r[key]) === wanted);
    } else if (value.startsWith("in.(")) {
      const list = new Set(value.slice(4, -1).split(","));
      out = out.filter((r) => list.has(String(r[key])));
    }
  }

  const or = params.get("or");
  if (or) {
    // or=(created_at.gt.X,and(created_at.eq.X,id.gt.Y))
    const gt = /created_at\.gt\.([^,)]+)/.exec(or);
    const eq = /created_at\.eq\.([^,)]+)/.exec(or);
    const idGt = /id\.gt\.([^,)]+)/.exec(or);
    if (gt && eq && idGt) {
      out = out.filter(
        (r) =>
          r.created_at > gt[1] || (r.created_at === eq[1] && String(r.id) > idGt[1]),
      );
    }
  }

  const order = params.get("order");
  if (order?.startsWith("created_at.asc")) {
    out.sort((a, b) =>
      a.created_at === b.created_at
        ? String(a.id).localeCompare(String(b.id))
        : a.created_at.localeCompare(b.created_at),
    );
  }

  return out;
}

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      cloudData.requests.push({ method: req.method, path: url.pathname });

      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }

      if (cloudData.failuresRemaining > 0) {
        cloudData.failuresRemaining -= 1;
        res.writeHead(500).end("transient");
        return;
      }

      if (url.pathname === "/auth/v1/user") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: USER_ID, email: "user@example.com" }));
        return;
      }

      if (url.pathname.startsWith("/rest/v1/")) {
        const table = url.pathname.slice("/rest/v1/".length);
        const rows = applyFilters(cloudData[table] || [], url.searchParams);

        if (req.method === "HEAD") {
          res.writeHead(206, { "content-range": `0-0/${rows.length}` }).end();
          return;
        }
        const limit = Number(url.searchParams.get("limit")) || rows.length;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(rows.slice(0, limit)));
        return;
      }

      if (url.pathname.startsWith("/storage/v1/object/authenticated/")) {
        const key = decodeURIComponent(
          url.pathname.slice("/storage/v1/object/authenticated/".length),
        )
          .split("/")
          .map(decodeURIComponent)
          .join("/");
        const bytes = cloudData.objects.get(key);
        if (!bytes) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
        return;
      }

      res.writeHead(404).end("no route");
    });

    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

/** Poll until the background run finishes. */
async function waitForImport(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!importer.status().running) return importer.status();
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("import did not finish in time");
}

before(async () => {
  resetCloudData();
  await startServer();
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-import-test-"));
  localStore.configure(userDataPath);
});

after(async () => {
  localStore.shutdown();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(userDataPath, { recursive: true, force: true });
});

beforeEach(() => {
  resetCloudData();
  // Each test starts from an empty local store and a clean cursor.
  db.get().exec("DELETE FROM items; DELETE FROM messages; DELETE FROM threads; DELETE FROM chunks; DELETE FROM index_state;");
  importer.resetProgress();
  fs.rmSync(blobs.blobsDir(), { recursive: true, force: true });
  cloud.configure({ url: baseUrl, accessToken: TOKEN, apiKey: "anon", userId: USER_ID });
});

// ---------------------------------------------------------------------------

describe("column mapping", () => {
  test("maps a vault row onto local columns", () => {
    const row = makeItem(1, {
      why: "worth keeping",
      ai_summary: "A summary.",
      attachment_preview: { title: "Preview" },
      comments: [{ id: "c1", text: "note", created_at: "2024-01-01T00:00:00Z" }],
      byte_size: "2048",
      media_width: "800",
    });
    const { item } = map.mapVaultItem(row);

    assert.equal(item.id, row.id);
    assert.equal(item.kind, "vault");
    assert.equal(item.title, "Cloud note 1");
    assert.equal(item.why, "worth keeping");
    assert.deepEqual(item.tags, ["imported", "n1"]);
    assert.deepEqual(item.preview, { title: "Preview" });
    assert.equal(item.comments.length, 1);
    assert.equal(item.origin, "supabase");
    // Numeric columns arrive as strings over JSON for bigint/numeric types.
    assert.equal(item.byte_size, 2048);
    assert.equal(item.media_width, 800);
  });

  test("never claims a local file that has not been downloaded", () => {
    const { item, blobs: specs } = map.mapVaultItem(
      makeItem(2, {
        storage_path: `${USER_ID}/file-2/original.png`,
        variant_thumb_path: `${USER_ID}/file-2/thumb.jpg`,
        mime_type: "image/png",
      }),
    );

    assert.equal(item.blob_path, null, "blob_path must stay null until bytes land");
    assert.equal(item.variant_thumb, null);
    assert.equal(specs.length, 2);
    assert.deepEqual(
      specs.map((s) => s.variant).sort(),
      ["original", "thumb"],
    );
    assert.equal(specs[0].bucket, "user-files");
  });

  test("collects files the marker references, not just the columns", () => {
    // A note with several images keeps all but the first only in the marker.
    // Reading columns alone would migrate one file and leave three behind
    // while the row still claimed them.
    const attachments = [
      { name: "a.png", storagePath: `${USER_ID}/f/a.png`, variantThumbPath: `${USER_ID}/f/a-t.jpg` },
      { name: "b.png", storagePath: `${USER_ID}/f/b.png` },
      { name: "c.png", storagePath: `${USER_ID}/f/c.png` },
    ];
    const row = makeItem(9, {
      storage_path: `${USER_ID}/f/a.png`,
      content: `Trip photos\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`,
    });

    const specs = map.collectBlobSpecs(row);
    const paths = specs.map((s) => s.path).sort();
    assert.deepEqual(paths, [
      `${USER_ID}/f/a-t.jpg`,
      `${USER_ID}/f/a.png`,
      `${USER_ID}/f/b.png`,
      `${USER_ID}/f/c.png`,
    ]);
  });

  test("downloads a file once even when column and marker both name it", () => {
    const attachments = [{ name: "a.png", storagePath: `${USER_ID}/f/a.png` }];
    const specs = map.collectBlobSpecs(
      makeItem(10, {
        storage_path: `${USER_ID}/f/a.png`,
        content: `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`,
      }),
    );

    assert.equal(specs.length, 1, "the shared file was collected twice");
    // ...and the one download satisfies both places that reference it.
    assert.deepEqual(
      specs[0].targets.map((t) => t.type).sort(),
      ["attachment", "column"],
    );
  });

  test("gives each extra attachment its own local name", () => {
    const attachments = [
      { storagePath: `${USER_ID}/f/a.png` },
      { storagePath: `${USER_ID}/f/b.png` },
    ];
    const specs = map.collectBlobSpecs(
      makeItem(11, { content: `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]` }),
    );
    const variants = specs.map((s) => s.variant);
    assert.equal(new Set(variants).size, variants.length, "two files would collide on disk");
  });

  test("rewrites the marker to point at local files", () => {
    const attachments = [
      { name: "a.png", storagePath: `${USER_ID}/f/a.png`, url: "https://x.supabase.co/signed?token=1" },
    ];
    const content = `Photos\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]\nTrailing prose.`;
    const localByKey = new Map([[`user-files/${USER_ID}/f/a.png`, "item-9/original.png"]]);

    const rewritten = map.localizeAttachments(content, localByKey, "user-files");
    const parsed = JSON.parse(/\[ATTACHMENTS_JSON:(.+)\]\n/.exec(rewritten)[1]);

    assert.equal(parsed[0].storagePath, "item-9/original.png");
    assert.equal(parsed[0].storageBucket, "local");
    // An expiring signed URL must not outrank the local file sitting next to it.
    assert.equal(parsed[0].url, undefined);
    assert.equal(parsed[0].name, "a.png", "unrelated fields should survive");
    assert.ok(rewritten.startsWith("Photos"), "prose before the marker was disturbed");
    assert.ok(rewritten.endsWith("Trailing prose."), "prose after the marker was lost");
  });

  test("leaves an attachment alone when its file never arrived", () => {
    const attachments = [{ storagePath: `${USER_ID}/f/missing.png` }];
    const content = `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`;
    // Rewriting this to a local path would invent a file that does not exist.
    const rewritten = map.localizeAttachments(content, new Map([["user-files/other", "x"]]), "user-files");
    const parsed = JSON.parse(/\[ATTACHMENTS_JSON:(.+)\]/.exec(rewritten)[1]);
    assert.equal(parsed[0].storagePath, `${USER_ID}/f/missing.png`);
    assert.equal(parsed[0].storageBucket, undefined);
  });

  test("reads tags whether they arrive as an array, JSON, or a Postgres literal", () => {
    assert.deepEqual(map.asArray(["a", "b"]), ["a", "b"]);
    assert.deepEqual(map.asArray('["a","b"]'), ["a", "b"]);
    assert.deepEqual(map.asArray("{a,b}"), ["a", "b"]);
    assert.deepEqual(map.asArray(null), []);
    assert.deepEqual(map.asArray(""), []);
  });

  test("splits a chat snapshot into a thread, messages, and its canvas", () => {
    const { thread, messages } = map.mapChat(
      {
        id: "chat-1",
        title: "Planning",
        created_at: "2024-03-01T00:00:00.000Z",
        updated_at: "2024-03-02T00:00:00.000Z",
      },
      {
        chat_id: "chat-1",
        state: {
          chatMessages: [
            { id: "m1", role: "user", content: "Hello", kind: "prompt" },
            { id: "m2", role: "assistant", content: "Hi there", attachments: [{ name: "a.png" }] },
          ],
          aiThread: [{ role: "user", content: "Hello" }],
          blocks: { b1: { type: "text", content: "canvas block" } },
          blockOrder: ["b1"],
          camera: { x: 1, y: 2 },
        },
      },
    );

    assert.equal(thread.id, "chat-1");
    assert.equal(thread.title, "Planning");
    assert.equal(thread.updated_at, "2024-03-02T00:00:00.000Z");
    // The grid canvas has no other home; losing it would lose real work.
    assert.deepEqual(thread.state.blockOrder, ["b1"]);
    assert.equal(thread.state.chatMessages, undefined, "conversation should not be duplicated");

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].content, "Hi there");
    // Fields with no column of their own survive in blocks.
    assert.deepEqual(messages[1].blocks.attachments, [{ name: "a.png" }]);
    assert.equal(messages[0].blocks.kind, "prompt");
  });

  test("falls back to aiThread when a snapshot has no rich messages", () => {
    const { messages } = map.mapChat(
      { id: "chat-2", created_at: "2024-03-01T00:00:00.000Z" },
      { chat_id: "chat-2", state: { aiThread: [{ role: "user", content: "only flat" }] } },
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, "only flat");
  });

  test("survives a chat with no state row at all", () => {
    const { thread, messages } = map.mapChat({ id: "chat-3", created_at: "2024-03-01T00:00:00.000Z" });
    assert.equal(thread.id, "chat-3");
    assert.deepEqual(messages, []);
  });
});

// ---------------------------------------------------------------------------

describe("cloud source", () => {
  test("refuses to write, whatever it is asked", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      await assert.rejects(
        () => cloud.send("/rest/v1/vault_items", { method }),
        /read-only/,
        `${method} should be refused`,
      );
    }
    // And nothing reached the server.
    assert.equal(
      cloudData.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD").length,
      0,
    );
  });

  test("confirms the token belongs to the expected user", async () => {
    const ok = await cloud.checkAccess();
    assert.equal(ok.ok, true);
    assert.equal(ok.email, "user@example.com");

    cloud.configure({ url: baseUrl, accessToken: TOKEN, userId: "someone-else" });
    const bad = await cloud.checkAccess();
    assert.equal(bad.ok, false);
  });

  test("walks every row across page boundaries without gaps or repeats", async () => {
    cloudData.vault_items = Array.from({ length: 25 }, (_, i) => makeItem(i));

    const seen = [];
    for await (const rows of cloud.pages("vault_items", { limit: 10 })) {
      seen.push(...rows.map((r) => r.id));
    }

    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25, "a row was returned twice");
  });

  test("pages correctly when many rows share a timestamp", async () => {
    // Bulk imports produce exactly this, and it is where offset-style
    // pagination and naive `gte` cursors both go wrong.
    const stamp = "2024-05-05T00:00:00.000Z";
    cloudData.vault_items = Array.from({ length: 12 }, (_, i) =>
      makeItem(i, { created_at: stamp }),
    );

    const seen = [];
    for await (const rows of cloud.pages("vault_items", { limit: 5 })) {
      seen.push(...rows.map((r) => r.id));
    }
    assert.equal(new Set(seen).size, 12);
  });

  test("retries a transient server error", async () => {
    cloudData.vault_items = [makeItem(0)];
    cloudData.failuresRemaining = 2;
    const rows = await cloud.page("vault_items", { limit: 10 });
    assert.equal(rows.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("import", () => {
  test("preflight reports both sides without importing anything", async () => {
    cloudData.vault_items = [makeItem(0), makeItem(1)];
    cloudData.lykn_chats = [{ id: "c1", user_id: USER_ID, title: "T", created_at: "2024-01-01T00:00:00.000Z" }];

    const plan = await importer.preflight();
    assert.equal(plan.ok, true);
    assert.equal(plan.cloud.items, 2);
    assert.equal(plan.cloud.chats, 1);
    assert.equal(store.countItems(), 0, "preflight must not write");
  });

  test("imports rows, files, chats, and messages", async () => {
    const withFile = makeItem(0, {
      storage_path: `${USER_ID}/file-0/original.png`,
      variant_thumb_path: `${USER_ID}/file-0/thumb.jpg`,
      mime_type: "image/png",
    });
    cloudData.vault_items = [withFile, makeItem(1)];
    cloudData.objects.set(`user-files/${USER_ID}/file-0/original.png`, Buffer.from("PNGDATA"));
    cloudData.objects.set(`user-files/${USER_ID}/file-0/thumb.jpg`, Buffer.from("THUMB"));

    cloudData.lykn_chats = [
      { id: "chat-a", user_id: USER_ID, title: "Imported chat", created_at: "2024-02-01T00:00:00.000Z", updated_at: "2024-02-09T00:00:00.000Z" },
    ];
    cloudData.lykn_chat_states = [
      {
        chat_id: "chat-a",
        user_id: USER_ID,
        state: {
          chatMessages: [
            { id: "m1", role: "user", content: "First" },
            { id: "m2", role: "assistant", content: "Second" },
          ],
          blocks: { b: { type: "text", content: "canvas" } },
        },
      },
    ];

    await importer.start({ reindex: false });
    const final = await waitForImport();

    assert.equal(final.error, null);
    assert.equal(final.items.imported, 2);
    assert.equal(final.blobs.downloaded, 2);
    assert.equal(final.chats.imported, 1);
    assert.equal(final.chats.messages, 2);

    const item = store.getItem(withFile.id);
    assert.equal(item.title, "Cloud note 0");
    assert.equal(item.origin, "supabase");
    assert.ok(item.blob_path, "blob_path should be set once bytes are on disk");
    assert.ok(item.variant_thumb);
    assert.equal((await blobs.read(item.blob_path)).toString(), "PNGDATA");

    const thread = store.getThread("chat-a");
    assert.equal(thread.title, "Imported chat");
    assert.deepEqual(thread.state.blocks.b.type, "text");
    // The real cloud timestamp has to survive appending messages.
    assert.equal(thread.updated_at, "2024-02-09T00:00:00.000Z");

    const messages = store.listMessages("chat-a");
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((m) => m.content), ["First", "Second"]);
  });

  test("migrates every attachment on a multi-image note and repoints the marker", async () => {
    const attachments = [
      { name: "a.png", storagePath: `${USER_ID}/f/a.png` },
      { name: "b.png", storagePath: `${USER_ID}/f/b.png` },
      { name: "c.png", storagePath: `${USER_ID}/f/c.png` },
    ];
    const row = makeItem(0, {
      mime_type: "image/png",
      storage_path: `${USER_ID}/f/a.png`,
      content: `Trip\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]`,
    });
    cloudData.vault_items = [row];
    for (const name of ["a", "b", "c"]) {
      cloudData.objects.set(`user-files/${USER_ID}/f/${name}.png`, Buffer.from(`${name}-bytes`));
    }

    await importer.start({ reindex: false });
    const final = await waitForImport();

    assert.equal(final.blobs.downloaded, 3, "an attachment was left in the cloud");

    const item = store.getItem(row.id);
    const parsed = JSON.parse(/\[ATTACHMENTS_JSON:(.+)\]/.exec(item.content)[1]);
    assert.equal(parsed.length, 3);

    // Every one must resolve to bytes actually on this device.
    for (const attachment of parsed) {
      assert.equal(attachment.storageBucket, "local");
      assert.ok(
        blobs.existsSync(attachment.storagePath),
        `${attachment.name} points at a file that does not exist`,
      );
    }
    assert.equal((await blobs.read(parsed[2].storagePath)).toString(), "c-bytes");
  });

  test("a missing file is reported, not silently imported as present", async () => {
    cloudData.vault_items = [
      makeItem(0, { storage_path: `${USER_ID}/gone/original.png`, mime_type: "image/png" }),
    ];
    // Deliberately do not register the object: the row outlived its upload.

    await importer.start({ reindex: false });
    const final = await waitForImport();

    assert.equal(final.items.imported, 1, "the note itself must still import");
    assert.equal(final.blobs.missing, 1);
    assert.equal(final.blobs.downloaded, 0);

    const item = store.getItem(cloudData.vault_items[0].id);
    assert.equal(item.blob_path, null, "must not point at a file that does not exist");
  });

  test("re-running is a no-op rather than a duplicate vault", async () => {
    cloudData.vault_items = Array.from({ length: 5 }, (_, i) =>
      makeItem(i, {
        storage_path: `${USER_ID}/f${i}/original.txt`,
        mime_type: "text/plain",
      }),
    );
    for (let i = 0; i < 5; i += 1) {
      cloudData.objects.set(`user-files/${USER_ID}/f${i}/original.txt`, Buffer.from(`file ${i}`));
    }

    await importer.start({ reindex: false });
    await waitForImport();
    assert.equal(store.countItems(), 5);

    // Second run from scratch: same ids, so upserts, and the files are already
    // on disk so they are skipped rather than re-fetched.
    await importer.start({ reindex: false, restart: true });
    const second = await waitForImport();

    assert.equal(store.countItems(), 5, "re-running duplicated rows");
    assert.equal(second.blobs.skipped, 5);
    assert.equal(second.blobs.downloaded, 0);
  });

  test("resumes from where it stopped instead of starting over", async () => {
    cloudData.vault_items = Array.from({ length: 8 }, (_, i) => makeItem(i));

    await importer.start({ reindex: false });
    await waitForImport();
    assert.equal(store.countItems(), 8);

    // Drop the local rows but keep the cursor: a resumed run should believe
    // it is already done and not re-walk the table.
    db.get().exec("DELETE FROM items");
    await importer.start({ reindex: false });
    const resumed = await waitForImport();

    assert.equal(resumed.items.seen, 0, "resumed run re-read rows it had already passed");
    assert.equal(importer.status().resumable, true);
  });

  test("a dry run reads everything and writes nothing", async () => {
    cloudData.vault_items = [makeItem(0), makeItem(1)];
    cloudData.lykn_chats = [
      { id: "chat-dry", user_id: USER_ID, title: "Dry", created_at: "2024-02-01T00:00:00.000Z" },
    ];

    await importer.start({ dryRun: true, reindex: false });
    const final = await waitForImport();

    assert.equal(final.items.imported, 2);
    assert.equal(final.chats.imported, 1);
    assert.equal(store.countItems(), 0, "dry run wrote rows");
    assert.equal(store.countThreads(), 0, "dry run wrote threads");
    assert.equal(importer.status().resumable, false, "dry run saved a cursor");
  });

  test("can be cancelled mid-run", async () => {
    cloudData.vault_items = Array.from({ length: 600 }, (_, i) => makeItem(i));

    await importer.start({ reindex: false });
    importer.cancel();
    const final = await waitForImport();

    assert.equal(final.cancelled, true);
    assert.equal(final.phase, "cancelled");
    assert.ok(store.countItems() < 600, "cancel did not stop the run early");
  });

  test("leaves imported rows queued for local embedding", async () => {
    cloudData.vault_items = [makeItem(0), makeItem(1)];

    await importer.start({ reindex: false });
    await waitForImport();

    // Cloud vectors are 1536-d OpenAI and the local model is 384-d, so nothing
    // is copied; the rows must instead show up as outstanding work.
    assert.equal(localStore.indexer.pendingCount().items, 2);
    assert.equal(
      Number(db.get().prepare("SELECT COUNT(*) AS n FROM chunks").get().n),
      0,
    );
  });
});

// ---------------------------------------------------------------------------

describe("verification", () => {
  test("passes when everything arrived", async () => {
    cloudData.vault_items = [
      makeItem(0, { storage_path: `${USER_ID}/v0/original.txt`, mime_type: "text/plain" }),
      makeItem(1),
    ];
    cloudData.objects.set(`user-files/${USER_ID}/v0/original.txt`, Buffer.from("bytes"));

    await importer.start({ reindex: false });
    await waitForImport();

    const report = await importer.verify();
    assert.equal(report.ok, true);
    assert.equal(report.items.cloud, 2);
    assert.equal(report.items.missing, 0);
    assert.equal(report.blobs.missing, 0);
  });

  test("names the rows and files that did not make it", async () => {
    cloudData.vault_items = [
      makeItem(0, { storage_path: `${USER_ID}/v0/original.txt`, mime_type: "text/plain" }),
      makeItem(1),
    ];
    cloudData.objects.set(`user-files/${USER_ID}/v0/original.txt`, Buffer.from("bytes"));

    await importer.start({ reindex: false });
    await waitForImport();

    // Simulate a partial migration after the fact.
    db.get().prepare("DELETE FROM items WHERE id = ?").run(cloudData.vault_items[1].id);
    fs.rmSync(blobs.blobsDir(), { recursive: true, force: true });

    const report = await importer.verify();
    assert.equal(report.ok, false);
    assert.equal(report.items.missing, 1);
    assert.deepEqual(report.missingItems, [cloudData.vault_items[1].id]);
    assert.equal(report.blobs.missing, 1);
    assert.equal(report.missingBlobs[0].id, cloudData.vault_items[0].id);
  });
});
