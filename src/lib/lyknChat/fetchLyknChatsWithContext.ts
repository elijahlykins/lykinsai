import { supabase } from "@/lib/supabase";
import type { QueryClient } from "@tanstack/react-query";
import { filterLyknChatsWithContext, type LyknChatListRow } from "@/lib/lyknChat/lyknChatHasContext";
import { isDemoLyknChatId } from "@/lib/demoLyknChats";

const BOARD_LIST_SELECT_BASE =
  "id, title, updated_at, created_at, lykn_chat_states(state)";
const BOARD_LIST_SELECT_WITH_MODEL =
  "id, title, updated_at, created_at, chat_model_key, lykn_chat_states(state)";
const BOARD_LIST_SELECT_WITH_MODEL_AND_PIN =
  "id, title, updated_at, created_at, chat_model_key, pinned_at, lykn_chat_states(state)";

function isMissingColumnError(
  error: { message?: string; code?: string } | null,
  column: string,
) {
  const msg = String(error?.message || "").toLowerCase();
  return (
    error?.code === "42703" ||
    msg.includes(column.toLowerCase()) ||
    (msg.includes("column") && msg.includes("does not exist"))
  );
}

function isMissingChatModelKeyColumn(error: { message?: string; code?: string } | null) {
  return isMissingColumnError(error, "chat_model_key");
}

function isMissingPinnedAtColumn(error: { message?: string; code?: string } | null) {
  return isMissingColumnError(error, "pinned_at");
}

/** Prevents mergeActiveRoute from resurrecting a chat mid-delete. */
const recentlyDeletedChatIds = new Set<string>();

export function markLyknChatDeleted(chatId: string) {
  if (!chatId) return;
  recentlyDeletedChatIds.add(chatId);
  globalThis.setTimeout?.(() => recentlyDeletedChatIds.delete(chatId), 30_000);
}

/** Optimistically drop a chat from every sidebar list cache. */
export function removeLyknChatFromListQueries(
  queryClient: QueryClient,
  userId: string | undefined,
  chatId: string,
) {
  if (!userId || !chatId) return;
  queryClient.setQueriesData(
    { queryKey: ["sidebar-boards-paged", userId] },
    (old: { pages?: LyknChatPage[]; pageParams?: unknown[] } | undefined) => {
      if (!old?.pages) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          rows: (page.rows || []).filter((row) => row.id !== chatId),
        })),
      };
    },
  );
  queryClient.setQueriesData(
    { queryKey: ["sidebar-boards-search", userId] },
    (old: LyknChatListRow[] | undefined) =>
      Array.isArray(old) ? old.filter((row) => row.id !== chatId) : old,
  );
  for (const key of ["boards", "sidebar-chats", "thread-chats", "mindmap_boards"] as const) {
    queryClient.setQueriesData(
      { queryKey: [key, userId] },
      (old: LyknChatListRow[] | undefined) =>
        Array.isArray(old) ? old.filter((row) => row.id !== chatId) : old,
    );
  }
}

/** Optimistically toggle pinned_at in sidebar list caches. */
export function patchLyknChatPinnedInListQueries(
  queryClient: QueryClient,
  userId: string | undefined,
  chatId: string,
  pinnedAt: string | null,
) {
  if (!userId || !chatId) return;
  const patchRow = <T extends LyknChatListRow>(row: T): T =>
    row.id === chatId ? { ...row, pinned_at: pinnedAt } : row;

  queryClient.setQueriesData(
    { queryKey: ["sidebar-boards-paged", userId] },
    (old: { pages?: LyknChatPage[]; pageParams?: unknown[] } | undefined) => {
      if (!old?.pages) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          rows: (page.rows || []).map(patchRow),
        })),
      };
    },
  );
  queryClient.setQueriesData(
    { queryKey: ["sidebar-boards-search", userId] },
    (old: LyknChatListRow[] | undefined) =>
      Array.isArray(old) ? old.map(patchRow) : old,
  );
  for (const key of ["boards", "sidebar-chats", "thread-chats", "mindmap_boards"] as const) {
    queryClient.setQueriesData(
      { queryKey: [key, userId] },
      (old: LyknChatListRow[] | undefined) =>
        Array.isArray(old) ? old.map(patchRow) : old,
    );
  }
}

type BoardListQuery = ReturnType<ReturnType<typeof supabase.from>["select"]>;

/**
 * Runs the board-list select against `lykn_chats` for `userId`, ordered newest
 * first, applying `shape` (range / limit / extra filters) to the query. Falls
 * back to the model-less projection on older DBs that lack `chat_model_key`.
 */
async function runBoardListQuery(
  userId: string,
  shape: (q: BoardListQuery) => BoardListQuery,
): Promise<LyknChatListRow[]> {
  const build = (select: string) =>
    shape(
      supabase
        .from("lykn_chats")
        .select(select)
        .eq("user_id", userId)
        .order("updated_at", { ascending: false }) as unknown as BoardListQuery,
    );

  const withModelAndPin = await build(BOARD_LIST_SELECT_WITH_MODEL_AND_PIN);
  if (!withModelAndPin.error) return (withModelAndPin.data || []) as LyknChatListRow[];

  if (isMissingPinnedAtColumn(withModelAndPin.error)) {
    const withModel = await build(BOARD_LIST_SELECT_WITH_MODEL);
    if (!withModel.error) return (withModel.data || []) as LyknChatListRow[];
    if (isMissingChatModelKeyColumn(withModel.error)) {
      const fallback = await build(BOARD_LIST_SELECT_BASE);
      if (fallback.error) throw fallback.error;
      return (fallback.data || []) as LyknChatListRow[];
    }
    throw withModel.error;
  }

  if (isMissingChatModelKeyColumn(withModelAndPin.error)) {
    const fallback = await build(BOARD_LIST_SELECT_BASE);
    if (fallback.error) throw fallback.error;
    return (fallback.data || []) as LyknChatListRow[];
  }

  throw withModelAndPin.error;
}

async function fetchBoardListRows(
  userId: string,
  overfetch: number,
): Promise<LyknChatListRow[]> {
  return runBoardListQuery(userId, (q) => q.limit(overfetch) as BoardListQuery);
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

/** Default number of chats fetched per sidebar page (infinite scroll). */
export const SIDEBAR_PAGE_SIZE = 30;

export interface LyknChatPage {
  /** Context-filtered chats for this page (empty shells removed). */
  rows: LyknChatListRow[];
  /** Offset to pass for the next page, or null when the list is exhausted. */
  nextOffset: number | null;
}

/**
 * Fetches one page of a user's chats (newest first) for the paginated sidebar.
 * Uses offset/range over `lykn_chats` so older chats stay reachable instead of
 * being capped at the first 50. Each raw page is context-filtered before return;
 * `nextOffset` is driven by the RAW page size so filtering can't prematurely end
 * pagination (a page of all-empty shells still advances the cursor).
 */
export async function fetchLyknChatsPage(
  userId: string,
  offset = 0,
  pageSize: number = SIDEBAR_PAGE_SIZE,
): Promise<LyknChatPage> {
  if (!userId) return { rows: [], nextOffset: null };
  const from = Math.max(0, offset);
  const to = from + pageSize - 1;
  const raw = await runBoardListQuery(
    userId,
    (q) => q.range(from, to) as BoardListQuery,
  );
  const rows = filterLyknChatsWithContext(raw);
  const nextOffset = raw.length === pageSize ? from + pageSize : null;
  return { rows, nextOffset };
}

/**
 * Searches a user's chats by title across the WHOLE history (not just the most
 * recent page) so old chats remain findable. Title matches are returned through
 * the context filter, mirroring the previous client-side title-search behaviour.
 */
export async function searchLyknChatsByTitle(
  userId: string,
  query: string,
  limit = 60,
): Promise<LyknChatListRow[]> {
  if (!userId) return [];
  const needle = String(query || "").trim();
  if (!needle) return [];
  // Escape PostgREST/ILIKE wildcards and the value separator so user text is
  // matched literally rather than as a pattern.
  const escaped = needle.replace(/([%_,\\])/g, "\\$1");
  const pattern = `%${escaped}%`;
  const raw = await runBoardListQuery(
    userId,
    (q) => q.ilike("title", pattern).limit(limit) as BoardListQuery,
  );
  return filterLyknChatsWithContext(raw);
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
  queryClient.invalidateQueries({ queryKey: ["sidebar-boards-paged", userId] });
  queryClient.invalidateQueries({ queryKey: ["sidebar-boards-search", userId] });
  queryClient.invalidateQueries({ queryKey: ["sidebar-chats", userId] });
  queryClient.invalidateQueries({ queryKey: ["thread-chats", userId] });
  queryClient.invalidateQueries({ queryKey: ["mindmap_boards", userId] });
}

/** Keep the active /chat/:id row visible in sidebar lists while open. */
export function mergeActiveRouteLyknChat<T extends LyknChatListRow>(
  boards: T[],
  pathname: string,
): T[] {
  const match = pathname.match(/^\/chat\/([^/]+)$/);
  if (!match) return boards;
  const id = match[1];
  if (isDemoLyknChatId(id) || id.startsWith("__prototype")) return boards;
  // Don't resurrect a chat the user just deleted — that caused a brief
  // duplicate ghost row while navigation/refetch caught up.
  if (recentlyDeletedChatIds.has(id)) {
    return boards.filter((b) => b.id !== id);
  }
  const existing = boards.find((b) => b.id === id);
  const active: T =
    existing ?? ({ id, title: "New Chat", updated_at: new Date().toISOString() } as T);
  return [active, ...boards.filter((b) => b.id !== id)];
}
