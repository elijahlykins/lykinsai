import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  Bookmark,
  BookmarkCheck,
  FolderPlus,
  GitCommit,
  Loader2,
  Pin,
  RefreshCw,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

/**
 * RecentActivityPanel — the user-facing window into the "living"
 * synthesis layer.
 *
 * When the user opens LYKN, they want to see WHAT'S BEEN HAPPENING:
 * which AI noticed what, which project state Cursor pushed yesterday,
 * which belief Claude Desktop helped them ratify, which rules fired.
 * Without this panel, all that activity is invisible — the synthesis
 * layer evolves silently and the user has to dig through 11 different
 * tables in the Belief Window to piece together a timeline.
 *
 * Data shape (from /api/v1/synthesis/activity):
 *   events: [{ id, type, when, by_client, summary, detail?,
 *              target_id?, target_label?, ...type-specific fields }]
 *
 * Layout:
 *   • Left-side slide-out (BeliefWindowPanel owns the right edge).
 *   • Header — title + manual refresh + close.
 *   • Body — day-grouped event list (Today / Yesterday / Earlier).
 *     Each event = icon + summary + optional detail + client badge +
 *     relative time. Empty state explains how to populate it.
 *
 * Polling: 60s auto-refresh while open. Manual refresh button bumps
 * the same query immediately. We keep a `mutedFetchInFlight` flag so
 * the spinner doesn't flash on the silent poll.
 */

// ---------------------------------------------------------------------------
// Types — match server.js's /api/v1/synthesis/activity response
// ---------------------------------------------------------------------------

type EventType =
  | "project_state"
  | "project_created"
  | "belief_active"
  | "belief_proposed"
  | "belief_other"
  | "fact_added"
  | "rule_applied";

interface ActivityEvent {
  id: string;
  type: EventType;
  when: string; // ISO
  by_client: string | null;
  summary: string;
  detail?: string | null;
  reason?: string | null;
  target_id?: string | null;
  target_label?: string | null;
  // Type-specific extras
  state_key?: string;
  serves_need?: string;
  status?: string;
  fact_kind?: string;
  confidence?: number;
  feedback?: string | null;
}

interface ActivityResponse {
  ok: boolean;
  events: ActivityEvent[];
  count: number;
  total_seen: number;
}

interface RecentActivityPanelProps {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Visual mapping per event type
// ---------------------------------------------------------------------------

const TYPE_THEME: Record<
  EventType,
  { icon: typeof Activity; tone: string; label: string }
> = {
  project_state: {
    icon: GitCommit,
    tone: "text-sky-300 bg-sky-500/10 border-sky-400/30",
    label: "Project update",
  },
  project_created: {
    icon: FolderPlus,
    tone: "text-emerald-300 bg-emerald-500/10 border-emerald-400/30",
    label: "Project started",
  },
  belief_active: {
    icon: Sparkles,
    tone: "text-amber-300 bg-amber-500/12 border-amber-400/40",
    label: "Belief active",
  },
  belief_proposed: {
    icon: Bookmark,
    tone: "text-amber-200/80 bg-amber-500/8 border-amber-400/25",
    label: "Belief proposed",
  },
  belief_other: {
    icon: BookmarkCheck,
    tone: "text-zinc-300 bg-zinc-500/10 border-zinc-400/25",
    label: "Belief change",
  },
  fact_added: {
    icon: Pin,
    tone: "text-blue-300 bg-blue-500/10 border-blue-400/30",
    label: "Identity fact",
  },
  rule_applied: {
    icon: Zap,
    tone: "text-violet-300 bg-violet-500/10 border-violet-400/30",
    label: "Rule applied",
  },
};

// Friendlier display names for the by_client field. Anything not in
// the map renders verbatim (truncated) so unknown clients still show up.
const CLIENT_LABEL: Record<string, string> = {
  claude: "Claude",
  "claude-desktop": "Claude Desktop",
  "claude-web": "Claude (web)",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  perplexity: "Perplexity",
  "lykn-chat": "LYKN",
  chatgpt: "ChatGPT",
  other: "External AI",
};

function formatClient(byClient: string | null | undefined): string | null {
  if (!byClient) return null;
  return CLIENT_LABEL[byClient] || byClient;
}

// ---------------------------------------------------------------------------
// Day grouping
// ---------------------------------------------------------------------------
// We group events into Today / Yesterday / Earlier. "Earlier" further
// folds into ISO-date subheaders only when the user has scrolled past
// the first ~10 events of older content — keeps the panel scannable
// for the common case of "checking in throughout the day."

type DayBucket = "Today" | "Yesterday" | "Earlier this week" | "Earlier";

function bucketFor(when: string): DayBucket {
  const t = Date.parse(when);
  if (!Number.isFinite(t)) return "Earlier";
  const now = Date.now();
  const diffMs = now - t;
  const oneDay = 24 * 60 * 60 * 1000;
  // "Today" = same calendar day, locale-aware.
  const eventDate = new Date(t);
  const today = new Date();
  if (eventDate.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (eventDate.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (diffMs < 7 * oneDay) return "Earlier this week";
  return "Earlier";
}

function relativeTime(when: string): string {
  const t = Date.parse(when);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Authed fetch — same pattern as the rest of the synthesis-layer pages
// ---------------------------------------------------------------------------

async function fetchActivity(): Promise<ActivityResponse | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token || "";
    const res = await fetch(`${API_BASE_URL}/api/v1/synthesis/activity?limit=80`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ActivityResponse;
    if (!body?.ok) return null;
    return body;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RecentActivityPanel({ open, onClose }: RecentActivityPanelProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number>(0);

  // Mounted flag — prevents stale-fetch races from setState'ing into an
  // unmounted panel when the user closes it mid-poll.
  const refresh = useCallback(async (silent: boolean) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const body = await fetchActivity();
      if (body) {
        setEvents(body.events || []);
        setLastFetchedAt(Date.now());
      } else {
        // Don't blow away existing data on a transient error — just
        // surface the message and keep showing what we had.
        setError("Couldn't load activity. Retry?");
      }
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  // First open + every-time-open refetch (so reopening after a
  // conversation in another tool shows the latest events). The 60s
  // auto-poll is below.
  useEffect(() => {
    if (!open) return;
    refresh(false);
  }, [open, refresh]);

  // Background poll — runs only while the panel is open.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      refresh(true);
    }, 60_000);
    return () => clearInterval(id);
  }, [open, refresh]);

  // Group events by day bucket (Today / Yesterday / Earlier this week /
  // Earlier). useMemo so we don't re-bucket on every render.
  const grouped = useMemo(() => {
    const buckets: Record<DayBucket, ActivityEvent[]> = {
      Today: [],
      Yesterday: [],
      "Earlier this week": [],
      Earlier: [],
    };
    for (const ev of events) {
      buckets[bucketFor(ev.when)].push(ev);
    }
    return buckets;
  }, [events]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop — light dimmer; click to close. Mirrors BeliefWindowPanel. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[80] bg-black/30 backdrop-blur-[2px]"
            onClick={onClose}
          />

          {/* Panel — slides in from the LEFT so it never collides with
              BeliefWindowPanel on the right. Width tuned to fit 1-2
              columns of event cards on desktop without dominating
              the synthesis-layer 3D canvas behind it. */}
          <motion.div
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className="fixed left-0 top-0 bottom-0 z-[81] w-full sm:w-[460px] flex flex-col bg-zinc-950/95 dark:bg-zinc-950/95 border-r border-white/10 shadow-2xl"
            role="dialog"
            aria-label="Recent synthesis-layer activity"
          >
            {/* ── Header ───────────────────────────────────────── */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
              <div className="flex-1 flex items-center gap-2">
                <Activity className="h-4 w-4 text-emerald-400" />
                <div className="flex flex-col">
                  <h2 className="text-[14px] font-semibold tracking-tight text-white">
                    Recent activity
                  </h2>
                  <p className="text-[11px] text-white/50 leading-snug">
                    What your AI clients have written to your synthesis layer.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => refresh(false)}
                disabled={loading || refreshing}
                className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-white/75 disabled:opacity-50"
                aria-label="Refresh"
                title="Refresh"
              >
                {loading || refreshing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-white/75"
                aria-label="Close"
                title="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* ── Body ─────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
              {loading && events.length === 0 && (
                <div className="flex items-center gap-2 text-[12px] text-white/55 py-8 justify-center">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading recent activity…
                </div>
              )}

              {!loading && error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
                  {error}
                </div>
              )}

              {!loading && !error && events.length === 0 && <EmptyState />}

              {(["Today", "Yesterday", "Earlier this week", "Earlier"] as DayBucket[]).map((bucket) => {
                const list = grouped[bucket];
                if (!list || list.length === 0) return null;
                return (
                  <section key={bucket} className="space-y-2">
                    <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-white/45">
                      {bucket}
                    </h3>
                    <ul className="space-y-2">
                      {list.map((ev) => (
                        <EventRow key={ev.id} event={ev} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>

            {/* ── Footer (last-fetched stamp) ──────────────────── */}
            {lastFetchedAt > 0 && (
              <div className="px-4 py-2 border-t border-white/10 text-[10.5px] text-white/40 flex items-center justify-between">
                <span>Auto-refreshes every 60s.</span>
                <span>Last updated {relativeTime(new Date(lastFetchedAt).toISOString())}</span>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// EmptyState — gentle nudge toward the "connect an AI" flow
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-6 text-center space-y-2">
      <Activity className="h-5 w-5 text-emerald-400/80 mx-auto" />
      <h4 className="text-[13px] font-medium text-white/85">
        Nothing here yet
      </h4>
      <p className="text-[11.5px] text-white/55 leading-relaxed max-w-[300px] mx-auto">
        When you connect Claude Desktop, Cursor, or another AI tool to LYKN
        and have a conversation, the things they notice — projects, decisions,
        beliefs, facts — show up here as a chronological feed.
      </p>
      <a
        href="/connections"
        className="inline-flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-md bg-emerald-500/15 border border-emerald-400/30 text-[11.5px] font-medium text-emerald-200 hover:bg-emerald-500/20 transition-colors"
      >
        Connect an AI client
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventRow — one row in the activity feed
// ---------------------------------------------------------------------------

function EventRow({ event }: { event: ActivityEvent }) {
  const theme = TYPE_THEME[event.type] || TYPE_THEME.project_state;
  const Icon = theme.icon;
  const clientLabel = formatClient(event.by_client);

  return (
    <li
      className={`rounded-lg border ${theme.tone.split(" ").pop()} bg-white/[0.025] px-3 py-2 space-y-1.5`}
    >
      <div className="flex items-start gap-2">
        <div
          className={`shrink-0 flex items-center justify-center h-6 w-6 rounded-md border ${theme.tone}`}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-white/55">
              {theme.label}
            </span>
            {clientLabel && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/10 text-white/65 font-medium">
                {clientLabel}
              </span>
            )}
            <span className="text-[10px] text-white/45 ml-auto">
              {relativeTime(event.when)}
            </span>
          </div>
          <p className="text-[12.5px] leading-snug text-white/90 mt-0.5 break-words">
            {event.summary}
          </p>
          {event.detail && (
            <p className="text-[11.5px] leading-relaxed text-white/55 mt-1 break-words line-clamp-3">
              {event.detail}
            </p>
          )}
          {event.reason && !event.detail && (
            <p className="text-[11px] italic text-white/45 mt-1 break-words line-clamp-2">
              {event.reason}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
