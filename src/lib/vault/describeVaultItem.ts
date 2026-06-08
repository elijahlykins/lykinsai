import { supabase } from "@/lib/supabase";
import {
  findAttachmentsMarker,
  withAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";
import { scheduleSynthesisReindex } from "@/lib/synthesis/queueReindex";
import { vaultNoteTextForSynthesis } from "@/lib/synthesis/sourceText";

/**
 * Fire-and-forget: asks the server to describe a vault item (image / text / file)
 * and patches the AI description back into the note's ATTACHMENTS_JSON marker.
 *
 * Design notes:
 *  - Attachment marker scanning goes through `findAttachmentsMarker`, which
 *    handles `[`/`]` characters that appear inside JSON strings. The old
 *    bracket-count loop here would mis-find boundaries on innocuous filenames.
 *  - The select reads `updated_at` and the update is conditional on that
 *    value, so a user edit landing between the two calls won't be silently
 *    overwritten with stale content + the new description.
 *  - `attachmentIndex` defaults to 0 for backward compatibility, but callers
 *    should pass the real index of the attachment they want enriched.
 */
export function describeVaultItemInBackground(
  noteId: string,
  opts: {
    imageUrl?: string;
    textContent?: string;
    fileType?: string;
    fileName?: string;
    attachmentIndex?: number;
  },
): void {
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

      const { data: sess } = await supabase.auth.getSession();
      const userId = sess?.session?.user?.id;
      if (!userId) return;

      const { data: note } = await supabase
        .from("notes")
        .select("title, content, updated_at")
        .eq("id", noteId)
        .eq("user_id", userId)
        .single();
      if (!note?.content) return;

      const span = findAttachmentsMarker(String(note.content));
      if (!span) return;

      const attachments = span.attachments.slice();
      const idx =
        Number.isInteger(opts.attachmentIndex) && (opts.attachmentIndex as number) >= 0
          ? (opts.attachmentIndex as number)
          : 0;
      if (idx >= attachments.length) return;
      const target = attachments[idx];
      if (!target || typeof target !== "object") return;

      attachments[idx] = { ...(target as Record<string, unknown>), aiDescription: description };
      const updatedContent = withAttachmentsMarker(String(note.content), attachments);

      // Lost-update guard: only commit if the row hasn't moved since we
      // read it. The user could have edited the note title/content while
      // the AI request was in flight; clobbering that would be data loss.
      const { error: updateErr } = await supabase
        .from("notes")
        .update({ content: updatedContent })
        .eq("id", noteId)
        .eq("user_id", userId)
        .eq("updated_at", note.updated_at);
      if (updateErr) return;

      // The vision description only just landed in the note. The original
      // post-save reindex embedded the image as title-only (no description
      // existed yet), so without a fresh reindex the assistant's semantic
      // vault search can never match the image by what it depicts. Re-embed
      // now with the description folded in via vaultNoteTextForSynthesis.
      scheduleSynthesisReindex({
        sourceType: "vault_note",
        sourceId: noteId,
        text: vaultNoteTextForSynthesis(String(note.title || ""), updatedContent),
        metadata: { title: note.title, describedReindex: true },
      });
    } catch (err: any) {
      if (import.meta.env.DEV) console.warn("Background vault item describe failed:", err?.message);
    }
  })();
}
