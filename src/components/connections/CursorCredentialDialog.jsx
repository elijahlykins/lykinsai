import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Trash2 } from "lucide-react";

import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import { toast } from "@/components/ui/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

async function authedFetch(path, init = {}) {
  const { data } = await supabase.auth.getSession();
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
      Authorization: `Bearer ${data?.session?.access_token || ""}`,
    },
  });
}

export default function CursorCredentialDialog({ open, onOpenChange }) {
  const [connections, setConnections] = useState([]);
  const [apiKey, setApiKey] = useState("");
  const [repo, setRepo] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authedFetch("/api/cursor/credentials");
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load Cursor credentials");
      setConnections(body.connections || []);
    } catch (error) {
      toast({ title: "Couldn't load Cursor", description: error.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setApiKey("");
    setRepo("");
    void refresh();
  }, [open, refresh]);

  const save = async (event) => {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      const response = await authedFetch("/api/cursor/credentials", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey.trim(), repo: repo.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Cursor rejected the credential");
      setApiKey("");
      setRepo("");
      await refresh();
      toast({ title: "Cursor connected", description: "Cloud builds can now use your account." });
    } catch (error) {
      toast({ title: "Couldn't connect Cursor", description: error.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (connection) => {
    if (!window.confirm("Disconnect this Cursor credential? In-flight builds may stop updating.")) return;
    const response = await authedFetch(`/api/cursor/credentials/${connection.id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      toast({ title: "Couldn't disconnect Cursor", variant: "destructive" });
      return;
    }
    await refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cursor Cloud</DialogTitle>
          <DialogDescription>
            Connect your own Cursor API key for cloud-agent builds. The key stays encrypted
            and is never sent to the model.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-20 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-black/45 dark:text-white/45" />
          </div>
        ) : connections.length > 0 ? (
          <div className="space-y-2">
            {connections.map((connection) => (
              <div
                key={connection.id}
                className="flex items-center gap-3 rounded-xl border border-black/10 px-3 py-2.5 dark:border-white/10"
              >
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {connection.account_display_name || "Cursor Cloud"}
                  </div>
                  <div className="truncate text-xs text-black/45 dark:text-white/45">
                    {connection.metadata?.default_repo || "No default repository"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(connection)}
                  className="rounded-lg p-2 text-black/40 hover:bg-red-500/10 hover:text-red-500 dark:text-white/40"
                  aria-label="Disconnect Cursor"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <form onSubmit={save} className="space-y-3">
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Cursor API key"
            autoComplete="off"
            className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-white/15"
          />
          <input
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="Default repository (optional, owner/repo)"
            className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-white/15"
          />
          <div className="flex items-center justify-between gap-3">
            <a
              href="https://cursor.com/dashboard"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              Create a key <ExternalLink className="h-3 w-3" />
            </a>
            <button
              type="submit"
              disabled={saving || !apiKey.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {connections.length ? "Replace key" : "Connect"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
