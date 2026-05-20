import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, ShieldAlert, Loader2, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import {
  CONNECTORS,
  CONNECTOR_CATEGORIES,
  CONNECTOR_NOTES_SOURCES,
  getConnectorSourceSlugs,
} from "@/lib/connectors/catalog";
import { OUTBOUND_TARGETS, aliasClientKindForCatalog } from "@/lib/connectors/outboundTargets";
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

// The Connections page only renders input connectors whose adapter is
// actually wired in code — even if the upstream gate is still pending.
// That means we INCLUDE:
//   • "available" — live and syncing today.
//   • "beta"      — live first-party capture surfaces (share sheet,
//                   browser extension, bookmarklet, RSS).
//   • "verification" — fully built; blocked on Google brand-verification
//                      review (YouTube, Drive, Docs, Sheets, Calendar,
//                      Gmail). OAuth works for Google Cloud test users
//                      so the tile is still useful to render.
//   • "paid"      — fully built; OAuth works, data sync gated on a paid
//                   upstream tier (X/Twitter bookmarks). Paid-plan
//                   warning is surfaced at click time.
// We EXCLUDE:
//   • "soon"   — no adapter in code yet. Showing these advertises
//                connections we can't actually make.
//   • "no-api" — capture-only surfaces ("How to capture"). Per the
//                product decision, leave these out until we have a
//                clean ingest story for each.
// The catalog itself stays exhaustive; this is just the view filter.
// AI tools (OUTBOUND_TARGETS) are unaffected — their tier 1 curation
// lives upstream.
const CONNECTABLE_INPUT_STATUSES = new Set([
  "available",
  "beta",
  "verification",
  "paid",
]);

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
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [connections, setConnections] = useState([]);
  const [providerConfig, setProviderConfig] = useState({});
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeAiTarget, setActiveAiTarget] = useState(null);
  const [activeInputConnector, setActiveInputConnector] = useState(null);
  // Per-`notes.source` aggregate of (notes, facts, beliefs) so each
  // input tile can show how much of the user's synthesis layer traces
  // back to that one app. Loaded once on mount via the
  // `get_connector_synthesis_counts` RPC; refreshed alongside the
  // connections list so newly-synced items light up the footer.
  // Map<sourceSlug, { notes, facts, beliefs }>
  const [synthesisCounts, setSynthesisCounts] = useState(new Map());

  const refresh = useCallback(async () => {
    if (!user) {
      setConnections([]);
      setProviderConfig({});
      setTokens([]);
      return;
    }
    setLoading(true);
    try {
      const [connRes, tokRes, countsRes] = await Promise.all([
        authedFetch("/api/connections"),
        authedFetch("/api/v1/synthesis/tokens"),
        // Direct supabase RPC — auth.uid() scopes results to this user.
        // Network failure or RLS denial falls through to a zero-counts
        // map so tiles silently omit the footer rather than blocking
        // the page.
        supabase.rpc("get_connector_synthesis_counts"),
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
      if (countsRes && !countsRes.error && Array.isArray(countsRes.data)) {
        const m = new Map();
        for (const row of countsRes.data) {
          if (!row?.connector_source) continue;
          m.set(row.connector_source, {
            notes: Number(row.note_count) || 0,
            facts: Number(row.fact_count) || 0,
            beliefs: Number(row.belief_count) || 0,
          });
        }
        setSynthesisCounts(m);
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

  // For each catalog connector id, sum the (notes, facts, beliefs)
  // across every `notes.source` slug that adapter writes. Most
  // connectors map 1:1 (notion → notion_page) but several emit
  // multiple slugs (Gmail → gmail_starred + gmail_inbox, Mastodon →
  // bookmark + favourite, Drive → starred + slides). Aliased tiles
  // (Google Docs / Sheets) get their *own* slug here so the per-tile
  // footer reflects that app's items only — not the whole Drive pile.
  // Map<connectorId, { notes, facts, beliefs }>
  const synthesisCountsByConnector = useMemo(() => {
    const m = new Map();
    for (const c of CONNECTORS) {
      const slugs = CONNECTOR_NOTES_SOURCES[c.id] || [];
      if (slugs.length === 0) continue;
      let notes = 0;
      let facts = 0;
      let beliefs = 0;
      for (const slug of slugs) {
        const row = synthesisCounts.get(slug);
        if (!row) continue;
        notes += row.notes;
        facts += row.facts;
        beliefs += row.beliefs;
      }
      if (notes > 0 || facts > 0 || beliefs > 0) {
        m.set(c.id, { notes, facts, beliefs });
      }
    }
    return m;
  }, [synthesisCounts]);

  const tokensByKind = useMemo(() => {
    const m = new Map();
    for (const t of tokens) {
      if (t.status !== "active") continue;
      // Alias granular DCR-emitted kinds (claude-web, claude-desktop) to
      // the merged catalog kind (claude) so a token minted via the
      // claude.ai OAuth flow still flips the consolidated Claude tile to
      // "Connected". Without this aliasing, only the granular kinds match
      // and a real Claude OAuth handshake looks unconnected here.
      const kind = aliasClientKindForCatalog(t.client_kind);
      const arr = m.get(kind) || [];
      arr.push(t);
      m.set(kind, arr);
    }
    return m;
  }, [tokens]);

  // Build the unified tile list. AI tools (the marquee) lead, then one
  // section per connector category in CONNECTOR_CATEGORIES order, with
  // every visible connector for that category grouped under it. We
  // iterate categories first (instead of walking the catalog in source
  // order) so a single out-of-order entry — e.g. YouTube sitting in
  // `social` between Notion and the rest of the Google productivity
  // tiles — can't cause the same heading to render twice. Section
  // tiles render as a full-width band inside the grid (col-span-full)
  // and are filtered out when their bucket is empty under the current
  // filter (see `visibleTiles`).
  const allTiles = useMemo(() => {
    const out = [];

    const aiTargets = OUTBOUND_TARGETS.filter((t) => t.tier === 1);
    if (aiTargets.length > 0) {
      out.push({
        key: "section:ai",
        kind: "section",
        sectionBucket: "ai",
        label: "AI Tools",
        description: "Use LYKN's synthesis layer inside your AI of choice.",
      });
      for (const target of aiTargets) {
        out.push({ key: `ai:${target.id}`, kind: "ai", target });
      }
    }

    for (const cat of CONNECTOR_CATEGORIES) {
      const connectorsInCat = CONNECTORS.filter(
        (c) => c.category === cat.id && CONNECTABLE_INPUT_STATUSES.has(c.status),
      );
      if (connectorsInCat.length === 0) continue;
      out.push({
        key: `section:${cat.id}`,
        kind: "section",
        sectionBucket: "input",
        label: cat.label || cat.id,
        description: cat.description,
      });
      for (const connector of connectorsInCat) {
        out.push({ key: `input:${connector.id}`, kind: "input", connector });
      }
    }

    return out;
  }, []);

  // Filter: drop tiles outside the current bucket, apply the free-text
  // search to app tiles (sections always pass — they get culled below
  // if their bucket ends up empty), then drop section headers whose
  // section has no surviving tiles after the filter.
  const visibleTiles = useMemo(() => {
    const keepBucket = (t) => {
      if (filter === "all") return true;
      if (filter === "ai") return t.kind === "ai" || (t.kind === "section" && t.sectionBucket === "ai");
      if (filter === "input") return t.kind === "input" || (t.kind === "section" && t.sectionBucket === "input");
      return true;
    };
    const q = query.trim().toLowerCase();
    const matchesQuery = (t) => {
      if (!q) return true;
      if (t.kind === "section") return true;
      if (t.kind === "ai") {
        const target = t.target;
        return (
          (target.name || "").toLowerCase().includes(q) ||
          (target.summary || "").toLowerCase().includes(q) ||
          (target.clientKind || "").toLowerCase().includes(q) ||
          (target.id || "").toLowerCase().includes(q) ||
          "ai tool".includes(q)
        );
      }
      if (t.kind === "input") {
        const c = t.connector;
        const cat = CONNECTOR_CATEGORIES.find((x) => x.id === c.category);
        return (
          (c.name || "").toLowerCase().includes(q) ||
          (c.summary || "").toLowerCase().includes(q) ||
          (c.id || "").toLowerCase().includes(q) ||
          (c.category || "").toLowerCase().includes(q) ||
          (cat?.label || "").toLowerCase().includes(q) ||
          "input tool".includes(q)
        );
      }
      return false;
    };
    const filtered = allTiles.filter((t) => keepBucket(t) && matchesQuery(t));
    const out = [];
    for (let i = 0; i < filtered.length; i++) {
      const t = filtered[i];
      if (t.kind === "section") {
        const next = filtered[i + 1];
        if (!next || next.kind === "section") continue;
      }
      out.push(t);
    }
    return out;
  }, [filter, allTiles, query]);

  const hasResults = visibleTiles.some((t) => t.kind !== "section");

  return (
    <section>
      {/* ── Toolbar: filter pill + search ─────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 p-1 rounded-full glass-control w-fit">
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
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-black/40 dark:text-white/40"
            strokeWidth={2}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connections…"
            aria-label="Search connections"
            className="w-full rounded-full border border-black/[0.08] dark:border-white/[0.12] bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md pl-8 pr-8 py-1.5 text-[12px] text-black/85 dark:text-white/90 placeholder:text-black/40 dark:placeholder:text-white/40 outline-none focus:border-black/25 dark:focus:border-white/30 transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-black/45 dark:text-white/45 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-black/70 dark:hover:text-white/80 transition-colors"
            >
              <X className="h-3 w-3" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>

      {/* ── Unified grid ─────────────────────────────────────────── */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {visibleTiles.map((tile) => {
          if (tile.kind === "section") {
            return (
              <div key={tile.key} className="col-span-full mt-3 first:mt-0">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-black/55 dark:text-white/55">
                  {tile.label}
                </h2>
                {tile.description && (
                  <p className="mt-0.5 text-[11.5px] text-black/45 dark:text-white/45">
                    {tile.description}
                  </p>
                )}
              </div>
            );
          }
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
                anchorId={target.clientKind || target.id}
                logoDomain={target.domain}
                logoUrl={undefined}
                name={target.name}
                typeLabel="AI tool"
                description={target.summary}
                badge={badge}
                chips={null}
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
            // Alias tiles (e.g. Google Docs → Google Drive) share their
            // parent connector's OAuth handshake and connection row.
            // Resolve to the parent for connection-state lookups and
            // OAuth routing, but keep the alias's own catalog entry for
            // display (logo, name, description).
            const authConnector = connector.aliasOf
              ? CONNECTORS.find((c) => c.id === connector.aliasOf) || connector
              : connector;
            const userConns = connectionsByProvider.get(authConnector.id) || [];
            const isConnected = userConns.some((c) => c.status === "active" || c.status === "paused");
            const isConfigured = providerConfig[authConnector.id] !== false;
            const paidWarning = getInputPaidWarning(connector);
            // Capture-only tiles (Google Keep, Instagram, Figma, …)
            // surface a clear "no programmatic sync available" story.
            // Clicking the tile is informational — it explains the
            // alternate ingest paths (browser extension, share sheet,
            // email-to-vault) rather than opening an OAuth dialog that
            // would just fail.
            const isCaptureOnly = connector.status === "no-api";
            const isComingSoon = connector.status === "soon";
            const badge = isCaptureOnly
              ? { tone: "neutral", label: connector.statusLabel || "Capture only" }
              : isComingSoon
                ? { tone: "amber", label: connector.statusLabel || "Coming soon" }
                : !isConfigured
                  ? { tone: "neutral", label: "Not configured" }
                  : isConnected
                    ? { tone: "emerald", label: "Connected", icon: CheckCircle2 }
                    : connector.status === "verification"
                      ? { tone: "amber", label: connector.statusLabel || "Pending review" }
                      : paidWarning
                        ? { tone: "amber", label: connector.statusLabel || `Requires ${connector.name} plan` }
                        : null;
            // Synthesis-counts footer surfaces the chain of impact for
            // a connected input tool: how many vault notes the adapter
            // has produced, how many user-model facts cite those notes,
            // and how many beliefs were promoted from those facts.
            // Only rendered when the tile is actually connected AND
            // we have at least one non-zero count — unconnected /
            // capture-only tiles stay quiet to avoid clutter.
            const counts =
              isConnected && !isCaptureOnly && !isComingSoon
                ? synthesisCountsByConnector.get(connector.id) || null
                : null;
            // Deep-link targets for each chip. We pass the first slug
            // for the connector (most are 1:1) so the receiving page
            // can filter to that one source. Pages that don't yet read
            // ?source= ignore it harmlessly — the click still lands on
            // the right surface.
            const primarySlug = getConnectorSourceSlugs(connector.id)[0] || "";
            const chips = counts
              ? [
                  {
                    key: "notes",
                    label: `${counts.notes} note${counts.notes === 1 ? "" : "s"}`,
                    onClick: () => navigate(`/vault${primarySlug ? `?source=${encodeURIComponent(primarySlug)}` : ""}`),
                  },
                  ...(counts.facts > 0
                    ? [{
                        key: "facts",
                        label: `${counts.facts} fact${counts.facts === 1 ? "" : "s"}`,
                        onClick: () => navigate(`/synthesis-layer${primarySlug ? `?source=${encodeURIComponent(primarySlug)}&focus=facts` : "?focus=facts"}`),
                      }]
                    : []),
                  ...(counts.beliefs > 0
                    ? [{
                        key: "beliefs",
                        label: `${counts.beliefs} belief${counts.beliefs === 1 ? "" : "s"}`,
                        onClick: () => navigate(`/synthesis-layer${primarySlug ? `?source=${encodeURIComponent(primarySlug)}&focus=beliefs` : "?focus=beliefs"}`),
                      }]
                    : []),
                ]
              : null;
            return (
              <AppTile
                key={tile.key}
                anchorId={connector.id}
                logoDomain={connector.domain}
                logoUrl={connector.iconUrl}
                name={connector.name}
                typeLabel="Input tool"
                description={connector.summary}
                badge={badge}
                chips={chips}
                ctaLabel={
                  isCaptureOnly
                    ? "How to capture"
                    : isComingSoon
                      ? "Notify me"
                      : isConnected
                        ? "Manage"
                        : "Connect"
                }
                ctaVariant={isConnected || isCaptureOnly || isComingSoon ? "ghost" : "primary"}
                onClick={() => {
                  if (!user) {
                    toast({ title: "Sign in to connect", description: "Input tools are tied to your LYKN account." });
                    return;
                  }
                  if (isCaptureOnly) {
                    toast({
                      title: `${connector.name} — capture-only`,
                      description:
                        connector.summary ||
                        "No programmatic API. Use the LYKN browser extension or mobile share sheet to save items one at a time.",
                    });
                    return;
                  }
                  if (isComingSoon) {
                    toast({
                      title: `${connector.name} is on the way`,
                      description:
                        connector.summary ||
                        "Adapter not wired yet — we'll light this card up when it lands.",
                    });
                    return;
                  }
                  if (!isConnected && paidWarning) {
                    // eslint-disable-next-line no-alert
                    if (!window.confirm(`${paidWarning.title}\n\n${paidWarning.message}`)) return;
                  }
                  // For alias tiles we open the dialog against the
                  // parent connector so the OAuth handshake hits the
                  // adapter that actually exists on the server. The
                  // alias's own catalog row has no `/start` endpoint.
                  setActiveInputConnector(authConnector);
                }}
              />
            );
          }

          return null;
        })}
      </div>

      {!hasResults && query.trim() && (
        <div className="mt-6 rounded-2xl border border-dashed border-black/10 dark:border-white/10 p-6 text-center">
          <p className="text-[12.5px] text-black/65 dark:text-white/65">
            No connections match <span className="font-medium text-black/85 dark:text-white/90">“{query.trim()}”</span>.
          </p>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="mt-2 text-[11px] font-medium text-black/55 dark:text-white/55 underline-offset-2 hover:underline hover:text-black/80 dark:hover:text-white/80"
          >
            Clear search
          </button>
        </div>
      )}

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
  anchorId,
  logoDomain,
  logoUrl,
  name,
  typeLabel,
  description,
  badge,
  chips,
  ctaLabel,
  ctaVariant = "ghost",
  onClick,
}) {
  // Lets the load-in greeting's "Connect Google Calendar" prompt (and
  // other deep links of the form /connections#<connector-id>) scroll
  // the matching tile into view and pulse a highlight ring on arrival.
  const ref = useRef(null);
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    if (!anchorId) return;
    const onHash = () => {
      const target = (window.location.hash || "").replace(/^#/, "");
      if (target !== anchorId) return;
      const el = ref.current;
      if (!el) return;
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        el.scrollIntoView();
      }
      setHighlight(true);
      window.setTimeout(() => setHighlight(false), 2400);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [anchorId]);

  return (
    <motion.div
      ref={ref}
      id={anchorId}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`group relative rounded-2xl border bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md p-4 flex flex-col gap-3 transition-colors shadow-sm scroll-mt-24 ${
        highlight
          ? "border-emerald-400/70 ring-2 ring-emerald-400/40 shadow-[0_0_24px_rgba(16,185,129,0.25)]"
          : "border-black/[0.06] dark:border-white/10 hover:border-black/15 dark:hover:border-white/20"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-2xl flex items-center justify-center flex-shrink-0 bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
          <AppFavicon domain={logoDomain} iconUrl={logoUrl} name={name} />
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
      {chips && chips.length > 0 && (
        <div
          className="flex items-center gap-1.5 flex-wrap"
          aria-label={`${name} synthesis impact`}
        >
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                chip.onClick?.();
              }}
              className="inline-flex items-center rounded-full border border-black/[0.08] dark:border-white/[0.12] bg-black/[0.03] dark:bg-white/[0.04] px-2 py-[2px] text-[10.5px] font-medium text-black/65 dark:text-white/65 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-black/85 dark:hover:text-white/85 transition-colors"
              title={`Open ${chip.label}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
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

function AppFavicon({ domain, iconUrl, name }) {
  const [attempt, setAttempt] = useState(0);
  // Prefer an explicit catalog-level `iconUrl` over the S2 favicon
  // service. Google Workspace apps in particular need this — S2 returns
  // the same generic Google "G" for docs.google.com / sheets.google.com /
  // mail.google.com, so all the Google tiles end up looking identical.
  // Falling through to the favicon services keeps every other connector
  // working with no per-connector config.
  const candidates = [];
  if (iconUrl) candidates.push(iconUrl);
  if (domain) {
    candidates.push(`https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`);
    candidates.push(`https://icons.duckduckgo.com/ip3/${domain}.ico`);
  }
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
