import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Loader2, Plug, RefreshCw, Unplug, Pencil, Search } from "lucide-react";
import { mcpFetch, openMcpOAuth } from "@/lib/mcp/mcpApi";
import McpTrustBadge from "@/components/connections/McpTrustBadge";

function statusLabel(status) {
  if (status === "connected") return "Connected";
  if (status === "authentication_required") return "Authentication required";
  if (status === "authorizing") return "Authorizing";
  if (status === "refreshing") return "Refreshing";
  if (status === "offline") return "Offline";
  if (status === "revoked") return "Revoked";
  if (status === "error") return "Error";
  return "Disconnected";
}

const CATEGORIES = [
  { id: "", label: "All" },
  { id: "communication", label: "Communication" },
  { id: "documents", label: "Documents" },
  { id: "productivity", label: "Productivity" },
  { id: "development", label: "Development" },
  { id: "crm", label: "CRM" },
  { id: "calendar", label: "Calendar" },
  { id: "finance", label: "Finance" },
];

export default function McpConnectionsPanel({ user, embedded = false }) {
  const location = useLocation();
  const preset = useMemo(() => {
    const params = new URLSearchParams(location.search || "");
    return {
      search: params.get("q") || "",
      catalogId: params.get("catalog") || "",
    };
  }, [location.search]);

  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(preset.search);
  const [category, setCategory] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState("discover");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [localTrusted, setLocalTrusted] = useState(false);
  const [commandLine, setCommandLine] = useState("");
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [detailId, setDetailId] = useState(null);
  const [detail, setDetail] = useState(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setConnections([]);
      return;
    }
    setLoading(true);
    try {
      const res = await mcpFetch("/api/mcp/connections");
      const data = await res.json().catch(() => ({}));
      setConnections(Array.isArray(data.connections) ? data.connections : []);
    } catch {
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onMessage = (event) => {
      if (!event?.data || event.data.type !== "lykn:mcp-oauth") return;
      refresh();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  useEffect(() => {
    if (preset.search) setQuery(preset.search);
  }, [preset.search]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (category) params.set("category", category);
        const res = await mcpFetch(`/api/mcp/catalog?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setResults(Array.isArray(data.entries) ? data.entries : []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    };
    const timer = setTimeout(run, query.trim() ? 180 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, category]);

  const connectCatalog = async (entry) => {
    if (!entry.remoteUrlTemplate) {
      setQuery(entry.name);
      setMode("discover");
      setError(`No hosted URL for ${entry.name} yet. Search for a community server, or add an MCP URL.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await mcpFetch("/api/mcp/connections", {
        method: "POST",
        body: JSON.stringify({
          name: entry.name,
          serverUrl: entry.remoteUrlTemplate,
          trustLevel: entry.trust,
          catalogId: entry.id,
          catalogSource: entry.source,
          providedThrough: entry.providedThrough,
          accountLabel: entry.name,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.authorizationUrl) openMcpOAuth(data.authorizationUrl);
      else if (!res.ok || data.ok === false) {
        setError(data.message || data.error || "Could not connect");
      }
      await refresh();
    } catch {
      setError("Could not connect");
    } finally {
      setBusy(false);
    }
  };

  const addUrl = async (event) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await mcpFetch("/api/mcp/connections", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || undefined,
          serverUrl: url.trim(),
          secret: token.trim() || undefined,
          trustLevel: localTrusted ? "local_trusted" : "custom",
          accountLabel: name.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.authorizationUrl) {
        openMcpOAuth(data.authorizationUrl);
        setUrl("");
        setName("");
        setToken("");
      } else if (!res.ok || data.ok === false) {
        if (data.error === "authentication_required" || data.connection?.status === "authentication_required") {
          setError("Authentication required. Use Connect on the connection, or paste a bearer token if the server accepts one.");
        } else {
          setError(data.message || data.error || "Could not connect");
        }
      } else {
        setUrl("");
        setName("");
        setToken("");
      }
      await refresh();
    } catch {
      setError("Could not connect");
    } finally {
      setBusy(false);
    }
  };

  const addLocal = async (event) => {
    event.preventDefault();
    if (!commandLine.trim() || !confirmInstall) return;
    setBusy(true);
    setError("");
    try {
      const res = await mcpFetch("/api/mcp/connections", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || undefined,
          transport: "stdio",
          commandLine: commandLine.trim(),
          confirmInstall: true,
          trustLevel: "local_trusted",
          accountLabel: name.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        setError(data.message || data.error || "Could not start local MCP");
      } else {
        setCommandLine("");
        setName("");
        setConfirmInstall(false);
      }
      await refresh();
    } catch {
      setError("Could not start local MCP");
    } finally {
      setBusy(false);
    }
  };

  const act = async (id, path, method = "POST", body) => {
    setBusy(true);
    setError("");
    try {
      const res = await mcpFetch(`/api/mcp/connections/${id}${path}`, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (data.authorizationUrl) openMcpOAuth(data.authorizationUrl);
      else if (!res.ok && data.message) setError(data.message);
      await refresh();
      if (detailId === id) await loadDetail(id);
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async (id) => {
    await act(id, "", "PATCH", { name: renameValue, accountLabel: renameValue });
    setRenaming(null);
  };

  const loadDetail = async (id) => {
    setDetailId(id);
    const res = await mcpFetch(`/api/mcp/connections/${id}/detail`);
    const data = await res.json().catch(() => ({}));
    setDetail(data.ok ? data : null);
  };

  return (
    <section className={`${embedded ? "mb-5" : "mb-6"}`}>
      <div className={`py-3 ${embedded ? "px-0" : "px-3.5 rounded-xl border border-black/[0.07] dark:border-white/[0.08]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold text-black/85 dark:text-white/90 flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5" strokeWidth={1.75} />
              Apps / MCP
            </h2>
            <p className="mt-0.5 text-[11.5px] leading-snug text-black/55 dark:text-white/55">
              Search a service, add an MCP URL, or run a local MCP. Marketplace listings are discovery only - they do not sync into Vault.
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {[
            ["discover", "Discover"],
            ["url", "Add MCP URL"],
            ["local", "Add Local MCP"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={`h-7 rounded-full px-2.5 text-[11px] font-medium ${
                mode === id
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "border border-black/10 text-black/60 dark:border-white/15 dark:text-white/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "discover" && (
          <div className="mt-3 space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-black/35 dark:text-white/35" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search Gmail, Slack, GitHub…"
                className="h-8 w-full rounded-md border border-black/10 bg-transparent pl-8 pr-2.5 text-[12.5px] outline-none focus:border-black/25 dark:border-white/10 dark:focus:border-white/25"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id || "all"}
                  type="button"
                  onClick={() => setCategory(cat.id)}
                  className={`h-6 rounded-full px-2 text-[10.5px] ${
                    category === cat.id
                      ? "bg-black/80 text-white dark:bg-white dark:text-black"
                      : "text-black/45 dark:text-white/45"
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
            <div className="divide-y divide-black/[0.05] dark:divide-white/[0.07]">
              {searching && (
                <div className="py-2 text-[11.5px] text-black/45 dark:text-white/45 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Searching
                </div>
              )}
              {!searching && results.length === 0 && (
                <p className="py-2 text-[11.5px] text-black/45 dark:text-white/45">
                  No marketplace matches. Try Add MCP URL or Add Local MCP.
                </p>
              )}
              {results.map((entry) => (
                <div key={entry.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate">
                        {entry.name}
                      </span>
                      <McpTrustBadge trust={entry.trust} />
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-black/50 dark:text-white/50 line-clamp-2">
                      {entry.description}
                    </p>
                    {entry.providedThrough && (
                      <p className="mt-0.5 text-[10.5px] text-black/40 dark:text-white/40">
                        Provided through {entry.providedThrough}
                      </p>
                    )}
                    {entry.source?.kind === "official_registry" && entry.trust === "community" && (
                      <p className="mt-0.5 text-[10.5px] text-black/40 dark:text-white/40">
                        Community listing. LYKN has not audited this server.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={busy || !user}
                    onClick={() => connectCatalog(entry)}
                    className="h-7 shrink-0 rounded-md bg-black px-2 text-[11px] font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
                  >
                    {entry.remoteUrlTemplate ? "Connect" : "Details"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === "url" && (
          <form onSubmit={addUrl} className="mt-3 grid gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Label (e.g. Work Google)"
              className="h-8 rounded-md border border-black/10 bg-transparent px-2.5 text-[12.5px] outline-none dark:border-white/10"
            />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
              required
              className="h-8 rounded-md border border-black/10 bg-transparent px-2.5 text-[12.5px] outline-none dark:border-white/10"
            />
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Bearer token (optional)"
              type="password"
              autoComplete="off"
              className="h-8 rounded-md border border-black/10 bg-transparent px-2.5 text-[12.5px] outline-none dark:border-white/10"
            />
            <label className="flex items-center gap-2 text-[11.5px] text-black/55 dark:text-white/55">
              <input type="checkbox" checked={localTrusted} onChange={(e) => setLocalTrusted(e.target.checked)} />
              Local trusted server (loopback only)
            </label>
            <button
              type="submit"
              disabled={busy || !user}
              className="h-8 rounded-md bg-black text-[12px] font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>
        )}

        {mode === "local" && (
          <form onSubmit={addLocal} className="mt-3 grid gap-2">
            <p className="text-[11px] leading-snug text-black/50 dark:text-white/50">
              This starts a program on this computer. LYKN stores command + args, never a raw shell string or environment secrets.
            </p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Label (e.g. Filesystem)"
              className="h-8 rounded-md border border-black/10 bg-transparent px-2.5 text-[12.5px] outline-none dark:border-white/10"
            />
            <input
              value={commandLine}
              onChange={(e) => setCommandLine(e.target.value)}
              placeholder="npx @modelcontextprotocol/server-everything"
              required
              className="h-8 rounded-md border border-black/10 bg-transparent px-2.5 text-[12.5px] outline-none dark:border-white/10"
            />
            <label className="flex items-start gap-2 text-[11.5px] text-black/55 dark:text-white/55">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmInstall}
                onChange={(e) => setConfirmInstall(e.target.checked)}
              />
              I understand this may download and run local code.
            </label>
            <button
              type="submit"
              disabled={busy || !user || !confirmInstall}
              className="h-8 rounded-md bg-black text-[12px] font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {busy ? "Starting…" : "Connect Local MCP"}
            </button>
          </form>
        )}

        {error && <p className="mt-2 text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
            Connected
          </h3>
          <div className="mt-1 divide-y divide-black/[0.06] dark:divide-white/[0.08]">
            {loading && (
              <div className="py-2 text-[11.5px] text-black/45 dark:text-white/45 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading
              </div>
            )}
            {!loading && connections.length === 0 && (
              <p className="py-2 text-[11.5px] text-black/45 dark:text-white/45">No MCP servers connected.</p>
            )}
            {connections.map((conn) => (
              <div key={conn.id} className="py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" className="min-w-0 text-left" onClick={() => loadDetail(conn.id)}>
                    {renaming === conn.id ? (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveRename(conn.id);
                        }}
                      >
                        <input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="h-7 w-40 rounded-md border border-black/10 bg-transparent px-2 text-[12px] outline-none dark:border-white/10"
                        />
                        <button type="submit" className="text-[11px] font-medium">Save</button>
                      </form>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate">
                          {conn.accountLabel || conn.name}
                        </span>
                        <McpTrustBadge trust={conn.trustLevel} />
                      </div>
                    )}
                    <div className="text-[11px] text-black/45 dark:text-white/45 truncate">
                      {conn.providedThrough ? `Provided through ${conn.providedThrough} · ` : ""}
                      {conn.accountIdentity ? `${conn.accountIdentity} · ` : ""}
                      {conn.transport === "stdio" ? `${conn.command || "local"} ${(conn.args || []).join(" ")}` : conn.serverUrl}
                    </div>
                    <div className="mt-0.5 text-[11px] text-black/55 dark:text-white/55">
                      {statusLabel(conn.status)}
                      {conn.toolCount ? ` · ${conn.toolCount} tools` : ""}
                      {conn.lastError ? ` · ${conn.lastError}` : ""}
                    </div>
                  </button>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {(conn.status === "authentication_required" || conn.status === "authorizing" || conn.status === "revoked") && (
                      <button
                        type="button"
                        className="px-2 h-7 rounded-md text-[11px] font-medium bg-black text-white dark:bg-white dark:text-black"
                        onClick={() => act(conn.id, "/authorize")}
                      >
                        Connect
                      </button>
                    )}
                    {(conn.status === "disconnected" || conn.status === "offline" || conn.status === "error") && (
                      <button
                        type="button"
                        className="px-2 h-7 rounded-md text-[11px] font-medium border border-black/10 dark:border-white/15"
                        onClick={() => act(conn.id, "/reconnect")}
                      >
                        Reconnect
                      </button>
                    )}
                    <button
                      type="button"
                      title="Rename"
                      onClick={() => {
                        setRenaming(conn.id);
                        setRenameValue(conn.accountLabel || conn.name);
                      }}
                      className="p-1.5 rounded-md text-black/50 hover:bg-black/[0.04] dark:text-white/50 dark:hover:bg-white/[0.06]"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Refresh"
                      onClick={() => act(conn.id, "/refresh")}
                      className="p-1.5 rounded-md text-black/50 hover:bg-black/[0.04] dark:text-white/50 dark:hover:bg-white/[0.06]"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Disconnect"
                      onClick={() => act(conn.id, "/disconnect")}
                      className="p-1.5 rounded-md text-black/50 hover:bg-black/[0.04] dark:text-white/50 dark:hover:bg-white/[0.06]"
                    >
                      <Unplug className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {detailId === conn.id && detail?.connection?.id === conn.id && (
                  <ConnectionDetail
                    detail={detail}
                    onClose={() => {
                      setDetailId(null);
                      setDetail(null);
                    }}
                    onDelete={() => act(conn.id, "", "DELETE")}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ConnectionDetail({ detail, onClose, onDelete }) {
  const conn = detail.connection;
  return (
    <div className="mt-2 rounded-xl border border-black/[0.06] bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[12px] font-medium">{conn.accountLabel || conn.name}</p>
          <p className="text-[11px] text-black/45 dark:text-white/45">
            {conn.transport === "stdio" ? "Local stdio" : "Remote MCP"}
            {conn.lastConnectedAt ? ` · Last connected ${new Date(conn.lastConnectedAt).toLocaleString()}` : ""}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-[11px] text-black/45">Close</button>
      </div>
      <div className="mt-2 space-y-2">
        {(detail.capabilities || []).map((group) => (
          <div key={group.domain}>
            <p className="text-[11px] font-semibold text-black/70 dark:text-white/70">{group.label}</p>
            <ul className="mt-0.5 space-y-0.5">
              {group.verbs.map((verb) => (
                <li key={`${verb.resource}-${verb.verb}`} className="text-[11px] text-black/55 dark:text-white/55">
                  {verb.approval ? `! ${verb.label} ${verb.approval}` : `✓ ${verb.label}`}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {(detail.tools || []).length > 0 && (
          <details className="text-[11px] text-black/50 dark:text-white/50">
            <summary>Advanced tool list</summary>
            <ul className="mt-1 space-y-0.5">
              {detail.tools.map((tool) => (
                <li key={tool.name}>
                  {tool.name}
                  {tool.consequence ? ` · ${tool.consequence}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="mt-3 text-[11px] text-red-600 dark:text-red-400"
      >
        Delete connection
      </button>
    </div>
  );
}
