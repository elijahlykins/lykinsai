import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, RefreshCw, Unplug, Pencil } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

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

function trustLabel(trust) {
  if (trust === "local_trusted") return "Local trusted";
  if (trust === "official") return "Official";
  if (trust === "verified") return "Verified";
  if (trust === "enterprise") return "Enterprise";
  if (trust === "community") return "Community";
  return "Custom";
}

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

  const refresh = useCallback(async () => {
    if (!user) {
      setConnections([]);
      return;
    }
    setLoading(true);
    try {
      const res = await authedFetch("/api/mcp/connections");
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

  const add = async (event) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await authedFetch("/api/mcp/connections", {
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
        window.open(data.authorizationUrl, "lykn-mcp-oauth", "width=480,height=720");
        setUrl("");
        setName("");
        setToken("");
      } else if (!res.ok || data.ok === false) {
        if (data.error === "authentication_required" || data.connection?.status === "authentication_required") {
          setError("Authentication required. Use Connect on the connection row, or paste a bearer token if the server accepts one.");
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
      const res = await authedFetch(`/api/mcp/connections/${id}${path}`, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (data.authorizationUrl) {
        window.open(data.authorizationUrl, "lykn-mcp-oauth", "width=480,height=720");
      } else if (!res.ok && data.message) {
        setError(data.message);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async (id) => {
    await act(id, "", "PATCH", { name: renameValue, accountLabel: renameValue });
    setRenaming(null);
  };

  return (
    <section className={`${embedded ? "mb-5" : "mb-6"}`}>
      <div className={`py-3 ${embedded ? "px-0" : "px-3.5 rounded-xl border border-black/[0.07] dark:border-white/[0.08]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold text-black/85 dark:text-white/90 flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5" strokeWidth={1.75} />
              MCP
            </h2>
            <p className="mt-0.5 text-[11.5px] leading-snug text-black/55 dark:text-white/55">
              Point LYKN at a remote MCP server. Custom URLs stay Custom even with TLS. Tools stay in their source app.
            </p>
          </div>
        </div>

        <form onSubmit={add} className="mt-3 grid gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Label (e.g. Work Google)"
            className="h-8 rounded-md border border-black/10 dark:border-white/10 bg-transparent px-2.5 text-[12.5px] outline-none focus:border-black/25 dark:focus:border-white/25"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/mcp"
            required
            className="h-8 rounded-md border border-black/10 dark:border-white/10 bg-transparent px-2.5 text-[12.5px] outline-none focus:border-black/25 dark:focus:border-white/25"
          />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token (optional)"
            type="password"
            autoComplete="off"
            className="h-8 rounded-md border border-black/10 dark:border-white/10 bg-transparent px-2.5 text-[12.5px] outline-none focus:border-black/25 dark:focus:border-white/25"
          />
          <label className="flex items-center gap-2 text-[11.5px] text-black/55 dark:text-white/55">
            <input type="checkbox" checked={localTrusted} onChange={(e) => setLocalTrusted(e.target.checked)} />
            Local trusted server (loopback only)
          </label>
          <button
            type="submit"
            disabled={busy || !user}
            className="h-8 rounded-md bg-black text-white dark:bg-white dark:text-black text-[12px] font-medium disabled:opacity-50"
          >
            {busy ? "Connecting…" : "Add MCP"}
          </button>
          {error && <p className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
        </form>

        <div className="mt-3 divide-y divide-black/[0.06] dark:divide-white/[0.08]">
          {loading && (
            <div className="py-2 text-[11.5px] text-black/45 dark:text-white/45 flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading
            </div>
          )}
          {!loading && connections.length === 0 && (
            <p className="py-2 text-[11.5px] text-black/45 dark:text-white/45">No MCP servers connected.</p>
          )}
          {connections.map((conn) => (
            <div key={conn.id} className="py-2.5 flex items-start justify-between gap-3">
              <div className="min-w-0">
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
                      className="h-7 w-40 rounded-md border border-black/10 dark:border-white/10 bg-transparent px-2 text-[12px] outline-none"
                    />
                    <button type="submit" className="text-[11px] font-medium">Save</button>
                  </form>
                ) : (
                  <div className="text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate">
                    {conn.accountLabel || conn.name}
                  </div>
                )}
                <div className="text-[11px] text-black/45 dark:text-white/45 truncate">
                  {conn.accountIdentity ? `${conn.accountIdentity} · ` : ""}
                  {conn.serverUrl}
                </div>
                <div className="mt-0.5 text-[11px] text-black/55 dark:text-white/55">
                  {statusLabel(conn.status)}
                  {` · ${trustLabel(conn.trustLevel)}`}
                  {conn.toolCount ? ` · ${conn.toolCount} tools` : ""}
                  {conn.lastError ? ` · ${conn.lastError}` : ""}
                </div>
              </div>
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
                {conn.status === "disconnected" && (
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
          ))}
        </div>
      </div>
    </section>
  );
}
