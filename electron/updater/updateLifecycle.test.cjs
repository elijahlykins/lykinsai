"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHECK_INTERVAL_MS,
  updateSnapshot,
  shouldReprompt,
} = require("./updateLifecycle.cjs");

test("updateSnapshot marks ready when a pending version is set", () => {
  const snap = updateSnapshot({
    currentVersion: "1.0.23",
    pendingVersion: "1.0.24",
    downloading: true,
  });
  assert.equal(snap.ready, true);
  assert.equal(snap.downloading, false);
  assert.equal(snap.pendingVersion, "1.0.24");
});

test("updateSnapshot reports downloading until the file is ready", () => {
  const snap = updateSnapshot({
    currentVersion: "1.0.23",
    pendingVersion: "",
    downloading: true,
  });
  assert.equal(snap.ready, false);
  assert.equal(snap.downloading, true);
});

test("shouldReprompt waits for the interval unless forced", () => {
  const now = 1_000_000;
  assert.equal(shouldReprompt({ lastAt: now - 1000, now, intervalMs: CHECK_INTERVAL_MS }), false);
  assert.equal(
    shouldReprompt({ lastAt: now - CHECK_INTERVAL_MS, now, intervalMs: CHECK_INTERVAL_MS }),
    true,
  );
  assert.equal(
    shouldReprompt({ lastAt: now, now, intervalMs: CHECK_INTERVAL_MS, force: true }),
    true,
  );
});
