import { supabase } from "./supabase";

export type Surface = "grid" | "project" | "vault";

export interface MemoryEntry {
  id: string;
  surface: Surface;
  surface_id: string | null;
  surface_title: string | null;
  user_message: string;
  assistant_message: string;
  summary: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Save a user ↔ assistant exchange (for vault/project and long-term storage)
// ---------------------------------------------------------------------------
export async function saveExchange(
  userId: string,
  surface: Surface,
  surfaceId: string | null,
  surfaceTitle: string | null,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  if (!userMessage || !assistantMessage) return;
  try {
    const { data, error } = await supabase
      .from("ai_conversation_memory")
      .insert({
        user_id: userId,
        surface,
        surface_id: surfaceId || null,
        surface_title: surfaceTitle || null,
        user_message: userMessage.slice(0, 4000),
        assistant_message: assistantMessage.slice(0, 4000),
      })
      .select("id")
      .single();
    if (error && import.meta.env.DEV) console.warn("[ConversationMemory] save failed:", error.message);
    else if (data?.id) {
      const text = `User:\n${userMessage.slice(0, 8000)}\n\nAssistant:\n${assistantMessage.slice(0, 8000)}`;
      const { scheduleSynthesisReindex } = await import("@/lib/synthesis/queueReindex");
      scheduleSynthesisReindex({
        sourceType: "conversation_exchange",
        sourceId: data.id,
        text,
        metadata: { surface, surface_id: surfaceId, surface_title: surfaceTitle },
      });
      const { scheduleUserProfileRefresh } = await import("@/lib/synthesis/profileRefresh");
      scheduleUserProfileRefresh(userId);
    }
  } catch {
    // Table may not exist yet — silently ignore
  }
}

// ---------------------------------------------------------------------------
// Load conversation history from board states (primary source — always works)
// ---------------------------------------------------------------------------
const BOARDS_TO_SCAN = 8;
const MESSAGES_PER_BOARD = 6;

interface BoardChatRow {
  board_id: string;
  state: any;
  updated_at: string;
  omnia_boards: { title: string } | null;
}

async function loadFromBoardStates(
  userId: string,
  excludeBoardId?: string | null
): Promise<MemoryEntry[]> {
  try {
    const { data, error } = await supabase
      .from("omnia_board_states")
      .select("board_id, state, updated_at, omnia_boards(title)")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(BOARDS_TO_SCAN);

    if (error || !data?.length) return [];

    const entries: MemoryEntry[] = [];
    for (const row of data as BoardChatRow[]) {
      if (excludeBoardId && row.board_id === excludeBoardId) continue;
      const state = row.state;
      if (!state) continue;

      const title = (row.omnia_boards as any)?.title || "New Chat";
      const chatMsgs: any[] = Array.isArray(state.chatMessages) ? state.chatMessages : [];
      if (!chatMsgs.length) continue;

      // Walk through messages and pair user→assistant exchanges
      const pairs: { user: string; assistant: string }[] = [];
      for (const msg of chatMsgs) {
        if (msg.role === "user" && msg.content && msg.aiResponse) {
          pairs.push({
            user: String(msg.content).slice(0, 800),
            assistant: String(msg.aiResponse).slice(0, 800),
          });
        }
      }

      // Take the most recent exchanges from this board
      const recent = pairs.slice(-MESSAGES_PER_BOARD);
      for (const p of recent) {
        entries.push({
          id: `board-${row.board_id}-${entries.length}`,
          surface: "grid",
          surface_id: row.board_id,
          surface_title: title,
          user_message: p.user,
          assistant_message: p.assistant,
          summary: null,
          created_at: row.updated_at || new Date().toISOString(),
        });
      }
    }
    return entries;
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[ConversationMemory] board states load failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Load from the dedicated memory table (vault/project chats + future data)
// ---------------------------------------------------------------------------
async function loadFromMemoryTable(userId: string): Promise<MemoryEntry[]> {
  try {
    const { data, error } = await supabase
      .from("ai_conversation_memory")
      .select("id, surface, surface_id, surface_title, user_message, assistant_message, summary, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error || !data?.length) return [];
    return (data as MemoryEntry[]).reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Merge and deduplicate from both sources
// ---------------------------------------------------------------------------
async function loadAllMemory(
  userId: string,
  excludeBoardId?: string | null
): Promise<MemoryEntry[]> {
  const [boardEntries, tableEntries] = await Promise.all([
    loadFromBoardStates(userId, excludeBoardId),
    loadFromMemoryTable(userId),
  ]);

  // Combine both sources — table entries come after board entries
  // (board entries are from older/other grids, table entries may include vault/project)
  const combined = [...boardEntries, ...tableEntries];

  // Deduplicate by matching user_message content
  const seen = new Set<string>();
  const unique: MemoryEntry[] = [];
  for (const e of combined) {
    const key = e.user_message.slice(0, 100).toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }

  return unique;
}

// ---------------------------------------------------------------------------
// Format memory entries into a prompt-friendly string
// ---------------------------------------------------------------------------
const MEMORY_CHAR_BUDGET = 6000;

export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
  if (!entries.length) return "";

  const lines: string[] = [];
  let chars = 0;

  for (const e of entries) {
    const label = surfaceLabel(e);
    const userSnip = (e.summary || e.user_message).slice(0, 600);
    const aiSnip = (e.summary || e.assistant_message).slice(0, 600);
    const block = `[${label}]\nUser: ${userSnip}\nAssistant: ${aiSnip}`;

    if (chars + block.length > MEMORY_CHAR_BUDGET) break;
    lines.push(block);
    chars += block.length;
  }

  return lines.join("\n\n");
}

function surfaceLabel(e: MemoryEntry): string {
  const title = e.surface_title || "";
  switch (e.surface) {
    case "grid":
      return title ? `Grid "${title}"` : "Grid";
    case "project":
      return title ? `Project "${title}"` : "Project";
    case "vault":
      return "The Vault";
    default:
      return title || "Unknown";
  }
}

// ---------------------------------------------------------------------------
// In-memory cache so we don't re-fetch on every message
// ---------------------------------------------------------------------------
let _cache: { userId: string; excludeBoardId: string | null; entries: MemoryEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL = 60_000;

export async function getMemoryForPrompt(
  userId: string,
  excludeBoardId?: string | null
): Promise<string> {
  const bid = excludeBoardId || null;
  if (
    _cache &&
    _cache.userId === userId &&
    _cache.excludeBoardId === bid &&
    Date.now() - _cache.fetchedAt < CACHE_TTL
  ) {
    return formatMemoryForPrompt(_cache.entries);
  }
  const entries = await loadAllMemory(userId, bid);
  _cache = { userId, excludeBoardId: bid, entries, fetchedAt: Date.now() };
  return formatMemoryForPrompt(entries);
}

export function invalidateMemoryCache(): void {
  _cache = null;
}
