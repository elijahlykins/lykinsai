/**
 * Bind a LYKN browser tab (agent id) to the LyknChat that opened it.
 *
 * Clicking a chat / Build / Imagine / Research link creates a browser tab.
 * The rail on that tab should keep the same conversation — not start a
 * fresh agent thread.
 */

const EVENT = "lykn-browser-chat-attach";

export type BrowserChatBind = {
  chatId: string;
  url?: string;
  title?: string;
  at: number;
};

const byAgent = new Map<string, BrowserChatBind>();
/** Chat waiting on the tab id from studioOpenUrl, so the rail can show
 *  the conversation before the bind lands. */
let pendingChatId: string | null = null;
let bindSeq = 0;

function emit() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* SSR / tests */
  }
}

export function markPendingBrowserChat(chatId: string) {
  const chat = String(chatId || "").trim();
  pendingChatId = chat || null;
  emit();
}

export function consumePendingBrowserChat(agentId: string) {
  const tab = String(agentId || "").trim();
  if (!tab || !pendingChatId) return;
  if (!byAgent.has(tab)) {
    bindBrowserTabChat(tab, pendingChatId);
  }
  pendingChatId = null;
}

export function bindBrowserTabChat(
  agentId: string,
  chatId: string,
  meta?: { url?: string; title?: string },
) {
  const tab = String(agentId || "").trim();
  const chat = String(chatId || "").trim();
  if (!tab || !chat) return;
  byAgent.set(tab, {
    chatId: chat,
    url: String(meta?.url || "").trim() || undefined,
    title: String(meta?.title || "").trim() || undefined,
    at: ++bindSeq,
  });
  emit();
}

export function unbindBrowserTabChat(agentId: string) {
  const tab = String(agentId || "").trim();
  if (!tab || !byAgent.has(tab)) return;
  byAgent.delete(tab);
  emit();
}

export function getAttachedChatId(agentId?: string | null): string | null {
  const tab = String(agentId || "").trim();
  if (tab) {
    const bound = byAgent.get(tab)?.chatId;
    if (bound) return bound;
  }
  return pendingChatId;
}

export function getAttachedPageForChat(
  chatId?: string | null,
): (BrowserChatBind & { agentId: string }) | null {
  const chat = String(chatId || "").trim();
  if (!chat) return null;
  let latest: (BrowserChatBind & { agentId: string }) | null = null;
  for (const [agentId, bind] of byAgent) {
    if (bind.chatId !== chat) continue;
    if (!latest || bind.at > latest.at) latest = { ...bind, agentId };
  }
  return latest;
}

export function subscribeBrowserChatAttach(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** Test helper — drop every bind. */
export function resetBrowserChatAttach() {
  pendingChatId = null;
  bindSeq = 0;
  if (byAgent.size === 0) {
    emit();
    return;
  }
  byAgent.clear();
  emit();
}
