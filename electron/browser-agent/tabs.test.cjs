/**
 * Agent-owned browser sub-tabs: id conventions and the runtime adapter.
 *
 * A browser tab and a worker agent used to be conflated; sub-tabs give one
 * agent several pages without changing the view map's shape. These tests pin
 * the properties the whole design leans on: ids parse unambiguously (agent
 * ids contain dashes), sub-tabs share their owner's session partition, the
 * adapter's active tab is the AGENT's selection (never the stage's visible
 * one), and a dead tab degrades to the root instead of throwing the run.
 *
 * Run: node --test electron/browser-agent/tabs.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const agentTabIds = require("../agentTabIds.cjs");
const { createAgentTabsAdapter } = require("../agentRuntime.cjs");
const { createBrowserController } = require("./browser/controller.cjs");

// ── id conventions ──────────────────────────────────────────────────────────

test("sub-tab ids round-trip even when the agent id is full of dashes", () => {
  const owner = "agent-2f4a-77b1-t9x";
  const id = agentTabIds.subTabId(owner, 3);
  assert.equal(id, `sub-${owner}-t3`);
  assert.equal(agentTabIds.subTabOwner(id), owner);
  assert.equal(agentTabIds.isSubTabId(id), true);
});

test("ordinary agent ids and artifact ids are not sub-tabs", () => {
  assert.equal(agentTabIds.subTabOwner("agent-2f4a"), "");
  assert.equal(agentTabIds.subTabOwner("art-report-1"), "");
  assert.equal(agentTabIds.isSubTabId("sub-x"), false, "the -t<n> marker is required");
});

test("a sub-tab's partition owner is its agent; everyone else owns themselves", () => {
  assert.equal(agentTabIds.partitionOwner("sub-agent-1-t2"), "agent-1");
  assert.equal(agentTabIds.partitionOwner("agent-1"), "agent-1");
});

// ── the adapter ─────────────────────────────────────────────────────────────

function fakeWc(name) {
  return { name, destroyed: false, isDestroyed() { return this.destroyed; } };
}

/** In-memory stand-in for main.cjs's capability, one owner's family. */
function makeCapability(owner) {
  const rootWc = fakeWc("root");
  const tabs = new Map(); // subId -> {wc, url}
  let n = 0;
  const capability = {
    open(ownerId, url) {
      if (ownerId !== owner) return { ok: false, error: "no_owner_tab" };
      n += 1;
      const tabId = agentTabIds.subTabId(owner, n);
      tabs.set(tabId, { wc: fakeWc(tabId), url: String(url || "") });
      return { ok: true, tabId, url };
    },
    close(ownerId, tabId) {
      if (agentTabIds.subTabOwner(tabId) !== ownerId) {
        return { ok: false, error: tabId === ownerId ? "cannot_close_primary_tab" : "not_your_tab" };
      }
      if (!tabs.delete(tabId)) return { ok: false, error: "unknown_tab" };
      return { ok: true, tabId };
    },
    activate(ownerId, tabId) {
      const inFamily = tabId === ownerId || agentTabIds.subTabOwner(tabId) === ownerId;
      if (!inFamily || (tabId !== ownerId && !tabs.has(tabId))) return { ok: false, error: "unknown_tab" };
      return { ok: true, tabId };
    },
    list(ownerId) {
      if (ownerId !== owner) return [];
      return [
        { id: owner, url: "https://root.test/", title: "Root" },
        ...[...tabs.entries()].map(([id, t]) => ({ id, url: t.url, title: id })),
      ];
    },
    getWebContents(tabId) {
      return tabs.get(tabId)?.wc || null;
    },
  };
  return { capability, rootWc, tabs };
}

test("opening a tab makes it the agent's active tab; closing falls back to the root", async () => {
  const owner = "agent-a1";
  const { capability, rootWc } = makeCapability(owner);
  const adapter = createAgentTabsAdapter({ agentId: owner, agentTabs: capability, rootWc });

  assert.equal(adapter.getActiveWebContents(), rootWc);
  const opened = await adapter.open("https://docs.test/");
  assert.equal(opened.ok, true);
  assert.notEqual(adapter.getActiveWebContents(), rootWc, "the new tab is what the agent now drives");

  const closed = await adapter.close(opened.tabId);
  assert.equal(closed.ok, true);
  assert.equal(adapter.getActiveWebContents(), rootWc, "closing the driven tab lands back on the root");
});

test("the primary tab cannot be closed", async () => {
  const owner = "agent-a1";
  const { capability, rootWc } = makeCapability(owner);
  const adapter = createAgentTabsAdapter({ agentId: owner, agentTabs: capability, rootWc });
  const res = await adapter.close(owner);
  assert.equal(res.ok, false);
  assert.equal(res.error, "cannot_close_primary_tab");
});

test("list marks the AGENT's active tab, not anyone else's selection", async () => {
  const owner = "agent-a1";
  const { capability, rootWc } = makeCapability(owner);
  const adapter = createAgentTabsAdapter({ agentId: owner, agentTabs: capability, rootWc });
  const opened = await adapter.open("https://docs.test/");
  await adapter.activate(owner);
  const rows = await adapter.list();
  const active = rows.filter((t) => t.active).map((t) => t.id);
  assert.deepEqual(active, [owner], "activate() moved the agent back to its root tab");
  assert.ok(rows.some((t) => t.id === opened.tabId), "the sub-tab is still listed");
});

test("a tab that died under the agent degrades to the root instead of throwing", async () => {
  const owner = "agent-a1";
  const { capability, rootWc, tabs } = makeCapability(owner);
  const adapter = createAgentTabsAdapter({ agentId: owner, agentTabs: capability, rootWc });
  const opened = await adapter.open("https://docs.test/");
  tabs.get(opened.tabId).wc.destroyed = true;
  assert.equal(adapter.getActiveWebContents(), rootWc, "a destroyed tab must fall back, not crash the run");
});

test("activating a tab outside the family is refused", async () => {
  const owner = "agent-a1";
  const { capability, rootWc } = makeCapability(owner);
  const adapter = createAgentTabsAdapter({ agentId: owner, agentTabs: capability, rootWc });
  const res = await adapter.activate("sub-agent-OTHER-t1");
  assert.equal(res.ok, false);
});

// ── controller integration ──────────────────────────────────────────────────

test("the controller drives whichever tab the adapter says is active", async () => {
  const owner = "agent-a1";
  const { capability, rootWc } = makeCapability(owner);
  const adapter = createAgentTabsAdapter({ agentId: owner, agentTabs: capability, rootWc });
  const seen = [];
  const actuator = {
    getDOMCatalog: async (w) => ({ ok: true, items: [], url: `https://${w.name}.test/` }),
    getPageContext: async (w) => ({ ok: true, url: `https://${w.name}.test/`, title: w.name, text: "" }),
    runAction: async (w, action) => {
      seen.push({ tab: w.name, type: action.type });
      return { ok: true };
    },
    waitForLoad: async () => {},
  };
  // The root webContents passed here is ignored whenever the adapter serves an
  // active one — that indirection is the whole point.
  const controller = createBrowserController({ webContents: rootWc, actuator, tabs: adapter });

  await controller.getPageState();
  const opened = await adapter.open("https://docs.test/");
  await controller.getPageState();
  await controller.scroll("down");
  assert.equal(seen.at(-1).tab, opened.tabId, "actions must land in the agent's active tab");

  await adapter.activate(owner);
  await controller.getPageState();
  await controller.scroll("down");
  assert.equal(seen.at(-1).tab, "root", "switching back re-routes actions to the root tab");
});
