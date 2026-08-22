/**
 * Utility-process entry point for the embedding model.
 *
 * Why a separate process at all: a loaded session sits at roughly 400 MB
 * resident, and tokenization is synchronous JavaScript. Running it in the main
 * process would both inflate the app's baseline memory for every user —
 * including those who never search — and stutter the UI during a backfill.
 * Out here the memory is reclaimable by killing the process, and a crash in
 * native ONNX code takes down a worker instead of the app.
 *
 * The protocol is a request/response pair keyed by `id`, plus unsolicited
 * `progress` notifications during long batches. It is spoken by embedder.cjs.
 */

const model = require("./embedModel.cjs");

const port = process.parentPort;

function send(message) {
  try {
    port.postMessage(message);
  } catch {
    // Parent went away mid-flight; nothing to report to.
  }
}

const HANDLERS = {
  ping: () => ({ pong: true, pid: process.pid }),
  status: (payload) => model.status(payload?.userDataPath),
  load: async (payload) => {
    await model.load(payload || {});
    return model.status(payload?.userDataPath);
  },
  unload: () => model.unload(),
  embed: async (payload, id) => {
    const vectors = await model.embed(payload?.texts || [], {
      kind: payload?.kind || "passage",
      userDataPath: payload?.userDataPath,
      allowDownload: payload?.allowDownload !== false,
      onProgress: (done, total) => send({ type: "progress", id, done, total }),
    });
    // Float32Arrays survive structured clone, so vectors cross the boundary
    // without a JSON round-trip through arrays of doubles.
    return { vectors, dims: vectors[0]?.length || model.DIMS };
  },
};

port.on("message", async (event) => {
  const msg = event?.data || {};
  const { id, op, payload } = msg;
  const handler = HANDLERS[op];

  if (!handler) {
    send({ type: "response", id, ok: false, error: `unknown embed op: ${op}` });
    return;
  }

  try {
    const data = await handler(payload, id);
    send({ type: "response", id, ok: true, data });
  } catch (err) {
    send({ type: "response", id, ok: false, error: err?.message || String(err) });
  }
});

port.start?.();
send({ type: "ready", pid: process.pid });
