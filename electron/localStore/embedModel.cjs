/**
 * The embedding model itself: resolve it on disk, load it once, turn text into
 * vectors. This is the on-device replacement for the OpenAI
 * `text-embedding-3-small` calls in synthesis-service.js.
 *
 * Model choice — bge-small-en-v1.5, int8-quantized, 384 dimensions:
 *   - 384 dims keeps the brute-force cosine scan in search.cjs cheap (measured
 *     4.4 ms at 5k chunks). The server's 1536-dim vectors would quadruple both
 *     that scan and the database size for no retrieval win at this corpus size.
 *   - int8 is 33 MB on disk instead of 127 MB, which is the difference between
 *     shipping the model inside the app and asking users to download it.
 *   - It runs at ~13 ms/chunk on Apple Silicon, so a 5,000-chunk vault
 *     re-embeds in about a minute.
 *
 * BGE models are asymmetric: passages are embedded bare, queries are embedded
 * behind a fixed instruction. Skipping that prefix on the query side measurably
 * degrades retrieval, so `embed()` takes an explicit `kind`.
 *
 * This module is deliberately free of Electron imports. It runs inside the
 * utility process (see embedHost.cjs) and directly under `node --test`.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Directory name of the bundled copy, and the hub id used to fetch it. */
const MODEL_NAME = "bge-small-en-v1.5";
const MODEL_REPO = "Xenova/bge-small-en-v1.5";
const DTYPE = "q8";
const DIMS = 384;

/**
 * Written into `chunks.model` on every row. Bump it whenever the model, its
 * quantization, or the text fed to it changes — `search.staleSources()` keys
 * off this string to decide what needs re-embedding.
 */
const MODEL_TAG = `${MODEL_NAME}-${DTYPE}`;

/** BGE's prescribed query instruction. Passages get no prefix. */
const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

const MAX_BATCH = 16;

let pipelinePromise = null;
let resolvedDir = null;

/** A directory counts as a usable model only if every required file is there. */
function isCompleteModelDir(dir) {
  if (!dir) return false;
  const required = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    path.join("onnx", `model_${DTYPE === "q8" ? "quantized" : DTYPE}.onnx`),
  ];
  return required.every((f) => {
    try {
      return fs.statSync(path.join(dir, f)).size > 0;
    } catch {
      return false;
    }
  });
}

/**
 * Where the model lives, in priority order: an explicit override, the copy
 * packaged into the app, the repo checkout used in development, then the
 * runtime download cache.
 *
 * @param {string} [userDataPath] Used only for the download fallback.
 */
function candidateDirs(userDataPath) {
  const dirs = [];
  if (process.env.LYKN_MODEL_DIR) dirs.push(process.env.LYKN_MODEL_DIR);
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, "models"));
  dirs.push(path.join(__dirname, "..", "..", "models"));
  if (userDataPath) dirs.push(path.join(userDataPath, "models"));
  return dirs;
}

function findLocalModel(userDataPath) {
  for (const base of candidateDirs(userDataPath)) {
    if (isCompleteModelDir(path.join(base, MODEL_NAME))) return base;
  }
  return null;
}

/**
 * Is a local embedding backend possible on this machine at all?
 *
 * onnxruntime-node ships prebuilt binaries per platform and has no Intel macOS
 * build, so `require` throws there. That is a supported outcome, not a bug: the
 * caller degrades to lexical-only search rather than failing.
 */
function probeRuntime() {
  try {
    require.resolve("onnxruntime-node");
  } catch {
    return { available: false, reason: "onnxruntime-node is not installed" };
  }
  try {
    require("onnxruntime-node");
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: `no native runtime for ${process.platform}/${process.arch}: ${err?.message || err}`,
    };
  }
}

/**
 * Load the feature-extraction pipeline. Concurrent callers share one promise so
 * a burst of requests during startup cannot load the model twice (~400 MB
 * resident each).
 *
 * @param {object} [opts]
 * @param {string} [opts.userDataPath]
 * @param {boolean} [opts.allowDownload=true] When false, a missing local model
 *   is an error instead of a network fetch. Packaged builds ship the model, so
 *   a download there means something went wrong with packaging.
 */
function load({ userDataPath, allowDownload = true, device = "cpu" } = {}) {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");

    const localBase = findLocalModel(userDataPath);
    let modelId;

    if (localBase) {
      env.localModelPath = localBase;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      modelId = MODEL_NAME;
      resolvedDir = path.join(localBase, MODEL_NAME);
    } else {
      if (!allowDownload) {
        throw new Error(
          `embedding model not found in: ${candidateDirs(userDataPath).join(", ")}`,
        );
      }
      env.allowRemoteModels = true;
      env.cacheDir = path.join(userDataPath || path.join(__dirname, "..", ".."), "models-cache");
      modelId = MODEL_REPO;
      resolvedDir = env.cacheDir;
    }

    // Leave the machine usable while a long backfill runs. ORT would otherwise
    // spin up one intra-op thread per core and make the whole desktop stutter.
    const cores = require("node:os").cpus()?.length || 4;
    const session_options = { intraOpNumThreads: Math.max(1, Math.floor(cores / 2)) };

    return pipeline("feature-extraction", modelId, { dtype: DTYPE, device, session_options });
  })();

  // A failed load must not be cached, or every later attempt replays the error.
  pipelinePromise.catch(() => {
    pipelinePromise = null;
  });

  return pipelinePromise;
}

/** Split a Tensor's flat buffer into one owned Float32Array per input row. */
function splitRows(tensor, count) {
  const flat = tensor.data;
  const dims = flat.length / count;
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = new Float32Array(flat.subarray(i * dims, (i + 1) * dims));
  }
  return out;
}

/**
 * Embed text. Returns one L2-normalized Float32Array per input, in order.
 *
 * @param {string[]} texts
 * @param {object} [opts]
 * @param {"passage"|"query"} [opts.kind="passage"]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<Float32Array[]>}
 */
async function embed(texts, { kind = "passage", onProgress, ...loadOpts } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t == null ? "" : t))
    .map((t) => (kind === "query" ? `${QUERY_INSTRUCTION}${t}` : t));
  if (!list.length) return [];

  const extractor = await load(loadOpts);
  const out = [];

  for (let i = 0; i < list.length; i += MAX_BATCH) {
    const batch = list.slice(i, i + MAX_BATCH);
    // Mean pooling + normalize matches how bge-small was trained and lets
    // search.cjs treat similarity as a plain dot product.
    const tensor = await extractor(batch, { pooling: "mean", normalize: true });
    out.push(...splitRows(tensor, batch.length));
    if (onProgress) onProgress(Math.min(i + batch.length, list.length), list.length);
  }

  return out;
}

/** Embed one string. */
async function embedOne(text, opts = {}) {
  const [vec] = await embed([text], opts);
  return vec || null;
}

/** Drop the loaded session so its memory can be reclaimed. */
async function unload() {
  const pending = pipelinePromise;
  pipelinePromise = null;
  resolvedDir = null;
  if (!pending) return { ok: true, unloaded: false };
  try {
    const extractor = await pending;
    await extractor?.dispose?.();
  } catch {
    // Nothing useful to do if teardown fails; the process exit will reclaim it.
  }
  return { ok: true, unloaded: true };
}

function status(userDataPath) {
  const runtime = probeRuntime();
  const localBase = findLocalModel(userDataPath);
  return {
    model: MODEL_TAG,
    dims: DIMS,
    runtimeAvailable: runtime.available,
    reason: runtime.reason || null,
    modelPresent: Boolean(localBase),
    modelDir: resolvedDir || (localBase ? path.join(localBase, MODEL_NAME) : null),
    loaded: Boolean(pipelinePromise),
    platform: `${process.platform}/${process.arch}`,
  };
}

module.exports = {
  load,
  embed,
  embedOne,
  unload,
  status,
  probeRuntime,
  findLocalModel,
  isCompleteModelDir,
  MODEL_NAME,
  MODEL_REPO,
  MODEL_TAG,
  QUERY_INSTRUCTION,
  DIMS,
  DTYPE,
  MAX_BATCH,
};
