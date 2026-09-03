import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";

import {
  completeManagedConnection,
  connectManagedProvider,
  disconnectManagedProvider,
  getManagedConnection,
  managedCallbackOrigin,
  openManagedConnectPopup,
  searchManagedDirectory,
} from "@/lib/connections/managedConnectionsApi";

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;
const PAGE_SIZE = 24;

/**
 * Searchable directory of managed app connections. Connection state is
 * authoritative from the LYKN Connection Service; this component never
 * infers it from browser cookies, MCP rows, or cached local flags.
 */
export default function ManagedConnectionsSection({ user }) {
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [unconfigured, setUnconfigured] = useState(false);
  const [busyProvider, setBusyProvider] = useState(null);
  const [errorByProvider, setErrorByProvider] = useState({});
  const queryRef = useRef("");
  queryRef.current = query;
  const limitRef = useRef(PAGE_SIZE);
  limitRef.current = limit;
  const pollRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current.timer);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const refresh = useCallback(
    async (q = queryRef.current, max = limitRef.current) => {
      if (!user) {
        setEntries([]);
        setLoaded(true);
        return;
      }
      setSearching(true);
      try {
        const result = await searchManagedDirectory({ query: q, limit: max });
        if (result.error && !result.unconfigured) {
          // A transient server/provider error must not render as "no apps":
          // keep whatever is already on screen and offer a retry.
          setLoadFailed(true);
        } else {
          setUnconfigured(result.unconfigured);
          setEntries(result.entries);
          setHasMore(result.hasMore);
          setLoadFailed(false);
        }
      } catch {
        setLoadFailed(true);
      } finally {
        setSearching(false);
        setLoaded(true);
      }
    },
    [user],
  );

  // Typing a new search resets pagination to the first page.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => refresh(query, limit), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, limit, refresh]);

  /**
   * Poll authoritative connection state until the OAuth flow lands. On
   * desktop the OAuth window opens in the LYKN in-app browser with no
   * window.opener, so the popup's postMessage never reaches this renderer —
   * polling is the reliable completion signal there; the message listener
   * below stays as the fast path for real popups on web.
   */
  const startStatusPolling = useCallback(
    (provider) => {
      stopPolling();
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      const tick = async () => {
        if (!pollRef.current || pollRef.current.provider !== provider) return;
        const connection = await getManagedConnection(provider);
        if (!pollRef.current || pollRef.current.provider !== provider) return;
        const status = connection?.status;
        if (status === "connected" || status === "broken") {
          stopPolling();
          setBusyProvider((current) => (current === provider ? null : current));
          refresh();
          return;
        }
        if (Date.now() > deadline) {
          stopPolling();
          setBusyProvider((current) => (current === provider ? null : current));
          refresh();
          return;
        }
        pollRef.current.timer = setTimeout(tick, POLL_INTERVAL_MS);
      };
      pollRef.current = { provider, timer: setTimeout(tick, POLL_INTERVAL_MS) };
    },
    [refresh, stopPolling],
  );

  useEffect(() => {
    const trusted = managedCallbackOrigin();
    const onMessage = async (event) => {
      if (!trusted || event.origin !== trusted || !event.data) return;
      if (event.data.type === "lykn:connection-auth") {
        stopPolling();
        setBusyProvider(null);
        if (!event.data.ok && event.data.provider) {
          setErrorByProvider((prev) => ({
            ...prev,
            [event.data.provider]: "Connection didn't finish. Try again.",
          }));
        }
        refresh();
        return;
      }
      if (event.data.type === "lykn:connection-verify" && event.data.sessionUri) {
        stopPolling();
        const result = await completeManagedConnection(event.data.sessionUri);
        setBusyProvider(null);
        if (!result.ok && result.provider) {
          setErrorByProvider((prev) => ({
            ...prev,
            [result.provider]: "Connection couldn't be verified. Try again.",
          }));
        }
        refresh();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh, stopPolling]);

  const handleConnect = async (provider) => {
    setErrorByProvider((prev) => ({ ...prev, [provider]: null }));
    setBusyProvider(provider);
    const result = await connectManagedProvider(provider);
    if (result.ok && result.url) {
      // window.open may be denied on desktop (the URL is rerouted to the
      // in-app browser and null comes back) — polling below is the
      // completion signal that works either way.
      openManagedConnectPopup(result.url, {
        onClosed: () => {
          setBusyProvider((current) => (current === provider ? null : current));
          stopPolling();
          refresh();
        },
      });
      startStatusPolling(provider);
      return;
    }
    setBusyProvider(null);
    setErrorByProvider((prev) => ({
      ...prev,
      [provider]:
        result.error === "not_configured"
          ? "Managed connections aren't available on this server yet."
          : result.message || "Couldn't start the connection. Try again.",
    }));
  };

  const handleDisconnect = async (provider) => {
    setErrorByProvider((prev) => ({ ...prev, [provider]: null }));
    setBusyProvider(provider);
    const result = await disconnectManagedProvider(provider);
    setBusyProvider(null);
    if (!result.ok) {
      setErrorByProvider((prev) => ({
        ...prev,
        [provider]: result.message || "Couldn't disconnect. Try again.",
      }));
    }
    refresh();
  };

  // Hide only when signed out or when the server has no managed-connection
  // backend configured — no dead tiles. While the first load is in flight,
  // show skeleton cards so the section doesn't pop in late.
  if (!user || (loaded && unconfigured)) return null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
          Apps
        </h3>
        {searching && <Loader2 className="h-3 w-3 animate-spin text-black/30 dark:text-white/30" />}
      </div>
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-black/35 dark:text-white/35" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search apps to connect - Gmail, Slack, Notion…"
          className="h-8 w-full rounded-md border border-black/10 bg-transparent pl-8 pr-2.5 text-[12.5px] outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
        />
      </div>
      {!loaded ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        loadFailed ? (
          <p className="mt-3 text-xs text-black/40 dark:text-white/40">
            Couldn't load apps.{" "}
            <button
              type="button"
              onClick={() => refresh()}
              className="underline underline-offset-2 hover:text-black/70 dark:hover:text-white/70"
            >
              Try again
            </button>
          </p>
        ) : (
          <p className="mt-3 text-xs text-black/40 dark:text-white/40">
            {query ? `No apps match “${query}”.` : "No apps available."}
          </p>
        )
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {entries.map((entry) => (
              <ManagedConnectionCard
                key={entry.provider}
                entry={entry}
                busy={busyProvider === entry.provider}
                error={errorByProvider[entry.provider]}
                onConnect={() => handleConnect(entry.provider)}
                onDisconnect={() => handleDisconnect(entry.provider)}
              />
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              disabled={searching}
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
              className="mt-2 block text-left text-[11px] font-medium text-blue-600 transition hover:text-blue-500 disabled:opacity-50 dark:text-blue-400"
            >
              {searching ? "Loading…" : "See more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="flex animate-pulse items-center gap-3 rounded-2xl border border-black/[0.08] bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.035]">
      <span className="h-9 w-9 flex-none rounded-xl bg-black/[0.06] dark:bg-white/10" />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="block h-3 w-24 rounded bg-black/[0.06] dark:bg-white/10" />
        <span className="block h-2.5 w-16 rounded bg-black/[0.04] dark:bg-white/[0.07]" />
      </span>
    </div>
  );
}

function AppIcon({ entry }) {
  const [broken, setBroken] = useState(false);
  if (entry.iconUrl && !broken) {
    return (
      <img
        src={entry.iconUrl}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-5 w-5 rounded object-contain"
      />
    );
  }
  return (
    <span className="text-[13px] font-semibold text-black/60 dark:text-white/60">
      {String(entry.label || "?").charAt(0).toUpperCase()}
    </span>
  );
}

function ManagedConnectionCard({ entry, busy, error, onConnect, onDisconnect }) {
  const connected = entry.status === "connected";
  const broken = entry.status === "broken" || entry.status === "error";

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-black/[0.08] bg-black/[0.02] p-3 transition dark:border-white/10 dark:bg-white/[0.035]">
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-black/[0.06] dark:bg-white/10 dark:ring-white/10">
        <AppIcon entry={entry} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-black dark:text-white">
            {entry.label}
          </span>
          {connected && (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
              Connected
            </span>
          )}
          {broken && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
              Needs attention
            </span>
          )}
        </span>
        {error && (
          <span className="mt-0.5 block text-[11px] text-red-600 dark:text-red-400">{error}</span>
        )}
      </span>
      <span className="flex-none">
        {busy ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-black/50 dark:text-white/50">
            <Loader2 className="h-3 w-3 animate-spin" />
            {connected ? "Working…" : "Connecting…"}
          </span>
        ) : connected ? (
          <button
            type="button"
            onClick={onDisconnect}
            className="text-[11px] font-medium text-black/50 transition hover:text-red-600 dark:text-white/50 dark:hover:text-red-400"
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="text-[11px] font-medium text-blue-600 transition hover:text-blue-500 dark:text-blue-400"
          >
            {broken ? "Reconnect" : "Connect"}
          </button>
        )}
      </span>
    </div>
  );
}
