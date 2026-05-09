import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  RefreshCw,
  Sparkles,
  ShieldAlert,
  Trash2,
  Loader2,
  Plug,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import {
  OUTBOUND_TARGETS,
  OUTBOUND_INSTALL_TYPES,
} from "@/lib/connectors/outboundTargets";
import UseLyknWithDialog from "@/components/connections/UseLyknWithDialog";

/**
 * UseLyknWithSection — the "outbound" half of the Connections page.
 *
 * Renders:
 *   1. A row of cards, one per outbound target (Claude Desktop, Cursor,
 *      Claude Code, ChatGPT placeholder, Other).
 *   2. A "Connected clients" table listing every active MCP token the
 *      user has issued, with last-used telemetry and a revoke button.
 *
 * Sibling to (not nested inside) the existing inbound `<ConnectorCard>`
 * grid — directionality is the whole point. catalog.js + ConnectorCard
 * answer "what flows INTO LYKN?". This file answers "what reaches OUT
 * of LYKN into your existing AI tools?".
 */
export default function UseLyknWithSection({ user }) {
  const [active, setActive] = useState(null); // outbound target object when dialog open
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setTokens([]);
      return;
    }
    setLoading(true);
    try {
      const res = await authedFetch("/api/v1/synthesis/tokens");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTokens(Array.isArray(data?.tokens) ? data.tokens : []);
    } catch {
      // Silent — don't spam toasts on transient connectivity hiccups.
      // The user can retry by clicking refresh.
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRevoke = useCallback(
    async (token) => {
      if (!token) return;
      const labelHint = token.label || token.client_kind || "this token";
      if (!confirm(`Revoke ${labelHint}? Any AI client using it returns 401 immediately.`)) {
        return;
      }
      setRevokingId(token.id);
      try {
        const res = await authedFetch(`/api/v1/synthesis/tokens/${token.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        toast({ title: "Token revoked", description: `${labelHint} can no longer reach LYKN.` });
        refresh();
      } catch (err) {
        toast({
          title: "Couldn't revoke",
          description: err?.message || "Try again in a moment.",
          variant: "destructive",
        });
      } finally {
        setRevokingId(null);
      }
    },
    [refresh],
  );

  const activeTokens = useMemo(
    () => tokens.filter((t) => t.status === "active"),
    [tokens],
  );

  return (
    <section className="mt-12">
      <div className="flex items-end justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 className="text-[16px] font-semibold tracking-tight text-black/85 dark:text-white/90 inline-flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            Use LYKN with your AI
          </h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-black/55 dark:text-white/60">
            The other direction. Hook LYKN's synthesis layer (your beliefs, rules, facts, vault)
            into the AI tools you already use — Claude Desktop, Claude Code, Cursor, and anything
            else that speaks MCP. One token per device, revocable any time.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-black/10 dark:border-white/15 px-2.5 py-1 text-[11px] font-medium text-black/65 dark:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </div>

      {/* ── Outbound target cards ───────────────────────── */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {OUTBOUND_TARGETS.map((target) => (
          <OutboundCard
            key={target.id}
            target={target}
            onLaunch={() => {
              if (!user) {
                toast({
                  title: "Sign in to mint a token",
                  description: "Tokens are tied to your LYKN account.",
                });
                return;
              }
              if (target.comingSoon) {
                toast({
                  title: `${target.name} support is on the way`,
                  description: target.summary,
                });
                return;
              }
              setActive(target);
            }}
          />
        ))}
      </div>

      {/* ── Connected clients table ───────────────────── */}
      <div className="mt-8">
        <h3 className="text-[13px] font-semibold tracking-tight text-black/80 dark:text-white/85 mb-2">
          Connected clients
        </h3>
        {!user ? (
          <p className="text-[11.5px] text-black/55 dark:text-white/55">
            Sign in to see clients you've connected.
          </p>
        ) : activeTokens.length === 0 ? (
          <div className="rounded-xl border border-dashed border-black/10 dark:border-white/15 bg-white/30 dark:bg-zinc-900/30 p-4 text-[11.5px] text-black/55 dark:text-white/55">
            No clients connected yet. Mint a token from one of the cards above to see it land here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-black/[0.06] dark:border-white/10 bg-white/40 dark:bg-zinc-900/40">
            <table className="w-full text-[11.5px]">
              <thead className="bg-black/[0.03] dark:bg-white/[0.04] text-black/55 dark:text-white/60">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Label</th>
                  <th className="text-left font-medium px-3 py-2 hidden sm:table-cell">Client</th>
                  <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Last used</th>
                  <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">From</th>
                  <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Scopes</th>
                  <th className="text-right font-medium px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeTokens.map((t) => (
                  <tr
                    key={t.id}
                    className="border-t border-black/[0.04] dark:border-white/[0.06]"
                  >
                    <td className="px-3 py-2 text-black/85 dark:text-white/90">
                      <div className="flex flex-col">
                        <span className="font-medium">{t.label || "AI client"}</span>
                        <code className="text-[10px] text-black/45 dark:text-white/50 font-mono">
                          {t.token_prefix || "—"}
                        </code>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-black/65 dark:text-white/70 hidden sm:table-cell">
                      {clientKindLabel(t.client_kind)}
                    </td>
                    <td className="px-3 py-2 text-black/55 dark:text-white/60 hidden md:table-cell">
                      {relativeTime(t.last_used_at)}
                    </td>
                    <td className="px-3 py-2 text-black/45 dark:text-white/50 hidden lg:table-cell max-w-[200px] truncate" title={t.last_used_client || ""}>
                      {t.last_used_client || "—"}
                    </td>
                    <td className="px-3 py-2 text-black/55 dark:text-white/60 hidden md:table-cell">
                      <span className="text-[10.5px] inline-flex items-center gap-1">
                        {(t.scopes || []).join(", ") || "read"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleRevoke(t)}
                        disabled={revokingId === t.id}
                        className="inline-flex items-center gap-1 rounded-md border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 px-2 py-1 text-[10.5px] font-medium text-red-700 dark:text-red-300 disabled:opacity-50"
                      >
                        {revokingId === t.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[10.5px] text-black/40 dark:text-white/40 leading-relaxed">
          Tokens are stored as SHA-256 hashes; the plaintext is shown once at creation and never persisted.
          Revoking a token returns 401 to that client immediately — usage telemetry is kept for audit.
        </p>
      </div>

      <UseLyknWithDialog
        open={Boolean(active)}
        onOpenChange={(o) => {
          if (!o) {
            setActive(null);
            // After closing the dialog (token was minted) — refresh
            // the list so the new token appears in Connected Clients.
            refresh();
          }
        }}
        target={active}
        onMinted={() => refresh()}
      />
    </section>
  );
}

// ─── OutboundCard ────────────────────────────────────────────────────────

function OutboundCard({ target, onLaunch }) {
  const installMeta = OUTBOUND_INSTALL_TYPES[target.installType] || OUTBOUND_INSTALL_TYPES.raw;
  const ctaDisabled = Boolean(target.comingSoon);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="group relative rounded-2xl border border-black/[0.06] dark:border-white/10 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md p-4 flex flex-col gap-3 hover:border-black/15 dark:hover:border-white/20 transition-colors shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
          <OutboundFavicon target={target} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[13px] font-semibold text-black/85 dark:text-white/90 truncate">
              {target.name}
            </h3>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10px] font-medium ${toneClass(installMeta.tone)}`}
            >
              {installMeta.label}
            </span>
            {target.comingSoon && (
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-400 px-2 py-[2px] text-[10px] font-medium">
                Soon
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-black/55 dark:text-white/55 line-clamp-3">
            {target.summary}
          </p>
        </div>
      </div>

      <div className="text-[10px] text-black/45 dark:text-white/45">
        Transport: {target.transport}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-2 border-t border-black/[0.05] dark:border-white/[0.06]">
        <div className="text-[10px] text-black/40 dark:text-white/40 inline-flex items-center gap-1">
          <Plug className="h-3 w-3" />
          MCP / REST
        </div>
        <button
          type="button"
          onClick={onLaunch}
          disabled={ctaDisabled}
          className={`text-[11px] font-medium rounded-full px-3 py-1 transition-colors ${
            ctaDisabled
              ? "bg-black/[0.04] dark:bg-white/[0.06] text-black/40 dark:text-white/40 cursor-not-allowed"
              : "bg-black text-white dark:bg-white dark:text-black hover:opacity-90"
          }`}
        >
          {ctaDisabled ? "Coming soon" : "Connect"}
          {!ctaDisabled && <ArrowUpRight className="h-3 w-3 inline ml-1 -mt-[1px]" />}
        </button>
      </div>
    </motion.div>
  );
}

function OutboundFavicon({ target }) {
  const [attempt, setAttempt] = useState(0);
  const candidates = target.domain
    ? [
        `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(target.domain)}`,
        `https://icons.duckduckgo.com/ip3/${target.domain}.ico`,
      ]
    : [];
  if (!candidates.length || attempt >= candidates.length) {
    return <ShieldAlert className="h-5 w-5 text-black/55 dark:text-white/65" strokeWidth={1.75} />;
  }
  return (
    <img
      key={attempt}
      src={candidates[attempt]}
      alt={`${target.name} logo`}
      width={28}
      height={28}
      loading="lazy"
      decoding="async"
      onError={() => setAttempt((a) => a + 1)}
      className="block object-contain"
      style={{ width: 28, height: 28 }}
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const TONE_CLASSES = {
  emerald:
    "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  blue: "bg-blue-500/12 text-blue-700 dark:text-blue-400 border-blue-500/20",
  amber:
    "bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/20",
  neutral:
    "bg-black/[0.04] text-black/55 dark:bg-white/[0.06] dark:text-white/55 border-black/[0.06] dark:border-white/[0.08]",
};

function toneClass(tone) {
  return TONE_CLASSES[tone] || TONE_CLASSES.neutral;
}

function clientKindLabel(kind) {
  switch (kind) {
    case "claude-desktop": return "Claude Desktop";
    case "claude-code":    return "Claude Code";
    case "cursor":         return "Cursor";
    case "chatgpt":        return "ChatGPT";
    default:               return "Other";
  }
}

function relativeTime(iso) {
  if (!iso) return "Never";
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
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}

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
