"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applySourceChatId,
  inheritOwnerSourceChatId,
  projectTabChatBindings,
  stripSourceChatIds,
  sourceChatIdOf,
} = require("./tabChatLineage.cjs");

test("projectTabChatBindings maps each tab to its own sourceChatId", () => {
  const metaById = new Map([
    ["tab-a", { sourceChatId: "chat-a", url: "https://a.example", pageTitle: "A" }],
    ["tab-b", { sourceChatId: "chat-b", url: "https://b.example", pageTitle: "B" }],
    ["tab-c", { url: "https://c.example", pageTitle: "New tab" }],
  ]);
  const a = projectTabChatBindings({ metaById, activeId: "tab-a", chatOpen: true });
  assert.equal(a.sourceChatId, "chat-a");
  assert.equal(a.agentId, "tab-a");
  assert.equal(a.open, true);
  const byId = Object.fromEntries(a.tabs.map((t) => [t.id, t.sourceChatId]));
  assert.equal(byId["tab-a"], "chat-a");
  assert.equal(byId["tab-b"], "chat-b");
  assert.equal(byId["tab-c"], undefined);

  const b = projectTabChatBindings({ metaById, activeId: "tab-b" });
  assert.equal(b.sourceChatId, "chat-b");
  const c = projectTabChatBindings({ metaById, activeId: "tab-c" });
  assert.equal(c.sourceChatId, undefined);
  assert.equal(c.tabs.length, 2);
});

test("a hidden Bot tab is omitted from the Studio projection", () => {
  const metaById = new Map([
    ["tab-a", { sourceChatId: "chat-a" }],
    ["bot-hidden", { sourceChatId: "chat-bot" }],
  ]);
  const p = projectTabChatBindings({
    metaById,
    activeId: "tab-a",
    isHiddenTab: (id) => id === "bot-hidden",
  });
  assert.deepEqual(p.tabs.map((t) => t.id), ["tab-a"]);
});

test("closed tab ids travel with the projection so the renderer can unbind", () => {
  const p = projectTabChatBindings({
    metaById: new Map(),
    closedTabIds: ["tab-a", "sub-tab-a-t1"],
  });
  assert.deepEqual(p.closedTabIds, ["tab-a", "sub-tab-a-t1"]);
  assert.equal(p.closedTabId, undefined);
  const one = projectTabChatBindings({
    metaById: new Map(),
    closedTabIds: ["tab-a"],
  });
  assert.equal(one.closedTabId, "tab-a");
});

test("stripSourceChatIds drops lineage without deleting tabs", () => {
  const metaById = new Map([
    ["tab-a", { sourceChatId: "chat-a", url: "https://a.example" }],
    ["tab-c", { url: "https://c.example" }],
  ]);
  assert.equal(stripSourceChatIds(metaById), 1);
  assert.equal(sourceChatIdOf(metaById.get("tab-a")), "");
  assert.equal(metaById.get("tab-a").url, "https://a.example");
  assert.equal(metaById.has("tab-c"), true);
});

test("applySourceChatId stamps unbound tabs and refuses to steal another chat", () => {
  const metaById = new Map([["tab-a", { url: "https://a.example" }]]);
  assert.deepEqual(applySourceChatId(metaById, "tab-a", "chat-a"), { ok: true, changed: true });
  assert.equal(sourceChatIdOf(metaById.get("tab-a")), "chat-a");
  assert.deepEqual(applySourceChatId(metaById, "tab-a", "chat-a"), { ok: true, changed: false });
  assert.deepEqual(applySourceChatId(metaById, "tab-a", "chat-b"), { ok: false, changed: false });
  assert.equal(sourceChatIdOf(metaById.get("tab-a")), "chat-a");
});

test("a child tab inherits the owner's sourceChatId, not a different Home chat", () => {
  const metaById = new Map([
    ["agent-a", { sourceChatId: "chat-a" }],
    ["sub-agent-a-t1", { url: "https://b.example" }],
  ]);
  const result = inheritOwnerSourceChatId(metaById, "agent-a", "sub-agent-a-t1");
  assert.equal(result.ok, true);
  assert.equal(sourceChatIdOf(metaById.get("sub-agent-a-t1")), "chat-a");
});

test("same-tab navigation must not drop sourceChatId when meta is merged", () => {
  const metaById = new Map([
    ["tab-a", { sourceChatId: "chat-a", url: "https://google.com", kind: "browse" }],
  ]);
  const prev = metaById.get("tab-a");
  metaById.set("tab-a", { ...prev, url: "https://github.com", kind: "browse" });
  assert.equal(sourceChatIdOf(metaById.get("tab-a")), "chat-a");
});
