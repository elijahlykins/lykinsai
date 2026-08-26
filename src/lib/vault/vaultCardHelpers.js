// Pure helpers for vault cards: parsing note/attachment metadata into
// display-ready values and computing deterministic card layout classes.
// Extracted verbatim from src/pages/Vault.jsx (Batch 1, see
// docs/REFACTOR_LOG.md). Every function here is a deterministic function of
// its arguments — no React state, refs, network, Supabase, or lifecycle.
//
// Note: src/lib/vault/vaultContentsForAi.ts still carries older private
// copies of several of these helpers (buildTextExcerpt, extractChatPreview,
// formatDate, …). Consolidating those is a separate, future batch — diff the
// implementations before unifying.
import {
  stripAttachmentsMarker,
  withAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";
import { isVerticalSocialContent } from "@/lib/media/socialEmbed";

/** Which of the two folders an item belongs in, or "" when it isn't AI output. */
export function driveFolderIdFor(card) {
  if (!card?.aiGenerated) return "";
  return card.kind === "attachment" && String(card.type || "") === "image" ? "images" : "artifacts";
}

// Marker parsing is delegated to `attachmentsMarker.ts` so all consumers
// share the same JSON-string-aware scanner. The previous inline bracket
// counter mishandled `[`/`]` characters that appear inside JSON string
// fields (e.g. a filename like `report[2025].pdf`), which corrupted slices.
export function stripAttachmentJsonMarker(content) {
  return stripAttachmentsMarker(String(content || ""));
}

export function isVoiceNoteCard(card = {}) {
  if (String(card.source || "").toLowerCase() === "voice_note") return true;
  if ((card.tags || []).some((t) => String(t).toLowerCase() === "voice")) return true;
  const label = String(card.attachment?.name || card.title || "").trim().toLowerCase();
  return label === "voice recording" || label.startsWith("voice note");
}

export function parseStorageTarget(attachment = {}, prefer = null) {
  const explicitBucket = String(attachment.storageBucket || "user-files").trim() || "user-files";
  const thumb = String(attachment.variantThumbPath || "").trim();
  const medium = String(attachment.variantMediumPath || "").trim();

  // Prefer a smaller rendition when asked and available (Phase 3 variants):
  // thumb → medium → original; medium → original.
  if (prefer) {
    const variantPath = prefer === "thumb" ? thumb || medium : medium;
    if (variantPath) return { bucket: explicitBucket, path: variantPath };
  }

  const explicitPath = String(attachment.storagePath || "").trim();
  if (explicitPath) {
    return { bucket: explicitBucket, path: explicitPath };
  }
  // Recover cards that only kept a variant path (e.g. medium.jpg) after the
  // original storagePath was lost — still enough to re-sign and show Try again.
  if (medium || thumb) {
    return { bucket: explicitBucket, path: medium || thumb };
  }

  const url = String(attachment.url || "").trim();
  if (!url || url.startsWith("data:")) return null;

  try {
    const parsed = new URL(url);
    const path = parsed.pathname || "";
    const publicMatch = path.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (publicMatch) {
      return {
        bucket: decodeURIComponent(publicMatch[1] || "user-files"),
        path: decodeURIComponent(publicMatch[2] || ""),
      };
    }
    const signedMatch = path.match(/\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (signedMatch) {
      return {
        bucket: decodeURIComponent(signedMatch[1] || "user-files"),
        path: decodeURIComponent(signedMatch[2] || ""),
      };
    }
  } catch {
    // Non-URL strings are handled by the raw attachment URL fallback.
  }
  return null;
}

export function buildTextExcerpt(htmlOrText = "") {
  // Strip the attachments marker first via the JSON-aware parser so a stray
  // `]` inside attachment metadata doesn't leave residue in the excerpt.
  let text = stripAttachmentsMarker(String(htmlOrText));
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, "");
  text = text.replace(/File uploaded:\s*/i, "");
  text = text.replace(/Type:\s*\w+/i, "");
  text = text.replace(/Size:\s*[\d.]+ [A-Z]+/i, "");
  return text.replace(/\s+/g, " ").trim();
}

/** Preserve paragraph breaks for card previews of formatted notes (meetings, tasks). */
export function buildSpacedExcerpt(htmlOrText = "", maxLen = 420) {
  let text = stripAttachmentsMarker(String(htmlOrText || ""));
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "• ");
  text = text.replace(/^\s*\[[ xX]\]\s+/gm, "• ");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > maxLen) text = `${text.slice(0, maxLen).trim()}…`;
  return text;
}

/**
 * Classify text-only vault rows so meeting notes + browser tasks don't land
 * in the generic "Quick Note" bucket (wrong label + collapsed whitespace).
 */
export function resolveTextNoteStyle(noteSource = "", tags = [], title = "", content = "") {
  const src = String(noteSource || "").toLowerCase();
  const tagSet = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase()));
  const titleLower = String(title || "").trim().toLowerCase();
  if (
    src === "meeting_notes" ||
    src.includes("meeting") ||
    tagSet.has("meeting-notes") ||
    titleLower.startsWith("meeting:") ||
    titleLower.startsWith("meeting notes")
  ) {
    return "meeting";
  }
  if (
    src === "browser_task" ||
    src.endsWith(":task") ||
    tagSet.has("browser-task") ||
    titleLower.startsWith("browser task:")
  ) {
    return "task";
  }
  // Markdown docs with headings (saved summaries, etc.) — still not a sticky note.
  if (/^#{1,3}\s+\S+/m.test(String(content || "")) && String(content || "").length > 160) {
    return "doc";
  }
  return "quick";
}

export function textNoteLabel(style) {
  if (style === "meeting") return "Meeting notes";
  if (style === "task") return "Task";
  if (style === "doc") return "Note";
  return "Quick Note";
}

export function isSupabaseStorageUrlText(value = "") {
  return /supabase\.co\/storage\//i.test(String(value || ""));
}

export function sanitizeCardTitle(raw = "", fallback = "Untitled") {
  const s = String(raw).trim();
  // Never show raw storage URLs (signed or public) as a card title.
  if (isSupabaseStorageUrlText(s)) {
    try {
      const path = new URL(s).pathname.split("/").pop() || "";
      const decoded = decodeURIComponent(path.split("?")[0] || "");
      if (
        decoded &&
        !isSupabaseStorageUrlText(decoded) &&
        !/^https?:\/\//i.test(decoded) &&
        !/^(medium|thumb|original)(\.|$)/i.test(decoded)
      ) {
        return decoded;
      }
    } catch { /* fall through */ }
    return fallback === "Untitled" ? "Image" : fallback;
  }
  // Variant filenames are internal — never show them as the card label.
  if (/^(medium|thumb|original)(\.[a-z0-9]+)?$/i.test(s)) {
    return fallback === "Untitled" ? "Image" : fallback;
  }
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).hostname.replace(/^www\./, ""); } catch { return "Saved Item"; }
  }
  return s || fallback;
}

export function parseAttachmentNotes(attachment = {}) {
  const raw = Array.isArray(attachment?.notes) ? attachment.notes : [];
  return raw
    .map((item, idx) => {
      const text = String(item?.text || "").trim();
      if (!text) return null;
      return {
        id: String(item?.id || `note-${idx}`),
        text,
        created_at: item?.created_at || null,
      };
    })
    .filter(Boolean);
}

// Quick notes don't have an attachment to hang per-file notes off, so
// comments live in a sibling jsonb column on the row itself. Same shape
// as parseAttachmentNotes so the UI can render either with one helper.
export function parseQuickNoteComments(note = {}) {
  let raw = note?.comments;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, idx) => {
      const text = String(item?.text || "").trim();
      if (!text) return null;
      return {
        id: String(item?.id || `comment-${idx}`),
        text,
        created_at: item?.created_at || null,
      };
    })
    .filter(Boolean);
}

export function withAttachmentJsonMarker(content = "", attachments = []) {
  return withAttachmentsMarker(String(content || ""), attachments);
}

export function decodeHtmlEntities(input = "") {
  const map = {
    "&quot;": "\"",
    "&#039;": "'",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
  };
  return String(input).replace(/&quot;|&#039;|&amp;|&lt;|&gt;/g, (m) => map[m] || m);
}

export function extractChatPreview(content = "") {
  const raw = String(content || "").trim();
  if (!raw) return null;

  const tryParse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const decoded = decodeHtmlEntities(raw);
  const candidateStrings = [raw, decoded];

  const extractJsonCandidates = (value) => {
    const candidates = [];
    const firstBrace = value.indexOf("{");
    const lastBrace = value.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidates.push(value.slice(firstBrace, lastBrace + 1));
    }
    const blocksIdx = value.indexOf("\"blocks\"");
    if (blocksIdx !== -1) {
      const left = value.lastIndexOf("{", blocksIdx);
      if (left !== -1) {
        const right = value.lastIndexOf("}");
        if (right > left) candidates.push(value.slice(left, right + 1));
      }
    }
    return candidates;
  };

  let parsed = null;
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

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.blocks)) return null;

  const turns = [];
  const textOnlyPrompts = [];
  parsed.blocks.forEach((block) => {
    const userText = block?.content?.text ? buildTextExcerpt(block.content.text) : "";
    if (userText) textOnlyPrompts.push(userText);
    const answers = Array.isArray(block?.content?.aiAnswers) ? block.content.aiAnswers : [];
    answers.forEach((answer) => {
      const q = buildTextExcerpt(answer?.q || userText || "");
      const a = buildTextExcerpt(answer?.a || "");
      if (q || a) turns.push({ q, a, ts: answer?.ts || null });
    });
  });

  if (turns.length === 0) {
    // Still return a chat-style preview for brick documents so raw JSON
    // never falls back into a plain quick-note text dump.
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

export function formatDate(value) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function resolveAttachmentAspectRatio(attachment = {}) {
  const width =
    toNumber(attachment.width) ??
    toNumber(attachment.imageWidth) ??
    toNumber(attachment.videoWidth) ??
    toNumber(attachment.metadata?.width) ??
    toNumber(attachment.metadata?.imageWidth) ??
    toNumber(attachment.metadata?.videoWidth);
  const height =
    toNumber(attachment.height) ??
    toNumber(attachment.imageHeight) ??
    toNumber(attachment.videoHeight) ??
    toNumber(attachment.metadata?.height) ??
    toNumber(attachment.metadata?.imageHeight) ??
    toNumber(attachment.metadata?.videoHeight);

  if (!width || !height || height <= 0) return null;
  return width / height;
}

export function isYouTubeShortUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!host.includes("youtube.com") && host !== "youtu.be") return false;
    const path = parsed.pathname.toLowerCase();
    return path.includes("/shorts/");
  } catch {
    return value.toLowerCase().includes("youtube.com/shorts/");
  }
}

export function stableBucket(value, count) {
  const source = String(value || "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return count > 0 ? hash % count : 0;
}

export function getYouTubeOffsetClass(seed) {
  const offsets = ["", "mt-1", "mt-2", "mt-3", "mt-4"];
  return offsets[stableBucket(seed, offsets.length)];
}

export function vaultPdfEmbedUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const params = "toolbar=0&navpanes=0&scrollbar=1";
  return raw.includes("#") ? raw : `${raw}#${params}`;
}

/** Fixed-size tile class for grid / tags / type (not collage). */
export function isUniformVaultTileClass(tileHeightClass) {
  const raw = String(tileHeightClass || "").trim();
  if (!raw) return false;
  return /^h-\d+$/.test(raw) || raw.includes("aspect-square");
}

export function getAttachmentHeightClass(card) {
  const type = card?.type;
  const ratio = resolveAttachmentAspectRatio(card?.attachment);

  if (type === "youtube") {
    const url = String(card?.attachment?.url || "");
    // Shorts should be tall, longform should be middle.
    if (isYouTubeShortUrl(url)) return "h-96 md:h-[34rem] xl:h-[42rem]";
    const middleVariants = [
      "h-44 md:h-52 xl:h-[15rem]",
      "h-48 md:h-56 xl:h-[16rem]",
      "h-52 md:h-60 xl:h-[17rem]",
      "h-56 md:h-64 xl:h-[18rem]",
      "h-60 md:h-72 xl:h-[19rem]",
      "h-64 md:h-80 xl:h-[22rem]",
    ];
    const bucket = stableBucket(card?.id || url, middleVariants.length);
    return middleVariants[bucket];
  }

  // If we know dimensions, size to fit content shape.
  if (ratio) {
    if (ratio <= 0.8) return "h-96 md:h-[34rem] xl:h-[42rem]"; // Pinterest-style tall
    if (ratio <= 1.05) return "h-72 md:h-80 xl:h-96"; // 3/4
    if (ratio <= 1.6) return "h-56 md:h-64 xl:h-72"; // half
    return "h-44 md:h-52 xl:h-60"; // 1/4 (wide)
  }

  // Social media embeds — vertical content (Reels, TikTok) is taller
  if (type === "instagram" || type === "tiktok" || type === "facebook") {
    const socialUrl = String(card?.attachment?.url || "");
    if (isVerticalSocialContent(socialUrl)) return "h-[28rem] md:h-[36rem] xl:h-[44rem]";
    return "h-80 md:h-[26rem] xl:h-[32rem]";
  }

  // Fallback by content type when dimensions are not present.
  if (type === "image") return "h-auto";
  if (type === "video" || type === "youtube") return "h-auto";
  if (type === "pdf" || type === "html") return "h-56 md:h-64 xl:h-72";
  if (type === "bookmark") return "h-auto";
  if (type === "spreadsheet") return "h-auto";
  if (type === "doc" || type === "word" || type === "file") return "h-56 md:h-64 xl:h-72";
  if (type === "audio") return "h-40 md:h-44 xl:h-52";
  return "h-56 md:h-64 xl:h-72";
}

// Relative height estimate (taller = bigger number) used ONLY to assign a
// card to a masonry column. It must be DETERMINISTIC and independent of async
// load state — we base it on attachment metadata / type defaults, never on
// live-measured dimensions — so the column a card lands in never changes as
// images resolve or more pages append. Approximate balance is fine; stability
// is the goal. The unit is "height relative to one column's width" (1 / aspect)
// plus a tiny constant for spacing (tags / ⋯ live in the click-to-open
// preview now, not under the card face).
export function estimateCardHeightUnit(card) {
  if (!card) return 1;
  const FOOTER = 0.06;
  if (card.kind === "source-folder") return 0.62;
  if (card.kind === "chat-preview") return 1.0 + FOOTER;
  if (card.kind === "quick-note") {
    const len = String(card.excerpt || "").length;
    const text = Math.min(1.4, 0.45 + len / 600);
    return text + FOOTER;
  }
  if (card.kind === "attachment") {
    const t = card.type;
    if (t === "audio") return 0.32 + FOOTER;
    if (t === "youtube") {
      const isShort = isYouTubeShortUrl(String(card.attachment?.url || ""));
      return (isShort ? 1.78 : 0.5625) + FOOTER;
    }
    if (t === "image" || t === "video") {
      const ratio = resolveAttachmentAspectRatio(card.attachment) || (t === "video" ? 16 / 9 : 1);
      const unit = ratio > 0 ? 1 / ratio : 1;
      // Clamp so a freak ratio can't dominate a column's estimate.
      return Math.min(2.2, Math.max(0.4, unit)) + FOOTER;
    }
    if (t === "pdf" || t === "html" || t === "doc" || t === "word" || t === "file") return 0.85 + FOOTER;
    if (t === "instagram" || t === "tiktok" || t === "facebook") return 1.4 + FOOTER;
    return 0.9 + FOOTER; // bookmark / link / unknown
  }
  return 0.9 + FOOTER;
}

// `h-auto` tiles reserve zero height in masonry/collage columns, so the
// skeleton collapses and every subsequent image load shoves the column
// downward. Always map to a stable bucket before first paint.
export function resolveStableTileHeight(card, tileHeightClass) {
  if (tileHeightClass && tileHeightClass !== "h-auto") return tileHeightClass;
  const fromCard = getAttachmentHeightClass(card);
  if (fromCard && fromCard !== "h-auto") return fromCard;
  return "h-56 md:h-64 xl:h-72";
}

export function extractYouTubeLinks(content = "") {
  const text = String(content || "");
  if (!text) return [];
  const regex = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+(?:[^\s<)]*)?|youtu\.be\/[\w-]+(?:[^\s<)]*)?)/gi;
  const matches = text.match(regex) || [];
  return [...new Set(matches)];
}
