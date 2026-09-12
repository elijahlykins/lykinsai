"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bookmarks = require("./bookmarks.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lykn-bookmarks-"));
}

test("toggle stars and unstars a URL", () => {
  const dir = tmpDir();
  const on = bookmarks.toggleBookmark(dir, {
    url: "https://example.com/docs",
    title: "Example Docs",
  });
  assert.equal(on.ok, true);
  assert.equal(on.bookmarked, true);
  assert.equal(bookmarks.isBookmarked(dir, "https://example.com/docs"), true);

  const off = bookmarks.toggleBookmark(dir, { url: "https://example.com/docs" });
  assert.equal(off.ok, true);
  assert.equal(off.bookmarked, false);
  assert.equal(bookmarks.readBookmarks(dir).items.length, 0);
});

test("bookmark identity ignores hash and trailing slash", () => {
  const dir = tmpDir();
  bookmarks.toggleBookmark(dir, { url: "https://example.com/page/" });
  assert.equal(bookmarks.isBookmarked(dir, "https://example.com/page#top"), true);
});

test("nothing is bookmarked automatically and bad URLs are rejected", () => {
  const dir = tmpDir();
  assert.equal(bookmarks.readBookmarks(dir).items.length, 0);
  const res = bookmarks.toggleBookmark(dir, { url: "lykn://new-tab" });
  assert.equal(res.ok, false);
  assert.equal(res.bookmarked, false);
});

test("labels prefer short titles, else the host leaf", () => {
  const dir = tmpDir();
  bookmarks.toggleBookmark(dir, { url: "https://github.com/", title: "GitHub" });
  bookmarks.toggleBookmark(dir, {
    url: "https://news.ycombinator.com/item?id=1",
    title:
      "A very long page title that would never fit on a bookmark chip in the bar",
  });
  const { items } = bookmarks.readBookmarks(dir);
  assert.equal(items.find((b) => b.url.includes("github")).label, "GitHub");
  assert.equal(items.find((b) => b.url.includes("ycombinator")).label, "News");
});

test("remove by URL", () => {
  const dir = tmpDir();
  bookmarks.toggleBookmark(dir, { url: "https://a.com/" });
  const res = bookmarks.removeBookmark(dir, { url: "https://a.com" });
  assert.equal(res.ok, true);
  assert.equal(bookmarks.readBookmarks(dir).items.length, 0);
});
