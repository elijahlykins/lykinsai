import { supabase } from "@/lib/supabase";

export type WorkspaceSummary = {
  boards: string;
  media: string;
  full: string;
};

const truncate = (s: string, max: number) => {
  const clean = String(s || "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
};

const stripAttachmentMarker = (content: string) =>
  String(content || "").replace(/\[ATTACHMENTS_JSON:[\s\S]*$/, "").trim();

function parseAttachments(content: string): any[] {
  const marker = "[ATTACHMENTS_JSON:";
  const start = (content || "").indexOf(marker);
  if (start === -1) return [];
  const jsonStart = start + marker.length;
  let bracketCount = 0;
  let jsonEnd = jsonStart;
  for (let i = jsonStart; i < content.length; i++) {
    if (content[i] === "[") bracketCount += 1;
    if (content[i] === "]") {
      bracketCount -= 1;
      if (bracketCount === 0) { jsonEnd = i + 1; break; }
    }
  }
  if (jsonEnd <= jsonStart) return [];
  try {
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
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

  console.log("[LYKN-WS] Fetching workspace summaries for user:", userId, "excluding board:", excludeBoardId);

  let boardsResult: any = { data: [], error: null };
  let notesResult: any = { data: [], error: null };

  try {
    [boardsResult, notesResult] = await Promise.all([
      supabase
        .from("omnia_boards")
        .select("id, title, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(20),
      supabase
        .from("notes")
        .select("id, title, content, updated_at, ai_summary, tags")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(25),
    ]);
  } catch (err) {
    console.error("[LYKN-WS] Failed to fetch boards/notes:", err);
    return { boards: "", media: "", full: "" };
  }

  if (boardsResult.error) console.warn("[LYKN-WS] Boards query error:", boardsResult.error);
  if (notesResult.error) console.warn("[LYKN-WS] Notes query error:", notesResult.error);

  const boards = (boardsResult.data || []).filter(
    (b: any) => b.id !== excludeBoardId,
  ).slice(0, 10);

  console.log("[LYKN-WS] Found", boards.length, "boards,", (notesResult.data || []).length, "notes");

  const boardIds = boards.map((b: any) => b.id);
  let latestSnapshots: Record<string, any> = {};
  if (boardIds.length > 0) {
    try {
      // Single batch query — each board has at most 1 row after migration 016.
      const { data: stateRows, error } = await supabase
        .from("omnia_board_states")
        .select("board_id, state")
        .in("board_id", boardIds.slice(0, 10));
      if (error) console.warn("[LYKN-WS] Board state batch query error:", error);
      for (const row of stateRows || []) {
        if (row.board_id && row.state) {
          latestSnapshots[row.board_id] = row.state;
        }
      }
      console.log("[LYKN-WS] Loaded snapshots for", Object.keys(latestSnapshots).length, "boards");
    } catch (err) {
      console.warn("[LYKN-WS] Board states fetch failed:", err);
    }
  }

  const boardLines = boards.map((b: any) => {
    const title = truncate(String(b.title || "Untitled"), 60);
    const snapshot = latestSnapshots[b.id];
    const summary = snapshot ? summarizeSnapshot(snapshot) : "";
    return summary
      ? `- "${title}" (id=${b.id}): ${truncate(summary, 150)}`
      : `- "${title}" (id=${b.id})`;
  });

  const notes = (notesResult.data || []).slice(0, 25);
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

  const boardsText = boardLines.length > 0
    ? `OTHER BOARDS (${boardLines.length}):\n${boardLines.join("\n")}`
    : "";

  const mediaText = noteLines.length > 0
    ? `MEDIA PAGE ITEMS (${noteLines.length}):\n${noteLines.join("\n")}`
    : "";

  // Vault / media first so client `.slice(0, 2000)` does not drop it when OTHER BOARDS is large.
  const full = [mediaText, boardsText].filter(Boolean).join("\n\n");

  console.log("[LYKN-WS] Workspace context size:", full.length, "chars. Boards section:", boardsText.length, "chars. Media section:", mediaText.length, "chars");

  const result = { boards: boardsText, media: mediaText, full };
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
