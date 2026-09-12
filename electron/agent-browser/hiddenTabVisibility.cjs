/**
 * A headless agent's browser surface stays hidden while it works. Revealing
 * it shows that same tab - it must not mint a blank new-tab beside it.
 *
 * Headless stays true for the worker (closing the Studio Browser must not
 * retire it). Revealed is a separate, in-session flag for the tab strip.
 */

function hiddenTabOwner(id, partitionOwner) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  try {
    return String(partitionOwner?.(raw) || raw).trim() || raw;
  } catch {
    return raw;
  }
}

function isHeadlessAgentTab(id, { isHeadless, partitionOwner } = {}) {
  const owner = hiddenTabOwner(id, partitionOwner);
  if (!owner) return false;
  try {
    return !!isHeadless?.(owner);
  } catch {
    return false;
  }
}

function isHiddenAgentTab(id, { isHeadless, isRevealed, partitionOwner } = {}) {
  const owner = hiddenTabOwner(id, partitionOwner);
  if (!owner) return false;
  try {
    if (isRevealed?.(owner) || isRevealed?.(String(id || "").trim())) return false;
  } catch {
    /* a broken revealed check must not hide a tab the user opened */
  }
  return isHeadlessAgentTab(id, { isHeadless, partitionOwner });
}

module.exports = {
  hiddenTabOwner,
  isHeadlessAgentTab,
  isHiddenAgentTab,
};
