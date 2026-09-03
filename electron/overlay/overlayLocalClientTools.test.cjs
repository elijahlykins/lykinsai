"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isOverlayLocalModeOn,
  overlayLocalModeBody,
  sanitizeLocalResult,
  runOverlayLocalTool,
  handleOverlayAwaitingClient,
} = require("./overlayLocalClientTools.cjs");

test("Glass only arms Local Mode when the Vault switch is on", () => {
  const off = { readLocalMode: () => ({ enabled: false }) };
  const on = { readLocalMode: () => ({ enabled: true }) };
  assert.equal(isOverlayLocalModeOn(off, "/tmp"), false);
  assert.deepEqual(overlayLocalModeBody(off, "/tmp"), {});
  assert.equal(isOverlayLocalModeOn(on, "/tmp"), true);
  assert.deepEqual(overlayLocalModeBody(on, "/tmp"), { localMode: true });
});

test("pulled-file bytes never go back to the model", () => {
  const out = sanitizeLocalResult({
    ok: true,
    name: "invoice.pdf",
    dataBase64: "AAAA",
    note: "Read.",
  });
  assert.equal(out.dataBase64, undefined);
  assert.match(out.note, /does not attach the raw bytes/);
});

test("renderer-only local tools fail closed instead of hanging the turn", async () => {
  const bot = await runOverlayLocalTool({
    name: "local_ask_bot",
    localSystem: { readLocalMode: () => ({ enabled: true }), run: async () => ({ ok: true }) },
    userDataPath: "/tmp",
  });
  assert.equal(bot.ok, false);
  assert.match(bot.error, /Studio Chat or use voice/);

  const browser = await runOverlayLocalTool({
    name: "local_browser_agent",
    localSystem: { readLocalMode: () => ({ enabled: true }), run: async () => ({ ok: true }) },
    userDataPath: "/tmp",
  });
  assert.equal(browser.ok, false);
  assert.match(browser.error, /not available from Glass/);
});

test("file tools run in main and post the result back to the stream", async () => {
  const posted = [];
  const localSystem = {
    readLocalMode: () => ({ enabled: true }),
    run: async (name, args) => ({ ok: true, tool: name, path: args.path, entries: ["a"] }),
  };
  const result = await handleOverlayAwaitingClient(
    {
      id: "call_1",
      name: "local_list_dir",
      args: { path: "/Users/me/Desktop/LYKN" },
      localStreamId: "lt_1",
    },
    {
      localSystem,
      userDataPath: "/tmp",
      apiBase: "http://127.0.0.1:3001",
      token: "tok",
      fetchImpl: async (url, init) => {
        posted.push({ url, init });
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.tool, "local_list_dir");
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/api\/ai\/local-tool-result$/);
  const body = JSON.parse(posted[0].init.body);
  assert.equal(body.streamId, "lt_1");
  assert.equal(body.toolCallId, "call_1");
  assert.equal(body.result.ok, true);
});

test("risky overlay local actions re-run only after approval", async () => {
  const runs = [];
  const localSystem = {
    readLocalMode: () => ({ enabled: true }),
    run: async (name, args, { approved } = {}) => {
      runs.push({ name, approved: !!approved });
      if (!approved) return { needsApproval: true, summary: "Delete this file?" };
      return { ok: true, deleted: true };
    },
  };
  const localApprovals = {
    issue: () => "tok_1",
    consume: (token) => token === "tok_1",
  };
  const declined = await runOverlayLocalTool({
    name: "local_run_command",
    args: { command: "rm x" },
    localSystem,
    localApprovals,
    userDataPath: "/tmp",
    requestApproval: async () => false,
  });
  assert.equal(declined.ok, false);
  assert.match(declined.error, /declined/);

  const allowed = await runOverlayLocalTool({
    name: "local_run_command",
    args: { command: "rm x" },
    localSystem,
    localApprovals,
    userDataPath: "/tmp",
    requestApproval: async () => true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(runs.filter((r) => r.approved).length, 1);
});
