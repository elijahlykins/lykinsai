import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import {
  SYNTHESIS_LOAD_POLICY,
  type SynthesisSourceType,
} from "@/lib/synthesis/loadPolicy";

export type ScheduleSynthesisReindexOpts = {
  sourceType: SynthesisSourceType;
  sourceId: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** Override debounce (ms) before calling the API after last schedule for this source. */
  debounceMs?: number;
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, ScheduleSynthesisReindexOpts>();

function keyFor(o: Pick<ScheduleSynthesisReindexOpts, "sourceType" | "sourceId">) {
  return `${o.sourceType}:${o.sourceId}`;
}

/**
 * Debounced reindex: coalesces rapid saves (board typing, etc.) into one embed job.
 * Fire-and-forget; failures are logged only.
 */
export function scheduleSynthesisReindex(opts: ScheduleSynthesisReindexOpts): void {
  const key = keyFor(opts);
  pending.set(key, opts);
  const debounceMs = opts.debounceMs ?? SYNTHESIS_LOAD_POLICY.minEmbedIntervalMs;

  const existing = timers.get(key);
  if (existing) clearTimeout(existing);

  const t = setTimeout(() => {
    timers.delete(key);
    void flushSynthesisReindex(key);
  }, debounceMs);
  timers.set(key, t);
}

async function flushSynthesisReindex(key: string): Promise<void> {
  const opts = pending.get(key);
  pending.delete(key);
  if (!opts) return;

  const text = String(opts.text || "").trim();
  if (text.length < 8) return;

  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return;

    const res = await fetch(`${API_BASE_URL}/api/synthesis/reindex`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sourceType: opts.sourceType,
        sourceId: opts.sourceId,
        text,
        metadata: opts.metadata || {},
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      if (import.meta.env.DEV) console.warn("[Synthesis] reindex failed:", res.status);
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Synthesis] reindex error:", e);
  }
}

/**
 * After vault `notes` rows are deleted — removes synthesis vectors for those note ids.
 * Fire-and-forget; safe if chunks never existed.
 */
export function purgeVaultNoteEmbeddings(noteIds: string | string[]): void {
  const ids = (Array.isArray(noteIds) ? noteIds : [noteIds]).filter(Boolean);
  for (const id of ids) {
    void purgeSynthesisSource("vault_note", String(id));
  }
}

/**
 * Remove all embedded chunks for a source (e.g. vault note deleted).
 */
export async function purgeSynthesisSource(
  sourceType: SynthesisSourceType,
  sourceId: string,
): Promise<void> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return;
    const res = await fetch(`${API_BASE_URL}/api/synthesis/purge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sourceType, sourceId }),
    });
    if (!res.ok && import.meta.env.DEV) console.warn("[Synthesis] purge failed:", res.status);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Synthesis] purge error:", e);
  }
}
