import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

export async function mcpFetch(path, init = {}) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token || "";
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

export function openMcpOAuth(url) {
  if (!url) return;
  window.open(url, "lykn-mcp-oauth", "width=480,height=720");
}

/** @param {{ search?: string, catalogId?: string }} [opts] */
export function openConnectionsSettings(opts = {}) {
  const search = opts.search;
  const catalogId = opts.catalogId;
  const params = new URLSearchParams();
  params.set("section", "connections");
  if (search) params.set("q", String(search));
  if (catalogId) params.set("catalog", String(catalogId));
  const next = `/settings?${params.toString()}`;
  window.history.replaceState(null, "", next);
  window.dispatchEvent(new CustomEvent("lykn-open-connections", { detail: { search, catalogId } }));
}
