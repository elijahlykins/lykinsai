"use strict";

/**
 * Visible browser tabs stay paired with visible workers.
 * Headless Bots are teammates — they must not come back as empty tabs
 * when the Studio Browser closes and reopens.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAgentRuntime } = require("./agentRuntime.cjs");

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lykn-agent-tabs-"));
}

function newRuntime(userDataPath, { onEnsure } = {}) {
  return createAgentRuntime({
    userDataPath,
    apiBase: "http://localhost:0",
    getAuthToken: async () => "",
    readStreamResponse: async () => "",
    emit: () => {},
    ensureBrowserWindow: (id, opts) => {
      onEnsure?.(id, opts);
    },
    destroyBrowserWindow: () => {},
    showBrowserWindow: () => {},
    hideBrowserWindow: () => {},
    hideAllBrowserWindows: () => {},
    browserWindowExists: () => false,
    getBrowserWebContents: () => null,
    isContentProtectionEnabled: () => false,
    openStageArtifact: () => {},
    destroyOwnedArtifactTabs: () => {},
    focusOverlayComposer: () => {},
    notifyAgentFinished: () => {},
  });
}

test("createAgent stamps the paired tab with sourceChatId at birth", () => {
  const ensured = [];
  const runtime = newRuntime(tempUserData(), {
    onEnsure: (id, opts) => ensured.push({ id, sourceChatId: opts?.sourceChatId }),
  });
  const a = runtime.createAgent({
    title: "A",
    silent: true,
    activate: false,
    sourceChatId: "chat-a",
  });
  const b = runtime.createAgent({
    title: "B",
    silent: true,
    activate: false,
    sourceChatId: "chat-b",
  });
  const unbound = runtime.createAgent({
    title: "Manual",
    silent: true,
    activate: false,
  });
  assert.ok(a?.ok && b?.ok && unbound?.ok);
  assert.equal(
    ensured.find((entry) => entry.id === a.agentId)?.sourceChatId,
    "chat-a",
  );
  assert.equal(
    ensured.find((entry) => entry.id === b.agentId)?.sourceChatId,
    "chat-b",
  );
  assert.equal(
    ensured.find((entry) => entry.id === unbound.agentId)?.sourceChatId,
    undefined,
  );
});

test("ensureAgentTabs does not recreate tabs for headless bots", () => {
  const ensured = [];
  const runtime = newRuntime(tempUserData(), {
    onEnsure: (id) => ensured.push(id),
  });

  const visible = runtime.createAgent({
    title: "New agent",
    silent: true,
    activate: false,
  });
  const bot = runtime.createAgent({
    title: "Ghost",
    silent: true,
    activate: false,
    headless: true,
  });
  assert.ok(visible?.ok && bot?.ok);

  ensured.length = 0;
  runtime.ensureAgentTabs();

  assert.ok(
    ensured.includes(visible.agentId),
    "the visible worker still gets its paired tab",
  );
  assert.ok(
    !ensured.includes(bot.agentId),
    "a headless Bot must not reappear as an empty browser tab",
  );
});

test("load() + ensureAgentTabs restores leftover workers, not persisted bots", async () => {
  const dir = tempUserData();
  fs.writeFileSync(
    path.join(dir, "overlay-agents.json"),
    JSON.stringify({
      activeAgentId: "bot-ghost",
      agents: [
        {
          id: "bot-ghost",
          title: "Ghost",
          role: "worker",
          headless: true,
          status: "idle",
          history: [{ role: "user", content: "hi", at: "2026-08-29T00:00:00.000Z" }],
        },
        {
          id: "bot-mark",
          title: "Mark",
          role: "worker",
          headless: true,
          status: "idle",
          history: [],
        },
        {
          id: "bot-cody",
          title: "Cody",
          role: "worker",
          headless: true,
          status: "idle",
          history: [],
        },
      ],
    }),
    "utf8",
  );

  const ensured = [];
  const runtime = newRuntime(dir, { onEnsure: (id) => ensured.push(id) });
  await runtime.load();
  runtime.ensureAgentTabs();

  assert.deepEqual(
    ensured,
    [],
    "closing the browser must not restore headless teammates as empty tabs",
  );
});
