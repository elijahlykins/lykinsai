import test from "node:test";
import assert from "node:assert/strict";
import {
  boundBrowserPage,
  browserPageContextForRequest,
  BROWSER_PAGE_TEXT_BUDGET,
  fetchTrustedBrowserTabPage,
} from "@/lib/lyknChat/browserSurfaceContext";

test("Home surface never attaches browser page context", () => {
  assert.equal(browserPageContextForRequest(undefined), undefined);
  assert.equal(
    browserPageContextForRequest({ surface: "browser", tabId: "tab-a" }),
    undefined,
  );
});

test("browser page context is bounded and per-send", () => {
  const apple = browserPageContextForRequest({
    surface: "browser",
    tabId: "tab-a",
    page: { url: "https://apple.com/news", title: "Apple", text: "iPhone article ".repeat(5000) },
  });
  const github = browserPageContextForRequest({
    surface: "browser",
    tabId: "tab-b",
    page: { url: "https://github.com/lykn", title: "GitHub", text: "repo readme" },
  });
  assert.equal(apple?.url, "https://apple.com/news");
  assert.ok((apple?.text || "").length <= BROWSER_PAGE_TEXT_BUDGET);
  assert.equal(github?.url, "https://github.com/lykn");
  assert.equal(github?.text, "repo readme");
  assert.notEqual(apple?.url, github?.url);
});

test("same chat two tabs keep distinct page snapshots", () => {
  const fromTab1 = boundBrowserPage({ url: "https://x.example", title: "X", text: "page X" });
  const fromTab2 = boundBrowserPage({ url: "https://y.example", title: "Y", text: "page Y" });
  assert.equal(fromTab1?.text, "page X");
  assert.equal(fromTab2?.text, "page Y");
});

test("failed or missing tab extraction yields no page, not another tab", async () => {
  const prev = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    lykn: {
      getBrowserTabPageContext: async () => ({ ok: false, error: "unknown_tab" }),
    },
  };
  try {
    assert.equal(await fetchTrustedBrowserTabPage("missing"), undefined);
    assert.equal(await fetchTrustedBrowserTabPage(""), undefined);
  } finally {
    if (prev === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = prev;
  }
});
