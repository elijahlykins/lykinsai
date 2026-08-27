import { supabase } from "./supabase";

export type Surface = "chat" | "grid" | "project" | "vault";

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
// Save a user ↔ assistant exchange (main /app chat, project, legacy vault)
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
  chat_id: string;
  state: any;
  updated_at: string;
  lykn_chats: { title: string } | null;
}

async function loadFromBoardStates(
  userId: string,
  excludeChatId?: string | null
): Promise<MemoryEntry[]> {
  try {
    const { data, error } = await supabase
      .from("lykn_chat_states")
      .select("chat_id, state, updated_at, lykn_chats(title)")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(BOARDS_TO_SCAN);

    if (error || !data?.length) return [];

    const entries: MemoryEntry[] = [];
    for (const row of data as BoardChatRow[]) {
      if (excludeChatId && row.chat_id === excludeChatId) continue;
      const state = row.state;
      if (!state) continue;

      const title = (row.lykn_chats as any)?.title || "New Chat";
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
          id: `chat-${row.chat_id}-${entries.length}`,
          surface: "chat",
          surface_id: row.chat_id,
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
  excludeChatId?: string | null
): Promise<MemoryEntry[]> {
  const [boardEntries, tableEntries] = await Promise.all([
    loadFromBoardStates(userId, excludeChatId),
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
const MEMORY_CHAR_BUDGET = 4500;
const EPISODIC_MAX = 5;

function tokenizeQuery(q: string): string[] {
  return String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 14);
}

function episodicScore(entry: MemoryEntry, tokens: string[]): number {
  if (!tokens.length) return 0;
  const hay = `${entry.user_message || ""} ${entry.assistant_message || ""} ${entry.surface_title || ""} ${entry.summary || ""}`.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits += 1;
  }
  // Mild recency boost so recent relevant chats win ties.
  const ageDays = Math.max(
    0,
    (Date.now() - (Date.parse(entry.created_at) || 0)) / (1000 * 60 * 60 * 24),
  );
  const recency = ageDays < 7 ? 0.35 : ageDays < 30 ? 0.15 : 0;
  return hits / tokens.length + recency;
}

function relativeWhen(iso: string | null | undefined): string {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "earlier";
  const days = Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/**
 * Rank past exchanges for this turn and format as episodic recalls.
 * Prefer query-relevant hits; fall back to recent if nothing matches.
 */
export function formatMemoryForPrompt(
  entries: MemoryEntry[],
  queryText?: string,
): string {
  if (!entries.length) return "";

  const tokens = tokenizeQuery(queryText || "");
  const scored = entries
    .map((e) => ({ e, score: episodicScore(e, tokens) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (Date.parse(b.e.created_at) || 0) - (Date.parse(a.e.created_at) || 0);
    });

  const relevant = scored.filter((x) => x.score > 0).slice(0, EPISODIC_MAX);
  const picked = (relevant.length ? relevant : scored.slice(0, 3)).map((x) => x.e);

  const lines: string[] = [
    "[EPISODIC]",
    "Past chats that may be relevant. When one clearly fits, you may briefly reference it (\"Last time we talked about…\") — do not invent episodes. Prefer Markdown Memory for durable identity.",
    "",
  ];
  let chars = lines.join("\n").length;

  for (const e of picked) {
    const label = surfaceLabel(e);
    const when = relativeWhen(e.created_at);
    const userSnip = (e.summary || e.user_message).replace(/\s+/g, " ").trim().slice(0, 280);
    const aiSnip = (e.assistant_message || "").replace(/\s+/g, " ").trim().slice(0, 220);
    const block = [
      `• ${when} — ${label}`,
      `  They said: ${userSnip}`,
      aiSnip ? `  You replied: ${aiSnip}` : null,
      e.surface_id ? `  chat_id: ${e.surface_id}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    if (chars + block.length > MEMORY_CHAR_BUDGET) break;
    lines.push(block);
    chars += block.length;
  }

  return lines.join("\n").trim();
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
let _cache: { userId: string; excludeChatId: string | null; entries: MemoryEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL = 60_000;

export async function getMemoryForPrompt(
  userId: string,
  excludeChatId?: string | null,
  queryText?: string,
): Promise<string> {
  const bid = excludeChatId || null;
  if (
    _cache &&
    _cache.userId === userId &&
    _cache.excludeChatId === bid &&
    Date.now() - _cache.fetchedAt < CACHE_TTL
  ) {
    return formatMemoryForPrompt(_cache.entries, queryText);
  }
  const entries = await loadAllMemory(userId, bid);
  _cache = { userId, excludeChatId: bid, entries, fetchedAt: Date.now() };
  return formatMemoryForPrompt(entries, queryText);
}

export function invalidateMemoryCache(): void {
  _cache = null;
}
