import { supabase } from "@/lib/supabase";
import { filterBoardsWithContext, type BoardListRow } from "@/lib/board/boardHasContext";

/**
 * Fetches recent chats that have real content (or a custom title) so empty
 * login shells and abandoned "New Chat" rows stay out of sidebars.
 */
export async function fetchBoardsWithContext(
  userId: string,
  limit = 50,
): Promise<BoardListRow[]> {
  const overfetch = Math.min(Math.max(limit * 3, limit), 150);
  const { data, error } = await supabase
    .from("omnia_boards")
    .select("id, title, updated_at, created_at, omnia_board_states(state)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(overfetch);

  if (error) throw error;
  const filtered = filterBoardsWithContext((data || []) as BoardListRow[]);
  return filtered.slice(0, limit);
}

/** Most recent chat with content — used when resuming without a /grid/:id URL. */
export async function fetchRecentBoardWithContext(
  userId: string,
): Promise<BoardListRow | null> {
  const rows = await fetchBoardsWithContext(userId, 1);
  return rows[0] ?? null;
}
