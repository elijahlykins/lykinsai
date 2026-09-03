/**
 * Renderer client for the LYKN managed-connections API
 * (/api/connections/managed/*). Product code talks about providers
 * ("gmail"), never about the backing auth infrastructure.
 */

import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

async function managedFetch(path, init = {}) {
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

export async function listManagedConnections() {
  const res = await managedFetch("/api/connections/managed");
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.connections) ? data.connections : [];
}

/**
 * Searchable directory of every connectable app with icons and live
 * connection state. Returns { unconfigured, entries }.
 */
export async function searchManagedDirectory({ query = "", limit = 24 } = {}) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  params.set("limit", String(limit));
  const res = await managedFetch(`/api/connections/managed/directory?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      unconfigured: data?.error === "not_configured",
      entries: [],
      hasMore: false,
      error: data?.error,
    };
  }
  return {
    unconfigured: Boolean(data.unconfigured),
    entries: Array.isArray(data.entries) ? data.entries : [],
    hasMore: Boolean(data.hasMore),
  };
}

/** Authoritative status for one provider, or null if unavailable. */
export async function getManagedConnection(provider) {
  const res = await managedFetch(`/api/connections/managed/${encodeURIComponent(provider)}`);
  const data = await res.json().catch(() => ({}));
  return res.ok ? data?.connection || null : null;
}

export async function connectManagedProvider(provider) {
  const res = await managedFetch(
    `/api/connections/managed/${encodeURIComponent(provider)}/connect`,
    { method: "POST" },
  );
  return res.json().catch(() => ({ ok: false, error: "internal" }));
}

export async function disconnectManagedProvider(provider) {
  const res = await managedFetch(
    `/api/connections/managed/${encodeURIComponent(provider)}/disconnect`,
    { method: "POST" },
  );
  return res.json().catch(() => ({ ok: false, error: "internal" }));
}

/** Completes callback identity verification with the signed-in user. */
export async function completeManagedConnection(sessionUri) {
  const res = await managedFetch("/api/connections/managed/complete", {
    method: "POST",
    body: JSON.stringify({ sessionUri }),
  });
  return res.json().catch(() => ({ ok: false, error: "internal" }));
}

export function openManagedConnectPopup(url, { onClosed } = {}) {
  if (!url) return null;
  const popup = window.open(url, "lykn-connection-auth", "width=480,height=720");
  if (popup && onClosed) {
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        onClosed();
      }
    }, 1000);
  }
  return popup;
}

/** Origin the OAuth popup pages post from (the LYKN API server). */
export function managedCallbackOrigin() {
  try {
    return new URL(API_BASE_URL).origin;
  } catch {
    return null;
  }
}
