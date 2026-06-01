import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, CheckCircle2, ChevronDown, Code2, Plug, ShieldAlert, Loader2, Search, X } from "lucide-react";
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
import VaultConnectionsToggle from "@/components/connections/VaultConnectionsToggle";

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

// AI Tools subgrouping. The flat list of 13 tier-1 outbound targets
// (Claude / ChatGPT / Cursor / Windsurf / JetBrains / Copilot / …)
// reads as a wall when the user lands on the Connections page,
// especially inside a chat where this grid takes ~half the surface
// area. Split into three intent-driven buckets so each one stays
// scannable, and collapse all but the first few per bucket behind a
// "Show all" pill so the section keeps a fixed initial height. Search
// auto-expands every bucket (see `visibleTiles`).
//
// `clientKinds` references the `clientKind` field on each target in
// `outboundTargets.js`. A target whose clientKind isn't listed in any
// bucket lands in `coding` as a fallback (current tier-1 lineup has
// no such target — every entry is mapped explicitly — but the
// fallback keeps the page resilient to future catalog additions).
const AI_SUBGROUPS = [
  {
    id: "chat",
    label: "Chat",
    description: "Conversational assistants — your synthesis layer follows you in.",
    clientKinds: new Set(["claude", "chatgpt", "gemini", "grok"]),
  },
  {
    id: "coding",
    label: "Coding",
    description: "IDEs, agents, and app-builders that should know your code context.",
    clientKinds: new Set([
      "claude-code",
      "cursor",
      "codex-cli",
      "windsurf",
      "jetbrains",
      "replit",
      "lovable",
      "github-copilot",
    ]),
  },
  {
    id: "docs",
    label: "Docs & Knowledge",
    description: "Writing surfaces that benefit from your beliefs and recent work.",
    clientKinds: new Set(["notion-ai"]),
  },
];
const AI_SUBGROUP_DEFAULT_VISIBLE = 3;
function aiSubgroupIdFor(target) {
  for (const g of AI_SUBGROUPS) {
    if (g.clientKinds.has(target.clientKind)) return g.id;
  }
  return "coding";
}

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

// Two "universal" tiles that lead the AI Tools section. Same AppTile
// shape as every other card; pinned to the top of the AI bucket so the
// honest framing — "you don't need a per-tool integration to use any
// modern AI client" — is the first thing the user sees, ahead of the
// curated shortcuts.
//
// `buildTarget(base)` synthesises the OUTBOUND_TARGETS row passed to
// UseLyknWithDialog. We START from a real catalog entry (so the dialog
// inherits color / domain / helpUrl) but OVERRIDE the framing so the
// universal flow doesn't bleed dev-facing labels ("Anything else (raw)",
// "Custom Agent") into the user surface. The MCP tile in particular
// pivots from the catalog entry's `installType: "raw"` (paste a bearer
// into your config) to `oauth-mcp` + `connectMode: "copy-only"` — the
// same OAuth/DCR flow Claude/Cursor/etc. use, because virtually every
// actively-maintained MCP client now supports it. The API tile keeps
// the `custom-agent` install path (token mint + code snippets) since
// developer-written agents legitimately want an embedded bearer.
const UNIVERSAL_AI_TILES = [
  {
    key: "ai-universal:mcp",
    targetId: "other-mcp",
    name: "Any AI tool via MCP",
    description:
      "Use LYKN inside any MCP-aware client — Claude Desktop, Cursor, Zed, Cline, Goose, Warp, Jan, Continue, or whatever ships next. Paste our MCP URL into the client's server config; it handles the OAuth handshake itself. No token to copy, nothing per-app to wire.",
    iconNode: Plug,
    accentClass: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 ring-indigo-500/20",
    buildTarget: (base) => ({
      ...base,
      name: "any MCP client",
      summary:
        "Paste LYKN's MCP URL into any MCP-aware client (Claude Desktop, Cursor, Zed, Cline, Goose, Warp, Jan, Continue, …). The client handles OAuth itself — you'll approve a LYKN consent screen, no bearer token to copy.",
      installType: "oauth-mcp",
      connectMode: "copy-only",
      installSteps: [
        "Open your MCP client (Claude Desktop, Cursor, Zed, Cline, Goose, Warp, Jan, Continue, …).",
        "Find its MCP server config — usually Settings → MCP, or a JSON file like ~/.cursor/mcp.json or ~/.config/cline/mcp_settings.json.",
        "Add a new server using the URL above as the endpoint. Save / reload.",
        "Approve the LYKN consent screen when your client pops it.",
      ],
    }),
  },
  {
    key: "ai-universal:api",
    targetId: "custom-agent",
    name: "Build with the LYKN API",
    description:
      "Wire LYKN into something you built yourself — LangChain, n8n, Vapi, a FastAPI service, a robot. Mint one bearer here, then call our REST endpoints (or MCP) from any language that speaks HTTP. Read your context block, search your vault, push project state back.",
    iconNode: Code2,
    accentClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 ring-emerald-500/20",
    buildTarget: (base) => ({
      ...base,
      name: "the LYKN API",
      summary:
        "Mint a bearer token and embed it in your own code — LangChain, n8n, Vapi, FastAPI, or any HTTP client. Both the REST mirror and the raw MCP endpoint accept the same token.",
    }),
  },
];

export default function ConnectionsAppGrid({
  user,
  compactPreview = false,
  wakePreview = false,
  onWakePreviewTabChange,
}) {
  const embeddedPreviewMode = compactPreview;
  const showPageHeader = !embeddedPreviewMode && !wakePreview;
  const showToolbar = !embeddedPreviewMode || wakePreview;
  const compactGrid = embeddedPreviewMode && !wakePreview;
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const filterDropdownRef = useRef(null);
  useEffect(() => {
    const onClick = (event) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(event.target)) {
        setShowFilterDropdown(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setShowFilterDropdown(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  const [connections, setConnections] = useState([]);
  const [providerConfig, setProviderConfig] = useState({});
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeAiTarget, setActiveAiTarget] = useState(null);
  const [activeInputConnector, setActiveInputConnector] = useState(null);
  // Per-AI-subgroup expansion. Empty set = every subgroup is collapsed
  // to its first AI_SUBGROUP_DEFAULT_VISIBLE tiles. Clicking the
  // subgroup's "Show all" pill flips it open; the active text-search
  // bypasses this entirely (see `visibleTiles`) so users always see
  // every match regardless of which bucket is collapsed.
  const [expandedAiSubgroups, setExpandedAiSubgroups] = useState(() => new Set());
  const toggleAiSubgroup = useCallback((id) => {
    setExpandedAiSubgroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
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

    const tierOneAi = OUTBOUND_TARGETS.filter((t) => t.tier === 1);
    const aiTargets = tierOneAi;

    if (aiTargets.length > 0 || UNIVERSAL_AI_TILES.length > 0) {
      out.push({
        key: "section:ai",
        kind: "section",
        sectionBucket: "ai",
        label: "AI Tools",
        description: "Use LYKN's synthesis layer inside your AI of choice.",
      });

      // Universal tiles lead the AI Tools section so the honest framing
      // ("one token, every client") is the first thing the user sees —
      // ahead of the curated per-client shortcuts. We resolve the
      // OUTBOUND_TARGETS entry here (not in render) so a renamed id
      // surfaces as a single console warning at construct time rather
      // than a silently-broken tile at click time.
      for (const u of UNIVERSAL_AI_TILES) {
        const base = OUTBOUND_TARGETS.find((t) => t.id === u.targetId);
        if (!base) {
          // eslint-disable-next-line no-console
          console.warn(`[ConnectionsAppGrid] universal tile "${u.key}" references missing target id "${u.targetId}"`);
          continue;
        }
        // Resolve the dialog target NOW (not at click time) so a
        // renamed/missing buildTarget surfaces immediately. Falls back
        // to the bare catalog entry if no override is declared.
        const target = typeof u.buildTarget === "function" ? u.buildTarget(base) : base;
        out.push({
          key: u.key,
          kind: "ai-universal",
          target,
          name: u.name,
          description: u.description,
          iconNode: u.iconNode,
          accentClass: u.accentClass,
        });
      }

      // Bucket each tier-1 target into its subgroup, keeping the
      // catalog ordering within the bucket so curation upstream still
      // wins. Empty buckets are silently dropped so a future change to
      // the catalog (e.g. removing all Docs tools) doesn't leave a
      // dangling subgroup header.
      const bySubgroup = new Map(AI_SUBGROUPS.map((g) => [g.id, []]));
      for (const target of aiTargets) {
        bySubgroup.get(aiSubgroupIdFor(target)).push(target);
      }
      for (const g of AI_SUBGROUPS) {
        const items = bySubgroup.get(g.id) || [];
        if (items.length === 0) continue;
        out.push({
          key: `aiSubgroup:${g.id}`,
          kind: "aiSubgroup",
          subgroupId: g.id,
          label: g.label,
          description: g.description,
          totalInGroup: items.length,
        });
        for (const target of items) {
          out.push({
            key: `ai:${target.id}`,
            kind: "ai",
            target,
            subgroupId: g.id,
          });
        }
      }
    }

    for (const cat of CONNECTOR_CATEGORIES) {
      const connectorsInCat = CONNECTORS.filter((c) => {
        if (c.category !== cat.id) return false;
        if (!CONNECTABLE_INPUT_STATUSES.has(c.status)) return false;
        return true;
      });
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
    // All data sources this memo reads are module-level
    // (OUTBOUND_TARGETS, CONNECTORS, CONNECTOR_CATEGORIES,
    // UNIVERSAL_AI_TILES) so the dep list is intentionally empty —
    // recomputing on every render would just re-allocate identical
    // arrays.
  }, []);

  // Filter: drop tiles outside the current bucket, apply the free-text
  // search to app tiles (section/subgroup headers always pass — they
  // get culled below if their group ends up empty), then drop empty
  // headers, then apply the per-AI-subgroup collapse pass.
  const visibleTiles = useMemo(() => {
    const keepBucket = (t) => {
      if (filter === "all") return true;
      if (filter === "ai") {
        return (
          t.kind === "ai" ||
          t.kind === "ai-universal" ||
          t.kind === "aiSubgroup" ||
          (t.kind === "section" && t.sectionBucket === "ai")
        );
      }
      if (filter === "input") return t.kind === "input" || (t.kind === "section" && t.sectionBucket === "input");
      return true;
    };
    const q = query.trim().toLowerCase();
    const matchesQuery = (t) => {
      if (!q) return true;
      if (t.kind === "section" || t.kind === "aiSubgroup") return true;
      if (t.kind === "ai-universal") {
        return (
          (t.name || "").toLowerCase().includes(q) ||
          (t.description || "").toLowerCase().includes(q) ||
          "mcp".includes(q) ||
          "api".includes(q) ||
          "universal".includes(q) ||
          "ai tool".includes(q)
        );
      }
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

    // Drop empty headers:
    //   • aiSubgroup with no following AI tile from the same subgroup
    //     (means the user's search excluded every entry in this
    //     bucket — hide the heading too).
    //   • section with no following non-header tile at all.
    const noEmpty = [];
    for (let i = 0; i < filtered.length; i++) {
      const t = filtered[i];
      if (t.kind === "section") {
        const next = filtered.slice(i + 1).find(
          (x) => x.kind !== "section" && x.kind !== "aiSubgroup",
        );
        if (!next) continue;
      } else if (t.kind === "aiSubgroup") {
        let hasChild = false;
        for (let j = i + 1; j < filtered.length; j++) {
          const x = filtered[j];
          if (x.kind === "section" || x.kind === "aiSubgroup") break;
          if (x.kind === "ai" && x.subgroupId === t.subgroupId) {
            hasChild = true;
            break;
          }
        }
        if (!hasChild) continue;
      }
      noEmpty.push(t);
    }

    // Active search bypasses the collapse pass — users always see every
    // matching tile regardless of which bucket they're in. Wake preview
    // does the same so the walkthrough grid shows the full lineup (e.g.
    // Grok in Chat) without a "Show N more" pill.
    if (q || wakePreview) return noEmpty;

    // Collapse pass: within each AI subgroup, show only the first
    // AI_SUBGROUP_DEFAULT_VISIBLE tiles, then emit ONE `aiShowMore`
    // pill that toggles `expandedAiSubgroups`. Already-expanded
    // subgroups pass through untouched (sans the pill).
    const out = [];
    const shownPerSubgroup = new Map();
    const totalPerSubgroup = new Map();
    for (const t of noEmpty) {
      if (t.kind === "ai") {
        totalPerSubgroup.set(
          t.subgroupId,
          (totalPerSubgroup.get(t.subgroupId) || 0) + 1,
        );
      }
    }
    for (const t of noEmpty) {
      if (t.kind !== "ai") {
        out.push(t);
        continue;
      }
      const expanded = expandedAiSubgroups.has(t.subgroupId);
      if (expanded) {
        out.push(t);
        continue;
      }
      const shown = shownPerSubgroup.get(t.subgroupId) || 0;
      if (shown < AI_SUBGROUP_DEFAULT_VISIBLE) {
        out.push(t);
        shownPerSubgroup.set(t.subgroupId, shown + 1);
        continue;
      }
      // First tile that overflows the visible cap — emit the
      // single show-all pill, then suppress the rest of this
      // subgroup's tiles. Subsequent overflow tiles fall through
      // to the skip branch below.
      if (shown === AI_SUBGROUP_DEFAULT_VISIBLE) {
        const total = totalPerSubgroup.get(t.subgroupId) || 0;
        out.push({
          key: `aiShowMore:${t.subgroupId}`,
          kind: "aiShowMore",
          subgroupId: t.subgroupId,
          hiddenCount: total - AI_SUBGROUP_DEFAULT_VISIBLE,
        });
        shownPerSubgroup.set(t.subgroupId, shown + 1);
      }
      // else: skip this tile — pill already emitted.
    }
    return out;
  }, [filter, allTiles, query, expandedAiSubgroups, wakePreview]);

  const hasResults = visibleTiles.some((t) => t.kind !== "section");

  const currentFilter = FILTERS.find((f) => f.id === filter) || FILTERS[0];

  return (
    <>
      {/* ── Header + toolbar ───────────────────────────────────────── */}
      {/* Section structure (h1 → description → search row → filter row)
          mirrors the Vault page's section exactly so switching between
          the two surfaces via the inline Vault ↔ Connections toggle
          doesn't reflow the page chrome. Spacing values (`mt-1`, `mt-4`,
          `mb-6`) match VaultNew.jsx 1:1. */}
      <section className={compactGrid ? "h-full overflow-hidden" : "mb-6"}>
        {showPageHeader && (
          <>
        <h1 className="text-3xl font-semibold">Apps</h1>
        <p className="text-black/60 dark:text-white/60 mt-1">
          Everything LYKN can plug into.{" "}
          <strong className="font-semibold text-black/80 dark:text-white/85">AI tools</strong> get
          your synthesis layer injected so every chat picks up where the last left off.{" "}
          <strong className="font-semibold text-black/80 dark:text-white/85">Input tools</strong> feed LYKN the
          evidence that makes your synthesis layer rich. All revocable any time.
        </p>
        {!user && (
          <p className="mt-2 text-[11px] text-black/45 dark:text-white/45" data-preview-hide-signin="true">
            Sign in to connect apps.
          </p>
        )}
          </>
        )}
        {showToolbar && (
        <div className={`flex flex-wrap items-center gap-3 relative z-[400] mt-4`}>
          <div className="relative w-full sm:flex-1 sm:max-w-xl">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-black/35 dark:text-white/35 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search connections — type an app name, category, or keyword"
              aria-label="Search connections"
              className="w-full h-11 rounded-2xl glass-control pl-10 pr-10 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full text-black/45 dark:text-white/45 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-black/70 dark:hover:text-white/80 transition-colors"
              >
                <X className="h-4 w-4" strokeWidth={2.25} />
              </button>
            )}
          </div>
          <div className="relative shrink-0" ref={filterDropdownRef}>
            <button
              type="button"
              onClick={() => setShowFilterDropdown((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-black/65 dark:text-white/65 hover:text-black/90 dark:hover:text-white/90 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            >
              {currentFilter.label}
              <ChevronDown className={`w-3 h-3 transition-transform ${showFilterDropdown ? "rotate-180" : ""}`} />
            </button>
            {showFilterDropdown && (
              <div className="absolute top-full right-0 mt-1 w-44 rounded-xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-[#1c1c1c]/80 backdrop-blur-md shadow-md z-[400] py-1">
                {FILTERS.map((f) => {
                  const active = filter === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => {
                        setFilter(f.id);
                        setShowFilterDropdown(false);
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors ${
                        active ? "text-blue-600 dark:text-blue-400 font-medium" : "text-black/70 dark:text-white/70"
                      }`}
                    >
                      <span className="flex-1 truncate">{f.label}</span>
                      {active && <Check className="w-3 h-3" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {wakePreview && (
            <div className="ml-auto shrink-0">
              <VaultConnectionsToggle
                active="connections"
                onPreviewTabChange={onWakePreviewTabChange}
              />
            </div>
          )}
        </div>
        )}
      </section>

      {/* ── Unified grid ─────────────────────────────────────────── */}
      <div className={`grid gap-2 ${
        compactGrid
          ? "grid-cols-3 pt-0 overflow-hidden"
          : "gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
      }`}>
        {visibleTiles.map((tile) => {
          if (tile.kind === "section") {
            if (compactGrid) return null;
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
          if (tile.kind === "aiSubgroup") {
            if (compactGrid) return null;
            // Subgroup heading sits inside the parent "AI Tools"
            // section. Visually lighter than a section header (less
            // tracking, no caps) so the parent → subgroup hierarchy
            // reads at a glance without two competing all-caps lines.
            const expanded = expandedAiSubgroups.has(tile.subgroupId);
            const showCollapseControl =
              tile.totalInGroup > AI_SUBGROUP_DEFAULT_VISIBLE && expanded;
            return (
              <div key={tile.key} className="col-span-full mt-2 first:mt-0">
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <h3 className="text-[12px] font-semibold text-black/75 dark:text-white/80">
                      {tile.label}
                      <span className="ml-1.5 text-[10.5px] font-medium text-black/40 dark:text-white/40">
                        {tile.totalInGroup}
                      </span>
                    </h3>
                    {tile.description && (
                      <p className="mt-0.5 text-[10.5px] text-black/45 dark:text-white/45">
                        {tile.description}
                      </p>
                    )}
                  </div>
                  {showCollapseControl && (
                    <button
                      type="button"
                      onClick={() => toggleAiSubgroup(tile.subgroupId)}
                      className="text-[10.5px] font-medium text-black/55 dark:text-white/55 hover:text-black/80 dark:hover:text-white/85 transition-colors underline-offset-2 hover:underline shrink-0"
                    >
                      Show less
                    </button>
                  )}
                </div>
              </div>
            );
          }
          if (tile.kind === "aiShowMore") {
            // One pill per collapsed subgroup, spans full grid width so
            // it sits cleanly under the last visible tile rather than
            // wedging into a column. Clicking flips the subgroup to
            // expanded; the parent header gets a matching "Show less"
            // button when it's open (see aiSubgroup branch above).
            return (
              <div key={tile.key} className="col-span-full -mt-1">
                <button
                  type="button"
                  onClick={() => toggleAiSubgroup(tile.subgroupId)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-black/15 dark:border-white/15 px-3 py-1 text-[11px] font-medium text-black/60 dark:text-white/65 hover:text-black/85 dark:hover:text-white/85 hover:border-black/30 dark:hover:border-white/30 transition-colors"
                >
                  Show all {tile.hiddenCount} more
                  <ChevronDown className="w-3 h-3" />
                </button>
              </div>
            );
          }
          if (tile.kind === "ai-universal") {
            // Universal tile: same AppTile shell as every other card,
            // but driven by a lucide icon (no favicon lookup) and a
            // friendlier label. The dialog target was pre-synthesized
            // in `allTiles` (see `buildTarget`) — for the MCP tile
            // that flips the underlying catalog row from a manual-
            // bearer flow to OAuth-MCP, matching how the curated
            // Claude/Cursor/etc. tiles work.
            const target = tile.target;
            const isOauthFlow = target?.installType === "oauth-mcp";
            return (
              <AppTile
                key={tile.key}
                anchorId={tile.key.replace(":", "-")}
                iconNode={tile.iconNode}
                iconAccentClass={tile.accentClass}
                name={tile.name}
                typeLabel="Universal"
                description={tile.description}
                badge={null}
                chips={null}
                ctaLabel={isOauthFlow ? "Connect" : "Set up"}
                ctaVariant="primary"
                onClick={() => {
                  if (!user) {
                    toast({ title: "Sign in to set up", description: "Tokens are tied to your LYKN account." });
                    return;
                  }
                  setActiveAiTarget(target);
                }}
              />
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
                : paidWarning && !wakePreview
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
                    : connector.status === "verification" && !wakePreview
                      ? { tone: "amber", label: connector.statusLabel || "Pending review" }
                      : paidWarning && !wakePreview
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
    </>
  );
}

// ─── AppTile ───────────────────────────────────────────────────────────────

function AppTile({
  anchorId,
  logoDomain,
  logoUrl,
  iconNode,
  iconAccentClass,
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
        {iconNode ? (
          // Universal tiles (or any caller passing iconNode) skip the
          // favicon pipeline entirely — useful when the tile isn't tied
          // to a specific upstream domain. Accent ring/tint differentiates
          // them from the favicon-on-white-square treatment used by
          // every connector-backed tile.
          <div
            className={`h-12 w-12 rounded-2xl flex items-center justify-center flex-shrink-0 ring-1 ${
              iconAccentClass ||
              "bg-black/[0.04] dark:bg-white/[0.06] text-black/70 dark:text-white/80 ring-black/[0.06] dark:ring-white/[0.08]"
            }`}
          >
            {(() => {
              const Icon = iconNode;
              return <Icon className="h-5 w-5" strokeWidth={1.75} />;
            })()}
          </div>
        ) : (
          <div className="h-12 w-12 rounded-2xl flex items-center justify-center flex-shrink-0 bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
            <AppFavicon domain={logoDomain} iconUrl={logoUrl} name={name} />
          </div>
        )}
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
