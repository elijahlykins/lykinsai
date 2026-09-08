"use strict";

// Real-process test of the minimal stdio MCP client: spawns a fake MCP
// server (plain node script speaking newline-delimited JSON-RPC) and runs
// the whole lifecycle against it — handshake, paginated tools/list,
// tools/call, server-side errors, junk on stdout, and close.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { startStdioMcpClient } = require("./stdioMcpClient.cjs");

const FAKE_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
console.log("this is a stray log line, not JSON");
const TOOLS_PAGE_1 = [
  { name: "get_scene_info", description: "Read the current Blender scene graph", inputSchema: { type: "object" } },
  { name: "execute_blender_code", description: "Run python inside Blender", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
];
const TOOLS_PAGE_2 = [
  { name: "get_object_info", description: "Read one object", inputSchema: { type: "object" } },
];
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  const fail = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } }) + "\\n");
  if (msg.method === "initialize") {
    reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-blender", version: "0.1.0" } });
  } else if (msg.method === "tools/list") {
    if (msg.params && msg.params.cursor === "page2") reply({ tools: TOOLS_PAGE_2 });
    else reply({ tools: TOOLS_PAGE_1, nextCursor: "page2" });
  } else if (msg.method === "tools/call") {
    const name = msg.params.name;
    if (name === "get_scene_info") reply({ content: [{ type: "text", text: JSON.stringify({ objects: ["Cube", "Camera"] }) }] });
    else if (name === "execute_blender_code") reply({ content: [{ type: "text", text: "ran: " + (msg.params.arguments.code || "") }] });
    else if (name === "broken_tool") reply({ isError: true, content: [{ type: "text", text: "kaboom" }] });
    else fail("unknown tool " + name);
  }
});
`;

let serverPath;

test.before(() => {
  serverPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lykn-mcp-test-")), "fake-server.cjs");
  fs.writeFileSync(serverPath, FAKE_SERVER);
});

async function connect() {
  return startStdioMcpClient({
    command: process.execPath,
    args: [serverPath],
    env: { PATH: process.env.PATH || "" },
  });
}

test("handshake, paginated discovery, calls, and errors", async () => {
  const client = await connect();
  try {
    assert.equal(client.serverInfo.name, "fake-blender");

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["get_scene_info", "execute_blender_code", "get_object_info"],
    );

    const read = await client.callTool("get_scene_info", {});
    assert.match(read.content[0].text, /Cube/);

    const write = await client.callTool("execute_blender_code", { code: "bpy.ops.mesh.primitive_cube_add()" });
    assert.match(write.content[0].text, /^ran: bpy/);

    const isErr = await client.callTool("broken_tool", {});
    assert.equal(isErr.isError, true);

    await assert.rejects(() => client.callTool("nope", {}), /unknown tool nope/);
  } finally {
    await client.close();
  }
  assert.equal(client.alive, false);
});

test("close kills the child and fails in-flight requests", async () => {
  const client = await connect();
  await client.close();
  await assert.rejects(() => client.callTool("get_scene_info", {}), /mcp_connection_closed/);
});

test("a command that is not an MCP server fails the handshake, not hangs", async () => {
  await assert.rejects(
    () =>
      startStdioMcpClient({
        command: process.execPath,
        args: ["-e", "process.exit(2)"],
        env: { PATH: process.env.PATH || "" },
      }),
    /mcp_server_exited|mcp_connection_closed/,
  );
});
