import type { NotePage } from "@/components/notes/NotesPanel";

const MEDIA_MODES = new Set([
  "image",
  "video",
  "audio",
  "embed",
  "pdf",
  "youtube",
  "social",
  "spreadsheet",
  "table",
  "media",
  "link",
  "file",
]);

function isNotesContentEmpty(content: unknown): boolean {
  if (!content || typeof content !== "object") return true;
  if ((content as { type?: string }).type !== "doc") return false;
  const nodes = Array.isArray((content as { content?: unknown }).content)
    ? (content as { content: unknown[] }).content
    : [];
  if (nodes.length === 0) return true;
  const isEmptyNode = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return true;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === "text") return !String(n.text || "").trim();
    if (n.type === "paragraph" || n.type === "heading") {
      const kids = Array.isArray(n.content) ? n.content : [];
      return kids.every(isEmptyNode);
    }
    return false;
  };
  return nodes.every(isEmptyNode);
}

function isNotesPagesEmpty(pages: NotePage[] | null | undefined): boolean {
  if (!Array.isArray(pages) || pages.length === 0) return true;
  return pages.every((p) => isNotesContentEmpty(p?.content));
}

function blockHasMeaningfulContent(block: unknown): boolean {
  const b = block as Record<string, unknown> | null;
  if (!b) return false;
  const data =
    b.data && typeof b.data === "object" ? (b.data as Record<string, unknown>) : {};
  const content = String(data.content ?? data.body ?? b.content ?? "").trim();
  const fmt = String(b.format || data.format || "").toLowerCase();
  const mode = String(b.mode || data.mode || "").toLowerCase();
  if (fmt === "media" || fmt === "table" || fmt === "button") return true;
  if (mode && MEDIA_MODES.has(mode)) return true;
  if (b.type === "create") return true;
  if (
    data.url ||
    data.src ||
    data.videoId ||
    data.storagePath ||
    data.dataUrl ||
    data.audioData ||
    data.pdfData ||
    data.oembedHtml ||
    data.extractedText
  ) {
    return true;
  }
  return content.length > 0;
}

/** True when a persisted board snapshot has chat, grid, or notes content worth listing. */
export function snapshotHasContext(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const snap = snapshot as Record<string, unknown>;

  const chatMessages = Array.isArray(snap.chatMessages) ? snap.chatMessages : [];
  if (chatMessages.length > 0) return true;

  const aiThread = Array.isArray(snap.aiThread) ? snap.aiThread : [];
  if (aiThread.length > 0) return true;

  const blocks = (snap.blocks && typeof snap.blocks === "object"
    ? snap.blocks
    : {}) as Record<string, unknown>;
  const blockOrder = Array.isArray(snap.blockOrder) ? snap.blockOrder : Object.keys(blocks);
  const meaningful = blockOrder.filter((id) => blockHasMeaningfulContent(blocks[String(id)]));
  if (meaningful.length > 0) return true;

  if (!isNotesPagesEmpty(snap.notesPages as NotePage[] | undefined)) return true;

  return false;
}

const DEFAULT_CHAT_TITLES = new Set(["New Chat", "Untitled board", ""]);

export function boardTitleLooksCustomized(title: string | null | undefined): boolean {
  const t = String(title || "").trim();
  return Boolean(t) && !DEFAULT_CHAT_TITLES.has(t);
}

export type LyknChatListRow = {
  id: string;
  title: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  chat_model_key?: string | null;
  thread_id?: string | null;
};

function stateFromBoardRow(row: Record<string, unknown>): unknown {
  const rel = row.lykn_chat_states;
  if (Array.isArray(rel)) return rel[0] && typeof rel[0] === "object" ? (rel[0] as { state?: unknown }).state : null;
  if (rel && typeof rel === "object") return (rel as { state?: unknown }).state ?? null;
  return null;
}

/** Boards that should appear in chat sidebars and the synthesis-layer Chats cluster. */
export function filterLyknChatsWithContext<T extends LyknChatListRow>(
  rows: T[],
  stateByChatId?: Map<string, unknown>,
): T[] {
  return rows.filter((row) => {
    if (boardTitleLooksCustomized(row.title)) return true;
    const state = stateByChatId?.get(row.id) ?? stateFromBoardRow(row as Record<string, unknown>);
    // Board row with no snapshot yet — user explicitly opened a new chat.
    if (state == null) return true;
    return snapshotHasContext(state);
  });
}
