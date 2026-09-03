/**
 * One description of "a file LYKN can show", whatever the file actually is.
 *
 * Files reach the viewer from four unrelated places — a path on this Mac, a
 * blob this device generated, a row in the vault, an attachment on a chat turn
 * — and each used to carry its own extension sniffing and its own renderer.
 * They all build one of these now, and the window resolves it once.
 */

import {
  chatAttachmentKind,
  chatAttachmentLabel,
  chatAttachmentText,
  resolveChatAttachmentUrl,
  type ChatAttachmentLike,
} from "@/lib/chat/chatAttachmentFile";
import { macFileUrl } from "@/components/macfiles/preview";
import type { LucideIcon } from "lucide-react";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";

export type FileMedia =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  // A built page or written document, framed and readable. `.html` on disk
  // used to open as source; artifacts and letters must render as a page.
  | "html"
  | "youtube"
  | "unsupported";

export interface FilePickOption {
  id: string;
  label: string;
  /** Already true of this file. Drawn with a check, still pickable. */
  current?: boolean;
}

/**
 * A toolbar button that opens a short list and acts on the choice.
 *
 * What a project is, and what filing something under one means, belongs to the
 * surface that opened the window and not to a file viewer — so that surface
 * hands over the list and the handler, and the window only draws the menu.
 */
export interface FilePickAction {
  id: string;
  label: string;
  icon: LucideIcon;
  /**
   * Read when the menu opens, not when the window does — a window can sit open
   * for hours, and a project made in the meantime should be in this list.
   */
  options: FilePickOption[] | (() => FilePickOption[]);
  /** Drawn in place of an empty list, so the button never opens onto nothing. */
  empty?: string;
  onPick: (optionId: string) => void | Promise<void>;
}

export interface FileSource {
  name?: string | null;
  /** Absolute path, when the bytes are a real file on this Mac. */
  path?: string | null;
  url?: string | null;
  /**
   * For bytes whose address has to be minted — a signed cloud URL, a proxied
   * artifact. Called only when there's no `url` already, so the window can go
   * up straight away and fill in once the address comes back.
   */
  resolveUrl?: (() => Promise<string>) | null;
  /**
   * A fetchable address for the same bytes, for take-to-chat. The preview
   * address can be iframe-only (the drive's branded file proxy blocks
   * cross-origin fetch), so the opener hands over the raw storage URL here —
   * the same address an image attachment fetches.
   */
  resolveAttachUrl?: (() => Promise<string>) | null;
  mime?: string | null;
  size?: number | null;
  /** Skip the sniffing when the caller already knows. */
  media?: FileMedia | null;
  /** The vault row these bytes belong to, when they came from one. */
  itemId?: string | null;
  videoId?: string | null;
  /** Transcript or PDF text layer, shown when there are no displayable bytes. */
  text?: string | null;
  attachment?: ChatAttachmentLike | null;
  /**
   * Saving differs enough per origin — a Mac path uploads, a chat attachment
   * already knows its own storage row — that the surface which opened the
   * window supplies it. No handler, no button.
   */
  onSaveToVault?: (() => void | Promise<void>) | null;
  /** Extra menus the opening surface offers for a file it owns. */
  picks?: FilePickAction[] | null;
  /**
   * The chat build this window is showing. Take-to-chat then stages this
   * artifact on the composer so a later prompt can edit it in Build mode.
   */
  artifact?: ChatArtifact | null;
}

export interface ResolvedFile {
  name: string;
  url: string;
  media: FileMedia;
  mime: string;
  size: number | null;
  path: string | null;
  text: string;
  videoId: string | null;
}

const EXT_MEDIA: Array<[RegExp, FileMedia]> = [
  [/^(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/, "image"],
  [/^(mp4|mov|m4v|webm)$/, "video"],
  [/^(mp3|m4a|wav|aac|flac|ogg)$/, "audio"],
  [/^pdf$/, "pdf"],
  [
    /^(txt|md|markdown|log|json|csv|tsv|yaml|yml|toml|xml|css|scss|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|cs|swift|kt|php|sh|zsh|sql|env|gitignore)$/,
    "text",
  ],
];

// Chromium decodes neither, so claiming a preview would paint a broken image
// where "open it in Preview" is the honest answer.
const UNDECODABLE = /^(heic|heif|tiff?)$/;

export function fileNameFromPath(value: unknown): string {
  return (
    String(value || "")
      .split("?")[0]
      .split("/")
      .filter(Boolean)
      .pop() || ""
  );
}

function extensionOf(name: string, url: string): string {
  for (const candidate of [name, fileNameFromPath(url)]) {
    const match = /\.([a-z0-9]{1,8})$/i.exec(candidate);
    if (match) return match[1].toLowerCase();
  }
  return "";
}

/** What we can actually paint for this file, from its mime then its name. */
export function mediaKindFor(opts: {
  name?: string | null;
  url?: string | null;
  mime?: string | null;
}): FileMedia {
  const name = String(opts.name || "");
  const url = String(opts.url || "");
  const mime = String(opts.mime || "").toLowerCase().split(";")[0].trim();
  const ext = extensionOf(name, url);

  if (UNDECODABLE.test(ext) || mime === "image/heic" || mime === "image/heif") {
    return "unsupported";
  }
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html" || ext === "html" || ext === "htm") return "html";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";

  for (const [re, media] of EXT_MEDIA) {
    if (re.test(ext)) return media;
  }
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return "unsupported";
}

function mediaFromAttachment(att: ChatAttachmentLike): FileMedia | null {
  const kind = chatAttachmentKind(att);
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
    return kind;
  }
  if (kind === "youtube") return "youtube";
  if (kind === "note") return "text";
  return null;
}

/**
 * Identity for "is this file already open". Two asks for the same file focus
 * the window that is already up rather than stacking a duplicate on top of it.
 */
export function fileSourceKey(source: FileSource): string {
  if (source.path) return `path:${source.path}`;
  if (source.itemId) return `item:${source.itemId}`;
  if (source.attachment?.id) return `attachment:${source.attachment.id}`;
  if (source.videoId) return `youtube:${source.videoId}`;
  const url = String(source.url || "");
  // A data URL is the file, and can run to megabytes — its name is enough.
  if (url && !url.startsWith("data:")) return `url:${url}`;
  return `name:${source.name || fileNameFromPath(url) || "file"}`;
}

export function fileSourceName(source: FileSource): string {
  const named = String(source.name || "").trim();
  if (named) return named;
  if (source.attachment) return chatAttachmentLabel(source.attachment);
  return fileNameFromPath(source.path) || fileNameFromPath(source.url) || "File";
}

/**
 * Work out the URL and the media kind. Only chat attachments need a round trip
 * (a signed URL, or an object URL for a File that never had one), so everything
 * else settles on the first tick.
 */
export async function resolveFile(source: FileSource): Promise<ResolvedFile> {
  const att = source.attachment || null;
  const name = fileSourceName(source);
  const text = String(source.text || (att ? chatAttachmentText(att) : "") || "");
  const videoId = source.videoId || att?.videoId || null;

  let url = String(source.url || "").trim();
  if (!url && source.path) url = macFileUrl(source.path) || "";
  if (!url && att) url = await resolveChatAttachmentUrl(att);
  if (!url && source.resolveUrl) {
    try {
      url = String((await source.resolveUrl()) || "").trim();
    } catch {
      /* no address; the body falls through to "can't show this" */
    }
  }

  const mime = String(source.mime || att?.mime || "")
    .toLowerCase()
    .split(";")[0]
    .trim();

  const media =
    source.media ||
    (videoId ? "youtube" : null) ||
    (att ? mediaFromAttachment(att) : null) ||
    mediaKindFor({ name, url, mime });

  return {
    name,
    url,
    // Nothing to point an <img> at is "unsupported" however the name reads —
    // except a note, which is its own text and never had bytes.
    media: !url && media !== "youtube" && !(media === "text" && text) ? "unsupported" : media,
    mime,
    size: source.size ?? att?.size ?? null,
    path: source.path || null,
    text,
    videoId,
  };
}
