import { supabase } from "@/lib/supabase";

/**
 * Load vault notes by id for Model Builder selected-file grid.
 * @returns {Promise<Array<{ id: string, title: string, tags: string[], source: string | null, updated_at: string | null, ai_summary: string | null, excerpt: string }>>}
 */
export async function fetchVaultNotesByIds(userId, noteIds) {
  if (!userId || !noteIds?.length) return [];
  const ids = [...new Set(noteIds.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 80);
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("vault_items")
    .select("id, title, tags, source, updated_at, ai_summary, content")
    .eq("user_id", userId)
    .in("id", ids);

  if (error) throw error;

  const byId = new Map(
    (data || []).map((row) => {
      const raw = String(row.content || "").replace(/\s+/g, " ").trim();
      const excerpt =
        String(row.ai_summary || "").trim() ||
        (raw.length > 160 ? `${raw.slice(0, 160)}…` : raw);
      return [
        row.id,
        {
          id: row.id,
          title: (row.title || "Untitled").trim(),
          tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
          source: row.source || null,
          updated_at: row.updated_at || null,
          ai_summary: row.ai_summary || null,
          excerpt,
        },
      ];
    }),
  );

  return ids.map((id) => byId.get(id)).filter(Boolean);
}
