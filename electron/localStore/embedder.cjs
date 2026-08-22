/**
 * Client for the embedding model — the API the rest of the main process uses.
 *
 * It owns the utility process from embedHost.cjs: spawning it on first use,
 * restarting it if it dies, and killing it after an idle period so a machine
 * that is not searching does not hold ~400 MB for a model it is not using.
 * Reloading costs roughly 300 ms from local disk, which is cheap enough that
 * aggressive unloading is the right trade.
 *
 * Outside Electron — under `node --test`, mainly — there is no utility process
 * to fork, so the same calls run against embedModel.cjs in this process. The
 * two paths are interchangeable by design: tests exercise the real model rather
 * than a mock of it.
 */

const path = require("node:path");

const model = require("./embedModel.cjs");

/** Kill the worker after this long with no requests. */
const IDLE_UNLOAD_MS = 5 * 60 * 1000;
/** Give a cold start room for a first-run download before giving up. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

let userDataPath = null;
let allowDownload = true;

let child = null;
let childReady = null;
let idleTimer = null;
let sequence = 0;
const pending = new Map();

// One embed at a time. Two concurrent batches would double peak memory and run
// slower than the same work done back to back, since ORT already parallelizes
// across cores internally.
let chain = Promise.resolve();

let cachedStatus = null;

function configure(options = {}) {
  userDataPath = options.userDataPath || userDataPath;
  if (typeof options.allowDownload === "boolean") allowDownload = options.allowDownload;
  cachedStatus = null;
  return { ok: true, userDataPath };
}

/** Electron's utility process API, or null when not running under Electron. */
function utilityProcessApi() {
  if (process.env.LYKN_EMBED_IN_PROCESS === "1") return null;
  try {
    const electron = require("electron");
    return electron?.utilityProcess || null;
  } catch {
    return null;
  }
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleUnload() {
  clearIdleTimer();
  if (!child || pending.size) return;
  idleTimer = setTimeout(() => {
    if (!pending.size) killChild("idle");
  }, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

function rejectAllPending(reason) {
  const err = new Error(reason);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(err);
  }
  pending.clear();
}

function killChild(why) {
  clearIdleTimer();
  const dying = child;
  child = null;
  childReady = null;
  if (!dying) return;
  try {
    dying.kill();
  } catch {
    // Already gone.
  }
  if (why !== "idle") console.warn(`[LYKN] embed worker stopped: ${why}`);
}

function spawnChild(api) {
  const proc = api.fork(path.join(__dirname, "embedHost.cjs"), [], {
    serviceName: "lykn-embeddings",
    // Surface model load errors in the app's own log rather than swallowing them.
    stdio: "inherit",
  });

  const ready = new Promise((resolve, reject) => {
    // Asymmetric by design in Electron: the parent's "message" event carries
    // the payload directly, while the child receives a MessageEvent and has to
    // read `.data`. Unwrapping `.data` here silently drops every message.
    const onMessage = (msg = {}) => {
      if (msg.type === "ready") {
        resolve(proc);
        return;
      }
      if (msg.type === "progress") {
        pending.get(msg.id)?.onProgress?.(msg.done, msg.total);
        return;
      }
      if (msg.type === "response") {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.data);
        else entry.reject(new Error(msg.error || "embed failed"));
        scheduleIdleUnload();
      }
    };

    proc.on("message", onMessage);
    proc.on("exit", (code) => {
      if (proc === child) {
        child = null;
        childReady = null;
      }
      rejectAllPending(`embed worker exited (code ${code})`);
      reject(new Error(`embed worker exited during startup (code ${code})`));
    });
  });

  return ready;
}

async function ensureChild(api) {
  if (child && childReady) return childReady;
  childReady = spawnChild(api).then((proc) => {
    child = proc;
    return proc;
  });
  childReady.catch(() => {
    child = null;
    childReady = null;
  });
  return childReady;
}

/**
 * Send one request, over the worker when available and in-process otherwise.
 * @param {string} op
 * @param {object} payload
 * @param {(done: number, total: number) => void} [onProgress]
 */
async function request(op, payload = {}, onProgress) {
  const args = { userDataPath, allowDownload, ...payload };
  const api = utilityProcessApi();

  if (!api) {
    switch (op) {
      case "ping":
        return { pong: true, pid: process.pid, inProcess: true };
      case "status":
        return model.status(args.userDataPath);
      case "load":
        await model.load(args);
        return model.status(args.userDataPath);
      case "unload":
        return model.unload();
      case "embed": {
        const vectors = await model.embed(args.texts || [], { ...args, onProgress });
        return { vectors, dims: vectors[0]?.length || model.DIMS };
      }
      default:
        throw new Error(`unknown embed op: ${op}`);
    }
  }

  const proc = await ensureChild(api);
  clearIdleTimer();

  const id = (sequence += 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // A wedged native call cannot be interrupted; restarting the worker is
      // the only reliable way back to a usable state.
      killChild("request timed out");
      reject(new Error(`embed request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();

    pending.set(id, { resolve, reject, onProgress, timer });
    proc.postMessage({ id, op, payload: args });
  });
}

/** Serialize the expensive operations; cheap ones go straight through. */
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Can this machine embed locally? Cached, because it costs a worker spawn.
 * A false answer is normal on platforms with no ONNX Runtime build (Intel
 * macOS today) and callers should fall back to lexical search.
 */
async function status() {
  if (cachedStatus) return cachedStatus;
  try {
    cachedStatus = await request("status");
  } catch (err) {
    cachedStatus = {
      model: model.MODEL_TAG,
      dims: model.DIMS,
      runtimeAvailable: false,
      reason: err?.message || "embed worker unavailable",
      modelPresent: false,
      loaded: false,
      platform: `${process.platform}/${process.arch}`,
    };
  }
  return cachedStatus;
}

async function isAvailable() {
  const s = await status();
  return Boolean(s?.runtimeAvailable);
}

/** Diagnostic: round-trip a message and report which process answered. */
async function ping() {
  return request("ping");
}

/** Load the model ahead of the first query so search does not pay for it. */
async function warmup() {
  if (!(await isAvailable())) return { ok: false, reason: (await status()).reason };
  const data = await enqueue(() => request("load"));
  cachedStatus = data;
  scheduleIdleUnload();
  return { ok: true, ...data };
}

/**
 * Embed documents for storage.
 * @param {string[]} texts
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<Float32Array[]>}
 */
async function embedPassages(texts, onProgress) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!list.length) return [];
  const data = await enqueue(() => request("embed", { texts: list, kind: "passage" }, onProgress));
  scheduleIdleUnload();
  return data.vectors;
}

/**
 * Embed a search query. Uses the model's query instruction, which is what
 * makes an asymmetric retrieval model rank passages correctly.
 * @returns {Promise<Float32Array|null>}
 */
async function embedQuery(text) {
  const q = String(text || "").trim();
  if (!q) return null;
  const data = await enqueue(() => request("embed", { texts: [q], kind: "query" }));
  scheduleIdleUnload();
  return data.vectors?.[0] || null;
}

/** Best-effort query embedding: null instead of throwing when unavailable. */
async function tryEmbedQuery(text) {
  try {
    if (!(await isAvailable())) return null;
    return await embedQuery(text);
  } catch (err) {
    console.warn("[LYKN] query embedding failed, using lexical only:", err?.message);
    return null;
  }
}

async function shutdown() {
  clearIdleTimer();
  rejectAllPending("shutting down");
  if (child) {
    killChild("shutdown");
    return { ok: true };
  }
  if (!utilityProcessApi()) await model.unload();
  return { ok: true };
}

module.exports = {
  configure,
  status,
  isAvailable,
  ping,
  warmup,
  embedPassages,
  embedQuery,
  tryEmbedQuery,
  shutdown,
  MODEL_TAG: model.MODEL_TAG,
  DIMS: model.DIMS,
  IDLE_UNLOAD_MS,
};
