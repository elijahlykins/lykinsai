// Helpers for turning raw user input into chat attachments: URL type
// inference (youtube / image / video / audio / pdf / document / link),
// attachment id minting, and the mapping from chat attachments to Imagine
// mode's generate input. Extracted verbatim from src/pages/LyknChat.tsx
// (LyknChat decomposition phase, see docs/REFACTOR_LOG.md).
import type { ImagineGenerateInput } from "@/components/lyknChat/StudioImagineMode";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";

export const isYouTubeUrl = (url = "") =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(String(url).trim());

export const getUrlExtension = (url = "") => {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const fileName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() || "" : "";
    return ext;
  } catch { return ""; }
};

const DOCUMENT_EXTS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "txt", "md", "markdown", "json", "html", "htm", "csv", "rtf"]);

export const inferUrlAttachmentType = (url = "") => {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "link";
  if (isYouTubeUrl(trimmed)) return "youtube";
  const ext = getUrlExtension(trimmed);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  return "link";
};

export function chatAttachmentsToImagineInput(
  text: string,
  atts: FocusedChatAttachment[],
): ImagineGenerateInput {
  const referenceUrls: string[] = [];
  const documents: { name: string; text: string }[] = [];
  for (const a of atts || []) {
    const isImg = a.type === "image" || String(a.mime || "").startsWith("image/");
    const src = String(a.url || "");
    if (isImg && src) {
      referenceUrls.push(src);
      continue;
    }
    const body = [a.extractedText, a.pdfText, a.transcript, a.vaultContent]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (body) documents.push({ name: a.name || a.vaultTitle || "attachment", text: body });
  }
  return { text, referenceUrls, documents };
}

export const makeAttId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
  `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
