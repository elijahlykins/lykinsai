import {
  ensureThreadSnapshot,
  patchThreadSnapshot,
  type ThreadSnapshot,
} from "@/lib/chat/chatThreadRuntime";
import type { PromptMessage } from "@/lib/lyknChat/chatTurnTypes";

function readLocalChat(chatId: string): {
  chatMessages: PromptMessage[];
  aiThread: ThreadSnapshot["aiThread"];
} | null {
  const read = (key: string) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!Array.isArray(data?.chatMessages) || !data.chatMessages.length) return null;
      return {
        chatMessages: data.chatMessages as PromptMessage[],
        aiThread: Array.isArray(data.aiThread) ? data.aiThread : [],
      };
    } catch {
      return null;
    }
  };
  return read(`lyknchat_chat_${chatId}`) || read(`lyknchat_draft_${chatId}`);
}

export function hydrateThreadSnapshotFromLocal(chatId: string): ThreadSnapshot | null {
  const id = String(chatId || "").trim();
  if (!id) return null;
  const snap = ensureThreadSnapshot(id);
  if (snap.chatMessages.length) return snap;
  const loaded = readLocalChat(id);
  if (!loaded) return snap;
  patchThreadSnapshot(id, {
    chatMessages: loaded.chatMessages,
    aiThread: loaded.aiThread.slice(-40),
  });
  return ensureThreadSnapshot(id);
}

export async function hydrateThreadSnapshot(
  chatId: string,
  userId?: string | null,
): Promise<ThreadSnapshot | null> {
  const id = String(chatId || "").trim();
  if (!id) return null;
  const local = hydrateThreadSnapshotFromLocal(id);
  if ((local && local.chatMessages.length) || !userId) return local;
  try {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase
      .from("lykn_chat_states")
      .select("state")
      .eq("chat_id", id)
      .eq("user_id", userId)
      .maybeSingle();
    const state = data?.state && typeof data.state === "object" ? data.state : null;
    const msgs = Array.isArray(state?.chatMessages) ? state.chatMessages : [];
    if (!msgs.length) return ensureThreadSnapshot(id);
    const live = ensureThreadSnapshot(id);
    if (live.chatMessages.length) return live;
    patchThreadSnapshot(id, {
      chatMessages: msgs,
      aiThread: Array.isArray(state.aiThread) ? state.aiThread.slice(-40) : [],
    });
  } catch {
    /* send still proceeds with whatever snapshot we have */
  }
  return ensureThreadSnapshot(id);
}
