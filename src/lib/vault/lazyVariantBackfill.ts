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
    [key: string]: unknown;
  } | null | undefined;
}

/** Best-effort, fire-and-forget. Never throws. */
export function lazyBackfillCardVariants(args: BackfillArgs): void {
  void run(args).catch(() => {});
}

async function run({ userId, noteId, attachment }: BackfillArgs): Promise<void> {
  if (!userId || !noteId || !attachment) return;
  // Only images for now (cheap, synchronous decode). Video posters are heavier
  // and handled at upload time.
  if (String(attachment.type || "").toLowerCase() !== "image") return;
  if (attachment.variantThumbPath || attachment.variantMediumPath) return;

  const storagePath = String(attachment.storagePath || "").trim();
  if (!storagePath || !storagePath.includes("/")) return;
  const bucket = String(attachment.storageBucket || "user-files").trim() || "user-files";

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

  const file = new File([blob], storagePath.split("/").pop() || "image", {
    type: blob.type || "image/jpeg",
  });
  const variants = await generateMediaVariants(file, "image");
  if (!variants.medium && !variants.thumb) return;

  const dir = storagePath.slice(0, storagePath.lastIndexOf("/") + 1);
  const patch: Record<string, unknown> = {};
  const markerPatch: Record<string, string> = {};

  if (variants.medium) {
    const mediumPath = `${dir}medium.jpg`;
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
    const thumbPath = `${dir}thumb.jpg`;
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
