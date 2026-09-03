"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRuntime } = require("../../electron/agentRuntime.cjs");

function newRuntime({
  contentsById = new Map(),
  activeBrowseId = "",
  shown = [],
} = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-teach-browser-"));
  const runtime = createAgentRuntime({
    userDataPath,
    apiBase: "http://localhost:0",
    getAuthToken: async () => "",
    readStreamResponse: async () => "",
    emit: () => {},
    ensureBrowserWindow: () => {},
    destroyBrowserWindow: () => {},
    showBrowserWindow: (id, opts) => shown.push({ id, ...opts }),
    hideBrowserWindow: () => {},
    hideAllBrowserWindows: () => {},
    browserWindowExists: () => false,
    getBrowserWebContents: (id) => contentsById.get(String(id || "")) || null,
    getActiveBrowseAgentId: () => activeBrowseId,
    isContentProtectionEnabled: () => false,
    openStageArtifact: () => {},
    destroyOwnedArtifactTabs: () => {},
    focusOverlayComposer: () => {},
    notifyAgentFinished: () => {},
  });
  return { runtime, shown, userDataPath };
}

function fakeWebContents(id) {
  return { id, isDestroyed: () => false };
}

test("ensureTeachingBrowser reuses a Bot agent and reveals it outside the headless gate", () => {
  const contentsById = new Map();
  const { runtime, shown } = newRuntime({ contentsById });
  const created = runtime.createAgent({
    title: "Ghost",
    silent: true,
    activate: false,
    headless: true,
    bot: { id: "bot_ghost", name: "Ghost" },
  });
  const wc = fakeWebContents(created.agentId);
  contentsById.set(created.agentId, wc);

  const result = runtime.ensureTeachingBrowser({
    agentId: created.agentId,
    botId: "bot_ghost",
    bot: { id: "bot_ghost", name: "Ghost" },
  });

  assert.equal(result, wc);
  const reveal = shown.find((entry) => entry.id === created.agentId);
  assert.ok(reveal, "teaching must reveal the demonstration tab");
  assert.equal(reveal.focus, true);
});

test("ensureTeachingBrowser creates a Bot-owned agent when none exists", () => {
  const contentsById = new Map();
  const { runtime } = newRuntime({ contentsById });
  const originalGet = contentsById.get.bind(contentsById);
  contentsById.get = (id) => {
    if (!contentsById.has(String(id || ""))) {
      contentsById.set(String(id || ""), fakeWebContents(id));
    }
    return originalGet(id);
  };

  const wc = runtime.ensureTeachingBrowser({
    botId: "bot_new",
    bot: { id: "bot_new", name: "Scout" },
  });
  assert.ok(wc?.id);
  const agent = runtime.__getAgentForTest(wc.id);
  assert.equal(agent.headless, true);
  assert.equal(agent.botProfile.id, "bot_new");
  assert.equal(agent.title, "Scout");
});

test("ensureTeachingBrowser falls back to the active Studio tab when no Bot is named", () => {
  const contentsById = new Map();
  const wc = fakeWebContents("tab_active");
  contentsById.set("tab_active", wc);
  const { runtime } = newRuntime({ contentsById, activeBrowseId: "tab_active" });
  assert.equal(runtime.ensureTeachingBrowser({}), wc);
});

test("ensureTeachingBrowser does not throw when browser helpers are missing", () => {
  const { runtime } = newRuntime();
  assert.equal(
    runtime.ensureTeachingBrowser({
      agentId: "missing",
      botId: "",
    }),
    null,
  );
});
