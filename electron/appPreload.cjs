/**
 * The bridge an installed app sees as `window.lykn`.
 *
 * This is a privilege boundary, so two rules shape everything below:
 *
 *   1. The app id is NEVER sent from here. Main derives it from the calling
 *      frame's origin, which Chromium enforces and the app's own JavaScript
 *      cannot forge. An app asking for another app's data has no way to say so.
 *   2. `ipcRenderer` is never exposed, directly or transitively. Everything
 *      goes through named operations on one channel that main validates.
 *
 * `lykn.db` is the durable path and needs no permission — an app's own data is
 * its own business. Everything that reaches outside the app (the vault, files,
 * the model) is capability-gated and prompts the user on first use.
 */

const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "lykn:app-bridge";
const SYNC_CHANNEL = "lykn:app-bridge-sync";

/**
 * Unwrap main's `{ ok, data }` envelope. A rejected IPC promise loses its stack
 * across the bridge, so main always resolves and the error is re-thrown here
 * where the app's own try/catch can see a real Error.
 */
async function call(op, args = {}) {
  const res = await ipcRenderer.invoke(CHANNEL, { op, args });
  if (!res || res.ok !== true) {
    throw new Error(res?.error || `lykn.${op} failed`);
  }
  return res.data;
}

const appMeta = (() => {
  try {
    return ipcRenderer.sendSync(SYNC_CHANNEL, { op: "app.meta" }) || {};
  } catch {
    return {};
  }
})();

// ---------------------------------------------------------------------------
// localStorage, redirected into the app's database
// ---------------------------------------------------------------------------
//
// localStorage genuinely works on this origin, so an app that uses it is not
// broken — but that data sits outside SQLite, which means it is not in the
// user's backup, not in the storage readout, and not deleted when they
// uninstall the app. Models reach for localStorage by reflex, so rather than
// only asking them not to, the API is repointed at the same store lykn.db
// writes to.
//
// The Storage API is synchronous and IPC is not, so a snapshot is loaded once
// during preload and writes go through to disk in the background. Reads stay
// synchronous and correct because this frame is the only writer.
//
// Context isolation means this preload cannot redefine `window.localStorage`
// for the app — that global lives in a different world. So the methods are
// exposed across the bridge and the boot document installs them, which is the
// only place with access to the world the app actually runs in.
function buildLocalStorageShim() {
  let cache;
  try {
    cache = new Map(Object.entries(ipcRenderer.sendSync(SYNC_CHANNEL, { op: "localStorage.snapshot" }) || {}));
  } catch {
    return null;
  }

  const flush = (key, value) => {
    // Fire-and-forget: a failed write must not turn a synchronous setItem into
    // an unhandled rejection inside the app.
    ipcRenderer.invoke(CHANNEL, { op: "localStorage.write", args: { key, value } }).catch(() => {});
  };

  // Plain functions only: contextBridge copies values across the boundary, so
  // a `length` getter would arrive frozen at its value on load. The shell turns
  // `size()` back into a live `length` property on its side.
  return {
    getItem(key) {
      const k = String(key);
      return cache.has(k) ? cache.get(k) : null;
    },
    setItem(key, value) {
      const k = String(key);
      const v = String(value);
      cache.set(k, v);
      flush(k, v);
    },
    removeItem(key) {
      const k = String(key);
      cache.delete(k);
      flush(k, null);
    },
    clear() {
      for (const k of [...cache.keys()]) flush(k, null);
      cache.clear();
    },
    key(index) {
      return [...cache.keys()][Number(index)] ?? null;
    },
    size() {
      return cache.size;
    },
    keys() {
      return [...cache.keys()];
    },
  };
}

const localStorageShim = buildLocalStorageShim();

// ---------------------------------------------------------------------------
// window.lykn
// ---------------------------------------------------------------------------

/**
 * The app's own database. Always available, scoped to this app, durable, and
 * included in the user's backup.
 *
 * A `collection` is this app's equivalent of a table; `key` identifies a row
 * within it. Values are any JSON-serializable structure.
 */
const dbApi = {
  get: (collection, key) => call("db.get", { collection, key }),
  set: (collection, key, value) => call("db.set", { collection, key, value }),
  setMany: (collection, entries) => call("db.setMany", { collection, entries }),
  delete: (collection, key) => call("db.delete", { collection, key }),
  /** Newest first. Pass `after` from the last row to page. */
  list: (collection, opts = {}) => call("db.list", { collection, ...opts }),
  /** Substring match across each row's JSON. */
  search: (collection, query, opts = {}) => call("db.search", { collection, query, ...opts }),
  count: (collection) => call("db.count", { collection }),
  clear: (collection) => call("db.clear", { collection }),
  collections: () => call("db.collections", {}),
};

/** Gated: reads and writes the user's vault, shared across every app. */
const vaultApi = {
  search: (query, opts = {}) => call("vault.search", { query, ...opts }),
  get: (id) => call("vault.get", { id }),
  list: (opts = {}) => call("vault.list", opts),
  create: (item) => call("vault.create", { item }),
};

/** Gated: read-only access to files the user has shared with LYKN. */
const filesApi = {
  list: (dirPath) => call("files.list", { path: dirPath }),
  read: (filePath) => call("files.read", { path: filePath }),
};

/** Gated: ask the model a question from inside the app. */
const aiApi = {
  complete: (prompt, opts = {}) => call("ai.complete", { prompt, ...opts }),
};

/** Gated: outbound HTTP, checked against the manifest's declared hosts. */
const netApi = {
  fetch: (url, opts = {}) => call("net.fetch", { url, ...opts }),
};

contextBridge.exposeInMainWorld("lykn", {
  app: {
    id: appMeta.id || null,
    name: appMeta.name || null,
    version: appMeta.version || 1,
    /** Capabilities the user actually granted, not merely those requested. */
    granted: appMeta.granted || [],
  },
  db: dbApi,
  vault: vaultApi,
  files: filesApi,
  ai: aiApi,
  net: netApi,

  /**
   * Request a capability the manifest declared. Resolves true once granted.
   * Calling a gated method without this prompts anyway; this exists so an app
   * can ask at a sensible moment instead of mid-interaction.
   */
  requestPermission: (capability) => call("permission.request", { capability }),

  /** Close the app window from inside the app. */
  close: () => call("app.close", {}),

  // Installed by the boot document as `window.localStorage`. Not for apps to
  // call directly — it exists so code written against the Storage API stores
  // into the app's database instead of into browser state we cannot back up.
  __storage: localStorageShim,

  // The shell's error reporter looks for this so a crash still reaches the
  // build agent when the app runs in its own window with no opener.
  __report: (payload) => {
    ipcRenderer.send("lykn:app-report", payload || {});
  },
});
