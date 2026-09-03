/**
 * Image Gen tiles for the Home vault widget.
 *
 * The widget shows the same Image Gen folder as AI Drive, from whichever
 * vault backend is active. Local blobs resolve immediately; cloud rows are
 * signed the same way the Vault grid signs them, so a generated image that
 * lives in the cloud vault still appears on the Home tile.
 */

import type { VaultItem } from "@/lib/types/vault";
import { isAiGeneratedVaultRow } from "@/lib/vault/aiDriveContents";
import { parseAttachmentsFromNote } from "@/lib/vault/attachmentsMarker";
import { looksLikeImageAttachment, resolveRenderType } from "@/lib/vault/attachmentType";
import { parseStorageTarget } from "@/lib/vault/vaultCardHelpers";
import {
  isLocalBlobUrl,
  isLocalTarget,
  localBlobUrl,
  resolveVaultMediaUrl,
  type StorageTarget,
} from "@/lib/vault/repository/mediaUrl";
import { LOCAL_BUCKET } from "@/lib/vault/repository/types";

export const AI_DRIVE_WIDGET_QUERY_KEY = "studio-vault-widget";

export interface LocalAiDriveImage {
  id: string;
  title: string;
  att_type: "image";
  thumb: string;
}

export interface AiDriveImageCandidate {
  id: string;
  title: string;
  att_type: "image";
  /** A URL that can already be drawn, if we have one. */
  thumb: string | null;
  /** Cloud object to sign when `thumb` is missing or only a stale preview. */
  signTarget: StorageTarget | null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function httpUrl(value: unknown): string | null {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

function isImageAttachment(att: Record<string, unknown>): boolean {
  return resolveRenderType(att) === "image" || looksLikeImageAttachment(att);
}

/** A display URL only when the bytes are already on this device. */
export function localAiDriveImageThumb(
  row: {
    storage_bucket?: unknown;
    storage_path?: unknown;
    variant_thumb_path?: unknown;
    variant_medium_path?: unknown;
    attachment_preview?: unknown;
    url?: unknown;
  },
  att: Record<string, unknown> | null | undefined = null,
): string | null {
  const preview = asRecord(row.attachment_preview) || asRecord(att?.preview);
  const blobUrl = firstString(
    att?.url,
    att?.image,
    att?.thumbnail_url,
    preview?.image,
    preview?.thumbnail_url,
    row.url,
  );
  if (isLocalBlobUrl(blobUrl)) return blobUrl;

  const attPath = firstString(
    att?.variantThumbPath,
    att?.variant_thumb_path,
    att?.variantMediumPath,
    att?.variant_medium_path,
    att?.storagePath,
    att?.storage_path,
  );
  const attBucket = firstString(att?.storageBucket, att?.storage_bucket);
  const rowBucket = firstString(row.storage_bucket);
  // Attachment JSON sometimes omits the bucket; a local row still owns the
  // path. An explicit cloud bucket on the attachment is ignored in favor of
  // the row's on-disk copy when one exists.
  if (attPath && (attBucket === LOCAL_BUCKET || (!attBucket && rowBucket === LOCAL_BUCKET))) {
    const target = { bucket: LOCAL_BUCKET, path: attPath };
    if (isLocalTarget(target)) return localBlobUrl(attPath);
  }

  const rowPath = firstString(
    row.variant_thumb_path,
    row.variant_medium_path,
    row.storage_path,
  );
  const target = { bucket: rowBucket, path: rowPath };
  if (!isLocalTarget(target)) return null;
  return localBlobUrl(rowPath);
}

function cloudSignTarget(
  row: {
    storage_bucket?: unknown;
    storage_path?: unknown;
    variant_thumb_path?: unknown;
    variant_medium_path?: unknown;
  },
  att: Record<string, unknown> | null | undefined,
): StorageTarget | null {
  const fromAtt = att ? parseStorageTarget(att, "thumb") : null;
  if (fromAtt?.path && !isLocalTarget(fromAtt)) return fromAtt;

  const rowPath = firstString(
    row.variant_thumb_path,
    row.variant_medium_path,
    row.storage_path,
  );
  if (!rowPath) return null;
  const bucket = firstString(row.storage_bucket) || "user-files";
  const target = { bucket, path: rowPath };
  return isLocalTarget(target) ? null : target;
}

function imageAttachmentsFor(row: VaultItem): Record<string, unknown>[] {
  const attachments = parseAttachmentsFromNote(row) as Record<string, unknown>[];
  const imageAtts = attachments.filter(isImageAttachment);
  if (!imageAtts.length && String(row.att_type || "") === "image") {
    imageAtts.push({});
  }
  return imageAtts;
}

/** Newest Image Gen cards from rows the caller already holds, local or cloud. */
export function collectAiDriveImageCandidates(
  rows: VaultItem[],
  limit = 18,
): AiDriveImageCandidate[] {
  const items: AiDriveImageCandidate[] = [];
  const cap = Math.max(0, Number(limit) || 0);

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || (row as { trashed?: unknown }).trashed) continue;
    if (!isAiGeneratedVaultRow(row, row.source, row.tags)) continue;

    for (const att of imageAttachmentsFor(row)) {
      if (items.length >= cap) return items;
      const localThumb = localAiDriveImageThumb(row, att);
      const signTarget = localThumb ? null : cloudSignTarget(row, att);
      const fallback = httpUrl(
        firstString(att?.thumbnail_url, att?.image, att?.url, row.url),
      );
      if (!localThumb && !signTarget && !fallback) continue;
      items.push({
        id: String(row.id || ""),
        title: firstString(att?.name, att?.title, row.title) || "Untitled",
        att_type: "image",
        thumb: localThumb || fallback,
        signTarget,
      });
    }
    if (items.length >= cap) break;
  }

  return items;
}

/** Newest local Image Gen cards from rows the caller already holds. */
export function collectLocalAiDriveImages(
  rows: VaultItem[],
  limit = 18,
): LocalAiDriveImage[] {
  const items: LocalAiDriveImage[] = [];
  const cap = Math.max(0, Number(limit) || 0);

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || (row as { trashed?: unknown }).trashed) continue;
    if (!isAiGeneratedVaultRow(row, row.source, row.tags)) continue;

    for (const att of imageAttachmentsFor(row)) {
      if (items.length >= cap) return items;
      const thumb = localAiDriveImageThumb(row, att);
      if (!thumb) continue;
      items.push({
        id: String(row.id || ""),
        title: firstString(att?.name, att?.title, row.title) || "Untitled",
        att_type: "image",
        thumb,
      });
    }
    if (items.length >= cap) break;
  }

  return items;
}

async function signCloudUrl(target: StorageTarget): Promise<string | null> {
  const bucket = String(target.bucket || "user-files").trim() || "user-files";
  const path = String(target.path || "").trim();
  if (!path) return null;
  try {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
    return data?.signedUrl || null;
  } catch {
    return null;
  }
}

async function resolveCandidateThumb(candidate: AiDriveImageCandidate): Promise<string | null> {
  if (candidate.thumb && isLocalBlobUrl(candidate.thumb)) return candidate.thumb;
  if (candidate.signTarget?.path) {
    const signed = await resolveVaultMediaUrl(candidate.signTarget, signCloudUrl);
    if (signed) return signed;
  }
  return candidate.thumb;
}

/** Scan the active vault for Image Gen tiles. Empty when signed out. */
export async function listAiDriveImages(
  userId: string | null | undefined,
  limit = 18,
): Promise<LocalAiDriveImage[]> {
  if (!userId) return [];
  const { getVaultRepository } = await import("@/lib/vault/repository");
  const repository = getVaultRepository(userId);
  const items: LocalAiDriveImage[] = [];
  let cursor = null as Awaited<ReturnType<typeof repository.listPage>>["nextCursor"];

  for (let page = 0; page < 8 && items.length < limit; page += 1) {
    const next = await repository.listPage({ cursor, limit: 50 });
    const need = limit - items.length;
    // Ask for extra candidates so a failed sign does not leave the strip short.
    const candidates = collectAiDriveImageCandidates(next.rows || [], need + 8);
    for (const candidate of candidates) {
      if (items.length >= limit) break;
      const thumb = await resolveCandidateThumb(candidate);
      if (!thumb) continue;
      items.push({
        id: candidate.id,
        title: candidate.title,
        att_type: "image",
        thumb,
      });
    }
    cursor = next.nextCursor;
    if (!cursor) break;
  }

  return items;
}
