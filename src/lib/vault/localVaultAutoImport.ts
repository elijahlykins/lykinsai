/**
 * Self-migration for accounts that predate the local-vault default.
 *
 * Local became the default backend (see repository/index.ts), which is right
 * for fresh installs but leaves an account with cloud items staring at an
 * empty AI Drive — everything is still in Supabase, the app just stopped
 * reading it. Rather than requiring a trip to Settings → Local Vault, this
 * runs the same importer automatically: signed in, local vault active, local
 * store empty, cloud vault non-empty → start the copy-down.
 *
 * Safety comes from the importer itself, not from this trigger: `start()` is
 * a no-op while a run is live (so several windows can race it harmlessly),
 * rows upsert by cloud id, and the cloud side is only ever read. The checks
 * here just avoid pointless work — a populated store or an empty cloud vault
 * means there is nothing to migrate.
 *
 * Fire-and-forget: any failure leaves the vault as it was (empty but intact
 * in the cloud) and the next launch tries again. The Settings pane remains
 * the manual/visible version of the same flow.
 */
// NOTE: "@/lib/vault/repository" and "@/lib/supabase" are imported lazily —
// the static chain pulls in @supabase/supabase-js, which the node test runner
// cannot load (aiDriveContents.ts defers the same import for the same reason).

const POLL_MS = 2500;
// A vault big enough to still be copying after this long is better served by
// the Settings pane (progress bar, cancel); stop polling, not the import.
const MAX_WAIT_MS = 45 * 60 * 1000;

/** The subset of the preload store bridge this trigger needs. */
export interface AutoImportBridge {
  stats: () => Promise<unknown>;
  importConfigure: (args: Record<string, unknown>) => Promise<unknown>;
  importPreflight: () => Promise<unknown>;
  importStart: (args?: Record<string, unknown>) => Promise<unknown>;
  importStatus: () => Promise<unknown>;
}

export type AutoImportEvent = "started" | "finished";

export interface AutoImportOptions {
  userId: string;
  onEvent?: (event: AutoImportEvent) => void;
  /** Test seams — production callers pass none of these. */
  api?: AutoImportBridge | null;
  isEnabled?: () => Promise<boolean> | boolean;
  getSession?: () => Promise<{ accessToken: string | null; url: string; apiKey: string }>;
  resetRepository?: () => Promise<void> | void;
  sleepImpl?: (ms: number) => Promise<void>;
}

// One attempt per user per app session: a transient failure retries on the
// next launch rather than looping while the user works.
const attemptedThisSession = new Set<string>();

/** Test-only: forget which users were attempted this session. */
export function resetAutoImportSessionGuard(): void {
  attemptedThisSession.clear();
}

function defaultBridge(): AutoImportBridge | null {
  const store = (globalThis as { window?: { lykn?: { store?: unknown } } }).window?.lykn
    ?.store as AutoImportBridge | undefined;
  if (!store || typeof store.importStart !== "function") return null;
  return store;
}

async function defaultIsEnabled(): Promise<boolean> {
  const { isLocalVaultAvailable, isLocalVaultEnabled } = await import("@/lib/vault/repository");
  return isLocalVaultAvailable() && isLocalVaultEnabled();
}

async function defaultResetRepository(): Promise<void> {
  const { resetVaultRepository } = await import("@/lib/vault/repository");
  resetVaultRepository();
}

async function defaultGetSession() {
  const { supabase } = await import("@/lib/supabase");
  const { data } = await supabase.auth.getSession();
  return {
    accessToken: data?.session?.access_token || null,
    url: String(import.meta.env.VITE_SUPABASE_URL || ""),
    apiKey: String(import.meta.env.VITE_SUPABASE_ANON_KEY || ""),
  };
}

/** Turn the bridge's `{ ok, data }` envelope into a value or a real error. */
function unwrap(response: unknown): any {
  const res = response as { ok?: boolean; data?: unknown; error?: string } | null;
  if (!res) throw new Error("the local store did not respond");
  if (res.ok === false) throw new Error(res.error || "local store call failed");
  return res.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start (and await) the cloud → local copy when this account needs one.
 * Resolves without doing anything for accounts that are already local-borne,
 * already migrated, or already importing. Never throws.
 */
export async function autoImportCloudVaultIfNeeded({
  userId,
  onEvent,
  api = defaultBridge(),
  isEnabled = defaultIsEnabled,
  getSession = defaultGetSession,
  resetRepository = defaultResetRepository,
  sleepImpl = sleep,
}: AutoImportOptions): Promise<void> {
  if (!userId || attemptedThisSession.has(userId)) return;
  if (!api || !(await isEnabled())) return;
  attemptedThisSession.add(userId);

  try {
    // A populated store means this account is either born-local or already
    // migrated — the two states this trigger exists to tell apart from
    // "cloud items, empty disk".
    const stats = unwrap(await api.stats()) as { items?: number } | null;
    if (Number(stats?.items || 0) > 0) return;

    const status = unwrap(await api.importStatus()) as { running?: boolean } | null;
    if (status?.running) return;

    const session = await getSession();
    if (!session.accessToken) return;
    unwrap(
      await api.importConfigure({
        url: session.url,
        apiKey: session.apiKey,
        accessToken: session.accessToken,
        userId,
      }),
    );

    const pre = unwrap(await api.importPreflight()) as {
      ok?: boolean;
      cloud?: { items?: number; chats?: number };
    } | null;
    if (pre?.ok === false) return;
    const cloudItems = Number(pre?.cloud?.items || 0);
    const cloudChats = Number(pre?.cloud?.chats || 0);
    // A fresh account: nothing in the cloud, nothing to move.
    if (cloudItems === 0 && cloudChats === 0) return;

    unwrap(await api.importStart({}));
    onEvent?.("started");

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleepImpl(POLL_MS);
      const s = unwrap(await api.importStatus()) as {
        running?: boolean;
        cancelled?: boolean;
      } | null;
      if (s?.running) continue;
      if (s?.cancelled) return;
      break;
    }

    // The repository cache may hold an instance created against the empty
    // store; drop it so the next read sees the imported rows.
    await resetRepository();
    onEvent?.("finished");
  } catch {
    // Best-effort by design: the cloud vault is untouched and the next
    // launch will try again. The Settings pane surfaces errors visibly.
  }
}
