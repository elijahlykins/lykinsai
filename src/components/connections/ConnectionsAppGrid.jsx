import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, ShieldAlert, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import { CONNECTORS } from "@/lib/connectors/catalog";
import { OUTBOUND_TARGETS } from "@/lib/connectors/outboundTargets";
import OAuthConnectDialog from "@/components/connections/OAuthConnectDialog";
import UseLyknWithDialog from "@/components/connections/UseLyknWithDialog";

// Unified "app store" view for the Connections page. Everything LYKN
// can plug into — AI tools (Claude, Cursor, ChatGPT, …) and input
// tools (Gmail, Notion, Slack, …) — renders as the same tile shape so
// the answer to "what can I connect?" is one glance.
//
// Two data sources behind the scenes:
//   • AI tools  → OUTBOUND_TARGETS (filtered to tier 1 launch lineup),
//                 click opens UseLyknWithDialog (mints an MCP token /
//                 install command).
//   • Input tools → CONNECTORS (filtered to PHASE_1_INPUT_IDS), click
//                   opens OAuthConnectDialog (runs OAuth handshake).
//
// Filter pill at the top swaps between All / AI tools / Input tools.

// Phase 1 input integrations — sync with project state
// `input_integration_roadmap`. Strings reference catalog ids;
// placeholders mark roadmap items whose adapter isn't built yet.
const PHASE_1_INPUT_IDS = [
  "gmail",
  "outlook-365",
  "google-drive",
  { placeholder: true, id: "onedrive", name: "OneDrive", domain: "onedrive.live.com", summary: "Files and folders feed LYKN the shape of your active work." },
  "google-calendar",
  "notion",
  "slack",
  "github",
  "linear",
  { placeholder: true, id: "asana", name: "Asana", domain: "asana.com", summary: "Task ownership and project trees teach LYKN where your week's effort is actually going." },
  "x",
  { placeholder: true, id: "linkedin", name: "LinkedIn", domain: "linkedin.com", summary: "Profile, network activity, and saved posts contribute professional-identity neurons." },
];

const FILTERS = [
  { id: "all", label: "All" },
  { id: "ai", label: "AI tools" },
  { id: "input", label: "Input tools" },
];

// Paid-plan warnings. The two data sources encode this differently, so
// normalize to { title, message } here. Returns null when the upstream
// app is free to use with LYKN.
//
//   • AI tools → explicit `requiresPaidPlan` descriptor on the outbound
//     target (e.g. Lovable Pro $25/mo, Notion Business). Already shaped
//     as { title, message }; pass it through.
//
//   • Input tools → `status: "paid"` flag in the catalog (e.g. X needs
//     API Basic at $200/mo to read bookmarks). Synthesize a warning from
//     `statusLabel` so users see the price before initiating OAuth.
function getAiPaidWarning(target) {
  return target?.requiresPaidPlan || null;
}
function getInputPaidWarning(connector) {
  if (!connector || connector.status !== "paid") return null;
  return {
    title: `${connector.name} requires a paid plan`,
    message: `${connector.statusLabel || "This connection needs a paid tier on the upstream app."} OAuth will still work, but data won't sync until you have an eligible plan. Continue?`,
  };
}

export default function ConnectionsAppGrid({ user }) {
  const [filter, setFilter] = useState("all");
  const [connections, setConnections] = useState([]);
  const [providerConfig, setProviderConfig] = useState({});
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeAiTarget, setActiveAiTarget] = useState(null);
  const [activeInputConnector, setActiveInputConnector] = useState(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setConnections([]);
      setProviderConfig({});
      setTokens([]);
      return;
    }
    setLoading(true);
    try {
      const [connRes, tokRes] = await Promise.all([
        authedFetch("/api/connections"),
        authedFetch("/api/v1/synthesis/tokens"),
      ]);
      if (connRes.ok) {
        const data = await connRes.json();
        setConnections(data.connections || []);
        setProviderConfig(data.providerConfig || {});
      }
      if (tokRes.ok) {
        const data = await tokRes.json();
        setTokens(Array.isArray(data?.tokens) ? data.tokens : []);
      }
    } catch {
      // Silent — the dialogs each have their own load/retry path.
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connectionsByProvider = useMemo(() => {
    const m = new Map();
    for (const c of connections) {
      const arr = m.get(c.provider) || [];
      arr.push(c);
      m.set(c.provider, arr);
    }
    return m;
  }, [connections]);

  const tokensByKind = useMemo(() => {
    const m = new Map();
    for (const t of tokens) {
      if (t.status !== "active") continue;
      const arr = m.get(t.client_kind) || [];
      arr.push(t);
      m.set(t.client_kind, arr);
    }
    return m;
  }, [tokens]);

  // Build the unified tile list. AI tools come first (the marquee),
  // then input tools, both in their curated order.
  const allTiles = useMemo(() => {
    const aiTiles = OUTBOUND_TARGETS.filter((t) => t.tier === 1).map((target) => ({
      key: `ai:${target.id}`,
      kind: "ai",
      target,
    }));

    const inputTiles = PHASE_1_INPUT_IDS.map((entry) => {
      if (typeof entry === "object" && entry.placeholder) {
        return { key: `input:${entry.id}`, kind: "placeholder", placeholder: entry };
      }
      const row = CONNECTORS.find((c) => c.id === entry);
      if (!row) {
        return { key: `input:${entry}`, kind: "placeholder", placeholder: { id: entry, name: entry } };
      }
      return { key: `input:${row.id}`, kind: "input", connector: row };
    });

    return [...aiTiles, ...inputTiles];
  }, []);

  const visibleTiles = useMemo(() => {
    if (filter === "ai") return allTiles.filter((t) => t.kind === "ai");
    if (filter === "input") return allTiles.filter((t) => t.kind === "input" || t.kind === "placeholder");
    return allTiles;
  }, [filter, allTiles]);

  return (
    <section>
      {/* ── Filter pill ───────────────────────────────────────────── */}
      <div className="mb-5 flex items-center gap-1 p-1 rounded-full glass-control w-fit">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${
              filter === f.id
                ? "bg-black text-white dark:bg-white dark:text-black shadow-sm"
                : "text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Unified grid ─────────────────────────────────────────── */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {visibleTiles.map((tile) => {
          if (tile.kind === "ai") {
            const target = tile.target;
            const isConnected = (tokensByKind.get(target.clientKind) || []).length > 0;
            const paidWarning = getAiPaidWarning(target);
            // Connection-status badge takes priority over the paid-plan
            // hint (once connected, the user clearly already had the plan).
            const badge = isConnected
              ? { tone: "emerald", label: "Connected", icon: CheckCircle2 }
              : target.comingSoon
                ? { tone: "amber", label: "Coming soon" }
                : paidWarning
                  ? { tone: "amber", label: paidWarning.shortLabel || `Requires ${target.name} plan` }
                  : null;
            return (
              <AppTile
                key={tile.key}
                logoDomain={target.domain}
                name={target.name}
                typeLabel="AI tool"
                description={target.summary}
                badge={badge}
                ctaLabel={isConnected ? "Manage" : target.comingSoon ? "Notify me" : "Connect"}
                ctaVariant={isConnected ? "ghost" : "primary"}
                onClick={() => {
                  if (!user) {
                    toast({ title: "Sign in to connect", description: "Tokens are tied to your LYKN account." });
                    return;
                  }
                  if (target.comingSoon) {
                    toast({ title: `${target.name} is on the way`, description: target.summary });
                    return;
                  }
                  // Paid-plan gate fires BEFORE opening the dialog so the
                  // user gets one clear "this costs money on the upstream
                  // side" prompt — no surprise wall mid-flow. UseLyknWithDialog
                  // also has its own confirm as a safety net.
                  if (!isConnected && paidWarning) {
                    // eslint-disable-next-line no-alert
                    if (!window.confirm(`${paidWarning.title}\n\n${paidWarning.message}`)) return;
                  }
                  setActiveAiTarget(target);
                }}
              />
            );
          }

          if (tile.kind === "input") {
            const connector = tile.connector;
            const userConns = connectionsByProvider.get(connector.id) || [];
            const isConnected = userConns.some((c) => c.status === "active" || c.status === "paused");
            const isConfigured = providerConfig[connector.id] !== false;
            const paidWarning = getInputPaidWarning(connector);
            const badge = !isConfigured
              ? { tone: "neutral", label: "Not configured" }
              : isConnected
                ? { tone: "emerald", label: "Connected", icon: CheckCircle2 }
                : connector.status === "verification"
                  ? { tone: "amber", label: connector.statusLabel || "Pending review" }
                  : paidWarning
                    ? { tone: "amber", label: connector.statusLabel || `Requires ${connector.name} plan` }
                    : null;
            return (
              <AppTile
                key={tile.key}
                logoDomain={connector.domain}
                name={connector.name}
                typeLabel="Input tool"
                description={connector.summary}
                badge={badge}
                ctaLabel={isConnected ? "Manage" : "Connect"}
                ctaVariant={isConnected ? "ghost" : "primary"}
                onClick={() => {
                  if (!user) {
                    toast({ title: "Sign in to connect", description: "Input tools are tied to your LYKN account." });
                    return;
                  }
                  if (!isConnected && paidWarning) {
                    // eslint-disable-next-line no-alert
                    if (!window.confirm(`${paidWarning.title}\n\n${paidWarning.message}`)) return;
                  }
                  setActiveInputConnector(connector);
                }}
              />
            );
          }

          // Placeholder (adapter not built yet)
          const p = tile.placeholder;
          return (
            <AppTile
              key={tile.key}
              logoDomain={p.domain}
              name={p.name}
              typeLabel="Input tool"
              description={p.summary || "Adapter not wired yet — coming soon."}
              badge={{ tone: "amber", label: "Coming soon" }}
              ctaLabel="Notify me"
              onClick={() => {
                if (!user) {
                  toast({ title: "Sign in to connect", description: "Input tools are tied to your LYKN account." });
                  return;
                }
                toast({
                  title: `${p.name} is on the way`,
                  description: "Adapter not wired yet — we'll light this card up when it lands.",
                });
              }}
            />
          );
        })}
      </div>

      {loading && (
        <p className="mt-3 text-[10.5px] text-black/40 dark:text-white/40 inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading connection status…
        </p>
      )}

      <UseLyknWithDialog
        open={Boolean(activeAiTarget)}
        onOpenChange={(o) => {
          if (!o) {
            setActiveAiTarget(null);
            refresh();
          }
        }}
        target={activeAiTarget}
        onMinted={() => refresh()}
      />
      <OAuthConnectDialog
        open={Boolean(activeInputConnector)}
        onOpenChange={(o) => {
          if (!o) {
            setActiveInputConnector(null);
            refresh();
          }
        }}
        connector={activeInputConnector}
      />
    </section>
  );
}

// ─── AppTile ───────────────────────────────────────────────────────────────

function AppTile({
  logoDomain,
  name,
  typeLabel,
  description,
  badge,
  ctaLabel,
  ctaVariant = "ghost",
  onClick,
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="group relative rounded-2xl border border-black/[0.06] dark:border-white/10 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md p-4 flex flex-col gap-3 hover:border-black/15 dark:hover:border-white/20 transition-colors shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-2xl flex items-center justify-center flex-shrink-0 bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
          <AppFavicon domain={logoDomain} name={name} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[13.5px] font-semibold text-black/85 dark:text-white/90 truncate">
              {name}
            </h3>
            {badge && (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10px] font-medium ${toneClass(badge.tone)}`}
              >
                {badge.icon ? <badge.icon className="h-2.5 w-2.5" /> : null}
                {badge.label}
              </span>
            )}
          </div>
          {typeLabel && (
            <p className="mt-0.5 text-[10.5px] uppercase tracking-wider text-black/40 dark:text-white/40">
              {typeLabel}
            </p>
          )}
        </div>
      </div>
      <p className="text-[11.5px] leading-relaxed text-black/60 dark:text-white/60 line-clamp-3">
        {description}
      </p>
      <div className="mt-auto flex items-center justify-end">
        <button
          type="button"
          onClick={onClick}
          className={`text-[11px] font-medium rounded-full px-3 py-1 transition-colors ${
            ctaVariant === "primary"
              ? "bg-black text-white dark:bg-white dark:text-black hover:opacity-90"
              : "border border-black/10 dark:border-white/15 text-black/65 dark:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          }`}
        >
          {ctaLabel}
        </button>
      </div>
    </motion.div>
  );
}

function AppFavicon({ domain, name }) {
  const [attempt, setAttempt] = useState(0);
  const candidates = domain
    ? [
        `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`,
        `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      ]
    : [];
  if (!candidates.length || attempt >= candidates.length) {
    return <ShieldAlert className="h-6 w-6 text-black/55 dark:text-white/65" strokeWidth={1.75} />;
  }
  return (
    <img
      key={attempt}
      src={candidates[attempt]}
      alt={`${name} logo`}
      width={32}
      height={32}
      loading="lazy"
      decoding="async"
      onError={() => setAttempt((a) => a + 1)}
      className="block object-contain"
      style={{ width: 32, height: 32 }}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const TONE_CLASSES = {
  emerald: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  blue: "bg-blue-500/12 text-blue-700 dark:text-blue-400 border-blue-500/20",
  amber: "bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/20",
  neutral: "bg-black/[0.04] text-black/55 dark:bg-white/[0.06] dark:text-white/55 border-black/[0.06] dark:border-white/[0.08]",
};

function toneClass(tone) {
  return TONE_CLASSES[tone] || TONE_CLASSES.neutral;
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
