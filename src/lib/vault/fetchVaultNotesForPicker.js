import { supabase } from "@/lib/supabase";

const MAX_NOTES = 2000;

/**
 * Lightweight vault note list for Model Builder knowledge picker.
 * @returns {Promise<Array<{ id: string, title: string, tags: string[], source: string | null, updated_at: string | null }>>}
 */
export async function fetchVaultNotesForPicker(userId) {
  if (!userId) return [];

  const { data, error } = await supabase
    .from("notes")
    .select("id, title, tags, source, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(MAX_NOTES);

  if (error) throw error;

  return (data || []).map((row) => ({
    id: row.id,
    title: (row.title || "Untitled").trim(),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    source: row.source || null,
    updated_at: row.updated_at || null,
  }));
}
