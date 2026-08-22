// Run: node --test electron/localStore/embed.test.cjs
//
// Covers the on-device embedding pipeline end to end: chunking, source-text
// extraction, the model itself, and the indexer that joins them to the search
// index.
//
// The model is real. A mocked embedder would happily pass every assertion here
// while producing vectors that retrieve nothing, which is the exact failure
// this pipeline exists to prevent — so the retrieval tests assert on actual
// semantic behaviour ("find the note about revenue when asked about sales")
// rather than on shapes and call counts.
//
// Requires the model on disk: npm run model:fetch
// Skips the model-dependent tests (rather than failing) on platforms with no
// ONNX Runtime build, which is a supported configuration.

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The utility process only exists inside Electron; under `node --test` the
// embedder runs the model in this process instead.
process.env.LYKN_EMBED_IN_PROCESS = "1";

const localStore = require("./index.cjs");
const { store, search, db, embedder, indexer } = localStore;
const chunker = require("./chunker.cjs");
const sourceText = require("./sourceText.cjs");
const embedModel = require("./embedModel.cjs");

let userDataPath;
let modelAvailable = false;

before(async () => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-embed-test-"));
  localStore.configure(userDataPath);
  const status = await embedder.status();
  modelAvailable = Boolean(status.runtimeAvailable && status.modelPresent);
  if (!modelAvailable) {
    console.warn(
      `[skip] local embeddings unavailable: ${status.reason || "model not fetched"} ` +
        `(runtime=${status.runtimeAvailable}, model=${status.modelPresent})`,
    );
  }
});

after(async () => {
  localStore.shutdown();
  fs.rmSync(userDataPath, { recursive: true, force: true });
});

const paragraph = (n) =>
  `This is sentence ${n} of a long document about distributed systems. ` +
  `It discusses consensus, replication, and the trade-offs between them in some detail.`;

// ---------------------------------------------------------------------------

describe("chunker", () => {
  test("keeps a short document whole", () => {
    const chunks = chunker.chunkText("A single short note about pricing.");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "A single short note about pricing.");
  });

  test("drops text too short to be worth embedding", () => {
    assert.deepEqual(chunker.chunkText("hi"), []);
    assert.deepEqual(chunker.chunkText("   "), []);
    assert.deepEqual(chunker.chunkText(null), []);
  });

  test("splits a long document without exceeding the hard ceiling", () => {
    const text = Array.from({ length: 40 }, (_, i) => paragraph(i)).join("\n\n");
    const chunks = chunker.chunkText(text);

    assert.ok(chunks.length > 1, "expected multiple chunks");
    for (const c of chunks) {
      assert.ok(
        c.length <= chunker.CHUNK_MAX_CHARS + 400,
        `chunk of ${c.length} chars exceeds the ceiling`,
      );
    }
  });

  test("breaks on sentence boundaries rather than mid-sentence", () => {
    const text = Array.from({ length: 30 }, (_, i) => paragraph(i)).join("\n\n");
    for (const c of chunker.chunkText(text)) {
      assert.match(c, /[.!?]["')\]]?$/, `chunk ends mid-sentence: …${c.slice(-40)}`);
    }
  });

  test("overlaps consecutive chunks so a boundary fact stays findable", () => {
    const text = Array.from({ length: 30 }, (_, i) => paragraph(i)).join("\n\n");
    const chunks = chunker.chunkText(text);
    const tailOfFirst = chunks[0].slice(-80);
    assert.ok(
      chunks[1].includes(tailOfFirst),
      "second chunk should carry the last sentence of the first",
    );
  });

  test("hard-splits a single sentence larger than the ceiling", () => {
    const chunks = chunker.chunkText("word ".repeat(2000));
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= chunker.CHUNK_MAX_CHARS + 400);
  });

  test("never returns more than the chunk cap", () => {
    const huge = Array.from({ length: 500 }, (_, i) => paragraph(i)).join("\n\n");
    assert.ok(chunker.chunkText(huge).length <= chunker.MAX_CHUNKS);
  });
});

// ---------------------------------------------------------------------------

describe("source text", () => {
  test("strips only the attachments marker, keeping text on both sides", () => {
    const content = `Before the marker.\n\n[ATTACHMENTS_JSON:[{"name":"a.pdf"}]]\n\nAfter the marker.`;
    const stripped = sourceText.stripAttachmentsMarker(content);
    assert.ok(stripped.includes("Before the marker."));
    assert.ok(stripped.includes("After the marker."), "body after the marker was dropped");
    assert.ok(!stripped.includes("ATTACHMENTS_JSON"));
  });

  test("survives brackets inside attachment filenames", () => {
    const content = `[ATTACHMENTS_JSON:[{"name":"report[2025].pdf"}]]\n\nBody text.`;
    const attachments = sourceText.parseAttachments(content);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, "report[2025].pdf");
    assert.equal(sourceText.stripAttachmentsMarker(content), "Body text.");
  });

  test("surfaces vision and OCR text so media is searchable", () => {
    const content = `[ATTACHMENTS_JSON:[{"type":"image","name":"sunset.png","aiDescription":"A sunset over the ocean","extractedText":"Golden Gate Bridge"}]]`;
    const text = sourceText.itemText({ title: "Trip photo", content });
    assert.ok(text.includes("Title: Trip photo"));
    assert.ok(text.includes("A sunset over the ocean"));
    assert.ok(text.includes("Golden Gate Bridge"));
    assert.ok(!text.includes("ATTACHMENTS_JSON"));
  });

  test("includes tags and summary in the embedded text", () => {
    const text = sourceText.itemText({
      title: "Q3 plan",
      content: "Body.",
      tags: ["pricing", "roadmap"],
      ai_summary: "Plans for the third quarter.",
    });
    assert.ok(text.includes("pricing, roadmap"));
    assert.ok(text.includes("Plans for the third quarter."));
  });

  test("flattens a thread into role-prefixed lines", () => {
    const text = sourceText.threadText({ title: "Debugging" }, [
      { role: "user", content: "Why is the build failing?" },
      { role: "assistant", content: "The lockfile is out of date." },
      { role: "assistant", blocks: [{ type: "code", content: "npm ci" }] },
    ]);
    assert.ok(text.includes("Conversation: Debugging"));
    assert.ok(text.includes("user: Why is the build failing?"));
    assert.ok(text.includes("assistant: The lockfile is out of date."));
    assert.ok(text.includes("npm ci"));
  });
});

// ---------------------------------------------------------------------------

describe("embedding model", () => {
  test("reports its status without loading the model", async () => {
    const status = await embedder.status();
    assert.equal(status.model, embedModel.MODEL_TAG);
    assert.equal(status.dims, 384);
    assert.equal(typeof status.runtimeAvailable, "boolean");
  });

  test("produces normalized vectors of the expected width", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const vectors = await embedder.embedPassages(["hello world", "a second passage"]);
    assert.equal(vectors.length, 2);

    for (const v of vectors) {
      assert.ok(v instanceof Float32Array);
      assert.equal(v.length, embedModel.DIMS);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit vector, got norm ${norm}`);
    }
  });

  test("places related text closer than unrelated text", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const [revenue, sales, cat] = await embedder.embedPassages([
      "The quarterly revenue report shows a 12% increase in subscription income.",
      "Sales grew twelve percent last quarter, driven by recurring subscriptions.",
      "My cat refuses to eat the new brand of food I bought yesterday.",
    ]);
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

    const related = dot(revenue, sales);
    const unrelated = dot(revenue, cat);
    assert.ok(
      related > unrelated + 0.2,
      `related ${related.toFixed(3)} should clearly beat unrelated ${unrelated.toFixed(3)}`,
    );
  });

  test("embeds a query differently from the same text as a passage", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const text = "how do I reset my password";
    const [asPassage] = await embedder.embedPassages([text]);
    const asQuery = await embedder.embedQuery(text);

    const dot = asPassage.reduce((s, x, i) => s + x * asQuery[i], 0);
    // The query instruction has to actually change the vector, or retrieval is
    // running symmetric on an asymmetric model.
    assert.ok(dot < 0.999, "query prefix had no effect on the embedding");
    assert.ok(dot > 0.5, "query and passage embeddings should still be related");
  });

  test("is deterministic", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");
    const [a] = await embedder.embedPassages(["stable input"]);
    const [b] = await embedder.embedPassages(["stable input"]);
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  test("preserves order across an internal batch boundary", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    // Long enough to span more than one internal batch, with each document
    // distinct enough that a misalignment would be unambiguous.
    const subjects = [
      "sourdough bread baking",
      "kubernetes pod scheduling",
      "italian renaissance painting",
      "mortgage interest rates",
      "deep sea marine biology",
      "vintage motorcycle repair",
      "classical piano technique",
      "tax loss harvesting",
      "antarctic ice core samples",
      "supply chain logistics",
    ];
    const texts = Array.from(
      { length: embedModel.MAX_BATCH + 5 },
      (_, i) => `A detailed note about ${subjects[i % subjects.length]}, entry ${i}.`,
    );

    const vectors = await embedder.embedPassages(texts);
    assert.equal(vectors.length, texts.length);

    // Embedded alone, an item must still be nearest to its own slot in the
    // batched result. Exact equality is the wrong bar: a batch pads every
    // sequence to its longest member, and under int8 that shifts the values
    // very slightly (~0.995 self-similarity) without changing what they mean.
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    for (const index of [0, embedModel.MAX_BATCH - 1, embedModel.MAX_BATCH, texts.length - 1]) {
      const [solo] = await embedder.embedPassages([texts[index]]);
      let best = -1;
      let bestScore = -Infinity;
      vectors.forEach((v, i) => {
        const score = dot(solo, v);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      });
      assert.equal(best, index, `text ${index} landed at position ${best} in the batch`);
      assert.ok(bestScore > 0.98, `self-similarity too low at ${index}: ${bestScore}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("indexer", () => {
  test("records an attempt for a row with nothing embeddable", async () => {
    const item = store.putItem({ kind: "vault", title: "", content: "" });
    const result = await indexer.indexSource("item", item.id);

    assert.equal(result.status, "empty");
    assert.equal(result.chunks, 0);

    // The point of index_state: without a record here the backfill would keep
    // finding this row forever and never report itself complete.
    const state = indexer.getState("item", item.id);
    assert.ok(state, "expected an index_state row");
    assert.equal(state.chunk_count, 0);
  });

  test("indexes an item and stores one chunk row per chunk", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const item = store.putItem({
      kind: "vault",
      title: "Kubernetes incident",
      content:
        "The pods entered a crash loop because the liveness probe timed out after the sidecar " +
        "started consuming more memory than its limit allowed.",
    });

    const result = await indexer.indexItem(item.id);
    assert.equal(result.status, "indexed");
    assert.ok(result.chunks >= 1);

    const rows = db
      .get()
      .prepare("SELECT * FROM chunks WHERE source_kind = 'item' AND source_id = ?")
      .all(item.id);
    assert.equal(rows.length, result.chunks);
    assert.equal(rows[0].dims, embedModel.DIMS);
    assert.equal(rows[0].model, embedModel.MODEL_TAG);
    assert.equal(rows[0].embedding.length, embedModel.DIMS * 4);
  });

  test("skips re-embedding when the text has not changed", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const item = store.putItem({ kind: "vault", title: "Stable", content: "Unchanged body text." });
    await indexer.indexItem(item.id);

    // An autosave that rewrites the row without changing a word is the common
    // case in an editor; it must not cost an embed.
    store.updateItem(item.id, { title: "Stable" });
    const second = await indexer.indexItem(item.id);
    assert.equal(second.status, "unchanged");

    const forced = await indexer.indexItem(item.id, { force: true });
    assert.equal(forced.status, "indexed");
  });

  test("re-embeds when the text actually changes", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const item = store.putItem({ kind: "vault", title: "Draft", content: "First version." });
    await indexer.indexItem(item.id);
    const before = indexer.getState("item", item.id).text_hash;

    store.updateItem(item.id, { content: "A completely rewritten second version." });
    const result = await indexer.indexItem(item.id);

    assert.equal(result.status, "indexed");
    assert.notEqual(indexer.getState("item", item.id).text_hash, before);
  });

  test("prefixes chunks with their document title but stores them raw", () => {
    const chunks = ["First chunk body.", "Second chunk body."];
    const prefixed = indexer.withContext(chunks, "Title: Quarterly plan");

    assert.ok(prefixed[0].startsWith("Title: Quarterly plan"));
    assert.ok(prefixed[1].includes("Second chunk body."));
    // A single-chunk document already is its own context.
    assert.deepEqual(indexer.withContext(["only"], "Title: X"), ["only"]);
  });

  test("removing a source clears its chunks and its state", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const item = store.putItem({ kind: "vault", title: "Temporary", content: "Delete me soon." });
    await indexer.indexItem(item.id);
    assert.ok(indexer.getState("item", item.id));

    indexer.removeSource("item", item.id);
    assert.equal(indexer.getState("item", item.id), null);
    const rows = db
      .get()
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id = ?")
      .get(item.id);
    assert.equal(Number(rows.n), 0);
  });

  test("counts outstanding work and clears it with a backfill", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    for (let i = 0; i < 3; i += 1) {
      store.putItem({
        kind: "vault",
        title: `Backfill subject ${i}`,
        content: `Body number ${i} describing an unrelated topic in a couple of sentences.`,
      });
    }

    assert.ok(indexer.pendingCount().items >= 3);

    await indexer.backfill({ includeThreads: false });
    // backfill() returns as soon as the pass is scheduled; wait for it to end.
    for (let i = 0; i < 600 && indexer.backfillStatus().running; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const status = indexer.backfillStatus();
    assert.equal(status.running, false);
    assert.equal(status.failed, 0);
    assert.equal(status.pending.items, 0, "backfill left items outstanding");
  });

  test("indexes a chat thread from its messages", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const thread = store.putThread({ title: "Deployment planning" });
    store.appendMessage(thread.id, { role: "user", content: "When should we cut the release?" });
    store.appendMessage(thread.id, {
      role: "assistant",
      content: "Friday is risky; ship Tuesday so there is a full week to catch regressions.",
    });

    const result = await indexer.indexThread(thread.id);
    assert.equal(result.status, "indexed");

    const rows = db
      .get()
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_kind = 'thread' AND source_id = ?")
      .get(thread.id);
    assert.ok(Number(rows.n) >= 1);
  });
});

// ---------------------------------------------------------------------------

describe("retrieval", () => {
  test("finds a note by meaning when the words do not match", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const target = store.putItem({
      kind: "vault",
      title: "Feline dietary preferences",
      content:
        "My cat refuses to eat the new brand of food I bought yesterday. She sniffs the bowl, " +
        "walks away, and waits by the cupboard where the old kibble used to be kept.",
    });
    store.putItem({
      kind: "vault",
      title: "Terraform state locking",
      content: "The remote backend holds a lock in DynamoDB while an apply is in progress.",
    });
    store.putItem({
      kind: "vault",
      title: "Invoice reconciliation",
      content: "Match Stripe payouts against the ledger before closing the month.",
    });

    await indexer.indexItem(target.id);
    for (const row of indexer.pendingSources({ kind: "item", limit: 50 })) {
      await indexer.indexSource("item", row.source_id);
    }

    // No shared vocabulary with the note: "kitten" and "won't touch her dinner"
    // appear nowhere in it, so lexical search cannot be what finds this.
    const query = "kitten won't touch her dinner";
    const lexical = search.lexicalSearch(query, { limit: 10 });
    assert.ok(
      !lexical.some((h) => h.id === target.id),
      "the lexical index already matched; this test is no longer proving anything",
    );

    const results = await indexer.searchLocal(query, { limit: 5 });
    assert.ok(results.length > 0, "semantic search returned nothing");
    assert.equal(results[0].id, target.id, "expected the cat note to rank first");
    assert.ok(results[0]._sources.includes("semantic"));
  });

  test("still returns lexical hits when no query embedding is available", () => {
    const item = store.putItem({
      kind: "vault",
      title: "Postgres vacuum settings",
      content: "Autovacuum thresholds were raised to reduce write amplification.",
    });

    // Exactly what happens on a platform with no ONNX Runtime build.
    const results = search.hybridSearch("autovacuum thresholds", { queryEmbedding: null });
    assert.ok(results.some((r) => r.id === item.id));
  });

  test("a soft-deleted item drops out of semantic results", async (t) => {
    if (!modelAvailable) return t.skip("no local embedding runtime");

    const item = store.putItem({
      kind: "vault",
      title: "Sourdough starter schedule",
      content: "Feed the starter twice a day with equal parts flour and water until it doubles.",
    });
    await indexer.indexItem(item.id);

    const before = await indexer.searchLocal("bread baking routine", { limit: 5 });
    assert.ok(before.some((r) => r.id === item.id));

    store.softDeleteItem(item.id);
    search.invalidateCache();

    const after = await indexer.searchLocal("bread baking routine", { limit: 5 });
    assert.ok(!after.some((r) => r.id === item.id), "deleted item still surfaced");
  });
});
