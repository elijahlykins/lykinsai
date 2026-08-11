import { supabase } from "@/lib/supabase";
import { detectSocialPlatform, getSocialEmbedLabel } from "@/lib/media/socialEmbed";
import { buildAttachmentColumns } from "@/lib/vault/attachmentType";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { describeVaultItemInBackground } from "@/lib/vault/describeVaultItem";
import {
  isVaultCapError,
  notifyVaultCapIfApplicable,
} from "@/lib/vault/vaultCapError";
import {
  isUploadRateLimitError,
  notifyUploadRateLimitIfApplicable,
} from "@/lib/vault/uploadRateLimitError";

interface SaveFileToVaultOptions {
  userId: string;
  filename: string;
  fileType: string;
  fileUrl: string;
  storagePath?: string;
  storageBucket?: string;
  fileSize: number;
  mimeType?: string;
  projectName?: string;
  extractedText?: string;
  spreadsheetData?: {
    rows: number;
    cols: number;
    cells: Record<string, string[]>;
  } | null;
  /** Override default `project_upload` source (e.g. studio_imagine). */
  source?: string;
  /** Override default `[fileType, "uploaded"]` tags. */
  tags?: string[];
  /** Optional vault folder (e.g. Generated). */
  folder?: string;
  /** Optional prose line before the ATTACHMENTS_JSON marker. */
  contentPrefix?: string;
}

interface SaveLinkToVaultOptions {
  userId: string;
  url: string;
  projectName?: string;
}

/**
 * Discriminated result of a save attempt. The legacy `null` return type
 * collapsed every failure mode (duplicate, vault cap, rate limit, RLS,
 * schema mismatch, network) into the same value, which forced every
 * caller to invent their own heuristic for what to tell the user.
 *
 * All callers must branch on `ok`:
 *   - `ok: true`   → note created, `id` is the new vault note row id
 *   - `ok: false`  → check `reason`:
 *       'duplicate' → silently no-op (file/link already saved)
 *       'cap'       → vault cap modal will already have been opened
 *       'rate'      → rate-limit modal will already have been opened
 *       'error'     → real failure, show `message` to the user
 */
export type SaveToVaultResult =
  | { ok: true; id: string; note: { id: string; title?: string; content?: string } }
  | { ok: false; reason: "duplicate" | "cap" | "rate" | "error"; message?: string };

// ── Dedup caches (survive for the browser session) ──────────────
//
// Keys are added ONLY after a successful insert, so transient errors
// (network, RLS misfire, schema race) do not become permanent dedupes
// for the rest of the session. The previous implementation added the
// key BEFORE attempting the insert, which meant a single failure locked
// the user out of re-saving that filename until the tab was reloaded —
// and also blocked legitimate re-saves of a deleted file.
const fileDedup = new Set<string>();
const linkDedup = new Set<string>();

function fileDedupKey(userId: string, storagePath?: string, filename?: string) {
  return `${userId}::${storagePath || filename || ""}`;
}

function linkDedupKey(userId: string, url: string) {
  return `${userId}::${url}`;
}

/**
 * PostgreSQL `LIKE`/`ILIKE` treats `%` and `_` as wildcards and `\` as
 * the escape character. We embed user-provided filenames and URLs into
 * dedup queries so they MUST be escaped, otherwise:
 *   - `report_2024.pdf` → matches every report-and-then-anything-2024
 *   - `100%-coverage.png` → matches everything that ends in `-coverage.png`
 *   - URLs containing `_` (very common) silently dedupe with unrelated rows
 *
 * Returns the input wrapped with leading/trailing `%` for use as the
 * second argument to `.ilike(column, …)`.
 */
function buildLikePattern(searchTerm: string): string {
  const escaped = String(searchTerm).replace(/[\\%_]/g, "\\$&");
  return `%${escaped}%`;
}

function classifyError(
  err: unknown,
): { reason: "cap" | "rate" | "error"; message: string } {
  if (isVaultCapError(err)) {
    notifyVaultCapIfApplicable(err);
    return { reason: "cap", message: "Vault is full. Upgrade to keep saving." };
  }
  if (isUploadRateLimitError(err)) {
    notifyUploadRateLimitIfApplicable(err);
    return {
      reason: "rate",
      message: "You're saving too fast. Try again in a moment.",
    };
  }
  const msg =
    (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string"
      ? (err as any).message
      : String(err || "")) || "Unknown error";
  return { reason: "error", message: msg };
}

/**
 * Saves a file that was uploaded to Supabase Storage as a vault note.
 * Skips silently if the same file (by storagePath or filename) already exists.
 * Always returns a discriminated result — never throws.
 */
export async function saveFileToVault(
  opts: SaveFileToVaultOptions
): Promise<SaveToVaultResult> {
  const {
    userId,
    filename,
    fileType,
    fileUrl,
    storagePath,
    storageBucket = "user-files",
    fileSize,
    mimeType,
    projectName,
    extractedText,
    spreadsheetData,
    source,
    tags: tagsOverride,
    folder,
    contentPrefix,
  } = opts;

  const dedupKey = fileDedupKey(userId, storagePath, filename);

  try {
    // ── In-memory dedup ──
    if (fileDedup.has(dedupKey)) {
      return { ok: false, reason: "duplicate" };
    }

    // ── DB dedup: check if a vault note for this file already exists ──
    const searchTerm = storagePath || filename;
    const { data: existing } = await supabase
      .from("vault_items")
      .select("id")
      .eq("user_id", userId)
      .ilike("content", buildLikePattern(searchTerm))
      .limit(1);
    if (existing && existing.length > 0) {
      // The DB already has a row matching this file — record it locally
      // so we don't issue another query for the same key in this session.
      fileDedup.add(dedupKey);
      return { ok: false, reason: "duplicate" };
    }

    const noteTitle = filename.replace(/\.[^/.]+$/, "") || filename;
    const fileSizeKB = (fileSize / 1024).toFixed(2);
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    const sizeDisplay =
      fileSize > 1024 * 1024 ? `${fileSizeMB} MB` : `${fileSizeKB} KB`;

    const safeExtractedText = extractedText
      ? String(extractedText).slice(0, 12000)
      : "";

    const attachmentPayload = [
      {
        type: fileType,
        url: fileUrl,
        name: filename,
        storagePath: storagePath || undefined,
        storageBucket: storageBucket || undefined,
        size: fileSize,
        mimeType: mimeType,
        extractedText: safeExtractedText || undefined,
        ...(spreadsheetData
          ? {
              rows: spreadsheetData.rows,
              cols: spreadsheetData.cols,
              cells: spreadsheetData.cells,
            }
          : {}),
      },
    ];

    // Attachment-only body — renderers pull filename/type/url from the
    // JSON payload; no prose line and no storage URL in the body.
    // Optional contentPrefix lets Studio-generated images keep a short caption.
    const prefix = String(contentPrefix || "").trim();
    const noteContent = prefix
      ? `${prefix}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`
      : `[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;

    const tags: string[] = Array.isArray(tagsOverride) && tagsOverride.length
      ? [...tagsOverride]
      : [fileType, "uploaded"];
    if (projectName && !tags.includes(projectName)) tags.push(projectName);

    const richInsert: Record<string, unknown> = {
      user_id: userId,
      title: noteTitle,
      content: noteContent,
      source: source || "project_upload",
      tags,
      ...(folder ? { folder } : {}),
      ...buildAttachmentColumns(attachmentPayload[0]),
    };

    let noteError: any = null;
    let insertedNote: any = null;
    ({ data: insertedNote, error: noteError } = await supabase
      .from("vault_items")
      .insert(richInsert)
      .select("id, title, content, created_at, updated_at")
      .single());

    const missingColumnError =
      noteError &&
      (noteError.code === "PGRST204" ||
        noteError.message?.includes("Could not find") ||
        noteError.message?.toLowerCase().includes("does not exist"));

    if (missingColumnError) {
      ({ data: insertedNote, error: noteError } = await supabase
        .from("vault_items")
        .insert({ user_id: userId, title: noteTitle, content: noteContent })
        .select("id, title, content, created_at, updated_at")
        .single());
    }

    if (noteError) {
      const classified = classifyError(noteError);
      if (import.meta.env.DEV) console.error("[saveToVault] Error creating vault note:", noteError);
      return { ok: false, reason: classified.reason, message: classified.message };
    }

    if (!insertedNote?.id) {
      // Insert reported no error but returned no row — treat as a real
      // failure rather than a duplicate, so the caller can surface it.
      return {
        ok: false,
        reason: "error",
        message: "Couldn't save this file. Please try again.",
      };
    }

    // Only NOW (after we have a confirmed row id) lock in the dedup
    // entry, so a transient failure above can be retried without
    // reloading the tab.
    fileDedup.add(dedupKey);

    const ssText = spreadsheetData?.cells
      ? Object.values(spreadsheetData.cells)
          .flat()
          .filter(Boolean)
          .join(", ")
          .slice(0, 3000)
      : "";
    describeVaultItemInBackground(insertedNote.id, {
      imageUrl:
        fileType === "image" || fileType === "video" ? fileUrl : undefined,
      textContent: safeExtractedText || ssText || undefined,
      fileType,
      fileName: filename,
    });
    const extraEmbed = safeExtractedText || ssText || "";
    afterVaultNoteSaved(userId, insertedNote.id, {
      title: noteTitle,
      content: noteContent,
      extraPlain: extraEmbed,
    });

    return { ok: true, id: insertedNote.id, note: insertedNote };
  } catch (err) {
    if (import.meta.env.DEV) console.error("[saveToVault] Unexpected error:", err);
    const classified = classifyError(err);
    return { ok: false, reason: classified.reason, message: classified.message };
  }
}

/**
 * Saves a link dropped into a project as a vault note.
 * Skips silently if the same URL already exists in the vault.
 * Always returns a discriminated result — never throws.
 */
export async function saveLinkToVault(
  opts: SaveLinkToVaultOptions
): Promise<SaveToVaultResult> {
  const { userId, url, projectName } = opts;
  const dedupKey = linkDedupKey(userId, url);

  try {
    // ── In-memory dedup ──
    if (linkDedup.has(dedupKey)) {
      return { ok: false, reason: "duplicate" };
    }

    // ── DB dedup: check if a vault note for this URL already exists ──
    const { data: existing } = await supabase
      .from("vault_items")
      .select("id")
      .eq("user_id", userId)
      .ilike("content", buildLikePattern(url))
      .limit(1);
    if (existing && existing.length > 0) {
      linkDedup.add(dedupKey);
      return { ok: false, reason: "duplicate" };
    }

    const isYouTube =
      /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
    const socialPlatform = detectSocialPlatform(url);

    let attachmentPayload: any[];
    let noteTitle: string;
    let noteContent: string;

    if (isYouTube) {
      // Fetch real video title + author + thumbnail via /api/unfurl
      // (which now hits YouTube's public oEmbed endpoint). Without
      // this, every YouTube save lands as a note titled "YouTube
      // Video" with no searchable text — searchVault for "C++" /
      // any video topic returns zero hits even when the user has
      // ten matching videos saved.
      let meta: any = { url, title: "YouTube Video" };
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const res = await fetch(
          `${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(url)}`
        );
        if (res.ok) meta = await res.json();
      } catch {
        /* fall back to placeholder title — embed still renders fine */
      }
      attachmentPayload = [
        {
          type: "youtube",
          url: meta.url || url,
          name: meta.title || "YouTube Video",
          title: meta.title || "",
          description: meta.description || "",
          image: meta.image || "",
          thumbnail_url: meta.image || "",
          siteName: meta.siteName || "YouTube",
          authorName: meta.authorName || "",
        },
      ];
      noteTitle = meta.title || "YouTube Video";
      // Keep the URL in the body so substring search across content
      // also matches direct URL drops, plus the title/description for
      // topical searches ("C++", "SQL", etc.).
      const bodyParts = [
        meta.title ? meta.title : "",
        meta.authorName ? `by ${meta.authorName}` : "",
        meta.description || "",
        `Link saved: ${url}`,
      ].filter(Boolean);
      noteContent = `${bodyParts.join("\n")}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;
    } else if (socialPlatform) {
      const label = getSocialEmbedLabel(socialPlatform);
      let meta: any = { url, title: `${label} Post` };
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const res = await fetch(
          `${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(url)}`
        );
        if (res.ok) meta = await res.json();
      } catch {
        /* use defaults */
      }
      attachmentPayload = [
        {
          type: meta.oembedType || socialPlatform,
          url: meta.url || url,
          name: meta.title || `${label} Post`,
          title: meta.title || "",
          description: meta.description || "",
          image: meta.image || "",
          favicon: meta.favicon || "",
          siteName: meta.siteName || label,
          oembedType: meta.oembedType || socialPlatform,
          oembedHtml: meta.oembedHtml || "",
          authorName: meta.authorName || "",
          authorHandle: meta.authorHandle || "",
          thumbnail_url: meta.image || "",
        },
      ];
      noteTitle = meta.title || `${label} Post`;
      noteContent = `${noteTitle}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;
    } else {
      let meta: any = { url, title: url };
      try {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const res = await fetch(
          `${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(url)}`
        );
        if (res.ok) meta = await res.json();
      } catch {
        /* use defaults */
      }
      attachmentPayload = [
        {
          type: "bookmark",
          url: meta.url || url,
          name: meta.title || url,
          title: meta.title || "",
          description: meta.description || "",
          image: meta.image || "",
          favicon: meta.favicon || "",
          siteName: meta.siteName || "",
          articleText: meta.articleText || "",
          oembedType: meta.oembedType || "",
          oembedHtml: meta.oembedHtml || "",
          authorName: meta.authorName || "",
          authorHandle: meta.authorHandle || "",
        },
      ];
      noteTitle = meta.title || url;
      noteContent = `${noteTitle}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;
    }

    const tags: string[] = isYouTube
      ? ["youtube", "uploaded"]
      : socialPlatform
        ? [socialPlatform, "social", "uploaded"]
        : ["link", "uploaded"];
    if (projectName) tags.push(projectName);

    const richInsert: Record<string, unknown> = {
      user_id: userId,
      title: noteTitle,
      content: noteContent,
      source: isYouTube ? "youtube_drop" : socialPlatform ? `${socialPlatform}_drop` : "link_drop",
      tags,
      ...buildAttachmentColumns(attachmentPayload[0]),
    };

    let noteError: any = null;
    let insertedNote: any = null;
    ({ data: insertedNote, error: noteError } = await supabase
      .from("vault_items")
      .insert(richInsert)
      .select("id, title, content, created_at, updated_at")
      .single());

    const missingColumnError =
      noteError &&
      (noteError.code === "PGRST204" ||
        noteError.message?.includes("Could not find") ||
        noteError.message?.toLowerCase().includes("does not exist"));

    if (missingColumnError) {
      ({ data: insertedNote, error: noteError } = await supabase
        .from("vault_items")
        .insert({ user_id: userId, title: noteTitle, content: noteContent })
        .select("id, title, content, created_at, updated_at")
        .single());
    }

    if (noteError) {
      const classified = classifyError(noteError);
      if (import.meta.env.DEV) console.error("[saveToVault] Error creating vault link note:", noteError);
      return { ok: false, reason: classified.reason, message: classified.message };
    }

    if (!insertedNote?.id) {
      return {
        ok: false,
        reason: "error",
        message: "Couldn't save this link. Please try again.",
      };
    }

    linkDedup.add(dedupKey);

    const att = attachmentPayload[0] || {};
    const linkText = [att.title, att.description, att.articleText]
      .filter(Boolean)
      .join("\n")
      .slice(0, 5000);
    describeVaultItemInBackground(insertedNote.id, {
      imageUrl: isYouTube ? undefined : att.image || att.thumbnail_url || undefined,
      textContent: linkText || undefined,
      fileType: isYouTube ? "youtube" : socialPlatform || "bookmark",
      fileName: att.title || att.name || url,
    });
    afterVaultNoteSaved(userId, insertedNote.id, {
      title: noteTitle,
      content: noteContent,
      extraPlain: linkText || undefined,
    });

    return { ok: true, id: insertedNote.id, note: insertedNote };
  } catch (err) {
    if (import.meta.env.DEV) console.error("[saveToVault] Unexpected error:", err);
    const classified = classifyError(err);
    return { ok: false, reason: classified.reason, message: classified.message };
  }
}

interface SaveGeneratedImageToVaultOptions {
  userId: string;
  imageUrl: string;
  /** Existing object path under user-files (from Imagine / generate_image). */
  storagePath?: string;
  mimeType?: string;
  promptText?: string;
  /** Vault `source` column. Default: studio_imagine */
  source?: string;
  folder?: string;
}

/**
 * Persist an AI-generated Studio/chat image as a durable vault card.
 *
 * Always copies into a unique `{userId}/{fileId}/original.*` vault layout —
 * even when a `generated/` storagePath already exists. Imagine batches share
 * the flat `…/generated/` folder; keeping that path would make every saved
 * sibling overwrite the same medium.jpg/thumb.jpg and look like the whole
 * batch landed in the vault.
 */
export async function saveGeneratedImageToVault(
  opts: SaveGeneratedImageToVaultOptions,
): Promise<SaveToVaultResult> {
  const {
    userId,
    imageUrl,
    promptText,
    source = "studio_imagine",
    folder = "Generated",
  } = opts;

  if (!userId || !imageUrl) {
    return { ok: false, reason: "error", message: "Missing image or user." };
  }

  const existingPath = String(opts.storagePath || "").trim();
  let mimeType = String(opts.mimeType || "").trim() || "image/jpeg";
  let fileUrl = imageUrl;
  let fileSize = 0;
  let ext = mimeType.includes("png")
    ? "png"
    : mimeType.includes("webp")
      ? "webp"
      : "jpg";

  try {
    // Prefer downloading the already-persisted object when we have a path;
    // otherwise fetch the preview URL.
    let blob: Blob | null = null;
    if (existingPath) {
      try {
        const { data: signedData } = await supabase.storage
          .from("user-files")
          .createSignedUrl(existingPath, 60 * 60);
        const src = signedData?.signedUrl || imageUrl;
        const res = await fetch(src);
        if (res.ok) blob = await res.blob();
      } catch {
        /* fall through to imageUrl fetch */
      }
      const pathExt = existingPath.split(".").pop()?.toLowerCase();
      if (pathExt === "png" || pathExt === "webp" || pathExt === "jpg" || pathExt === "jpeg") {
        ext = pathExt === "jpeg" ? "jpg" : pathExt;
        if (!opts.mimeType) {
          mimeType =
            ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        }
      }
    }

    if (!blob) {
      const res = await fetch(imageUrl);
      if (!res.ok) {
        return {
          ok: false,
          reason: "error",
          message: "Couldn't download the image to save it.",
        };
      }
      blob = await res.blob();
    }

    if (!blob.size) {
      return { ok: false, reason: "error", message: "Image was empty." };
    }
    if (blob.type) mimeType = blob.type;
    ext = mimeType.includes("png")
      ? "png"
      : mimeType.includes("webp")
        ? "webp"
        : mimeType.includes("jpeg") || mimeType.includes("jpg")
          ? "jpg"
          : ext;

    // One vault card → one private directory (same as normal uploads).
    const fileId = crypto.randomUUID();
    const storagePath = `${userId}/${fileId}/original.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("user-files")
      .upload(storagePath, blob, {
        cacheControl: "3600",
        upsert: false,
        contentType: mimeType,
      });
    if (uploadError) {
      const classified = classifyError(uploadError);
      return { ok: false, reason: classified.reason, message: classified.message };
    }
    fileSize = blob.size;
    const { data: signedData } = await supabase.storage
      .from("user-files")
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
    fileUrl = signedData?.signedUrl || imageUrl;

    const shortId = fileId.slice(0, 8);
    const filename = `AI Generated ${new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}-${shortId}.${ext}`;

    // Keep the caption short — the full Imagine batch prompt is shared by all
    // four slots and must not make this card look like a batch dump.
    const caption = String(promptText || "").trim().slice(0, 120);
    const promptLine = caption
      ? `AI-generated image: "${caption}"`
      : "AI-generated image";

    return await saveFileToVault({
      userId,
      filename,
      fileType: "image",
      fileUrl,
      storagePath,
      storageBucket: "user-files",
      fileSize,
      mimeType,
      source,
      folder,
      tags: ["image", "ai-generated", "generated"],
      contentPrefix: promptLine,
    });
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error("[saveToVault] saveGeneratedImageToVault error:", err);
    }
    const classified = classifyError(err);
    return { ok: false, reason: classified.reason, message: classified.message };
  }
}
