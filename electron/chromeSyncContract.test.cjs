"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const contract = require("./chromeSyncContract.cjs");

test("profile values round-trip browser id and profile dir", () => {
  const encoded = contract.encodeProfileValue("chrome", "Default");
  assert.equal(encoded, "chrome::Default");
  assert.deepEqual(contract.parseProfileValue(encoded), {
    browserId: "chrome",
    profileDir: "Default",
  });
});

test("runOptions uses the canonical IPC flag names", () => {
  assert.deepEqual(
    contract.runOptions({
      browserId: "chrome",
      profileDir: "Profile 1",
      importCookies: true,
      importTabs: false,
      importHistory: true,
    }),
    {
      browserId: "chrome",
      profileDir: "Profile 1",
      importCookies: true,
      importTabs: false,
      importHistory: true,
    },
  );
});

test("keychain denial is a blocker; partial cookie keep is not", () => {
  assert.equal(contract.isBlockerWarning("keychain_denied"), true);
  assert.equal(contract.isBlockerWarning("cookies_kept_existing_login: google.com"), false);
  assert.deepEqual(contract.blockerWarnings(["keychain_denied", "history_empty"]), [
    "keychain_denied",
  ]);
});

test("humaniseWarning stays user-safe", () => {
  assert.match(contract.humaniseWarning("keychain_denied"), /Keychain/);
  assert.equal(contract.humaniseWarning("secret_token_abc"), "");
});

test("browser chrome and walkthrough load the same contract script", () => {
  const stage = fs.readFileSync(path.join(__dirname, "agent-stage.html"), "utf8");
  const welcome = fs.readFileSync(path.join(__dirname, "welcome.html"), "utf8");
  const stageJs = fs.readFileSync(path.join(__dirname, "agent-stage.js"), "utf8");
  const welcomeJs = welcome.slice(welcome.indexOf("<script>"));
  assert.match(stage, /src="chromeSyncContract\.cjs"/);
  assert.match(welcome, /src="chromeSyncContract\.cjs"/);
  assert.match(welcome, /id="logins-import"/);
  assert.match(stageJs, /lyknChromeSyncContract/);
  assert.match(stageJs, /chromeSyncRun/);
  assert.match(welcomeJs, /lyknWelcome\.syncBrowser/);
  assert.match(welcomeJs, /lyknChromeSyncContract/);
});

test("walkthrough Sync button stays above the preview and remains clickable", () => {
  const welcome = fs.readFileSync(path.join(__dirname, "welcome.html"), "utf8");
  assert.match(welcome, /\.cta\s*\{[\s\S]*z-index:\s*5;/);
  assert.match(welcome, /#logins-import[\s\S]{0,400}pointer-events:\s*auto/);
  assert.match(welcome, /script-src 'self' 'unsafe-inline'/);
  assert.match(welcome, /id="logins-import"/);
});

test("real browser Sync menu is no-drag and the docked overlay parks the page", () => {
  const stage = fs.readFileSync(path.join(__dirname, "agent-stage.html"), "utf8");
  const host = fs.readFileSync(path.join(__dirname, "agent-browser/host.cjs"), "utf8");
  assert.match(stage, /#sync-menu[\s\S]{0,400}-webkit-app-region:\s*no-drag/);
  assert.match(host, /dockedPageBoundsForOverlay/);
  assert.match(host, /agentStageMenuOverlay/);
});
