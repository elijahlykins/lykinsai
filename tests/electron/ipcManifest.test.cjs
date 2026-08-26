"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { buildManifest, findDuplicates } = require("./ipcSurface.cjs");

const expected = JSON.parse(fs.readFileSync(path.join(__dirname, "ipcManifest.json"), "utf8"));
const actual = buildManifest();
const keyOf = (e) => `${e.mode} ${e.channel}`;

test("IPC channel count matches the manifest", () => {
  assert.equal(actual.channelCount, expected.channelCount);
});

test("handle vs on counts match the manifest", () => {
  assert.equal(actual.handleCount, expected.handleCount);
  assert.equal(actual.onCount, expected.onCount);
});

test("no IPC channel was lost or renamed", () => {
  const live = new Set(actual.entries.map(keyOf));
  const missing = expected.entries.map(keyOf).filter((k) => !live.has(k));
  assert.deepEqual(missing, []);
});

test("no unexpected IPC channel appeared", () => {
  const known = new Set(expected.entries.map(keyOf));
  const added = actual.entries.map(keyOf).filter((k) => !known.has(k));
  assert.deepEqual(added, []);
});

test("no duplicate IPC channels", () => {
  assert.deepEqual(findDuplicates(actual.entries), []);
  assert.equal(actual.duplicateCount, 0);
});

test("handle/on mode is unchanged per channel", () => {
  const expectedMode = Object.fromEntries(expected.entries.map((e) => [e.channel, e.mode]));
  for (const e of actual.entries) {
    const want = expectedMode[e.channel];
    if (!want) continue;
    assert.equal(e.mode, want, `${e.channel} mode changed`);
  }
});

test("canonical channel set is unchanged", () => {
  const sortKey = (e) => `${e.channel}\t${e.mode}`;
  assert.deepEqual(
    actual.entries.map(sortKey).sort(),
    expected.entries.map(sortKey).sort(),
  );
});
