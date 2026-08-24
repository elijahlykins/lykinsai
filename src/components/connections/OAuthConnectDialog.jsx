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
import { toUserFacingError } from "@/lib/ai/userFacingErrors";
import { ConnectorDetailHeader } from "./ConnectorDetail";
import {
  Loader2,
  RefreshCw,
  Pause,
  Play,
  Unplug,
  CheckCircle2,
  AlertTriangle,
  ArrowUpRight,
} from "lucide-react";

/**
 * Generic OAuth connection dialog. Renders for any provider the backend
 * supports — GitHub today, Reddit / Notion / Spotify / Pinterest as we
 * add adapters. The dialog is intentionally provider-agnostic; everything
 * provider-specific (display name, scopes, what we pull) is passed in.
 *
 * Props:
 *   open, onOpenChange — Radix dialog control
 *   connector          — full row from src/lib/connectors/catalog.js
 */
export default function OAuthConnectDialog({ open, onOpenChange, connector }) {
  const [connections, setConnections] = useState([]);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [prefieldValues, setPrefieldValues] = useState({});

  const provider = connector?.id;
  const prefields = connector?.oauthPrefields || [];
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
      setProviderConfigured(Boolean(data.providerConfig?.[provider] ?? true));
    } catch (err) {
      toast({
        title: "Couldn't load connections",
        description: toUserFacingError(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    if (open) {
      refresh();
      setPrefieldValues({});
    }
  }, [open, refresh]);

  // Listen for the popup → opener handshake. The /oauth/callback page
  // posts a message with { type:'lykn:oauth', provider, ok } and closes
  // itself. We refresh the list whenever we see that for our provider.
  //
  // The popup runs at the API origin (e.g. lykn-ideation.onrender.com), so
  // event.origin won't equal location.origin — we validate against the
  // configured API_BASE_URL instead. Defense-in-depth; the payload itself
  // contains no secrets.
  useEffect(() => {
    if (!open) return;
    const expectedOrigin = (() => {
      try {
        return new URL(API_BASE_URL).origin;
      } catch {
        return "";
      }
    })();
    const onMessage = (event) => {
      // Only trust messages from our own API origin.
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      const msg = event?.data;
      if (!msg || msg.type !== "lykn:oauth") return;
      if (msg.provider !== provider) return;
      if (msg.ok) {
        toast({
          title: `Connected to ${connector.name}`,
          description: "Initial sync started. Check your Vault in a moment.",
        });
      } else {
        toast({
          title: "Connection failed",
          description: "The provider rejected the request or you cancelled.",
          variant: "destructive",
        });
      }
      setConnecting(false);
      refresh();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, provider, connector?.name, refresh]);

  const handleConnect = useCallback(async () => {
    if (!providerConfigured) return;

    // For per-instance providers (Mastodon), the catalog declares
    // oauthPrefields that must be filled in BEFORE the popup opens. Bail
    // with a clear message rather than start an OAuth flow with missing
    // context.
    const missingPre = prefields
      .filter((f) => f.required !== false)
      .filter((f) => !String(prefieldValues[f.name] || "").trim());
    if (missingPre.length) {
      toast({
        title: "Missing field",
        description: `Please fill in ${missingPre.map((f) => f.label).join(", ")}.`,
        variant: "destructive",
      });
      return;
    }

    setConnecting(true);
    try {
      const body = Object.fromEntries(
        prefields.map((f) => [f.name, String(prefieldValues[f.name] || "").trim()]),
      );
      const res = await authedFetch(`/api/connections/${provider}/start`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const w = 620;
      const h = 760;
      const left = Math.max(0, (window.screen.width - w) / 2);
      const top = Math.max(0, (window.screen.height - h) / 2);
      const popup = window.open(
        data.url,
        "lyknOauth",
        `width=${w},height=${h},left=${left},top=${top},popup=1`,
      );
      if (!popup) {
        // Popup blocked — fall back to current tab.
        window.location.href = data.url;
        return;
      }
      // Backstop for "user closed the popup without finishing OAuth".
      // We deliberately do NOT poll popup.closed here: the opener has
      // COOP same-origin-allow-popups (vercel.json), and once the popup
      // navigates to the provider (Google, GitHub, …) every popup.closed
      // read logs a "Cross-Origin-Opener-Policy policy would block the
      // window.closed call" warning. At 500ms ticks that's tens of
      // warnings per OAuth flow.
      //
      // Instead we check popup.closed exactly once, when focus returns
      // to the opener — which happens both when the callback page closes
      // itself (happy path) and when the user X-es the popup (cancel).
      // On the happy path the postMessage listener above has already
      // cleared `connecting` by the time focus fires, so this is a no-op.
      const onFocus = () => {
        // Tiny deferral so a racing postMessage wins and clears state
        // before we touch popup.closed at all.
        setTimeout(() => {
          let closed = true;
          try {
            closed = popup.closed;
          } catch {
            closed = true;
          }
          if (closed) {
            window.removeEventListener("focus", onFocus);
            setConnecting(false);
          }
        }, 100);
      };
      window.addEventListener("focus", onFocus);
    } catch (err) {
      setConnecting(false);
      toast({
        title: "Couldn't start OAuth",
        description: toUserFacingError(err),
        variant: "destructive",
      });
    }
  }, [provider, providerConfigured, prefields, prefieldValues]);

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
            title: "Token revoked",
            description: "Reconnect to keep syncing.",
            variant: "destructive",
          });
        } else {
          toast({ title: "Already up to date", description: "No new items." });
        }
        refresh();
      } catch (err) {
        toast({ title: "Sync failed", description: toUserFacingError(err), variant: "destructive" });
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
        toast({ title: "Update failed", description: toUserFacingError(err), variant: "destructive" });
      }
    },
    [refresh],
  );

  const handleDisconnect = useCallback(
    async (conn) => {
      if (
        !confirm(
          `Disconnect ${connector.name} (${conn.account_handle || conn.account_display_name})? Items already in your vault stay.`,
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
        toast({ title: "Delete failed", description: toUserFacingError(err), variant: "destructive" });
      }
    },
    [connector?.name, refresh],
  );

  if (!connector) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-lg max-h-[88dvh] overflow-y-auto sm:w-full">
        <DialogHeader className="sr-only">
          <DialogTitle>{connector.name}</DialogTitle>
          <DialogDescription>{connector.summary}</DialogDescription>
        </DialogHeader>

        <ConnectorDetailHeader
          name={connector.name}
          domain={connector.domain}
          tagline={connector.summary}
          description={connector.description}
          developer={connector.developer || connector.name}
          tools={connector.pulls}
          toolsLabel="What LYKN reads"
          toolsNote="Read-only. No posts, edits, follows, or DMs. You can disconnect any time."
          connectorUrl={connector.domain ? `https://${connector.domain}` : undefined}
          author={connector.developer || connector.name}
          trustNote={`LYKN connects to ${connector.name} with read-only access to the items below. Nothing is posted or changed on your behalf, and you can disconnect at any time.`}
        />

        {/* ── Provider not configured fallback ─────────────── */}
        {!providerConfigured && (
          <div className="rounded-xl border border-amber-300 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5 text-[12px] text-amber-900 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-[2px] flex-shrink-0" />
            <span>
              <strong>Not configured on the server.</strong> Set{" "}
              <code className="px-1 rounded bg-amber-100 dark:bg-amber-900/30 text-[11px]">
                {provider.toUpperCase()}_CLIENT_ID
              </code>{" "}
              and{" "}
              <code className="px-1 rounded bg-amber-100 dark:bg-amber-900/30 text-[11px]">
                {provider.toUpperCase()}_CLIENT_SECRET
              </code>{" "}
              in <code>.env</code>, then restart the API.
            </span>
          </div>
        )}

        {/* ── Pre-fields (e.g. Mastodon's instance picker) ──── */}
        {prefields.length > 0 && (
          <div className="space-y-3">
            {prefields.map((f) => (
              <div key={f.name} className="space-y-1">
                <label
                  htmlFor={`oauth-pre-${provider}-${f.name}`}
                  className="text-[11.5px] font-medium text-black/70 dark:text-white/75"
                >
                  {f.label}
                  {f.required === false ? (
                    <span className="ml-1 text-black/40 dark:text-white/40">(optional)</span>
                  ) : null}
                </label>
                <input
                  id={`oauth-pre-${provider}-${f.name}`}
                  type="text"
                  value={prefieldValues[f.name] || ""}
                  onChange={(e) =>
                    setPrefieldValues((v) => ({ ...v, [f.name]: e.target.value }))
                  }
                  placeholder={f.placeholder || ""}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-zinc-900 px-3 py-2 text-[13px] text-black/90 dark:text-white/90 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-black/30 dark:focus:border-white/30"
                />
                {f.helpText && (
                  <p className="text-[10.5px] text-black/50 dark:text-white/50 leading-relaxed">
                    {f.helpText}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Already connected accounts ───────────────────── */}
        {myConnections.length > 0 ? (
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
            <button
              type="button"
              onClick={handleConnect}
              disabled={!providerConfigured || connecting}
              className="w-full mt-1 h-9 rounded-lg border border-dashed border-black/15 dark:border-white/15 text-[12px] text-black/55 dark:text-white/55 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              {connecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUpRight className="h-3.5 w-3.5" />
              )}
              Add another {connector.name} account
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            disabled={!providerConfigured || connecting}
            className="w-full h-10 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[13px] font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2 shadow-sm hover:opacity-90 transition-opacity"
          >
            {connecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUpRight className="h-4 w-4" />
            )}
            Connect {connector.name}
          </button>
        )}

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
          @{conn.account_handle || conn.account_display_name || conn.provider_user_id}
        </div>
        <div className="text-[10.5px] text-black/45 dark:text-white/45 truncate">
          {conn.total_synced_count || 0} item{(conn.total_synced_count || 0) === 1 ? "" : "s"}
          {" · "}
          {conn.last_synced_at ? `synced ${relativeTime(conn.last_synced_at)}` : "never synced"}
          {isReauth && " · needs reconnect"}
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
