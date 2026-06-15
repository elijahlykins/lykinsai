/**
 * Builds the same vault item lines as the in-app Vault chat (VaultNew handleChatSend),
 * so other chat surfaces can send equivalent [WORKSPACE_CONTEXT] vault detail.
 */
import { supabase } from "@/lib/supabase";
import { detectSocialPlatform, isSocialEmbedType } from "@/lib/media/socialEmbed";
import {
  parseAttachmentsFromContent,
  stripAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";

export const VAULT_AI_NOTES_LIMIT = 100;
export const VAULT_AI_MAX_CARD_LINES = 40;

// `attachments` is embedded inside `content` as [ATTACHMENTS_JSON:...]; no dedicated column.
const NOTES_COLUMN_SETS = [
  "id, title, content, tags, created_at, updated_at, source",
  "id, title, content, tags, created_at, updated_at",
  "id, title, content, created_at, updated_at",
] as const;

export type VaultAiNoteRow = Record<string, unknown>;

export async function fetchNotesForVaultAi(userId: string): Promise<VaultAiNoteRow[]> {
  if (!userId) return [];
  for (const cols of NOTES_COLUMN_SETS) {
    const { data, error } = await supabase
      .from("notes")
      // Column sets mirror VaultNew fetch — string is not a narrow union on generated types.
      .select(cols as any)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(VAULT_AI_NOTES_LIMIT);
    if (!error && Array.isArray(data)) return data as unknown as VaultAiNoteRow[];
  }
  return [];
}

// Marker parsing delegates to the shared JSON-string-aware scanner so that
// `[`/`]` characters inside attachment fields don't break boundaries.
function stripAttachmentJsonMarker(content: string) {
  return stripAttachmentsMarker(String(content || ""));
}

function parseAttachmentsFromNote(note: VaultAiNoteRow) {
  const normalized: unknown[] = [];

  if (Array.isArray(note.attachments)) {
    normalized.push(...note.attachments);
  } else if (typeof note.attachments === "string") {
    try {
      const parsed = JSON.parse(note.attachments);
      if (Array.isArray(parsed)) normalized.push(...parsed);
    } catch {
      /* content marker may still work */
    }
  }

  if (normalized.length === 0 && note.content) {
    normalized.push(...parseAttachmentsFromContent(String(note.content)));
  }

  return normalized.filter(Boolean);
}

function resolveAttachmentType(attachment: Record<string, unknown> = {}) {
  const url = String(attachment.url || "");
  const name = String(attachment.name || "");

  if (isSocialEmbedType(attachment.oembedType as string | undefined)) return String(attachment.oembedType);
  const socialPlatform = detectSocialPlatform(url);
  if (socialPlatform) return socialPlatform;

  if (attachment.type === "bookmark" || attachment.type === "link" || attachment.siteName || attachment.articleText)
    return "bookmark";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";

  const explicit = attachment.type;
  if (explicit && explicit !== "file") return explicit as string;
  if (url.startsWith("data:image/")) return "image";
  if (url.startsWith("data:video/")) return "video";
  if (url.startsWith("data:audio/")) return "audio";

  const extMatch = (url.split("/").pop() || name).match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";

  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "wma"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["xls", "xlsx", "csv"].includes(ext) || attachment.type === "spreadsheet") return "spreadsheet";
  if (["doc", "docx", "ppt", "pptx", "txt", "md"].includes(ext)) return "file";

  return "file";
}

function buildTextExcerpt(htmlOrText = "") {
  const noHtml = String(htmlOrText).replace(/<[^>]+>/g, " ");
  return noHtml.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(input = "") {
  const map: Record<string, string> = {
    "&quot;": "\"",
    "&#039;": "'",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
  };
  return String(input).replace(/&quot;|&#039;|&amp;|&lt;|&gt;/g, (m) => map[m] || m);
}

function extractChatPreview(content = "") {
  const raw = String(content || "").trim();
  if (!raw) return null;

  const tryParse = (value: string) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const decoded = decodeHtmlEntities(raw);
  const candidateStrings = [raw, decoded];

  const extractJsonCandidates = (value: string) => {
    const candidates: string[] = [];
    const firstBrace = value.indexOf("{");
    const lastBrace = value.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidates.push(value.slice(firstBrace, lastBrace + 1));
    }
    const blocksIdx = value.indexOf('"blocks"');
    if (blocksIdx !== -1) {
      const left = value.lastIndexOf("{", blocksIdx);
      if (left !== -1) {
        const right = value.lastIndexOf("}");
        if (right > left) candidates.push(value.slice(left, right + 1));
      }
    }
    return candidates;
  };

  let parsed: Record<string, unknown> | null = null;
  for (const source of candidateStrings) {
    parsed = tryParse(source);
    if (parsed) break;
    const embeddedCandidates = extractJsonCandidates(source);
    for (const candidate of embeddedCandidates) {
      parsed = tryParse(candidate);
      if (parsed) break;
    }
    if (parsed) break;
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).blocks)) return null;

  const turns: { q: string; a: string; ts: unknown }[] = [];
  const textOnlyPrompts: string[] = [];
  (parsed as any).blocks.forEach((block: any) => {
    const userText = block?.content?.text ? buildTextExcerpt(block.content.text) : "";
    if (userText) textOnlyPrompts.push(userText);
    const answers = Array.isArray(block?.content?.aiAnswers) ? block.content.aiAnswers : [];
    answers.forEach((answer: any) => {
      const q = buildTextExcerpt(answer?.q || userText || "");
      const a = buildTextExcerpt(answer?.a || "");
      if (q || a) turns.push({ q, a, ts: answer?.ts || null });
    });
  });

  if (turns.length === 0) {
    const firstPrompt = textOnlyPrompts[0] || "";
    return {
      turnsCount: 0,
      question: firstPrompt || "Chat draft",
      answer: firstPrompt ? "" : "No messages yet.",
    };
  }

  const first = turns[0];
  return {
    turnsCount: turns.length,
    question: first.q || "Chat message",
    answer: first.a || "",
  };
}

function extractYouTubeLinks(content = "") {
  const text = String(content || "");
  if (!text) return [];
  const regex =
    /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+(?:[^\s<)]*)?|youtu\.be\/[\w-]+(?:[^\s<)]*)?)/gi;
  const matches = text.match(regex) || [];
  return [...new Set(matches)];
}

function formatDate(value: unknown) {
  if (!value) return "No date";
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return "No date";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function parseAttachmentNotes(attachment: Record<string, unknown> = {}) {
  const raw = Array.isArray(attachment?.notes) ? attachment.notes : [];
  return raw
    .map((item: any, idx: number) => {
      const text = String(item?.text || "").trim();
      if (!text) return null;
      return {
        id: String(item?.id || `note-${idx}`),
        text,
        created_at: item?.created_at || null,
      };
    })
    .filter(Boolean) as { id: string; text: string; created_at: unknown }[];
}

type VaultAiCard = {
  id: string;
  kind: "attachment" | "quick-note";
  noteId: string;
  attachmentIndex?: number;
  type?: string;
  attachment?: Record<string, unknown>;
  title?: string;
  parentTitle?: string;
  noteExcerpt?: string;
  dateLabel?: string;
  tags?: string[];
  excerpt?: string;
};

/** Mirrors VaultNew `vaultCards` but omits chat-preview tiles (same as Vault chat visibility). */
function buildVaultCardsForAiChat(notes: VaultAiNoteRow[]): VaultAiCard[] {
  const safeNotes = notes.filter((n) => n && !(n as any).trashed);
  const cards: VaultAiCard[] = [];

  safeNotes.forEach((note) => {
    const attachments = parseAttachmentsFromNote(note) as Record<string, unknown>[];
    const cleanContent = stripAttachmentJsonMarker(String(note.content || ""));
    const chatPreview = extractChatPreview(cleanContent);
    const youtubeLinks = extractYouTubeLinks(cleanContent);
    const dateLabel = formatDate(note.updated_at || note.created_at);
    const isStandaloneQuickNote =
      String(note?.source || "").toLowerCase() === "quick_note" ||
      String(note?.source || "").toLowerCase() === "voice_note" ||
      (String(note?.title || "")
        .trim()
        .toLowerCase() === "quick note" &&
        attachments.length === 0);
    const excerpt = isStandaloneQuickNote
      ? String(cleanContent || "")
          .replace(/\r\n/g, "\n")
          .trim()
      : buildTextExcerpt(cleanContent);

    const noteTags = Array.isArray(note.tags) ? (note.tags as string[]) : [];
    const noteExcerpt = excerpt || "";

    attachments.forEach((attachment, idx) => {
      const type = resolveAttachmentType(attachment);
      cards.push({
        id: `${note.id}-att-${(attachment as any).id || idx}`,
        kind: "attachment",
        noteId: String(note.id),
        attachmentIndex: idx,
        type,
        attachment,
        title: String((attachment as any).name || note.title || "Untitled"),
        parentTitle: String(note.title || "Untitled note"),
        noteExcerpt,
        dateLabel,
        tags: noteTags,
      });
    });

    if (attachments.length === 0 && youtubeLinks.length > 0) {
      youtubeLinks.forEach((url, idx) => {
        cards.push({
          id: `${note.id}-yt-${idx}`,
          kind: "attachment",
          noteId: String(note.id),
          type: "youtube",
          attachment: { url, name: "YouTube Video" },
          title: "YouTube Video",
          parentTitle: String(note.title || "Untitled note"),
          noteExcerpt,
          dateLabel,
          tags: noteTags,
        });
      });
    }

    // Skip chat-preview cards — Vault chat uses visibleCards which excludes them.

    if (excerpt && attachments.length === 0 && (isStandaloneQuickNote || !chatPreview)) {
      cards.push({
        id: `${note.id}-quick-note`,
        kind: "quick-note",
        noteId: String(note.id),
        title: String(note.title || "Quick Note"),
        excerpt,
        dateLabel,
        tags: noteTags,
      });
    }
  });

  const seen = new Set<string>();
  return cards.filter((card) => {
    if (card.kind === "attachment") {
      const att = card.attachment || {};
      const url = String(att.url || "").trim();
      const videoId = String((att as any).videoId || "").trim();
      const storagePath = String((att as any).storagePath || (att as any).fileId || "").trim();
      const key =
        (videoId && `yt:${videoId}`) ||
        (storagePath && `path:${storagePath}`) ||
        (url && !url.startsWith("data:") && `url:${url}`) ||
        null;
      if (key) {
        if (seen.has(key)) return false;
        seen.add(key);
      }
    } else if (card.kind === "quick-note") {
      const text = String(card.excerpt || "")
        .trim()
        .slice(0, 200);
      if (text) {
        // Include the noteId in the dedup key so two distinct notes
        // with overlapping first-200-character excerpts don't get
        // collapsed into one card. Without `noteId` here, the user
        // would silently lose one of two legitimate quick notes that
        // happen to start the same way ("Meeting notes — ..." etc.).
        const key = `qn:${card.noteId || ""}:${text}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
    }
    return true;
  });
}

/** One line per card — same string shape as VaultNew handleChatSend. */
function formatVaultCardLineForAi(card: VaultAiCard): string {
  const date = card.dateLabel || "unknown date";
  const tagStr = card.tags?.length ? ` [tags: ${card.tags.join(", ")}]` : "";
  // Items are referenced in chat by `(id=<noteId>)` so the AI can mention them.
  // The grid / "pull onto board" surface no longer exists, so we don't emit
  // any `pull=[PULL_MEDIA:...]` tokens — the AI must reference items in plain
  // chat (and use [TAG_NOTES:...] for tagging), nothing else.
  const noteId = card.noteId || "";
  const idStr = noteId ? ` (id=${noteId})` : "";
  const pullStr = "";

  if (card.kind === "attachment") {
    const att = card.attachment || {};
    const type = (card.type || "file").toUpperCase();
    const name = card.title || (att.name as string) || "Untitled file";
    const attIdx = Number.isInteger(card.attachmentIndex) ? ` attachmentIndex=${card.attachmentIndex}` : "";
    const extras: string[] = [];
    // Connected-source items (Notion / Gmail / Slack / Readwise / etc.) save
    // the real body text into `attachment.articleText`. For those we lift the
    // per-card excerpt to 2500 chars because that text IS the document — a
    // 500-char teaser is useless for "summarise my Notion page about X".
    // Generic bookmarks stay at 500 since their articleText is just scraped
    // metadata, not the source of truth. The outer workspaceContext budget
    // (28K) still truncates after concat, so older items get clipped before
    // recent ones — acceptable since fetchNotesForVaultAi orders by
    // updated_at DESC.
    const CONNECTED_SOURCE_OEMBED_TYPES = new Set([
      "notion", "gmail", "outlook", "slack", "github", "linear",
      "todoist", "trello", "loom", "vimeo", "figma", "canva",
      "dribbble", "behance", "readwise", "raindrop", "pinterest",
      "bluesky", "reddit", "mastodon", "gdrive", "gcal", "spotify",
    ]);
    const oembedType = String((att as any).oembedType || "").toLowerCase();
    const isConnectedSource = CONNECTED_SOURCE_OEMBED_TYPES.has(oembedType);
    const articleBudget = isConnectedSource ? 2500 : 500;
    if (card.parentTitle && card.parentTitle !== name && card.parentTitle !== "Untitled note") {
      extras.push(`From note: "${card.parentTitle}"`);
    }
    if (card.noteExcerpt) extras.push(`Note context: ${card.noteExcerpt.slice(0, 300)}`);
    if ((att as any).aiDescription) extras.push(`Visual: ${String((att as any).aiDescription).slice(0, 300)}`);
    if ((att as any).extractedText) extras.push(`Content: ${String((att as any).extractedText).slice(0, 500)}`);
    if ((att as any).description) extras.push(`Desc: ${String((att as any).description).slice(0, 250)}`);
    if ((att as any).articleText) extras.push(`${isConnectedSource ? oembedType : "Article"}: ${String((att as any).articleText).slice(0, articleBudget)}`);
    if ((att as any).siteName) extras.push(`Site: ${(att as any).siteName}`);
    if ((att as any).url) extras.push(`URL: ${(att as any).url}`);
    const fileNotes = parseAttachmentNotes(att);
    if (fileNotes.length > 0) {
      extras.push(
        `User notes (context on why they saved this): ${fileNotes.map((n) => n.text).join(" | ").slice(0, 400)}`,
      );
    }
    return `[${type}] "${name}"${idStr}${attIdx}${pullStr} (${date})${tagStr}${extras.length ? " — " + extras.join(" | ") : ""}`;
  }

  if (card.kind === "quick-note") {
    return `[NOTE] "${card.title || "Quick Note"}"${idStr}${pullStr} — ${(card.excerpt || "").slice(0, 500)} (${date})${tagStr}`;
  }

  return `[ITEM] "${card.title || "Untitled"}"${idStr}${pullStr} (${date})${tagStr}`;
}

function collectAllTagsFromNotes(notes: VaultAiNoteRow[]): string {
  const tagMap: Record<string, number> = {};
  for (const note of notes) {
    const tags = Array.isArray(note.tags) ? (note.tags as string[]) : [];
    tags.forEach((t) => {
      const tag = String(t).trim();
      if (!tag) return;
      tagMap[tag] = (tagMap[tag] || 0) + 1;
    });
  }
  const sorted = Object.entries(tagMap).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted.map(([t]) => t).join(", ") : "(none yet)";
}

/** Hard cap on TAG DIRECTORY entries so a heavily-tagged vault doesn't
 * blow the AI prompt token budget. The first 60 tags (sorted by item
 * count) are by far the most useful for the model anyway. */
const MAX_TAG_DIRECTORY_ENTRIES = 60;

/** Builds a TAG DIRECTORY mapping each tag to its associated note IDs and titles. */
function buildTagDirectory(notes: VaultAiNoteRow[]): string {
  const tagIndex: Record<string, { id: string; title: string }[]> = {};
  for (const note of notes) {
    const tags = Array.isArray(note.tags) ? (note.tags as string[]) : [];
    if (tags.length === 0) continue;
    const id = String(note.id || "");
    const title = String(note.title || "Untitled").slice(0, 60);
    for (const raw of tags) {
      const tag = String(raw).trim();
      if (!tag) continue;
      if (!tagIndex[tag]) tagIndex[tag] = [];
      tagIndex[tag].push({ id, title });
    }
  }
  const sorted = Object.entries(tagIndex).sort((a, b) => b[1].length - a[1].length);
  if (sorted.length === 0) return "";
  const truncated = sorted.slice(0, MAX_TAG_DIRECTORY_ENTRIES);
  const lines = truncated.map(([tag, items]) => {
    const refs = items
      .slice(0, 8)
      .map((n) => `"${n.title}" (id=${n.id})`)
      .join(", ");
    const overflow = items.length > 8 ? ` +${items.length - 8} more` : "";
    return `#${tag} (${items.length}): ${refs}${overflow}`;
  });
  const overflowSuffix = sorted.length > MAX_TAG_DIRECTORY_ENTRIES
    ? `\n…and ${sorted.length - MAX_TAG_DIRECTORY_ENTRIES} more tags omitted to save context.`
    : "";
  return `TAG DIRECTORY — every tag with its items:\n${lines.join("\n")}${overflowSuffix}`;
}

export function buildVaultDetailForGridAi(
  notes: VaultAiNoteRow[],
  opts?: { maxLines?: number },
): { block: string; totalCardCount: number; existingTagsStr: string } {
  const maxLines = opts?.maxLines ?? VAULT_AI_MAX_CARD_LINES;
  const cards = buildVaultCardsForAiChat(notes);
  const totalCardCount = cards.length;
  const existingTagsStr = collectAllTagsFromNotes(notes);
  const tagDir = buildTagDirectory(notes);
  const lines = cards.slice(0, maxLines).map(formatVaultCardLineForAi);
  const block = lines.length
    ? [
        `DETAILED VAULT — same listing as Vault chat (${totalCardCount} cards from recent notes; showing up to ${maxLines}). Existing tags in use: ${existingTagsStr}.`,
        // Reference items in chat by title or `(id=<noteId>)`. Do NOT emit any
        // [PULL_MEDIA:...] / [CREATE_BLOCK:...] / pull tokens — the grid surface
        // does not exist in the current product, so there's nothing to pull
        // items onto. For tagging, use the [TAG_NOTES:noteId|tag1,tag2] marker
        // at the END of your reply.
        `When the user asks about saved items, reference them in plain chat by title or "(id=<noteId>)". You CANNOT pull, drop, embed, or place items onto a canvas / grid / board — those surfaces do not exist. To add tags, emit [TAG_NOTES:<noteId>|tag1,tag2] at the END of your reply.`,
        tagDir,
        lines.join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
  return { block, totalCardCount, existingTagsStr };
}
