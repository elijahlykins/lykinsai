import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";
import { toast } from "@/components/ui/use-toast";
import { toUserFacingError } from "@/lib/ai/userFacingErrors";
import {
  Rss,
  Plus,
  Loader2,
  RefreshCw,
  Pause,
  Play,
  Trash2,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";

const FETCH_HEADERS_BASE = { "Content-Type": "application/json" };

async function authedFetch(path, init = {}) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token || "";
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...FETCH_HEADERS_BASE,
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

export default function RssDialog({ open, onOpenChange }) {
  const [feeds, setFeeds] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [input, setInput] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [preview, setPreview] = useState(null); // { feedUrl, title, ... }
  const [previewError, setPreviewError] = useState("");
  const [adding, setAdding] = useState(false);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await authedFetch("/api/feeds");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFeeds(data.feeds || []);
    } catch (err) {
      toast({
        title: "Couldn't load feeds",
        description: toUserFacingError(err),
        variant: "destructive",
      });
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Reset and reload whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setInput("");
    setPreview(null);
    setPreviewError("");
    refreshList();
  }, [open, refreshList]);

  // ── Discovery (debounced on Enter / Discover click) ──────────────────────
  const handleDiscover = useCallback(
    async (rawUrl) => {
      const url = (rawUrl || "").trim();
      if (!url) return;
      setDiscovering(true);
      setPreviewError("");
      setPreview(null);
      try {
        const res = await authedFetch("/api/feeds/discover", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setPreview(data);
      } catch (err) {
        setPreviewError(toUserFacingError(err));
      } finally {
        setDiscovering(false);
      }
    },
    [],
  );

  const handleAdd = useCallback(async () => {
    if (!preview) return;
    setAdding(true);
    try {
      const res = await authedFetch("/api/feeds", {
        method: "POST",
        body: JSON.stringify({ url: preview.feedUrl, initialBackfillCount: 5 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast({
        title: "Feed added",
        description: `Polling "${data.feed.title || preview.title}" every 30 minutes. New posts will land in your Vault.`,
      });
      setInput("");
      setPreview(null);
      refreshList();
    } catch (err) {
      toast({
        title: "Couldn't add feed",
        description: toUserFacingError(err),
        variant: "destructive",
      });
    } finally {
      setAdding(false);
    }
  }, [preview, refreshList]);

  const handleRefresh = useCallback(
    async (id) => {
      try {
        const res = await authedFetch(`/api/feeds/${id}/refresh`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.status === "304") {
          toast({ title: "No new posts", description: "Feed unchanged since last fetch." });
        } else if (data.saved > 0) {
          toast({
            title: `+${data.saved} saved`,
            description: "Check your Vault.",
          });
        } else {
          toast({ title: "Feed refreshed", description: "No new posts." });
        }
        refreshList();
      } catch (err) {
        toast({
          title: "Refresh failed",
          description: toUserFacingError(err),
          variant: "destructive",
        });
      }
    },
    [refreshList],
  );

  const handleToggleStatus = useCallback(
    async (feed) => {
      const next = feed.status === "paused" ? "active" : "paused";
      try {
        const res = await authedFetch(`/api/feeds/${feed.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        refreshList();
      } catch (err) {
        toast({ title: "Update failed", description: toUserFacingError(err), variant: "destructive" });
      }
    },
    [refreshList],
  );

  const handleDelete = useCallback(
    async (feed) => {
      if (!confirm(`Stop following "${feed.title || feed.feed_url}"? Existing saved posts stay in your vault.`)) return;
      try {
        const res = await authedFetch(`/api/feeds/${feed.id}`, { method: "DELETE" });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${res.status}`);
        }
        refreshList();
      } catch (err) {
        toast({ title: "Delete failed", description: toUserFacingError(err), variant: "destructive" });
      }
    },
    [refreshList],
  );

  const sortedFeeds = useMemo(
    () => [...feeds].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    [feeds],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-white dark:bg-zinc-950 border border-black/10 dark:border-white/10 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-semibold tracking-tight flex items-center gap-2">
            <Rss className="h-4 w-4 text-orange-500" />
            RSS &amp; Atom feeds
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed text-black/60 dark:text-white/60">
            Subscribe to any blog, Substack, podcast, YouTube channel, GitHub
            release, or subreddit. New posts get pulled into your Vault
            automatically every 30 minutes.
          </DialogDescription>
        </DialogHeader>

        {/* ── Add new feed ─────────────────────────────────── */}
        <div className="rounded-2xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="paste a site URL or feed URL (e.g. nytimes.com or example.com/feed)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleDiscover(input);
              }}
              className="flex-1 min-w-0 h-9 px-3 rounded-lg border border-black/10 dark:border-white/15 bg-white dark:bg-white/5 text-[13px] text-black/85 dark:text-white/90 outline-none focus:border-black/30 dark:focus:border-white/30"
            />
            <button
              type="button"
              onClick={() => handleDiscover(input)}
              disabled={discovering || !input.trim()}
              className="h-9 px-3 rounded-lg bg-black text-white dark:bg-white dark:text-black text-[12.5px] font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {discovering ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Discover
            </button>
          </div>

          {previewError && (
            <div className="flex items-start gap-2 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 px-3 py-2 text-[11.5px] text-rose-800 dark:text-rose-200">
              <AlertTriangle className="h-3.5 w-3.5 mt-[1px] flex-shrink-0" />
              <span>{previewError}</span>
            </div>
          )}

          {preview && (
            <FeedPreview preview={preview} onAdd={handleAdd} adding={adding} />
          )}

          <div className="text-[11px] text-black/45 dark:text-white/45 leading-relaxed">
            Tip: most sites publish a feed at <code>/feed</code>, <code>/rss</code>, or
            <code> /atom.xml</code>. Substacks expose <code>/feed</code>; YouTube channels work via the
            channel page; GitHub repos via <code>/releases.atom</code>; subreddits via
            <code> /.rss</code>.
          </div>
        </div>

        {/* ── Existing subscriptions ───────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[12.5px] font-semibold tracking-tight text-black/80 dark:text-white/85">
              Your feeds
              <span className="ml-2 text-black/45 dark:text-white/45 font-normal">
                {sortedFeeds.length}
              </span>
            </h3>
            {loadingList && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-black/40 dark:text-white/40" />
            )}
          </div>

          {!loadingList && sortedFeeds.length === 0 ? (
            <div className="rounded-xl border border-dashed border-black/10 dark:border-white/10 px-4 py-6 text-center text-[12px] text-black/50 dark:text-white/50">
              No feeds yet. Add your first one above.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {sortedFeeds.map((feed) => (
                <FeedRow
                  key={feed.id}
                  feed={feed}
                  onRefresh={() => handleRefresh(feed.id)}
                  onToggle={() => handleToggleStatus(feed)}
                  onDelete={() => handleDelete(feed)}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FeedPreview({ preview, onAdd, adding }) {
  return (
    <div className="rounded-xl bg-white dark:bg-white/[0.04] border border-black/10 dark:border-white/10 p-3 space-y-3">
      <div className="flex items-start gap-3">
        {preview.iconUrl ? (
          <img
            src={preview.iconUrl}
            alt=""
            className="h-8 w-8 rounded-md flex-shrink-0 object-cover bg-black/[0.04] dark:bg-white/[0.06]"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <div className="h-8 w-8 rounded-md flex-shrink-0 bg-orange-500/10 text-orange-600 dark:text-orange-400 flex items-center justify-center">
            <Rss className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-black/85 dark:text-white/90 truncate">
            {preview.title || preview.feedUrl}
          </div>
          {preview.description && (
            <div className="text-[11.5px] text-black/55 dark:text-white/55 line-clamp-2 mt-0.5">
              {preview.description}
            </div>
          )}
          <div className="text-[10.5px] text-black/40 dark:text-white/40 mt-0.5 truncate">
            {preview.feedUrl}
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          disabled={adding}
          className="h-8 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-medium disabled:opacity-60 inline-flex items-center gap-1.5 flex-shrink-0"
        >
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add
        </button>
      </div>

      {preview.recentEntries?.length > 0 && (
        <div className="border-t border-black/[0.06] dark:border-white/10 pt-2">
          <div className="text-[10.5px] uppercase tracking-wide text-black/40 dark:text-white/40 mb-1.5">
            Recent posts
          </div>
          <ul className="space-y-1">
            {preview.recentEntries.slice(0, 3).map((entry, i) => (
              <li key={i} className="text-[11.5px] text-black/70 dark:text-white/70 truncate">
                <span className="text-black/30 dark:text-white/30 mr-1.5">›</span>
                {entry.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FeedRow({ feed, onRefresh, onToggle, onDelete }) {
  const isPaused = feed.status === "paused";
  const isError = feed.status === "error";
  const lastSeen = feed.last_success_at
    ? relativeTime(feed.last_success_at)
    : feed.last_fetched_at
      ? `tried ${relativeTime(feed.last_fetched_at)}`
      : "never polled";

  return (
    <li
      className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 transition-colors ${
        isError
          ? "border-rose-200 dark:border-rose-900/40 bg-rose-50/40 dark:bg-rose-950/15"
          : isPaused
            ? "border-black/[0.08] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02] opacity-70"
            : "border-black/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/[0.03]"
      }`}
    >
      {feed.icon_url ? (
        <img
          src={feed.icon_url}
          alt=""
          className="h-7 w-7 rounded-md object-cover flex-shrink-0 bg-black/[0.04] dark:bg-white/[0.06]"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <div className="h-7 w-7 rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 flex items-center justify-center flex-shrink-0">
          <Rss className="h-3.5 w-3.5" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-black/85 dark:text-white/90 truncate flex items-center gap-1.5">
          {feed.title || feed.feed_url}
          {feed.site_url && (
            <a
              href={feed.site_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-black/35 dark:text-white/35 hover:text-black/60 dark:hover:text-white/70"
              title="Open site"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="text-[10.5px] text-black/45 dark:text-white/45 truncate">
          {feed.items_saved || 0} saved · {lastSeen}
          {isError && feed.last_error ? ` · ${feed.last_error}` : ""}
          {isPaused ? " · paused" : ""}
        </div>
      </div>

      <div className="flex items-center gap-0.5 flex-shrink-0">
        <IconButton
          title="Refresh now"
          onClick={onRefresh}
          icon={<RefreshCw className="h-3.5 w-3.5" />}
        />
        <IconButton
          title={isPaused ? "Resume" : "Pause"}
          onClick={onToggle}
          icon={isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        />
        <IconButton
          title="Unsubscribe"
          onClick={onDelete}
          icon={<Trash2 className="h-3.5 w-3.5" />}
          danger
        />
      </div>
    </li>
  );
}

function IconButton({ icon, title, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`h-7 w-7 rounded-md flex items-center justify-center transition-colors ${
        danger
          ? "text-black/45 dark:text-white/45 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30"
          : "text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/90 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
      }`}
    >
      {icon}
    </button>
  );
}

// Tiny relative-time formatter so we don't pull in date-fns just for this.
function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "—";
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
