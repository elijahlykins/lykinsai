// Right-side dashboard panel rendered alongside the load-in greeting
// bubble. Designed to look like a polished personal briefing card —
// a hero stat at the top ("12 updates"), a per-lane distribution
// breakdown, a sparkline of the past 7 days of activity, and a
// synthesis-state row at the bottom. Every element is hover-aware:
// stat cells lift, lane bars glow + scale, the sparkline tracks a
// dot at the cursor, and the footer pulses on hover. The whole card
// is a launchpad — click anywhere meaningful to deep-link straight
// into the relevant surface.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Area,
  AreaChart,
  Dot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  ArrowUpRight,
  CalendarDays,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import type { LoadInUpdatesStats } from "@/lib/synthesis/loadInUpdates";

interface Props {
  stats: LoadInUpdatesStats;
  /** Optional first-name greeting, e.g. "Eli" — shown above the hero. */
  greetingName?: string;
}

// User's persistent "hide today's briefing card" preference. Keeping
// this in localStorage (not session state) so dismissing it once means
// it stays dismissed across reloads — the panel is opt-in eye candy,
// not load-bearing UI, so we honour the user's choice indefinitely
// until they explicitly bring it back via the reopen pill.
const HIDE_PREF_KEY = "lykn:loadInBrief:hidden";

// Per-lane brand palette. We keep them muted so the panel reads as a
// dashboard, not a parade of saturated swatches — each colour is the
// 400-tone of its lane so the bars stay legible in both light and
// dark themes without re-mapping.
type LaneKey = Exclude<keyof LoadInUpdatesStats["byCategory"], "health">;

const LANE_COLOR: Record<LaneKey, string> = {
  productivity: "#60a5fa",
  social: "#e879f9",
  reading: "#fbbf24",
  media: "#f472b6",
};

const LANE_LABEL: Record<LaneKey, string> = {
  productivity: "Productivity",
  social: "Social",
  reading: "Reading",
  media: "Media",
};

const LANE_HREF: Record<LaneKey, string> = {
  productivity: "/vault?category=productivity",
  social: "/vault?category=social",
  reading: "/vault?category=reading",
  media: "/vault?category=media",
};

/** Format `YYYY-MM-DD` into a short weekday label, e.g. "Mon". */
function shortDay(iso: string): string {
  const t = Date.parse(`${iso}T12:00:00`);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { weekday: "short" });
}

const LoadInBriefingPanel: React.FC<Props> = ({ stats, greetingName }) => {
  const navigate = useNavigate();

  // Hide-state mirrors the same lazy-init + persistence pattern as the
  // chat app dock so both dismissibles behave identically from the
  // user's perspective.
  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(HIDE_PREF_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (hidden) window.localStorage.setItem(HIDE_PREF_KEY, "1");
      else window.localStorage.removeItem(HIDE_PREF_KEY);
    } catch {
      // localStorage may be blocked — preference just won't persist.
    }
  }, [hidden]);

  // SPA-friendly anchor handler. Internal hrefs route via the router
  // (no full page reload), but cmd/ctrl/shift/middle-click still get
  // the browser's native "open in new tab" behaviour.
  const goInternal = useCallback(
    (href: string) => (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || (e as any).button === 1)
        return;
      e.preventDefault();
      navigate(href);
    },
    [navigate],
  );

  // Sort lanes by count (desc) so the busiest one anchors the bar
  // chart at the top of the list. Lanes with zero activity stay
  // visible but render as ghosted bars — the panel reads as
  // "everything I'm watching" not "only what's busy".
  const laneRows = useMemo(() => {
    const entries = (
      Object.entries(stats.byCategory) as Array<
        [keyof LoadInUpdatesStats["byCategory"], number]
      >
    )
      .filter((entry): entry is [LaneKey, number] => entry[0] !== "health")
      .map(([key, count]) => ({
        key,
        label: LANE_LABEL[key],
        count,
        color: LANE_COLOR[key],
        href: LANE_HREF[key],
      }));
    entries.sort((a, b) => b.count - a.count);
    return entries;
  }, [stats.byCategory]);

  const laneMax = useMemo(
    () => Math.max(1, ...laneRows.map((l) => l.count)),
    [laneRows],
  );

  // Sparkline series — the area chart wants `{name, value}` objects
  // keyed off the day label rather than the raw YYYY-MM-DD bucket
  // (which would render awkwardly along the X axis).
  const sparkData = useMemo(
    () =>
      stats.series.map((b) => ({
        day: shortDay(b.date),
        value: b.count,
        date: b.date,
      })),
    [stats.series],
  );

  const seriesMax = Math.max(...stats.series.map((b) => b.count), 0);
  const seriesTotal = stats.series.reduce((acc, b) => acc + b.count, 0);
  const seriesAvg = seriesTotal / Math.max(1, stats.series.length);
  // Trend = today vs. 7-day average. We only flash the "↑" if today
  // is meaningfully above average — otherwise the panel feels noisy.
  const today = stats.series[stats.series.length - 1]?.count ?? 0;
  const trendUp = today > seriesAvg && today > 0;

  const heroCount = stats.totalUpdates;
  const heroLabel = heroCount === 1 ? "update today" : "updates today";
  const greetingTag = greetingName
    ? `Today's briefing for ${greetingName}`
    : "Today's briefing";

  const approvalsTotal =
    stats.approvals.proposedBeliefs +
    stats.approvals.activeBeliefs +
    stats.approvals.newFacts;

  // Lane row hover tracking — drives the per-row scale + glow plus
  // the count-badge pop. Kept in component state so the hover-state
  // can decorate multiple sub-elements off the same single source of
  // truth. MUST be declared before the `hidden` early return below so
  // hook order stays stable across renders (React enforces this).
  const [hoveredLane, setHoveredLane] = useState<string | null>(null);

  // Collapsed render — a small pill in the same anchor slot so the
  // briefing can always be brought back, without taking up the full
  // 320px column the open card needs. Early return lives below every
  // hook declaration on purpose: returning before a hook would change
  // the hook count between renders and trip React's invariant.
  if (hidden) {
    return (
      <motion.button
        type="button"
        onClick={() => setHidden(false)}
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        whileHover={{ y: -1 }}
        transition={{ duration: 0.28, ease: "easeOut" }}
        title="Show today's briefing"
        aria-label="Show today's briefing"
        className="group inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-white/40 dark:border-white/10 bg-white/60 dark:bg-white/[0.06] backdrop-blur-xl shadow-[0_4px_18px_rgba(15,23,42,0.08)] dark:shadow-[0_4px_18px_rgba(0,0,0,0.4)] text-[10.5px] font-semibold text-black/65 dark:text-white/65 hover:text-black/90 dark:hover:text-white/90 hover:bg-white/80 dark:hover:bg-white/[0.10] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
      >
        <Sparkles className="w-3 h-3 text-blue-500/80 dark:text-blue-300/80" />
        <span className="tabular-nums">{heroCount}</span>
        <span className="opacity-70">briefing</span>
      </motion.button>
    );
  }

  return (
    <motion.aside
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.36, ease: "easeOut" }}
      className="group/panel relative w-full max-w-[20rem] flex-shrink-0 rounded-2xl border border-white/40 dark:border-white/10 bg-gradient-to-br from-white/70 via-white/55 to-white/40 dark:from-white/[0.07] dark:via-white/[0.04] dark:to-white/[0.02] backdrop-blur-xl shadow-[0_8px_32px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.45)] overflow-hidden transition-shadow duration-300 hover:shadow-[0_14px_44px_rgba(15,23,42,0.14)] dark:hover:shadow-[0_14px_44px_rgba(0,0,0,0.6)]"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-blue-400/15 via-fuchsia-400/10 to-transparent dark:from-blue-500/20 dark:via-fuchsia-500/10 transition-opacity duration-500 group-hover/panel:opacity-90"
      />
      {/* Subtle highlight that sweeps across the card on panel hover —
          adds a touch of "live" to the otherwise static dashboard. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-8 -top-8 h-24 opacity-0 group-hover/panel:opacity-100 transition-opacity duration-500 bg-[radial-gradient(ellipse_at_top,rgba(96,165,250,0.22),transparent_70%)] dark:bg-[radial-gradient(ellipse_at_top,rgba(96,165,250,0.18),transparent_70%)]"
      />

      {/* Dismiss control — top-right of the card. Subtle by default so
          it doesn't compete with the hero stat, but legible on hover.
          Clicking it collapses the card to the reopen pill rendered
          above. */}
      <button
        type="button"
        onClick={() => setHidden(true)}
        title="Hide briefing"
        aria-label="Hide briefing"
        className="absolute top-2.5 right-2.5 z-10 h-6 w-6 rounded-full flex items-center justify-center text-black/35 dark:text-white/35 hover:text-black/80 dark:hover:text-white/85 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
      >
        <X className="w-3.5 h-3.5" />
        <span className="sr-only">Hide briefing</span>
      </button>

      <div className="relative px-5 pt-5 pb-4">
        <div className="flex items-center gap-1.5 pr-7 text-[10.5px] uppercase tracking-[0.12em] font-semibold text-black/55 dark:text-white/55">
          <Sparkles className="w-3 h-3" />
          <span>{greetingTag}</span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <motion.span
            key={heroCount}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="text-4xl font-bold leading-none tabular-nums tracking-tight text-black/90 dark:text-white/90"
          >
            {heroCount}
          </motion.span>
          <span className="text-sm font-medium text-black/55 dark:text-white/55">
            {heroLabel}
          </span>
          {trendUp ? (
            <motion.span
              whileHover={{ scale: 1.06 }}
              className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] font-semibold text-emerald-600 dark:text-emerald-300 bg-emerald-500/10 border border-emerald-400/30 px-1.5 py-0.5 rounded-md cursor-default"
              title={`Today: ${today} · 7-day avg: ${seriesAvg.toFixed(1)}`}
            >
              <TrendingUp className="w-2.5 h-2.5" />
              Above avg
            </motion.span>
          ) : null}
        </div>
      </div>

      {/* Top stat row — calendar + approvals at-a-glance. Both cells
          are clickable: calendar → vault calendar view, approvals →
          synthesis layer. */}
      <div className="relative grid grid-cols-2 gap-2 px-5 pb-4">
        <StatCell
          icon={<CalendarDays className="w-3.5 h-3.5" />}
          tint="emerald"
          primary={stats.calendarToday}
          label="Calendar today"
          footnote={
            stats.calendarWeek > 0
              ? `+${stats.calendarWeek} this week`
              : undefined
          }
          href="/vault?category=calendar"
          onInternalClick={goInternal("/vault?category=calendar")}
        />
        <StatCell
          icon={<Sparkles className="w-3.5 h-3.5" />}
          tint="violet"
          primary={approvalsTotal}
          label="Awaiting you"
          footnote={
            stats.approvals.proposedBeliefs > 0
              ? `${stats.approvals.proposedBeliefs} need a call`
              : stats.approvals.newFacts > 0
                ? `${stats.approvals.newFacts} new neurons`
                : undefined
          }
          href="/synthesis-layer"
          onInternalClick={goInternal("/synthesis-layer")}
        />
      </div>

      {/* Sparkline — past 7 days of activity */}
      <div className="relative px-5 pb-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] font-semibold text-black/55 dark:text-white/55">
            <Activity className="w-3 h-3" />
            <span>7-day activity</span>
          </div>
          <span className="text-[10.5px] tabular-nums text-black/45 dark:text-white/45">
            {seriesTotal} total
          </span>
        </div>
        <div className="h-[68px] -mx-1 group/spark">
          {seriesMax > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={sparkData}
                margin={{ top: 4, right: 4, left: 4, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="loadInSparkFill"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.55} />
                    <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient
                    id="loadInSparkFillHover"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.75} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="day"
                  tick={{
                    fontSize: 9,
                    fill: "currentColor",
                    opacity: 0.5,
                  }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis hide domain={[0, "dataMax + 1"]} />
                <Tooltip
                  cursor={{
                    stroke: "currentColor",
                    strokeOpacity: 0.22,
                    strokeWidth: 1,
                    strokeDasharray: "2 2",
                  }}
                  contentStyle={{
                    background: "rgba(15, 23, 42, 0.94)",
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 10,
                    fontSize: 11,
                    color: "white",
                    padding: "6px 10px",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                  }}
                  labelStyle={{
                    color: "rgba(255,255,255,0.65)",
                    fontWeight: 600,
                    marginBottom: 2,
                  }}
                  formatter={(v: any) => [
                    `${v} update${v === 1 ? "" : "s"}`,
                    "",
                  ]}
                  separator=""
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#3b82f6"
                  strokeWidth={1.75}
                  fill="url(#loadInSparkFill)"
                  isAnimationActive
                  animationDuration={600}
                  activeDot={(props: any) => (
                    <Dot
                      {...props}
                      r={4.5}
                      fill="#3b82f6"
                      stroke="white"
                      strokeWidth={2}
                    />
                  )}
                  className="transition-opacity duration-300 group-hover/spark:[&_path]:!stroke-[#2563eb]"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-[11px] text-black/45 dark:text-white/45 italic">
              Quiet week. Nothing logged yet.
            </div>
          )}
        </div>
      </div>

      {/* Per-lane distribution bars — each row is a clickable link to
          the corresponding vault category, with the bar glowing and
          the count badge popping on hover. */}
      <div className="relative px-5 pb-5">
        <div className="flex items-center gap-1.5 mb-2 text-[10.5px] uppercase tracking-[0.12em] font-semibold text-black/55 dark:text-white/55">
          <span>By source</span>
        </div>
        <div className="space-y-1">
          {laneRows.map((lane, i) => {
            const pct = lane.count > 0 ? (lane.count / laneMax) * 100 : 0;
            const isHovered = hoveredLane === lane.key;
            return (
              <a
                key={lane.key}
                href={lane.href}
                onClick={goInternal(lane.href)}
                onMouseEnter={() => setHoveredLane(lane.key)}
                onMouseLeave={() => setHoveredLane(null)}
                onFocus={() => setHoveredLane(lane.key)}
                onBlur={() => setHoveredLane(null)}
                title={`Open ${lane.label} (${lane.count} ${lane.count === 1 ? "item" : "items"})`}
                className="group/lane flex items-center gap-2 px-2 py-1 -mx-2 rounded-lg transition-all duration-200 hover:bg-white/60 dark:hover:bg-white/[0.06] focus:bg-white/60 dark:focus:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
              >
                <span className="text-[11px] font-medium text-black/65 dark:text-white/65 group-hover/lane:text-black/90 dark:group-hover/lane:text-white/90 w-[68px] flex-shrink-0 truncate transition-colors">
                  {lane.label}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.06] overflow-hidden relative">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{
                      width: `${pct}%`,
                      // Subtle "breathe" on hover — the bar lifts to
                      // full opacity and gains a soft outer glow via
                      // boxShadow so the visual response feels alive
                      // without being noisy.
                      opacity: isHovered
                        ? 1
                        : lane.count > 0
                          ? 0.95
                          : 0.25,
                      boxShadow: isHovered
                        ? `0 0 12px 0 ${lane.color}88`
                        : "none",
                    }}
                    transition={{
                      width: {
                        duration: 0.55,
                        delay: 0.08 * i,
                        ease: "easeOut",
                      },
                      opacity: { duration: 0.18 },
                      boxShadow: { duration: 0.2 },
                    }}
                    className="h-full rounded-full"
                    style={{ background: lane.color }}
                  />
                </div>
                <motion.span
                  animate={{ scale: isHovered ? 1.18 : 1 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="text-[11px] tabular-nums font-semibold text-black/70 dark:text-white/70 group-hover/lane:text-black/95 dark:group-hover/lane:text-white/95 w-5 text-right transition-colors"
                >
                  {lane.count}
                </motion.span>
                <ArrowUpRight className="w-3 h-3 text-black/30 dark:text-white/30 group-hover/lane:text-black/70 dark:group-hover/lane:text-white/70 opacity-0 group-hover/lane:opacity-100 -translate-x-1 group-hover/lane:translate-x-0 transition-all" />
              </a>
            );
          })}
        </div>
      </div>

      {/* Synthesis footer — quiet status if nothing pending. The whole
          row is a link to the synthesis layer with a hover sheen and
          arrow reveal. */}
      <a
        href="/synthesis-layer"
        onClick={goInternal("/synthesis-layer")}
        title={
          approvalsTotal > 0
            ? `${approvalsTotal} pending in the synthesis layer`
            : "Open the synthesis layer"
        }
        className="group/foot relative border-t border-white/40 dark:border-white/10 bg-white/30 dark:bg-white/[0.02] hover:bg-white/55 dark:hover:bg-white/[0.05] px-5 py-3 flex items-center justify-between transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
      >
        <div className="flex items-center gap-2 text-[11px] text-black/70 dark:text-white/70 group-hover/foot:text-black/95 dark:group-hover/foot:text-white/95 transition-colors">
          <span className="relative flex h-2 w-2">
            {approvalsTotal > 0 ? (
              <>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fuchsia-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-fuchsia-500 group-hover/foot:scale-125 transition-transform" />
              </>
            ) : (
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500 group-hover/foot:scale-125 transition-transform" />
            )}
          </span>
          <span className="font-medium">
            {approvalsTotal > 0
              ? `${approvalsTotal} pending`
              : "Synthesis layer is steady"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] tabular-nums text-black/45 dark:text-white/45 group-hover/foot:text-black/70 dark:group-hover/foot:text-white/70 transition-colors">
            {stats.projects} project{stats.projects === 1 ? "" : "s"} active
          </span>
          <ArrowUpRight className="w-3 h-3 text-black/30 dark:text-white/30 group-hover/foot:text-black/70 dark:group-hover/foot:text-white/70 opacity-0 group-hover/foot:opacity-100 -translate-x-1 group-hover/foot:translate-x-0 transition-all" />
        </div>
      </a>
    </motion.aside>
  );
};

interface StatCellProps {
  icon: React.ReactNode;
  primary: number;
  label: string;
  footnote?: string;
  tint: "emerald" | "violet" | "blue" | "amber";
  href: string;
  onInternalClick: (e: React.MouseEvent) => void;
}

const StatCell: React.FC<StatCellProps> = ({
  icon,
  primary,
  label,
  footnote,
  tint,
  href,
  onInternalClick,
}) => {
  const tintCls =
    tint === "emerald"
      ? "from-emerald-400/20 to-emerald-400/[0.04] text-emerald-600 dark:text-emerald-300 ring-emerald-400/25 group-hover/cell:from-emerald-400/35 group-hover/cell:to-emerald-400/[0.08]"
      : tint === "violet"
        ? "from-fuchsia-400/20 to-fuchsia-400/[0.04] text-fuchsia-600 dark:text-fuchsia-300 ring-fuchsia-400/25 group-hover/cell:from-fuchsia-400/35 group-hover/cell:to-fuchsia-400/[0.08]"
        : tint === "blue"
          ? "from-blue-400/20 to-blue-400/[0.04] text-blue-600 dark:text-blue-300 ring-blue-400/25 group-hover/cell:from-blue-400/35 group-hover/cell:to-blue-400/[0.08]"
          : "from-amber-400/20 to-amber-400/[0.04] text-amber-600 dark:text-amber-300 ring-amber-400/25 group-hover/cell:from-amber-400/35 group-hover/cell:to-amber-400/[0.08]";

  return (
    <motion.a
      href={href}
      onClick={onInternalClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="group/cell relative block rounded-xl border border-white/50 dark:border-white/10 bg-white/55 dark:bg-white/[0.04] backdrop-blur-sm px-3 py-2.5 transition-all duration-200 hover:border-black/15 dark:hover:border-white/20 hover:bg-white/80 dark:hover:bg-white/[0.08] hover:shadow-[0_6px_20px_rgba(15,23,42,0.10)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
    >
      <div className="flex items-start justify-between">
        <div
          className={`inline-flex items-center justify-center w-6 h-6 rounded-md bg-gradient-to-br ${tintCls} ring-1 transition-all duration-200 group-hover/cell:scale-110`}
        >
          {icon}
        </div>
        <ArrowUpRight className="w-3 h-3 text-black/30 dark:text-white/30 opacity-0 group-hover/cell:opacity-100 -translate-x-1 -translate-y-0.5 group-hover/cell:translate-x-0 group-hover/cell:translate-y-0 transition-all" />
      </div>
      <div className="mt-1.5 text-2xl font-bold leading-none tabular-nums tracking-tight text-black/90 dark:text-white/90">
        {primary}
      </div>
      <div className="mt-0.5 text-[10.5px] font-medium uppercase tracking-wider text-black/55 dark:text-white/55 group-hover/cell:text-black/75 dark:group-hover/cell:text-white/75 transition-colors">
        {label}
      </div>
      {footnote ? (
        <div className="mt-0.5 text-[10.5px] text-black/45 dark:text-white/45 group-hover/cell:text-black/65 dark:group-hover/cell:text-white/65 transition-colors">
          {footnote}
        </div>
      ) : null}
    </motion.a>
  );
};

export default LoadInBriefingPanel;
