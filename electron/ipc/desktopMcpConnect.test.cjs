"use strict";

/**
 * The chat-side connect op: catalog resolution pins commands, env gating
 * happens BEFORE the approval card, and the approval-token contract is the
 * same one consequential tool calls use (main-issued, single-use, bound to
 * the exact command line).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { connectOp, resolveConnectTarget } = require("./desktopMcp.cjs");
const { createLocalMcpHost } = require("../mcp/localMcpHost.cjs");

const FIXTURE_TOOLS = [
  { name: "get_scene_info", description: "read", inputSchema: { type: "object" } },
];

function fakeSpawn() {
  return async () => ({
    pid: 7,
    serverInfo: {},
    alive: true,
    listTools: async () => FIXTURE_TOOLS,
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {},
  });
}

/** Minimal localApprovals twin: issue → consume once, bound to tool+args. */
function fakeApprovals() {
  const issued = new Map();
  let n = 0;
  return {
    issue(tool, bound) {
      n += 1;
      const token = `tok-${n}`;
      issued.set(token, { tool, bound: JSON.stringify(bound) });
      return token;
    },
    consume(token, tool, bound) {
      const row = issued.get(token);
      if (!row) return false;
      issued.delete(token);
      return row.tool === tool && row.bound === JSON.stringify(bound);
    },
  };
}

function makeHost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-dmcp-connect-"));
  return createLocalMcpHost({ userDataPath: dir, spawnClient: fakeSpawn() });
}

test("resolveConnectTarget: catalog pins the command; the model cannot override it", () => {
  const target = resolveConnectTarget({ app: "blender", commandLine: "uvx evil-package" });
  assert.equal(target.commandLine, "uvx blender-mcp");
  assert.equal(target.catalogId, "blender");

  const custom = resolveConnectTarget({ name: "Krita", commandLine: "uvx krita-mcp" });
  assert.equal(custom.commandLine, "uvx krita-mcp");
  assert.equal(custom.catalogId, null);

  assert.equal(resolveConnectTarget({ app: "not-a-thing" }), null);
  assert.equal(resolveConnectTarget({}), null);
});

test("connect: needsApproval with the exact command, then token connects", async () => {
  const host = makeHost();
  const approvals = fakeApprovals();

  const first = await connectOp(host, { app: "blender" }, undefined, approvals);
  assert.equal(first.needsApproval, true);
  assert.equal(first.command, "uvx blender-mcp");
  assert.match(first.summary, /Connect Blender — runs: uvx blender-mcp/);
  assert.ok(first.approvalToken);

  const second = await connectOp(host, { app: "blender" }, first.approvalToken, approvals);
  assert.equal(second.ok, true);
  assert.equal(second.connection.name, "Blender");
  // The catalog's app-side setup rides along even on success.
  assert.ok(second.setup.length > 0);
  // And the fresh tool list is in the result so the model can go work.
  assert.equal(second.tools[0].tool, "get_scene_info");

  // The token was single-use.
  const replay = await connectOp(host, { app: "blender" }, first.approvalToken, approvals);
  assert.equal(replay.needsApproval, true);
  await host.closeAll();
});

test("connect: env_required comes BEFORE the approval card and lists hints", async () => {
  const host = makeHost();
  const approvals = fakeApprovals();

  const gated = await connectOp(host, { app: "github" }, undefined, approvals);
  assert.equal(gated.ok, false);
  assert.equal(gated.error, "env_required");
  assert.equal(gated.needsEnv[0].name, "GITHUB_PERSONAL_ACCESS_TOKEN");
  assert.match(gated.needsEnv[0].hint, /Developer settings/);
  assert.equal(gated.needsApproval, undefined);

  // With the key supplied the normal approval flow runs.
  const withKey = await connectOp(
    host,
    { app: "github", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" } },
    undefined,
    approvals,
  );
  assert.equal(withKey.needsApproval, true);
  const done = await connectOp(
    host,
    { app: "github", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" } },
    withKey.approvalToken,
    approvals,
  );
  assert.equal(done.ok, true);
  assert.deepEqual(done.connection.envKeys, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
  await host.closeAll();
});

test("connect: unknown app without a command gets catalog guidance, not a spawn", async () => {
  const host = makeHost();
  const res = await connectOp(host, { app: "flurbotron" }, undefined, fakeApprovals());
  assert.equal(res.ok, false);
  assert.equal(res.error, "unknown_app");
  assert.match(res.guidance, /local_mcp_catalog/);
  assert.equal(host.list().length, 0);
});

test("connect: a failed spawn ships the setup steps as the recovery path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-dmcp-fail-"));
  const host = createLocalMcpHost({
    userDataPath: dir,
    spawnClient: async () => {
      throw new Error("mcp_server_exited: addon not enabled");
    },
  });
  const approvals = fakeApprovals();
  const first = await connectOp(host, { app: "blender" }, undefined, approvals);
  const failed = await connectOp(host, { app: "blender" }, first.approvalToken, approvals);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "connect_failed");
  assert.ok(failed.setup.length > 0, "setup steps must ride the failure");
  assert.match(failed.guidance, /Walk the user through/);
});
