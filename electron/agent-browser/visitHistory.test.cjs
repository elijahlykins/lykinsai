"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const visitHistory = require("./visitHistory.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lykn-visits-"));
}

test("visits record newest first", () => {
  const dir = tmpDir();
  visitHistory.recordVisit(dir, { url: "https://a.com/", title: "A" });
  visitHistory.recordVisit(dir, { url: "https://b.com/", title: "B" });
  const { items } = visitHistory.readVisits(dir);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://b.com/");
  assert.equal(items[1].url, "https://a.com/");
});

test("reload of the same URL updates the entry instead of stacking", () => {
  const dir = tmpDir();
  visitHistory.recordVisit(dir, { url: "https://a.com/", title: "A" });
  visitHistory.recordVisit(dir, { url: "https://a.com/", title: "A again" });
  const { items } = visitHistory.readVisits(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "A again");
});

test("internal pages and non-http URLs are not recorded", () => {
  const dir = tmpDir();
  visitHistory.recordVisit(dir, { url: "lykn://new-tab" });
  visitHistory.recordVisit(dir, { url: "file:///tmp/agent-browser-home.html" });
  visitHistory.recordVisit(dir, {
    url: "https://x.test/agent-browser-home.html",
  });
  assert.equal(visitHistory.readVisits(dir).items.length, 0);
});

test("remove and clear", () => {
  const dir = tmpDir();
  visitHistory.recordVisit(dir, { url: "https://a.com/" });
  visitHistory.recordVisit(dir, { url: "https://b.com/" });
  const removed = visitHistory.removeVisit(dir, { url: "https://a.com/" });
  assert.equal(removed.ok, true);
  assert.equal(visitHistory.readVisits(dir).items.length, 1);
  const cleared = visitHistory.clearVisits(dir);
  assert.equal(cleared.ok, true);
  assert.equal(visitHistory.readVisits(dir).items.length, 0);
});

test("the log is capped", () => {
  const dir = tmpDir();
  const items = [];
  for (let i = 0; i < visitHistory.MAX_VISITS + 20; i += 1) {
    items.push({ url: `https://site-${i}.com/`, at: Date.now() - i });
  }
  visitHistory.recordVisit(dir, { url: "https://newest.com/" });
  // Write an oversized store directly, then confirm reads clamp it.
  fs.writeFileSync(
    visitHistory.visitsPath(dir),
    JSON.stringify({ items }),
    "utf8",
  );
  assert.equal(visitHistory.readVisits(dir).items.length, visitHistory.MAX_VISITS);
});
