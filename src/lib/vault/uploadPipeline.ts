import { supabase } from "@/lib/supabase";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { describeVaultItemInBackground } from "@/lib/vault/describeVaultItem";
import { uploadFileToStorage } from "@/lib/vault/uploadFileToStorage";
import {
  IMAGE_COMPRESS_THRESHOLD_BYTES,
  VIDEO_COMPRESS_THRESHOLD_BYTES,
  maybeCompressMedia,
  needsTranscodeForCompatibility,
} from "@/lib/vault/compressMedia";
import {
  useVaultUploadStore,
  type VaultUploadItem,
} from "@/store/vaultUploadStore";
import { UPLOAD_RATE_LIMITS } from "@/lib/pricing-config";
import { notifyUploadRateLimitIfApplicable } from "@/lib/vault/uploadRateLimitError";

type PlanId = keyof typeof UPLOAD_RATE_LIMITS;

// ---------------------------------------------------------------------------
// Rolling-window rate limiter (client-side, per tab)
//
// This is the *proactive* counterpart to the DB trigger in
// 033_upload_rate_trigger.sql. The trigger is authoritative — if it raises,
// the upload fails. But raising on every request after a big drop is a
// terrible UX, so we also throttle bursts locally: we remember the timestamps
// of recent uploads in this tab and, before starting each file, sleep until
// the oldest one ages out of the window.
//
// Timestamps live at module scope so multiple `startVaultUploads` calls from
// the same tab (e.g. rapid-fire drops) share the same bookkeeping. Cross-tab
// coordination is deliberately not attempted — the DB trigger catches that.
// ---------------------------------------------------------------------------
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const recentUploadTimestamps: number[] = [];

function pruneRecentUploads(now: number): void {
  // Anything older than the widest window (1 hour) is irrelevant.
  const cutoff = now - HOUR_MS;
  while (recentUploadTimestamps.length && recentUploadTimestamps[0] < cutoff) {
    recentUploadTimestamps.shift();
  }
}

function countWithin(now: number, windowMs: number): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (let i = recentUploadTimestamps.length - 1; i >= 0; i -= 1) {
    if (recentUploadTimestamps[i] >= cutoff) count += 1;
    else break;
  }
  return count;
}

function resolvePlanLimits(planId: PlanId | null | undefined) {
  const key: PlanId = planId && UPLOAD_RATE_LIMITS[planId] ? planId : "free";
  return UPLOAD_RATE_LIMITS[key];
}

/**
 * Blocks until starting another upload wouldn't breach either the
 * per-minute or per-hour cap. Cheap when the user is nowhere near the cap,
 * which is the common case.
 */
async function awaitRateLimitSlot(planId: PlanId | null | undefined): Promise<void> {
  const limits = resolvePlanLimits(planId);
  // Safety clamp: nobody's caps should be absurdly tight.
  const perMinute = Number.isFinite(limits.perMinute) ? limits.perMinute : Infinity;
  const perHour = Number.isFinite(limits.perHour) ? limits.perHour : Infinity;

  // Up to ~10 minutes of waiting, more than enough for any realistic burst
  // scenario. If the user is this far over quota, something is wrong and
  // we'd rather surface an error than loop forever.
  for (let i = 0; i < 600; i += 1) {
    const now = Date.now();
    pruneRecentUploads(now);
    const inMinute = countWithin(now, MINUTE_MS);
    const inHour = countWithin(now, HOUR_MS);

    if (inMinute < perMinute && inHour < perHour) return;

    // Sleep until the oldest timestamp in the breached window ages out.
    let waitMs = 1000;
    if (inMinute >= perMinute && recentUploadTimestamps.length > 0) {
      const oldestInMinute = recentUploadTimestamps.find(
        (t) => t >= now - MINUTE_MS,
      );
      if (oldestInMinute !== undefined) {
        waitMs = Math.max(250, oldestInMinute + MINUTE_MS - now + 50);
      }
    } else if (inHour >= perHour && recentUploadTimestamps.length > 0) {
      const oldestInHour = recentUploadTimestamps.find(
        (t) => t >= now - HOUR_MS,
      );
      if (oldestInHour !== undefined) {
        waitMs = Math.max(1000, oldestInHour + HOUR_MS - now + 100);
      }
    }
    // Cap a single wait at 30s so the UI can refresh and the user can see
    // that something is (intentionally) happening.
    waitMs = Math.min(waitMs, 30_000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function recordUpload(): void {
  recentUploadTimestamps.push(Date.now());
}

/**
 * The vault upload pipeline lives here (not in the React component) so that:
 *   1. In-flight uploads keep running when the user navigates away from the
 *      vault page.
 *   2. Multiple components can subscribe to the same progress without
 *      duplicating state.
 *   3. The heavy ffmpeg / TUS work never holds a React fiber.
 *
 * Each job goes through three stages: COMPRESS → UPLOAD → POST_PROCESS.
 * Compression is *globally* serialized by the ffmpeg mutex in compressMedia.ts,
 * so large drops of videos won't fight over the single wasm instance.
 * Uploads run with a modest parallelism so multiple files saturate the
 * user's bandwidth while not overwhelming the compression stage.
 */

type StartFileUploadsInput = {
  userId: string;
  files: Array<{ file: File; folderPath: string | null; filename: string }>;
  /**
   * User's active plan. Drives client-side upload rate limiting so big
   * batch drops get paced out instead of hammering the DB trigger. Defaults
   * to "free" (strictest) if not provided — safer to over-throttle than to
   * miss the cap.
   */
  planId?: PlanId | null;
  onAllComplete?: (result: { createdNotes: Array<{ id: string }> }) => void;
  /**
   * Fires as soon as each individual file finishes uploading and has a
   * persisted vault note. Used by the vault grid to swap its optimistic
   * "ghost" card for the real, DB-backed card as each upload completes
   * (rather than waiting for the whole batch).
   */
  onFileComplete?: (note: { id: string; [key: string]: unknown }) => void;
};

const VIDEO_EXTENSIONS = new Set([
  "mov", "mp4", "m4v", "webm", "mkv", "avi", "wmv", "mpeg", "mpg", "3gp", "qt",
]);

const UPLOAD_PARALLELISM = 4;

function getFileType(mimeType: string, filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType?.includes("word") || ext === "doc" || ext === "docx") return "doc";
  if (mimeType?.includes("excel") || ext === "xls" || ext === "xlsx") return "spreadsheet";
  if (mimeType?.includes("presentation") || ext === "ppt" || ext === "pptx") return "presentation";
  if (mimeType?.includes("text") || ext === "txt" || ext === "md") return "text";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "file";
}

function canPreview(fileType: string): boolean {
  return fileType === "image" || fileType === "video";
}

async function extractPdfText(file: File): Promise<string> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfjsLib: any = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (pageText) pages.push(pageText);
    }
    return pages.join("\n\n");
  } catch (error: any) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("PDF text extraction failed:", error?.message);
    }
    return "";
  }
}

type CreateNoteArgs = {
  userId: string;
  filename: string;
  folderPath: string | null;
  fileType: string;
  fileUrl: string | null;
  storagePath: string | null;
  storageBucket: string;
  fileSize: number;
  mimeType: string;
};

async function createVaultNote(args: CreateNoteArgs): Promise<any | null> {
  const {
    userId, filename, folderPath, fileType, fileUrl, storagePath,
    storageBucket, fileSize, mimeType,
  } = args;

  const folderName = folderPath ? String(folderPath).trim() : "Uploaded Files";
  const noteTitle = filename.replace(/\.[^/.]+$/, "") || filename;
  const fileSizeKB = (fileSize / 1024).toFixed(2);
  const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
  const sizeDisplay = fileSize > 1024 * 1024 ? `${fileSizeMB} MB` : `${fileSizeKB} KB`;

  const attachmentPayload = [{
    type: fileType,
    url: fileUrl,
    name: filename,
    fileId: null,
    storagePath: storagePath || undefined,
    storageBucket: storageBucket || undefined,
    size: fileSize,
    mimeType,
  }];

  const noteContent = `File uploaded: ${filename}\n\nType: ${fileType}\nSize: ${sizeDisplay}\n\n[View File](${fileUrl || ""})\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;

  const richInsert = {
    user_id: userId,
    title: noteTitle,
    content: noteContent,
    folder: folderName,
    source: "file_upload",
    tags: [fileType, "uploaded"],
  } as Record<string, unknown>;

  let { data: insertedNote, error: noteError } = await supabase
    .from("notes")
    .insert(richInsert)
    .select("id, title, content, tags, created_at, updated_at")
    .single();

  const missingColumnError =
    noteError &&
    (
      (noteError as any).code === "PGRST204" ||
      (noteError as any).message?.includes("Could not find") ||
      String((noteError as any).message || "").toLowerCase().includes("does not exist")
    );

  if (missingColumnError) {
    ({ data: insertedNote, error: noteError } = await supabase
      .from("notes")
      .insert({ user_id: userId, title: noteTitle, content: noteContent })
      .select("id, title, content, created_at, updated_at")
      .single());
  }

  if (noteError) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error("Error creating note for file:", noteError);
    }
    // Propagate trigger-raised errors (vault cap, upload rate limit) so
    // `processOne` can route them through the right user-facing flow
    // instead of quietly returning null.
    const msgs = [
      (noteError as any)?.message,
      (noteError as any)?.details,
      (noteError as any)?.hint,
    ]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    if (msgs.includes("upload_rate_limit") || msgs.includes("vault_cap_reached")) {
      throw noteError;
    }
    return null;
  }
  return insertedNote || null;
}

function runPostProcessing(args: {
  userId: string;
  noteId: string;
  file: File;
  filename: string;
  fileType: string;
  fileUrl: string | null;
  createdNote: any;
}): void {
  const { userId, noteId, file, filename, fileType, fileUrl, createdNote } = args;
  (async () => {
    try {
      let extractedPdfText = "";
      let spreadsheetData: any = null;

      if (fileType === "pdf") {
        extractedPdfText = await extractPdfText(file);
      } else if (fileType === "spreadsheet") {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const formData = new FormData();
          formData.append("file", file);
          const ssRes = await fetch(`${API_BASE_URL}/api/files/parse-spreadsheet`, {
            method: "POST",
            body: formData,
          });
          if (ssRes.ok) spreadsheetData = await ssRes.json();
        } catch { /* best-effort */ }
      }

      if (extractedPdfText || spreadsheetData) {
        try {
          const { data: latest } = await supabase
            .from("notes")
            .select("content")
            .eq("id", noteId)
            .single();
          const content: string = (latest as any)?.content || createdNote?.content || "";
          const marker = "[ATTACHMENTS_JSON:";
          const start = content.indexOf(marker);
          if (start !== -1) {
            const jsonStart = start + marker.length;
            let depth = 0;
            let end = jsonStart;
            for (let i = jsonStart; i < content.length; i += 1) {
              const ch = content[i];
              if (ch === "[") depth += 1;
              if (ch === "]") {
                depth -= 1;
                if (depth === 0) { end = i + 1; break; }
              }
            }
            try {
              const jsonStr = content.slice(jsonStart, end);
              const parsed = JSON.parse(jsonStr);
              if (Array.isArray(parsed) && parsed[0]) {
                if (extractedPdfText) {
                  parsed[0].extractedText = String(extractedPdfText).slice(0, 12000);
                }
                if (spreadsheetData) {
                  parsed[0].rows = spreadsheetData.rows;
                  parsed[0].cols = spreadsheetData.cols;
                  parsed[0].cells = spreadsheetData.cells;
                }
                const newContent =
                  content.slice(0, jsonStart) +
                  JSON.stringify(parsed) +
                  content.slice(end);
                await supabase
                  .from("notes")
                  .update({ content: newContent })
                  .eq("id", noteId);
              }
            } catch { /* ignore parse errors */ }
          }
        } catch { /* ignore */ }
      }

      const ssText = spreadsheetData?.cells
        ? Object.values(spreadsheetData.cells).flat().filter(Boolean).join(", ").slice(0, 3000)
        : "";

      describeVaultItemInBackground(noteId, {
        imageUrl: (fileType === "image" || fileType === "video") ? fileUrl || undefined : undefined,
        textContent: extractedPdfText || ssText || undefined,
        fileType,
        fileName: filename,
      });

      afterVaultNoteSaved(userId, noteId, {
        title: createdNote?.title || filename,
        content: createdNote?.content || "",
        extraPlain: extractedPdfText || ssText || undefined,
      });
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[uploadPipeline] post-processing failed:", err);
      }
    }
  })();
}

async function processOne(args: {
  userId: string;
  itemId: string;
  file: File;
  folderPath: string | null;
  filename: string;
  planId?: PlanId | null;
  onFileComplete?: (note: { id: string; [key: string]: unknown }) => void;
}): Promise<{ id: string } | null> {
  const { userId } = args;
  let { file, filename } = args;
  const store = useVaultUploadStore.getState();
  const fileType = getFileType(file.type, filename);

  // ── HEIF → JPEG ─────────────────────────────────────────────────────
  const nameLower = filename.toLowerCase();
  const mimeLower = (file.type || "").toLowerCase();
  const isHeif =
    nameLower.endsWith(".heic") ||
    nameLower.endsWith(".heif") ||
    mimeLower.startsWith("image/heic") ||
    mimeLower.startsWith("image/heif");
  if (isHeif) {
    try {
      const { fileToDisplayableFile } = await import("@/lib/heifToJpeg");
      const displayable = await fileToDisplayableFile(file);
      if (displayable !== file) {
        file = displayable;
        filename = displayable.name;
      }
    } catch (e) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[uploadPipeline] HEIF conversion skipped:", e);
      }
    }
  }

  try {
    // ── Rate-limit gate ───────────────────────────────────────────────
    // Pace out big batches so we don't hammer the 033 trigger. Status is
    // "pending" until a slot opens, so the toast shows "Waiting…" rather
    // than spinning on a doomed compression job.
    await awaitRateLimitSlot(args.planId);

    // ── Compression phase ─────────────────────────────────────────────
    const originalSize = file.size || 0;
    const nameExt = filename.split(".").pop()?.toLowerCase() || "";
    const typeLower = (file.type || "").toLowerCase();
    const isVideo = typeLower.startsWith("video/") || VIDEO_EXTENSIONS.has(nameExt);
    const isImage = typeLower.startsWith("image/");
    // Videos get transcoded either because they're above the size
    // threshold OR because the container commonly holds codecs the
    // browser can't decode (HEVC .mov, ProRes, etc.). In the latter case
    // compression is about playability, not bytes.
    const willCompressVideo =
      isVideo &&
      (originalSize >= VIDEO_COMPRESS_THRESHOLD_BYTES ||
        needsTranscodeForCompatibility(file));
    const willCompressImage = isImage && originalSize >= IMAGE_COMPRESS_THRESHOLD_BYTES;

    if (willCompressVideo || willCompressImage) {
      store.update(args.itemId, {
        status: willCompressVideo ? "compressing-video" : "compressing-image",
        progress: 0,
      });
      const compressResult = await maybeCompressMedia(file, ({ percent }) => {
        store.update(args.itemId, { progress: Math.round(percent) });
      });
      if (compressResult.compressed) {
        file = compressResult.file;
        filename = compressResult.file.name;
        store.update(args.itemId, {
          filename,
          sizeBytes: file.size,
          mimeType: file.type || "",
          savedFromBytes: compressResult.originalSize,
          savedToBytes: compressResult.finalSize,
        });
      }
    }

    // ── Upload phase ──────────────────────────────────────────────────
    store.update(args.itemId, { status: "uploading", progress: 1 });

    const fileId = crypto.randomUUID();
    const fileExt = filename.split(".").pop() || "bin";
    const storagePath = `${userId}/${fileId}/original.${fileExt}`;

    let lastRenderedPct = 0;
    let uploadResult;
    try {
      uploadResult = await uploadFileToStorage({
        file,
        userId,
        storagePath,
        bucket: "user-files",
        contentType: file.type,
        cacheControl: "3600",
        upsert: false,
        onProgress: (pct: number) => {
          const scaled = Math.min(95, Math.max(1, Math.round(pct * 0.95)));
          if (scaled === lastRenderedPct) return;
          lastRenderedPct = scaled;
          store.update(args.itemId, { progress: scaled });
        },
      });
    } catch (uploadError: any) {
      const bucketMissing =
        uploadError?.message?.toLowerCase?.().includes("bucket not found") ||
        uploadError?.statusCode === 404;
      if (bucketMissing) {
        throw new Error(
          "Storage bucket 'user-files' is missing. Create it in Supabase Storage to upload media.",
        );
      }
      throw uploadError;
    }

    const fileUrl = uploadResult.signedUrl || uploadResult.publicUrl || null;
    store.update(args.itemId, { progress: 97 });

    const createdNote = await createVaultNote({
      userId,
      filename,
      folderPath: args.folderPath,
      fileType,
      fileUrl,
      storagePath,
      storageBucket: "user-files",
      fileSize: file.size,
      mimeType: file.type,
    });

    // Record after the insert succeeds (the DB trigger is authoritative,
    // but we want our rolling window to reflect reality).
    recordUpload();

    store.update(args.itemId, {
      progress: 100,
      status: "completed",
      noteId: createdNote?.id || null,
    });

    if (createdNote?.id) {
      // Tell the vault grid about this note immediately so its optimistic
      // ghost card can swap to the real DB-backed one without waiting for
      // the rest of the batch to finish.
      if (args.onFileComplete) {
        try {
          args.onFileComplete(createdNote as { id: string });
        } catch (err) {
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn("[uploadPipeline] onFileComplete threw:", err);
          }
        }
      }

      runPostProcessing({
        userId,
        noteId: createdNote.id,
        file,
        filename,
        fileType,
        fileUrl,
        createdNote,
      });
    }

    return createdNote || null;
  } catch (error: any) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error("Upload error:", error);
    }
    const rawMsg =
      error?.message ||
      error?.error?.message ||
      error?.originalResponse?.getBody?.() ||
      "";
    let friendly = "Upload failed. Please try again.";
    const lower = String(rawMsg).toLowerCase();

    // The DB-trigger rate limit looks like a generic PG check_violation to
    // supabase-js. Catch it first so we show the rate-limit modal, not a
    // generic "Upload failed: ..." toast. The shared helper also dispatches
    // the event that `useUsageGate` listens for.
    if (notifyUploadRateLimitIfApplicable(error)) {
      friendly = "Upload paused — you're uploading too fast. Try again in a moment.";
    } else if (lower.includes("exceeded the maximum allowed size") || lower.includes("payload too large") || lower.includes("413")) {
      friendly = "File too large for this vault. Increase the bucket file size limit in Supabase Storage.";
    } else if (lower.includes("mime") && lower.includes("not allowed")) {
      friendly = "This file type is blocked by the storage bucket settings.";
    } else if (lower.includes("bucket not found")) {
      friendly = "Storage bucket 'user-files' is missing. Create it in Supabase Storage.";
    } else if (rawMsg) {
      friendly = `Upload failed: ${String(rawMsg).slice(0, 160)}`;
    }
    store.update(args.itemId, { status: "error", error: friendly });
    return null;
  }
}

/**
 * Enqueues the files into the global upload store and kicks off the worker
 * pool. Returns a promise that resolves when all enqueued files have
 * finished (completed or errored). The pipeline keeps running even if the
 * caller's component unmounts – the store lives at module scope.
 */
export async function startVaultUploads(input: StartFileUploadsInput): Promise<void> {
  const store = useVaultUploadStore.getState();

  const enqueued: Array<{
    itemId: string;
    file: File;
    folderPath: string | null;
    filename: string;
  }> = [];

  for (const entry of input.files) {
    const itemId = crypto.randomUUID();
    const mimeType = entry.file.type || "";
    const fileType = getFileType(mimeType, entry.filename);
    let previewUrl: string | null = null;
    if (canPreview(fileType)) {
      try {
        previewUrl = URL.createObjectURL(entry.file);
      } catch {
        previewUrl = null;
      }
    }
    const item: VaultUploadItem = {
      id: itemId,
      filename: entry.filename,
      folderPath: entry.folderPath,
      mimeType,
      fileType,
      sizeBytes: entry.file.size || 0,
      progress: 0,
      status: "pending",
      error: null,
      previewUrl,
      savedFromBytes: null,
      savedToBytes: null,
      noteId: null,
      startedAt: Date.now(),
    };
    store.enqueue(item);
    enqueued.push({
      itemId,
      file: entry.file,
      folderPath: entry.folderPath,
      filename: entry.filename,
    });
  }

  const createdNotes: Array<{ id: string }> = [];
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < enqueued.length) {
      const currentIndex = cursor;
      cursor += 1;
      const job = enqueued[currentIndex];
      const created = await processOne({
        userId: input.userId,
        itemId: job.itemId,
        file: job.file,
        folderPath: job.folderPath,
        filename: job.filename,
        planId: input.planId ?? null,
        onFileComplete: input.onFileComplete,
      });
      if (created?.id) createdNotes.push(created);
    }
  };
  const workerCount = Math.min(UPLOAD_PARALLELISM, enqueued.length);
  const workers = Array.from({ length: workerCount }, () => runNext());
  await Promise.all(workers);

  if (input.onAllComplete) {
    try {
      input.onAllComplete({ createdNotes });
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[uploadPipeline] onAllComplete threw:", err);
      }
    }
  }
}
