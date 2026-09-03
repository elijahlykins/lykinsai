import { getThreadSnapshot } from "@/lib/chat/chatThreadRuntime";

const MAX_LOCAL_CHAT = 30;

export function writeThreadChatCache(chatId: string) {
  const id = String(chatId || "").trim();
  if (!id) return;
  const snap = getThreadSnapshot(id);
  if (!snap) return;
  try {
    localStorage.setItem(
      `lyknchat_chat_${id}`,
      JSON.stringify({
        chatMessages: (snap.chatMessages || []).slice(-MAX_LOCAL_CHAT),
        aiThread: (snap.aiThread || []).slice(-MAX_LOCAL_CHAT),
      }),
    );
  } catch {
    /* quota */
  }
}

/** Persist an off-route thread from chatThreadRuntime. Merges messages into
 *  the existing board state so camera/blocks are not wiped. Page scrapes are
 *  not stored. */
export async function persistOffRouteThread(chatId: string, userId?: string | null) {
  const id = String(chatId || "").trim();
  if (!id) return;
  writeThreadChatCache(id);
  if (!userId) return;
  const snap = getThreadSnapshot(id);
  if (!snap) return;
  try {
    const { supabase } = await import("@/lib/supabase");
    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from("lykn_chat_states")
      .select("state, version")
      .eq("chat_id", id)
      .eq("user_id", userId)
      .maybeSingle();
    const prev = existing?.state && typeof existing.state === "object" ? existing.state : {};
    await supabase.from("lykn_chat_states").upsert(
      {
        chat_id: id,
        user_id: userId,
        state: {
          ...prev,
          chatMessages: snap.chatMessages,
          aiThread: snap.aiThread,
        },
        version: existing?.version || 2,
        updated_at: now,
      },
      { onConflict: "chat_id" },
    );
    await supabase.from("lykn_chats").update({ updated_at: now }).eq("id", id).eq("user_id", userId);
  } catch {
    /* local cache already written */
  }
}
