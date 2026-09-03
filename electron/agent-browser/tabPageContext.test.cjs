"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractOwnedTabPageContext,
  resolveOwnedTabWebContents,
} = require("./tabPageContext.cjs");

function wc(url, title) {
  return {
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => title,
  };
}

test("extracts page context from the exact tab id, never a sibling", async () => {
  const views = new Map([
    ["tab-a", { webContents: wc("https://apple.com/", "Apple") }],
    ["tab-b", { webContents: wc("https://github.com/", "GitHub") }],
  ]);
  const a = await extractOwnedTabPageContext({
    tabId: "tab-a",
    views,
    getPageContext: async (contents) => ({
      url: contents.getURL(),
      title: contents.getTitle(),
      text: contents.getURL().includes("apple") ? "iPhone article" : "WRONG",
    }),
  });
  const b = await extractOwnedTabPageContext({
    tabId: "tab-b",
    views,
    getPageContext: async (contents) => ({
      url: contents.getURL(),
      title: contents.getTitle(),
      text: contents.getURL().includes("github") ? "repo readme" : "WRONG",
    }),
  });
  assert.equal(a.ok, true);
  assert.equal(a.url, "https://apple.com/");
  assert.equal(a.text, "iPhone article");
  assert.equal(b.ok, true);
  assert.equal(b.url, "https://github.com/");
  assert.equal(b.text, "repo readme");
});

test("invalid tabId does not fall back to another active page", async () => {
  const views = new Map([
    ["tab-live", { webContents: wc("https://live.example/", "Live") }],
  ]);
  let called = 0;
  const missing = await extractOwnedTabPageContext({
    tabId: "tab-missing",
    views,
    getPageContext: async () => {
      called += 1;
      return { url: "https://live.example/", text: "should not run" };
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "unknown_tab");
  assert.equal(called, 0);
  assert.equal(missing.url, undefined);
  const empty = resolveOwnedTabWebContents("", views);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "missing_tab");
});

test("extraction throw still returns URL/title so chat send can continue", async () => {
  const views = new Map([
    ["tab-a", { webContents: wc("https://apple.com/news", "News") }],
  ]);
  const res = await extractOwnedTabPageContext({
    tabId: "tab-a",
    views,
    getPageContext: async () => {
      throw new Error("frame gone");
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, "https://apple.com/news");
  assert.equal(res.title, "News");
  assert.equal(res.text, "");
  assert.match(String(res.error || ""), /frame gone/);
});
