"use strict";

/**
 * Local MCP host — the ONE authority for MCP servers that run on THIS
 * machine (Blender, Ableton, any stdio server the user connects).
 *
 * Server-side MCP (server/routes/mcp.routes.js) owns REMOTE connectors and
 * their OAuth tokens; it never dials the user's desktop. This host owns the
 * other half: spawning local stdio servers (electron/mcp/stdioMcpClient.cjs),
 * persisting the user's connections across restarts, searching their tools,
 * and gating consequential calls behind the Local Mode approval contract.
 *
 * Reached from two directions:
 *   - Settings UI via `lykn:desktop-mcp` IPC (add / reconnect / remove / list)
 *   - The model via local_mcp_search_tools / local_mcp_call_tool, executed in
 *     the renderer (localToolExecutor.ts → IPC → here)
 *
 * Consequence model: read-shaped tools (get_/list_/screenshot_…) run
 * immediately; anything that mutates the app needs a main-issued approval
 * token ONCE, after which that tool is remembered as approved for that
 * connection. That keeps "act → read state → act" loops fluid without ever
 * letting the model self-approve.
 *
 * Commands come from the user, not the model, and still pass
 * localCommandPolicy (argv-only, no shells, no metacharacters). Tool RESULTS
 * can carry images (a Blender viewport screenshot); those surface as
 * `imageDataUrl`, which the chat agent loop attaches to the model as real
 * pixels — the render-look-refine loop for desktop apps.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { startStdioMcpClient } = require("./stdioMcpClient.cjs");
const { resolveCatalogEntry } = require("./desktopMcpCatalog.cjs");
const {
  parseLocalCommand,
  assertLocalCommandSafe,
  assertWorkingDirectorySafe,
  desktopChildEnv,
} = require("./localCommandPolicy.cjs");

const STORE_FILE = "desktop-mcp-connections.json";
const MAX_CONNECTIONS = 12;
const MAX_TOOLS_PER_SERVER = 200;
const MAX_DESCRIPTION_CHARS = 400;
const MAX_SCHEMA_JSON_CHARS = 4_000;
const MAX_SEARCH_RESULTS = 10;
const MAX_SUMMARY_TOOLS = 6;
const MAX_RESULT_TEXT_CHARS = 24_000;
const MAX_IMAGE_DATA_CHARS = 6_000_000;

// Tool names that only observe the app. Everything else mutates it and takes
// the approval lane. Names come from server authors, so match on the verb
// prefix rather than trying to enumerate the world.
const READ_TOOL_RE =
  /^(get|list|read|search|find|show|describe|inspect|status|screenshot|capture|view|query|fetch|check|ping|info)([_\-.]|$)/i;

/** "get_scene_info" → "read" (runs free); "execute_blender_code" → "consequential" (gated). */
function classifyConsequence(toolName) {
  return READ_TOOL_RE.test(String(toolName || "")) ? "read" : "consequential";
}

// ---------------------------------------------------------------------------
// Companion-app bridge failures
// ---------------------------------------------------------------------------
// Many local MCP servers (FreeCAD, Blender, SketchUp, Unity…) are a thin
// bridge to an automation server running INSIDE the app, started manually
// each session. When the app crashes or restarts, the stdio bridge stays
// alive but every call fails with "connection refused" — an error that tells
// the model nothing about the fix. Recognize that shape and attach the
// catalog entry's setup steps, so the model relays the exact click path
// ("switch to the MCP Addon workbench and start the RPC server") instead of
// a vague "reopen the app".

const COMPANION_UNREACHABLE_RE =
  /(connection refused|errno 61|econnrefused|connection reset|failed to connect|could not connect|cannot connect|connect(?:ion)?(?:\s+attempt)? timed?(?:\s+|-)?out|no connection could be made|actively refused)/i;

function companionRecoveryGuidance(rowName) {
  let steps = [];
  try {
    const entry = resolveCatalogEntry(rowName);
    if (Array.isArray(entry?.setup)) steps = entry.setup.filter(Boolean);
  } catch {
    /* catalog lookup is best-effort */
  }
  const perApp = steps.length ? ` For ${rowName}: ${steps.join(". ")}.` : "";
  return (
    `${rowName}'s connector is running but the app itself is not answering — its ` +
    `in-app automation server is not listening. It usually must be started inside ` +
    `the app every session and does NOT come back on its own after the app ` +
    `restarts or recovers from a crash.${perApp} Tell the user the exact step to ` +
    `perform inside the app, wait for their confirmation, then retry this call. ` +
    `Do not restart the connector; the missing piece is inside the app.`
  );
}

function trimTool(tool) {
  const out = {
    name: String(tool?.name || "").slice(0, 120),
    description: String(tool?.description || "").slice(0, MAX_DESCRIPTION_CHARS),
  };
  try {
    if (tool?.inputSchema && JSON.stringify(tool.inputSchema).length <= MAX_SCHEMA_JSON_CHARS) {
      out.inputSchema = tool.inputSchema;
    }
  } catch {
    /* unserialisable schema — omit */
  }
  return out;
}

/** MCP content blocks → { text, imageDataUrl } the chat loop understands. */
function foldResultContent(blocks) {
  const texts = [];
  let imageDataUrl = null;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === "text") {
      texts.push(String(block.text || ""));
    } else if (block?.type === "image" && !imageDataUrl && block.data) {
      const url = `data:${block.mimeType || "image/png"};base64,${block.data}`;
      if (url.length <= MAX_IMAGE_DATA_CHARS) imageDataUrl = url;
    } else if (block?.type === "resource" && block.resource?.text) {
      texts.push(String(block.resource.text));
    }
  }
  let text = texts.join("\n").trim();
  let truncated = false;
  if (text.length > MAX_RESULT_TEXT_CHARS) {
    text = text.slice(0, MAX_RESULT_TEXT_CHARS);
    truncated = true;
  }
  return { text, imageDataUrl, truncated };
}

/** The renderer-visible row: everything except env VALUES (only their names). */
function publicRow(row) {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: [...row.args],
    workingDirectory: row.workingDirectory || null,
    envKeys: Object.keys(row.env || {}),
    status: row.status,
    toolCount: (row.tools || []).length,
    approvedTools: [...(row.approvedTools || [])],
    createdAt: row.createdAt,
    lastConnectedAt: row.lastConnectedAt || null,
    lastError: row.lastError || null,
  };
}

async function defaultSpawnClient({ command, args, env, cwd, onExit }) {
  return startStdioMcpClient({ command, args, env: desktopChildEnv(env), cwd, onExit });
}

// ---------------------------------------------------------------------------
// Env secrets at rest
// ---------------------------------------------------------------------------
// Connection env vars are API keys (GitHub tokens, Figma PATs). They are
// encrypted with Electron safeStorage (Keychain-backed) when available; the
// stored shape records which path was taken so a store written inside
// Electron never gets silently misread by plain Node and vice versa.

function electronSafeStorage() {
  try {
    const { safeStorage } = require("electron");
    return safeStorage?.isEncryptionAvailable() ? safeStorage : null;
  } catch {
    return null; // plain Node (tests)
  }
}

/** value → { v, enc } stored form. */
function encryptEnvValue(value) {
  const s = electronSafeStorage();
  if (s) return { v: s.encryptString(String(value)).toString("base64"), enc: true };
  return { v: String(value), enc: false };
}

/** stored form (or legacy plaintext string) → value. "" when undecryptable. */
function decryptEnvValue(stored) {
  if (typeof stored === "string") return stored; // legacy rows
  if (!stored || typeof stored !== "object") return "";
  if (!stored.enc) return String(stored.v || "");
  const s = electronSafeStorage();
  if (!s) return "";
  try {
    return s.decryptString(Buffer.from(String(stored.v || ""), "base64"));
  } catch {
    return "";
  }
}

function encryptEnvMap(env) {
  const out = {};
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== "string" || !v) continue;
      out[String(k)] = encryptEnvValue(v);
    }
  }
  return out;
}

function decryptEnvMap(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    const value = decryptEnvValue(v);
    if (value) out[k] = value;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.userDataPath  where the connections JSON persists
 * @param {Function} [opts.spawnClient]  injectable for tests — must resolve to
 *   a stdioMcpClient-shaped handle ({ alive, listTools, callTool, close }).
 */
function createLocalMcpHost({ userDataPath, spawnClient = defaultSpawnClient } = {}) {
  if (!userDataPath) throw new Error("createLocalMcpHost requires userDataPath");
  const storePath = path.join(userDataPath, STORE_FILE);

  /** @type {Array<object>} persisted rows (see publicRow for the shape). */
  let rows = [];
  /** id → live stdio client. */
  const clients = new Map();

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (Array.isArray(parsed?.connections)) rows = parsed.connections;
  } catch {
    /* first run or unreadable store — start empty */
  }

  function persist() {
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      const tmp = `${storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, connections: rows }, null, 2));
      fs.renameSync(tmp, storePath);
    } catch (err) {
      console.warn("[desktop-mcp] persist failed:", err?.message || err);
    }
  }

  function findRow({ connectionId, app } = {}) {
    if (connectionId) {
      const byId = rows.find((r) => r.id === String(connectionId));
      if (byId) return byId;
    }
    const want = String(app || "").trim().toLowerCase();
    if (!want) return null;
    return (
      rows.find((r) => r.name.toLowerCase() === want) ||
      rows.find((r) => r.name.toLowerCase().includes(want) || want.includes(r.name.toLowerCase())) ||
      null
    );
  }

  async function closeClient(id) {
    const client = clients.get(id);
    clients.delete(id);
    if (client) {
      try {
        await client.close();
      } catch {
        /* already gone */
      }
    }
  }

  /** Spawn (or reuse) the live client for a row, refreshing its tool list. */
  async function ensureClient(row) {
    const existing = clients.get(row.id);
    if (existing?.alive) return existing;
    clients.delete(row.id);
    const client = await spawnClient({
      command: row.command,
      args: row.args,
      env: decryptEnvMap(row.env),
      cwd: row.workingDirectory || undefined,
      onExit: () => {
        // Spontaneous death (app quit, crash). Only downgrade if this client
        // is still the row's current one — a reconnect may have replaced it.
        if (clients.get(row.id) === client) {
          clients.delete(row.id);
          row.status = "offline";
          persist();
        }
      },
    });
    clients.set(row.id, client);
    try {
      const tools = await client.listTools();
      row.tools = (Array.isArray(tools) ? tools : []).slice(0, MAX_TOOLS_PER_SERVER).map(trimTool);
    } catch {
      /* keep the persisted tool list; the call itself may still work */
    }
    row.status = "connected";
    row.lastConnectedAt = new Date().toISOString();
    row.lastError = null;
    persist();
    return client;
  }

  async function add({ name, commandLine, command, args, workingDirectory, env } = {}) {
    const cleanName = String(name || "").trim().slice(0, 60);
    if (!cleanName) return { ok: false, error: "missing_name" };

    const parsed = parseLocalCommand(
      commandLine != null && commandLine !== "" ? commandLine : { command, args },
    );
    if (!parsed.ok) return { ok: false, error: parsed.error };
    // The connect was explicitly approved (Settings form or the chat approval
    // card) — that IS the install consent npx/uvx would otherwise prompt for.
    const safe = assertLocalCommandSafe({
      command: parsed.command,
      args: parsed.args,
      confirmInstall: true,
    });
    if (!safe.ok) return { ok: false, error: safe.error };
    const cwd = assertWorkingDirectorySafe(workingDirectory);
    if (!cwd.ok) return { ok: false, error: cwd.error };

    const envPatch = encryptEnvMap(env);

    // Same app name = update in place, never a duplicate row. This is the
    // retry lane: a connect that failed on env_required comes back with keys,
    // and approval memory + createdAt survive the retry.
    const existing = rows.find((r) => r.name.toLowerCase() === cleanName.toLowerCase());
    const row = existing || {
      id: crypto.randomUUID(),
      name: cleanName,
      env: {},
      status: "error",
      tools: [],
      approvedTools: [],
      createdAt: new Date().toISOString(),
      lastConnectedAt: null,
      lastError: null,
    };
    if (!existing && rows.length >= MAX_CONNECTIONS) {
      return { ok: false, error: "too_many_connections" };
    }
    if (existing) await closeClient(existing.id);
    row.command = safe.command;
    row.args = safe.args;
    row.workingDirectory = cwd.cwd;
    row.env = { ...(row.env || {}), ...envPatch };
    if (!existing) rows.push(row);

    try {
      await ensureClient(row);
      return { ok: true, connection: publicRow(row), ...(existing ? { updated: true } : {}) };
    } catch (err) {
      row.status = "error";
      row.lastError = String(err?.message || err).slice(0, 400);
      persist();
      return { ok: false, error: "connect_failed", message: row.lastError, connection: publicRow(row) };
    }
  }

  async function reconnect(id) {
    const row = rows.find((r) => r.id === String(id));
    if (!row) return { ok: false, error: "not_found" };
    await closeClient(row.id);
    try {
      await ensureClient(row);
      return { ok: true, connection: publicRow(row) };
    } catch (err) {
      row.status = "error";
      row.lastError = String(err?.message || err).slice(0, 400);
      persist();
      return { ok: false, error: "connect_failed", message: row.lastError, connection: publicRow(row) };
    }
  }

  async function remove(id) {
    const row = rows.find((r) => r.id === String(id));
    if (!row) return { ok: false, error: "not_found" };
    await closeClient(row.id);
    rows = rows.filter((r) => r.id !== row.id);
    persist();
    return { ok: true };
  }

  function list() {
    return rows.map(publicRow);
  }

  function detail(id) {
    const row = rows.find((r) => r.id === String(id));
    if (!row) return { ok: false, error: "not_found" };
    return { ok: true, connection: publicRow(row), tools: (row.tools || []).map(trimTool) };
  }

  /**
   * The compact per-turn report chatRequestBuilder ships as `desktopMcpApps`.
   * Rows that never connected are excluded — an app with zero tools would
   * only teach the model to apologise.
   */
  function summary() {
    return rows
      .filter((r) => (r.tools || []).length > 0 && r.status !== "error")
      .map((r) => ({
        name: r.name,
        toolCount: r.tools.length,
        tools: r.tools.slice(0, MAX_SUMMARY_TOOLS).map((t) => t.name),
      }));
  }

  function searchTools({ query, app } = {}) {
    let scope = rows.filter((r) => (r.tools || []).length > 0);
    if (app) {
      const match = findRow({ app });
      scope = match ? [match] : [];
      if (!scope.length) {
        const connected = rows.map((r) => r.name).join(", ") || "none";
        return {
          ok: false,
          note: `No desktop MCP app matches "${app}". Connected apps: ${connected}.`,
        };
      }
    }
    const tokens = String(query || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
    const scored = [];
    for (const row of scope) {
      for (const tool of row.tools) {
        let score = 0;
        const name = tool.name.toLowerCase();
        const desc = (tool.description || "").toLowerCase();
        for (const token of tokens) {
          if (name.includes(token)) score += 3;
          if (desc.includes(token)) score += 1;
        }
        if (score > 0 || tokens.length === 0) {
          scored.push({ score, row, tool });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MAX_SEARCH_RESULTS).map(({ row, tool }) => ({
      app: row.name,
      tool: tool.name,
      description: tool.description,
      consequence: classifyConsequence(tool.name),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    }));
    if (!top.length) {
      return {
        ok: true,
        tools: [],
        note: `No tools matched "${String(query || "")}". Try broader words, or omit the query to list everything.`,
      };
    }
    return { ok: true, tools: top };
  }

  async function callTool({ app, connectionId, toolName, args, approved } = {}) {
    const row = findRow({ connectionId, app });
    if (!row) {
      const connected = rows.map((r) => r.name).join(", ") || "none";
      return {
        ok: false,
        error:
          `No connected desktop app matches "${String(app || connectionId || "")}". ` +
          `Connected: ${connected}. Use local_mcp_search_tools to see their tools.`,
      };
    }
    const wanted = String(toolName || "").trim();
    const tool = (row.tools || []).find((t) => t.name === wanted);
    if (!tool) {
      return {
        ok: false,
        error: `"${wanted}" is not on ${row.name}. Use local_mcp_search_tools to find the right tool.`,
      };
    }

    const consequence = classifyConsequence(wanted);
    const remembered = (row.approvedTools || []).includes(wanted);
    if (consequence === "consequential" && !remembered && approved !== true) {
      return {
        ok: false,
        needsApproval: true,
        summary: `${row.name}: run ${wanted}`,
        app: row.name,
        tool: wanted,
      };
    }
    if (consequence === "consequential" && !remembered && approved === true) {
      // First approval is remembered per connection+tool: the user said yes
      // to this action once; asking again every hop would break act→read→act.
      row.approvedTools = [...(row.approvedTools || []), wanted];
      persist();
    }

    let client;
    try {
      client = await ensureClient(row);
    } catch (err) {
      row.status = "error";
      row.lastError = String(err?.message || err).slice(0, 400);
      persist();
      return { ok: false, error: `Could not reach ${row.name}: ${row.lastError}` };
    }

    try {
      const res = await client.callTool(wanted, args && typeof args === "object" ? args : {});
      const folded = foldResultContent(res?.content);
      const failed = res?.isError === true;
      return {
        ok: !failed,
        app: row.name,
        tool: wanted,
        result: folded.text,
        ...(folded.imageDataUrl ? { imageDataUrl: folded.imageDataUrl } : {}),
        ...(folded.truncated ? { truncated: true } : {}),
        ...(failed ? { error: folded.text || "tool reported an error" } : {}),
        ...(failed && COMPANION_UNREACHABLE_RE.test(folded.text)
          ? { guidance: companionRecoveryGuidance(row.name) }
          : {}),
      };
    } catch (err) {
      // Most call failures mean the app side died (user quit Blender).
      row.status = "offline";
      persist();
      await closeClient(row.id);
      const message = String(err?.message || err).slice(0, 400);
      return {
        ok: false,
        error: message,
        ...(COMPANION_UNREACHABLE_RE.test(message)
          ? { guidance: companionRecoveryGuidance(row.name) }
          : {}),
      };
    }
  }

  async function closeAll() {
    await Promise.allSettled(rows.map((r) => closeClient(r.id)));
  }

  /** Close every child on app quit; harmless outside Electron (tests). */
  function registerShutdownHooks() {
    try {
      const { app } = require("electron");
      app.on("will-quit", () => {
        void closeAll();
      });
    } catch {
      /* plain Node — children die with the parent */
    }
  }

  return {
    add,
    reconnect,
    remove,
    list,
    detail,
    summary,
    searchTools,
    callTool,
    closeAll,
    registerShutdownHooks,
  };
}

module.exports = {
  createLocalMcpHost,
  classifyConsequence,
  foldResultContent,
  encryptEnvValue,
  decryptEnvValue,
};
