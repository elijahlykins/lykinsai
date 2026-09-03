import { supabase } from "@/lib/supabase";
import { saveFileToVault, type SaveToVaultResult } from "@/lib/saveToVault";
import {
  LOCAL_BUCKET,
  isLocalVaultEnabled,
} from "@/lib/vault/repository";
import { writeLocalBlob } from "@/lib/vault/repository/localBlobs";
import {
  WRITTEN_DOCUMENT_FOLDER,
  WRITTEN_DOCUMENT_SOURCE,
  WRITTEN_DOCUMENT_TAGS,
  writtenDocumentFilename,
  writtenDocumentLockKey,
} from "@/lib/vault/writtenDocumentFiling";

export type SaveWrittenDocumentResult =
  | { ok: true; id: string }
  | { ok: false; reason: "unsigned" | "empty" | "duplicate" | "error"; message?: string };

function claimLock(key: string): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
    return true;
  } catch {
    return true;
  }
}

function releaseLock(key: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

async function resolveUserId(explicit?: string | null): Promise<string> {
  const given = String(explicit || "").trim();
  if (given) return given;
  try {
    const { data } = await supabase.auth.getSession();
    return String(data?.session?.user?.id || "").trim();
  } catch {
    return "";
  }
}

function htmlAsPlainText(html: string): string {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

/**
 * Persist a written HTML document into the vault the UI actually reads,
 * filed under AI Drive / Docs. Downloads stay a separate machine copy.
 */
export async function saveWrittenDocumentToDrive(opts: {
  userId?: string | null;
  title?: string;
  html?: string;
  filename?: string;
}): Promise<SaveWrittenDocumentResult> {
  const html = String(opts.html || "");
  if (!html.trim()) return { ok: false, reason: "empty" };

  const userId = await resolveUserId(opts.userId);
  if (!userId) return { ok: false, reason: "unsigned" };

  const title = String(opts.title || "").trim() || "Document";
  const filename = writtenDocumentFilename(title, opts.filename);
  const lockKey = writtenDocumentLockKey(filename, html);
  if (!claimLock(lockKey)) return { ok: false, reason: "duplicate" };

  try {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    let noteId: string | undefined;
    let storagePath: string;
    let storageBucket: string;
    let fileUrl: string;

    if (isLocalVaultEnabled()) {
      noteId = crypto.randomUUID();
      const written = await writeLocalBlob(noteId, blob, {
        filename,
        mimeType: "text/html",
        variant: "original",
      });
      storagePath = written.path;
      storageBucket = LOCAL_BUCKET;
      fileUrl = written.url;
    } else {
      const fileId = crypto.randomUUID();
      storagePath = `${userId}/${fileId}/artifact.html`;
      storageBucket = "user-files";
      const { error: uploadError } = await supabase.storage
        .from("user-files")
        .upload(storagePath, blob, {
          cacheControl: "3600",
          upsert: false,
          contentType: "text/html;charset=utf-8",
        });
      if (uploadError) {
        releaseLock(lockKey);
        return {
          ok: false,
          reason: "error",
          message: uploadError.message || "Couldn't upload the document.",
        };
      }
      const { data: signedData } = await supabase.storage
        .from("user-files")
        .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
      fileUrl = signedData?.signedUrl || "";
    }

    const result: SaveToVaultResult = await saveFileToVault({
      userId,
      filename,
      fileType: "html",
      fileUrl,
      noteId,
      storagePath,
      storageBucket,
      fileSize: blob.size,
      mimeType: "text/html;charset=utf-8",
      source: WRITTEN_DOCUMENT_SOURCE,
      folder: WRITTEN_DOCUMENT_FOLDER,
      tags: [...WRITTEN_DOCUMENT_TAGS],
      contentPrefix: title,
      extractedText: htmlAsPlainText(html),
    });

    if (!result.ok) {
      if (result.reason !== "duplicate") releaseLock(lockKey);
      return {
        ok: false,
        reason: result.reason === "duplicate" ? "duplicate" : "error",
        message: result.message,
      };
    }

    try {
      const { queryClientInstance } = await import("@/lib/query-client");
      void queryClientInstance.invalidateQueries({ queryKey: ["vault-notes", userId] });
    } catch {
      /* vault will refresh on next visit */
    }

    return { ok: true, id: result.id };
  } catch (err) {
    releaseLock(lockKey);
    const message =
      err && typeof err === "object" && "message" in err
        ? String((err as { message?: unknown }).message || "")
        : String(err || "");
    return { ok: false, reason: "error", message: message || "Couldn't save the document." };
  }
}
