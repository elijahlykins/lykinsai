/**
 * Open one AI Drive item the same way a click in the drive listing does:
 * a file window in view mode. Written HTML documents open in the LYKN
 * browser so they read as a page, not as source. Chat must not embed the file.
 */

import { supabase } from "@/lib/supabase";
import { parseAttachmentsFromNote } from "@/lib/vault/attachmentsMarker";
import { resolveRenderType } from "@/lib/vault/attachmentType";
import { parseStorageTarget } from "@/lib/vault/vaultCardHelpers";
import { getVaultRepository, LOCAL_BUCKET, resolveVaultMediaUrl } from "@/lib/vault/repository";
import { openFileWindow } from "@/lib/files/fileWindows";
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import { openRenderedDocument } from "@/lib/vault/openRenderedDocument";
import type { FileMedia } from "@/lib/files/fileSource";

const WINDOW_MEDIA: Record<string, FileMedia> = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "pdf",
  html: "html",
};

const LINK_TYPES = new Set(["youtube", "bookmark", "link"]);

async function signCloudUrl(target: { bucket?: string | null; path?: string | null }): Promise<string | null> {
  const bucket = String(target.bucket || "user-files").trim() || "user-files";
  const path = String(target.path || "").trim();
  if (!path) return null;
  try {
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24);
    return data?.signedUrl || null;
  } catch {
    return null;
  }
}

function storageTargetFor(att: Record<string, unknown> | null, row: Record<string, unknown> | null) {
  const fromAtt = att ? parseStorageTarget(att) : null;
  if (fromAtt?.path) return fromAtt;
  const path = String(row?.storage_path || row?.blob_path || "").trim();
  if (!path) return null;
  return {
    bucket: String(row?.storage_bucket || "").trim() || LOCAL_BUCKET,
    path,
  };
}

export async function openAiDriveItem(opts: {
  noteId: string;
  title?: string;
  folder?: string;
  userId?: string | null;
  html?: string | null;
}): Promise<boolean> {
  const noteId = String(opts.noteId || "").trim();
  const givenHtml = typeof opts.html === "string" ? opts.html : "";
  if (!noteId && !givenHtml.trim()) return false;

  let row = null;
  if (noteId) {
    try {
      row = await getVaultRepository(opts.userId).getById(noteId);
    } catch {
      row = null;
    }
  }

  const attachments = parseAttachmentsFromNote(row || {});
  const attachment = (attachments[0] || null) as Record<string, unknown> | null;
  const type = attachment ? resolveRenderType(attachment) : givenHtml ? "html" : "";
  const title =
    String(opts.title || "").trim() ||
    String(attachment?.name || "").trim() ||
    String(row?.title || "").trim() ||
    "File";

  if (type === "html" || givenHtml.trim()) {
    let html = givenHtml;
    let url = "";
    if (!html.trim()) {
      const target = storageTargetFor(attachment, row as Record<string, unknown> | null);
      url = (await resolveVaultMediaUrl(target, signCloudUrl)) || String(attachment?.url || "").trim();
      if (url) {
        try {
          const resp = await fetch(url);
          if (resp.ok) html = await resp.text();
        } catch {
          html = "";
        }
      }
    }
    if (openRenderedDocument({ title, html, url })) return true;
  }

  if (attachment && !LINK_TYPES.has(type)) {
    const att = attachment;
    openFileWindow({
      itemId: noteId,
      name: title,
      mime: String(att.mimeType || att.mime || "") || null,
      media: WINDOW_MEDIA[type] || (opts.folder === "images" ? "image" : null),
      resolveUrl: async () => {
        const target = storageTargetFor(att, row as Record<string, unknown> | null);
        const signed = await resolveVaultMediaUrl(target, signCloudUrl);
        if (signed) return signed;
        return String(att.url || "").trim();
      },
    });
    return true;
  }

  openLyknMediaPop({
    type: "vault-payload",
    payload: {
      ok: true,
      kind: "vault",
      node_id: `vault_${noteId}`,
      note: {
        id: noteId,
        title,
        content: String(row?.content || ""),
      },
    },
  });
  return true;
}
