import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

const FETCH_INIT = { cache: "no-store" };

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function fetchPublishedCustomModels() {
  const res = await fetch(`${API_BASE_URL}/api/v1/custom-models/published`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body.models || [];
}
