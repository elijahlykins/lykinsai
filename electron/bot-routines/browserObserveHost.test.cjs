/**
 * Passive observation host: bind by durable URL, never a random tab.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBrowserObserveHost } = require("./browserObserveHost.cjs");

function tab(id, url, extra = {}) {
  return { id, url, title: extra.title || id, wc: extra.wc || { getURL: () => url, getTitle: () => extra.title || id } };
}

test("a matching URL is observed; a different origin is not used as a replacement", async () => {
  const host = createBrowserObserveHost({
    listTabs: () => [tab("a", "https://evil.test/x"), tab("b", "https://render.com/deploy/123")],
    getDOMCatalog: async (wc) => ({
      ok: true,
      items: [{ uid: 1, tag: "span", role: "status", label: "Building" }],
      url: wc.getURL(),
    }),
    getPageContext: async (wc) => ({ ok: true, url: wc.getURL(), title: "Deploy", text: "Building" }),
  });
  const obs = await host.observe({
    target: {
      url: "https://render.com/deploy/123",
      origin: "https://render.com",
      target: { kind: "text", text: "Building" },
    },
  });
  assert.equal(obs.ok, true);
  assert.equal(obs.url, "https://render.com/deploy/123");
  assert.equal(obs.target.found, true);
});

test("no matching tab is target_unavailable, not a random other tab", async () => {
  const host = createBrowserObserveHost({
    listTabs: () => [tab("a", "https://unrelated.test/")],
    getDOMCatalog: async () => ({ ok: true, items: [] }),
    getPageContext: async () => ({ ok: true, url: "https://unrelated.test/", title: "x", text: "" }),
  });
  const obs = await host.observe({
    target: { url: "https://render.com/deploy/123", origin: "https://render.com" },
  });
  assert.equal(obs.ok, false);
  assert.equal(obs.status, "target_unavailable");
});

test("a hinted tab that navigated away is reported, not silently remapped", async () => {
  const host = createBrowserObserveHost({
    listTabs: () => [tab("kept", "https://accounts.google.com/signin", { title: "Sign in" })],
    getDOMCatalog: async () => ({ ok: true, items: [] }),
    getPageContext: async () => ({ ok: true, url: "https://accounts.google.com/signin", title: "Sign in", text: "" }),
  });
  const obs = await host.observe({
    target: {
      url: "https://render.com/deploy/123",
      origin: "https://render.com",
      tabIdHint: "kept",
    },
  });
  assert.equal(obs.ok, false);
  assert.equal(obs.status, "needs_attention");
});
