/**
 * Vault card → folder-listing entry, so AI Drive can be listed with the same
 * columns a real folder gets: a name, a kind, a size and a date.
 *
 * The Vault's own grid identifies things by how they look — a photo is its
 * thumbnail, a note is its text. That reads well as a collage and badly as a
 * listing, where the eye scans a column of names. Everything here exists to
 * give a card the two things a file has and a card doesn't: a filename and a
 * human "kind".
 */

import {
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Link2,
  MessageSquare,
  Music,
  Sparkles,
  StickyNote,
  Video,
  Youtube,
} from "lucide-react";
import { kindOf } from "./fileKinds";

const TYPE_KINDS = {
  image: { icon: ImageIcon, label: "Image" },
  video: { icon: Video, label: "Movie" },
  audio: { icon: Music, label: "Audio" },
  pdf: { icon: FileText, label: "PDF" },
  youtube: { icon: Youtube, label: "YouTube" },
  bookmark: { icon: Link2, label: "Link" },
  link: { icon: Link2, label: "Link" },
  spreadsheet: { icon: FileSpreadsheet, label: "Spreadsheet" },
};

/** Everything `resolveRenderType` can return for an embedded social post. */
const SOCIAL_KINDS = new Set([
  "instagram",
  "tiktok",
  "twitter",
  "x",
  "threads",
  "facebook",
  "linkedin",
  "reddit",
  "pinterest",
]);

function attachmentKind(card) {
  const type = String(card.type || "").toLowerCase();
  // A saved artifact is a page, but calling it a "Web Page" next to the ones
  // actually saved off the web loses the only distinction that matters here.
  if (type === "html") {
    return card.aiGenerated
      ? { icon: Sparkles, label: "Artifact" }
      : { icon: Globe, label: "Web Page" };
  }
  if (TYPE_KINDS[type]) return TYPE_KINDS[type];
  if (SOCIAL_KINDS.has(type)) return { icon: MessageSquare, label: "Post" };
  // A generic upload still has a filename, and that's what tells us what it
  // is — the same fallback a folder listing uses.
  const name = String(card.attachment?.name || card.title || "");
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return kindOf({ type: "file", ext });
}

/** The name this item is filed under. Never blank — a nameless row is unusable. */
export function driveEntryName(card) {
  if (!card) return "Untitled";
  if (card.kind === "source-folder") return card.sourceName || card.title || "Connected app";
  if (card.kind === "drive-folder") return card.folderName || card.title || "Folder";
  if (card.kind === "attachment") {
    return card.attachment?.name || card.title || card.parentTitle || "Untitled";
  }
  return card.title || card.label || "Untitled note";
}

/**
 * Flattens a card into what the listing draws. `thumb` is filled in by the
 * caller — only the Vault knows which signed URLs have resolved.
 */
export function driveEntryFor(card) {
  const isFolder = card.kind === "source-folder" || card.kind === "drive-folder";
  const kind = isFolder
    ? { icon: null, label: "Folder" }
    : card.kind === "quick-note"
      ? { icon: StickyNote, label: card.label || "Note" }
      : card.kind === "chat-preview"
        ? { icon: MessageSquare, label: "Chat" }
        : attachmentKind(card);

  return {
    id: card.id,
    card,
    isFolder,
    name: driveEntryName(card),
    kindLabel: kind.label,
    icon: kind.icon,
    // Connector folders wear their app's icon. AI Drive's own folders stay
    // plain, matching the unbadged white folders used for its fixed locations.
    favicon: card.kind === "source-folder" ? card.favicon || "" : "",
    badgeIcon: null,
    count: isFolder ? card.count || 0 : 0,
    size: card.kind === "attachment" ? card.attachment?.size ?? null : null,
    dateMs: card.createdAtMs || card.lastTouchedMs || 0,
  };
}

export const DRIVE_SORTS = [
  { id: "name", label: "Name" },
  { id: "kind", label: "Kind" },
  { id: "size", label: "Size" },
  { id: "added", label: "Date Added" },
];

/**
 * Folders stay above files however the rest is sorted, which is how the Vault
 * has always pinned connector tiles and how the Finder window next door is set
 * up. Ties fall back to the name so the order never wobbles between renders.
 */
export function sortDriveEntries(entries, sort, order) {
  const direction = order === "desc" ? -1 : 1;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const compare = (a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    let result = 0;
    if (sort === "kind") result = a.kindLabel.localeCompare(b.kindLabel) || byName(a, b);
    else if (sort === "size") result = (a.size || 0) - (b.size || 0) || byName(a, b);
    else if (sort === "added") result = (a.dateMs || 0) - (b.dateMs || 0) || byName(a, b);
    else result = byName(a, b);
    return result * direction;
  };
  return [...entries].sort(compare);
}
