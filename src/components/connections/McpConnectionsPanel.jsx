import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, RefreshCw, Unplug } from "lucide-react";
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
  if (status === "refreshing") return "Refreshing";
  if (status === "offline") return "Offline";
  if (status === "error") return "Error";
  return "Disconnected";
}

export default function McpConnectionsPanel({ user, embedded = false }) {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        if (data.error === "authentication_required" || data.connection?.status === "authentication_required") {
          setError("Authentication required. Phase 2 will handle MCP OAuth. A bearer token can be pasted if the server accepts one.");
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

  const act = async (id, path, method = "POST") => {
    setBusy(true);
    try {
      await authedFetch(`/api/mcp/connections/${id}${path}`, { method });
      await refresh();
    } finally {
      setBusy(false);
    }
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
              Point LYKN at a remote MCP server. Tools stay in their source app. Vault is not used unless you save something.
            </p>
          </div>
        </div>

        <form onSubmit={add} className="mt-3 grid gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
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
                <div className="text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate">{conn.name}</div>
                <div className="text-[11px] text-black/45 dark:text-white/45 truncate">{conn.serverUrl}</div>
                <div className="mt-0.5 text-[11px] text-black/55 dark:text-white/55">
                  {statusLabel(conn.status)}
                  {conn.toolCount ? ` · ${conn.toolCount} tools` : ""}
                  {conn.lastError ? ` · ${conn.lastError}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
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
                  onClick={() => act(conn.id, "", "DELETE")}
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
