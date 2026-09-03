/**
 * A Bot's browser surface stays hidden while it works. Clicking the chat-bar
 * peek reveals that same tab - it must not mint a blank new-tab beside it.
 *
 * Headless stays true for the teammate (closing the Studio Browser must not
 * retire them). Revealed is a separate, in-session flag for the tab strip.
 */

function botTabOwner(id, partitionOwner) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  try {
    return String(partitionOwner?.(raw) || raw).trim() || raw;
  } catch {
    return raw;
  }
}

function isHeadlessBotTab(id, { isHeadless, partitionOwner } = {}) {
  const owner = botTabOwner(id, partitionOwner);
  if (!owner) return false;
  try {
    return !!isHeadless?.(owner);
  } catch {
    return false;
  }
}

function isHiddenBotTab(id, { isHeadless, isRevealed, partitionOwner } = {}) {
  const owner = botTabOwner(id, partitionOwner);
  if (!owner) return false;
  try {
    if (isRevealed?.(owner) || isRevealed?.(String(id || "").trim())) return false;
  } catch {
    /* a broken revealed check must not hide a tab the user opened */
  }
  return isHeadlessBotTab(id, { isHeadless, partitionOwner });
}

module.exports = {
  botTabOwner,
  isHeadlessBotTab,
  isHiddenBotTab,
};
