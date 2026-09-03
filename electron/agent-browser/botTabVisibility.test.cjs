"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  botTabOwner,
  isHeadlessBotTab,
  isHiddenBotTab,
} = require("./botTabVisibility.cjs");

function opts({ headless = [], revealed = [] } = {}) {
  const hiddenAgents = new Set(headless);
  const opened = new Set(revealed);
  return {
    isHeadless: (id) => hiddenAgents.has(id),
    isRevealed: (id) => opened.has(id),
    partitionOwner: (id) => id,
  };
}

test("a Bot work surface stays hidden until the user opens the peek", () => {
  const flags = opts({ headless: ["bot-scout"] });
  assert.equal(isHeadlessBotTab("bot-scout", flags), true);
  assert.equal(isHiddenBotTab("bot-scout", flags), true);
  assert.equal(isHiddenBotTab("worker-1", flags), false);
});

test("revealing a Bot tab keeps it a teammate surface, but shows it", () => {
  const flags = opts({ headless: ["bot-scout"], revealed: ["bot-scout"] });
  assert.equal(isHeadlessBotTab("bot-scout", flags), true);
  assert.equal(isHiddenBotTab("bot-scout", flags), false);
});

test("a sub-tab follows its owner's headless / revealed flags", () => {
  const flags = {
    isHeadless: (id) => id === "bot-scout",
    isRevealed: (id) => id === "bot-scout",
    partitionOwner: (id) => (id.startsWith("sub-") ? "bot-scout" : id),
  };
  assert.equal(botTabOwner("sub-bot-scout-t1", flags.partitionOwner), "bot-scout");
  assert.equal(isHeadlessBotTab("sub-bot-scout-t1", flags), true);
  assert.equal(isHiddenBotTab("sub-bot-scout-t1", flags), false);
});

test("showing a Bot tab reveals it so a cold Studio Browser cannot mint a blank page", () => {
  const host = fs.readFileSync(path.join(__dirname, "host.cjs"), "utf8");
  const ensure = host.slice(
    host.indexOf("function ensureAgentBrowserWindow"),
    host.indexOf("function destroyAgentBrowserWindow"),
  );
  assert.match(ensure, /revealBotBrowserTab/);
  assert.match(ensure, /isHiddenBotTab/);
  const users = host.slice(
    host.indexOf("function userBrowserTabIds"),
    host.indexOf("function hasUserBrowserTab"),
  );
  assert.match(users, /isHiddenBotTab/);
  assert.doesNotMatch(users, /!isHeadlessBotTab/);
  const close = fs.readFileSync(
    path.join(__dirname, "..", "ipc", "agentBridge.cjs"),
    "utf8",
  );
  assert.match(close, /if \(botSurface\) \{\s*concealBotBrowserTab\(id\);/s);
});
