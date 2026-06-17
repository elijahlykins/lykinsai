/**
 * Backend (Node/ESM) port of src/lib/vault/attachmentType.ts.
 *
 * Used by server-side write paths (connectors, MCP tools, RSS) to populate the
 * normalized attachment columns (migration 104) alongside the legacy marker.
 * Self-contained so it doesn't depend on any frontend module.
 *
 * Keep in sync with src/lib/vault/attachmentType.ts.
 */

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff", "avif"];
const VIDEO_EXT = ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "mpeg", "mpg", "3gp", "qt"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "wma"];

export function normalizeUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;
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

export function deriveHostName(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function detectPlatform(rawUrl) {
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

function normalizePlatformString(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "twitter" || s === "x") return "x";
  if (["instagram", "tiktok", "facebook", "linkedin", "reddit", "bluesky"].includes(s)) return s;
  return null;
}

function isYouTubeUrl(url) {
  return /(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/)/i.test(String(url || ""));
}

function extOf(att) {
  const url = String(att.url || "");
  const name = String(att.name || "");
  const urlNoQuery = url.split("?")[0];
  const m = (urlNoQuery.split("/").pop() || name).match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Canonical classification for the normalized columns. Mirrors the frontend
 * resolveRenderType -> canonical mapping.
 */
export function classifyAttachment(attachment = {}) {
  const rawUrl = String(attachment.url || "");
  const normalizedUrl = normalizeUrl(rawUrl);

  const platform =
    detectPlatform(rawUrl) ||
    normalizePlatformString(attachment.platform) ||
    normalizePlatformString(attachment.oembedType) ||
    normalizePlatformString(attachment.type);

  if (platform) {
    return { attType: "social", platform, url: normalizedUrl, hostName: deriveHostName(rawUrl) };
  }

  if (isYouTubeUrl(rawUrl) || attachment.type === "youtube") {
    return { attType: "youtube", platform: null, url: normalizedUrl, hostName: deriveHostName(rawUrl) };
  }

  const explicit = String(attachment.type || "");
  const isLink =
    explicit === "bookmark" ||
    explicit === "link" ||
    Boolean(attachment.siteName) ||
    Boolean(attachment.articleText);
  if (isLink) {
    return { attType: "link", platform: null, url: normalizedUrl, hostName: deriveHostName(rawUrl) };
  }

  if (["image", "video", "audio", "pdf"].includes(explicit)) {
    return { attType: explicit, platform: null, url: null, hostName: null };
  }

  const ext = extOf(attachment);
  let attType = "file";
  if (IMAGE_EXT.includes(ext)) attType = "image";
  else if (VIDEO_EXT.includes(ext)) attType = "video";
  else if (AUDIO_EXT.includes(ext)) attType = "audio";
  else if (ext === "pdf") attType = "pdf";

  return { attType, platform: null, url: null, hostName: null };
}

const PREVIEW_KEYS = [
  "title", "description", "image", "thumbnail_url", "favicon", "siteName",
  "authorName", "authorHandle", "videoId", "extractedText", "aiDescription",
  "oembedType", "oembedHtml", "articleText", "ocr", "alt", "caption",
  "rows", "cols", "cells",
];

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPreview(att) {
  const out = {};
  for (const k of PREVIEW_KEYS) {
    const v = att[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Maps the primary attachment to the snake_case `notes` columns (migration
 * 104). Spread directly into an insert/update. A null/absent attachment yields
 * a plain note (`att_type = 'note'`).
 */
export function buildAttachmentColumns(primary) {
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
    storage_path: primary.storagePath || null,
    storage_bucket: primary.storageBucket || null,
    mime_type: primary.mimeType || null,
    byte_size: numOrNull(primary.size),
    duration_seconds: numOrNull(primary.durationSeconds ?? primary.duration),
    page_count: numOrNull(primary.pageCount),
    host_name: hostName,
    media_width: numOrNull(primary.width),
    media_height: numOrNull(primary.height),
    attachment_preview: buildPreview(primary),
  };
}

function canonicalToRenderType(attType, platform) {
  if (attType === "social") return platform || "bookmark";
  if (attType === "link") return "bookmark";
  return attType;
}

/**
 * Reconstructs a render-compatible attachment object from the normalized
 * columns (inverse of buildAttachmentColumns). Marker fallback for rows whose
 * content no longer carries the marker. Null for plain notes.
 */
export function primaryAttachmentFromColumns(note) {
  if (!note) return null;
  const attType = typeof note.att_type === "string" ? note.att_type : null;
  if (!attType || attType === "note") return null;

  const platform = typeof note.platform === "string" ? note.platform : null;
  const preview =
    note.attachment_preview && typeof note.attachment_preview === "object"
      ? note.attachment_preview
      : {};

  const out = { type: canonicalToRenderType(attType, platform), ...preview };
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
