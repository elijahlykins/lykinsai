import { useCallback, useEffect, useMemo, useState } from "react";
import { Plug } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { CONNECTORS } from "@/lib/connectors/catalog";
import { OUTBOUND_TARGETS, aliasClientKindForCatalog } from "@/lib/connectors/outboundTargets";

// Floating macOS-style dock at the bottom-center of the Vault page.
//
// LAUNCHER, not a management surface. Each icon is a connected app —
// both input tools (Gmail, Slack, Notion…) and AI tools (Claude,
// ChatGPT, Cursor…). Clicking an icon opens that app's web surface
// in a new tab so the user can just start working; LYKN context is
// already plumbed into AI tools via MCP, and input tools are already
// feeding the synthesis layer in the background.
//
// Management (sync now / pause / disconnect / reconnect) lives on
// the Connections page. The trailing plug button in the dock + the
// Vault↔Connections toggle at the top both get the user there in one
// click. A red dot on a tile means "needs reconnect — open Connections
// to fix it."
//
// Positioning: `fixed bottom-6 left-1/2 -translate-x-1/2`. The Vault
// already has a `+` quick-note FAB at `bottom-6 right-6`; the dock
// sits centered so the two never collide.
export default function VaultAppDock({ user }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [connections, setConnections] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setConnections([]);
      setTokens([]);
      setLoaded(true);
      return;
    }
    try {
      const [connRes, tokRes] = await Promise.all([
        authedFetch("/api/connections"),
        authedFetch("/api/v1/synthesis/tokens"),
      ]);
      if (connRes.ok) {
        const data = await connRes.json();
        setConnections(data.connections || []);
      }
      if (tokRes.ok) {
        const data = await tokRes.json();
        setTokens(Array.isArray(data?.tokens) ? data.tokens : []);
      }
    } catch {
      // Silent — empty dock is acceptable degradation.
    } finally {
      setLoaded(true);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh when the window regains focus (e.g. user just connected
  // on /connections in another tab and tabbed back).
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Refresh whenever the user lands back on /vault. Since the
  // VaultConnectionsShell keeps both surfaces mounted, the dock
  // doesn't unmount across the toggle — so without this effect a
  // newly-connected app would NOT show up until reload.
  useEffect(() => {
    if (pathname === "/vault") refresh();
  }, [pathname, refresh]);

  // Build the list of connected app tiles. AI tools come first, then
  // input tools (matches the Connections grid order).
  const tiles = useMemo(() => {
    const aiTiles = [];
    const seenKinds = new Set();
    for (const tok of tokens) {
      if (tok.status !== "active") continue;
      // Granular DCR-emitted kinds (claude-web, claude-desktop) get
      // aliased to the merged catalog kind (claude) so a Claude OAuth
      // token from claude.ai still resolves to the consolidated Claude
      // tile. See aliasClientKindForCatalog for the merge contract.
      const kind = aliasClientKindForCatalog(tok.client_kind);
      if (!kind || seenKinds.has(kind)) continue;
      seenKinds.add(kind);
      const target = OUTBOUND_TARGETS.find((t) => t.clientKind === kind);
      if (!target) continue;
      aiTiles.push({
        key: `ai:${kind}`,
        kind: "ai",
        name: target.name,
        domain: target.domain,
        launchUrl: resolveLaunchUrl(target.domain),
        meta: tok.last_used_at ? `Last used ${relativeTime(tok.last_used_at)}` : "Token active",
        needsAttention: false,
      });
    }

    const inputTiles = [];
    const seenProviders = new Set();
    for (const conn of connections) {
      if (conn.status !== "active" && conn.status !== "paused" && conn.status !== "reauth") continue;
      const provider = conn.provider;
      if (!provider || seenProviders.has(provider)) continue;
      seenProviders.add(provider);
      const connector = CONNECTORS.find((c) => c.id === provider);
      if (!connector) continue;
      const metaBits = [];
      if (conn.total_synced_count) metaBits.push(`${conn.total_synced_count} item${conn.total_synced_count === 1 ? "" : "s"}`);
      if (conn.last_synced_at) metaBits.push(`synced ${relativeTime(conn.last_synced_at)}`);
      if (conn.status === "paused") metaBits.push("paused");
      if (conn.status === "reauth") metaBits.push("reconnect needed");
      inputTiles.push({
        key: `input:${provider}`,
        kind: "input",
        name: connector.name,
        domain: connector.domain,
        launchUrl: resolveLaunchUrl(connector.domain),
        meta: metaBits.join(" · ") || "Connected",
        needsAttention: conn.status === "reauth",
      });
    }

    return [...aiTiles, ...inputTiles];
  }, [tokens, connections]);

  if (!loaded) return null;

  const handleLaunch = (tile) => {
    // reauth tiles route to /connections to reconnect rather than
    // launching the app — the app's session is broken until they
    // reauthorize. Everything else opens in a new tab.
    if (tile.needsAttention) {
      navigate("/connections");
      return;
    }
    if (!tile.launchUrl) {
      navigate("/connections");
      return;
    }
    window.open(tile.launchUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[65] pointer-events-none">
      <div className="pointer-events-auto">
        {tiles.length === 0 ? (
          <button
            type="button"
            onClick={() => navigate("/connections")}
            className="flex items-center gap-2 px-4 py-2 rounded-full glass-control hover:bg-black/[0.04] dark:hover:bg-white/[0.04] text-[12px] font-medium text-black/70 dark:text-white/75 shadow-sm transition-colors"
          >
            <Plug className="w-3.5 h-3.5" />
            Connect an app
          </button>
        ) : (
          <div className="flex items-end gap-1.5 px-2 py-2 rounded-2xl glass-control shadow-lg">
            {tiles.map((tile) => (
              <DockIcon
                key={tile.key}
                domain={tile.domain}
                name={tile.name}
                meta={tile.meta}
                needsAttention={tile.needsAttention}
                onClick={() => handleLaunch(tile)}
              />
            ))}
            <button
              type="button"
              onClick={() => navigate("/connections")}
              title="Connect another app"
              className="ml-1 h-12 w-12 rounded-xl flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/[0.05] dark:hover:bg-white/[0.05] transition-colors"
            >
              <Plug className="w-4 h-4" />
              <span className="sr-only">Connect another app</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DockIcon ──────────────────────────────────────────────────────────────

function DockIcon({ domain, name, meta, needsAttention, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      title={`Open ${name}`}
      className="relative h-12 w-12 rounded-xl flex items-center justify-center bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden transition-transform hover:scale-110 hover:-translate-y-1 touch-manipulation"
    >
      <DockFavicon domain={domain} name={name} />
      {needsAttention && (
        <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white dark:ring-zinc-950" />
      )}
      {hovered && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap px-2.5 py-1 rounded-md bg-black/85 dark:bg-white/95 text-white dark:text-black text-[10.5px] font-medium shadow-md pointer-events-none">
          <div>{name}</div>
          {meta && <div className="text-[9.5px] opacity-70">{meta}</div>}
        </div>
      )}
    </button>
  );
}

function DockFavicon({ domain, name }) {
  const [attempt, setAttempt] = useState(0);
  const candidates = domain
    ? [
        `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`,
        `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      ]
    : [];
  if (!candidates.length || attempt >= candidates.length) {
    return (
      <span className="text-[14px] font-semibold text-black/65 dark:text-zinc-700">
        {name?.[0]?.toUpperCase() || "?"}
      </span>
    );
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

// Resolves the URL to open when a dock icon is clicked. `domain` is the
// catalog value (e.g. "claude.ai", "mail.google.com"). We just prefix
// https:// — this lands on the app's web surface for every web tool
// (Claude, ChatGPT, Gmail, Notion, …). Desktop-only or CLI-only tools
// (Cursor, Claude Code) land on their homepage, which is the best web
// approximation available.
function resolveLaunchUrl(domain) {
  if (!domain) return null;
  if (domain.startsWith("http://") || domain.startsWith("https://")) return domain;
  return `https://${domain}`;
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

function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
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
