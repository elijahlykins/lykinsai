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

export function formatWalletUsd(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export async function fetchModelBuilderWallet() {
  const res = await fetch(`${API_BASE_URL}/api/v1/model-builder/wallet`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body;
}

/** @param {{ amount_cents?: number, amount_usd?: number }} opts */
export async function startModelBuilderWalletCheckout(opts = {}) {
  const res = await fetch(`${API_BASE_URL}/api/v1/model-builder/wallet/checkout`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(opts),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  }
  return body;
}
