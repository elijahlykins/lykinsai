import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, ChevronLeft, Code2, KeyRound, Plug, ShieldAlert, Loader2, Search, X } from "lucide-react";
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
import { CUSTOM_API_PRESETS } from "@/lib/connectors/customApiPresets";
import OAuthConnectDialog from "@/components/connections/OAuthConnectDialog";
import TokenConnectDialog from "@/components/connections/TokenConnectDialog";
import CustomApiDialog from "@/components/connections/CustomApiDialog";
import UseLyknWithDialog from "@/components/connections/UseLyknWithDialog";
import VaultConnectionsToggle from "@/components/connections/VaultConnectionsToggle";

// Unified "app store" view for the Connections page. Everything LYKN
// can plug into - AI tools (Claude, Cursor, ChatGPT, …) and input
// tools (Gmail, Notion, Slack, …) - renders as the same tile shape so
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
// actually wired in code - even if the upstream gate is still pending.
// That means we INCLUDE:
//   • "available" - live and syncing today.
//   • "beta"      - live first-party capture surfaces (share sheet,
//                   browser extension, bookmarklet, RSS).
//   • "verification" - fully built; blocked on Google brand-verification
//                      review (YouTube, Drive, Docs, Sheets, Calendar,
//                      Gmail). OAuth works for Google Cloud test users
//                      so the tile is still useful to render.
//   • "paid"      - fully built; OAuth works, data sync gated on a paid
//                   upstream tier (X/Twitter bookmarks). Paid-plan
//                   warning is surfaced at click time.
// We EXCLUDE:
//   • "soon"   - no adapter in code yet. Showing these advertises
//                connections we can't actually make.
//   • "no-api" - capture-only surfaces ("How to capture"). Per the
//                product decision, leave these out until we have a
//                clean ingest story for each.
// The catalog itself stays exhaustive; this is just the view filter.
// AI tools (OUTBOUND_TARGETS) are unaffected - their tier 1 curation
// lives upstream.
const CONNECTABLE_INPUT_STATUSES = new Set([
  "available",
  "beta",
  "verification",
  "paid",
]);

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
// no such target - every entry is mapped explicitly - but the
// fallback keeps the page resilient to future catalog additions).
const AI_SUBGROUPS = [
  {
    id: "chat",
    label: "Chat",
    description: "Conversational assistants - your synthesis layer follows you in.",
    clientKinds: new Set(["claude", "chatgpt", "gemini", "grok"]),
    // Always show every chat client (no "Show 1 more" pill) - the list is
    // short and Grok shouldn't hide behind a collapse.
    noCollapse: true,
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

// Two "universal" tiles that lead the "Use LYKN elsewhere" section. Same
// AppTile shape as every other card; pinned to the top so the honest
// framing - "you don't need a per-tool integration to use any
// modern AI client" - is the first thing the user sees, ahead of the
// curated shortcuts.
//
// `buildTarget(base)` synthesises the OUTBOUND_TARGETS row passed to
// UseLyknWithDialog. We START from a real catalog entry (so the dialog
// inherits color / domain / helpUrl) but OVERRIDE the framing so the
// universal flow doesn't bleed dev-facing labels ("Anything else (raw)",
// "Custom Agent") into the user surface. The MCP tile in particular
// pivots from the catalog entry's `installType: "raw"` (paste a bearer
// into your config) to `oauth-mcp` + `connectMode: "copy-only"` - the
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
      "Use LYKN inside any MCP-aware client - Claude Desktop, Cursor, Zed, Cline, Goose, Warp, Jan, Continue, or whatever ships next. Paste our MCP URL into the client's server config; it handles the OAuth handshake itself. No token to copy, nothing per-app to wire.",
    iconNode: Plug,
    accentClass: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 ring-indigo-500/20",
    buildTarget: (base) => ({
      ...base,
      name: "any MCP client",
      summary:
        "Paste LYKN's MCP URL into any MCP-aware client (Claude Desktop, Cursor, Zed, Cline, Goose, Warp, Jan, Continue, …). The client handles OAuth itself - you'll approve a LYKN consent screen, no bearer token to copy.",
      installType: "oauth-mcp",
      connectMode: "copy-only",
      installSteps: [
        "Open your MCP client (Claude Desktop, Cursor, Zed, Cline, Goose, Warp, Jan, Continue, …).",
        "Find its MCP server config - usually Settings → MCP, or a JSON file like ~/.cursor/mcp.json or ~/.config/cline/mcp_settings.json.",
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
      "Wire LYKN into something you built yourself - LangChain, n8n, Vapi, a FastAPI service, a robot. Mint one bearer here, then call our REST endpoints (or MCP) from any language that speaks HTTP. Read your context block, search your vault, push project state back.",
    iconNode: Code2,
    accentClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 ring-emerald-500/20",
    buildTarget: (base) => ({
      ...base,
      name: "the LYKN API",
      summary:
        "Mint a bearer token and embed it in your own code - LangChain, n8n, Vapi, FastAPI, or any HTTP client. Both the REST mirror and the raw MCP endpoint accept the same token.",
    }),
  },
];

export default function ConnectionsAppGrid({
  user,
  compactPreview = false,
  wakePreview = false,
  onWakePreviewTabChange,
  // When true the grid is rendered inside the Settings dialog. The picker
  // renders inline (not as a fixed overlay) because a `fixed` element nested
  // under Radix's transformed DialogContent anchors to the dialog, not the
  // viewport. Cards stack tighter to fit the narrower surface.
  embedded = false,
  // Embedded only: called when the back button is pressed on the top-level
  // cards view (i.e. leave Connections). The picker has its own back that
  // returns to the cards, so Settings shows just one back button.
  onBack,
}) {
  const embeddedPreviewMode = compactPreview;
  const showPageHeader = !embeddedPreviewMode && !wakePreview && !embedded;
  const compactGrid = embeddedPreviewMode && !wakePreview;
  const navigate = useNavigate();
  const [connections, setConnections] = useState([]);
  const [providerConfig, setProviderConfig] = useState({});
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeAiTarget, setActiveAiTarget] = useState(null);
  const [activeInputConnector, setActiveInputConnector] = useState(null);
  // Token-paste providers (Cursor, Trello, Readwise, …) use a credential-paste
  // dialog rather than the OAuth popup.
  const [activeTokenConnector, setActiveTokenConnector] = useState(null);
  // Universal "Custom API" tile opens its own manage-connections dialog.
  const [customApiOpen, setCustomApiOpen] = useState(false);
  // When a preset card is clicked, the dialog opens straight into that app's
  // form (base URL + auth prefilled, key field ready).
  const [customApiPresetId, setCustomApiPresetId] = useState(null);
  // The page is three launcher cards. "Connect via API" and "Connect via MCP"
  // open a picker modal listing every app reachable that way. `picker` holds
  // which lane is open ("api" | "mcp" | null); `pickerQuery` is its search box.
  const [picker, setPicker] = useState(null);
  const [pickerQuery, setPickerQuery] = useState("");

  // Open the inbound (pull-into-LYKN) flow for a connector, routing to the
  // right dialog: Custom API manager, token-paste, or OAuth popup.
  const openInboundConnector = useCallback((authConnector) => {
    if (!authConnector) return;
    if (authConnector.customApi) {
      setCustomApiOpen(true);
      return;
    }
    if (authConnector.authMode === "token") {
      setActiveTokenConnector(authConnector);
      return;
    }
    setActiveInputConnector(authConnector);
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
        // Direct supabase RPC - auth.uid() scopes results to this user.
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
      // Silent - the dialogs each have their own load/retry path.
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
  // footer reflects that app's items only - not the whole Drive pile.
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
  // order) so a single out-of-order entry - e.g. YouTube sitting in
  // `social` between Notion and the rest of the Google productivity
  // tiles - can't cause the same heading to render twice. Section
  // tiles render as a full-width band inside the grid (col-span-full)
  // and are filtered out when their bucket is empty under the current
  // filter (see `visibleTiles`).
  // Apps reachable via their REST API / OAuth — the "Connect via API" lane.
  // Native connectors first (category order), then BYO-key presets with no
  // native equivalent, then the Custom API catch-all ("connect anything
  // else") last. Module-level data sources → empty dep list.
  const apiLaneTiles = useMemo(() => {
    const tiles = [];
    const nativeIds = new Set();
    for (const cat of CONNECTOR_CATEGORIES) {
      for (const c of CONNECTORS) {
        if (c.category !== cat.id) continue;
        if (c.customApi) continue;
        if (!CONNECTABLE_INPUT_STATUSES.has(c.status)) continue;
        nativeIds.add(c.id);
        tiles.push({ key: `input:${c.id}`, kind: "input", connector: c });
      }
    }
    for (const preset of CUSTOM_API_PRESETS) {
      if (nativeIds.has(preset.id)) continue;
      tiles.push({ key: `preset:${preset.id}`, kind: "preset", preset });
    }
    const customApiConnector = CONNECTORS.find(
      (c) => c.customApi && CONNECTABLE_INPUT_STATUSES.has(c.status),
    );
    if (customApiConnector) {
      tiles.push({ key: `input:${customApiConnector.id}`, kind: "input", connector: customApiConnector });
    }
    return tiles;
  }, []);

  // Tools you use LYKN inside via MCP — the "Connect via MCP" lane. The
  // generic "any MCP client" tile leads, then curated AI clients grouped
  // Chat / Coding / Docs (all shown — the modal has its own search).
  const mcpLaneTiles = useMemo(() => {
    const tiles = [];
    const mcpUniversal = UNIVERSAL_AI_TILES.find((u) => u.key === "ai-universal:mcp");
    if (mcpUniversal) {
      const base = OUTBOUND_TARGETS.find((t) => t.id === mcpUniversal.targetId);
      if (base) {
        const target = typeof mcpUniversal.buildTarget === "function" ? mcpUniversal.buildTarget(base) : base;
        tiles.push({
          key: mcpUniversal.key,
          kind: "ai-universal",
          target,
          name: mcpUniversal.name,
          description: mcpUniversal.description,
          iconNode: mcpUniversal.iconNode,
          accentClass: mcpUniversal.accentClass,
        });
      }
    }
    const aiTargets = OUTBOUND_TARGETS.filter((t) => t.tier === 1);
    const bySubgroup = new Map(AI_SUBGROUPS.map((g) => [g.id, []]));
    for (const target of aiTargets) {
      bySubgroup.get(aiSubgroupIdFor(target)).push(target);
    }
    for (const g of AI_SUBGROUPS) {
      const items = bySubgroup.get(g.id) || [];
      if (items.length === 0) continue;
      tiles.push({ key: `aiSubgroup:${g.id}`, kind: "section", label: g.label, description: g.description });
      for (const target of items) {
        tiles.push({ key: `ai:${target.id}`, kind: "ai", target, subgroupId: g.id });
      }
    }
    return tiles;
  }, []);

  // The "Build with the LYKN API" card opens this target directly (mint a
  // bearer + show code snippets) — it's a single thing, no picker list.
  const buildTarget = useMemo(() => {
    const u = UNIVERSAL_AI_TILES.find((x) => x.key === "ai-universal:api");
    if (!u) return null;
    const base = OUTBOUND_TARGETS.find((t) => t.id === u.targetId);
    if (!base) return null;
    return typeof u.buildTarget === "function" ? u.buildTarget(base) : base;
  }, []);

  // Free-text filter for the picker modal. Section labels always pass; the
  // empty ones get dropped afterward in `pickerTiles`.
  const matchesPickerQuery = useCallback((tile, q) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    if (tile.kind === "section") return true;
    if (tile.kind === "ai-universal") {
      return (
        (tile.name || "").toLowerCase().includes(s) ||
        (tile.description || "").toLowerCase().includes(s) ||
        "mcp".includes(s) ||
        "api".includes(s)
      );
    }
    if (tile.kind === "ai") {
      const t = tile.target;
      return (
        (t.name || "").toLowerCase().includes(s) ||
        (t.summary || "").toLowerCase().includes(s) ||
        (t.clientKind || "").toLowerCase().includes(s) ||
        (t.id || "").toLowerCase().includes(s)
      );
    }
    if (tile.kind === "preset") {
      const p = tile.preset;
      return (
        (p.name || "").toLowerCase().includes(s) ||
        (p.description || "").toLowerCase().includes(s) ||
        (p.id || "").toLowerCase().includes(s)
      );
    }
    if (tile.kind === "input") {
      const c = tile.connector;
      const cat = CONNECTOR_CATEGORIES.find((x) => x.id === c.category);
      return (
        (c.name || "").toLowerCase().includes(s) ||
        (c.summary || "").toLowerCase().includes(s) ||
        (c.id || "").toLowerCase().includes(s) ||
        (cat?.label || "").toLowerCase().includes(s)
      );
    }
    return false;
  }, []);

  // The open lane's tiles, filtered by the modal search, with empty section
  // labels dropped.
  const pickerTiles = useMemo(() => {
    if (!picker) return [];
    const lane = picker === "api" ? apiLaneTiles : mcpLaneTiles;
    const filtered = lane.filter((t) => matchesPickerQuery(t, pickerQuery));
    const out = [];
    for (let i = 0; i < filtered.length; i++) {
      const t = filtered[i];
      if (t.kind === "section") {
        const next = filtered.slice(i + 1).find((x) => x.kind !== "section");
        if (!next) continue;
      }
      out.push(t);
    }
    return out;
  }, [picker, apiLaneTiles, mcpLaneTiles, pickerQuery, matchesPickerQuery]);

  const hasPickerResults = pickerTiles.some((t) => t.kind !== "section");

  // The picker's scrollable grid of app tiles + empty state. Shared by the
  // inline (Settings `embedded`) and modal renders so the tile logic lives in
  // one place.
  const pickerBody = (
    <>
      <div
        className={`grid gap-2 ${
          embedded ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        }`}
      >
        {pickerTiles.map((tile) => {
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
          if (tile.kind === "preset") {
            const p = tile.preset;
            return (
              <AppTile
                key={tile.key}
                anchorId={`preset-${p.id}`}
                logoDomain={p.domain}
                logoUrl={undefined}
                name={p.name}
                typeLabel="Bring your key"
                description={p.keyHint || p.description}
                badge={null}
                chips={null}
                ctaLabel="Connect"
                ctaVariant="primary"
                onClick={() => {
                  if (!user) {
                    toast({ title: "Sign in to connect", description: "Custom API keys are tied to your LYKN account." });
                    return;
                  }
                  setCustomApiPresetId(p.id);
                  setCustomApiOpen(true);
                }}
              />
            );
          }
          if (tile.kind === "ai-universal") {
            // Universal tile: same AppTile shell as every other card,
            // but driven by a lucide icon (no favicon lookup) and a
            // friendlier label. The dialog target was pre-synthesized
            // in `allTiles` (see `buildTarget`) - for the MCP tile
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
                  // side" prompt - no surprise wall mid-flow. UseLyknWithDialog
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
            // Clicking the tile is informational - it explains the
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
            // we have at least one non-zero count - unconnected /
            // capture-only tiles stay quiet to avoid clutter.
            const counts =
              isConnected && !isCaptureOnly && !isComingSoon
                ? synthesisCountsByConnector.get(connector.id) || null
                : null;
            // Deep-link targets for each chip. We pass the first slug
            // for the connector (most are 1:1) so the receiving page
            // can filter to that one source. Pages that don't yet read
            // ?source= ignore it harmlessly - the click still lands on
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
                iconNode={connector.customApi ? KeyRound : undefined}
                iconAccentClass={
                  connector.customApi
                    ? "bg-sky-500/10 text-sky-600 dark:text-sky-400 ring-sky-500/20"
                    : undefined
                }
                name={connector.name}
                typeLabel={connector.customApi ? "Any other app" : undefined}
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
                      title: `${connector.name} - capture-only`,
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
                        "Adapter not wired yet - we'll light this card up when it lands.",
                    });
                    return;
                  }
                  if (!isConnected && paidWarning) {
                    // eslint-disable-next-line no-alert
                    if (!window.confirm(`${paidWarning.title}\n\n${paidWarning.message}`)) return;
                  }
                  // Route to the right connect flow: Custom API manager,
                  // token-paste dialog, or OAuth popup. Alias tiles open
                  // against their parent connector (the alias row has no
                  // /start endpoint of its own).
                  openInboundConnector(authConnector);
                }}
              />
            );
          }

          return null;
        })}
      </div>
      {!hasPickerResults && pickerQuery.trim() && (
        <div className="mt-6 rounded-2xl border border-dashed border-black/10 dark:border-white/10 p-6 text-center">
          <p className="text-[12.5px] text-black/65 dark:text-white/65">
            No matches for <span className="font-medium text-black/85 dark:text-white/90">“{pickerQuery.trim()}”</span>.
          </p>
          <button
            type="button"
            onClick={() => setPickerQuery("")}
            className="mt-2 text-[11px] font-medium text-black/55 dark:text-white/55 underline-offset-2 hover:underline hover:text-black/80 dark:hover:text-white/80"
          >
            Clear search
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <section className={compactGrid ? "h-full overflow-hidden" : "mb-6"}>
        {showPageHeader && (
          <>
            <h1 className="text-3xl font-semibold">Apps</h1>
            <p className="text-black/60 dark:text-white/60 mt-1">
              Three ways to connect.{" "}
              <strong className="font-semibold text-black/80 dark:text-white/85">Connect via API</strong> to let LYKN
              read from and act on the apps you use.{" "}
              <strong className="font-semibold text-black/80 dark:text-white/85">Connect via MCP</strong> to use LYKN
              inside other AI tools. Or{" "}
              <strong className="font-semibold text-black/80 dark:text-white/85">build with the LYKN API</strong>.
              All revocable any time.
            </p>
            {!user && (
              <p className="mt-2 text-[11px] text-black/45 dark:text-white/45" data-preview-hide-signin="true">
                Sign in to connect apps.
              </p>
            )}
          </>
        )}
        {wakePreview && (
          <div className="flex justify-end mt-4">
            <VaultConnectionsToggle
              active="connections"
              onPreviewTabChange={onWakePreviewTabChange}
            />
          </div>
        )}
      </section>

      {/* ── Three launcher cards ───────────────────────────────────── */}
      {/* Inside Settings the inline picker replaces the cards, so hide them
          while a lane is open. */}
      {!(embedded && picker) && (
      <>
      {embedded && onBack && (
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1.5 p-1.5 rounded-md text-black/50 dark:text-white/50 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
            aria-label="Back to settings"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h3 className="text-sm font-semibold text-black/85 dark:text-white/90">Connections</h3>
        </div>
      )}
      <div className="flex flex-col divide-y divide-black/[0.07] dark:divide-white/[0.08] rounded-xl border border-black/[0.07] dark:border-white/[0.08]">
        <LauncherRow
          title="Connect via API"
          description="Connect Google, Slack, Notion, Stripe and more with a sign-in or API key."
          ctaLabel="Browse apps"
          onClick={() => {
            setPickerQuery("");
            setPicker("api");
          }}
        />
        <LauncherRow
          title="Connect via MCP"
          description="Use LYKN inside Claude, Cursor, ChatGPT and any other MCP-aware client."
          ctaLabel="Browse tools"
          onClick={() => {
            setPickerQuery("");
            setPicker("mcp");
          }}
        />
        <LauncherRow
          title="Build with the LYKN API"
          description="Mint a token and wire LYKN into your own code, agents or automations."
          ctaLabel="Get a token"
          onClick={() => {
            if (!user) {
              toast({ title: "Sign in to build", description: "API tokens are tied to your LYKN account." });
              return;
            }
            if (buildTarget) setActiveAiTarget(buildTarget);
          }}
        />
      </div>
      </>
      )}

      {/* ── Picker (Connect via API / MCP) ─────────────────────────── */}
      {/* Inline inside Settings (`embedded`); a centered modal otherwise. */}
      {picker && (
        embedded ? (
          <div className="mt-5">
            <div className="flex items-center gap-2 mb-1">
              <button
                type="button"
                onClick={() => setPicker(null)}
                className="-ml-1.5 p-1.5 rounded-md text-black/50 dark:text-white/50 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                aria-label="Back to connection options"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <h3 className="text-sm font-semibold text-black/85 dark:text-white/90">
                {picker === "api" ? "Connect via API" : "Connect via MCP"}
              </h3>
            </div>
            <p className="ml-1 mb-3 text-[12px] text-black/55 dark:text-white/55">
              {picker === "api"
                ? "Pick an app. We'll walk you through connecting it."
                : "Pick a tool to use LYKN inside. We'll walk you through the setup."}
            </p>
            <div className="relative mb-3">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-black/35 dark:text-white/35 pointer-events-none" />
              <input
                type="search"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder={picker === "api" ? "Search apps…" : "Search tools…"}
                aria-label="Search"
                autoFocus
                className="w-full h-10 rounded-xl glass-control pl-10 pr-3 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
              />
            </div>
            {pickerBody}
          </div>
        ) : (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={picker === "api" ? "Connect via API" : "Connect via MCP"}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setPicker(null)} />
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="relative w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-xl"
          >
            <div className="p-4 border-b border-black/[0.06] dark:border-white/10">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[16px] font-semibold text-black/85 dark:text-white/90">
                    {picker === "api" ? "Connect via API" : "Connect via MCP"}
                  </h2>
                  <p className="mt-0.5 text-[12px] text-black/55 dark:text-white/55">
                    {picker === "api"
                      ? "Pick an app. We'll walk you through connecting it."
                      : "Pick a tool to use LYKN inside. We'll walk you through the setup."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPicker(null)}
                  className="p-1 rounded-md text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="relative mt-3">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-black/35 dark:text-white/35 pointer-events-none" />
                <input
                  type="search"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder={picker === "api" ? "Search apps…" : "Search tools…"}
                  aria-label="Search"
                  autoFocus
                  className="w-full h-10 rounded-xl glass-control pl-10 pr-3 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
                />
              </div>
            </div>
            <div className="p-4 overflow-y-auto">
              {pickerBody}
            </div>
          </motion.div>
        </div>
        )
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
      <TokenConnectDialog
        open={Boolean(activeTokenConnector)}
        onOpenChange={(o) => {
          if (!o) {
            setActiveTokenConnector(null);
            refresh();
          }
        }}
        connector={activeTokenConnector}
      />
      <CustomApiDialog
        open={customApiOpen}
        initialPresetId={customApiPresetId}
        onOpenChange={(o) => {
          if (!o) {
            setCustomApiOpen(false);
            setCustomApiPresetId(null);
            refresh();
          }
        }}
      />
    </>
  );
}

// ─── LauncherRow ─────────────────────────────────────────────────────────────
// One of the three top-level connection options. A simple title + one-liner on
// the left and a button on the right — no icon, no card chrome. Clicking the
// button opens the picker (API / MCP) or the build dialog.

function LauncherRow({ title, description, ctaLabel, onClick }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-3">
      <div className="min-w-0">
        <h2 className="text-[13.5px] font-semibold text-black/85 dark:text-white/90">{title}</h2>
        {description && (
          <p className="mt-0.5 text-[11.5px] leading-snug text-black/55 dark:text-white/55">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onClick}
        className="flex-shrink-0 inline-flex items-center gap-1 rounded-lg bg-black text-white dark:bg-white dark:text-black px-3 py-1.5 text-[12px] font-medium hover:opacity-90 transition-opacity"
      >
        {ctaLabel}
      </button>
    </div>
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
      className={`group relative rounded-xl border bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md p-2.5 flex flex-col gap-1.5 transition-colors shadow-sm scroll-mt-24 ${
        highlight
          ? "border-emerald-400/70 ring-2 ring-emerald-400/40 shadow-[0_0_24px_rgba(16,185,129,0.25)]"
          : "border-black/[0.06] dark:border-white/10 hover:border-black/15 dark:hover:border-white/20"
      }`}
    >
      <div className="flex items-start gap-2">
        {iconNode ? (
          // Universal tiles (or any caller passing iconNode) skip the
          // favicon pipeline entirely - useful when the tile isn't tied
          // to a specific upstream domain. Accent ring/tint differentiates
          // them from the favicon-on-white-square treatment used by
          // every connector-backed tile.
          <div
            className={`h-7 w-7 rounded-lg flex items-center justify-center flex-shrink-0 ring-1 ${
              iconAccentClass ||
              "bg-black/[0.04] dark:bg-white/[0.06] text-black/70 dark:text-white/80 ring-black/[0.06] dark:ring-white/[0.08]"
            }`}
          >
            {(() => {
              const Icon = iconNode;
              return <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />;
            })()}
          </div>
        ) : (
          <div className="h-7 w-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden">
            <AppFavicon domain={logoDomain} iconUrl={logoUrl} name={name} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[12px] font-semibold text-black/85 dark:text-white/90 truncate">
              {name}
            </h3>
            {badge && (
              <span
                className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-[1px] text-[9px] font-medium ${toneClass(badge.tone)}`}
              >
                {badge.icon ? <badge.icon className="h-2 w-2" /> : null}
                {badge.label}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClick}
          className={`flex-shrink-0 text-[10px] font-medium rounded-full px-2 py-[3px] transition-colors ${
            ctaVariant === "primary"
              ? "bg-black text-white dark:bg-white dark:text-black hover:opacity-90"
              : "border border-black/10 dark:border-white/15 text-black/65 dark:text-white/70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          }`}
        >
          {ctaLabel}
        </button>
      </div>
      <p className="text-[10.5px] leading-snug text-black/55 dark:text-white/55 line-clamp-2 pl-9">
        {description}
      </p>
      {chips && chips.length > 0 && (
        <div
          className="flex items-center gap-1 flex-wrap pl-9"
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
              className="inline-flex items-center rounded-full border border-black/[0.08] dark:border-white/[0.12] bg-black/[0.03] dark:bg-white/[0.04] px-1.5 py-[1px] text-[9.5px] font-medium text-black/65 dark:text-white/65 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:text-black/85 dark:hover:text-white/85 transition-colors"
              title={`Open ${chip.label}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function AppFavicon({ domain, iconUrl, name }) {
  const [attempt, setAttempt] = useState(0);
  // Prefer an explicit catalog-level `iconUrl` over the S2 favicon
  // service. Google Workspace apps in particular need this - S2 returns
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
    return <ShieldAlert className="h-4 w-4 text-black/55 dark:text-white/65" strokeWidth={1.75} />;
  }
  return (
    <img
      key={attempt}
      src={candidates[attempt]}
      alt={`${name} logo`}
      width={20}
      height={20}
      loading="lazy"
      decoding="async"
      onError={() => setAttempt((a) => a + 1)}
      className="block object-contain"
      style={{ width: 20, height: 20 }}
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
