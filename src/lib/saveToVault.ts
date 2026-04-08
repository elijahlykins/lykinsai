import { supabase } from "@/lib/supabase";
import { detectSocialPlatform, getSocialEmbedLabel } from "@/canvas/utils/socialEmbed";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";

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
}

interface SaveLinkToVaultOptions {
  userId: string;
  url: string;
  projectName?: string;
}

// ── Dedup caches (survive for the browser session) ──────────────
const fileDedup = new Set<string>();
const linkDedup = new Set<string>();

function fileDedupKey(userId: string, storagePath?: string, filename?: string) {
  return `${userId}::${storagePath || filename || ""}`;
}

function linkDedupKey(userId: string, url: string) {
  return `${userId}::${url}`;
}

function describeVaultItemInBackground(
  noteId: string,
  opts: {
    imageUrl?: string;
    textContent?: string;
    fileType?: string;
    fileName?: string;
  }
) {
  (async () => {
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/describe-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (!res.ok) return;
      const { description } = await res.json();
      if (!description) return;

      const { data: note } = await supabase
        .from("notes")
        .select("content")
        .eq("id", noteId)
        .single();
      if (!note?.content) return;

      const marker = "[ATTACHMENTS_JSON:";
      const start = note.content.indexOf(marker);
      if (start === -1) return;
      const jsonStart = start + marker.length;
      let bracketCount = 0;
      let jsonEnd = jsonStart;
      for (let i = jsonStart; i < note.content.length; i++) {
        if (note.content[i] === "[") bracketCount++;
        if (note.content[i] === "]") {
          bracketCount--;
          if (bracketCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
      if (jsonEnd <= jsonStart) return;

      let attachments: any[];
      try {
        attachments = JSON.parse(note.content.slice(jsonStart, jsonEnd));
      } catch {
        return;
      }
      if (!Array.isArray(attachments) || attachments.length === 0) return;

      attachments[0].aiDescription = description;
      const updatedContent =
        note.content.slice(0, start) +
        `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]` +
        note.content.slice(
          jsonEnd + (note.content[jsonEnd] === "]" ? 1 : 0)
        );

      await supabase
        .from("notes")
        .update({ content: updatedContent })
        .eq("id", noteId);
    } catch (err: any) {
      console.warn("Background vault describe failed:", err?.message);
    }
  })();
}

/**
 * Saves a file that was uploaded to Supabase Storage as a vault note.
 * Skips silently if the same file (by storagePath or filename) already exists.
 * Fire-and-forget safe — catches all errors internally.
 */
export async function saveFileToVault(
  opts: SaveFileToVaultOptions
): Promise<{ id: string } | null> {
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
  } = opts;

  try {
    // ── In-memory dedup ──
    const key = fileDedupKey(userId, storagePath, filename);
    if (fileDedup.has(key)) return null;
    fileDedup.add(key);

    // ── DB dedup: check if a vault note for this file already exists ──
    const searchTerm = storagePath || filename;
    const { data: existing } = await supabase
      .from("notes")
      .select("id")
      .eq("user_id", userId)
      .ilike("content", `%${searchTerm}%`)
      .limit(1);
    if (existing && existing.length > 0) return null;

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

    const noteContent = `File uploaded: ${filename}\n\nType: ${fileType}\nSize: ${sizeDisplay}\n\n[View File](${fileUrl})\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;

    const tags: string[] = [fileType, "uploaded"];
    if (projectName) tags.push(projectName);

    const richInsert: Record<string, unknown> = {
      user_id: userId,
      title: noteTitle,
      content: noteContent,
      source: "project_upload",
      tags,
      attachments: JSON.stringify(attachmentPayload),
    };

    let noteError: any = null;
    let insertedNote: any = null;
    ({ data: insertedNote, error: noteError } = await supabase
      .from("notes")
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
        .from("notes")
        .insert({ user_id: userId, title: noteTitle, content: noteContent })
        .select("id, title, content, created_at, updated_at")
        .single());
    }

    if (noteError) {
      console.error("[saveToVault] Error creating vault note:", noteError);
      return null;
    }

    if (insertedNote?.id) {
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
    }

    return insertedNote ?? null;
  } catch (err) {
    console.error("[saveToVault] Unexpected error:", err);
    return null;
  }
}

/**
 * Saves a link dropped into a project as a vault note.
 * Skips silently if the same URL already exists in the vault.
 * Fire-and-forget safe — catches all errors internally.
 */
export async function saveLinkToVault(
  opts: SaveLinkToVaultOptions
): Promise<{ id: string } | null> {
  const { userId, url, projectName } = opts;

  try {
    // ── In-memory dedup ──
    const key = linkDedupKey(userId, url);
    if (linkDedup.has(key)) return null;
    linkDedup.add(key);

    // ── DB dedup: check if a vault note for this URL already exists ──
    const { data: existing } = await supabase
      .from("notes")
      .select("id")
      .eq("user_id", userId)
      .ilike("content", `%${url}%`)
      .limit(1);
    if (existing && existing.length > 0) return null;

    const isYouTube =
      /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
    const socialPlatform = detectSocialPlatform(url);

    let attachmentPayload: any[];
    let noteTitle: string;
    let noteContent: string;

    if (isYouTube) {
      attachmentPayload = [
        { type: "youtube", url, name: "YouTube Video" },
      ];
      noteTitle = "YouTube Video";
      noteContent = `Link saved: ${url}\n\n[ATTACHMENTS_JSON:${JSON.stringify(attachmentPayload)}]`;
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
      attachments: JSON.stringify(attachmentPayload),
    };

    let noteError: any = null;
    let insertedNote: any = null;
    ({ data: insertedNote, error: noteError } = await supabase
      .from("notes")
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
        .from("notes")
        .insert({ user_id: userId, title: noteTitle, content: noteContent })
        .select("id, title, content, created_at, updated_at")
        .single());
    }

    if (noteError) {
      console.error("[saveToVault] Error creating vault link note:", noteError);
      return null;
    }

    if (insertedNote?.id) {
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
    }

    return insertedNote ?? null;
  } catch (err) {
    console.error("[saveToVault] Unexpected error:", err);
    return null;
  }
}
