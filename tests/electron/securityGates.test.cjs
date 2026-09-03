"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ELECTRON_ROOT = path.resolve(__dirname, "..", "..", "electron");

function collectMainProcessSource() {
  const files = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (["browser-agent", "bot-harness", "eval", "appRuntime", "vendor", "resources", "localStore"].includes(ent.name)) {
          continue;
        }
        walk(full);
        continue;
      }
      if (!ent.name.endsWith(".cjs") || ent.name.endsWith(".test.cjs")) continue;
      files.push(full);
    }
  }
  walk(ELECTRON_ROOT);
  return files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

const src = collectMainProcessSource();

test("lykn:local-tool-run consumes a main-issued approval token", () => {
  assert.match(src, /ipcMain\.handle\("lykn:local-tool-run"/);
  assert.match(src, /localApprovals\.consume\(approvalToken/);
  assert.match(src, /untrustedSenderResult\(/);
});

test("filesystem and app-launch IPC require a trusted LYKN sender", () => {
  for (const channel of [
    "lykn:mac-fs-list",
    "lykn:mac-fs-open",
    "lykn:files-list",
    "lykn:files-mkdir",
    "lykn:files-rename",
    "lykn:files-move",
    "lykn:files-copy",
    "lykn:files-trash",
    "lykn:save-to-downloads",
    "lykn:mac-app-launch",
    "lykn:mac-app-quit",
  ]) {
    assert.match(src, new RegExp(`ipcMain\\.handle\\("${channel}"`));
  }
  assert.match(src, /requireTrusted\(/);
  assert.match(src, /trustedLyknIpcOpts\(/);
  assert.match(src, /trustedFileRoots/);
});

test("agent-browser home IPC uses the trusted-document identity gate", () => {
  assert.match(src, /function agentBrowserHomeSender\(/);
  assert.match(src, /isTrustedAgentBrowserHomeUrl/);
  assert.match(src, /sanitizeHomeAttachments\(/);
});

test("browser-execute allowlists BROWSER_APP_NAMES", () => {
  assert.match(src, /const BROWSER_APP_NAMES = \[/);
  assert.match(src, /BROWSER_APP_NAMES\.includes\(browser\)/);
});

test("SSRF helpers remain the canonical network safety boundary", () => {
  const netSrc = fs.readFileSync(path.join(ELECTRON_ROOT, "net/safeFetch.cjs"), "utf8");
  assert.match(netSrc, /function isPrivateIpMain\(/);
  assert.match(netSrc, /async function assertPublicHttpUrl\(/);
  assert.match(netSrc, /async function safeFetchMain\(/);
  assert.match(netSrc, /function openExternalSafe\(/);
  assert.match(src, /safeFetchMain\(/);
  assert.match(src, /assertPublicHttpUrl\(/);
});

test("studio-bind-tab-chat requires a trusted LYKN sender and an exact tab id", () => {
  const bridge = fs.readFileSync(path.join(ELECTRON_ROOT, "ipc/agentBridge.cjs"), "utf8");
  assert.match(bridge, /ipcMain\.handle\("lykn:studio-bind-tab-chat"/);
  const start = bridge.indexOf('ipcMain.handle("lykn:studio-bind-tab-chat"');
  const end = bridge.indexOf('ipcMain.handle("lykn:browser-tab-page-context"');
  const handler = bridge.slice(start, end === -1 ? start + 800 : end);
  assert.match(handler, /untrustedSenderResult\(/);
  assert.match(handler, /applyTabSourceChatId\(tabId, chatId\)/);
  assert.match(handler, /unknown_tab/);
  const studioPreload = fs.readFileSync(path.join(ELECTRON_ROOT, "preload.cjs"), "utf8");
  assert.match(studioPreload, /bindTabChat/);
  const pagePreload = fs.readFileSync(path.join(ELECTRON_ROOT, "agent-browser-preload.cjs"), "utf8");
  assert.doesNotMatch(pagePreload, /bindTabChat/);
  assert.doesNotMatch(pagePreload, /studio-bind-tab-chat/);
});

test("studio-clear-tab-chats requires a trusted LYKN sender", () => {
  assert.match(src, /ipcMain\.handle\("lykn:studio-clear-tab-chats"/);
  const bridge = fs.readFileSync(path.join(ELECTRON_ROOT, "ipc/agentBridge.cjs"), "utf8");
  const start = bridge.indexOf('ipcMain.handle("lykn:studio-clear-tab-chats"');
  const end = bridge.indexOf("ipcMain.on(\"lykn:studio-browser-set\"");
  const handler = bridge.slice(start, end === -1 ? start + 400 : end);
  assert.match(handler, /untrustedSenderResult\(/);
});

test("browser-tab-page-context requires a trusted LYKN sender and an exact tab id", () => {
  const bridge = fs.readFileSync(path.join(ELECTRON_ROOT, "ipc/agentBridge.cjs"), "utf8");
  assert.match(bridge, /ipcMain\.handle\("lykn:browser-tab-page-context"/);
  const start = bridge.indexOf('ipcMain.handle("lykn:browser-tab-page-context"');
  const end = bridge.indexOf("ipcMain.on(\"lykn:studio-browser-set\"");
  const handler = bridge.slice(start, end === -1 ? start + 800 : end);
  assert.match(handler, /untrustedSenderResult\(/);
  assert.match(handler, /extractOwnedTabPageContext/);
  assert.doesNotMatch(handler, /getActiveAgentBrowserWebContents/);
  assert.doesNotMatch(handler, /getCurrentlyVisible/);
  const studioPreload = fs.readFileSync(path.join(ELECTRON_ROOT, "preload.cjs"), "utf8");
  assert.match(studioPreload, /getBrowserTabPageContext/);
  assert.doesNotMatch(studioPreload, /lykn-chat-send/);
  const pagePreload = fs.readFileSync(path.join(ELECTRON_ROOT, "agent-browser-preload.cjs"), "utf8");
  assert.doesNotMatch(pagePreload, /getBrowserTabPageContext/);
  assert.doesNotMatch(pagePreload, /browser-tab-page-context/);
  assert.doesNotMatch(pagePreload, /lykn:chat-send/);
  assert.doesNotMatch(pagePreload, /studioOpenUrl/);
  const stagePreload = fs.readFileSync(path.join(ELECTRON_ROOT, "agent-stage-preload.cjs"), "utf8");
  assert.doesNotMatch(stagePreload, /getBrowserTabPageContext/);
  assert.doesNotMatch(stagePreload, /browser-tab-page-context/);
});

test("chrome-sync IPC requires a trusted LYKN sender", () => {
  const bridge = fs.readFileSync(path.join(ELECTRON_ROOT, "ipc/agentBridge.cjs"), "utf8");
  for (const channel of ["lykn:chrome-sync-status", "lykn:chrome-sync-run"]) {
    const start = bridge.indexOf(`ipcMain.handle("${channel}"`);
    assert.notEqual(start, -1, channel);
    const handler = bridge.slice(start, start + 500);
    assert.match(handler, /untrustedSenderResult\(/);
  }
  const pagePreload = fs.readFileSync(path.join(ELECTRON_ROOT, "agent-browser-preload.cjs"), "utf8");
  assert.doesNotMatch(pagePreload, /chrome-sync/);
  const stagePreload = fs.readFileSync(path.join(ELECTRON_ROOT, "agent-stage-preload.cjs"), "utf8");
  const welcomePreload = fs.readFileSync(path.join(ELECTRON_ROOT, "welcome-preload.cjs"), "utf8");
  assert.match(stagePreload, /lykn:chrome-sync-run/);
  assert.match(welcomePreload, /lykn:chrome-sync-run/);
});

test("lykn:update-install requires a trusted LYKN sender", () => {
  const updater = fs.readFileSync(path.join(ELECTRON_ROOT, "updater/autoUpdate.cjs"), "utf8");
  const start = updater.indexOf('ipcMain.handle("lykn:update-install"');
  assert.notEqual(start, -1);
  const handler = updater.slice(start, start + 600);
  assert.match(handler, /isTrustedLyknIpcSender\(/);
  const pagePreload = fs.readFileSync(path.join(ELECTRON_ROOT, "agent-browser-preload.cjs"), "utf8");
  assert.doesNotMatch(pagePreload, /lykn:update-install/);
  assert.doesNotMatch(pagePreload, /installUpdate/);
});

test("runtime identity prompts live in prompt corpora, never as AGENTS.md", () => {
  // Runtime prompt content must not masquerade as a developer AGENTS.md file:
  // each runtime keeps its identity inside its own prompt corpus.
  assert.equal(fs.existsSync(path.join(ELECTRON_ROOT, "browser-agent/agent/identity.md")), true);
  assert.equal(fs.existsSync(path.join(ELECTRON_ROOT, "browser-agent/AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(ELECTRON_ROOT, "bot-harness/prompts/identity.md")), true);
  assert.equal(fs.existsSync(path.join(ELECTRON_ROOT, "bot-harness/AGENTS.md")), false);
});
