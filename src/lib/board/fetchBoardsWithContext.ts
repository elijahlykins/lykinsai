import { supabase } from "@/lib/supabase";
import type { QueryClient } from "@tanstack/react-query";
import { filterBoardsWithContext, type BoardListRow } from "@/lib/board/boardHasContext";
import { isDemoGridId } from "@/lib/demoGrids";

/**
 * Fetches recent chats that have real content, a custom title, or were
 * explicitly opened (board row exists but no snapshot yet). Empty login
 * shells that never got a row stay out of sidebars.
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

/** Invalidate every react-query cache that lists chats for sidebars / synthesis. */
export function invalidateBoardListQueries(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  if (!userId) return;
  queryClient.invalidateQueries({ queryKey: ["boards", userId] });
  queryClient.invalidateQueries({ queryKey: ["mindmap_boards", userId] });
}

/** Prepend the active /grid/:id route when the list hasn't refetched yet. */
export function mergeActiveRouteBoard<T extends BoardListRow>(
  boards: T[],
  pathname: string,
): T[] {
  const match = pathname.match(/^\/grid\/([^/]+)$/);
  if (!match) return boards;
  const id = match[1];
  if (isDemoGridId(id) || id.startsWith("__prototype")) return boards;
  if (boards.some((b) => b.id === id)) return boards;
  return [{ id, title: "New Chat", updated_at: new Date().toISOString() } as T, ...boards];
}
