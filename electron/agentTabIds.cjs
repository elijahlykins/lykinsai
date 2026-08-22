/**
 * Tab-id conventions for agent-owned browser sub-tabs.
 *
 * A browser tab and a worker agent used to be the same thing: one agent, one
 * WebContentsView, keyed by the agent's id. Sub-tabs give one agent several
 * tabs — the research page open beside the form being filled — without
 * changing that map's shape: a sub-tab is one more entry in
 * `agentBrowserViews`, whose id encodes which agent owns it.
 *
 * The format is `sub-<agentId>-t<n>`. The trailing `-t<digits>` marker is what
 * makes parsing unambiguous even though agent ids themselves contain dashes:
 * the owner is everything between the prefix and the LAST `-t<digits>`.
 *
 * Kept in its own module because main.cjs (which manages the views) and the
 * tests (which cannot load main.cjs outside Electron) both need it.
 */

const SUB_TAB_RE = /^sub-(.+)-t(\d+)$/;

/** The id for the owner's nth extra tab (n >= 1). */
function subTabId(agentId, n) {
  return `sub-${String(agentId || "").trim()}-t${Math.max(1, Math.floor(Number(n) || 1))}`;
}

/** The owning agent's id, or "" when the id is not a sub-tab. */
function subTabOwner(id) {
  const m = SUB_TAB_RE.exec(String(id || ""));
  return m ? m[1] : "";
}

function isSubTabId(id) {
  return SUB_TAB_RE.test(String(id || ""));
}

/**
 * The id whose session a tab should share: a sub-tab lives in its owner's
 * partition (sign-ins must carry across an agent's tabs), everything else in
 * its own.
 */
function partitionOwner(id) {
  return subTabOwner(id) || String(id || "").trim();
}

module.exports = { subTabId, subTabOwner, isSubTabId, partitionOwner };
