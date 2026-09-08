"use strict";

/**
 * Fixture MCP server for the desktop-MCP end-to-end test.
 *
 * A real stdio process speaking the same newline-delimited JSON-RPC 2.0 the
 * production servers (blender-mcp et al) speak, so the e2e test exercises
 * the ACTUAL spawn → handshake → list → call → close path through
 * stdioMcpClient + localMcpHost instead of an injected fake.
 *
 * Tools:
 *   get_status   read           reports ok + whether ECHO_FIXTURE_KEY arrived
 *   set_value    consequential  echoes the value back (approval-lane probe)
 *   get_snapshot read           returns an image content block (vision path)
 */

const readline = require("node:readline");

// 1x1 transparent PNG.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const TOOLS = [
  {
    name: "get_status",
    description: "Report fixture status and whether the env key arrived.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_value",
    description: "Store a value (consequential — exercises the approval lane).",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
  {
    name: "get_snapshot",
    description: "Return a tiny PNG as an image content block.",
    inputSchema: { type: "object", properties: {} },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`,
  );
}

function handleCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (name === "get_status") {
    const envSeen = process.env.ECHO_FIXTURE_KEY ? `key:${process.env.ECHO_FIXTURE_KEY}` : "key:absent";
    reply(id, { content: [{ type: "text", text: `status:ok ${envSeen}` }] });
  } else if (name === "set_value") {
    reply(id, { content: [{ type: "text", text: `set:${String(args.value || "")}` }] });
  } else if (name === "get_snapshot") {
    reply(id, {
      content: [
        { type: "text", text: "snapshot taken" },
        { type: "image", data: TINY_PNG_B64, mimeType: "image/png" },
      ],
    });
  } else {
    replyError(id, `unknown tool: ${String(name)}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.method === "initialize") {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "echo-fixture", version: "1.0.0" },
    });
  } else if (msg?.method === "tools/list") {
    reply(msg.id, { tools: TOOLS });
  } else if (msg?.method === "tools/call") {
    handleCall(msg.id, msg.params);
  } else if (msg?.id != null) {
    replyError(msg.id, `unknown method: ${String(msg.method)}`);
  }
  // notifications (initialized) need no reply
});

process.stdin.on("end", () => process.exit(0));
