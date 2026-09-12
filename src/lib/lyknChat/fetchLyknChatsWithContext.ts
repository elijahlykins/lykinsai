import { supabase } from "@/lib/supabase";
import type { QueryClient } from "@tanstack/react-query";
import {
  boardTitleLooksCustomized,
  filterLyknChatsWithContext,
  type LyknChatListRow,
} from "@/lib/lyknChat/lyknChatHasContext";
import { isDemoLyknChatId } from "@/lib/demoLyknChats";

const BOARD_LIST_META_BASE = "id, title, updated_at, created_at";
const BOARD_LIST_META_WITH_MODEL = "id, title, updated_at, created_at, chat_model_key";
const BOARD_LIST_META_WITH_MODEL_AND_PIN =
  "id, title, updated_at, created_at, chat_model_key, pinned_at";

function withHasContent(select: string) {
  return `${select}, lykn_chat_states(has_content)`;
}

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

function isMissingHasContentColumn(error: { message?: string; code?: string } | null) {
  // Do not treat generic 42703 as this column — pin/model misses share that code.
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("has_content");
}

function withHasContentFlag<T extends LyknChatListRow>(
  rows: T[],
  flags: Map<string, boolean>,
): T[] {
  return rows.map((row) => {
    if (boardTitleLooksCustomized(row.title) || !flags.has(row.id)) return row;
    return { ...row, lykn_chat_states: { has_content: flags.get(row.id) } } as T;
  });
}

/**
 * Untitled chats need a content signal so empty shells stay out of history.
 * Prefer the boolean `has_content` column; fall back to snapshot jsonb only
 * for those untitled ids on older DBs.
 */
async function attachListContext<T extends LyknChatListRow>(rows: T[]): Promise<T[]> {
  const untitledIds = rows
    .filter((row) => !boardTitleLooksCustomized(row.title))
    .map((row) => row.id);
  if (!untitledIds.length) return rows;

  const flagged = await supabase
    .from("lykn_chat_states")
    .select("chat_id, has_content")
    .in("chat_id", untitledIds);
  if (!flagged.error) {
    const flags = new Map<string, boolean>();
    for (const row of flagged.data || []) {
      const id = String((row as { chat_id?: string }).chat_id || "");
      if (id) flags.set(id, Boolean((row as { has_content?: boolean }).has_content));
    }
    return withHasContentFlag(rows, flags);
  }

  if (!isMissingHasContentColumn(flagged.error)) throw flagged.error;

  const heavy = await supabase
    .from("lykn_chat_states")
    .select("chat_id, state")
    .in("chat_id", untitledIds);
  if (heavy.error) throw heavy.error;
  return rows.map((row) => {
    if (boardTitleLooksCustomized(row.title)) return row;
    const match = (heavy.data || []).find(
      (s) => String((s as { chat_id?: string }).chat_id || "") === row.id,
    );
    return match ? ({ ...row, lykn_chat_states: { state: (match as { state?: unknown }).state } } as T) : row;
  });
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

function isSchemaFallbackError(error: { message?: string; code?: string } | null) {
  return (
    isMissingHasContentColumn(error) ||
    isMissingPinnedAtColumn(error) ||
    isMissingChatModelKeyColumn(error)
  );
}

/**
 * Runs the board-list select against `lykn_chats` for `userId`, ordered newest
 * first, applying `shape` (range / limit / extra filters) to the query.
 * Prefers a boolean has_content embed so lists never download snapshot jsonb.
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

  const asRows = (data: unknown) => (data || []) as LyknChatListRow[];

  const leanSelects = [
    withHasContent(BOARD_LIST_META_WITH_MODEL_AND_PIN),
    withHasContent(BOARD_LIST_META_WITH_MODEL),
    withHasContent(BOARD_LIST_META_BASE),
  ];
  for (const select of leanSelects) {
    const res = await build(select);
    if (!res.error) return asRows(res.data);
    if (!isSchemaFallbackError(res.error)) throw res.error;
    if (isMissingHasContentColumn(res.error)) break;
  }

  const metaSelects = [
    BOARD_LIST_META_WITH_MODEL_AND_PIN,
    BOARD_LIST_META_WITH_MODEL,
    BOARD_LIST_META_BASE,
  ];
  for (const select of metaSelects) {
    const res = await build(select);
    if (!res.error) return attachListContext(asRows(res.data));
    if (!isSchemaFallbackError(res.error)) throw res.error;
  }

  throw new Error("Failed to load chats");
}

async function fetchBoardListRows(
  userId: string,
  overfetch: number,
): Promise<LyknChatListRow[]> {
  return runBoardListQuery(userId, (q) => q.limit(overfetch) as BoardListQuery);
}

/**
 * Fetches recent chats that have real content or a custom title. Empty
 * composers never get a row, and leftover empty shells stay out of sidebars.
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
