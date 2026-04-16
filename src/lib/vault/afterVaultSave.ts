import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import { useAiStore } from "@/store/aiStore";
import { invalidateWorkspaceSummaryCache } from "@/lib/workspaceContext";
import { scheduleUserProfileRefresh } from "@/lib/synthesis/profileRefresh";
import { scheduleSynthesisReindex } from "@/lib/synthesis/queueReindex";
import { vaultNoteTextForSynthesis } from "@/lib/synthesis/sourceText";

const enrichTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ENRICH_DEBOUNCE_MS = 4000;

/**
 * Single entry point after a vault `notes` row is created/updated in a meaningful way:
 * - refreshes workspace listing cache for AI
 * - schedules user synthesis profile refresh (debounced server-side)
 * - queues semantic reindex for this note
 * - debounced server enrich (summary + signals + stronger embeddings)
 *
 * @param workspaceOpts.excludeBoardId — same board id you pass to `fetchWorkspaceSummaries` so "OTHER BOARDS"
 *   stays correct; omit when unknown (e.g. background file save).
 */
export function afterVaultNoteSaved(
  userId: string,
  noteId: string,
  opts: { title: string; content: string; extraPlain?: string },
  workspaceOpts?: { excludeBoardId?: string | null },
): void {
  if (!userId || !noteId) return;
  invalidateWorkspaceSummaryCache(userId);
  const ex = workspaceOpts?.excludeBoardId ?? undefined;
  void useAiStore.getState().refreshWorkspaceSummary(userId, ex, { force: true });
  scheduleUserProfileRefresh(userId);

  let text = vaultNoteTextForSynthesis(opts.title, opts.content);
  const extra = String(opts.extraPlain || "").trim();
  if (extra) text = `${text}\n\n${extra.slice(0, 12_000)}`;
  scheduleSynthesisReindex({
    sourceType: "vault_note",
    sourceId: noteId,
    text,
    metadata: { title: opts.title },
  });

  scheduleVaultNoteEnrichment(noteId);
}

function scheduleVaultNoteEnrichment(noteId: string): void {
  const prev = enrichTimers.get(noteId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    enrichTimers.delete(noteId);
    void runVaultNoteEnrichment(noteId);
  }, ENRICH_DEBOUNCE_MS);
  enrichTimers.set(noteId, t);
}

async function runVaultNoteEnrichment(noteId: string): Promise<void> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return;
    const res = await fetch(`${API_BASE_URL}/api/vault/enrich-note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ noteId }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (import.meta.env.DEV) console.warn("[Vault] enrich-note failed:", res.status);
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[Vault] enrich-note error:", e);
  }
}
