import type { FocusedChatAttachment } from "@/lib/ai/chatSendOrchestrator";

/**
 * Shared file → chat-attachment ingestion.
 *
 * This is the single source of truth used by BOTH the composer file picker
 * (OmniaGrid's hidden <input>) and clipboard paste (useChatEngine's
 * handleChatPaste). Keeping it in one place means screenshots pasted with
 * Cmd+V behave identically to files chosen from disk.
 */

const DOCUMENT_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
  "txt", "md", "markdown", "json", "html", "htm", "csv", "rtf",
]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "aac", "flac", "wma"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "webm", "mkv", "wmv"]);
const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif", "avif",
]);

function isImageFile(mime: string, ext: string): boolean {
  return mime.startsWith("image/") || IMAGE_EXTS.has(ext);
}

function makeAttId(): string {
  return (
    (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
    `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const [meta, b64] = dataUrl.split(",");
    if (!b64) return null;
    const mime = meta.match(/data:([^;]+)/)?.[1] || "application/octet-stream";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

/**
 * Best-effort background upload of a chat attachment's bytes to Supabase
 * Storage so the image/file survives leaving and returning to the chat.
 *
 * The attachment is added to the composer immediately with its data URL (for
 * instant preview + vision this turn); once the upload lands we patch the
 * attachment with a durable `storagePath`. On persist the data URL is dropped
 * and `reSignChatAttachments` mints a fresh signed URL from the path on reload.
 *
 * Fully degrade-safe: if there's no signed-in user, no upload context, or the
 * upload fails, the attachment keeps its data URL (which is persisted as-is),
 * so behavior never regresses.
 */
async function uploadChatAttachmentBytes(
  blob: Blob,
  fileName: string,
  userId: string,
): Promise<{ storagePath: string; storageBucket: string } | null> {
  try {
    const { supabase } = await import("@/lib/supabase");
    const fileId =
      (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const typeExt = (blob.type.split("/")[1] || "").replace("jpeg", "jpg");
    const nameExt = (fileName || "").split(".").pop()?.toLowerCase() || "";
    const ext = typeExt || nameExt || "bin";
    const storagePath = `${userId}/${fileId}/original.${ext}`;
    const { error } = await supabase.storage
      .from("user-files")
      .upload(storagePath, blob, {
        cacheControl: "3600",
        upsert: false,
        contentType: blob.type || "application/octet-stream",
      });
    if (error) return null;
    return { storagePath, storageBucket: "user-files" };
  } catch {
    return null;
  }
}

export interface ChatFileUploadCtx {
  /** Signed-in user id; uploads are skipped (data-URL-only) when absent. */
  userId?: string | null;
  /** Patch a composer attachment in place once its durable upload lands. */
  updateAttachment: (id: string, patch: Record<string, unknown>) => void;
}

/**
 * Convert a list of dropped/pasted/picked files into chat attachments,
 * pushing each through `addFocusedAttachment` as it resolves.
 *
 * Mirrors the picker logic: audio/video kept as rawFile for server
 * transcription, documents extracted to text, everything else read as a
 * data URL (image / pdf / generic file).
 */
export async function ingestChatFiles(
  files: File[] | FileList | null | undefined,
  addFocusedAttachment: (att: FocusedChatAttachment) => void,
  uploadCtx?: ChatFileUploadCtx,
): Promise<void> {
  const list = Array.from(files || []);
  if (!list.length) return;

  for (const file of list) {
    const mime = file.type || "";
    const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
    const isAudio = mime.startsWith("audio/") || AUDIO_EXTS.has(ext);
    const isVideo = mime.startsWith("video/") || VIDEO_EXTS.has(ext);
    const isImage = isImageFile(mime, ext);

    if (isAudio || isVideo) {
      addFocusedAttachment({
        id: makeAttId(),
        type: isAudio ? "audio" : "video",
        url: "",
        name: file.name,
        mime,
        size: file.size,
        rawFile: file,
      });
      continue;
    }

    if (DOCUMENT_EXTS.has(ext)) {
      try {
        const { extractTextFromFile } = await import("@/lib/extract-text");
        const { API_BASE_URL } = await import("@/lib/api-config");
        const result = await extractTextFromFile(file, API_BASE_URL);
        addFocusedAttachment({
          id: makeAttId(),
          type: "document",
          url: "",
          name: file.name,
          mime,
          size: file.size,
          extractedText: result?.text || "",
        });
      } catch {
        addFocusedAttachment({
          id: makeAttId(),
          type: "document",
          url: "",
          name: file.name,
          mime,
          size: file.size,
        });
      }
      continue;
    }

    if (isImage) {
      try {
        // HEIF→JPEG + downscale/compress so multi-MB phone photos don't blow
        // past the server's JSON body limit (which surfaced to users as a
        // repeated "trouble connecting" error on the mobile app).
        const { fileToChatImageDataUrl } = await import("@/lib/heifToJpeg");
        const dataUrl = await fileToChatImageDataUrl(file);
        const attId = makeAttId();
        const attName = file.name || "Pasted image";
        addFocusedAttachment({
          id: attId,
          type: "image",
          url: dataUrl,
          name: attName,
          mime: dataUrl.startsWith("data:image/jpeg") ? "image/jpeg" : mime,
          size: file.size,
        });
        // Persist the (downscaled) image bytes to storage in the background so
        // it survives reloads — uploading the same bytes the user is previewing.
        if (uploadCtx?.userId) {
          const blob = dataUrlToBlob(dataUrl);
          if (blob) {
            void uploadChatAttachmentBytes(blob, attName, uploadCtx.userId).then((meta) => {
              if (meta) uploadCtx.updateAttachment(attId, meta);
            });
          }
        }
      } catch {
        // Unreadable image — skip silently rather than break the paste.
      }
      continue;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const type = mime === "application/pdf" || ext === "pdf" ? "pdf" : "file";
      const attId = makeAttId();
      const attName = file.name || "Pasted file";
      addFocusedAttachment({
        id: attId,
        type,
        url: dataUrl,
        name: attName,
        mime,
        size: file.size,
      });
      if (uploadCtx?.userId) {
        void uploadChatAttachmentBytes(file, attName, uploadCtx.userId).then((meta) => {
          if (meta) uploadCtx.updateAttachment(attId, meta);
        });
      }
    } catch {
      // Unreadable file — skip silently rather than break the paste.
    }
  }
}
