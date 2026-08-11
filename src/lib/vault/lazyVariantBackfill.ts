/**
 * Lazy, on-view backfill of media variants for EXISTING vault items
 * (Phase 3 of the Vault Normalization Program).
 *
 * New uploads get medium/thumb renditions at upload time. Items saved before
 * Phase 3 have only the original. The first time such an image scrolls into
 * view we generate its variants in the background, upload them, and patch the
 * row (columns + marker) so subsequent views — and other devices — load the
 * small rendition. Best-effort and idempotent: any failure leaves the original
 * working, and an in-memory guard prevents re-processing the same item.
 */
import { supabase } from "@/lib/supabase";
import { generateMediaVariants } from "@/lib/vault/mediaVariants";
import { uploadFileToStorage } from "@/lib/vault/uploadFileToStorage";
import { findAttachmentsMarker, withAttachmentsMarker } from "@/lib/vault/attachmentsMarker";

// Dedupe by storage path so a card rendered repeatedly (scroll, re-mount)
// only triggers one backfill attempt per session.
const attempted = new Set<string>();

interface BackfillArgs {
  userId: string;
  noteId: string;
  /** The primary attachment parsed from the note (marker or columns). */
  attachment: {
    type?: unknown;
    storagePath?: unknown;
    storageBucket?: unknown;
    variantThumbPath?: unknown;
    variantMediumPath?: unknown;
    size?: unknown;
    byteSize?: unknown;
    [key: string]: unknown;
  } | null | undefined;
  /**
   * Called once the poster/variant paths are stored, so the caller can show
   * the thumbnail immediately (used for video cards, which otherwise render a
   * black box). Receives the storage paths that were written.
   */
  onPosterReady?: (info: {
    bucket: string;
    variantThumbPath?: string;
    variantMediumPath?: string;
  }) => void;
}

// Cap how large an existing video we'll re-download just to grab a poster
// frame, so scrolling a vault full of big clips doesn't spew bandwidth.
// Compressed vault videos are typically well under this.
const MAX_VIDEO_BACKFILL_BYTES = 120 * 1024 * 1024;

/** Best-effort, fire-and-forget. Never throws. */
export function lazyBackfillCardVariants(args: BackfillArgs): void {
  void run(args).catch(() => {});
}

async function run({ userId, noteId, attachment, onPosterReady }: BackfillArgs): Promise<void> {
  if (!userId || !noteId || !attachment) return;
  const type = String(attachment.type || "").toLowerCase();
  // Images (cheap decode) and videos (poster frame). Both skip if a variant
  // already exists.
  if (type !== "image" && type !== "video") return;
  if (attachment.variantThumbPath || attachment.variantMediumPath) return;

  const storagePath = String(attachment.storagePath || "").trim();
  if (!storagePath || !storagePath.includes("/")) return;
  const bucket = String(attachment.storageBucket || "user-files").trim() || "user-files";

  // Don't re-download huge originals just for a poster frame.
  if (type === "video") {
    const bytes = Number(attachment.size ?? attachment.byteSize ?? 0);
    if (Number.isFinite(bytes) && bytes > MAX_VIDEO_BACKFILL_BYTES) return;
  }

  const guardKey = `${bucket}:${storagePath}`;
  if (attempted.has(guardKey)) return;
  attempted.add(guardKey);

  // Fetch the original bytes via a short-lived signed URL.
  let blob: Blob;
  try {
    const { data } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 600);
    if (!data?.signedUrl) return;
    const res = await fetch(data.signedUrl);
    if (!res.ok) return;
    blob = await res.blob();
  } catch {
    return;
  }

  const file = new File([blob], storagePath.split("/").pop() || "media", {
    type: blob.type || (type === "video" ? "video/mp4" : "image/jpeg"),
  });
  const variants = await generateMediaVariants(file, type);
  if (!variants.medium && !variants.thumb) return;

  const dir = storagePath.slice(0, storagePath.lastIndexOf("/") + 1);
  // Flat folders (e.g. userId/generated/) must not all write the same
  // medium.jpg — derive unique names from the original file stem. Per-file
  // dirs (userId/{fileId}/) keep the compact medium.jpg / thumb.jpg names.
  const baseName = storagePath.slice(storagePath.lastIndexOf("/") + 1) || "media";
  const stem = baseName.replace(/\.[^.]+$/, "") || "media";
  const sharedDir = /\/generated\/$/i.test(dir) || stem !== "original";
  const mediumName = sharedDir ? `${stem}.medium.jpg` : "medium.jpg";
  const thumbName = sharedDir ? `${stem}.thumb.jpg` : "thumb.jpg";
  const patch: Record<string, unknown> = {};
  const markerPatch: Record<string, string> = {};

  if (variants.medium) {
    const mediumPath = `${dir}${mediumName}`;
    try {
      await uploadFileToStorage({
        file: variants.medium,
        userId,
        storagePath: mediumPath,
        bucket,
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: true,
      });
      patch.variant_medium_path = mediumPath;
      markerPatch.variantMediumPath = mediumPath;
    } catch { /* best-effort */ }
  }
  if (variants.thumb) {
    const thumbPath = `${dir}${thumbName}`;
    try {
      await uploadFileToStorage({
        file: variants.thumb,
        userId,
        storagePath: thumbPath,
        bucket,
        contentType: "image/jpeg",
        cacheControl: "31536000",
        upsert: true,
      });
      patch.variant_thumb_path = thumbPath;
      markerPatch.variantThumbPath = thumbPath;
    } catch { /* best-effort */ }
  }

  if (!Object.keys(patch).length) return;
  await patchNote(userId, noteId, patch, markerPatch);

  // Let the grid show the poster right away (video cards especially, which
  // otherwise stay a black box until reload).
  try {
    onPosterReady?.({
      bucket,
      variantThumbPath: markerPatch.variantThumbPath,
      variantMediumPath: markerPatch.variantMediumPath,
    });
  } catch {
    /* non-fatal */
  }
}

async function patchNote(
  userId: string,
  noteId: string,
  columnPatch: Record<string, unknown>,
  markerPatch: Record<string, string>,
): Promise<void> {
  try {
    const { data: latest } = await supabase
      .from("vault_items")
      .select("content, updated_at")
      .eq("id", noteId)
      .eq("user_id", userId)
      .single();
    const content: string = (latest as any)?.content || "";
    const span = findAttachmentsMarker(content);
    let newContent: string | null = null;
    if (span && span.attachments[0] && typeof span.attachments[0] === "object") {
      const next = span.attachments.slice() as Record<string, unknown>[];
      next[0] = { ...(next[0] as Record<string, unknown>), ...markerPatch };
      newContent = withAttachmentsMarker(content, next);
    }
    const updatedAt = (latest as any)?.updated_at;
    const patch = newContent ? { content: newContent, ...columnPatch } : { ...columnPatch };
    const q = supabase.from("vault_items").update(patch).eq("id", noteId).eq("user_id", userId);
    if (updatedAt) q.eq("updated_at", updatedAt);
    const { error } = await q;
    if (
      error &&
      ((error as any).code === "PGRST204" ||
        /could not find|does not exist/i.test((error as any).message || "")) &&
      newContent
    ) {
      // Columns missing — at least persist the marker (carries variants).
      const q2 = supabase.from("vault_items").update({ content: newContent }).eq("id", noteId).eq("user_id", userId);
      if (updatedAt) q2.eq("updated_at", updatedAt);
      await q2;
    }
  } catch { /* best-effort */ }
}
