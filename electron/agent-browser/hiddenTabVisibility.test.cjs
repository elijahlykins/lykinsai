"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  hiddenTabOwner,
  isHeadlessAgentTab,
  isHiddenAgentTab,
} = require("./hiddenTabVisibility.cjs");

function opts({ headless = [], revealed = [] } = {}) {
  const hiddenAgents = new Set(headless);
  const opened = new Set(revealed);
  return {
    isHeadless: (id) => hiddenAgents.has(id),
    isRevealed: (id) => opened.has(id),
    partitionOwner: (id) => id,
  };
}

test("a headless work surface stays hidden until the user opens the peek", () => {
  const flags = opts({ headless: ["agent-scout"] });
  assert.equal(isHeadlessAgentTab("agent-scout", flags), true);
  assert.equal(isHiddenAgentTab("agent-scout", flags), true);
  assert.equal(isHiddenAgentTab("worker-1", flags), false);
});

test("revealing a headless tab keeps it a worker surface, but shows it", () => {
  const flags = opts({ headless: ["agent-scout"], revealed: ["agent-scout"] });
  assert.equal(isHeadlessAgentTab("agent-scout", flags), true);
  assert.equal(isHiddenAgentTab("agent-scout", flags), false);
});

test("a sub-tab follows its owner's headless / revealed flags", () => {
  const flags = {
    isHeadless: (id) => id === "agent-scout",
    isRevealed: (id) => id === "agent-scout",
    partitionOwner: (id) => (id.startsWith("sub-") ? "agent-scout" : id),
  };
  assert.equal(hiddenTabOwner("sub-agent-scout-t1", flags.partitionOwner), "agent-scout");
  assert.equal(isHeadlessAgentTab("sub-agent-scout-t1", flags), true);
  assert.equal(isHiddenAgentTab("sub-agent-scout-t1", flags), false);
});

test("showing a headless tab reveals it so a cold Studio Browser cannot mint a blank page", () => {
  const host = fs.readFileSync(path.join(__dirname, "host.cjs"), "utf8");
  const ensure = host.slice(
    host.indexOf("function ensureAgentBrowserWindow"),
    host.indexOf("function destroyAgentBrowserWindow"),
  );
  assert.match(ensure, /revealAgentBrowserTab/);
  assert.match(ensure, /isHiddenAgentTab/);
  const users = host.slice(
    host.indexOf("function userBrowserTabIds"),
    host.indexOf("function hasUserBrowserTab"),
  );
  assert.match(users, /isHiddenAgentTab/);
  assert.doesNotMatch(users, /!isHeadlessAgentTab/);
  const close = fs.readFileSync(
    path.join(__dirname, "..", "ipc", "agentBridge.cjs"),
    "utf8",
  );
  assert.match(close, /if \(headlessSurface\) \{\s*concealAgentBrowserTab\(id\);/s);
});
