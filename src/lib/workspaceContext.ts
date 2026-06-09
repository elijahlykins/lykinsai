import { supabase } from "@/lib/supabase";
import {
  parseAttachmentsFromContent,
  stripAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";

export type WorkspaceSummary = {
  boards: string;
  media: string;
  full: string;
};

const truncate = (s: string, max: number) => {
  const clean = String(s || "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
};

// Marker handling is delegated to the shared, JSON-string-aware scanner in
// `attachmentsMarker.ts`. The previous inline copies counted raw `[`/`]`
// characters with no string-state tracking, so a filename like
// `report[2025].pdf` desynchronised the counter — yielding empty attachment
// arrays and mis-reported file types in the AI workspace context.
const stripAttachmentMarker = (content: string) =>
  stripAttachmentsMarker(String(content || ""));

function parseAttachments(content: string): any[] {
  return parseAttachmentsFromContent(content || "") as any[];
}

/** User-written notes on a vault attachment (same shape as VaultNew `parseAttachmentNotes`). */
function collectAttachmentUserNoteTexts(attachments: any[]): string[] {
  const out: string[] = [];
  for (const att of attachments) {
    const raw = Array.isArray(att?.notes) ? att.notes : [];
    for (const item of raw) {
      const text = String(item?.text || "").trim();
      if (text) out.push(text);
    }
  }
  return out;
}

function resolveAttachType(att: any): string {
  const url = String(att?.url || "");
  const name = String(att?.name || "");
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  const explicit = att?.type;
  if (explicit && explicit !== "file") return explicit;
  if (url.startsWith("data:image/")) return "image";
  if (url.startsWith("data:video/")) return "video";
  if (url.startsWith("data:audio/")) return "audio";
  const extMatch = (url.split("/").pop() || name).match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "wma"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt", "md", "csv"].includes(ext)) return "file";
  return url ? "link" : "text";
}

function summarizeSnapshot(state: any): string {
  if (!state) return "";
  const blocks = state.blocks || {};
  const order = Array.isArray(state.blockOrder) ? state.blockOrder : Object.keys(blocks);
  const snippets: string[] = [];

  for (const id of order.slice(0, 10)) {
    const b = blocks[id];
    if (!b) continue;
    if (b.type === "text" || (b.type === "create" && !b.mode)) {
      const text = truncate(String(b.content || ""), 120);
      if (text) snippets.push(text);
    } else if (b.type === "create") {
      const mode = String(b.mode || "").toLowerCase();
      if (mode === "image") snippets.push("[image]");
      else if (mode === "video") snippets.push("[video]");
      else if (mode === "taskboard") snippets.push("[taskboard]");
      else if (mode === "design") snippets.push("[design]");
      else {
        const title = String(b.data?.title || b.universalType || mode || "block");
        snippets.push(`[${truncate(title, 40)}]`);
      }
    }
    if (snippets.join(" ").length > 200) break;
  }

  const chatMsgs = Array.isArray(state.chatMessages) ? state.chatMessages : [];
  if (chatMsgs.length > 0) {
    const preview = chatMsgs
      .slice(0, 2)
      .map((m: any) => truncate(String(m.content || ""), 60))
      .filter(Boolean)
      .join(" / ");
    if (preview) snippets.push(`chat: ${preview}`);
  }

  return snippets.join(" | ");
}

const wsCache = new Map<string, { ts: number; data: WorkspaceSummary }>();
const WS_CACHE_TTL = 5 * 60_000; // 5 minutes

export async function fetchWorkspaceSummaries(
  userId: string,
  excludeBoardId?: string,
): Promise<WorkspaceSummary> {
  const cacheKey = `${userId}:${excludeBoardId ?? ""}`;
  const cached = wsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WS_CACHE_TTL) {
    return cached.data;
  }

  if (import.meta.env.DEV) console.log("[LYKN-WS] Fetching workspace summaries");

  // NOTE: the grid / `omnia_boards` surface is intentionally not loaded here.
  // The grid is not part of the current product, so we never want "OTHER
  // BOARDS" appearing in the AI's workspace context — it would make the AI
  // describe / reference a surface that doesn't exist for the user.
  let notesResult: any = { data: [], error: null };

  try {
    notesResult = await supabase
      .from("notes")
      .select("id, title, content, updated_at, ai_summary, tags")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(25);
  } catch (err) {
    if (import.meta.env.DEV) console.error("[LYKN-WS] Failed to fetch notes:", err);
    return { boards: "", media: "", full: "" };
  }

  if (notesResult.error && import.meta.env.DEV) console.warn("[LYKN-WS] Notes query error:", notesResult.error);

  if (import.meta.env.DEV) console.log("[LYKN-WS] Found", (notesResult.data || []).length, "notes");

  const notes = (notesResult.data || []).slice(0, 25);

  const tagMap: Record<string, number> = {};
  for (const n of notes) {
    const tags = Array.isArray((n as any).tags) ? (n as any).tags : [];
    for (const t of tags) {
      const tag = String(t).trim();
      if (tag) tagMap[tag] = (tagMap[tag] || 0) + 1;
    }
  }
  const tagSummaryEntries = Object.entries(tagMap).sort((a, b) => b[1] - a[1]);
  const tagSummaryStr = tagSummaryEntries.length
    ? tagSummaryEntries.map(([t, c]) => `${t} (${c})`).join(", ")
    : "";

  const noteLines = notes.map((n: any) => {
    const title = truncate(String(n.title || "Untitled"), 60);
    const summaryBit = n.ai_summary ? String(n.ai_summary).trim() : "";
    const content = truncate(
      summaryBit || stripAttachmentMarker(n.content || ""),
      summaryBit ? 160 : 100,
    );
    const tags = Array.isArray(n.tags) ? n.tags.slice(0, 3).join(", ") : "";
    const attachments = parseAttachments(n.content || "");
    const attTypes = attachments.map((a: any, i: number) => {
      const t = resolveAttachType(a);
      return `${t}[${i}]`;
    });
    const userNoteTexts = collectAttachmentUserNoteTexts(attachments);
    const userNotesBlurb =
      userNoteTexts.length > 0 ? truncate(userNoteTexts.join(" | "), 500) : "";
    const parts = [`- "${title}" (id=${n.id})`];
    if (attTypes.length > 0) parts.push(`files: ${attTypes.join(", ")}`);
    if (userNotesBlurb) parts.push(`user notes: ${userNotesBlurb}`);
    if (summaryBit) parts.push(`summary: ${content}`);
    else if (content) parts.push(content);
    if (tags) parts.push(`[${tags}]`);
    return parts.join(" — ");
  });

  const mediaHeader = noteLines.length > 0
    ? `VAULT ITEMS (${noteLines.length}):`
    : "";
  const tagLine = tagSummaryStr ? `Tags in use: ${tagSummaryStr}` : "";
  const mediaText = mediaHeader
    ? [mediaHeader, tagLine, noteLines.join("\n")].filter(Boolean).join("\n")
    : "";

  const full = mediaText;

  if (import.meta.env.DEV) console.log("[LYKN-WS] Workspace context size:", full.length, "chars");

  const result = { boards: "", media: mediaText, full };
  wsCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

/** Call after vault notes change so the next AI request gets fresh board/vault listings. */
export function invalidateWorkspaceSummaryCache(userId: string) {
  if (!userId) return;
  for (const key of wsCache.keys()) {
    if (key.startsWith(`${userId}:`)) wsCache.delete(key);
  }
}
