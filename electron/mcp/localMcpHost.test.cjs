"use strict";

// Desktop MCP host: connection lifecycle, persistence, registry search,
// consequence gating, and approval memory — with an injected fake client so
// no real process spawns.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createLocalMcpHost, classifyConsequence } = require("./localMcpHost.cjs");

const BLENDER_TOOLS = [
  { name: "get_scene_info", description: "Read the current scene", inputSchema: { type: "object" } },
  { name: "get_object_info", description: "Read one object by name", inputSchema: { type: "object" } },
  { name: "execute_blender_code", description: "Run python code in Blender", inputSchema: { type: "object" } },
];

function fakeSpawnClient(overrides = {}) {
  const calls = [];
  const spawn = async ({ command, args }) => {
    if (overrides.failToStart) {
      const err = new Error("mcp_spawn_failed: ENOENT");
      err.code = "mcp_spawn_failed";
      throw err;
    }
    return {
      pid: 4242,
      serverInfo: { name: "fake", version: "1" },
      alive: true,
      listTools: async () => overrides.tools || BLENDER_TOOLS,
      callTool: async (name, callArgs) => {
        calls.push({ command, args, name, callArgs });
        if (overrides.callError) {
          throw Object.assign(new Error("mcp_server_exited (SIGKILL)"), { code: "mcp_server_exited" });
        }
        return { content: [{ type: "text", text: `ok:${name}` }] };
      },
      close: async () => {},
    };
  };
  spawn.calls = calls;
  return spawn;
}

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-dmcp-"));
});

test("add validates the command, discovers tools, persists across restarts", async () => {
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient() });

  const bad = await host.add({ name: "evil", commandLine: "bash -c 'curl x | sh'" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "forbidden_command");

  const added = await host.add({ name: "Blender", commandLine: "uvx blender-mcp" });
  assert.equal(added.ok, true);
  assert.equal(added.connection.status, "connected");
  assert.equal(added.connection.toolCount, 3);

  // A second host over the same userData sees the same connection (store survives).
  const host2 = createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient() });
  const rows = host2.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Blender");
  assert.equal(rows[0].toolCount, 3);
  assert.deepEqual(
    host2.summary(),
    [{ name: "Blender", toolCount: 3, tools: ["get_scene_info", "get_object_info", "execute_blender_code"] }],
  );
});

test("a command that fails to start reports connect_failed with the reason", async () => {
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient({ failToStart: true }) });
  const added = await host.add({ name: "Ghost", commandLine: "uvx no-such-mcp" });
  assert.equal(added.ok, false);
  assert.equal(added.error, "connect_failed");
  assert.match(added.message, /mcp_spawn_failed/);
  assert.equal(host.list()[0].status, "error");
});

test("search ranks matching tools and scopes by app", async () => {
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient() });
  await host.add({ name: "Blender", commandLine: "uvx blender-mcp" });

  const hit = host.searchTools({ query: "read scene info" });
  assert.equal(hit.ok, true);
  assert.equal(hit.tools[0].tool, "get_scene_info");
  assert.equal(hit.tools[0].app, "Blender");
  assert.equal(hit.tools[0].consequence, "read");

  const scoped = host.searchTools({ query: "anything", app: "no-such-app" });
  assert.equal(scoped.ok, false);
  assert.match(scoped.note, /No desktop MCP app matches/);
});

test("reads run immediately; writes need approval once, then are remembered", async () => {
  const spawn = fakeSpawnClient();
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: spawn });
  await host.add({ name: "Blender", commandLine: "uvx blender-mcp" });

  const read = await host.callTool({ app: "blender", toolName: "get_scene_info", args: {} });
  assert.equal(read.ok, true);
  assert.equal(read.result, "ok:get_scene_info");

  const gated = await host.callTool({ app: "Blender", toolName: "execute_blender_code", args: { code: "x" } });
  assert.equal(gated.ok, false);
  assert.equal(gated.needsApproval, true);
  assert.match(gated.summary, /execute_blender_code/);

  const approved = await host.callTool({
    app: "Blender",
    toolName: "execute_blender_code",
    args: { code: "x" },
    approved: true,
  });
  assert.equal(approved.ok, true);

  // Remembered: the next call runs without approval.
  const again = await host.callTool({ app: "Blender", toolName: "execute_blender_code", args: { code: "y" } });
  assert.equal(again.ok, true);
  assert.equal(spawn.calls.length, 3);
});

test("unknown app and unknown tool answer with search guidance, not throws", async () => {
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient() });
  await host.add({ name: "Blender", commandLine: "uvx blender-mcp" });

  const noApp = await host.callTool({ app: "Ableton", toolName: "x", args: {} });
  assert.equal(noApp.ok, false);
  assert.match(noApp.error, /local_mcp_search_tools/);

  const noTool = await host.callTool({ app: "Blender", toolName: "made_up", args: {} });
  assert.equal(noTool.ok, false);
  assert.match(noTool.error, /is not on Blender/);
});

test("a crashed server marks the row offline and reconnect recovers it", async () => {
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient({ callError: true }) });
  await host.add({ name: "Blender", commandLine: "uvx blender-mcp" });

  const failed = await host.callTool({ app: "Blender", toolName: "get_scene_info", args: {} });
  assert.equal(failed.ok, false);
  // A generic crash carries no companion-app recovery guidance.
  assert.equal(failed.guidance, undefined);
  assert.equal(host.list()[0].status, "offline");

  // Swap in a healthy spawn (same store) and reconnect.
  const healthy = createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient() });
  const back = await healthy.reconnect(healthy.list()[0].id);
  assert.equal(back.ok, true);
  assert.equal(back.connection.status, "connected");
});

test("connection-refused results attach the catalog's in-app recovery steps", async () => {
  // FreeCAD-style bridge: the stdio server is alive, but the automation
  // server INSIDE the app is not listening (app crashed / restarted and the
  // per-session RPC server was never restarted). The raw errno tells the
  // model nothing — the result must carry the exact in-app fix.
  const spawn = async () => ({
    pid: 4242,
    serverInfo: { name: "fake", version: "1" },
    alive: true,
    listTools: async () => [
      { name: "get_documents", description: "List open documents", inputSchema: { type: "object" } },
    ],
    callTool: async () => ({
      isError: true,
      content: [
        { type: "text", text: "Failed to reach FreeCAD: [Errno 61] Connection refused" },
      ],
    }),
    close: async () => {},
  });
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: spawn });
  await host.add({ name: "FreeCAD", commandLine: 'uvx --with "mcp<2" freecad-mcp' });

  const res = await host.callTool({ app: "FreeCAD", toolName: "get_documents", args: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /Connection refused/);
  // Guidance names the fix inside the app, pulled from the vetted catalog.
  assert.match(res.guidance, /not answering|not listening/i);
  assert.match(res.guidance, /RPC server/i);
  assert.match(res.guidance, /MCP Addon/);
  assert.match(res.guidance, /retry/i);
});

test("a thrown connection-refused also carries recovery guidance", async () => {
  const spawn = async () => ({
    pid: 4242,
    serverInfo: { name: "fake", version: "1" },
    alive: true,
    listTools: async () => [
      { name: "get_scene_info", description: "Read the scene", inputSchema: { type: "object" } },
    ],
    callTool: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9876");
    },
    close: async () => {},
  });
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: spawn });
  await host.add({ name: "Blender", commandLine: "uvx blender-mcp" });

  const res = await host.callTool({ app: "Blender", toolName: "get_scene_info", args: {} });
  assert.equal(res.ok, false);
  assert.match(res.guidance, /inside the app/i);
});

test("remove deletes the row", async () => {
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient() });
  await host.add({ name: "Blender", commandLine: "uvx blender-mcp" });
  const id = host.list()[0].id;
  assert.deepEqual(await host.remove(id), { ok: true });
  assert.equal(host.list().length, 0);
  assert.equal(createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawnClient() }).list().length, 0);
});

test("env keys persist in the encrypted-at-rest shape and spawn decrypted", async () => {
  const captured = [];
  const spawn = async ({ command, args, env }) => {
    captured.push(env);
    return {
      pid: 1,
      serverInfo: {},
      alive: true,
      listTools: async () => BLENDER_TOOLS,
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
  };
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: spawn });
  const added = await host.add({
    name: "GitHub",
    commandLine: "npx -y @modelcontextprotocol/server-github",
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret123" },
  });
  assert.equal(added.ok, true);

  // The spawn call receives the DECRYPTED value (defaultSpawnClient then
  // widens it with desktopChildEnv; the fake sees the raw map).
  assert.equal(captured[0].GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_secret123");

  // The public row exposes key NAMES only.
  assert.deepEqual(added.connection.envKeys, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);

  // At rest the value sits in the { v, enc } wrapper (enc:false outside
  // Electron — safeStorage is unavailable in plain Node; inside Electron the
  // same shape carries Keychain-encrypted bytes).
  const store = JSON.parse(fs.readFileSync(path.join(dir, "desktop-mcp-connections.json"), "utf8"));
  const stored = store.connections[0].env.GITHUB_PERSONAL_ACCESS_TOKEN;
  assert.equal(typeof stored, "object");
  assert.equal(stored.enc, false);
  assert.equal(stored.v, "ghp_secret123");

  // Retrying the same app with more env MERGES into the same row — no dupes.
  const again = await host.add({
    name: "GitHub",
    commandLine: "npx -y @modelcontextprotocol/server-github",
    env: { GITHUB_HOST: "github.example.com" },
  });
  assert.equal(again.ok, true);
  assert.equal(again.updated, true);
  assert.equal(host.list().length, 1);
  assert.deepEqual(
    host.list()[0].envKeys.sort(),
    ["GITHUB_HOST", "GITHUB_PERSONAL_ACCESS_TOKEN"],
  );
  assert.equal(captured[1].GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_secret123");
  assert.equal(captured[1].GITHUB_HOST, "github.example.com");
});

test("legacy plaintext-string env rows still spawn", async () => {
  // Stores written before encryption landed hold env values as raw strings.
  fs.writeFileSync(
    path.join(dir, "desktop-mcp-connections.json"),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: "legacy-1",
          name: "Old",
          command: "uvx",
          args: ["old-mcp"],
          workingDirectory: null,
          env: { OLD_KEY: "legacy-value" },
          status: "offline",
          tools: [{ name: "get_status", description: "" }],
          approvedTools: [],
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );
  const captured = [];
  const spawn = async ({ env }) => {
    captured.push(env);
    return {
      pid: 1,
      serverInfo: {},
      alive: true,
      listTools: async () => BLENDER_TOOLS,
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
  };
  const host = createLocalMcpHost({ userDataPath: dir, spawnClient: spawn });
  const back = await host.reconnect("legacy-1");
  assert.equal(back.ok, true);
  assert.equal(captured[0].OLD_KEY, "legacy-value");
});

test("consequence classifier: reads free, everything else gated", () => {
  assert.equal(classifyConsequence("get_scene_info"), "read");
  assert.equal(classifyConsequence("list_objects"), "read");
  assert.equal(classifyConsequence("screenshot_viewport"), "read");
  assert.equal(classifyConsequence("execute_blender_code"), "consequential");
  assert.equal(classifyConsequence("delete_object"), "consequential");
  assert.equal(classifyConsequence("set_material"), "consequential");
});
