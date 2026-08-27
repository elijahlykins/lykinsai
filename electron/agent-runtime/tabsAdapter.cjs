"use strict";

/**
 * Bridge the main process's sub-tab capability onto the browser controller's
 * tabs interface, scoped to ONE agent.
 *
 * The adapter keeps its own notion of which tab the agent is driving
 * (`activeTabId`), separate from the stage's visible selection — the user may
 * be looking at a different agent entirely, and what they watch must never
 * decide which page this agent's next click lands on. Exported for tests.
 */
function createAgentTabsAdapter({ agentId, agentTabs, rootWc, onTabOpened = null }) {
  let activeTabId = agentId;
  const wcOf = (tabId) =>
    tabId === agentId ? rootWc : agentTabs.getWebContents(tabId);
  return {
    async list() {
      const rows = (await agentTabs.list(agentId)) || [];
      // The agent's own active tab, not the stage's visible one.
      return rows.map((t) => ({
        id: t.id,
        url: t.url || "",
        title: t.title || "",
        active: t.id === activeTabId,
      }));
    },
    async open(url) {
      const res = agentTabs.open(agentId, url) || { ok: false, error: "tab_open_failed" };
      if (res.ok && res.tabId) {
        activeTabId = res.tabId;
        // Let the runtime wire the new tab into whatever it watches on the
        // root — user-input seizure above all. A hook failure must not fail
        // the open; the tab exists either way.
        if (typeof onTabOpened === "function") {
          try {
            onTabOpened(res.tabId, wcOf(res.tabId));
          } catch {
            /* observation is best-effort */
          }
        }
      }
      return res;
    },
    async close(tabId) {
      const res = agentTabs.close(agentId, tabId) || { ok: false, error: "tab_close_failed" };
      if (res.ok && activeTabId === tabId) activeTabId = agentId;
      return res;
    },
    async activate(tabId) {
      const target = wcOf(tabId);
      if (!target || target.isDestroyed?.()) return { ok: false, error: "unknown_tab" };
      const res = agentTabs.activate(agentId, tabId) || { ok: false, error: "tab_activate_failed" };
      if (res.ok) activeTabId = tabId;
      return res;
    },
    getActiveWebContents() {
      const target = wcOf(activeTabId);
      // A tab that died under us (closed view, crashed renderer) falls back to
      // the root tab rather than throwing the whole run.
      if (target && !target.isDestroyed?.()) return target;
      activeTabId = agentId;
      return rootWc;
    },
  };
}

module.exports = { createAgentTabsAdapter };
