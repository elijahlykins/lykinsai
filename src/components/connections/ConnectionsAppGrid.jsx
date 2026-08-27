import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, ChevronLeft, KeyRound, ShieldAlert, Loader2, Search, X } from "lucide-react";
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
import { CUSTOM_API_PRESETS } from "@/lib/connectors/customApiPresets";
import OAuthConnectDialog from "@/components/connections/OAuthConnectDialog";
import TokenConnectDialog from "@/components/connections/TokenConnectDialog";
import CustomApiDialog from "@/components/connections/CustomApiDialog";
import VaultConnectionsToggle from "@/components/connections/VaultConnectionsToggle";
import McpConnectionsPanel from "@/components/connections/McpConnectionsPanel";

// Unified "app store" view for the Connections page. Everything LYKN
// can plug into renders as the same tile shape so the answer to "what
// can I connect?" is one glance.
//
// Tiles come from CONNECTORS (native adapters) plus CUSTOM_API_PRESETS
// (bring-your-own-key apps); clicking one opens the matching connect
// flow — OAuth popup, token paste, or the Custom API manager.
//
// This page is INBOUND only: apps LYKN reads from and acts on. LYKN is
// not exposed to outside AI models.

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
const CONNECTABLE_INPUT_STATUSES = new Set([
  "available",
  "beta",
  "verification",
  "paid",
]);

// Paid-plan warning for an input tool. `status: "paid"` in the catalog
// (e.g. X needs API Basic at $200/mo to read bookmarks) becomes a
// { title, message } confirm shown before OAuth starts, so users see the
// price before initiating the handshake.
function getInputPaidWarning(connector) {
  if (!connector || connector.status !== "paid") return null;
  return {
    title: `${connector.name} requires a paid plan`,
    message: `${connector.statusLabel || "This connection needs a paid tier on the upstream app."} OAuth will still work, but data won't sync until you have an eligible plan. Continue?`,
  };
}

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
  // Open straight into the app picker on mount instead of the launcher
  // row — used by the wake preview so "Connect apps" lands directly on
  // the connection-card grid.
  initialPicker = null,
}) {
  const embeddedPreviewMode = compactPreview;
  const showPageHeader = !embeddedPreviewMode && !wakePreview && !embedded;
  const compactGrid = embeddedPreviewMode && !wakePreview;
  // Render the picker inline (contained in the surface) rather than as
  // a viewport-fixed modal whenever we're inside a transformed/clipped host:
  // the Settings dialog (`embedded`) and the wake walkthrough preview
  // (`wakePreview`). A `position: fixed` element nested under the walkthrough's
  // transformed carousel track anchors to that transform, not the viewport, so
  // the modal renders shifted "sideways" and breaks the preview.
  const inlinePicker = embedded || wakePreview;
  const navigate = useNavigate();
  const [connections, setConnections] = useState([]);
  const [providerConfig, setProviderConfig] = useState({});
  const [loading, setLoading] = useState(false);
  const [activeInputConnector, setActiveInputConnector] = useState(null);
  // Token-paste providers (Cursor, Trello, Readwise, …) use a credential-paste
  // dialog rather than the OAuth popup.
  const [activeTokenConnector, setActiveTokenConnector] = useState(null);
  // Universal "Custom API" tile opens its own manage-connections dialog.
  const [customApiOpen, setCustomApiOpen] = useState(false);
  // When a preset card is clicked, the dialog opens straight into that app's
  // form (base URL + auth prefilled, key field ready).
  const [customApiPresetId, setCustomApiPresetId] = useState(null);
  // The page is a launcher row that opens a picker modal listing every app
  // LYKN can connect to. `picker` is truthy while it's open; `pickerQuery`
  // is its search box.
  const [picker, setPicker] = useState(initialPicker);
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
  const [vaultCounts, setVaultCounts] = useState(new Map());

  const refresh = useCallback(async () => {
    if (!user) {
      setConnections([]);
      setProviderConfig({});
      return;
    }
    setLoading(true);
    try {
      const [connRes, countsRes] = await Promise.all([
        authedFetch("/api/connections"),
        // Direct supabase RPC - auth.uid() scopes results to this user.
        // Network failure or RLS denial falls through to a zero-counts
        // map so tiles silently omit the footer rather than blocking
        // the page.
        supabase.rpc("vault_connector_source_counts"),
      ]);
      if (connRes.ok) {
        const data = await connRes.json();
        setConnections(data.connections || []);
        setProviderConfig(data.providerConfig || {});
      }
      if (countsRes && !countsRes.error && Array.isArray(countsRes.data)) {
        const m = new Map();
        for (const row of countsRes.data) {
          if (!row?.source) continue;
          m.set(row.source, Number(row.count) || 0);
        }
        setVaultCounts(m);
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

  const vaultCountsByConnector = useMemo(() => {
    const totals = new Map();
    for (const connector of CONNECTORS) {
      const count = (CONNECTOR_NOTES_SOURCES[connector.id] || [])
        .reduce((sum, source) => sum + (vaultCounts.get(source) || 0), 0);
      if (count > 0) totals.set(connector.id, count);
    }
    return totals;
  }, [vaultCounts]);

  // Apps reachable via their REST API / OAuth. Native connectors first
  // (category order), then BYO-key presets with no native equivalent, then
  // the Custom API catch-all ("connect anything else") last. Module-level
  // data sources → empty dep list.
  const appTiles = useMemo(() => {
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

  // Free-text filter for the picker modal. Section labels always pass; the
  // empty ones get dropped afterward in `pickerTiles`.
  const matchesPickerQuery = useCallback((tile, q) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    if (tile.kind === "section") return true;
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

  // The picker's tiles, filtered by the modal search, with empty section
  // labels dropped.
  const pickerTiles = useMemo(() => {
    if (!picker) return [];
    const filtered = appTiles.filter((t) => matchesPickerQuery(t, pickerQuery));
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
  }, [picker, appTiles, pickerQuery, matchesPickerQuery]);

  const hasPickerResults = pickerTiles.some((t) => t.kind !== "section");

  // The picker's scrollable grid of app tiles + empty state. Shared by the
  // inline (Settings `embedded`) and modal renders so the tile logic lives in
  // one place.
  const pickerBody = (
    <>
      <div
        className={`gap-2 ${
          // Inline in Settings the pane's width is the only thing that matters
          // and it can be anything, so the tiles count their own columns. The
          // standalone modal is sized by the viewport, so it may ask it.
          inlinePicker
            ? "lykn-settings-grid"
            : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        }`}
        style={inlinePicker ? { '--lykn-settings-grid-min': '208px' } : undefined}
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
                plain={embedded}
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
            // Vault-count footer shows how many notes a connected input
            // adapter has produced.
            // Only rendered when the tile is actually connected AND
            // we have at least one non-zero count - unconnected /
            // capture-only tiles stay quiet to avoid clutter.
            const noteCount =
              isConnected && !isCaptureOnly && !isComingSoon
                ? vaultCountsByConnector.get(connector.id) || 0
                : 0;
            // Deep-link targets for each chip. We pass the first slug
            // for the connector (most are 1:1) so the receiving page
            // can filter to that one source. Pages that don't yet read
            // ?source= ignore it harmlessly - the click still lands on
            // the right surface.
            const primarySlug = getConnectorSourceSlugs(connector.id)[0] || "";
            const chips = noteCount > 0
              ? [{
                  key: "notes",
                  label: `${noteCount} note${noteCount === 1 ? "" : "s"}`,
                  onClick: () => navigate(`/vault${primarySlug ? `?source=${encodeURIComponent(primarySlug)}` : ""}`),
                }]
              : null;
            return (
              <AppTile
                key={tile.key}
                plain={embedded}
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
              Connect the apps you use — sign in with OAuth or paste an API key — and LYKN can read
              from them and act on them. All revocable any time.
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

      {user && !compactGrid && (
        <div id="mcp-connections" className={embedded ? "mb-5" : "mb-6"}>
          <McpConnectionsPanel user={user} embedded={embedded} />
        </div>
      )}

      {/* ── Launcher card ──────────────────────────────────────────── */}
      {/* When the picker is inline (Settings or wake preview) it replaces the
          card, so hide it while the picker is open. */}
      {!(inlinePicker && picker) && (
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
      <div className={`flex flex-col divide-y divide-black/[0.07] dark:divide-white/[0.08] ${
        embedded ? "" : "rounded-xl border border-black/[0.07] dark:border-white/[0.08]"
      }`}>
        <LauncherRow
          plain={embedded}
          title="Connect an app"
          description="Connect Google, Slack, Notion, Stripe and more with a sign-in or API key."
          ctaLabel="Browse apps"
          onClick={() => {
            setPickerQuery("");
            setPicker("api");
          }}
        />
      </div>
      </>
      )}

      {/* ── App picker ─────────────────────────────────────────────── */}
      {/* Inline inside Settings (`embedded`) and the wake preview
          (`wakePreview`); a centered modal otherwise. */}
      {picker && (
        inlinePicker ? (
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
              <h3 className="text-sm font-semibold text-black/85 dark:text-white/90">Connect an app</h3>
            </div>
            <p className="ml-1 mb-3 text-[12px] text-black/55 dark:text-white/55">
              Pick an app. We'll walk you through connecting it.
            </p>
            <div className="relative mb-3">
              {embedded ? null : (
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-black/35 dark:text-white/35 pointer-events-none" />
              )}
              <input
                type="search"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Search apps…"
                aria-label="Search"
                autoFocus
                className={
                  embedded
                    ? "w-full h-9 bg-transparent border-0 border-b border-black/10 dark:border-white/15 px-0 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35 focus:border-black/30 dark:focus:border-white/30"
                    : "w-full h-10 rounded-xl glass-control pl-10 pr-3 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
                }
              />
            </div>
            {pickerBody}
          </div>
        ) : (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Connect an app"
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
                    Connect an app
                  </h2>
                  <p className="mt-0.5 text-[12px] text-black/55 dark:text-white/55">
                    Pick an app. We'll walk you through connecting it.
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
                  placeholder="Search apps…"
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
// The top-level connection entry point. A simple title + one-liner on the left
// and a button on the right — no icon, no card chrome. Clicking the button
// opens the app picker.

function LauncherRow({ title, description, ctaLabel, onClick, plain = false }) {
  return (
    <div className={`flex items-center justify-between gap-4 py-3 ${plain ? "px-0" : "px-3.5"}`}>
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
        className={
          plain
            ? "flex-shrink-0 text-[12px] font-medium text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white transition-colors"
            : "flex-shrink-0 inline-flex items-center gap-1 rounded-lg bg-black text-white dark:bg-white dark:text-black px-3 py-1.5 text-[12px] font-medium hover:opacity-90 transition-opacity"
        }
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
  plain = false,
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

  if (plain) {
    return (
      <div
        ref={ref}
        id={anchorId}
        className={`group relative flex flex-col gap-1 py-3 scroll-mt-24 border-b border-black/[0.06] dark:border-white/[0.08] last:border-b-0 ${
          highlight ? "bg-black/[0.02] dark:bg-white/[0.03]" : ""
        }`}
      >
        <div className="flex items-start gap-2.5">
          {iconNode ? (
            <div className="h-6 w-6 flex items-center justify-center flex-shrink-0 text-black/55 dark:text-white/55">
              {(() => {
                const Icon = iconNode;
                return <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />;
              })()}
            </div>
          ) : (
            <div className="h-6 w-6 flex items-center justify-center flex-shrink-0 overflow-hidden">
              <AppFavicon domain={logoDomain} iconUrl={logoUrl} name={name} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-[13px] font-medium text-black/85 dark:text-white/90 truncate">
                {name}
                {badge?.label ? (
                  <span className="ml-2 text-[11px] font-normal text-black/45 dark:text-white/45">
                    {badge.label}
                  </span>
                ) : null}
              </h3>
              <button
                type="button"
                onClick={onClick}
                className="flex-shrink-0 text-[12px] font-medium text-black/65 dark:text-white/65 hover:text-black dark:hover:text-white transition-colors"
              >
                {ctaLabel}
              </button>
            </div>
            <p className="mt-0.5 text-[11.5px] leading-snug text-black/55 dark:text-white/55 line-clamp-2">
              {description}
            </p>
            {chips && chips.length > 0 && (
              <div className="mt-1.5 flex items-center gap-3 flex-wrap" aria-label={`${name} Vault impact`}>
                {chips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      chip.onClick?.();
                    }}
                    className="text-[11px] text-black/55 dark:text-white/55 hover:text-black dark:hover:text-white transition-colors"
                    title={`Open ${chip.label}`}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

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
          aria-label={`${name} Vault impact`}
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
