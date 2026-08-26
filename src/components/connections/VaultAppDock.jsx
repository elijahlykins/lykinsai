import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Plug, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { CONNECTORS } from "@/lib/connectors/catalog";
import { toast } from "@/components/ui/use-toast";
import { toUserFacingError } from "@/lib/ai/userFacingErrors";
import lyknIconUrl from "@/assets/FINAL/LYKN-ICON-A-Squircle/PNGs/LYKN-Icon-A-Squircle-BLUE-master.png";

// Floating macOS-style dock for the Vault page and a vertical variant
// rendered along the left edge of the focused-chat surface.
//
// LAUNCHER, not a management surface. Each icon is a connected input
// tool (Gmail, Slack, Notion…). Clicking an icon opens that app's web
// surface in a new tab so the user can just start working; the adapter
// is already feeding Vault retrieval in the background.
//
// Management (sync now / pause / disconnect / reconnect) lives on
// the Connections page. The trailing plug button in the dock + the
// Vault↔Connections toggle at the top both get the user there in one
// click. A red dot on a tile means "needs reconnect — open Connections
// to fix it."
//
// Positioning:
//   horizontal (default) — `fixed bottom-6 left-1/2 -translate-x-1/2`,
//     used on Vault / Connections. The Vault already has a `+` quick-
//     note FAB at `bottom-6 right-6`; the dock sits centered so the
//     two never collide.
//   vertical — `fixed top-1/2 -translate-y-1/2` anchored just inside
//     the chat column (`var(--sidebar-offset)`), used by LyknChat in
//     focused-chat mode so the launcher is always visible while the
//     user is working in chat.
// Per-orientation localStorage key for the user's "hide this dock"
// preference. Vertical lives in the chat surface, horizontal lives on
// Vault/Connections — different surfaces, different preferences, so we
// keep them split. Vault dock currently has no hide UI; the key is
// reserved in case we add one later.
const HIDE_PREF_KEY = {
  vertical: "lykn:chatAppDock:hidden",
  horizontal: "lykn:vaultAppDock:hidden",
};

export default function VaultAppDock({ user, orientation = "horizontal" }) {
  const isVertical = orientation === "vertical";
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [connections, setConnections] = useState([]);
  // Provider whose OAuth popup we just launched from a reauth tile. While
  // non-null we listen for the /oauth/callback postMessage so we can toast +
  // refresh in-place instead of routing the user to /connections. Scoped to
  // the dock-initiated flow so we don't double-toast OAuth handshakes that
  // the OAuthConnectDialog on /connections initiates (it owns its own
  // listener and toasts for those).
  const [reconnectingProvider, setReconnectingProvider] = useState(null);
  // Persist the user's "hide this dock" choice across reloads. SSR-safe
  // (window check) and lazy so we never paint the dock for a frame
  // before remembering it was dismissed.
  const [hidden, setHidden] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(HIDE_PREF_KEY[orientation]) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (hidden) window.localStorage.setItem(HIDE_PREF_KEY[orientation], "1");
      else window.localStorage.removeItem(HIDE_PREF_KEY[orientation]);
    } catch {
      // localStorage may be blocked (Safari private mode, etc.) —
      // preference just won't persist, but in-session toggle still works.
    }
  }, [hidden, orientation]);

  const refresh = useCallback(async () => {
    if (!user) {
      setConnections([]);
      return;
    }
    try {
      const connRes = await authedFetch("/api/connections");
      if (connRes.ok) {
        const data = await connRes.json();
        setConnections(data.connections || []);
      }
    } catch {
      // Silent — the dock keeps the LYKN anchor + whatever previous
      // connection state we already had. A transient fetch failure
      // shouldn't blank the launcher.
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

  // Refresh whenever the user lands on /vault or /connections. The
  // VaultConnectionsShell mounts a single dock across both routes, so
  // toggling between them never unmounts us — without this effect a
  // newly-connected app would NOT show up until full reload, even
  // though it's exactly the moment the user wants to see it (right
  // after approving an OAuth handshake on /connections).
  useEffect(() => {
    if (pathname === "/vault" || pathname.startsWith("/connections")) {
      refresh();
    }
  }, [pathname, refresh]);

  // Build the list of connected app tiles, in the same order as the
  // Connections grid.
  const tiles = useMemo(() => {
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
      // `requiresPrefields` flags connectors that can't start OAuth
      // blind from the dock (Mastodon needs an instance URL first).
      // Those still get routed to /connections so the user can fill
      // the form. Everything else (Google, Notion, GitHub, …) can
      // reauth in one click from here.
      const requiresPrefields = (connector.oauthPrefields || []).some(
        (f) => f.required !== false,
      );
      inputTiles.push({
        key: `input:${provider}`,
        kind: "input",
        provider,
        name: connector.name,
        domain: connector.domain,
        iconUrl: connector.iconUrl || null,
        launchUrl: resolveLaunchUrl(connector.domain),
        meta: metaBits.join(" · ") || "Connected",
        needsAttention: conn.status === "reauth",
        requiresPrefields,
      });
    }

    return inputTiles;
  }, [connections]);

  // Skip waiting on the fetch before painting — the LYKN tile is the
  // permanent anchor of the dock and is available to click while the
  // connections list is still loading. Showing the dock
  // immediately also avoids a layout flash where it pops in late.

  // Kick off an OAuth re-handshake directly from the dock. Same shape as
  // OAuthConnectDialog.handleConnect — POST /api/connections/{provider}/start,
  // open the returned URL in a centered popup, let the postMessage listener
  // below pick up the result. Falls back to /connections on any failure so
  // the user always has a recovery surface.
  const handleReconnect = useCallback(
    async (tile) => {
      if (tile.kind !== "input" || !tile.provider || tile.requiresPrefields) {
        navigate("/settings?section=connections");
        return;
      }
      setReconnectingProvider(tile.provider);
      try {
        const res = await authedFetch(`/api/connections/${tile.provider}/start`, {
          method: "POST",
          body: JSON.stringify({}),
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
          // Popup blocked — fall back to a same-tab navigation so the
          // handshake still completes. The callback page will redirect
          // back to LYKN when done.
          window.location.href = data.url;
          return;
        }
        // Backstop for "user closed the popup without finishing OAuth"
        // (cancelled, browser killed it, network error inside the
        // callback page). We don't toast here — silent failures
        // shouldn't surface as toasts.
        //
        // We deliberately do NOT poll popup.closed: the opener has
        // COOP same-origin-allow-popups (vercel.json), and once the
        // popup navigates to the provider (Google, GitHub, …) every
        // popup.closed read logs a "Cross-Origin-Opener-Policy policy
        // would block the window.closed call" warning. At 500ms ticks
        // that's tens of warnings per OAuth flow.
        //
        // Instead we check popup.closed exactly once, when focus
        // returns to the opener — which happens both when the callback
        // page closes itself (happy path) and when the user X-es the
        // popup (cancel). On the happy path the postMessage listener
        // below has already cleared `reconnectingProvider` by the time
        // focus fires, so this is a no-op.
        const onFocus = () => {
          setTimeout(() => {
            let closed = true;
            try {
              closed = popup.closed;
            } catch {
              closed = true;
            }
            if (closed) {
              window.removeEventListener("focus", onFocus);
              setReconnectingProvider((p) => (p === tile.provider ? null : p));
            }
          }, 100);
        };
        window.addEventListener("focus", onFocus);
      } catch (err) {
        setReconnectingProvider(null);
        toast({
          title: "Couldn't start reconnect",
          description: toUserFacingError(err),
          variant: "destructive",
        });
        navigate("/settings?section=connections");
      }
    },
    [navigate],
  );

  const handleLaunch = (tile) => {
    // reauth tiles open the OAuth popup in place so the user can
    // reconnect in one click — the previous behavior bounced them
    // to /connections and made them hunt for the "Add another …"
    // button. Everything else opens in a new tab.
    if (tile.needsAttention) {
      handleReconnect(tile);
      return;
    }
    if (!tile.launchUrl) {
      navigate("/settings?section=connections");
      return;
    }
    window.open(tile.launchUrl, "_blank", "noopener,noreferrer");
  };

  // Listen for the /oauth/callback handshake message while a dock-initiated
  // reconnect is in flight. Mirrors OAuthConnectDialog's listener (origin
  // checked against API_BASE_URL because the callback page renders on the
  // API host) but scoped to the provider we just launched so we don't
  // double-toast when the user has the Connections page open in the
  // background.
  useEffect(() => {
    if (!reconnectingProvider) return;
    const expectedOrigin = (() => {
      try {
        return new URL(API_BASE_URL).origin;
      } catch {
        return "";
      }
    })();
    const onMessage = (event) => {
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      const msg = event?.data;
      if (!msg || msg.type !== "lykn:oauth") return;
      if (msg.provider !== reconnectingProvider) return;
      if (msg.ok) {
        toast({
          title: "Reconnected",
          description: "Sync is back on. Give it a moment to catch up.",
        });
      } else {
        toast({
          title: "Reconnection failed",
          description: "The provider rejected the request or you cancelled.",
          variant: "destructive",
        });
      }
      setReconnectingProvider(null);
      refresh();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [reconnectingProvider, refresh]);

  // Vertical variant anchors itself just inside the chat column, using
  // the same sidebar offset every other chat chrome consumes. The icons
  // stack top-to-bottom; tooltips flip to the right edge so they don't
  // run off the screen.
  // The vertical dock anchors to `var(--sidebar-offset)`, which animates
  // when the global sidebar opens/closes. Without an explicit transition
  // on `left` the dock snaps to its new x as soon as the variable flips,
  // while the chat column eases (transition-all duration-300) — the two
  // motions desync and the dock visibly jumps. We match the chat
  // column's easing on `left` so the dock glides in lockstep with it.
  const outerCls = isVertical
    ? "fixed top-1/2 -translate-y-1/2 z-[65] pointer-events-none transition-[left] duration-300 ease-in-out"
    // Horizontal dock is hidden on phones (the bottom tab bar already owns
    // the bottom edge there); it returns at the md breakpoint and up.
    : "hidden md:block fixed bottom-6 left-1/2 -translate-x-1/2 z-[65] pointer-events-none";
  const outerStyle = isVertical
    ? { left: "calc(var(--sidebar-offset, 0px) + 0.75rem)" }
    : undefined;
  const innerCls = isVertical
    ? "flex flex-col items-center gap-1.5 px-2 py-2 rounded-2xl glass-control shadow-lg"
    : "flex items-end gap-1.5 px-2 py-2 rounded-2xl glass-control shadow-lg";
  const plugCls = isVertical
    ? "mt-1 h-12 w-12 rounded-xl flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/[0.05] dark:hover:bg-white/[0.05] transition-colors"
    : "ml-1 h-12 w-12 rounded-xl flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/[0.05] dark:hover:bg-white/[0.05] transition-colors";

  // Collapsed state — only wired for the vertical (in-chat) dock. When
  // the user dismisses the dock we keep a slim affordance in the exact
  // same spot so they can bring it back without hunting for a setting.
  // Horizontal dock has no hide UI today, so falls through to the full
  // dock render unconditionally.
  if (hidden && isVertical) {
    return (
      <div className={outerCls} style={outerStyle}>
        <div className="pointer-events-auto">
          <button
            type="button"
            onClick={() => setHidden(false)}
            title="Show app launcher"
            aria-label="Show app launcher"
            className="group h-12 w-6 rounded-r-xl rounded-l-md flex items-center justify-center glass-control shadow-lg text-black/45 dark:text-white/45 hover:text-black/80 dark:hover:text-white/80 hover:w-7 transition-all"
          >
            <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            <span className="sr-only">Show app launcher</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={outerCls} style={outerStyle}>
      <div className="pointer-events-auto">
        <div className={innerCls}>
          {/* LYKN home — always at the leading edge, always available.
              Routes to Studio, the canonical "open LYKN" destination.
              Rendered with the same white-card shell as the connected-app
              DockIcons so it reads as "the first app in the row" rather
              than a special anchor. */}
          <LyknDockTile onClick={() => navigate("/studio")} vertical={isVertical} />

          {tiles.map((tile) => (
            <DockIcon
              key={tile.key}
              domain={tile.domain}
              iconUrl={tile.iconUrl}
              name={tile.name}
              meta={tile.meta}
              needsAttention={tile.needsAttention}
              onClick={() => handleLaunch(tile)}
              vertical={isVertical}
            />
          ))}
          <button
            type="button"
            onClick={() => navigate("/settings?section=connections")}
            title={tiles.length > 0 ? "Connect another app" : "Connect an app"}
            className={plugCls}
          >
            <Plug className="w-4 h-4" />
            <span className="sr-only">
              {tiles.length > 0 ? "Connect another app" : "Connect an app"}
            </span>
          </button>
          {/* Hide-dock affordance — only rendered in the chat (vertical)
              context. Deliberately quieter than the app tiles so it
              reads as chrome, not an app to launch. Tucks in at the
              far end of the stack so it's the last thing in the row. */}
          {isVertical && (
            <button
              type="button"
              onClick={() => setHidden(true)}
              title="Hide app launcher"
              aria-label="Hide app launcher"
              className="mt-0.5 h-6 w-12 rounded-md flex items-center justify-center text-black/35 dark:text-white/35 hover:text-black/70 dark:hover:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.05] transition-colors"
            >
              <X className="w-3 h-3" />
              <span className="sr-only">Hide app launcher</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── LyknDockTile ──────────────────────────────────────────────────────────
// The permanent LYKN anchor at the leading edge of the dock. Mirrors the
// DockIcon container exactly (white rounded-square card, ring, shadow,
// hover lift, tooltip) so the LYKN tile reads as "the first icon in the
// row" rather than a special-case anchor. The BLUE squircle PNG is
// rendered at the same 32px favicon size DockFavicon uses for connected
// apps, keeping the visual rhythm consistent across the whole dock.
function LyknDockTile({ onClick, vertical = false }) {
  const [hovered, setHovered] = useState(false);
  // Vertical dock: tile lifts to the right on hover (and tooltip
  // anchors to the right edge) instead of the horizontal dock's
  // upward lift + tooltip-above behavior.
  const liftCls = vertical
    ? "hover:scale-110 hover:translate-x-1"
    : "hover:scale-110 hover:-translate-y-1";
  const tooltipCls = vertical
    ? "absolute left-full ml-2 top-1/2 -translate-y-1/2 whitespace-nowrap px-2.5 py-1 rounded-md bg-black/85 dark:bg-white/95 text-white dark:text-black text-[10.5px] font-medium shadow-md pointer-events-none"
    : "absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap px-2.5 py-1 rounded-md bg-black/85 dark:bg-white/95 text-white dark:text-black text-[10.5px] font-medium shadow-md pointer-events-none";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      title="Open LYKN"
      className={`relative h-12 w-12 rounded-xl flex items-center justify-center bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden transition-transform touch-manipulation ${liftCls}`}
    >
      {/* The squircle PNG already bakes its own padding around the
          LYKN mark, so rendering at 32px (the DockFavicon canvas size)
          made the visible mark read smaller than Claude/Cursor
          favicons next to it — those ship as full-bleed glyphs with
          no internal padding. Bumping the LYKN render box to 44px
          inside the 48px tile cancels out the squircle's padding so
          the optical weight of the glyph matches the rest of the row. */}
      <img
        src={lyknIconUrl}
        alt="LYKN"
        width={44}
        height={44}
        className="block object-contain"
        style={{ width: 48, height: 48 }}
        draggable={false}
      />
      {hovered && (
        <div className={tooltipCls}>
          <div>LYKN</div>
          <div className="text-[9.5px] opacity-70">Open chat</div>
        </div>
      )}
    </button>
  );
}

// ─── DockIcon ──────────────────────────────────────────────────────────────

function DockIcon({ domain, iconUrl, name, meta, needsAttention, onClick, vertical = false }) {
  const [hovered, setHovered] = useState(false);
  const liftCls = vertical
    ? "hover:scale-110 hover:translate-x-1"
    : "hover:scale-110 hover:-translate-y-1";
  const tooltipCls = vertical
    ? "absolute left-full ml-2 top-1/2 -translate-y-1/2 whitespace-nowrap px-2.5 py-1 rounded-md bg-black/85 dark:bg-white/95 text-white dark:text-black text-[10.5px] font-medium shadow-md pointer-events-none"
    : "absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap px-2.5 py-1 rounded-md bg-black/85 dark:bg-white/95 text-white dark:text-black text-[10.5px] font-medium shadow-md pointer-events-none";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      title={`Open ${name}`}
      className={`relative h-12 w-12 rounded-xl flex items-center justify-center bg-white dark:bg-white/95 ring-1 ring-black/[0.06] shadow-sm overflow-hidden transition-transform touch-manipulation ${liftCls}`}
    >
      <DockFavicon domain={domain} iconUrl={iconUrl} name={name} />
      {needsAttention && (
        <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white dark:ring-zinc-950" />
      )}
      {hovered && (
        <div className={tooltipCls}>
          <div>{name}</div>
          {meta && <div className="text-[9.5px] opacity-70">{meta}</div>}
        </div>
      )}
    </button>
  );
}

function DockFavicon({ domain, iconUrl, name }) {
  const [attempt, setAttempt] = useState(0);
  // Same precedence as the connections-page AppFavicon: explicit
  // catalog-provided iconUrl wins (Google Workspace product logos,
  // future brand-asset overrides), then S2, then DuckDuckGo as a
  // last resort.
  const candidates = [];
  if (iconUrl) candidates.push(iconUrl);
  if (domain) {
    candidates.push(`https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`);
    candidates.push(`https://icons.duckduckgo.com/ip3/${domain}.ico`);
  }
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
