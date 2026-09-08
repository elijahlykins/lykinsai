import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import {
  shouldShowSignupGrantNotice,
  signupGrantNoticeDismissPatch,
} from "../../lib/billing/signupGrantNotice.js";

const LOCAL_SEEN_KEY = "lykn_signup_grant_notice_seen";

function localKey(userId) {
  return `${LOCAL_SEEN_KEY}:${String(userId || "")}`;
}

export function readLocalSignupGrantNoticeSeen(userId) {
  if (!userId) return false;
  try {
    return window.localStorage.getItem(localKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function writeLocalSignupGrantNoticeSeen(userId) {
  if (!userId) return;
  try {
    window.localStorage.setItem(localKey(userId), "1");
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

export async function dismissSignupGrantNotice(userId) {
  writeLocalSignupGrantNoticeSeen(userId);
  const headers = await authHeaders();
  if (!headers) return { ok: true, localOnly: true };
  const res = await fetch(`${API_BASE_URL}/api/account/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(signupGrantNoticeDismissPatch()),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: true, localOnly: true };
  return { ok: true, preferences: data?.preferences || null };
}

export function signupGrantNoticeVisible(billing, userId) {
  return shouldShowSignupGrantNotice({
    notice: billing?.signup_grant_notice,
    localSeen: readLocalSignupGrantNoticeSeen(userId),
  });
}
