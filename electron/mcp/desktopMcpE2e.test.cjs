"use strict";

/**
 * Desktop MCP end-to-end: a REAL child process (fixtures/echoMcpServer.cjs)
 * through the production spawn path — command policy → stdioMcpClient
 * handshake → localMcpHost persistence, search, approval lane, image
 * folding. Everything else in this area tests with injected fakes; this is
 * the one test that proves the wire actually works.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createLocalMcpHost } = require("./localMcpHost.cjs");

const FIXTURE = path.join(__dirname, "fixtures", "echoMcpServer.cjs");

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lykn-mcp-e2e-"));
}

test("connect → list → search → call → image → close against a real stdio server", async () => {
  const host = createLocalMcpHost({ userDataPath: tmpUserData() });
  try {
    const added = await host.add({
      name: "Echo Fixture",
      commandLine: `node ${FIXTURE}`,
      env: { ECHO_FIXTURE_KEY: "roundtrip-42" },
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.connection.status, "connected");
    assert.equal(added.connection.toolCount, 3);
    // env VALUES never appear in the public row
    assert.deepEqual(added.connection.envKeys, ["ECHO_FIXTURE_KEY"]);

    // search finds the fixture's tools with schemas
    const search = host.searchTools({ query: "status" });
    assert.equal(search.ok, true);
    assert.equal(search.tools[0].tool, "get_status");
    assert.equal(search.tools[0].consequence, "read");

    // read tool runs free AND proves the env var crossed encryption+spawn
    const status = await host.callTool({ app: "Echo Fixture", toolName: "get_status", args: {} });
    assert.equal(status.ok, true);
    assert.match(status.result, /status:ok key:roundtrip-42/);

    // consequential tool needs an approval, then is remembered
    const denied = await host.callTool({
      app: "Echo Fixture",
      toolName: "set_value",
      args: { value: "a" },
    });
    assert.equal(denied.needsApproval, true);
    const approvedCall = await host.callTool({
      app: "Echo Fixture",
      toolName: "set_value",
      args: { value: "a" },
      approved: true,
    });
    assert.equal(approvedCall.ok, true);
    assert.match(approvedCall.result, /set:a/);
    const remembered = await host.callTool({
      app: "Echo Fixture",
      toolName: "set_value",
      args: { value: "b" },
    });
    assert.equal(remembered.ok, true, "second call must not re-ask");

    // image content blocks surface as imageDataUrl for the vision loop
    const snap = await host.callTool({ app: "Echo Fixture", toolName: "get_snapshot", args: {} });
    assert.equal(snap.ok, true);
    assert.match(snap.imageDataUrl, /^data:image\/png;base64,/);
    assert.match(snap.result, /snapshot taken/);

    // reconnecting the SAME name updates in place — no duplicate rows
    const again = await host.add({ name: "Echo Fixture", commandLine: `node ${FIXTURE}` });
    assert.equal(again.ok, true);
    assert.equal(again.updated, true);
    assert.equal(host.list().length, 1);
  } finally {
    await host.closeAll();
  }
});

test("a command that is not an MCP server fails with connect_failed, not a hang", async () => {
  const host = createLocalMcpHost({ userDataPath: tmpUserData() });
  try {
    const res = await host.add({
      name: "Not A Server",
      commandLine: `node ${path.join(__dirname, "fixtures", "does-not-exist.cjs")}`,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "connect_failed");
    assert.match(String(res.message), /mcp_server_exited|mcp_timeout|mcp_spawn_failed/);
  } finally {
    await host.closeAll();
  }
});
