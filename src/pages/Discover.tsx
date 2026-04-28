import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Compass,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  Video as VideoIcon,
} from "lucide-react";
import { motion } from "framer-motion";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { saveLinkToVault } from "@/lib/saveToVault";
import { toast } from "@/components/ui/use-toast";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type DiscoverKind = "article" | "video";
type DiscoverMode = "all" | "articles" | "videos";

interface DiscoverItem {
  kind: DiscoverKind;
  url: string;
  videoId?: string;
  title: string;
  snippet: string;
  source: string;
  thumbnail: string | null;
  publishedAt: string | null;
  query?: string;
  aiTakeaway?: string | null;
  viewCount?: number;
  likeCount?: number;
  durationSec?: number;
}

interface DiscoverFeedResponse {
  ok: boolean;
  source?: "db" | "live";
  themes: string[];
  queries?: string[];
  articles: DiscoverItem[];
  videos: DiscoverItem[];
  items?: DiscoverItem[];
  cursor: string | null;
  hasMore?: boolean;
  page?: number;
  generatedAt: string;
  cached?: boolean;
  empty?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

// Stable colored gradient for articles missing a hero image — derived from
// the source domain so the same publisher always gets the same colors.
const PLACEHOLDER_PALETTES: Array<[string, string]> = [
  ["from-rose-400/30", "to-orange-400/30"],
  ["from-amber-400/30", "to-yellow-400/30"],
  ["from-emerald-400/30", "to-teal-400/30"],
  ["from-sky-400/30", "to-indigo-400/30"],
  ["from-violet-400/30", "to-fuchsia-400/30"],
  ["from-pink-400/30", "to-rose-400/30"],
  ["from-cyan-400/30", "to-blue-400/30"],
  ["from-lime-400/30", "to-green-400/30"],
];

function paletteForSource(source: string): [string, string] {
  let hash = 0;
  const s = source || "x";
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PLACEHOLDER_PALETTES.length;
  return PLACEHOLDER_PALETTES[idx];
}

function publisherInitial(source: string): string {
  const s = String(source || "").replace(/^www\./, "").trim();
  if (!s) return "?";
  const firstAlpha = s.match(/[a-z0-9]/i);
  return firstAlpha ? firstAlpha[0].toUpperCase() : s[0].toUpperCase();
}

function formatViewCount(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n < 1000) return `${n} views`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K views`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M views`;
  return `${(n / 1_000_000_000).toFixed(1)}B views`;
}

function formatDuration(sec: number | undefined): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

async function fetchDiscoverFeed(opts: {
  mode: DiscoverMode;
  recencyDays: number;
  themes?: string[];
  force?: boolean;
  cursor?: string | null;
}): Promise<DiscoverFeedResponse> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error("not_signed_in");

  const res = await fetch(`${API_BASE_URL}/api/discover/feed`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: opts.mode,
      recencyDays: opts.recencyDays,
      themes: opts.themes,
      force: opts.force,
      cursor: opts.cursor ?? null,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discover feed failed: ${res.status} ${text.slice(0, 160)}`);
  }
  return (await res.json()) as DiscoverFeedResponse;
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function Discover() {
  const { user } = useAuth();
  const [mode, setMode] = useState<DiscoverMode>("all");
  const [recencyDays, setRecencyDays] = useState<number>(30);
  const [activeThemes, setActiveThemes] = useState<string[] | null>(null);
  const [savingItems, setSavingItems] = useState<Set<string>>(new Set());
  const [savedItems, setSavedItems] = useState<Set<string>>(new Set());
  // Some publisher og:image URLs 404 / hotlink-block / get caught by mixed-
  // content blocking once the browser actually loads them. Track those so
  // we can render the gradient placeholder instead of leaving a blank tile.
  const [failedThumbnails, setFailedThumbnails] = useState<Set<string>>(new Set());
  const markThumbnailFailed = useCallback((url: string) => {
    setFailedThumbnails((prev) => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
    refetch,
    error,
  } = useInfiniteQuery<DiscoverFeedResponse, Error, DiscoverFeedResponse, readonly unknown[], string | null>({
    queryKey: [
      "discover-feed",
      user?.id,
      mode,
      recencyDays,
      (activeThemes || []).join("|"),
    ],
    queryFn: ({ pageParam }) =>
      fetchDiscoverFeed({
        mode,
        recencyDays,
        themes: activeThemes ?? undefined,
        cursor: pageParam,
      }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => {
      if (!lastPage?.cursor) return undefined;
      return lastPage.cursor;
    },
    enabled: Boolean(user?.id),
    // Always refetch on mount so theme changes / deploys / new ingests
    // surface immediately instead of being shadowed by stale client cache.
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  const pages = data?.pages ?? [];
  const themes = pages[0]?.themes ?? [];

  // Merge all loaded pages into one flat list, deduped by URL/videoId so a
  // theme rotation overlap doesn't show the same item twice.
  const allItems = useMemo<DiscoverItem[]>(() => {
    if (pages.length === 0) return [];
    const seen = new Set<string>();
    const out: DiscoverItem[] = [];
    for (const pg of pages) {
      let pgItems: DiscoverItem[];
      if (mode === "articles") pgItems = pg.articles;
      else if (mode === "videos") pgItems = pg.videos;
      else if (Array.isArray(pg.items) && pg.items.length > 0) pgItems = pg.items;
      else {
        pgItems = [...pg.articles, ...pg.videos].sort((a, b) => {
          const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
          const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
          return tb - ta;
        });
      }
      for (const it of pgItems) {
        const key =
          it.kind === "video" ? `v:${it.videoId}` : `a:${(it.url || "").toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(it);
      }
    }
    return out;
  }, [pages, mode]);

  // ── Infinite scroll: fetch the next page when a sentinel near the bottom
  // ── enters the viewport. Using IntersectionObserver instead of scroll
  // ── listeners keeps it cheap.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return undefined;
    if (!hasNextPage || isFetchingNextPage) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void fetchNextPage();
            break;
          }
        }
      },
      { rootMargin: "600px 0px 600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, allItems.length]);

  const toggleTheme = useCallback((theme: string) => {
    setActiveThemes((prev) => {
      const current = prev ?? [];
      if (current.includes(theme)) {
        const next = current.filter((t) => t !== theme);
        return next.length === 0 ? null : next;
      }
      return [...current, theme];
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    // Force-bypass the server cache for the first page so the next refetch
    // surfaces fresh data at the top of the feed.
    await fetchDiscoverFeed({
      mode,
      recencyDays,
      themes: activeThemes ?? undefined,
      force: true,
      cursor: null,
    }).catch(() => {});
    void refetch();
  }, [mode, recencyDays, activeThemes, refetch]);

  const handleSave = useCallback(
    async (item: DiscoverItem) => {
      if (!user?.id) {
        toast({ title: "Sign in to save", description: "You need an account to save items to your vault." });
        return;
      }
      const key = item.kind === "video" ? `v:${item.videoId}` : `a:${item.url}`;
      if (savedItems.has(key) || savingItems.has(key)) return;
      setSavingItems((s) => new Set(s).add(key));
      try {
        const result = await saveLinkToVault({ userId: user.id, url: item.url });
        if (result) {
          setSavedItems((s) => new Set(s).add(key));
          toast({ title: "Saved to vault", description: item.title });
        } else {
          // Already in vault (dedup) or silent failure.
          setSavedItems((s) => new Set(s).add(key));
          toast({ title: "Already in your vault", description: item.title });
        }
      } catch (e) {
        toast({ title: "Save failed", description: e instanceof Error ? e.message : "Unknown error" });
      } finally {
        setSavingItems((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [user?.id, savedItems, savingItems],
  );

  if (!user) {
    return (
      <div className="min-h-[100svh] flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <Compass className="w-10 h-10 mx-auto mb-4 text-blue-500" />
          <h1 className="text-2xl font-semibold mb-2">Discover</h1>
          <p className="text-sm text-black/60 dark:text-white/60">
            Sign in to get a personalized stream of articles and videos pulled around what you&apos;re working on.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] px-6 md:px-10 py-10 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Compass className="w-5 h-5 text-blue-500" />
            <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-black/50 dark:text-white/50">
              For you
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Discover</h1>
          <p className="text-sm text-black/60 dark:text-white/60 mt-1.5 max-w-2xl">
            A stream of articles and videos based on the themes from your synthesis profile and recent work.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={recencyDays}
            onChange={(e) => setRecencyDays(Number(e.target.value))}
            className="text-xs bg-white/50 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-full px-3 py-1.5 outline-none hover:bg-white/70 dark:hover:bg-white/10 transition-colors"
          >
            <option value={1}>Past day</option>
            <option value={7}>Past week</option>
            <option value={30}>Past month</option>
            <option value={90}>Past 3 months</option>
            <option value={365}>Past year</option>
          </select>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isFetching}
            className="text-xs flex items-center gap-1.5 bg-white/50 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-full px-3 py-1.5 hover:bg-white/70 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
            title="Force refresh feed"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {(["all", "articles", "videos"] as DiscoverMode[]).map((m) => {
          const isActive = mode === m;
          const Icon = m === "articles" ? FileText : m === "videos" ? VideoIcon : Sparkles;
          const label = m === "all" ? "All" : m === "articles" ? "Articles" : "Videos";
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`text-xs flex items-center gap-1.5 rounded-full px-3 py-1.5 border transition-colors ${
                isActive
                  ? "bg-blue-500 text-white border-blue-500"
                  : "bg-white/50 dark:bg-white/5 border-black/10 dark:border-white/10 hover:bg-white/70 dark:hover:bg-white/10 text-black/70 dark:text-white/70"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Theme chips */}
      {themes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-8">
          <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-black/40 dark:text-white/40 mr-1">
            Themes
          </span>
          {themes.map((theme) => {
            const isActive = (activeThemes || []).includes(theme);
            const isFiltered = activeThemes && activeThemes.length > 0;
            return (
              <button
                key={theme}
                type="button"
                onClick={() => toggleTheme(theme)}
                className={`text-[0.6875rem] rounded-full px-2.5 py-1 border transition-colors ${
                  isActive
                    ? "bg-blue-500/15 border-blue-500/40 text-blue-700 dark:text-blue-300"
                    : isFiltered
                      ? "bg-transparent border-black/10 dark:border-white/10 text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
                      : "bg-white/40 dark:bg-white/5 border-black/8 dark:border-white/8 text-black/60 dark:text-white/60 hover:bg-white/60 dark:hover:bg-white/10"
                }`}
              >
                {theme}
              </button>
            );
          })}
          {activeThemes && activeThemes.length > 0 && (
            <button
              type="button"
              onClick={() => setActiveThemes(null)}
              className="text-[0.6875rem] rounded-full px-2.5 py-1 text-black/50 dark:text-white/50 hover:text-black/70 dark:hover:text-white/70 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Body */}
      {isLoading && (
        <div className="flex items-center justify-center py-20 text-black/50 dark:text-white/50">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">Curating your feed…</span>
        </div>
      )}

      {!isLoading && error && (
        <div className="text-center py-20 text-red-500/80 text-sm">
          Couldn&apos;t load your feed. {error instanceof Error ? error.message : ""}
        </div>
      )}

      {!isLoading && !error && allItems.length === 0 && (
        <div className="text-center py-20 max-w-md mx-auto">
          <Sparkles className="w-8 h-8 mx-auto mb-3 text-black/30 dark:text-white/30" />
          <p className="text-sm text-black/60 dark:text-white/60">
            No matches yet. Add a few notes or canvases so we can learn what you&apos;re into, then come back here.
          </p>
        </div>
      )}

      {!isLoading && allItems.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {allItems.map((item, idx) => {
            const key = item.kind === "video" ? `v:${item.videoId}` : `a:${item.url}`;
            const isSaving = savingItems.has(key);
            const isSaved = savedItems.has(key);
            // For YouTube videos, the maxres → hqdefault swap happens in the
            // onError below, so only treat the thumbnail as fully failed for
            // articles (or videos where even hqdefault died, which is rare).
            const effectiveThumbnail =
              item.thumbnail && !failedThumbnails.has(item.thumbnail)
                ? item.thumbnail
                : null;
            return (
              <motion.div
                key={`${key}-${idx}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: Math.min(idx * 0.015, 0.25) }}
                className="group flex flex-col rounded-2xl overflow-hidden bg-white/55 dark:bg-white/5 border border-black/8 dark:border-white/8 hover:border-black/15 dark:hover:border-white/15 hover:shadow-[0_4px_20px_-8px_rgba(0,0,0,0.15)] transition-all"
              >
                {effectiveThumbnail ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative block aspect-video overflow-hidden bg-black/5 dark:bg-white/5"
                  >
                    <img
                      src={effectiveThumbnail}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
                      onError={(e) => {
                        const img = e.currentTarget as HTMLImageElement;
                        // YouTube: ~30% of videos don't have a maxresdefault
                        // render but every video has hqdefault (480x360).
                        // Swap once before giving up.
                        if (
                          item.kind === "video" &&
                          item.videoId &&
                          img.src.includes("maxresdefault.jpg")
                        ) {
                          img.src = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
                          return;
                        }
                        // Mark the URL as failed so the next render swaps in
                        // the gradient placeholder instead of an empty tile.
                        if (item.thumbnail) markThumbnailFailed(item.thumbnail);
                      }}
                    />
                    <div className="absolute top-2 left-2 text-[0.6875rem] font-medium px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-sm text-white flex items-center gap-1">
                      {item.kind === "video" ? (
                        <>
                          <VideoIcon className="w-3 h-3" /> Video
                        </>
                      ) : (
                        <>
                          <FileText className="w-3 h-3" /> Article
                        </>
                      )}
                    </div>
                    {item.kind === "video" && item.durationSec ? (
                      <div className="absolute bottom-2 right-2 text-[0.6875rem] font-medium px-1.5 py-0.5 rounded bg-black/75 text-white tabular-nums">
                        {formatDuration(item.durationSec)}
                      </div>
                    ) : null}
                  </a>
                ) : (
                  (() => {
                    const [from, to] = paletteForSource(item.source);
                    return (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`relative block aspect-video overflow-hidden bg-gradient-to-br ${from} ${to} flex items-center justify-center`}
                      >
                        {/* Subtle dot grid for texture */}
                        <div
                          className="absolute inset-0 opacity-30 pointer-events-none"
                          style={{
                            backgroundImage:
                              "radial-gradient(currentColor 0.5px, transparent 0.5px)",
                            backgroundSize: "12px 12px",
                            color: "rgba(0,0,0,0.25)",
                          }}
                          aria-hidden
                        />
                        <div className="relative flex flex-col items-center justify-center text-center px-4">
                          <div className="w-14 h-14 rounded-2xl bg-white/85 dark:bg-white/15 backdrop-blur-sm border border-white/40 dark:border-white/10 flex items-center justify-center shadow-sm">
                            <span className="text-2xl font-semibold text-black/70 dark:text-white/85">
                              {publisherInitial(item.source)}
                            </span>
                          </div>
                          <div className="mt-2 text-[0.6875rem] font-medium tracking-wide text-black/65 dark:text-white/75 max-w-[180px] truncate">
                            {item.source || (item.kind === "video" ? "YouTube" : "Web")}
                          </div>
                        </div>
                        <div className="absolute top-2 left-2 text-[0.6875rem] font-medium px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-sm text-white flex items-center gap-1">
                          {item.kind === "video" ? (
                            <>
                              <VideoIcon className="w-3 h-3" /> Video
                            </>
                          ) : (
                            <>
                              <FileText className="w-3 h-3" /> Article
                            </>
                          )}
                        </div>
                      </a>
                    );
                  })()
                )}

                <div className="flex flex-col flex-1 p-4">
                  <div className="flex items-center gap-1.5 text-[0.6875rem] text-black/50 dark:text-white/50 mb-1.5 flex-wrap">
                    <span className="truncate max-w-[140px]" title={item.source}>
                      {item.source || (item.kind === "video" ? "YouTube" : "Web")}
                    </span>
                    {item.kind === "video" && item.viewCount ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">{formatViewCount(item.viewCount)}</span>
                      </>
                    ) : null}
                    {item.publishedAt && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{formatRelative(item.publishedAt)}</span>
                      </>
                    )}
                  </div>

                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-sm leading-snug mb-2 line-clamp-2 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  >
                    {item.title}
                  </a>

                  {item.aiTakeaway ? (
                    <p className="text-xs text-black/70 dark:text-white/75 leading-relaxed line-clamp-3 mb-3 flex-1 italic">
                      <Sparkles className="inline w-3 h-3 mr-1 text-blue-500/80 align-[-1px]" />
                      {item.aiTakeaway}
                    </p>
                  ) : item.snippet ? (
                    <p className="text-xs text-black/55 dark:text-white/55 line-clamp-3 mb-3 flex-1">{item.snippet}</p>
                  ) : null}

                  {item.query && (
                    <div className="text-[0.625rem] text-black/40 dark:text-white/40 mb-3 line-clamp-1">
                      Matched: <span className="italic">{item.query}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2 mt-auto pt-2 border-t border-black/5 dark:border-white/5">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs flex items-center gap-1 text-black/60 dark:text-white/60 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Open
                    </a>
                    <button
                      type="button"
                      onClick={() => handleSave(item)}
                      disabled={isSaving || isSaved}
                      className="ml-auto text-xs flex items-center gap-1 text-black/60 dark:text-white/60 hover:text-blue-600 dark:hover:text-blue-400 transition-colors disabled:opacity-60"
                    >
                      {isSaving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Save className="w-3.5 h-3.5" />
                      )}
                      {isSaved ? "Saved" : "Save"}
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Infinite-scroll sentinel + footer state */}
      {!isLoading && allItems.length > 0 && (
        <>
          {hasNextPage ? (
            <>
              <div ref={sentinelRef} aria-hidden className="h-1" />
              <div className="mt-8 flex items-center justify-center text-[0.6875rem] text-black/40 dark:text-white/40">
                {isFetchingNextPage ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
                    Loading more…
                  </>
                ) : (
                  <span>Scroll for more</span>
                )}
              </div>
            </>
          ) : (
            <div className="mt-8 text-center text-[0.6875rem] text-black/30 dark:text-white/30">
              That&apos;s all for now · click Refresh for a new batch
            </div>
          )}
        </>
      )}
    </div>
  );
}
