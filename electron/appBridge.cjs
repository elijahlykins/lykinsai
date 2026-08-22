/**
 * Main-process half of the installed-app bridge.
 *
 * Everything an app can do to the world outside itself passes through here.
 * The one invariant that makes the rest safe: **the app id comes from the
 * calling frame's origin, never from the message**. Chromium guarantees the
 * origin of `lykn-app://<id>/`, and an app cannot script its own origin into
 * something else, so `db.get` is scoped to the caller by construction rather
 * than by the caller behaving.
 *
 * Capabilities are declared in the app's manifest and granted by the user.
 * A declared capability is only a request; `grants` on the app row is the
 * answer, and only the answer is consulted at call time.
 */

const { dialog, ipcMain, BrowserWindow } = require("electron");

const apps = require("./localStore/apps.cjs");
const localStore = require("./localStore/index.cjs");
const appProtocol = require("./appProtocol.cjs");

/** Reserved collection backing the localStorage shim. */
const LOCAL_STORAGE_COLLECTION = "__localStorage";

/**
 * What each capability lets an app reach, in the words the user sees when
 * they are asked. Written as consequences rather than API names, because
 * "files.read" means nothing to someone deciding whether to trust a to-do app.
 */
const CAPABILITIES = {
  storage: {
    label: "Store its own data",
    detail: "Save data on this device. Only this app can read it.",
    implicit: true,
  },
  "vault.read": {
    label: "Read your vault",
    detail: "Search and read notes, files, and saved items in your LYKN vault.",
  },
  "vault.write": {
    label: "Add to your vault",
    detail: "Create new notes and items in your LYKN vault.",
  },
  "files.read": {
    label: "Read your files",
    detail: "Read files in the folders you have synced with LYKN.",
  },
  ai: {
    label: "Ask LYKN",
    detail: "Send text to the model and use the reply. Uses your LYKN usage.",
  },
  net: {
    label: "Access the internet",
    detail: "Send requests to the websites listed in the app's manifest.",
  },
};

/** Which capability each bridge operation requires. Absent means implicit. */
const OP_CAPABILITY = {
  "vault.search": "vault.read",
  "vault.get": "vault.read",
  "vault.list": "vault.read",
  "vault.create": "vault.write",
  "files.list": "files.read",
  "files.read": "files.read",
  "ai.complete": "ai",
  "net.fetch": "net",
};

let hooks = {
  /** @type {null | ((prompt: string, opts: object) => Promise<string>)} */
  onAiComplete: null,
  /** @type {null | ((dirPath: string) => Promise<any>)} */
  onFilesList: null,
  /** @type {null | ((filePath: string) => Promise<any>)} */
  onFilesRead: null,
};

function configure(next = {}) {
  hooks = { ...hooks, ...next };
}

// ---------------------------------------------------------------------------
// Identity + permissions
// ---------------------------------------------------------------------------

/**
 * Resolve which app is calling from the sender's frame.
 *
 * Returns null for any frame that is not an installed app, which is what stops
 * the main renderer (or a compromised page inside it) from using this channel
 * as a way to read every app's data.
 */
function callerAppId(event) {
  const frame = event?.senderFrame;
  const url = frame?.url || event?.sender?.getURL?.() || "";
  const id = appProtocol.appIdFromOrigin(url);
  if (!id) return null;
  const app = apps.getApp(id);
  return app && !app.deleted_at ? id : null;
}

function grantedList(app) {
  const grants = app?.grants && typeof app.grants === "object" ? app.grants : {};
  return Object.keys(grants).filter((k) => grants[k] === true);
}

function hasCapability(app, capability) {
  if (!capability) return true;
  if (CAPABILITIES[capability]?.implicit) return true;
  return app?.grants?.[capability] === true;
}

/**
 * Ask the user once, then remember the answer.
 *
 * Denial is persisted too — an app that was told no must not be able to
 * re-prompt on every keystroke until the user gives in.
 */
async function ensureCapability(appId, capability) {
  if (!capability || CAPABILITIES[capability]?.implicit) return true;

  const app = apps.getApp(appId);
  if (!app) return false;
  if (app.grants?.[capability] === true) return true;
  if (app.grants?.[capability] === false) return false;

  const declared = Array.isArray(app.capabilities) ? app.capabilities : [];
  if (!declared.includes(capability)) {
    // Not in the manifest the user reviewed at install time. Refuse outright
    // rather than prompting, so an app cannot widen its own reach later.
    return false;
  }

  const meta = CAPABILITIES[capability] || { label: capability, detail: "" };
  const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
  const opts = {
    type: "question",
    buttons: ["Don't allow", "Allow"],
    defaultId: 0,
    cancelId: 0,
    title: "App permission",
    message: `Allow "${app.name}" to ${meta.label.toLowerCase()}?`,
    detail: meta.detail,
  };

  const result = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);
  const allowed = result?.response === 1;

  apps.updateApp(appId, { grants: { ...(app.grants || {}), [capability]: allowed } });
  return allowed;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const OPERATIONS = {
  "db.get": (appId, a) => apps.dataGet(appId, a.collection, a.key),
  "db.set": (appId, a) => apps.dataSet(appId, a.collection, a.key, a.value),
  "db.setMany": (appId, a) => apps.dataSetMany(appId, a.collection, a.entries || []),
  "db.delete": (appId, a) => apps.dataDelete(appId, a.collection, a.key),
  "db.list": (appId, a) => apps.dataList(appId, a.collection, { limit: a.limit, after: a.after }),
  "db.search": (appId, a) => apps.dataSearch(appId, a.collection, a.query, { limit: a.limit }),
  "db.count": (appId, a) => apps.dataCount(appId, a.collection),
  "db.clear": (appId, a) => apps.dataClear(appId, a.collection),
  "db.collections": (appId) =>
    apps.dataCollections(appId).filter((c) => c.collection !== LOCAL_STORAGE_COLLECTION),

  "localStorage.write": (appId, a) =>
    a.value == null
      ? apps.dataDelete(appId, LOCAL_STORAGE_COLLECTION, a.key)
      : apps.dataSet(appId, LOCAL_STORAGE_COLLECTION, a.key, String(a.value)),

  "vault.search": async (_appId, a) => {
    const res = await localStore.indexer.searchLocal(String(a.query || ""), {
      limit: Math.min(Number(a.limit) || 20, 50),
    });
    // Hand back only what an app needs to show a result. Blob paths and
    // internal columns stay on this side of the bridge.
    return (Array.isArray(res) ? res : res?.results || []).map((r) => ({
      id: r.id,
      title: r.title,
      content: typeof r.content === "string" ? r.content.slice(0, 4000) : null,
      created_at: r.created_at,
    }));
  },
  "vault.get": (_appId, a) => {
    const item = localStore.store.getItem(String(a.id || ""));
    if (!item) return null;
    return { id: item.id, title: item.title, content: item.content, tags: item.tags, created_at: item.created_at };
  },
  "vault.list": (_appId, a) =>
    localStore.store
      .listItems({ kind: "vault", limit: Math.min(Number(a.limit) || 50, 200) })
      .map((i) => ({ id: i.id, title: i.title, created_at: i.created_at })),
  "vault.create": async (appId, a) => {
    const item = a.item || {};
    const saved = await localStore.saveAndIndexItem({
      kind: "vault",
      title: String(item.title || "Untitled").slice(0, 300),
      content: String(item.content || ""),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 20).map(String) : [],
      // Provenance so the user can see which app wrote this into their vault.
      source: `app:${appId}`,
      origin: "app",
    });
    return { id: saved.id, title: saved.title };
  },

  "files.list": async (_appId, a) => {
    if (!hooks.onFilesList) throw new Error("file access is not available");
    return hooks.onFilesList(String(a.path || ""));
  },
  "files.read": async (_appId, a) => {
    if (!hooks.onFilesRead) throw new Error("file access is not available");
    return hooks.onFilesRead(String(a.path || ""));
  },

  "ai.complete": async (_appId, a) => {
    if (!hooks.onAiComplete) throw new Error("the model is not available right now");
    const prompt = String(a.prompt || "").slice(0, 8000);
    if (!prompt.trim()) throw new Error("prompt is required");
    return hooks.onAiComplete(prompt, { maxTokens: Math.min(Number(a.maxTokens) || 800, 2000) });
  },

  "net.fetch": async (appId, a) => {
    const app = apps.getApp(appId);
    const url = String(a.url || "");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`invalid URL: ${url}`);
    }
    if (parsed.protocol !== "https:") throw new Error("only https:// requests are allowed");

    // The manifest names the hosts; anything else is refused even with `net`
    // granted, so a to-do app that asked for one API cannot become a tunnel.
    const allowed = Array.isArray(app?.capabilities)
      ? app.capabilities
          .filter((c) => typeof c === "string" && c.startsWith("net:"))
          .map((c) => c.slice(4).toLowerCase())
      : [];
    if (!allowed.includes(parsed.hostname.toLowerCase())) {
      throw new Error(
        `${parsed.hostname} is not in this app's allowed hosts (${allowed.join(", ") || "none"})`,
      );
    }

    const res = await fetch(url, {
      method: String(a.method || "GET").toUpperCase(),
      headers: a.headers && typeof a.headers === "object" ? a.headers : undefined,
      body: a.body != null ? String(a.body) : undefined,
      redirect: "follow",
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text.slice(0, 500_000) };
  },

  "permission.request": async (appId, a) => {
    const capability = String(a.capability || "");
    if (!CAPABILITIES[capability]) throw new Error(`unknown capability: ${capability}`);
    return ensureCapability(appId, capability);
  },

  "app.close": (appId, _a, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return { ok: true, id: appId };
  },
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Most recent runtime errors per app, for the build agent's verify pass. */
const runtimeErrors = new Map();

function recordRuntimeError(appId, payload) {
  if (!appId) return;
  // The shell reports its whole lifecycle on this channel, not just failures.
  // Recording "ready" as an error would make every working app look broken to
  // the verify pass.
  const type = String(payload?.type || "");
  if (!type || type === "ready") return;

  const list = runtimeErrors.get(appId) || [];
  list.push({
    type,
    message: String(payload?.message || "").slice(0, 800),
    at: Date.now(),
  });
  runtimeErrors.set(appId, list.slice(-20));
}

function takeRuntimeErrors(appId) {
  const list = runtimeErrors.get(appId) || [];
  runtimeErrors.delete(appId);
  return list;
}

function bind() {
  ipcMain.handle("lykn:app-bridge", async (event, { op, args } = {}) => {
    const name = String(op || "");
    const appId = callerAppId(event);
    if (!appId) return { ok: false, error: "not an installed app" };

    const handler = OPERATIONS[name];
    if (!handler) return { ok: false, error: `unknown operation: ${name}` };

    try {
      const capability = OP_CAPABILITY[name];
      if (capability) {
        const allowed = await ensureCapability(appId, capability);
        if (!allowed) {
          return { ok: false, error: `"${CAPABILITIES[capability].label}" is not allowed for this app` };
        }
      }
      const data = await handler(appId, args || {}, event);
      return { ok: true, data };
    } catch (err) {
      console.error(`[LYKN] app bridge ${name} failed for ${appId}:`, err?.message);
      return { ok: false, error: err?.message || "operation failed" };
    }
  });

  // Synchronous reads used during preload, before the app's own code runs.
  ipcMain.on("lykn:app-bridge-sync", (event, { op } = {}) => {
    const appId = callerAppId(event);
    if (!appId) {
      event.returnValue = null;
      return;
    }
    try {
      if (op === "app.meta") {
        const app = apps.getApp(appId);
        event.returnValue = app
          ? { id: app.id, name: app.name, version: app.version, granted: grantedList(app) }
          : null;
        return;
      }
      if (op === "localStorage.snapshot") {
        const rows = apps.dataList(appId, LOCAL_STORAGE_COLLECTION, { limit: 1000 });
        event.returnValue = Object.fromEntries(rows.map((r) => [r.key, String(r.value ?? "")]));
        return;
      }
    } catch (err) {
      console.error("[LYKN] app bridge sync failed:", err?.message);
    }
    event.returnValue = null;
  });

  ipcMain.on("lykn:app-report", (event, payload) => {
    recordRuntimeError(callerAppId(event), payload);
  });
}

module.exports = {
  CAPABILITIES,
  LOCAL_STORAGE_COLLECTION,
  configure,
  bind,
  callerAppId,
  ensureCapability,
  hasCapability,
  grantedList,
  recordRuntimeError,
  takeRuntimeErrors,
};
