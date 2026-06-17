import { supabase } from "@/lib/supabase";
import type { QueryClient } from "@tanstack/react-query";
import { filterLyknChatsWithContext, type LyknChatListRow } from "@/lib/lyknChat/lyknChatHasContext";
import { isDemoLyknChatId } from "@/lib/demoLyknChats";

const BOARD_LIST_SELECT_BASE =
  "id, title, updated_at, created_at, lykn_chat_states(state)";
const BOARD_LIST_SELECT_WITH_MODEL =
  "id, title, updated_at, created_at, chat_model_key, lykn_chat_states(state)";

function isMissingChatModelKeyColumn(error: { message?: string; code?: string } | null) {
  const msg = String(error?.message || "").toLowerCase();
  return (
    error?.code === "42703" ||
    msg.includes("chat_model_key") ||
    (msg.includes("column") && msg.includes("does not exist"))
  );
}

async function fetchBoardListRows(
  userId: string,
  overfetch: number,
): Promise<LyknChatListRow[]> {
  const query = (select: string) =>
    supabase
      .from("lykn_chats")
      .select(select)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(overfetch);

  const withModel = await query(BOARD_LIST_SELECT_WITH_MODEL);
  if (!withModel.error) return (withModel.data || []) as LyknChatListRow[];

  if (isMissingChatModelKeyColumn(withModel.error)) {
    const fallback = await query(BOARD_LIST_SELECT_BASE);
    if (fallback.error) throw fallback.error;
    return (fallback.data || []) as LyknChatListRow[];
  }

  throw withModel.error;
}

/**
 * Fetches recent chats that have real content, a custom title, or were
 * explicitly opened (board row exists but no snapshot yet). Empty login
 * shells that never got a row stay out of sidebars.
 */
export async function fetchLyknChatsWithContext(
  userId: string,
  limit = 50,
): Promise<LyknChatListRow[]> {
  const overfetch = Math.min(Math.max(limit * 3, limit), 150);
  const data = await fetchBoardListRows(userId, overfetch);
  const filtered = filterLyknChatsWithContext(data);
  return filtered.slice(0, limit);
}

/** Most recent chat with content — used when resuming without a /grid/:id URL. */
export async function fetchRecentBoardWithContext(
  userId: string,
): Promise<LyknChatListRow | null> {
  const rows = await fetchLyknChatsWithContext(userId, 1);
  return rows[0] ?? null;
}

/** Most recently touched board row — includes in-progress chats not yet in sidebars. */
export async function fetchMostRecentLyknChat(
  userId: string,
): Promise<LyknChatListRow | null> {
  const rows = await fetchBoardListRows(userId, 1);
  return rows[0] ?? null;
}

/** Invalidate every react-query cache that lists chats for sidebars / synthesis. */
export function invalidateLyknChatListQueries(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  if (!userId) return;
  queryClient.invalidateQueries({ queryKey: ["boards", userId] });
  queryClient.invalidateQueries({ queryKey: ["sidebar-chats", userId] });
  queryClient.invalidateQueries({ queryKey: ["thread-chats", userId] });
  queryClient.invalidateQueries({ queryKey: ["mindmap_boards", userId] });
}

/** Pin the active /grid/:id chat to the top of sidebar lists. */
export function mergeActiveRouteLyknChat<T extends LyknChatListRow>(
  boards: T[],
  pathname: string,
): T[] {
  const match = pathname.match(/^\/chat\/([^/]+)$/);
  if (!match) return boards;
  const id = match[1];
  if (isDemoLyknChatId(id) || id.startsWith("__prototype")) return boards;
  const existing = boards.find((b) => b.id === id);
  const active: T =
    existing ?? ({ id, title: "New Chat", updated_at: new Date().toISOString() } as T);
  return [active, ...boards.filter((b) => b.id !== id)];
}
