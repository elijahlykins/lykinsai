/**
 * Local Vault — the settings surface for moving the vault onto this Mac.
 *
 * Three things happen here, in the order a user has to do them: copy the cloud
 * vault down, let the search index catch up, then switch the app over. The
 * order matters, so the switch stays disabled until there is something local
 * to switch to — flipping it on an empty store would show an empty vault and
 * look exactly like data loss.
 *
 * The import itself is read-only against Supabase. Nothing here deletes
 * anything in the cloud, and the copy can be run again without duplicating
 * rows, which is what makes it safe to offer before the migration is finished.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { HardDrive, Cloud, Check, AlertTriangle, Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { toast } from "@/components/ui/use-toast";
import { Switch } from "@/components/ui/switch";
import { LG_SWITCH } from "@/components/settings/glassTokens";
import {
  isLocalVaultAvailable,
  isLocalVaultEnabled,
  setLocalVaultEnabled,
  resetVaultRepository,
} from "@/lib/vault/repository";

const POLL_MS = 700;

/** The importer's internal phase names, said the way a person would. */
const PHASE_LABELS = {
  preflight: "Getting ready",
  items: "Copying your items",
  blobs: "Copying your files",
  chats: "Copying your chats",
  done: "Finished",
};

function bridge() {
  return typeof window !== "undefined" ? window.lykn?.store : null;
}

/** Unwrap the `{ ok, data }` envelope every store op returns. */
function unwrap(response) {
  if (!response) throw new Error("The local store did not respond.");
  if (response.ok === false) throw new Error(response.error || "Local store call failed.");
  return response.data;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCount(n) {
  return Number(n || 0).toLocaleString();
}

function Row({ label, description, trailing, danger = false }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <div className="min-w-0">
        <div
          className={`text-[13px] ${
            danger ? "text-red-600 dark:text-red-400" : "text-black dark:text-white"
          }`}
        >
          {label}
        </div>
        {description ? (
          <div className="mt-0.5 text-[11px] leading-snug text-black/45 dark:text-white/40">
            {description}
          </div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}

function Group({ children, caption, className = "" }) {
  return (
    <div className={className}>
      <div className="lykn-settings-group overflow-hidden rounded-[14px] divide-y divide-black/[0.06] dark:divide-white/[0.08]">
        {children}
      </div>
      {caption ? (
        <p className="mt-1.5 px-3 text-[11px] leading-snug text-black/45 dark:text-white/40">
          {caption}
        </p>
      ) : null}
    </div>
  );
}

function ActionButton({ children, onClick, busy = false, disabled = false, tone = "default" }) {
  const tones = {
    default:
      "bg-black/[0.06] hover:bg-black/[0.1] text-black dark:bg-white/[0.1] dark:hover:bg-white/[0.16] dark:text-white",
    primary: "bg-blue-600 hover:bg-blue-500 text-white",
    danger:
      "bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </button>
  );
}

function Bar({ value, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]">
      <div
        className="h-full rounded-full bg-blue-600 transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function LocalVaultSettings() {
  const { user } = useAuth();
  const available = isLocalVaultAvailable();

  const [enabled, setEnabled] = useState(() => isLocalVaultEnabled());
  const [stats, setStats] = useState(null);
  const [importState, setImportState] = useState(null);
  const [indexState, setIndexState] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const refresh = useCallback(async () => {
    const api = bridge();
    if (!api) return;
    try {
      const [nextStats, nextImport, nextIndex] = await Promise.all([
        api.stats().then(unwrap).catch(() => null),
        api.importStatus().then(unwrap).catch(() => null),
        api.indexStatus().then(unwrap).catch(() => null),
      ]);
      if (!mounted.current) return;
      setStats(nextStats);
      setImportState(nextImport);
      setIndexState(nextIndex);
    } catch {
      /* a failed poll is not worth surfacing; the next one may succeed */
    }
  }, []);

  useEffect(() => {
    if (!available) return undefined;
    void refresh();
    return undefined;
  }, [available, refresh]);

  // Poll only while something is actually moving, so an idle settings pane
  // isn't waking the main process twice a second.
  const running = Boolean(importState?.running || indexState?.running);
  useEffect(() => {
    if (!available || !running) return undefined;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [available, running, refresh]);

  /**
   * Hand the main process a read-only Supabase session.
   *
   * The renderer owns the session, so the token has to travel down. It is the
   * user's own access token, scoped by row-level security exactly as it is
   * here, and the importer refuses any HTTP method other than GET.
   */
  const configureImport = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (!accessToken) throw new Error("Sign in again to copy your vault down.");

    unwrap(
      await bridge().importConfigure({
        url: import.meta.env.VITE_SUPABASE_URL,
        apiKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        accessToken,
        userId: user?.id,
      }),
    );
  }, [user?.id]);

  const run = useCallback(
    async (name, fn, { successTitle, successBody } = {}) => {
      setBusy(name);
      setError(null);
      try {
        await fn();
        if (successTitle) toast({ title: successTitle, description: successBody });
      } catch (err) {
        const message = err?.message || "Something went wrong.";
        setError(message);
        toast({ title: "Local vault", description: message, variant: "destructive" });
      } finally {
        if (mounted.current) setBusy(null);
        void refresh();
      }
    },
    [refresh],
  );

  const onCheck = () =>
    run("check", async () => {
      await configureImport();
      const result = unwrap(await bridge().importPreflight());
      if (result?.ok === false) {
        throw new Error(result.reason || "Couldn't reach your cloud vault.");
      }
      if (mounted.current) setPreflight(result);
    });

  const onCopy = () =>
    run("copy", async () => {
      await configureImport();
      unwrap(await bridge().importStart({}));
    });

  const onCancel = () => run("cancel", async () => unwrap(await bridge().importCancel()));

  const onIndex = () =>
    run("index", async () => unwrap(await bridge().indexBackfill({})), {
      successTitle: "Indexing started",
      successBody: "Search will improve as it works through your vault.",
    });

  const onVerify = () =>
    run("verify", async () => {
      await configureImport();
      const result = unwrap(await bridge().importVerify({}));
      const missingRows = result?.items?.missing || 0;
      const missingFiles = result?.blobs?.missing || 0;
      const ok = result?.ok !== false;

      const parts = [];
      if (missingRows) parts.push(`${formatCount(missingRows)} items`);
      if (missingFiles) parts.push(`${formatCount(missingFiles)} files`);

      toast({
        title: ok ? "Everything matches" : "Some things are missing",
        description: ok
          ? `${formatCount(result?.items?.local)} items and ${formatCount(
              result?.chats?.local,
            )} chats are here, matching the cloud.`
          : `${parts.join(" and ")} haven't made it down yet. Copying again should fix it.`,
        variant: ok ? undefined : "destructive",
      });
    });

  const onToggle = (next) => {
    // Turning it on with nothing local would present an empty vault, which is
    // indistinguishable from having lost everything.
    if (next && !(stats?.items > 0)) {
      toast({
        title: "Nothing here yet",
        description: "Copy your vault down first, then switch over.",
        variant: "destructive",
      });
      return;
    }
    setLocalVaultEnabled(next);
    resetVaultRepository();
    setEnabled(next);
    toast({
      title: next ? "Vault is now local" : "Vault is back on the cloud",
      description: next
        ? "Reload any open vault windows to see it."
        : "Your local copy is untouched and still on this Mac.",
    });
  };

  if (!available) {
    return (
      <div className="space-y-5">
        <Group caption="The local vault keeps your files on this Mac instead of our servers. It needs the desktop app.">
          <Row
            label="Not available here"
            description="Open LYKN's desktop app to store your vault on this device."
            trailing={<Cloud className="h-4 w-4 text-black/30 dark:text-white/30" />}
          />
        </Group>
      </div>
    );
  }

  // The importer walks items then chats, so the bar tracks whichever phase is
  // live rather than trying to average two very different units of work.
  const copied =
    importState?.phase === "chats"
      ? { done: importState.chats?.imported || 0, total: importState.chats?.total || 0 }
      : { done: importState?.items?.imported || 0, total: importState?.items?.total || 0 };

  const importDone = Boolean(importState?.finishedAt) && !importState?.cancelled;

  const pendingToIndex =
    indexState?.remaining ??
    (indexState?.pending?.items || 0) + (indexState?.pending?.threads || 0);

  return (
    <div className="space-y-5">
      <Group caption="Read your vault from this Mac instead of our servers. Files stay on disk, search runs on-device, and nothing leaves the machine.">
        <Row
          label="Use the local vault"
          description={
            enabled
              ? "The vault is reading from this Mac."
              : stats?.items > 0
                ? "Ready to switch — you have a local copy."
                : "Copy your vault down first."
          }
          trailing={
            <Switch
              checked={enabled}
              onCheckedChange={onToggle}
              aria-label="Use the local vault"
              className={LG_SWITCH}
            />
          }
        />
      </Group>

      <div>
        <div className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/35">
          On this Mac
        </div>
        <Group caption="Everything here lives in LYKN's application folder and is included in your Mac's normal backups.">
          <Row
            label="Items"
            trailing={
              <span className="text-[13px] tabular-nums text-black/60 dark:text-white/55">
                {formatCount(stats?.items)}
              </span>
            }
          />
          <Row
            label="Files"
            description={
              stats?.blobs?.files ? `${formatCount(stats.blobs.files)} on disk` : undefined
            }
            trailing={
              <span className="text-[13px] tabular-nums text-black/60 dark:text-white/55">
                {formatBytes(stats?.blobs?.bytes)}
              </span>
            }
          />
          <Row
            label="Chats"
            trailing={
              <span className="text-[13px] tabular-nums text-black/60 dark:text-white/55">
                {formatCount(stats?.threads)}
              </span>
            }
          />
        </Group>
      </div>

      <div>
        <div className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/35">
          Copy from the cloud
        </div>
        <Group
          caption={
            "This only reads. Nothing in your cloud vault is changed or deleted, and you can run it " +
            "again at any time — items already copied are skipped rather than duplicated."
          }
        >
          {preflight ? (
            <Row
              label="In your cloud vault"
              description={`${formatCount(preflight.cloud?.items)} items · ${formatCount(
                preflight.cloud?.chats,
              )} chats${
                preflight.local?.imported
                  ? ` · ${formatCount(preflight.local.imported)} already copied`
                  : ""
              }`}
              trailing={<Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
            />
          ) : (
            <Row
              label="Check what's there"
              description="Count your cloud items before copying anything."
              trailing={
                <ActionButton onClick={onCheck} busy={busy === "check"}>
                  Check
                </ActionButton>
              }
            />
          )}

          {importState?.running ? (
            <div className="px-3.5 py-3">
              <div className="mb-2 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[13px] text-black dark:text-white">
                    {PHASE_LABELS[importState.phase] || "Copying"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-black/45 dark:text-white/40">
                    {formatCount(copied.done)} of {formatCount(copied.total)}
                    {importState.blobs?.downloaded
                      ? ` · ${formatCount(importState.blobs.downloaded)} files (${formatBytes(
                          importState.blobs.bytes,
                        )})`
                      : ""}
                  </div>
                </div>
                <ActionButton onClick={onCancel} busy={busy === "cancel"} tone="danger">
                  Stop
                </ActionButton>
              </div>
              <Bar value={copied.done} total={copied.total} />
            </div>
          ) : (
            <Row
              label={importDone ? "Copy again" : "Copy my vault down"}
              description={
                importDone
                  ? "Picks up anything added since the last copy."
                  : "Brings every item, file and chat onto this Mac."
              }
              trailing={
                <ActionButton onClick={onCopy} busy={busy === "copy"} tone="primary">
                  {importDone ? "Copy again" : "Start"}
                </ActionButton>
              }
            />
          )}

          {importDone ? (
            <Row
              label="Check it matches"
              description="Compares your local copy against the cloud, row by row."
              trailing={
                <ActionButton onClick={onVerify} busy={busy === "verify"}>
                  Verify
                </ActionButton>
              }
            />
          ) : null}
        </Group>
      </div>

      {stats?.items > 0 ? (
        <div>
          <div className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/35">
            Search index
          </div>
          <Group caption="Search runs entirely on this Mac. Indexing happens once, then keeps up on its own as you add things.">
            {indexState?.running ? (
              <div className="px-3.5 py-3">
                <div className="mb-2 text-[13px] text-black dark:text-white">
                  Indexing {formatCount(indexState.done)} of {formatCount(indexState.total)}
                </div>
                <Bar value={indexState.done} total={indexState.total} />
              </div>
            ) : (
              <Row
                label={pendingToIndex > 0 ? "Some items aren't searchable yet" : "Up to date"}
                description={
                  pendingToIndex > 0
                    ? `${formatCount(pendingToIndex)} waiting to be indexed.`
                    : "Everything on this Mac is searchable."
                }
                trailing={
                  pendingToIndex > 0 ? (
                    <ActionButton onClick={onIndex} busy={busy === "index"}>
                      Index now
                    </ActionButton>
                  ) : (
                    <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  )
                }
              />
            )}
          </Group>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-[10px] bg-red-500/10 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
          <p className="text-[11px] leading-snug text-red-700 dark:text-red-300">{error}</p>
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-3 pb-1 text-[11px] text-black/40 dark:text-white/35">
        <HardDrive className="h-3 w-3" />
        <span>Your cloud vault stays exactly as it is. Nothing here deletes it.</span>
      </div>
    </div>
  );
}
