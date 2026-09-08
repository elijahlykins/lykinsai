"use strict";

/**
 * Minimal MCP client over stdio for the Electron main process.
 *
 * Desktop MCP servers (Blender, Ableton, …) are local processes the user
 * connected on purpose; they run ON this machine, so the desktop app — not
 * the cloud server — owns them. The packaged app deliberately does not ship
 * @modelcontextprotocol/sdk (its dependency tree drags express and friends
 * into the bundle); the stdio transport is newline-delimited JSON-RPC 2.0,
 * which this file implements directly: initialize handshake, tools/list
 * (paginated), tools/call, close.
 *
 * Callers pass ALREADY-VALIDATED argv (see localCommandPolicy.cjs). This
 * module never consults a shell.
 */

const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "LYKN Desktop", version: "1.0.0" };

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// First connect may download a managed Python + all wheels (uvx) or the npm
// package (npx). A verified cold Adobe launch takes ~45s on a fast link;
// slower connections need real headroom before we call it a failure.
const INITIALIZE_TIMEOUT_MS = 180_000;
const CALL_TIMEOUT_MS = 120_000; // a Blender render or scene op can be slow
const KILL_GRACE_MS = 3_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_LINE_CHARS = 4_000_000;

function rpcError(message, code) {
  const err = new Error(message);
  err.code = code || "mcp_rpc_error";
  return err;
}

/**
 * Spawn the server and complete the MCP initialize handshake.
 * Resolves to a client handle; rejects if the process dies or the
 * handshake times out (e.g. the command exists but is not an MCP server).
 */
async function startStdioMcpClient({ command, args = [], env = {}, cwd, onExit } = {}) {
  const child = spawn(command, args, {
    env,
    cwd: cwd || undefined,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject, timer }
  let stderrTail = "";
  let closed = false;
  let buffer = "";

  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-MAX_STDERR_CHARS);
  });

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    if (buffer.length > MAX_LINE_CHARS) {
      failAll(rpcError("mcp_message_too_large", "mcp_message_too_large"));
      void close();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleMessage(line);
      newline = buffer.indexOf("\n");
    }
  });

  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      closed = true;
      failAll(
        rpcError(
          `mcp_server_exited (${signal || code}): ${stderrTail.slice(-400).trim() || "no stderr"}`,
          "mcp_server_exited",
        ),
      );
      try {
        onExit?.({ code, signal, stderrTail });
      } catch {
        /* observer only */
      }
      resolve();
    });
  });
  child.once("error", (err) => {
    closed = true;
    failAll(rpcError(`mcp_spawn_failed: ${err?.message || err}`, "mcp_spawn_failed"));
  });

  function failAll(err) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // servers may log junk to stdout; ignore non-JSON lines
    }
    if (msg?.id == null) return; // notification — nothing awaited
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(
        rpcError(String(msg.error.message || "mcp_server_error"), "mcp_server_error"),
      );
    } else {
      entry.resolve(msg.result);
    }
  }

  function send(payload) {
    if (closed) throw rpcError("mcp_connection_closed", "mcp_connection_closed");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(rpcError(`mcp_timeout: ${method} after ${timeoutMs}ms`, "mcp_timeout"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function close() {
    if (!closed) {
      closed = true;
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      await exitPromise;
      clearTimeout(force);
    }
    failAll(rpcError("mcp_connection_closed", "mcp_connection_closed"));
  }

  // ── Handshake ────────────────────────────────────────────────────────
  let serverInfo = null;
  try {
    const init = await request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      { timeoutMs: INITIALIZE_TIMEOUT_MS },
    );
    serverInfo = init?.serverInfo || null;
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (err) {
    await close();
    throw err;
  }

  return {
    pid: child.pid,
    serverInfo,
    get alive() {
      return !closed;
    },

    /** All tools, following nextCursor pagination. */
    async listTools() {
      const tools = [];
      let cursor;
      do {
        const result = await request("tools/list", cursor ? { cursor } : {});
        for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
          if (tool?.name) tools.push(tool);
        }
        cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      } while (cursor && tools.length < 800);
      return tools;
    },

    async callTool(name, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
      return request(
        "tools/call",
        { name: String(name || ""), arguments: args && typeof args === "object" ? args : {} },
        { timeoutMs },
      );
    },

    close,
  };
}

module.exports = { startStdioMcpClient, PROTOCOL_VERSION };
