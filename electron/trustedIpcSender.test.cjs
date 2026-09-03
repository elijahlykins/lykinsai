"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { isTrustedLyknIpcUrl, untrustedSenderResult } = require("./trustedIpcSender.cjs");

const APP_ORIGIN = "https://lykn.io";
const APP_URL = "https://lykn.io/studio";
const electronRoot = path.join(os.tmpdir(), "lykn-app", "electron");
const opts = { appOrigin: APP_ORIGIN, appUrl: APP_URL, trustedFileRoots: [electronRoot] };

test("welcome.html is trusted when the electron/ folder is an explicit root", () => {
  const electronDir = path.join(os.tmpdir(), "lykn-src", "electron");
  const fileUrl = `file://${electronDir}/welcome.html`;
  assert.equal(
    isTrustedLyknIpcUrl(fileUrl, { ...opts, trustedFileRoots: [electronDir] }),
    true,
  );
});

test("Studio origin and packaged electron HTML are trusted", () => {
  assert.equal(isTrustedLyknIpcUrl("https://lykn.io/studio", opts), true);
  assert.equal(isTrustedLyknIpcUrl("https://lykn.io/settings", opts), true);
  assert.equal(
    isTrustedLyknIpcUrl(`file://${electronRoot}/overlay.html`, opts),
    true,
  );
  assert.equal(
    isTrustedLyknIpcUrl(`file://${electronRoot}/agent-stage.html`, opts),
    true,
  );
  assert.equal(isTrustedLyknIpcUrl("lykn://new-tab", opts), true);
});

test("agent tabs and arbitrary file URLs are not trusted", () => {
  assert.equal(isTrustedLyknIpcUrl("https://example.com/", opts), false);
  assert.equal(isTrustedLyknIpcUrl("https://evil.example/agent-browser-home.html", opts), false);
  assert.equal(isTrustedLyknIpcUrl("http://127.0.0.1:38471/", opts), false);
  assert.equal(isTrustedLyknIpcUrl("file:///etc/passwd", opts), false);
  assert.equal(isTrustedLyknIpcUrl("file:///Users/me/Downloads/page.html", opts), false);
  assert.equal(
    isTrustedLyknIpcUrl("file:///Users/me/Downloads/electron/overlay.html", opts),
    false,
  );
  assert.equal(isTrustedLyknIpcUrl("", opts), false);
});

test("file: trust fails closed without explicit electron roots", () => {
  const noRoots = { appOrigin: APP_ORIGIN, appUrl: APP_URL };
  assert.equal(
    isTrustedLyknIpcUrl(`file://${electronRoot}/overlay.html`, noRoots),
    false,
  );
});

test("untrustedSenderResult fail-closes when the sender URL is foreign", () => {
  const bad = { sender: { getURL: () => "https://evil.example/" } };
  const good = { sender: { getURL: () => "https://lykn.io/studio" } };
  assert.deepEqual(untrustedSenderResult(bad, opts), { ok: false, error: "untrusted_sender" });
  assert.equal(untrustedSenderResult(good, opts), null);
});

test("filesystem-shaped IPC from an untrusted sender is rejected", () => {
  const foreign = { sender: { getURL: () => "https://evil.example/agent-tab" } };
  assert.deepEqual(untrustedSenderResult(foreign, opts), { ok: false, error: "untrusted_sender" });
});
