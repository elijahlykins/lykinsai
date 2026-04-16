import { supabase } from "@/lib/supabase";

/**
 * Fire-and-forget: asks the server to describe a vault item (image / text / file)
 * and patches the AI description back into the note's ATTACHMENTS_JSON marker.
 */
export function describeVaultItemInBackground(
  noteId: string,
  opts: {
    imageUrl?: string;
    textContent?: string;
    fileType?: string;
    fileName?: string;
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
      let sliceEnd = jsonEnd;
      if (note.content[sliceEnd] === "]") sliceEnd += 1;
      const updatedContent =
        note.content.slice(0, start) +
        `[ATTACHMENTS_JSON:${JSON.stringify(attachments)}]` +
        note.content.slice(sliceEnd);

      await supabase
        .from("notes")
        .update({ content: updatedContent })
        .eq("id", noteId);
    } catch (err: any) {
      if (import.meta.env.DEV) console.warn("Background vault item describe failed:", err?.message);
    }
  })();
}
