import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import {
  Loader2,
  RefreshCw,
  Pause,
  Play,
  Unplug,
  CheckCircle2,
  Shield,
  ArrowUpRight,
  ExternalLink,
  Eye,
  EyeOff,
} from "lucide-react";

/**
 * TokenConnectDialog — generic credential-paste connection dialog.
 *
 * Used for any provider whose `authMode === "token"` in the catalog
 * (Readwise, Matter, Bluesky app password, etc.). Renders the
 * `connector.connectFields` as labeled inputs, then POSTs them to
 * `POST /api/connections/:provider/connect-token`.
 *
 * Re-uses the same connection list / sync / pause / disconnect routes as
 * the OAuth dialog, so once a token-mode connection is created it shows
 * up identically in the connections list.
 */
export default function TokenConnectDialog({ open, onOpenChange, connector }) {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [values, setValues] = useState({});
  const [revealed, setRevealed] = useState({});

  const [dynamicInfo, setDynamicInfo] = useState(null);

  const provider = connector?.id;
  const fields = connector?.connectFields || [];
  // Catalog-supplied defaults; an adapter's connectInfo() can override
  // these at open time (Trello needs the server-side API key embedded in
  // the help URL, for instance).
  const helpUrl = dynamicInfo?.tokenHelpUrl || connector?.tokenHelpUrl || null;
  const helpLabel =
    dynamicInfo?.tokenHelpLabel || connector?.tokenHelpLabel || "Where do I get this?";
  const message = dynamicInfo?.message || null;

  const myConnections = useMemo(
    () => connections.filter((c) => c.provider === provider),
    [connections, provider],
  );

  const refresh = useCallback(async () => {
    if (!provider) return;
    setLoading(true);
    try {
      const res = await authedFetch("/api/connections");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConnections(data.connections || []);
    } catch (err) {
      toast({
        title: "Couldn't load connections",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    if (!open || !provider) return;
    refresh();
    // Reset the form whenever the dialog is opened so a previous
    // attempt's value doesn't linger.
    setValues({});
    setRevealed({});
    // Fetch any dynamic connect info the adapter wants to surface
    // (Trello-style pre-filled help URL, etc.). Failures are silent —
    // the catalog defaults still render.
    (async () => {
      try {
        const res = await authedFetch(`/api/connections/${provider}/connect-info`);
        if (!res.ok) return;
        const data = await res.json();
        setDynamicInfo(data || null);
      } catch {
        setDynamicInfo(null);
      }
    })();
  }, [open, provider, refresh]);

  const handleSubmit = useCallback(
    async (e) => {
      e?.preventDefault?.();
      if (!provider) return;

      // Coerce blank required fields to undefined and bail with a clear
      // message — every adapter assumes its required field is present.
      const missing = fields
        .filter((f) => f.required !== false)
        .filter((f) => !String(values[f.name] || "").trim());
      if (missing.length) {
        toast({
          title: "Missing field",
          description: `Please fill in ${missing.map((f) => f.label).join(", ")}.`,
          variant: "destructive",
        });
        return;
      }

      setSaving(true);
      try {
        const res = await authedFetch(`/api/connections/${provider}/connect-token`, {
          method: "POST",
          body: JSON.stringify(
            Object.fromEntries(
              fields.map((f) => [f.name, String(values[f.name] || "").trim()]),
            ),
          ),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        toast({
          title: `Connected to ${connector.name}`,
          description: "Initial sync started — check your Vault in a moment.",
        });
        setValues({});
        setRevealed({});
        refresh();
      } catch (err) {
        toast({
          title: "Couldn't connect",
          description: err.message,
          variant: "destructive",
        });
      } finally {
        setSaving(false);
      }
    },
    [provider, fields, values, connector?.name, refresh],
  );

  const handleSync = useCallback(
    async (id) => {
      setSyncingId(id);
      try {
        const res = await authedFetch(`/api/connections/${id}/sync`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if ((data.saved || 0) > 0) {
          toast({ title: `+${data.saved} saved`, description: "Check your Vault." });
        } else if (data.status === "reauth") {
          toast({
            title: "Token rejected",
            description: "Reconnect with a fresh token.",
            variant: "destructive",
          });
        } else {
          toast({ title: "Already up to date", description: "No new items." });
        }
        refresh();
      } catch (err) {
        toast({ title: "Sync failed", description: err.message, variant: "destructive" });
      } finally {
        setSyncingId(null);
      }
    },
    [refresh],
  );

  const handleToggleStatus = useCallback(
    async (conn) => {
      const next = conn.status === "paused" ? "active" : "paused";
      try {
        const res = await authedFetch(`/api/connections/${conn.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        refresh();
      } catch (err) {
        toast({ title: "Update failed", description: err.message, variant: "destructive" });
      }
    },
    [refresh],
  );

  const handleDisconnect = useCallback(
    async (conn) => {
      if (
        !confirm(
          `Disconnect ${connector.name}${conn.account_handle ? ` (${conn.account_handle})` : ""}? Items already in your vault stay.`,
        )
      )
        return;
      try {
        const res = await authedFetch(`/api/connections/${conn.id}`, { method: "DELETE" });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        toast({ title: "Disconnected", description: `${connector.name} unlinked.` });
        refresh();
      } catch (err) {
        toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      }
    },
    [connector?.name, refresh],
  );

  if (!connector) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-white dark:bg-zinc-950 border border-black/10 dark:border-white/10">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-semibold tracking-tight flex items-center gap-2">
            <ProviderFavicon connector={connector} />
            {connector.name}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed text-black/60 dark:text-white/60">
            {connector.summary}
          </DialogDescription>
        </DialogHeader>

        {/* ── Scopes / what we pull ───────────────────────── */}
        <div className="rounded-xl border border-black/[0.08] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-black/65 dark:text-white/70 mb-1.5">
            <Shield className="h-3 w-3" />
            What LYKN reads
          </div>
          <ul className="space-y-1">
            {(connector.pulls || []).map((p) => (
              <li
                key={p}
                className="text-[12px] text-black/75 dark:text-white/80 flex items-start gap-2"
              >
                <span className="mt-1 h-1 w-1 rounded-full bg-black/40 dark:bg-white/40 flex-shrink-0" />
                {p}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-[10.5px] text-black/45 dark:text-white/45">
            Read-only. The credential is encrypted at rest. You can revoke it any time.
          </div>
        </div>

        {/* ── Already-connected accounts ──────────────────── */}
        {myConnections.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-black/65 dark:text-white/70 flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              Connected
            </div>
            <ul className="space-y-1.5">
              {myConnections.map((conn) => (
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  syncing={syncingId === conn.id}
                  onSync={() => handleSync(conn.id)}
                  onToggle={() => handleToggleStatus(conn)}
                  onDisconnect={() => handleDisconnect(conn)}
                />
              ))}
            </ul>
          </div>
        )}

        {/* ── Token-paste form ────────────────────────────── */}
        <form onSubmit={handleSubmit} className="space-y-3">
          {fields.map((f) => {
            const isSecret = f.secret !== false;
            const isRevealed = !!revealed[f.name];
            const inputType = isSecret && !isRevealed ? "password" : "text";
            return (
              <div key={f.name} className="space-y-1">
                <label
                  htmlFor={`tcd-${provider}-${f.name}`}
                  className="text-[11.5px] font-medium text-black/70 dark:text-white/75"
                >
                  {f.label}
                  {f.required === false ? (
                    <span className="ml-1 text-black/40 dark:text-white/40">(optional)</span>
                  ) : null}
                </label>
                <div className="relative">
                  <input
                    id={`tcd-${provider}-${f.name}`}
                    type={inputType}
                    value={values[f.name] || ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.name]: e.target.value }))
                    }
                    placeholder={f.placeholder || ""}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 text-[13px] text-black/90 dark:text-white/90 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-black/30 dark:focus:border-white/30 pr-9"
                  />
                  {isSecret && (
                    <button
                      type="button"
                      onClick={() =>
                        setRevealed((r) => ({ ...r, [f.name]: !r[f.name] }))
                      }
                      title={isRevealed ? "Hide" : "Show"}
                      tabIndex={-1}
                      className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/90 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      {isRevealed ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
                {f.helpText && (
                  <p className="text-[10.5px] text-black/50 dark:text-white/50 leading-relaxed">
                    {f.helpText}
                  </p>
                )}
              </div>
            );
          })}

          {message && (
            <p className="text-[11.5px] leading-relaxed text-black/65 dark:text-white/70 rounded-lg bg-blue-500/8 dark:bg-blue-500/12 border border-blue-500/20 px-2.5 py-2">
              {message}
            </p>
          )}

          {helpUrl && (
            <a
              href={helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[11.5px] text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/90 underline-offset-2 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {helpLabel}
            </a>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full h-10 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[13px] font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2 shadow-sm hover:opacity-90 transition-opacity"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUpRight className="h-4 w-4" />
            )}
            {myConnections.length > 0
              ? `Add another ${connector.name} account`
              : `Connect ${connector.name}`}
          </button>
        </form>

        {loading && (
          <div className="text-[10.5px] text-black/40 dark:text-white/40 inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Refreshing…
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionRow({ conn, syncing, onSync, onToggle, onDisconnect }) {
  const isPaused = conn.status === "paused";
  const isReauth = conn.status === "reauth";
  const isError = conn.status === "error";

  return (
    <li
      className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 transition-colors ${
        isReauth || isError
          ? "border-rose-200 dark:border-rose-900/40 bg-rose-50/40 dark:bg-rose-950/15"
          : isPaused
            ? "border-black/[0.08] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02] opacity-70"
            : "border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/[0.03]"
      }`}
    >
      {conn.account_avatar_url ? (
        <img
          src={conn.account_avatar_url}
          alt=""
          className="h-7 w-7 rounded-full object-cover flex-shrink-0 bg-black/[0.04] dark:bg-white/[0.06]"
        />
      ) : (
        <div className="h-7 w-7 rounded-full bg-black/[0.06] dark:bg-white/[0.08] flex items-center justify-center text-[10px] font-semibold text-black/55 dark:text-white/65">
          {(conn.account_handle || conn.provider)[0]?.toUpperCase() || "?"}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate">
          {conn.account_handle
            ? `@${conn.account_handle}`
            : conn.account_display_name || conn.provider_user_id}
        </div>
        <div className="text-[10.5px] text-black/45 dark:text-white/45 truncate">
          {conn.total_synced_count || 0} item{(conn.total_synced_count || 0) === 1 ? "" : "s"}
          {" · "}
          {conn.last_synced_at ? `synced ${relativeTime(conn.last_synced_at)}` : "never synced"}
          {isReauth && " · token invalid"}
          {isError && conn.last_error ? ` · ${truncate(conn.last_error, 60)}` : ""}
          {isPaused && " · paused"}
        </div>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <IconButton
          title="Sync now"
          onClick={onSync}
          disabled={syncing}
          icon={
            syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )
          }
        />
        <IconButton
          title={isPaused ? "Resume" : "Pause"}
          onClick={onToggle}
          icon={isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        />
        <IconButton
          title="Disconnect"
          onClick={onDisconnect}
          danger
          icon={<Unplug className="h-3.5 w-3.5" />}
        />
      </div>
    </li>
  );
}

function ProviderFavicon({ connector }) {
  const url = connector.domain
    ? `https://www.google.com/s2/favicons?domain=${connector.domain}&sz=64`
    : "";
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      className="h-5 w-5 rounded-sm object-cover bg-black/[0.04] dark:bg-white/[0.06]"
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  );
}

function IconButton({ icon, title, onClick, danger, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`h-7 w-7 rounded-md flex items-center justify-center transition-colors disabled:opacity-50 ${
        danger
          ? "text-black/45 dark:text-white/45 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30"
          : "text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/90 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
      }`}
    >
      {icon}
    </button>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function authedFetch(path, init = {}) {
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

function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "—";
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.floor(day / 30)}mo ago`;
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
