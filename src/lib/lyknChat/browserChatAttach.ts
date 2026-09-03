/**
 * Bind a LYKN browser tab (agent id) to the LyknChat that opened it.
 *
 * Renderer UI attachment: tabId → chatId | unbound.
 * Main-process lineage lives on agentBrowserMeta.sourceChatId and is
 * hydrated into this map. Neither side sends conversation history.
 */

const EVENT = "lykn-browser-chat-attach";

export type BrowserChatBind = {
  chatId: string;
  url?: string;
  title?: string;
  at: number;
};

const byAgent = new Map<string, BrowserChatBind>();
/** Tabs the user has actually opened (click-to-reveal, a chat link). Hidden
 *  Bot work does not count — that stays a peek on that Bot's own chat. */
const revealed = new Set<string>();
/** In-flight opens keyed by a token so two rapid studioOpenUrl calls cannot
 *  steal each other's chat. The rail never reads this; it only resolves a
 *  real tab id. */
const pendingByToken = new Map<string, string>();
let pendingSeq = 0;
let bindSeq = 0;

function emit() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* SSR / tests */
  }
}

function normalizeId(value?: string | null): string {
  return String(value || "").trim();
}

/** Pure rail resolver: a tab shows its own bind, or nothing. Never Home. */
export function resolveRailChatId(input: {
  tabId?: string | null;
  attachedChatId?: string | null;
}): string | null {
  const tab = normalizeId(input.tabId);
  if (!tab) return null;
  const attached = normalizeId(input.attachedChatId);
  return attached || null;
}

export function markPendingBrowserChat(chatId: string): string | null {
  const chat = normalizeId(chatId);
  if (!chat) return null;
  const token = `p${++pendingSeq}`;
  pendingByToken.set(token, chat);
  return token;
}

export function consumePendingBrowserChat(agentId: string, token?: string | null) {
  const tab = normalizeId(agentId);
  const key = normalizeId(token);
  if (!tab || !key || !pendingByToken.has(key)) return;
  const chat = pendingByToken.get(key) || "";
  pendingByToken.delete(key);
  if (!chat || byAgent.has(tab)) return;
  bindBrowserTabChat(tab, chat);
}

export function bindBrowserTabChat(
  agentId: string,
  chatId: string,
  meta?: { url?: string; title?: string },
) {
  const tab = normalizeId(agentId);
  const chat = normalizeId(chatId);
  if (!tab || !chat) return;
  byAgent.set(tab, {
    chatId: chat,
    url: String(meta?.url || "").trim() || undefined,
    title: String(meta?.title || "").trim() || undefined,
    at: ++bindSeq,
  });
  emit();
}

/** Fill a renderer bind from trusted main-process sourceChatId. Never
 *  overwrites a tab already paired with a different chat. */
export function hydrateTabChatFromMain(
  agentId: string,
  sourceChatId?: string | null,
  meta?: { url?: string; title?: string },
) {
  const tab = normalizeId(agentId);
  const chat = normalizeId(sourceChatId);
  if (!tab || !chat) return;
  const existing = byAgent.get(tab);
  if (existing && existing.chatId !== chat) return;
  if (
    existing &&
    existing.chatId === chat &&
    existing.url === (String(meta?.url || "").trim() || undefined) &&
    existing.title === (String(meta?.title || "").trim() || undefined)
  ) {
    return;
  }
  bindBrowserTabChat(tab, chat, meta);
}

/** The user opened this tab in the Studio Browser — coming back to its chat
 *  should raise that tab again, and leaving should park the window. */
export function markBrowserTabRevealed(agentId: string) {
  const tab = normalizeId(agentId);
  if (!tab || revealed.has(tab)) return;
  revealed.add(tab);
  emit();
}

export function isBrowserTabRevealed(agentId?: string | null) {
  return revealed.has(normalizeId(agentId));
}

/** Bind only when the pair or page changed, so Ask LYKN can stay in sync
 *  without retriggering listeners on every agent progress tick. */
export function ensureBrowserTabChat(
  agentId: string,
  chatId: string,
  meta?: { url?: string; title?: string },
) {
  const tab = normalizeId(agentId);
  const chat = normalizeId(chatId);
  if (!tab || !chat) return;
  const url = String(meta?.url || "").trim() || undefined;
  const title = String(meta?.title || "").trim() || undefined;
  const existing = byAgent.get(tab);
  if (existing && existing.chatId !== chat) {
    // A Bot's worker tab (or any already-paired tab) must not follow the
    // user onto a sibling chat. Update the page only when the pair matches.
    return;
  }
  if (
    existing &&
    existing.chatId === chat &&
    existing.url === url &&
    existing.title === title
  ) {
    return;
  }
  bindBrowserTabChat(tab, chat, meta);
}

export function unbindBrowserTabChat(agentId: string) {
  const tab = normalizeId(agentId);
  if (!tab || (!byAgent.has(tab) && !revealed.has(tab))) return;
  byAgent.delete(tab);
  revealed.delete(tab);
  emit();
}

export function getAttachedChatId(agentId?: string | null): string | null {
  const tab = normalizeId(agentId);
  if (!tab) return null;
  return byAgent.get(tab)?.chatId || null;
}

export function getAttachedPageForChat(
  chatId?: string | null,
): (BrowserChatBind & { agentId: string }) | null {
  const chat = normalizeId(chatId);
  if (!chat) return null;
  let latest: (BrowserChatBind & { agentId: string }) | null = null;
  for (const [agentId, bind] of byAgent) {
    if (bind.chatId !== chat) continue;
    if (!latest || bind.at > latest.at) latest = { ...bind, agentId };
  }
  return latest;
}

export function chatHasRevealedBrowser(chatId?: string | null): boolean {
  const page = getAttachedPageForChat(chatId);
  return !!(page && revealed.has(page.agentId));
}

export function otherChatHasRevealedBrowser(chatId?: string | null): boolean {
  const chat = normalizeId(chatId);
  for (const [agentId, bind] of byAgent) {
    if (!revealed.has(agentId)) continue;
    if (bind.chatId !== chat) return true;
  }
  return false;
}

export function subscribeBrowserChatAttach(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** Test helper — drop every bind. */
export function resetBrowserChatAttach() {
  pendingByToken.clear();
  pendingSeq = 0;
  bindSeq = 0;
  revealed.clear();
  if (byAgent.size === 0) {
    emit();
    return;
  }
  byAgent.clear();
  emit();
}
