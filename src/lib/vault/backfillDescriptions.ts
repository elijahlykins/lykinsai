import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";

/**
 * Background driver for the vault description backfill.
 *
 * Walks the user's vault in small server-side batches, asking the API to
 * generate a description for any item that lacks one (vision for images/files,
 * text summary for notes) and to re-embed it. This is what makes the cheap
 * keyword + description search reliable: every item ends up with a searchable
 * description, so the assistant rarely needs to fall back to anything heavier.
 *
 * Designed to be fired once per session, lazily, after the user is signed in:
 *  - self-guards against concurrent / repeat runs in the same tab,
 *  - stops as soon as the server reports `done` (or makes no progress),
 *  - paces itself between batches so it never hammers the API or the user's
 *    AI usage budget,
 *  - is entirely fire-and-forget: any failure just ends the run quietly.
 */

const BATCH_SIZE = 6;
const DELAY_BETWEEN_BATCHES_MS = 4000;
const MAX_BATCHES_PER_RUN = 40; // safety cap (~240 items/session)

let running = false;
let ranThisSession = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runBatch(token: string): Promise<{ processed: number; remaining: number; done: boolean } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/vault/backfill-descriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ batchSize: BATCH_SIZE }),
    });
    if (!res.ok) {
      // 429 (rate limit) or 503 (LLM off) — back off and stop for this run.
      return null;
    }
    const data = await res.json();
    return {
      processed: Number(data?.processed) || 0,
      remaining: Number(data?.remaining) || 0,
      done: Boolean(data?.done),
    };
  } catch {
    return null;
  }
}

/**
 * Kick off the sweep. Safe to call multiple times — only the first call per
 * tab/session actually runs. Returns immediately; work continues in the
 * background.
 */
export function startVaultDescriptionBackfill(opts: { force?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  if (running) return;
  if (ranThisSession && !opts.force) return;
  running = true;
  ranThisSession = true;

  void (async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;
      if (!token) return;

      for (let i = 0; i < MAX_BATCHES_PER_RUN; i += 1) {
        const result = await runBatch(token);
        // null => transient/blocked; stop gracefully and retry next session.
        if (!result) break;
        if (result.done || result.processed === 0) break;
        await sleep(DELAY_BETWEEN_BATCHES_MS);
      }
    } catch (e) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[Vault] description backfill error:", (e as Error)?.message);
      }
    } finally {
      running = false;
    }
  })();
}

/** Reset the once-per-session guard (e.g. on sign-out). */
export function resetVaultDescriptionBackfill(): void {
  ranThisSession = false;
}
