/**
 * Smoke test for the embedding pipeline inside a real Electron process.
 *
 * `npm run test:embed` runs the model in-process, because `node --test` has no
 * utility process to fork. That leaves the path that actually ships untested:
 * spawning embedHost.cjs, passing Float32Arrays across the process boundary,
 * and tearing the worker down without hanging the app. Those only fail under
 * Electron, so they need Electron to catch.
 *
 * Run: npm run verify:embed
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { app } = require("electron");

const localStore = require("../electron/localStore/index.cjs");

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-embed-verify-"));
  console.log(`electron ${process.versions.electron} | node ${process.versions.node}`);
  console.log(`userData: ${userDataPath}\n`);

  localStore.configure(userDataPath);
  const { store, embedder, indexer, search } = localStore;

  const pong = await embedder.ping();
  check(
    "embedding runs in a separate process",
    Boolean(pong?.pid) && pong.pid !== process.pid && !pong.inProcess,
    `worker pid ${pong?.pid}, main pid ${process.pid}`,
  );

  const status = await embedder.status();
  check("onnx runtime is available", status.runtimeAvailable === true, status.reason || "");
  check("model is bundled on disk", status.modelPresent === true, status.modelDir || "not found");

  if (!status.runtimeAvailable || !status.modelPresent) {
    console.log("\nCannot continue without a runtime and a model. Run: npm run model:fetch");
    return false;
  }

  const warm = await embedder.warmup();
  check("model warms up", warm.ok === true, warm.reason || "");

  const vectors = await embedder.embedPassages(["a passage to embed", "and another one"]);
  check(
    "Float32Array vectors survive the process boundary",
    vectors.length === 2 &&
      vectors[0] instanceof Float32Array &&
      vectors[0].length === embedder.DIMS,
    `${vectors.length} vectors of ${vectors[0]?.length} dims, type ${vectors[0]?.constructor?.name}`,
  );

  const norm = Math.sqrt(vectors[0].reduce((s, x) => s + x * x, 0));
  check("vectors arrive normalized, not truncated", Math.abs(norm - 1) < 1e-3, `norm ${norm.toFixed(6)}`);

  const target = store.putItem({
    kind: "vault",
    title: "Feline dietary preferences",
    content:
      "My cat refuses to eat the new brand of food I bought yesterday. She sniffs the bowl and " +
      "walks away, waiting by the cupboard where the old kibble used to be kept.",
  });
  store.putItem({
    kind: "vault",
    title: "Terraform state locking",
    content: "The remote backend holds a lock in DynamoDB while an apply is in progress.",
  });

  for (const row of indexer.pendingSources({ kind: "item", limit: 50 })) {
    await indexer.indexSource("item", row.source_id);
  }
  check("indexing leaves nothing outstanding", indexer.pendingCount().items === 0);

  const query = "kitten won't touch her dinner";
  const lexical = search.lexicalSearch(query, { limit: 10 });
  const results = await indexer.searchLocal(query, { limit: 5 });
  check(
    "semantic search finds a note sharing no words with the query",
    results[0]?.id === target.id && !lexical.some((h) => h.id === target.id),
    `top hit "${results[0]?.title}", lexical found ${lexical.length}`,
  );

  const progress = [];
  await embedder.embedPassages(
    Array.from({ length: 40 }, (_, i) => `progress probe number ${i}`),
    (done, total) => progress.push([done, total]),
  );
  check(
    "progress events cross the boundary during long batches",
    progress.length >= 2 && progress[progress.length - 1][0] === 40,
    `${progress.length} updates, last ${JSON.stringify(progress[progress.length - 1])}`,
  );

  await embedder.shutdown();
  const afterKill = await embedder.ping();
  check(
    "worker restarts after shutdown",
    Boolean(afterKill?.pid) && afterKill.pid !== pong.pid,
    `new pid ${afterKill?.pid}`,
  );

  localStore.shutdown();
  fs.rmSync(userDataPath, { recursive: true, force: true });
  return checks.every((c) => c.passed);
}

app.whenReady().then(
  async () => {
    let ok = false;
    try {
      ok = await main();
    } catch (err) {
      console.error("\nverification threw:", err?.stack || err);
    }
    const failed = checks.filter((c) => !c.passed).length;
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    app.exit(ok ? 0 : 1);
  },
  (err) => {
    console.error("electron failed to start:", err);
    app.exit(1);
  },
);
