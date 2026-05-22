import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Debounce so we don't run the profile LLM on every message. The server
 * still gates with PROFILE_LLM_THROTTLE_MS (24h between actual LLM passes,
 * see server.js), so this debounce only controls **how long after the
 * user pauses** we issue the HTTP ping that may run a pass.
 *
 * Was 90s — that's the lag a user feels between "I saved my last note for
 * the night" and "my synthesis layer noticed". Tightened to 30s. The
 * fact-extraction pipeline downstream short-circuits on the evidence-hash
 * gate when nothing material changed, so the cost of an extra ping is
 * usually a cheap evidence-hash compute + a DB read.
 */
const DEBOUNCE_MS = 30 * 1000;

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
