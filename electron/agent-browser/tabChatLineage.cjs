"use strict";

/**
 * Tab → LYKN chatId projection. Main-process lineage lives on
 * agentBrowserMeta.sourceChatId. This module only shapes the reference;
 * it never includes conversation history.
 */

function sourceChatIdOf(meta) {
  return String(meta?.sourceChatId || "").trim();
}

function projectTabChatBindings({
  metaById,
  activeId = "",
  chatOpen = false,
  isHiddenTab = () => false,
  closedTabIds = [],
} = {}) {
  const id = String(activeId || "").trim();
  const entries = metaById instanceof Map ? metaById : new Map();
  const sourceChatId = sourceChatIdOf(entries.get(id));
  const tabs = [];
  for (const [tabId, meta] of entries.entries()) {
    if (isHiddenTab(tabId)) continue;
    const chat = sourceChatIdOf(meta);
    if (!chat) continue;
    tabs.push({
      id: tabId,
      sourceChatId: chat,
      url: String(meta?.url || ""),
      title: String(meta?.pageTitle || meta?.title || ""),
    });
  }
  const closed = [...(closedTabIds || [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return {
    open: !!chatOpen,
    agentId: id,
    activeAgentId: id,
    sourceChatId: sourceChatId || undefined,
    tabs,
    ...(closed.length === 1 ? { closedTabId: closed[0] } : {}),
    ...(closed.length ? { closedTabIds: closed } : {}),
  };
}

function stripSourceChatIds(metaById) {
  if (!(metaById instanceof Map)) return 0;
  let n = 0;
  for (const [id, meta] of metaById.entries()) {
    if (!sourceChatIdOf(meta)) continue;
    const next = { ...meta };
    delete next.sourceChatId;
    metaById.set(id, next);
    n += 1;
  }
  return n;
}

/** Stamp lineage onto a tab. Never replace a different conversation. */
function applySourceChatId(metaById, tabId, chatId) {
  if (!(metaById instanceof Map)) return { ok: false, changed: false };
  const id = String(tabId || "").trim();
  const chat = String(chatId || "").trim();
  if (!id || !chat) return { ok: false, changed: false };
  const prev = metaById.get(id) || {};
  const existing = sourceChatIdOf(prev);
  if (existing && existing !== chat) return { ok: false, changed: false };
  if (existing === chat) return { ok: true, changed: false };
  metaById.set(id, { ...prev, sourceChatId: chat });
  return { ok: true, changed: true };
}

function inheritOwnerSourceChatId(metaById, ownerId, childId) {
  return applySourceChatId(
    metaById,
    childId,
    sourceChatIdOf(metaById instanceof Map ? metaById.get(ownerId) : null),
  );
}

module.exports = {
  sourceChatIdOf,
  projectTabChatBindings,
  stripSourceChatIds,
  applySourceChatId,
  inheritOwnerSourceChatId,
};
