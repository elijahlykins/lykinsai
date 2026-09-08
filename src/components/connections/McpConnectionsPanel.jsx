import { useCallback, useEffect, useState } from "react";
import { Loader2, Monitor, Plug, RefreshCw, Unplug, Pencil } from "lucide-react";
import { mcpFetch, openMcpOAuth } from "@/lib/mcp/mcpApi";
import McpTrustBadge from "@/components/connections/McpTrustBadge";
import {
  desktopMcpRun,
  invalidateDesktopMcpSummary,
  isDesktopMcpAvailable,
} from "@/lib/mcp/desktopMcpBridge";

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

/**
 * MCP servers card: connect any MCP server by URL. Discovery for mainstream
 * apps lives in the managed Apps directory above — this card is the open
 * escape hatch. The URL is enforced server-side by lib/mcp/urlPolicy.js:
 * HTTPS-only for remote servers, SSRF guard against private/metadata
 * addresses, loopback only behind the explicit local-trusted opt-in, and
 * every redirect hop re-validated.
 */
export default function McpConnectionsPanel({ user, embedded = false }) {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [localTrusted, setLocalTrusted] = useState(false);
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
      <DesktopMcpSection />
      <div className={`py-3 ${embedded ? "px-0" : "px-3.5 rounded-xl border border-black/[0.07] dark:border-white/[0.08]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold text-black/85 dark:text-white/90 flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5" strokeWidth={1.75} />
              MCP servers
            </h2>
            <p className="mt-0.5 text-[11.5px] leading-snug text-black/55 dark:text-white/55">
              Connect any MCP server by URL. Remote servers must use HTTPS on a public
              address; sign-in happens through the server&apos;s own OAuth when it asks for it.
            </p>
          </div>
        </div>

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

/**
 * MCP servers that run ON this Mac (Blender, Ableton, any stdio server).
 * Owned by the local MCP host in the Electron main process — the cloud never
 * sees these — so this section only exists inside the desktop shell.
 */
function DesktopMcpSection() {
  const available = isDesktopMcpAvailable();
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [detailId, setDetailId] = useState(null);
  const [detailTools, setDetailTools] = useState([]);
  const [catalog, setCatalog] = useState([]);

  const refresh = useCallback(async () => {
    if (!available) return;
    const res = await desktopMcpRun("list");
    setRows(Array.isArray(res.connections) ? res.connections : []);
  }, [available]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Chips come from the vetted catalog in Electron main (the same source the
  // chat connect tool uses), badged with what is actually installed here.
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    desktopMcpRun("catalog").then((res) => {
      if (!cancelled && Array.isArray(res.entries)) setCatalog(res.entries);
    });
    return () => {
      cancelled = true;
    };
  }, [available]);

  if (!available) return null;

  const connectedNames = new Set(rows.map((row) => row.name.toLowerCase()));
  // One-click chips: zero-config entries only (API-key servers connect through
  // chat, which collects the key). Detected apps float to the front — the chip
  // row should read as "your Mac", not "our catalog".
  const suggestions = catalog
    .filter((item) => !item.envKeys?.length && !connectedNames.has(item.name.toLowerCase()))
    .sort((a, b) => Number(b.detected) - Number(a.detected))
    .slice(0, 8);

  const doAdd = async ({ label, command }) => {
    setBusy(true);
    setError("");
    try {
      const res = await desktopMcpRun("add", { name: label, commandLine: command });
      if (res.ok === false) {
        setError(
          res.error === "install_confirmation_required"
            ? "This command installs a package on first run — add it again to confirm."
            : res.message || res.error || "Could not connect",
        );
      } else {
        setName("");
        setCommandLine("");
      }
      invalidateDesktopMcpSummary();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const act = async (op, id) => {
    setBusy(true);
    setError("");
    try {
      const res = await desktopMcpRun(op, { id });
      if (res.ok === false && (res.message || res.error)) setError(res.message || res.error);
      invalidateDesktopMcpSummary();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const loadDetail = async (id) => {
    if (detailId === id) {
      setDetailId(null);
      setDetailTools([]);
      return;
    }
    const res = await desktopMcpRun("detail", { id });
    setDetailId(id);
    setDetailTools(Array.isArray(res.tools) ? res.tools : []);
  };

  return (
    <div className="py-3 mb-4 border-b border-black/[0.06] dark:border-white/[0.08]">
      <h2 className="text-[13.5px] font-semibold text-black/85 dark:text-white/90 flex items-center gap-1.5">
        <Monitor className="w-3.5 h-3.5" strokeWidth={1.75} />
        On this Mac
      </h2>
      <p className="mt-0.5 text-[11.5px] leading-snug text-black/55 dark:text-white/55">
        MCP servers that run on this computer and control desktop apps — Blender, Ableton,
        or any local server. LYKN starts them on demand; nothing leaves your machine.
      </p>

      {suggestions.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {suggestions.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy}
              title={`${item.description}\n\nRuns: ${item.command}${item.setup?.length ? `\n\nSetup: ${item.setup.join(" → ")}` : ""}`}
              onClick={() => doAdd({ label: item.name, command: item.command })}
              className="px-2.5 h-7 rounded-full text-[11.5px] font-medium border border-black/10 text-black/70 hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-white/75 dark:hover:bg-white/[0.06]"
            >
              + {item.name}
              {item.detected ? <span className="ml-1 text-emerald-600 dark:text-emerald-400">•</span> : null}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (commandLine.trim()) doAdd({ label: name.trim(), command: commandLine.trim() });
        }}
        className="mt-2.5 grid gap-2"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Label (e.g. Blender)"
          className="h-8 rounded-md border border-black/10 bg-transparent px-2.5 text-[12.5px] outline-none dark:border-white/10"
        />
        <input
          value={commandLine}
          onChange={(e) => setCommandLine(e.target.value)}
          placeholder="Launch command (e.g. uvx blender-mcp)"
          required
          className="h-8 rounded-md border border-black/10 bg-transparent px-2.5 text-[12.5px] font-mono outline-none dark:border-white/10"
        />
        <button
          type="submit"
          disabled={busy || !commandLine.trim()}
          className="h-8 rounded-md bg-black text-[12px] font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {busy ? "Connecting…" : "Connect local server"}
        </button>
      </form>

      {error && <p className="mt-2 text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}

      {rows.length > 0 && (
        <div className="mt-3 divide-y divide-black/[0.06] dark:divide-white/[0.08]">
          {rows.map((conn) => (
            <div key={conn.id} className="py-2.5">
              <div className="flex items-start justify-between gap-3">
                <button type="button" className="min-w-0 text-left" onClick={() => loadDetail(conn.id)}>
                  <span className="block text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate">
                    {conn.name}
                  </span>
                  <span className="block text-[11px] text-black/45 dark:text-white/45 truncate font-mono">
                    {conn.command} {(conn.args || []).join(" ")}
                  </span>
                  <span className="block mt-0.5 text-[11px] text-black/55 dark:text-white/55">
                    {statusLabel(conn.status)}
                    {conn.toolCount ? ` · ${conn.toolCount} tools` : ""}
                    {conn.lastError ? ` · ${conn.lastError}` : ""}
                  </span>
                </button>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {conn.status !== "connected" && (
                    <button
                      type="button"
                      className="px-2 h-7 rounded-md text-[11px] font-medium border border-black/10 dark:border-white/15"
                      onClick={() => act("reconnect", conn.id)}
                    >
                      Reconnect
                    </button>
                  )}
                  <button
                    type="button"
                    title="Remove"
                    onClick={() => act("remove", conn.id)}
                    className="p-1.5 rounded-md text-black/50 hover:bg-black/[0.04] dark:text-white/50 dark:hover:bg-white/[0.06]"
                  >
                    <Unplug className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {detailId === conn.id && detailTools.length > 0 && (
                <details open className="mt-1.5 text-[11px] text-black/50 dark:text-white/50">
                  <summary>Tools</summary>
                  <ul className="mt-1 space-y-0.5">
                    {detailTools.map((tool) => (
                      <li key={tool.name}>
                        {tool.name}
                        {tool.consequence === "consequential" ? " · asks approval once" : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
