import { supabase } from "@/lib/supabase";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { describeVaultItemInBackground } from "@/lib/vault/describeVaultItem";
import { uploadFileToStorage } from "@/lib/vault/uploadFileToStorage";
import { generateMediaVariants } from "@/lib/vault/mediaVariants";
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
import { UPLOAD_RATE_LIMITS, VAULT_UPLOAD_LIMITS } from "@/lib/pricing-config";
import {
  preflightVaultUploadBatch,
  summarizePreflightRejections,
  formatBytesShort,
} from "@/lib/vault/uploadPreflight";
import { notifyUploadRateLimitIfApplicable } from "@/lib/vault/uploadRateLimitError";
import { notifyVaultCapIfApplicable } from "@/lib/vault/vaultCapError";
import { findAttachmentsMarker, withAttachmentsMarker } from "@/lib/vault/attachmentsMarker";
import { buildAttachmentColumns } from "@/lib/vault/attachmentType";
import { toast } from "@/components/ui/use-toast";
import {
  commitVaultUpload,
  registerVaultUploadCancellation,
  setVaultUploadStoragePath,
  unregisterVaultUploadCancellation,
} from "@/lib/vault/uploadCancellation";
import { beginUploadLedger, clearUploadLedger } from "@/lib/vault/uploadLedger";

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
 *
 * The optional `signal` lets the per-item AbortController short-circuit
 * the wait if the user dismisses the upload while we're still pacing.
 */
async function awaitRateLimitSlot(
  planId: PlanId | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const limits = resolvePlanLimits(planId);
  // Safety clamp: nobody's caps should be absurdly tight.
  const perMinute = Number.isFinite(limits.perMinute) ? limits.perMinute : Infinity;
  const perHour = Number.isFinite(limits.perHour) ? limits.perHour : Infinity;

  // Up to ~10 minutes of waiting, more than enough for any realistic burst
  // scenario. If the user is this far over quota, surface an error
  // instead of either looping forever (UX hang) or silently bypassing
  // the limit (the original bug — the loop just `return`-ed past 600
  // iterations).
  for (let i = 0; i < 600; i += 1) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
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
    await waitWithAbort(waitMs, signal);
  }

  // We've waited the full 10 minutes and the cap is still pinned. That's
  // a real over-quota condition — surface it as a friendly error so the
  // pipeline catch can route it through the existing rate-limit modal,
  // rather than silently letting the upload proceed (which would just
  // bounce off the DB trigger and orphan a storage object).
  throw new Error(
    "upload_rate_limit: too many uploads queued — please try again later",
  );
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  /** Latest vault note count — refreshed here when omitted. */
  vaultCount?: number | null;
  onAllComplete?: (result: { createdNotes: Array<{ id: string }> }) => void;
  /** Fires after each note row is inserted (for client-side cap bookkeeping). */
  onNoteCreated?: () => void;
  /**
   * Fires as soon as each individual file finishes uploading and has a
   * persisted vault note. Used by the vault grid to swap its optimistic
   * "ghost" card for the real, DB-backed card as each upload completes
   * (rather than waiting for the whole batch).
   */
  onFileComplete?: (note: { id: string; [key: string]: unknown }) => void;
  /**
   * Fires when a just-uploaded image/video's medium/thumb variants are
   * generated and stored. Lets the grid swap a freshly-uploaded video's
   * black box for its real poster frame without waiting for a reload.
   */
  onVariantsReady?: (
    noteId: string,
    variants: { variantThumbPath?: string; variantMediumPath?: string },
  ) => void;
};

const UPLOAD_PARALLELISM = 4;

// Optimistic ghost-card previews are created at drop time so the grid feels
// instant — the user sees every dropped image/video immediately, before any
// compression/upload/DB write. We create them for bulk imports too (the case
// that needs instant feedback MOST), but cap the count so a pathological
// 200-file drop doesn't pin hundreds of decoded blobs in memory or jank the
// grid. Files past the cap still upload normally; they just don't get a ghost
// card and instead pop in when their real note lands. Each preview URL is
// revoked by the upload store on terminal state / merge, so this is a bound on
// *concurrent* previews, not total uploads.
const MAX_OPTIMISTIC_PREVIEWS = 120;

// ---------------------------------------------------------------------------
// In-flight dedup
//
// `saveFileToVault.ts` already has its own session-level + DB dedup, but the
// vault upload pipeline path was bypassing it: every drop minted a fresh
// UUID storagePath, so the same file dragged into the vault twice in quick
// succession produced two storage objects, two `notes` rows, and two
// duplicate cards on the grid.
//
// We dedup on `(userId, filename, size, lastModified)` — robust against
// accidental double-drops (drop, then panic-drop again because the toast
// didn't appear instantly) without false-positiving distinct files that
// happen to share a name. The key is held only while the upload is
// actively in flight, then released in the `finally` of `processOne` —
// so legitimately re-saving a file later still works.
// ---------------------------------------------------------------------------
const inFlightDedup = new Set<string>();

function inFlightDedupKey(userId: string, file: File, filename: string): string {
  const size = file.size || 0;
  const lastModified = (file as File).lastModified || 0;
  return `${userId}::${filename}::${size}::${lastModified}`;
}

const VIDEO_EXTENSIONS = new Set([
  "mov", "mp4", "m4v", "webm", "mkv", "avi", "wmv", "mpeg", "mpg", "3gp", "qt",
]);
const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff", "avif",
]);

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
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "file";
}

function canPreview(fileType: string): boolean {
  return fileType === "image" || fileType === "video";
}

// Reads the intrinsic pixel dimensions of an image/video file so the vault
// grid can reserve the EXACT aspect-ratio slot before the media ever loads.
// Without stored dims the masonry estimate (assumes square), the skeleton
// (a fixed height), and the loaded image (its true ratio) all disagree —
// so every card shifts its column the moment its image resolves, which is
// the visible "things load in and jump as you scroll" jank. Capturing the
// ratio once at upload time eliminates that reflow permanently for new
// uploads. Best-effort: decode failures just return null and the grid
// falls back to its previous (shifting) behaviour for that one item.
async function probeMediaDimensions(
  file: File,
  fileType: string,
): Promise<{ width: number; height: number; durationSeconds?: number } | null> {
  try {
    if (fileType === "image") {
      // createImageBitmap is the fastest path (decodes off the main thread)
      // and works for every raster format the browser can render. SVGs and
      // anything it can't decode fall through to the <img> path below.
      if (typeof createImageBitmap === "function") {
        try {
          const bitmap = await createImageBitmap(file);
          const dims = { width: bitmap.width, height: bitmap.height };
          bitmap.close?.();
          if (dims.width > 0 && dims.height > 0) return dims;
        } catch {
          /* fall through to <img> decode */
        }
      }
      return await new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        const done = (dims: { width: number; height: number } | null) => {
          URL.revokeObjectURL(url);
          resolve(dims);
        };
        img.onload = () =>
          done(
            img.naturalWidth > 0 && img.naturalHeight > 0
              ? { width: img.naturalWidth, height: img.naturalHeight }
              : null,
          );
        img.onerror = () => done(null);
        img.src = url;
      });
    }
    if (fileType === "video") {
      return await new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement("video");
        const done = (
          dims: { width: number; height: number; durationSeconds?: number } | null,
        ) => {
          URL.revokeObjectURL(url);
          resolve(dims);
        };
        // Some browsers won't fire loadedmetadata for a detached element
        // unless we nudge it; muted + preload metadata is enough.
        video.preload = "metadata";
        video.muted = true;
        video.onloadedmetadata = () => {
          if (!(video.videoWidth > 0 && video.videoHeight > 0)) return done(null);
          const dur = Number(video.duration);
          done({
            width: video.videoWidth,
            height: video.videoHeight,
            ...(Number.isFinite(dur) && dur > 0 ? { durationSeconds: dur } : {}),
          });
        };
        video.onerror = () => done(null);
        video.src = url;
      });
    }
  } catch {
    /* best-effort */
  }
  return null;
}

// Cap how many PDF pages we pull text from. The vault item stores the FULL
// document (and its real page count), but extracting/embedding every page of a
// 400-page report is wasteful — the first few pages carry the gist for search.
const PDF_TEXT_PAGE_CAP = 6;

async function extractPdfText(
  file: File,
): Promise<{ text: string; pageCount: number | null }> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfjsLib: any = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages: number = pdf.numPages;
    const lastPage = Math.min(totalPages, PDF_TEXT_PAGE_CAP);
    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= lastPage; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (pageText) pages.push(pageText);
    }
    return { text: pages.join("\n\n"), pageCount: totalPages };
  } catch (error: any) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("PDF text extraction failed:", error?.message);
    }
    return { text: "", pageCount: null };
  }
}

// Extracts text from a Word/OpenDocument/PowerPoint file via the server's
// generic /api/files/extract-text route (which already wires mammoth for docx).
async function extractDocText(file: File): Promise<string> {
  try {
    const { API_BASE_URL } = await import("@/lib/api-config");
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE_URL}/api/files/extract-text`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) return "";
    const data = await res.json().catch(() => null);
    return String(data?.text || "").trim();
  } catch {
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
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
};

async function createVaultNote(args: CreateNoteArgs): Promise<any | null> {
  const {
    userId, filename, folderPath, fileType, fileUrl, storagePath,
    storageBucket, fileSize, mimeType, width, height, durationSeconds,
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
    // Intrinsic pixel dimensions let the vault reserve the exact
    // aspect-ratio slot before the media loads — no layout shift.
    ...(width && height && width > 0 && height > 0 ? { width, height } : {}),
    ...(durationSeconds && durationSeconds > 0 ? { durationSeconds } : {}),
  }];

  // Attachment-only body: title + ATTACHMENTS_JSON carry everything the
  // renderers need. No prose line, no storage URL — the neuron panel
  // and vault grid draw the image/video/file from the attachment payload.
  const noteContent = `[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;

  const richInsert = {
    user_id: userId,
    title: noteTitle,
    content: noteContent,
    folder: folderName,
    source: "file_upload",
    tags: [fileType, "uploaded"],
    // Dual-write the normalized attachment columns (migration 104) alongside
    // the marker. The missing-column fallback below covers pre-migration DBs.
    ...buildAttachmentColumns(attachmentPayload[0]),
  } as Record<string, unknown>;

  let { data: insertedNote, error: noteError } = await supabase
    .from("vault_items")
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
      .from("vault_items")
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

// Updates `notes` columns, transparently retrying without them on a DB that
// predates a given migration so the note still lands.
async function updateNoteColumnsTolerant(
  userId: string,
  noteId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("vault_items")
    .update(patch)
    .eq("id", noteId)
    .eq("user_id", userId);
  if (
    error &&
    ((error as any).code === "PGRST204" ||
      /could not find|does not exist/i.test((error as any).message || ""))
  ) {
    // Columns not present yet (pre-migration) — silently skip.
  }
}

async function generateAndStoreVariants(args: {
  userId: string;
  noteId: string;
  file: File;
  fileType: string;
  storagePath: string;
}): Promise<{ variantThumbPath?: string; variantMediumPath?: string }> {
  const { userId, noteId, file, fileType, storagePath } = args;
  const dir = storagePath.slice(0, storagePath.lastIndexOf("/") + 1);
  if (!dir) return {};

  const variants = await generateMediaVariants(file, fileType);
  const patch: Record<string, unknown> = {};

  if (variants.medium) {
    const mediumPath = `${dir}medium.jpg`;
    try {
      await uploadFileToStorage({
        file: variants.medium,
        userId,
        storagePath: mediumPath,
        bucket: "user-files",
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: true,
      });
      patch.variant_medium_path = mediumPath;
    } catch { /* best-effort */ }
  }

  if (variants.thumb) {
    const thumbPath = `${dir}thumb.jpg`;
    try {
      await uploadFileToStorage({
        file: variants.thumb,
        userId,
        storagePath: thumbPath,
        bucket: "user-files",
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: true,
      });
      patch.variant_thumb_path = thumbPath;
    } catch { /* best-effort */ }
  }

  if (!Object.keys(patch).length) return {};

  const result = {
    variantThumbPath: patch.variant_thumb_path as string | undefined,
    variantMediumPath: patch.variant_medium_path as string | undefined,
  };

  // Dual-write the variant paths into the marker too, so existing
  // marker-based renderers (VaultAttachment, the Vault grid) can prefer the
  // small rendition without a column-select refactor.
  try {
    const { data: latest } = await supabase
      .from("vault_items")
      .select("content, updated_at")
      .eq("id", noteId)
      .eq("user_id", userId)
      .single();
    const content: string = (latest as any)?.content || "";
    const span = findAttachmentsMarker(content);
    if (span && span.attachments[0] && typeof span.attachments[0] === "object") {
      const next = span.attachments.slice() as Record<string, unknown>[];
      const head = { ...(next[0] as Record<string, unknown>) };
      if (patch.variant_medium_path) head.variantMediumPath = patch.variant_medium_path;
      if (patch.variant_thumb_path) head.variantThumbPath = patch.variant_thumb_path;
      next[0] = head;
      const newContent = withAttachmentsMarker(content, next);
      const updatedAt = (latest as any)?.updated_at;
      const q = supabase
        .from("vault_items")
        .update({ content: newContent, ...patch })
        .eq("id", noteId)
        .eq("user_id", userId);
      if (updatedAt) q.eq("updated_at", updatedAt);
      const { error } = await q;
      if (
        error &&
        ((error as any).code === "PGRST204" ||
          /could not find|does not exist/i.test((error as any).message || ""))
      ) {
        // Columns missing — persist the marker (which now carries variants).
        const q2 = supabase
          .from("vault_items")
          .update({ content: newContent })
          .eq("id", noteId)
          .eq("user_id", userId);
        if (updatedAt) q2.eq("updated_at", updatedAt);
        await q2;
      }
      return result;
    }
  } catch { /* fall through to columns-only update */ }

  await updateNoteColumnsTolerant(userId, noteId, patch);
  return result;
}

function runPostProcessing(args: {
  userId: string;
  noteId: string;
  file: File;
  filename: string;
  fileType: string;
  fileUrl: string | null;
  storagePath: string | null;
  createdNote: any;
  bulkImport?: boolean;
  onVariantsReady?: (
    noteId: string,
    variants: { variantThumbPath?: string; variantMediumPath?: string },
  ) => void;
}): void {
  const { userId, noteId, file, filename, fileType, fileUrl, storagePath, createdNote, bulkImport } = args;
  (async () => {
    // Image/video: derive medium + thumb renditions and store their paths so
    // the grid/mobile can load a small JPEG instead of the full original.
    if ((fileType === "image" || fileType === "video") && storagePath) {
      try {
        const variants = await generateAndStoreVariants({ userId, noteId, file, fileType, storagePath });
        // Tell the grid the poster/variant paths are ready so a just-uploaded
        // video can swap its black box for the real frame without a reload.
        if (variants && (variants.variantThumbPath || variants.variantMediumPath)) {
          try {
            args.onVariantsReady?.(noteId, variants);
          } catch {
            /* non-fatal */
          }
        }
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[uploadPipeline] variant generation failed:", err);
        }
      }
    }
    try {
      let extractedText = "";
      let pdfPageCount: number | null = null;
      let spreadsheetData: any = null;

      if (fileType === "pdf") {
        const pdf = await extractPdfText(file);
        extractedText = pdf.text;
        pdfPageCount = pdf.pageCount;
      } else if (fileType === "doc") {
        // Word/OpenDocument: extract via the server route (mammoth for docx).
        extractedText = await extractDocText(file);
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

      if (extractedText || spreadsheetData || pdfPageCount != null) {
        try {
          const { data: latest } = await supabase
            .from("vault_items")
            .select("content, updated_at")
            .eq("id", noteId)
            .eq("user_id", userId)
            .single();
          const content: string = (latest as any)?.content || createdNote?.content || "";
          const span = findAttachmentsMarker(content);
          if (span && span.attachments[0] && typeof span.attachments[0] === "object") {
            const next = span.attachments.slice() as Record<string, unknown>[];
            const head = { ...(next[0] as Record<string, unknown>) };
            if (extractedText) {
              head.extractedText = String(extractedText).slice(0, 12000);
            }
            if (pdfPageCount != null) head.pageCount = pdfPageCount;
            if (spreadsheetData) {
              head.rows = spreadsheetData.rows;
              head.cols = spreadsheetData.cols;
              head.cells = spreadsheetData.cells;
            }
            next[0] = head;
            const newContent = withAttachmentsMarker(content, next);
            const updatedAt = (latest as any)?.updated_at;
            // Re-derive the normalized columns from the enriched primary
            // attachment so page_count / attachment_preview.extractedText land
            // in columns too (dual-write). Tolerate pre-migration DBs.
            const refreshedColumns = buildAttachmentColumns(head);
            const q = supabase
              .from("vault_items")
              .update({ content: newContent, ...refreshedColumns })
              .eq("id", noteId)
              .eq("user_id", userId);
            // Lost-update guard so a concurrent edit wins.
            if (updatedAt) q.eq("updated_at", updatedAt);
            const { error: upErr } = await q;
            if (
              upErr &&
              ((upErr as any).code === "PGRST204" ||
                /could not find|does not exist/i.test((upErr as any).message || ""))
            ) {
              // Columns not present yet — at least persist the enriched content.
              const q2 = supabase
                .from("vault_items")
                .update({ content: newContent })
                .eq("id", noteId)
                .eq("user_id", userId);
              if (updatedAt) q2.eq("updated_at", updatedAt);
              await q2;
            }
          }
        } catch { /* ignore */ }
      }

      const ssText = spreadsheetData?.cells
        ? Object.values(spreadsheetData.cells).flat().filter(Boolean).join(", ").slice(0, 3000)
        : "";

      if (!bulkImport) {
        describeVaultItemInBackground(noteId, {
          imageUrl: (fileType === "image" || fileType === "video") ? fileUrl || undefined : undefined,
          textContent: extractedText || ssText || undefined,
          fileType,
          fileName: filename,
        });
      }

      afterVaultNoteSaved(userId, noteId, {
        title: createdNote?.title || filename,
        content: createdNote?.content || "",
        extraPlain: extractedText || ssText || undefined,
        bulkImport,
      });
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[uploadPipeline] post-processing failed:", err);
      }
    }
  })();
}

async function resolveVaultCount(
  userId: string,
  hint: number | null | undefined,
): Promise<number> {
  if (typeof hint === "number" && Number.isFinite(hint)) return Math.max(0, hint);
  const { count } = await supabase
    .from("vault_items")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  return count ?? 0;
}

type VaultSlotState = {
  remaining: number | null;
};

function takeVaultSlot(state: VaultSlotState | null | undefined): boolean {
  if (!state || state.remaining === null) return true;
  if (state.remaining <= 0) return false;
  state.remaining -= 1;
  return true;
}

// ---------------------------------------------------------------------------
// Video poster fallback
//
// When a video's full upload fails — most commonly because the original bytes
// exceed the Supabase project-wide file-size limit (the TUS "create upload"
// POST is rejected before any chunk flows), or because the .mov holds a codec
// we couldn't transcode — we don't want the user to lose the drop entirely.
// Instead we capture a single poster frame, encode it as a small JPEG (well
// under the 6 MiB TUS threshold, so it goes via the reliable single-shot path),
// and save THAT thumbnail to the vault as an image. The user keeps a visual
// record of the clip even though the playable video didn't make it.
//
// Best-effort: if we can't decode a frame (e.g. an HEVC .mov on a browser that
// can't render it), we return null and the caller surfaces the original error.
// ---------------------------------------------------------------------------
async function saveVideoPosterFallback(args: {
  userId: string;
  itemId: string;
  file: File;
  filename: string;
  folderPath: string | null;
  onFileComplete?: (note: { id: string; [key: string]: unknown }) => void;
  onNoteCreated?: () => void;
}): Promise<{ id: string } | null> {
  const store = useVaultUploadStore.getState();

  // Capture a poster frame. `medium` (≤1280px) is the nicer preview; fall back
  // to the tiny `thumb` if the medium encode didn't materialize.
  let poster: Blob | null = null;
  let posterWidth: number | null = null;
  let posterHeight: number | null = null;
  try {
    const variants = await generateMediaVariants(args.file, "video");
    poster = variants.medium || variants.thumb;
    posterWidth = variants.width;
    posterHeight = variants.height;
  } catch {
    return null;
  }
  if (!poster) return null;

  const fileId = crypto.randomUUID();
  const posterPath = `${args.userId}/${fileId}/poster.jpg`;
  setVaultUploadStoragePath(args.itemId, posterPath, "user-files");
  void beginUploadLedger(args.userId, posterPath, "user-files");

  let uploadResult;
  try {
    uploadResult = await uploadFileToStorage({
      file: poster,
      userId: args.userId,
      storagePath: posterPath,
      bucket: "user-files",
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: true,
    });
  } catch {
    void clearUploadLedger(posterPath);
    return null;
  }

  const fileUrl = uploadResult.signedUrl || uploadResult.publicUrl || null;
  if (!fileUrl) {
    void supabase.storage.from("user-files").remove([posterPath]).catch(() => {});
    void clearUploadLedger(posterPath);
    return null;
  }

  // Keep the visual association with the original clip in the title, but save
  // it as an image so the vault renders the JPEG (not a broken <video>).
  const baseName = args.filename.replace(/\.[^/.]+$/, "") || args.filename;
  const posterName = `${baseName} (video preview).jpg`;

  let createdNote: any = null;
  try {
    createdNote = await createVaultNote({
      userId: args.userId,
      filename: posterName,
      folderPath: args.folderPath,
      fileType: "image",
      fileUrl,
      storagePath: posterPath,
      storageBucket: "user-files",
      fileSize: poster.size,
      mimeType: "image/jpeg",
      width: posterWidth,
      height: posterHeight,
    });
  } catch {
    // Cap / rate-limit / RLS — clean up the orphaned poster and bail; the
    // caller's catch will surface the appropriate user-facing error.
    void supabase.storage.from("user-files").remove([posterPath]).catch(() => {});
    void clearUploadLedger(posterPath);
    return null;
  }

  if (!createdNote?.id) {
    void supabase.storage.from("user-files").remove([posterPath]).catch(() => {});
    void clearUploadLedger(posterPath);
    return null;
  }

  // Same commit point as the main path: take the item out of the
  // cancellation registry the instant the poster row lands, and roll back
  // both if the user cancelled during the insert.
  if (!commitVaultUpload(args.itemId)) {
    try {
      await supabase
        .from("vault_items")
        .delete()
        .eq("id", createdNote.id)
        .eq("user_id", args.userId);
    } catch {
      /* best-effort — reconciler will catch any remnant */
    }
    void supabase.storage.from("user-files").remove([posterPath]).catch(() => {});
    void clearUploadLedger(posterPath);
    return null;
  }

  // Committed: clear the in-flight ledger row for the poster.
  void clearUploadLedger(posterPath);

  recordUpload();
  args.onNoteCreated?.();

  store.update(args.itemId, {
    progress: 100,
    status: "completed",
    noteId: createdNote.id,
  });

  if (args.onFileComplete) {
    try {
      args.onFileComplete(createdNote as { id: string });
    } catch {
      /* non-fatal */
    }
  }

  return createdNote;
}

async function processOne(args: {
  userId: string;
  itemId: string;
  file: File;
  folderPath: string | null;
  filename: string;
  planId?: PlanId | null;
  bulkImport?: boolean;
  vaultSlots?: VaultSlotState | null;
  onFileComplete?: (note: { id: string; [key: string]: unknown }) => void;
  onNoteCreated?: () => void;
  onVariantsReady?: (
    noteId: string,
    variants: { variantThumbPath?: string; variantMediumPath?: string },
  ) => void;
}): Promise<{ id: string } | null> {
  const { userId } = args;
  let { file, filename } = args;
  const store = useVaultUploadStore.getState();
  const fileType = getFileType(file.type, filename);

  // Per-item AbortController. Wired through:
  //   - awaitRateLimitSlot (so cancellation interrupts the pacing wait)
  //   - uploadFileToStorage (so TUS calls .abort() and we don't keep
  //     pushing chunks to a doomed object)
  //   - the cancellation registry (so vaultUploadStore.remove/clearAll
  //     can trigger us from outside the pipeline).
  const abortCtrl = new AbortController();
  registerVaultUploadCancellation(args.itemId, abortCtrl);

  // Upload-ledger bookkeeping (migration 112). `ledgerStoragePath` is set once
  // we record an in-flight upload; `ledgerCommitted` flips at the commit point.
  // The finally clears any still-pending ledger row so a failed/aborted upload
  // never leaves a stale 'uploading' marker for the reconciler to chase.
  let ledgerStoragePath: string | null = null;
  let ledgerCommitted = false;

  // ── Vault headroom (before HEIF decode / compression) ───────────
  if (!takeVaultSlot(args.vaultSlots)) {
    store.update(args.itemId, {
      status: "error",
      error: "Vault is full — upgrade your plan to save more.",
    });
    notifyVaultCapIfApplicable({ message: "vault_cap_reached" });
    unregisterVaultUploadCancellation(args.itemId);
    return null;
  }

  // ── HEIF → JPEG ─────────────────────────────────────────────────────
  const nameLower = filename.toLowerCase();
  const mimeLower = (file.type || "").toLowerCase();
  const isHeif =
    nameLower.endsWith(".heic") ||
    nameLower.endsWith(".heif") ||
    mimeLower.startsWith("image/heic") ||
    mimeLower.startsWith("image/heif");
  if (isHeif) {
    if (abortCtrl.signal.aborted) {
      // The user dismissed the toast before we got off the starting line.
      // Skip the work entirely — no storage object exists yet so there's
      // nothing to clean up.
      unregisterVaultUploadCancellation(args.itemId);
      return null;
    }
    try {
      const { fileToDisplayableFile } = await import("@/lib/heifToJpeg");
      const displayable = await fileToDisplayableFile(file);
      // Recheck after the (potentially seconds-long) HEIF decode — same
      // reasoning as below.
      if (abortCtrl.signal.aborted) {
        unregisterVaultUploadCancellation(args.itemId);
        return null;
      }
      if (displayable !== file) {
        file = displayable;
        filename = displayable.name;
      } else {
        // The converter declined to swap the file (browser doesn't
        // support HEIF decoding via libheif fall-through). Surface a
        // clear error rather than silently uploading the .heic that
        // most non-Apple browsers won't be able to render later.
        store.update(args.itemId, {
          status: "error",
          error: "This browser can't preview HEIC images. Convert to JPEG and try again.",
        });
        unregisterVaultUploadCancellation(args.itemId);
        return null;
      }
    } catch (e) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[uploadPipeline] HEIF conversion failed:", e);
      }
      store.update(args.itemId, {
        status: "error",
        error: "Couldn't convert HEIC image — try saving it as JPEG first.",
      });
      unregisterVaultUploadCancellation(args.itemId);
      return null;
    }
  }

  try {
    // ── Rate-limit gate ───────────────────────────────────────────────
    // Pace out big batches so we don't hammer the 033 trigger. Status is
    // "pending" until a slot opens, so the toast shows "Waiting…" rather
    // than spinning on a doomed compression job.
    await awaitRateLimitSlot(args.planId, abortCtrl.signal);

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
      // Compression occupies the 0-50 sub-range and the upload phase
      // owns 50-95. Without these explicit sub-ranges the progress
      // bar visibly snapped backward at the compression→upload
      // handoff (compression hit 100, then upload reset to 1) which
      // looked like a stalled / restarting upload to users.
      const compressResult = await maybeCompressMedia(
        file,
        ({ percent }) => {
          const scaled = Math.min(50, Math.max(0, Math.round(percent * 0.5)));
          store.update(args.itemId, { progress: scaled });
        },
        // Cancellation during a long ffmpeg / WebCodecs encode used to
        // run to completion before the upload phase even started; now
        // we tear down promptly when the user dismisses.
        abortCtrl.signal,
      );
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
    // Upload owns 50-95. If we skipped compression we still resume from
    // 50 instead of 1 so the bar visibly progresses.
    store.update(args.itemId, { status: "uploading", progress: 50 });

    const fileId = crypto.randomUUID();
    const fileExt = filename.split(".").pop() || "bin";
    const storagePath = `${userId}/${fileId}/original.${fileExt}`;
    // Tell the cancellation registry which path we're writing to so
    // dismissing the upload mid-flight can best-effort delete the
    // partial object instead of leaking bytes.
    setVaultUploadStoragePath(args.itemId, storagePath, "user-files");

    // Record the in-flight upload BEFORE pushing bytes, so a crash/tab-close
    // between here and the row insert leaves a reapable trail. Best-effort and
    // fire-and-forget — it must not delay the upload or break it pre-migration.
    ledgerStoragePath = storagePath;
    void beginUploadLedger(userId, storagePath, "user-files");

    let lastRenderedPct = 50;
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
        signal: abortCtrl.signal,
        onProgress: (pct: number) => {
          // Map the 0-100 storage progress into our 50-95 sub-range
          // so the bar advances smoothly past the compression handoff.
          const scaled = Math.min(95, Math.max(50, 50 + Math.round(pct * 0.45)));
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

    // Race window: the bytes are now in storage but the row doesn't
    // exist yet. If the user cancelled during the upload tail (or while
    // we were minting URLs), insert a row only to immediately have the
    // user see a "ghost" note. Recheck the signal here and clean up the
    // freshly-uploaded object instead.
    if (abortCtrl.signal.aborted) {
      void supabase.storage.from("user-files").remove([storagePath]).catch(() => {});
      throw new DOMException("Aborted", "AbortError");
    }

    // Probe intrinsic dimensions on the FINAL (post-compression) file so the
    // stored ratio matches the bytes the grid will actually render. Best-
    // effort and bounded — a slow/failed decode just omits dims rather than
    // holding up the note insert.
    let mediaDims: { width: number; height: number; durationSeconds?: number } | null = null;
    if (fileType === "image" || fileType === "video") {
      mediaDims = await Promise.race([
        probeMediaDimensions(file, fileType),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
    }

    let createdNote: any = null;
    try {
      createdNote = await createVaultNote({
        userId,
        filename,
        folderPath: args.folderPath,
        fileType,
        fileUrl,
        storagePath,
        storageBucket: "user-files",
        fileSize: file.size,
        mimeType: file.type,
        width: mediaDims?.width ?? null,
        height: mediaDims?.height ?? null,
        durationSeconds: mediaDims?.durationSeconds ?? null,
      });
    } catch (createError) {
      // Trigger-raised errors propagate so the catch below can route them
      // through the right user-facing flow (rate-limit / vault-cap modal).
      // Best-effort delete the freshly-uploaded object before re-throwing so
      // we don't leave orphan files in storage when the DB rejects the row.
      void supabase.storage.from("user-files").remove([storagePath]).catch(() => {});
      throw createError;
    }

    if (!createdNote?.id) {
      // The insert returned `null` (a non-trigger DB error: RLS, missing
      // column, schema mismatch). Don't pretend the upload succeeded —
      // mark error, don't burn a rate-limit slot, and clean up storage.
      void supabase.storage.from("user-files").remove([storagePath]).catch(() => {});
      store.update(args.itemId, {
        status: "error",
        error: "Upload finished but couldn't save to your vault. Please try again.",
      });
      return null;
    }

    // ── Commit point ──────────────────────────────────────────────────
    // The file and the row both exist now. Atomically (synchronously, no
    // await in between) take the item out of the cancellation registry so
    // any *later* dismiss/clearAll is a guaranteed no-op and can't delete
    // the file out from under this committed row. If this returns false the
    // user cancelled during/just before the insert, so we roll back BOTH —
    // row first (worst case is a leaked file the reconciler reaps; the
    // reverse would recreate the dangling-row bug we're fixing).
    if (!commitVaultUpload(args.itemId)) {
      try {
        await supabase
          .from("vault_items")
          .delete()
          .eq("id", createdNote.id)
          .eq("user_id", userId);
      } catch {
        /* best-effort — reconciler will catch any remnant */
      }
      void supabase.storage.from("user-files").remove([storagePath]).catch(() => {});
      throw new DOMException("Aborted", "AbortError");
    }

    // Committed: clear the in-flight ledger row so the reconciler never reaps
    // this now-durable upload.
    ledgerCommitted = true;
    void clearUploadLedger(storagePath);

    // Record after the insert succeeds (the DB trigger is authoritative,
    // but we want our rolling window to reflect reality).
    recordUpload();
    args.onNoteCreated?.();

    store.update(args.itemId, {
      progress: 100,
      status: "completed",
      noteId: createdNote.id,
    });

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
      storagePath,
      createdNote,
      bulkImport: args.bulkImport,
      onVariantsReady: args.onVariantsReady,
    });

    return createdNote;
  } catch (error: any) {
    // User dismissed the toast (or called clearAll) while we were
    // uploading. Don't surface this as an "upload failed" — the user
    // already removed the item from the store, so the item update is
    // best-effort and largely a no-op.
    const isAbort =
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR" ||
      String(error?.message || "").toLowerCase().includes("aborted");
    if (isAbort) {
      // Best-effort: if the item is somehow still in the store, mark
      // it errored with a "Cancelled" message so the user knows what
      // happened. The cancellation cleanup of partial storage objects
      // is handled by `cancelVaultUpload` itself.
      store.update(args.itemId, { status: "error", error: "Cancelled." });
      return null;
    }

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

    // Trigger-raised vault-cap and rate-limit errors look like generic
    // PG check_violations to supabase-js. Detect them first so the shared
    // helpers can dispatch the events `useUsageGate` listens to (which
    // open the upgrade modal), instead of showing a generic toast.
    let didNotifyExternally = false;
    const isCapError = notifyVaultCapIfApplicable(error);
    const isRateLimitError = !isCapError && notifyUploadRateLimitIfApplicable(error);

    // ── Video poster fallback ─────────────────────────────────────────
    // The full video couldn't be uploaded (commonly: the original bytes
    // exceed the storage project's file-size limit, so the TUS "create
    // upload" POST is rejected). Rather than lose the drop entirely, save a
    // poster-frame thumbnail so the user keeps a visual record. We skip this
    // for cap / rate-limit failures — those would just reject the poster too
    // and the upgrade modal is the right surface for them.
    if (!isCapError && !isRateLimitError && fileType === "video") {
      try {
        const poster = await saveVideoPosterFallback({
          userId,
          itemId: args.itemId,
          file,
          filename,
          folderPath: args.folderPath,
          onFileComplete: args.onFileComplete,
          onNoteCreated: args.onNoteCreated,
        });
        if (poster?.id) {
          try {
            toast({
              title: "Saved a video preview",
              description: `${args.filename ? `${args.filename}: ` : ""}couldn't upload the full video, so we saved a thumbnail instead.`,
            });
          } catch {
            /* toast unavailable */
          }
          return poster;
        }
      } catch (fallbackErr) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[uploadPipeline] video poster fallback failed:", fallbackErr);
        }
      }
    }

    if (isCapError) {
      friendly = "Vault is full — upgrade your plan to keep uploading.";
      didNotifyExternally = true;
    } else if (isRateLimitError) {
      friendly = "Upload paused — you're uploading too fast. Try again in a moment.";
      didNotifyExternally = true;
    } else if (lower.includes("exceeded the maximum allowed size") || lower.includes("payload too large") || lower.includes("413")) {
      friendly = `File too large — max ${formatBytesShort(VAULT_UPLOAD_LIMITS.maxFileBytes)} per file.`;
    } else if (lower.includes("mime") && lower.includes("not allowed")) {
      friendly = "This file type is blocked by the storage bucket settings.";
    } else if (lower.includes("bucket not found")) {
      friendly = "Storage bucket 'user-files' is missing. Create it in Supabase Storage.";
    } else if (lower.includes("creating upload") || (lower.includes("tus") && lower.includes("unexpected response"))) {
      // The TUS create POST was rejected before any bytes flowed — almost
      // always the storage project's max-file-size limit. Point the user at
      // the actionable cause instead of echoing the raw tus error.
      friendly = "Video too large to upload — it exceeds your storage size limit.";
    } else if (rawMsg) {
      friendly = `Upload failed: ${String(rawMsg).slice(0, 160)}`;
    }
    store.update(args.itemId, { status: "error", error: friendly });

    // The persistent upload-progress toast is no longer rendered (uploads
    // are silent by design — see comment in `App.jsx`). That means a
    // generic failure would otherwise just make the optimistic ghost
    // card vanish from the grid with no explanation. Surface the
    // friendly error via the global toast system so the user always
    // knows when a drop didn't make it. We skip this if the error
    // already triggered an external notification (cap/rate-limit) so
    // we don't double-toast on top of the upgrade modal.
    if (!didNotifyExternally) {
      try {
        toast({
          title: "Upload failed",
          description: `${args.filename ? `${args.filename}: ` : ""}${friendly}`,
          variant: "destructive",
        });
      } catch {
        // Toast subsystem unavailable (e.g. very early during boot).
        // The store still has the error state, so a future surface
        // (Activity panel, etc.) can pick it up.
      }
    }
    return null;
  } finally {
    // Always release the per-item entry so we don't leak controllers if
    // the upload finishes naturally (most of the time) — or if it
    // errored for any non-cancellation reason.
    unregisterVaultUploadCancellation(args.itemId);
    // If we recorded an in-flight ledger row but never reached the commit
    // point (error / abort / fallback path), clear the bookkeeping now. Any
    // actual orphaned bytes were already removed by the failing branch (or, on
    // a hard crash where this never runs, get reaped by the reconciler).
    if (ledgerStoragePath && !ledgerCommitted) {
      void clearUploadLedger(ledgerStoragePath);
    }
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

  if (!input.files.length) return;

  const vaultCount = await resolveVaultCount(input.userId, input.vaultCount);
  const preflight = preflightVaultUploadBatch(
    input.files,
    input.planId ?? null,
    vaultCount,
  );

  const rejectionSummary = summarizePreflightRejections(preflight.rejected);
  if (rejectionSummary) {
    try {
      toast({
        title: preflight.accepted.length > 0 ? "Some files skipped" : "Upload blocked",
        description: rejectionSummary,
        variant: preflight.accepted.length > 0 ? "default" : "destructive",
      });
    } catch {
      /* toast unavailable */
    }
  }

  if (!preflight.accepted.length) {
    if (preflight.remainingSlots === 0) {
      notifyVaultCapIfApplicable({ message: "vault_cap_reached" });
    }
    return;
  }

  if (preflight.isBulkImport) {
    try {
      toast({
        title: `Uploading ${preflight.accepted.length} files`,
        description:
          "Large import — skipping per-file AI descriptions until this batch finishes. Files still save normally.",
      });
    } catch {
      /* toast unavailable */
    }
  }

  const vaultSlots: VaultSlotState = {
    remaining: preflight.remainingSlots,
  };

  const enqueued: Array<{
    itemId: string;
    file: File;
    folderPath: string | null;
    filename: string;
    dedupKey: string;
  }> = [];

  // Budget for optimistic ghost previews shared across the whole batch.
  // Decremented each time we mint an object URL; once exhausted, remaining
  // files upload without a ghost card (they appear when their note lands).
  let previewBudget = MAX_OPTIMISTIC_PREVIEWS;

  for (const entry of preflight.accepted) {
    // Skip files already mid-flight in this session. Without this the
    // user could drop the same image twice (because the toast was slow
    // to render, or they second-guessed) and end up with two identical
    // notes after the second upload finished.
    const dedupKey = inFlightDedupKey(input.userId, entry.file, entry.filename);
    if (inFlightDedup.has(dedupKey)) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.info(
          `[uploadPipeline] skipping duplicate in-flight upload: ${entry.filename}`,
        );
      }
      continue;
    }
    inFlightDedup.add(dedupKey);

    const itemId = crypto.randomUUID();
    const mimeType = entry.file.type || "";
    const fileType = getFileType(mimeType, entry.filename);
    // Create an optimistic preview for both normal AND bulk imports — the
    // big drop is exactly when the user most needs instant visual feedback.
    // Bounded by previewBudget so a 200-file drop stays memory-safe.
    let previewUrl: string | null = null;
    if (canPreview(fileType) && previewBudget > 0) {
      try {
        previewUrl = URL.createObjectURL(entry.file);
        previewBudget -= 1;
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
      dedupKey,
    });
  }

  const createdNotes: Array<{ id: string }> = [];
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < enqueued.length) {
      const currentIndex = cursor;
      cursor += 1;
      const job = enqueued[currentIndex];
      try {
        const created = await processOne({
          userId: input.userId,
          itemId: job.itemId,
          file: job.file,
          folderPath: job.folderPath,
          filename: job.filename,
          planId: input.planId ?? null,
          bulkImport: preflight.isBulkImport,
          vaultSlots,
          onFileComplete: input.onFileComplete,
          onNoteCreated: input.onNoteCreated,
          onVariantsReady: input.onVariantsReady,
        });
        if (created?.id) createdNotes.push(created);
      } finally {
        // Release the dedup slot whether the upload succeeded, errored,
        // or was cancelled — otherwise a failed upload would lock the
        // user out of re-trying that exact file for the rest of the tab
        // session.
        inFlightDedup.delete(job.dedupKey);
      }
    }
  };
  const workerCount = Math.min(UPLOAD_PARALLELISM, enqueued.length);
  const workers = Array.from({ length: workerCount }, () => runNext());
  await Promise.all(workers);

  if (preflight.isBulkImport && createdNotes.length > 0) {
    try {
      const { invalidateWorkspaceSummaryCache } = await import("@/lib/workspaceContext");
      const { useAiStore } = await import("@/store/aiStore");
      invalidateWorkspaceSummaryCache(input.userId);
      void useAiStore.getState().refreshWorkspaceSummary(input.userId, undefined, { force: true });
    } catch {
      /* best-effort batch refresh */
    }
  }

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
