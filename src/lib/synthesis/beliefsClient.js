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

/**
 * Load beliefs + rules from the synthesis layer (`GET /api/beliefs`).
 * @returns {{ active: object[], proposed: object[], rules: object[] } | null}
 */
export async function fetchSynthesisBeliefs() {
  const res = await fetch(`${API_BASE_URL}/api/beliefs`, {
    ...FETCH_INIT,
    headers: await authHeaders(),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body?.ok) return null;
  const beliefs = Array.isArray(body.beliefs) ? body.beliefs : [];
  return {
    active: beliefs.filter((b) => b.status === "active"),
    proposed: beliefs.filter((b) => b.status === "proposed"),
    rules: Array.isArray(body.rules) ? body.rules : [],
  };
}

export async function patchSynthesisRule(ruleId, { triggerText, actionText }) {
  const body = {};
  if (triggerText != null) body.trigger_text = triggerText;
  if (actionText != null) body.action_text = actionText;
  const res = await fetch(`${API_BASE_URL}/api/rules/${ruleId}`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || data?.reason || `HTTP ${res.status}`);
  }
  return data.rule || data;
}

export async function retireSynthesisRule(ruleId) {
  const res = await fetch(`${API_BASE_URL}/api/rules/${ruleId}/retire`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || data?.reason || `HTTP ${res.status}`);
  }
  return data;
}
