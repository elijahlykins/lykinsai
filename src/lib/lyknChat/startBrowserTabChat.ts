/**
 * First send from an unbound browser tab mints a real lykn_chats row and
 * binds that tab to it. Never inherits Home or another tab's conversation.
 */
import {
  bindBrowserTabChat,
  getAttachedChatId,
} from "@/lib/lyknChat/browserChatAttach";
import { addOpenThread } from "@/lib/chat/chatThreadRuntime";
import { notifyLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";

const inflight = new Map<string, Promise<string | null>>();

export type StartBrowserTabChatInput = {
  tabId?: string | null;
  userId?: string | null;
  createChat: (userId: string) => Promise<{ chatId: string }>;
  stampMain?: (tabId: string, chatId: string) => Promise<unknown> | unknown;
};

export async function startChatForUnboundBrowserTab(
  input: StartBrowserTabChatInput,
): Promise<string | null> {
  const tab = String(input.tabId || "").trim();
  const userId = String(input.userId || "").trim();
  if (!tab) return null;
  const attached = getAttachedChatId(tab);
  if (attached) return attached;
  if (!userId) return null;
  const pending = inflight.get(tab);
  if (pending) return pending;

  const work = (async () => {
    try {
      const already = getAttachedChatId(tab);
      if (already) return already;
      const { chatId } = await input.createChat(userId);
      const id = String(chatId || "").trim();
      if (!id) return null;
      bindBrowserTabChat(tab, id);
      addOpenThread(id);
      notifyLyknChatsChanged();
      try {
        await input.stampMain?.(tab, id);
      } catch {
        /* renderer bind is enough for this session; main hydrates next load */
      }
      return id;
    } finally {
      inflight.delete(tab);
    }
  })();
  inflight.set(tab, work);
  return work;
}

export function resetStartBrowserTabChat() {
  inflight.clear();
}

export function stampBrowserTabChatInMain(tabId: string, chatId: string) {
  const tab = String(tabId || "").trim();
  const chat = String(chatId || "").trim();
  if (!tab || !chat) return Promise.resolve(null);
  const lykn = (
    typeof window !== "undefined"
      ? (window as unknown as { lykn?: { bindTabChat?: (t: string, c: string) => Promise<unknown> } }).lykn
      : undefined
  );
  return lykn?.bindTabChat?.(tab, chat) ?? Promise.resolve(null);
}
