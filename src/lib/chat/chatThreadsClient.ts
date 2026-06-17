import { supabase } from "@/lib/supabase";
import { filterLyknChatsWithContext, type LyknChatListRow } from "@/lib/lyknChat/lyknChatHasContext";
import { setPendingBoardThread } from "@/lib/chat/chatThreadAssign";

export type ChatThreadRow = {
  id: string;
  name: string;
  updated_at: string;
  created_at: string;
};

export type ChatThreadWithBoards = ChatThreadRow & {
  chats: LyknChatListRow[];
};

export type SidebarChatEntry =
  | { kind: "chat"; board: LyknChatListRow }
  | { kind: "thread"; threadId: string; label: string; chats: LyknChatListRow[] };

const THREAD_BOARD_SELECT =
  "id, title, updated_at, created_at, chat_model_key, thread_id, lykn_chat_states(state)";

function isMissingThreadSchema(error: { message?: string; code?: string } | null) {
  const msg = String(error?.message || "").toLowerCase();
  return (
    error?.code === "42703" ||
    error?.code === "42P01" ||
    msg.includes("thread_id") ||
    msg.includes("lykn_chat_threads")
  );
}

async function insertChatBoardRow(
  userId: string,
  chatId: string,
  threadId: string | null,
): Promise<void> {
  const payload: Record<string, string> = {
    id: chatId,
    user_id: userId,
    title: "New Chat",
  };
  if (threadId) payload.thread_id = threadId;

  const { error } = await supabase.from("lykn_chats").insert(payload);
  if (!error) return;
  if (error.code === "23505") return;

  if (threadId && isMissingThreadSchema(error)) {
    const { error: retryErr } = await supabase.from("lykn_chats").insert({
      id: chatId,
      user_id: userId,
      title: "New Chat",
    });
    if (!retryErr || retryErr.code === "23505") return;
    throw retryErr;
  }

  throw error;
}

export async function fetchChatThreadsWithBoards(userId: string): Promise<ChatThreadWithBoards[]> {
  if (!userId) return [];

  const threadRes = await supabase
    .from("lykn_chat_threads")
    .select("id, name, updated_at, created_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(80);

  if (threadRes.error) {
    if (isMissingThreadSchema(threadRes.error)) return [];
    throw threadRes.error;
  }

  const threads = (threadRes.data || []) as ChatThreadRow[];
  if (!threads.length) return [];

  const threadIds = threads.map((t) => t.id);
  const boardsRes = await supabase
    .from("lykn_chats")
    .select(THREAD_BOARD_SELECT)
    .eq("user_id", userId)
    .in("thread_id", threadIds)
    .order("updated_at", { ascending: false });

  if (boardsRes.error) {
    if (isMissingThreadSchema(boardsRes.error)) return [];
    throw boardsRes.error;
  }

  const allBoards = filterLyknChatsWithContext((boardsRes.data || []) as LyknChatListRow[]);
  const byThread = new Map<string, LyknChatListRow[]>();
  for (const b of allBoards) {
    const tid = String((b as LyknChatListRow & { thread_id?: string }).thread_id || "");
    if (!tid) continue;
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid)!.push(b);
  }

  return threads
    .map((t) => ({
      ...t,
      chats: byThread.get(t.id) || [],
    }))
    .filter((t) => t.chats.length > 0);
}

export async function fetchOrphanBoards(userId: string): Promise<LyknChatListRow[]> {
  if (!userId) return [];
  const res = await supabase
    .from("lykn_chats")
    .select(THREAD_BOARD_SELECT)
    .eq("user_id", userId)
    .is("thread_id", null)
    .order("updated_at", { ascending: false })
    .limit(120);

  if (res.error) {
    if (isMissingThreadSchema(res.error)) return [];
    throw res.error;
  }
  return filterLyknChatsWithContext((res.data || []) as LyknChatListRow[]);
}

function entryUpdatedAt(entry: SidebarChatEntry): number {
  if (entry.kind === "chat") {
    return new Date(entry.board.updated_at || entry.board.created_at || 0).getTime();
  }
  return Math.max(
    ...entry.chats.map((c) => new Date(c.updated_at || c.created_at || 0).getTime()),
    0,
  );
}

/** Flat sidebar list: normal chats + one row per multi-chat thread (T + dropdown). */
export async function fetchSidebarChatEntries(userId: string): Promise<SidebarChatEntry[]> {
  if (!userId) return [];

  const res = await supabase
    .from("lykn_chats")
    .select(THREAD_BOARD_SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(120);

  if (res.error) {
    if (isMissingThreadSchema(res.error)) {
      const fallback = await supabase
        .from("lykn_chats")
        .select("id, title, updated_at, created_at, chat_model_key, lykn_chat_states(state)")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(120);
      if (fallback.error) throw fallback.error;
      return filterLyknChatsWithContext((fallback.data || []) as LyknChatListRow[]).map((board) => ({
        kind: "chat" as const,
        board,
      }));
    }
    throw res.error;
  }

  const boards = filterLyknChatsWithContext((res.data || []) as LyknChatListRow[]);
  const byThread = new Map<string, LyknChatListRow[]>();
  const orphans: LyknChatListRow[] = [];

  for (const board of boards) {
    const tid = String((board as LyknChatListRow & { thread_id?: string }).thread_id || "");
    if (!tid) {
      orphans.push(board);
      continue;
    }
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid)!.push(board);
  }

  const entries: SidebarChatEntry[] = orphans.map((board) => ({ kind: "chat", board }));

  for (const [threadId, chats] of byThread) {
    if (chats.length === 1) {
      entries.push({ kind: "chat", board: chats[0] });
      continue;
    }
    const sorted = [...chats].sort(
      (a, b) =>
        new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(),
    );
    entries.push({
      kind: "thread",
      threadId,
      label: String(sorted[0]?.title || "New Chat"),
      chats: sorted,
    });
  }

  entries.sort((a, b) => entryUpdatedAt(b) - entryUpdatedAt(a));
  return entries;
}

export async function getBoardThreadId(chatId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("lykn_chats")
    .select("thread_id")
    .eq("id", chatId)
    .maybeSingle();
  if (error) {
    if (isMissingThreadSchema(error)) return null;
    throw error;
  }
  return data?.thread_id ? String(data.thread_id) : null;
}

export async function ensureBoardThread(
  userId: string,
  chatId: string,
  { title = "New Thread" } = {},
): Promise<string | null> {
  const existing = await getBoardThreadId(chatId);
  if (existing) return existing;

  const threadId = crypto.randomUUID();
  const { error: threadErr } = await supabase.from("lykn_chat_threads").insert({
    id: threadId,
    user_id: userId,
    name: String(title || "New Thread").trim().slice(0, 120) || "New Thread",
  });
  if (threadErr) {
    if (isMissingThreadSchema(threadErr)) return null;
    throw threadErr;
  }

  const { error: boardErr } = await supabase
    .from("lykn_chats")
    .update({ thread_id: threadId })
    .eq("id", chatId)
    .eq("user_id", userId);
  if (boardErr) {
    if (isMissingThreadSchema(boardErr)) return null;
    throw boardErr;
  }
  return threadId;
}

/** Plain new chat — no thread until the user opts in from the chat UI. */
export async function createNewChat(userId: string): Promise<{ chatId: string }> {
  const chatId = crypto.randomUUID();
  await insertChatBoardRow(userId, chatId, null);
  return { chatId };
}

/** Link the current chat to a new sibling chat (creates the thread on first use). */
export async function beginThreadFromBoard(
  userId: string,
  sourceChatId: string,
  { title = "New Chat" } = {},
): Promise<{ threadId: string; chatId: string }> {
  const existingThreadId = await getBoardThreadId(sourceChatId);
  if (existingThreadId) {
    const { chatId } = await createChatInThread(userId, existingThreadId);
    return { threadId: existingThreadId, chatId };
  }

  const threadId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  const threadName = String(title || "New Chat").trim().slice(0, 120) || "New Chat";
  setPendingBoardThread(chatId, threadId);

  const { error: threadErr } = await supabase.from("lykn_chat_threads").insert({
    id: threadId,
    user_id: userId,
    name: threadName,
  });
  if (threadErr && !isMissingThreadSchema(threadErr)) throw threadErr;

  const linkThreadId = isMissingThreadSchema(threadErr) ? null : threadId;

  const { error: linkErr } = await supabase
    .from("lykn_chats")
    .update({ thread_id: linkThreadId })
    .eq("id", sourceChatId)
    .eq("user_id", userId);
  if (linkErr && !isMissingThreadSchema(linkErr)) throw linkErr;

  await insertChatBoardRow(userId, chatId, linkThreadId);

  if (linkThreadId) {
    await supabase
      .from("lykn_chat_threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", linkThreadId)
      .eq("user_id", userId);
  }

  return { threadId: linkThreadId || threadId, chatId };
}

/** @deprecated Use createNewChat — threads are opt-in from the chat UI. */
export async function createChatThreadWithBoard(userId: string): Promise<{ threadId: string; chatId: string }> {
  const { chatId } = await createNewChat(userId);
  return { threadId: "", chatId };
}

export async function createChatInThread(
  userId: string,
  threadId: string,
): Promise<{ chatId: string }> {
  const chatId = crypto.randomUUID();
  setPendingBoardThread(chatId, threadId);

  await supabase
    .from("lykn_chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId)
    .eq("user_id", userId);

  await insertChatBoardRow(userId, chatId, threadId);

  return { chatId };
}

export async function updateChatThreadName(
  userId: string,
  threadId: string,
  name: string,
) {
  const trimmed = String(name || "").trim().slice(0, 120);
  if (!trimmed || !threadId) return;
  await supabase
    .from("lykn_chat_threads")
    .update({ name: trimmed, updated_at: new Date().toISOString() })
    .eq("id", threadId)
    .eq("user_id", userId);
}

export async function maybeSyncThreadNameFromChat(
  userId: string,
  chatId: string,
  chatTitle: string,
) {
  const title = String(chatTitle || "").trim();
  if (!title || title === "New Chat" || title === "Untitled board") return;

  const threadId = await getBoardThreadId(chatId);
  if (!threadId) return;

  const { data: thread } = await supabase
    .from("lykn_chat_threads")
    .select("name")
    .eq("id", threadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!thread) return;

  const threadName = String(thread.name || "").trim();
  if (threadName && threadName !== "New Thread") return;

  await updateChatThreadName(userId, threadId, title);
}

export async function fetchChatsInThread(userId: string, threadId: string): Promise<LyknChatListRow[]> {
  if (!userId || !threadId) return [];
  const res = await supabase
    .from("lykn_chats")
    .select(THREAD_BOARD_SELECT)
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .order("updated_at", { ascending: false });
  if (res.error) {
    if (isMissingThreadSchema(res.error)) return [];
    throw res.error;
  }
  return filterLyknChatsWithContext((res.data || []) as LyknChatListRow[]);
}
