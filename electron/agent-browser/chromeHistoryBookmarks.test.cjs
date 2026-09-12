"use strict";

/**
 * Chrome-parity regressions for the browser chrome: bookmarks are user-saved
 * only, history has its own button, and downloads animate the toolbar button.
 *
 * Run: node --test electron/agent-browser/chromeHistoryBookmarks.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stageHtml = fs.readFileSync(path.join(__dirname, "../agent-stage.html"), "utf8");
const stageJs = fs.readFileSync(path.join(__dirname, "../agent-stage.js"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "../agent-stage-preload.cjs"), "utf8");
const host = fs.readFileSync(path.join(__dirname, "host.cjs"), "utf8");

test("the favorites bar renders bookmarks, not browsing history", () => {
  assert.match(stageHtml, /id="favs" hidden aria-label="Bookmarks"/);
  assert.match(stageJs, /\(state\.bookmarks \|\| \[\]\)\.slice/);
  assert.doesNotMatch(stageJs, /\(state\.recents \|\| \[\]\)\.slice/);
});

test("the chrome has a designated History button and a bookmark star", () => {
  assert.match(stageHtml, /id="history-btn"/);
  assert.match(stageHtml, /id="history-menu"/);
  assert.match(stageHtml, /id="history-clear"/);
  assert.match(stageHtml, /id="bookmark"/);
  assert.match(preload, /lykn:agent-visits-list/);
  assert.match(preload, /lykn:agent-bookmark-toggle/);
});

test("every visit is recorded to history; bookmarks never auto-fill", () => {
  assert.match(host, /visitHistory\.recordVisit/);
  assert.doesNotMatch(host, /toggleBookmark/);
  assert.match(host, /agentBookmarks\.readBookmarks/);
});

test("downloads animate the toolbar button from will-download progress", () => {
  assert.match(host, /lykn:agent-stage-download-progress/);
  assert.match(stageHtml, /#download\.downloading/);
  assert.match(stageHtml, /icon-done/);
  assert.match(stageJs, /onDownloadProgress/);
});

test("omnibox suggestions come from the shared engine with visit history", () => {
  assert.match(stageJs, /window\.lyknOmniboxSuggest/);
  assert.match(stageJs, /listVisits/);
  assert.match(stageHtml, /src="omniboxSuggest\.js"/);
});
