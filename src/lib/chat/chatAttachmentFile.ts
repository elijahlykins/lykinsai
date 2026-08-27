/**
 * Re-opening a file the user attached to a chat turn.
 *
 * A sent attachment can point at its bytes in four different ways depending on
 * how it got into the composer and whether the chat has been reloaded since:
 *
 *   - `url` — a data URL (picker / paste), a signed Supabase URL (re-minted by
 *     `reSignChatAttachments` on load), or a `lykn-blob://` device URL
 *   - `storagePath` + `storageBucket` — the durable copy; the only survivor of
 *     a reload, since signed URLs are stripped on persist
 *   - `rawFile` — audio/video picked from disk, which never get a data URL
 *   - nothing at all — vault text drops, folders, links
 *
 * Every caller that wants to preview, download or save one of these needs the
 * same resolution order, so it lives here once.
 */

import { supabase } from "@/lib/supabase";
import { triggerBlobDownload } from "@/lib/lyknChat/downloadArtifact";
import { localBlobUrl } from "@/lib/vault/repository/mediaUrl";
import { LOCAL_BUCKET } from "@/lib/vault/repository/types";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";

/** File-I/O subset of the canonical composer/persisted attachment.
 *  Fields are optional because download/open helpers accept any stage of
 *  the same object (composer chip, sent bubble, vault drop). */
export type ChatAttachmentLike = Partial<FocusedChatAttachment>;

export type ChatAttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "youtube"
  | "link"
  | "note"
  | "folder"
  | "document"
  | "file";

const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "avif", "tiff",
]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "wma"]);
const DOCUMENT_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
  "txt", "md", "markdown", "json", "html", "htm", "csv", "rtf",
]);

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
};

function extensionOf(att: ChatAttachmentLike): string {
  const candidates = [att?.name, att?.storagePath, String(att?.url || "").split("?")[0]];
  for (const raw of candidates) {
    const leaf = String(raw || "").split("/").pop() || "";
    const match = leaf.match(/\.([a-z0-9]{1,8})$/i);
    if (match) return match[1].toLowerCase();
  }
  return "";
}

function mimeOf(att: ChatAttachmentLike): string {
  const declared = String(att?.mime || "").toLowerCase().split(";")[0].trim();
  if (declared) return declared;
  const url = String(att?.url || "");
  const dataMime = /^data:([^;,]+)/.exec(url)?.[1];
  if (dataMime) return dataMime.toLowerCase();
  const ext = extensionOf(att);
  const guess = Object.entries(MIME_EXT).find(([, e]) => e === ext);
  return guess ? guess[0] : "";
}

/** What the attachment IS, resolved from its type then its mime then its name. */
export function chatAttachmentKind(att: ChatAttachmentLike): ChatAttachmentKind {
  const declared = String(att?.type || "").toLowerCase();
  if (declared === "youtube" || att?.videoId) return "youtube";
  if (declared === "link" || declared === "bookmark") return "link";
  if (declared === "note" || declared === "vault") return "note";
  if (declared === "folder") return "folder";
  if (
    declared === "image" ||
    declared === "video" ||
    declared === "audio" ||
    declared === "pdf"
  ) {
    return declared;
  }

  const mime = mimeOf(att);
  const ext = extensionOf(att);
  if (mime.startsWith("image/") || IMAGE_EXTS.has(ext)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXTS.has(ext)) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (declared === "document" || DOCUMENT_EXTS.has(ext)) return "document";
  return "file";
}

/** The vault's file-type vocabulary for this attachment. */
export function chatAttachmentFileType(
  att: ChatAttachmentLike,
): "image" | "video" | "audio" | "pdf" | "file" {
  const kind = chatAttachmentKind(att);
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
    return kind;
  }
  return "file";
}

/** Text already extracted from the attachment (PDF layer, OCR, transcript…). */
export function chatAttachmentText(att: ChatAttachmentLike): string {
  return String(
    att?.pdfText || att?.extractedText || att?.transcript || att?.vaultContent || att?.ocrText || "",
  ).trim();
}

export function chatAttachmentLabel(att: ChatAttachmentLike): string {
  const named = String(att?.name || att?.vaultTitle || "").trim();
  if (named) return named;
  const kind = chatAttachmentKind(att);
  if (kind === "note") return "Note";
  if (kind === "folder") return "Folder";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** A filename safe to hand a download, with an extension when we can infer one. */
export function chatAttachmentFilename(att: ChatAttachmentLike): string {
  const base =
    String(chatAttachmentLabel(att))
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/^https?_+/i, "")
      .trim()
      .slice(0, 120) || `lykn-${chatAttachmentKind(att)}`;
  if (/\.[a-z0-9]{1,8}$/i.test(base)) return base;
  const ext = MIME_EXT[mimeOf(att)] || extensionOf(att);
  return ext ? `${base}.${ext}` : base;
}

/**
 * Stable identity for "has this been saved to the vault". A signed URL changes
 * on every reload and a data URL is megabytes long, so the storage path wins
 * whenever the attachment has one.
 */
export function chatAttachmentSaveKeys(att: ChatAttachmentLike): string[] {
  const keys: string[] = [];
  const path = String(att?.storagePath || "").trim();
  if (path) keys.push(path);
  const url = String(att?.url || "").trim();
  if (url && !url.startsWith("data:")) keys.push(url);
  return keys;
}

// One object URL per File, so repeatedly opening the same attachment in a
// session doesn't leak a new blob URL each time.
const fileUrlCache = new WeakMap<File, string>();

function rawFileUrl(file: File): string {
  const cached = fileUrlCache.get(file);
  if (cached) return cached;
  const url = URL.createObjectURL(file);
  fileUrlCache.set(file, url);
  return url;
}

/** A URL an `<img>` / `<video>` / `<iframe>` can load, or "" when there is none. */
export async function resolveChatAttachmentUrl(att: ChatAttachmentLike): Promise<string> {
  const direct = String(att?.url || "").trim();
  if (direct) return direct;

  const path = String(att?.storagePath || "").trim();
  if (path) {
    const bucket = String(att?.storageBucket || "user-files").trim() || "user-files";
    if (bucket === LOCAL_BUCKET) return localBlobUrl(path) || "";
    try {
      const { data } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, 60 * 60 * 24);
      if (data?.signedUrl) return data.signedUrl;
    } catch {
      /* fall through to the raw file */
    }
  }

  const raw = att?.rawFile;
  if (raw instanceof File) return rawFileUrl(raw);
  return "";
}

/** True when this attachment has bytes we can preview or download. */
export function chatAttachmentHasBytes(att: ChatAttachmentLike): boolean {
  if (att?.rawFile instanceof File) return true;
  if (String(att?.storagePath || "").trim()) return true;
  const url = String(att?.url || "").trim();
  if (!url) return false;
  const kind = chatAttachmentKind(att);
  return kind !== "link" && kind !== "youtube";
}

/** The attachment's bytes, downloaded from wherever they currently live. */
export async function fetchChatAttachmentBlob(
  att: ChatAttachmentLike,
): Promise<Blob | null> {
  const raw = att?.rawFile;
  if (raw instanceof File) return raw;
  const url = await resolveChatAttachmentUrl(att);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size ? blob : null;
  } catch {
    return null;
  }
}

/** Write the attachment to the user's computer. Throws when there's nothing to write. */
export async function downloadChatAttachment(att: ChatAttachmentLike): Promise<void> {
  const filename = chatAttachmentFilename(att);
  const blob = await fetchChatAttachmentBlob(att);
  if (blob) {
    triggerBlobDownload(blob, filename, blob.type || mimeOf(att));
    return;
  }
  const text = chatAttachmentText(att);
  if (text) {
    triggerBlobDownload(text, `${filename.replace(/\.[a-z0-9]{1,8}$/i, "")}.txt`, "text/plain;charset=utf-8");
    return;
  }
  throw new Error("This attachment has no file to download.");
}
