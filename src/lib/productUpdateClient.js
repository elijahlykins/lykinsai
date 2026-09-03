import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import {
  PRODUCT_UPDATE,
  isProductUpdateSeen,
  productUpdateDismissPatch,
} from "@/lib/productUpdate";

const LOCAL_SEEN_KEY = "lykn_seen_product_update_id";

export function readLocalSeenProductUpdateId() {
  try {
    return String(window.localStorage.getItem(LOCAL_SEEN_KEY) || "");
  } catch {
    return "";
  }
}

export function writeLocalSeenProductUpdateId(updateId = PRODUCT_UPDATE.id) {
  try {
    window.localStorage.setItem(LOCAL_SEEN_KEY, String(updateId || ""));
  } catch {
    /* private mode */
  }
}

async function authHeaders() {
  const sess = await supabase.auth.getSession();
  const token = sess?.data?.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function fetchAccountPreferences() {
  const headers = await authHeaders();
  if (!headers) return null;
  const res = await fetch(`${API_BASE_URL}/api/account/preferences`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return data?.preferences || null;
}

export async function dismissProductUpdate(updateId = PRODUCT_UPDATE.id) {
  writeLocalSeenProductUpdateId(updateId);
  const headers = await authHeaders();
  if (!headers) return { ok: true, localOnly: true };
  const res = await fetch(`${API_BASE_URL}/api/account/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(productUpdateDismissPatch(updateId)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: true, localOnly: true };
  return { ok: true, preferences: data?.preferences || null };
}

export function productUpdateVisible(preferences, updateId = PRODUCT_UPDATE.id) {
  if (readLocalSeenProductUpdateId() === updateId) return false;
  if (isProductUpdateSeen(preferences?.metadata, updateId)) return false;
  return true;
}
