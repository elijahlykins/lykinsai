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

test("browser runtime prompt remains and Bot runtime identity is not an AGENTS.md", () => {
  assert.equal(fs.existsSync(path.join(ELECTRON_ROOT, "browser-agent/AGENTS.md")), true);
  assert.equal(fs.existsSync(path.join(ELECTRON_ROOT, "bot-harness/prompts/identity.md")), true);
  assert.equal(fs.existsSync(path.join(ELECTRON_ROOT, "bot-harness/AGENTS.md")), false);
});
