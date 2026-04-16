import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Debounce so we don’t run the profile LLM on every message. */
const DEBOUNCE_MS = 8 * 60 * 1000;

/**
 * Schedule a server-side user-model refresh (LLM distill → `lykn_user_synthesis_profile`).
 * Coalesces to one call per user after quiet period.
 */
export function scheduleUserProfileRefresh(userId: string): void {
  if (!userId) return;
  const prev = timers.get(userId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(userId);
    void runProfileRefresh();
  }, DEBOUNCE_MS);
  timers.set(userId, t);
}

async function runProfileRefresh(): Promise<void> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return;
    const res = await fetch(`${API_BASE_URL}/api/synthesis/refresh-profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (import.meta.env.DEV) console.warn("[Synthesis] profile refresh failed:", res.status);
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Synthesis] profile refresh error:", e);
  }
}
