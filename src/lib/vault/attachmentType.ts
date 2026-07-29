/**
 * Canonical attachment classification for the Vault.
 *
 * Phase 1 of the Vault Normalization Program. Two responsibilities:
 *
 *  1. `classifyAttachment` — derives the NORMALIZED contract fields
 *     (`att_type`, `platform`, `url`, `host_name`) that get written to real
 *     columns (migration 104). This is the "decide the type once at save time"
 *     source of truth.
 *
 *  2. `resolveRenderType` — returns the LEGACY granular render string that the
 *     existing renderers (VaultAttachment.tsx, Vault.jsx, vaultContentsForAi.ts)
 *     already switch on (bookmark, youtube, image, video, audio, pdf, html,
 *     spreadsheet, file, …). Centralizing it here removes the duplicated
 *     `resolveAttachmentType()` copies WITHOUT changing rendering behavior.
 *
 * Keep in sync with the backend port at lib/vault/attachmentType.js.
 */
import {
  detectSocialPlatform,
  isSocialEmbedType,
} from "@/lib/media/socialEmbed";
import { extractYouTubeVideoId } from "@/lib/media/youtube";

export type CanonicalAttType =
  | "note"
  | "link"
  | "social"
  | "youtube"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "file";

export type CanonicalPlatform =
  | "x"
  | "instagram"
  | "tiktok"
  | "facebook"
  | "linkedin"
  | "reddit"
  | "bluesky";

export interface AttachmentLike {
  type?: unknown;
  url?: unknown;
  name?: unknown;
  mimeType?: unknown;
  oembedType?: unknown;
  siteName?: unknown;
  articleText?: unknown;
  [key: string]: unknown;
}

export interface ClassifiedAttachment {
  attType: CanonicalAttType;
  platform: CanonicalPlatform | null;
  url: string | null;
  hostName: string | null;
}

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff", "avif"];
const VIDEO_EXT = ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "mpeg", "mpg", "3gp", "qt"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "wma"];

/**
 * Normalize a URL into a fully-qualified http(s) address, or null. Bare hosts
 * ("youtube.com") get an `https://` prefix; junk ("asdf") returns null.
 */
export function normalizeUrl(input: unknown): string | null {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
  // data:/blob: URIs are not web addresses — never coerce them.
  if (/^(data|blob):/i.test(trimmed)) return null;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.toString();
    } catch {
      return null;
    }
  }
  const looksLikeHost =
    trimmed.includes(".") ||
    /^localhost(:\d+)?(\/|$|\?|#)/i.test(trimmed) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(trimmed);
  if (!looksLikeHost) return null;
  try {
    return new URL(`https://${trimmed}`).toString();
  } catch {
    return null;
  }
}

/** Hostname (without leading www.) derived from a URL, or null. */
export function deriveHostName(url: unknown): string | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Full social-platform detector (the 7 networks we model). Superset of
 * `detectSocialPlatform` (which only covers instagram/tiktok/facebook).
 */
export function detectPlatform(rawUrl: unknown): CanonicalPlatform | null {
  const url = String(rawUrl || "").trim();
  if (!url) return null;
  if (/^https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/i.test(url)) return "x";
  if (/^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv|stories)\//i.test(url)) return "instagram";
  if (/^https?:\/\/((www\.|m\.)?tiktok\.com\/@[^/]+\/(video|photo)\/|vm\.tiktok\.com\/|(www\.)?tiktok\.com\/t\/)/i.test(url)) return "tiktok";
  if (/^https?:\/\/((www\.|m\.|web\.)?facebook\.com\/.+\/(posts|videos|reel|watch)|fb\.watch\/)/i.test(url)) return "facebook";
  if (/^https?:\/\/(www\.)?linkedin\.com\/(posts|pulse|feed|in)\//i.test(url)) return "linkedin";
  if (/^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(url)) return "reddit";
  if (/^https?:\/\/(bsky\.app|staging\.bsky\.app)\/profile\//i.test(url)) return "bluesky";
  return null;
}

/** Maps a legacy/loose platform-ish string to a canonical platform. */
function normalizePlatformString(value: unknown): CanonicalPlatform | null {
  const s = String(value || "").trim().toLowerCase();
  if (s === "twitter" || s === "x") return "x";
  if (s === "instagram") return "instagram";
  if (s === "tiktok") return "tiktok";
  if (s === "facebook") return "facebook";
  if (s === "linkedin") return "linkedin";
  if (s === "reddit") return "reddit";
  if (s === "bluesky") return "bluesky";
  return null;
}

function extOf(att: AttachmentLike): string {
  // Check every place a filename can hide — signed URLs, storagePath, and
  // variant paths like `…/medium.jpg` that used to leave type stuck on "file".
  const candidates = [
    att.name,
    att.storagePath,
    att.storage_path,
    att.variantMediumPath,
    att.variant_medium_path,
    att.variantThumbPath,
    att.variant_thumb_path,
    att.url,
  ];
  for (const raw of candidates) {
    const s = String(raw || "").trim().split("?")[0];
    if (!s) continue;
    const leaf = s.split("/").pop() || s;
    const m = leaf.match(/\.([^.]+)$/);
    if (m) return m[1].toLowerCase();
  }
  return "";
}

/** True when attachment paths/names look like an image file. */
export function looksLikeImageAttachment(attachment: AttachmentLike = {}): boolean {
  const mime = String(attachment.mimeType || "").toLowerCase().split(";")[0].trim();
  if (mime.startsWith("image/")) return true;
  if (String(attachment.type || "").toLowerCase() === "image") return true;
  const url = String(attachment.url || "");
  if (url.startsWith("data:image/")) return true;
  return IMAGE_EXT.includes(extOf(attachment));
}

/**
 * LEGACY granular render type. Matches the historical `resolveAttachmentType`
 * the renderers switch on (bookmark, youtube, instagram, tiktok, facebook,
 * image, video, audio, pdf, spreadsheet, file). Do not change without auditing
 * VaultAttachment.tsx / Vault.jsx rendering.
 */
export function resolveRenderType(attachment: AttachmentLike = {}): string {
  const url = String(attachment.url || "");
  const explicit = String(attachment.type || "").toLowerCase();
  const mime = String(attachment.mimeType || "").toLowerCase().split(";")[0].trim();

  // Media types first — never let a leftover siteName/articleText coerce an
  // image into a bookmark tile (which used to paint the supabase URL).
  if (explicit === "image" || mime.startsWith("image/") || url.startsWith("data:image/")) return "image";
  if (explicit === "video" || mime.startsWith("video/") || url.startsWith("data:video/")) return "video";
  if (explicit === "audio" || mime.startsWith("audio/") || url.startsWith("data:audio/")) return "audio";
  if (explicit === "pdf" || mime === "application/pdf") return "pdf";
  if (explicit === "html") return "html";

  if (isSocialEmbedType(attachment.oembedType as string | undefined)) return String(attachment.oembedType);
  const socialPlatform = detectSocialPlatform(url);
  if (socialPlatform) return socialPlatform;

  if ((url.includes("youtube.com") || url.includes("youtu.be")) && extractYouTubeVideoId(url)) return "youtube";

  if (explicit === "bookmark" || explicit === "link" || attachment.siteName || attachment.articleText) {
    return "bookmark";
  }
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";

  if (explicit && explicit !== "file") return explicit;

  const ext = extOf(attachment);
  // Mime / path extension win over a missing explicit type — storage signed
  // URLs and variant paths (`medium.jpg`) used to fall through to a generic
  // "file" tile that painted the raw supabase URL as a download link.
  if (mime.startsWith("image/") || IMAGE_EXT.includes(ext)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXT.includes(ext)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXT.includes(ext)) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (["xls", "xlsx", "csv"].includes(ext) || attachment.type === "spreadsheet") return "spreadsheet";
  // Built artifacts / saved HTML pages — iframe preview (also recovers legacy
  // rows that were saved as type "file" with a .html name).
  if (["html", "htm"].includes(ext) || mime === "text/html" || attachment.type === "html") {
    return "html";
  }
  if (["doc", "docx", "ppt", "pptx", "txt", "md"].includes(ext)) return "file";

  // Storage-backed uploads with no extension still shouldn't become a
  // bookmark/link (which surfaces the signed URL). Keep a neutral file tile.
  if (/supabase\.co\/storage\//i.test(url) || attachment.storagePath || attachment.storage_path) {
    return "file";
  }

  return "file";
}

/**
 * Canonical classification written to the `att_type`/`platform`/`url`/
 * `host_name` columns. `note` is reserved for plain notes (no attachment) and
 * is the caller's default when there is no attachment.
 */
export function classifyAttachment(attachment: AttachmentLike = {}): ClassifiedAttachment {
  const rawUrl = String(attachment.url || "");
  const normalizedUrl = normalizeUrl(rawUrl);

  // Social first: a full platform detector wins over the bookmark/link guess.
  const platform =
    detectPlatform(rawUrl) ||
    normalizePlatformString(attachment.platform) ||
    normalizePlatformString(attachment.oembedType) ||
    normalizePlatformString(attachment.type);

  if (platform) {
    return {
      attType: "social",
      platform,
      url: normalizedUrl,
      hostName: deriveHostName(rawUrl),
    };
  }

  const render = resolveRenderType(attachment);

  let attType: CanonicalAttType;
  switch (render) {
    case "youtube":
      attType = "youtube";
      break;
    case "bookmark":
    case "link":
      attType = "link";
      break;
    case "image":
    case "video":
    case "audio":
    case "pdf":
      attType = render;
      break;
    default:
      // spreadsheet / presentation / text / doc / file → generic file
      attType = "file";
      break;
  }

  const isWeb = attType === "link" || attType === "youtube";
  return {
    attType,
    platform: null,
    url: isWeb ? normalizedUrl : null,
    hostName: isWeb ? deriveHostName(rawUrl) : null,
  };
}

const PREVIEW_KEYS = [
  "title", "description", "image", "thumbnail_url", "favicon", "siteName",
  "authorName", "authorHandle", "videoId", "extractedText", "aiDescription",
  "oembedType", "oembedHtml", "articleText", "ocr", "alt", "caption",
  "rows", "cols", "cells",
] as const;

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPreview(att: AttachmentLike): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const k of PREVIEW_KEYS) {
    const v = att[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Maps the primary attachment to the snake_case `notes`/`vault_items` columns
 * (migration 104). Spread directly into an insert/update. A null/absent
 * attachment yields a plain note (`att_type = 'note'`). This is the single
 * source of truth for the dual-write transition.
 */
export function buildAttachmentColumns(
  primary: AttachmentLike | null | undefined,
): Record<string, unknown> {
  if (!primary || typeof primary !== "object") {
    return {
      att_type: "note",
      platform: null,
      url: null,
      storage_path: null,
      storage_bucket: null,
      mime_type: null,
      byte_size: null,
      duration_seconds: null,
      page_count: null,
      host_name: null,
      media_width: null,
      media_height: null,
      attachment_preview: null,
    };
  }
  const { attType, platform, url, hostName } = classifyAttachment(primary);
  return {
    att_type: attType,
    platform: platform || null,
    url,
    storage_path: (primary.storagePath as string) || null,
    storage_bucket: (primary.storageBucket as string) || null,
    mime_type: (primary.mimeType as string) || null,
    byte_size: numOrNull(primary.size),
    duration_seconds: numOrNull(primary.durationSeconds ?? primary.duration),
    page_count: numOrNull(primary.pageCount),
    host_name: hostName,
    media_width: numOrNull(primary.width),
    media_height: numOrNull(primary.height),
    attachment_preview: buildPreview(primary),
  };
}

/** Maps a canonical att_type/platform back to the legacy render type. */
function canonicalToRenderType(attType: string, platform: string | null): string {
  if (attType === "social") return platform || "bookmark";
  if (attType === "link") return "bookmark";
  return attType; // youtube | image | video | audio | pdf | file
}

export interface NoteColumns {
  att_type?: unknown;
  platform?: unknown;
  url?: unknown;
  storage_path?: unknown;
  storage_bucket?: unknown;
  mime_type?: unknown;
  byte_size?: unknown;
  duration_seconds?: unknown;
  page_count?: unknown;
  media_width?: unknown;
  media_height?: unknown;
  attachment_preview?: unknown;
  [key: string]: unknown;
}

/**
 * Reconstructs a render-compatible attachment object from the normalized
 * columns (inverse of `buildAttachmentColumns`). Used as the marker fallback
 * for rows whose `content` no longer carries the `[ATTACHMENTS_JSON:…]` marker.
 * Returns null for plain notes (`att_type` null or 'note').
 */
export function primaryAttachmentFromColumns(
  note: NoteColumns | null | undefined,
): Record<string, unknown> | null {
  if (!note) return null;
  const attType = typeof note.att_type === "string" ? note.att_type : null;
  if (!attType || attType === "note") return null;

  const platform = typeof note.platform === "string" ? note.platform : null;
  const preview =
    note.attachment_preview && typeof note.attachment_preview === "object"
      ? (note.attachment_preview as Record<string, unknown>)
      : {};

  const out: Record<string, unknown> = {
    type: canonicalToRenderType(attType, platform),
    ...preview,
  };
  if (platform) out.platform = platform;
  if (note.url) out.url = note.url;
  if (note.storage_path) out.storagePath = note.storage_path;
  if (note.storage_bucket) out.storageBucket = note.storage_bucket;
  if (note.mime_type) out.mimeType = note.mime_type;
  if (note.byte_size != null) out.size = note.byte_size;
  if (note.duration_seconds != null) out.durationSeconds = note.duration_seconds;
  if (note.page_count != null) out.pageCount = note.page_count;
  if (note.media_width != null) out.width = note.media_width;
  if (note.media_height != null) out.height = note.media_height;
  if (note.variant_medium_path) out.variantMediumPath = note.variant_medium_path;
  if (note.variant_thumb_path) out.variantThumbPath = note.variant_thumb_path;
  return out;
}
