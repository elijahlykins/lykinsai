import { supabase } from "@/lib/supabase";

/**
 * User vault tags with note counts (server RPC when available).
 * @returns {Promise<Array<{ name: string, count: number }>>}
 */
export async function fetchVaultTags(userId) {
  if (!userId) return [];

  try {
    const { data: rpcData, error: rpcError } = await supabase.rpc("vault_tag_counts");
    if (!rpcError && Array.isArray(rpcData)) {
      return rpcData
        .map((row) => ({
          name: String(row.tag || "").trim(),
          count: Number(row.count) || 0,
        }))
        .filter((entry) => entry.name);
    }
  } catch {
    /* fall through */
  }

  const { data, error } = await supabase
    .from("notes")
    .select("tags")
    .eq("user_id", userId)
    .not("tags", "is", null)
    .limit(5000);

  if (error || !data) return [];

  const tagMap = {};
  data.forEach((row) => {
    (row.tags || []).forEach((t) => {
      const tag = String(t).trim();
      if (!tag) return;
      tagMap[tag] = (tagMap[tag] || 0) + 1;
    });
  });

  return Object.entries(tagMap)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}
