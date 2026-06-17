import { supabase } from "@/lib/supabase";
import { parseAttachmentsFromContent } from "@/lib/vault/attachmentsMarker";

// File-type buckets used by the project "What's inside" wheel. Order here is
// the slice order in the donut; colors match the vault's own type language.
export const VAULT_TYPE_META = {
  pdf: { label: "PDFs", color: "#ef4444" },
  image: { label: "Images", color: "#3b82f6" },
  video: { label: "Videos", color: "#a855f7" },
  link: { label: "Links", color: "#06b6d4" },
  audio: { label: "Audio", color: "#f59e0b" },
  doc: { label: "Docs", color: "#22c55e" },
  note: { label: "Notes", color: "#94a3b8" },
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|flv|wmv|3gp)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|aiff?)$/i;
const PDF_EXT = /\.pdf$/i;

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

// Map a single attachment object to one of the wheel's file-type buckets.
function typeFromAttachment(att) {
  if (!att || typeof att !== "object") return null;
  const t = String(att.type || "").toLowerCase();
  const name = String(att.name || "").toLowerCase();
  const url = String(att.url || "").toLowerCase();
  const mime = String(att.mimeType || att.mime_type || "").toLowerCase();

  if (t === "image" || mime.startsWith("image/") || IMAGE_EXT.test(name) || IMAGE_EXT.test(url)) return "image";
  if (t === "video" || t === "youtube" || mime.startsWith("video/") || VIDEO_EXT.test(name) || VIDEO_EXT.test(url)) return "video";
  if (t === "audio" || mime.startsWith("audio/") || AUDIO_EXT.test(name) || AUDIO_EXT.test(url)) return "audio";
  if (t === "pdf" || mime === "application/pdf" || PDF_EXT.test(name) || PDF_EXT.test(url)) return "pdf";
  if (t === "bookmark" || t === "link") return "link";
  if (["doc", "spreadsheet", "presentation", "text", "file"].includes(t)) return "doc";
  // Unknown attachment type that is just an external URL → treat as a link.
  if (url && isHttpUrl(url)) return "link";
  return "doc";
}

// Classify a vault note row into one file-type bucket. Attachments win; then a
// bare external `source` URL means it's a saved link; otherwise it's a note.
export function classifyVaultNote(row) {
  const content = typeof row?.content === "string" ? row.content : "";
  const attachments = parseAttachmentsFromContent(content);
  for (const att of attachments) {
    const bucket = typeFromAttachment(att);
    if (bucket) return bucket;
  }
  if (isHttpUrl(row?.source)) return "link";
  return "note";
}

/**
 * Fetch the given vault notes and tally them by file type for the project
 * "What's inside" wheel.
 * @returns {Promise<Record<keyof typeof VAULT_TYPE_META, number>>}
 */
export async function fetchVaultFileTypeCounts(userId, noteIds) {
  const empty = { pdf: 0, image: 0, video: 0, link: 0, audio: 0, doc: 0, note: 0 };
  if (!userId || !noteIds?.length) return empty;
  const ids = [...new Set(noteIds.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 200);
  if (!ids.length) return empty;

  const { data, error } = await supabase
    .from("vault_items")
    .select("id, source, content")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw error;

  const counts = { ...empty };
  for (const row of data || []) {
    const bucket = classifyVaultNote(row);
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  return counts;
}
