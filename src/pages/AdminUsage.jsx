// Admin AI Usage Dashboard — only visible to ADMIN_EMAILS (default admin@lykn.io).
// Pure client-side rendering on top of /api/admin/usage/* routes which are
// gated server-side by requireAdmin.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { ArrowLeft, RefreshCw, Activity, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AI_SURFACES, TIER_META, attachLiveSpend, findSilentSurfaces } from "@/lib/admin/aiCallCatalog";
import {
  COST_OPTIMIZATIONS,
  TIER_LABELS,
  CATEGORY_META,
  groupOptimizationsByTier,
  formatSavingsBadge,
  summarizeOptimizations,
} from "@/lib/admin/costOptimizationsLog";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "mtd", label: "This month" },
  { id: "ytd", label: "This year" },
  { id: "all", label: "All time" },
];

const CHART_COLORS = [
  "#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#84cc16", "#14b8a6", "#f97316",
  "#3b82f6", "#a855f7",
];

function fmtMoney(v) {
  const n = Number(v) || 0;
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function fmtNum(v) {
  const n = Number(v) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTokens(v) {
  const n = Number(v) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtDateShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

async function adminFetch(path) {
  const res = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function Card({ className, children }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/15 dark:border-white/10 bg-white/40 dark:bg-white/5 backdrop-blur-md p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function RangeSelector({ value, onChange }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl border border-white/15 bg-white/30 dark:bg-white/5 p-1">
      {RANGES.map((r) => (
        <button
          key={r.id}
          onClick={() => onChange(r.id)}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg transition",
            value === r.id
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:bg-white/40 dark:hover:bg-white/10",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function fmtClockShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

const LIVE_WINDOWS = [
  { id: 15, label: "15m" },
  { id: 60, label: "1h" },
  { id: 180, label: "3h" },
  { id: 360, label: "6h" },
];

// ─── Diagnostics banner ─────────────────────────────────────────────────────
// Polls /api/admin/usage/diagnostics. Stays out of the way when everything is
// fine; loudly shows what to do when it's not (missing migration, missing
// service role key, or zero rows in the table).

function DiagnosticsBanner() {
  const [expanded, setExpanded] = useState(false);

  const diagQ = useQuery({
    queryKey: ["admin-usage-diagnostics"],
    queryFn: () => adminFetch(`/api/admin/usage/diagnostics`),
    refetchInterval: 60_000,
    retry: false,
  });

  if (diagQ.isLoading) return null;

  const d = diagQ.data || {};
  const rpcs = d.rpcs || {};
  const missingRpcs = Object.entries(rpcs)
    .filter(([, v]) => v && v.ok === false && v.reason === "missing")
    .map(([k]) => k);
  const otherFailingRpcs = Object.entries(rpcs)
    .filter(([, v]) => v && v.ok === false && v.reason !== "missing" && v.reason !== "untested")
    .map(([k, v]) => ({ name: k, ...v }));

  const errors = [];
  if (diagQ.error) {
    errors.push({
      title: "Diagnostics endpoint failed",
      detail: String(diagQ.error.message || diagQ.error),
      hint: "The server may be running an older build — restart the Node process so it picks up the new /api/admin/usage/diagnostics route.",
    });
  }
  if (d && d.service_role_configured === false) {
    errors.push({
      title: "SUPABASE_SERVICE_ROLE_KEY is not set on the server",
      detail: "Without the service role key, the server cannot read or write usage logs across users. Nothing will ever be logged or shown here.",
      hint: "Set SUPABASE_SERVICE_ROLE_KEY in your .env file (and VITE_SUPABASE_URL), then restart the server.",
    });
  }
  if (d && d.service_role_configured && d.table_reachable === false) {
    errors.push({
      title: "Cannot reach the ai_usage_logs table",
      detail: d.table_error || "The service-role REST request failed.",
      hint: "Confirm SUPABASE_SERVICE_ROLE_KEY belongs to the same project as VITE_SUPABASE_URL, and that the ai_usage_logs table exists.",
    });
  }
  if (missingRpcs.length) {
    errors.push({
      title: `Missing database functions: ${missingRpcs.join(", ")}`,
      detail: "These are SECURITY DEFINER functions defined in supabase-migrations/040_admin_usage_rpcs.sql and 042_admin_usage_live.sql. Until you apply those migrations, the dashboard has nothing to read.",
      hint: "Open Supabase → SQL editor and run 040_admin_usage_rpcs.sql first, then 042_admin_usage_live.sql. Or apply via the Supabase CLI.",
    });
  }
  if (otherFailingRpcs.length) {
    errors.push({
      title: "Database functions returned errors",
      detail: otherFailingRpcs.map((r) => `${r.name}: ${r.message || r.reason} (${r.status || ""})`).join(" · "),
      hint: "Check Supabase logs for the function. Common cause: schema drift after running migrations out of order.",
    });
  }
  if (
    d &&
    d.service_role_configured &&
    d.table_reachable &&
    d.total_rows === 0
  ) {
    errors.push({
      title: "ai_usage_logs is empty",
      detail: "The dashboard reads from ai_usage_logs, and that table has zero rows. This usually means the server can read the table but has never successfully written to it — most often because of a missing service-role key or a NOT NULL constraint blocking inserts.",
      hint: "Make sure SUPABASE_SERVICE_ROLE_KEY is the service_role key (not anon), and that migration 040 has run (it drops NOT NULL on user_id so guest rows can insert).",
    });
  }
  if (
    d &&
    d.service_role_configured &&
    d.table_reachable &&
    typeof d.total_rows === "number" &&
    d.total_rows > 0 &&
    d.rows_today === 0 &&
    !missingRpcs.length
  ) {
    errors.push({
      title: "No rows logged today",
      detail: `Total rows in DB: ${d.total_rows}. Rows in last hour: ${d.rows_last_hour ?? "?"}. Latest row: ${d.latest_row?.created_at ? new Date(d.latest_row.created_at).toLocaleString() : "—"}.`,
      hint: "If you have active users right now, restart the Node server so the new logAiUsage call sites in stream-guest, embeddings, transcription and YouTube are loaded. The previous build was running the old code that didn't log them.",
    });
  }

  const ok = errors.length === 0;

  // Healthy + collapsed → tiny green pill, no noise.
  if (ok && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="inline-flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300 hover:underline"
        title="Show diagnostics"
      >
        <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        Tracking OK · {fmtNum(d.total_rows)} rows · {fmtNum(d.rows_today)} today
      </button>
    );
  }

  return (
    <Card
      className={cn(
        ok
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/10",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-semibold">
            {ok ? "Tracking OK" : `Dashboard isn't seeing data — ${errors.length} issue${errors.length === 1 ? "" : "s"} detected`}
          </div>
          <div className="text-xs text-muted-foreground">
            Service role: <span className={d.service_role_configured ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>{d.service_role_configured ? "configured" : "missing"}</span>
            {" · "}
            ai_usage_logs: <span className="font-mono">{d.table_reachable ? "reachable" : "unreachable"}</span>
            {" · "}
            total rows: <span className="font-mono">{d.total_rows ?? "?"}</span>
            {" · "}
            today: <span className="font-mono">{d.rows_today ?? "?"}</span>
            {" · "}
            last hour: <span className="font-mono">{d.rows_last_hour ?? "?"}</span>
            {d.latest_row?.created_at && (
              <> {" · "}latest: <span className="font-mono">{fmtRelative(d.latest_row.created_at)}</span></>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => diagQ.refetch()}
            title="Re-run diagnostics"
          >
            <RefreshCw className="size-3.5 mr-1" /> Recheck
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide" : "Details"}
          </Button>
        </div>
      </div>

      {(expanded || !ok) && errors.length > 0 && (
        <ul className="mt-3 space-y-2">
          {errors.map((e, i) => (
            <li key={i} className="rounded-lg border border-amber-500/30 bg-white/40 dark:bg-white/5 p-3">
              <div className="text-sm font-medium">{e.title}</div>
              {e.detail && <div className="text-xs text-muted-foreground mt-0.5">{e.detail}</div>}
              {e.hint && (
                <div className="text-xs mt-1">
                  <span className="font-medium">Fix: </span>{e.hint}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {expanded && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Raw response</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-black/30 p-2 text-[11px] leading-snug">
            {JSON.stringify(d, null, 2)}
          </pre>
        </details>
      )}
    </Card>
  );
}

// ─── Live section (last N minutes, polls every 5s) ──────────────────────────

function LiveSection() {
  const [minutes, setMinutes] = useState(60);
  const seenIdsRef = useRef(new Set());
  const [newIds, setNewIds] = useState(new Set());

  const liveQ = useQuery({
    queryKey: ["admin-usage-live", minutes],
    queryFn: () => adminFetch(`/api/admin/usage/live?minutes=${minutes}`),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  });

  const data = liveQ.data || {};
  const totals = data.totals || {};
  const perMinute = Array.isArray(data.per_minute) ? data.per_minute : [];
  const byAction = Array.isArray(data.by_action) ? data.by_action : [];
  const topUsers = Array.isArray(data.top_users) ? data.top_users : [];
  const recent = Array.isArray(data.recent) ? data.recent : [];

  // Highlight rows that arrived since last poll. seenIdsRef stores ids we've
  // already shown so a re-render only flags genuinely new ones; the highlight
  // is removed after 6 seconds.
  useEffect(() => {
    if (!recent.length) return;
    const fresh = new Set();
    for (const r of recent) {
      if (r?.id && !seenIdsRef.current.has(r.id)) {
        seenIdsRef.current.add(r.id);
        fresh.add(r.id);
      }
    }
    if (!fresh.size) return;
    setNewIds((prev) => {
      const merged = new Set(prev);
      fresh.forEach((id) => merged.add(id));
      return merged;
    });
    const timer = setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev);
        fresh.forEach((id) => next.delete(id));
        return next;
      });
    }, 6000);
    return () => clearTimeout(timer);
  }, [recent]);

  // Reset seen-set when window changes so all rows in the new window animate
  // in once.
  useEffect(() => {
    seenIdsRef.current = new Set();
    setNewIds(new Set());
  }, [minutes]);

  const isFetching = liveQ.isFetching && !liveQ.isLoading;

  const labelForWindow = LIVE_WINDOWS.find((w) => w.id === minutes)?.label || `${minutes}m`;

  const sparkline = useMemo(() => {
    return perMinute.map((p) => ({
      ...p,
      cost_usd: Number(p.cost_usd) || 0,
      calls: Number(p.calls) || 0,
    }));
  }, [perMinute]);

  return (
    <Card className="relative overflow-hidden border-emerald-500/25 bg-emerald-500/5">
      {/* Heading row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <span className="relative inline-flex">
            <span className="absolute inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 opacity-75 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <Activity className="size-4 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-sm font-semibold tracking-wide uppercase text-emerald-700 dark:text-emerald-300">
            Live · last {labelForWindow}
          </h3>
          {isFetching && (
            <span className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">refreshing…</span>
          )}
        </div>
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-emerald-500/25 bg-white/30 dark:bg-white/5 p-1">
          {LIVE_WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => setMinutes(w.id)}
              className={cn(
                "px-3 py-1 text-xs rounded-lg transition",
                minutes === w.id
                  ? "bg-emerald-500/85 text-white"
                  : "text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <LiveKpi label="Spend" value={fmtMoney(totals.total_cost_usd)} sub={`since ${fmtClockShort(data.since)}`} />
        <LiveKpi label="Requests" value={fmtNum(totals.request_count)} sub={`${fmtTokens(totals.total_tokens)} tokens`} />
        <LiveKpi label="Active users" value={fmtNum(totals.active_users)} sub={`${fmtNum(totals.guest_requests)} guest reqs`} />
        <LiveKpi
          label="Hottest action"
          value={byAction[0]?.action_type || "—"}
          sub={byAction[0] ? `${fmtMoney(byAction[0].cost_usd)} · ${fmtNum(byAction[0].calls)}× ` : "no activity"}
        />
      </div>

      {/* Per-minute area chart */}
      <div className="mt-4">
        {sparkline.length === 0 ? (
          <EmptyChart label="No activity yet — calls will appear here in real time" />
        ) : (
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={sparkline} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="liveCost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeOpacity={0.1} vertical={false} />
              <XAxis
                dataKey="minute"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => fmtClockShort(v)}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => (v >= 0.01 ? `$${Number(v).toFixed(2)}` : "")}
                width={42}
              />
              <Tooltip
                contentStyle={{ borderRadius: 12, fontSize: 12 }}
                labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                formatter={(value, key) => {
                  if (key === "cost_usd") return [fmtMoney(value), "Cost"];
                  if (key === "calls") return [fmtNum(value), "Calls"];
                  return [value, key];
                }}
              />
              <Area type="monotone" dataKey="cost_usd" stroke="#10b981" strokeWidth={2} fill="url(#liveCost)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Two-column: top users + live feed */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
            Top users · last {labelForWindow}
          </h4>
          {topUsers.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-emerald-500/20 rounded-xl">
              No signed-in user activity yet
            </div>
          ) : (
            <ul className="space-y-1">
              {topUsers.map((u) => (
                <li key={u.user_id}>
                  <Link
                    to={`/admin/usage/${u.user_id}`}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-white/40 dark:hover:bg-white/5 transition"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{u.email}</div>
                      <div className="text-[10px] text-muted-foreground tabular-nums">
                        {fmtNum(u.calls)} calls · {fmtTokens(u.tokens)} tok · {fmtRelative(u.last_request)}
                      </div>
                    </div>
                    <div className="text-sm font-medium tabular-nums">{fmtMoney(u.cost_usd)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:col-span-3">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
            Live feed
            <span className="text-[10px] font-normal text-muted-foreground/70 normal-case tracking-normal">
              polling every 5s
            </span>
          </h4>
          {recent.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-emerald-500/20 rounded-xl">
              No activity in the last {labelForWindow} yet
            </div>
          ) : (
            <ul className="space-y-1 max-h-[320px] overflow-y-auto pr-1">
              {recent.map((r) => {
                const isNew = newIds.has(r.id);
                return (
                  <li
                    key={r.id}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border",
                      isNew
                        ? "border-emerald-500/40 bg-emerald-500/15 animate-pulse-once"
                        : "border-transparent hover:bg-white/30 dark:hover:bg-white/5",
                    )}
                    style={isNew ? { animation: "lyknLiveFlash 2.4s ease-out 1" } : undefined}
                  >
                    <span className="text-[10px] text-muted-foreground tabular-nums w-12 shrink-0">
                      {fmtClockShort(r.created_at)}
                    </span>
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-white/40 dark:bg-white/10 border border-white/15 text-[10px] shrink-0">
                      {r.action_type}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground truncate w-32 shrink-0">
                      {r.model}
                    </span>
                    <span className="flex-1 truncate">
                      {r.user_id ? (
                        <Link to={`/admin/usage/${r.user_id}`} className="hover:underline">
                          {r.email}
                        </Link>
                      ) : (
                        <span className="italic text-muted-foreground">{r.email}</span>
                      )}
                    </span>
                    <span className="tabular-nums text-[11px] text-muted-foreground shrink-0">
                      {fmtTokens(r.total_tokens)}
                    </span>
                    <span className="tabular-nums font-medium shrink-0 w-20 text-right">
                      {fmtMoney(r.cost_usd)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Inline keyframes — scoped via unique animation name so we don't need
          to touch global CSS just for this. */}
      <style>{`
        @keyframes lyknLiveFlash {
          0%   { background-color: rgba(16, 185, 129, 0.30); border-color: rgba(16, 185, 129, 0.55); }
          100% { background-color: rgba(16, 185, 129, 0.00); border-color: rgba(16, 185, 129, 0.00); }
        }
      `}</style>
    </Card>
  );
}

function LiveKpi({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-emerald-500/20 bg-white/30 dark:bg-white/5 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-emerald-700/80 dark:text-emerald-300/80">{label}</div>
      <div className="mt-0.5 text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ─── AI Surfaces (call catalog) ─────────────────────────────────────────────
// Cross-references the static AI_SURFACES catalog against live by_action
// data. Sorts by live spend so the most expensive thing in your app is the
// first row. Click a row to expand optimization notes.

const TIERS = [
  { id: "all", label: "All" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
];

function TierBadge({ tier }) {
  const meta = TIER_META[tier] || TIER_META.variable;
  return (
    <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider", meta.badgeClass)}>
      {meta.label}
    </span>
  );
}

function SurfaceRow({ surface, totalCost, isExpanded, onToggle }) {
  const sharedCount = surface.sharedActionTypes?.length || 0;
  const pct = totalCost > 0 ? (surface.liveCost / totalCost) * 100 : 0;
  const hasRisks = Array.isArray(surface.risks) && surface.risks.length > 0;
  const isSilent = surface.metered && surface.liveRequests === 0;

  return (
    <div className="rounded-lg border border-white/10 bg-white/30 dark:bg-white/5">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-3 hover:bg-white/40 dark:hover:bg-white/[0.07] transition rounded-lg"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-muted-foreground">
            {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">{surface.name}</span>
              <TierBadge tier={surface.tier} />
              {surface.guestAccessible && (
                <span className="inline-flex items-center rounded-md bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                  Guest
                </span>
              )}
              {isSilent && (
                <span
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                  title="No rows in this range. Either nothing's hit this surface yet, or logging is broken."
                >
                  <AlertTriangle className="size-3" /> Silent
                </span>
              )}
              {sharedCount > 0 && (
                <span
                  className="inline-flex items-center rounded-md bg-slate-500/15 text-slate-700 dark:text-slate-300 border border-slate-500/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                  title={`Shares action_type(s) with another surface: ${surface.sharedActionTypes.join(", ")}. Live cost is shown for each surface independently and may overcount.`}
                >
                  Shared
                </span>
              )}
              {hasRisks && (
                <span
                  className="inline-flex items-center gap-1 rounded-md bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                  title="Has known double-spend or waste risks — see details."
                >
                  <AlertTriangle className="size-3" /> Risk
                </span>
              )}
            </div>
            <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{surface.description}</div>
            <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
              <code className="font-mono px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10">{surface.endpoint}</code>
              <span>·</span>
              <span className="font-mono">{surface.file}{surface.lineRange ? ` ${surface.lineRange}` : ""}</span>
            </div>
          </div>

          <div className="text-right shrink-0 min-w-[120px]">
            <div className="text-sm font-semibold tabular-nums">{fmtMoney(surface.liveCost)}</div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {fmtNum(surface.liveRequests)} calls · {pct.toFixed(1)}%
            </div>
            <div className="text-[10px] text-muted-foreground tabular-nums">
              {fmtTokens(surface.liveTokens)} tok
            </div>
          </div>
        </div>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-white/10">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Providers</div>
              <div className="text-xs">{surface.providers.join(" · ")}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Models</div>
              <div className="text-xs font-mono">{surface.models.join(", ")}</div>
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">action_type buckets</div>
            <div className="flex flex-wrap gap-1">
              {surface.actionTypes.map((a) => (
                <code
                  key={a}
                  className={cn(
                    "text-[11px] px-1.5 py-0.5 rounded font-mono",
                    surface.sharedActionTypes?.includes(a)
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "bg-black/10 dark:bg-white/10",
                  )}
                >
                  {a}
                </code>
              ))}
            </div>
          </div>

          {surface.optimization && (
            <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300 mb-0.5">
                Optimization candidates
              </div>
              <div className="text-xs">{surface.optimization}</div>
            </div>
          )}

          {hasRisks && (
            <div className="rounded-md border border-red-500/25 bg-red-500/5 p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-red-700 dark:text-red-300 mb-1 inline-flex items-center gap-1">
                <AlertTriangle className="size-3" /> Risks
              </div>
              <ul className="text-xs space-y-1 list-disc pl-4">
                {surface.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AISurfacesSection({ byAction }) {
  const [tierFilter, setTierFilter] = useState("all");
  const [hideSilent, setHideSilent] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());

  const enriched = useMemo(() => attachLiveSpend(AI_SURFACES, byAction || []), [byAction]);
  const totalCost = useMemo(() => enriched.reduce((s, x) => s + (x.liveCost || 0), 0), [enriched]);

  const visible = useMemo(() => {
    let out = enriched;
    if (tierFilter !== "all") out = out.filter((s) => s.tier === tierFilter);
    if (hideSilent) out = out.filter((s) => s.liveRequests > 0);
    return [...out].sort((a, b) => (b.liveCost || 0) - (a.liveCost || 0));
  }, [enriched, tierFilter, hideSilent]);

  const silentSurfaces = useMemo(() => findSilentSurfaces(enriched), [enriched]);

  // Top-3 cost drivers — shown as a quick "where to optimize first" callout.
  const topThree = useMemo(
    () => [...enriched].filter((s) => s.liveCost > 0).sort((a, b) => b.liveCost - a.liveCost).slice(0, 3),
    [enriched],
  );

  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-medium">AI surfaces — every call site, ranked by live spend</h3>
          <p className="text-xs text-muted-foreground">
            {AI_SURFACES.length} known surfaces · {fmtMoney(totalCost)} attributed cost in range · click any row for optimization notes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap gap-1 rounded-xl border border-white/15 bg-white/30 dark:bg-white/5 p-1">
            {TIERS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTierFilter(t.id)}
                className={cn(
                  "px-2.5 py-1 text-[11px] rounded-lg transition",
                  tierFilter === t.id
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-white/40 dark:hover:bg-white/10",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-foreground"
              checked={hideSilent}
              onChange={(e) => setHideSilent(e.target.checked)}
            />
            Hide silent
          </label>
        </div>
      </div>

      {topThree.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
          <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300 mb-1.5">
            Where the money is going
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {topThree.map((s, i) => (
              <div key={s.id} className="rounded-md border border-amber-500/20 bg-white/30 dark:bg-white/5 p-2">
                <div className="text-[10px] text-muted-foreground">#{i + 1}</div>
                <div className="text-sm font-medium truncate" title={s.name}>{s.name}</div>
                <div className="text-xs tabular-nums">
                  {fmtMoney(s.liveCost)} <span className="text-muted-foreground">· {fmtNum(s.liveRequests)} calls</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyChart label="No surfaces match the current filter" />
      ) : (
        <div className="space-y-2">
          {visible.map((s) => (
            <SurfaceRow
              key={s.id}
              surface={s}
              totalCost={totalCost}
              isExpanded={expanded.has(s.id)}
              onToggle={() => toggle(s.id)}
            />
          ))}
        </div>
      )}

      {silentSurfaces.length > 0 && hideSilent && (
        <div className="mt-3 text-[11px] text-muted-foreground">
          {silentSurfaces.length} silent surface{silentSurfaces.length === 1 ? "" : "s"} hidden (no calls in range).{" "}
          <button
            type="button"
            onClick={() => setHideSilent(false)}
            className="underline hover:no-underline"
          >
            Show all
          </button>
        </div>
      )}
    </Card>
  );
}

// ─── Cost optimizations log ─────────────────────────────────────────────────
// "Where we are saving" — appended at the bottom of the dashboard. Renders
// the entries from src/lib/admin/costOptimizationsLog.js grouped by tier so
// you can see at a glance what's been shipped, what category it belongs to
// (caching, model swap, debounce, etc.), and the projected savings range.

const CATEGORY_BADGE_CLASS = {
  emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  indigo:  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30",
  amber:   "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  cyan:    "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30",
  purple:  "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  red:     "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  slate:   "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30",
};

function OptCard({ opt, surfaceLookup }) {
  const [expanded, setExpanded] = useState(false);
  const catMeta = CATEGORY_META[opt.category] || CATEGORY_META.infra;
  const badgeClass = CATEGORY_BADGE_CLASS[catMeta.color] || CATEGORY_BADGE_CLASS.slate;
  const savings = formatSavingsBadge(opt.expectedSavings);

  return (
    <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/[0.04] hover:bg-emerald-500/[0.07] transition">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-3"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-muted-foreground">
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">{opt.title}</span>
              <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider", badgeClass)}>
                {catMeta.label}
              </span>
              {opt.provider && (
                <span className="inline-flex items-center rounded-md bg-white/40 dark:bg-white/10 border border-white/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {opt.provider}
                </span>
              )}
            </div>
            <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{opt.description}</div>
            <div className="mt-1.5 text-[10px] text-muted-foreground">
              shipped {opt.shippedAt} · {opt.files.join(", ")}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="inline-flex items-center rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-semibold tabular-nums">
              {savings}
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-0 space-y-2 border-t border-emerald-500/15">
          <div className="text-xs pt-2">{opt.description}</div>

          {opt.expectedSavings?.scope && (
            <div className="rounded-md border border-emerald-500/20 bg-white/30 dark:bg-white/5 p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300 mb-0.5">
                Savings scope
              </div>
              <div className="text-xs">
                {savings} on {opt.expectedSavings.scope}
                {opt.expectedSavings.note && (
                  <div className="mt-1 text-[11px] text-muted-foreground">{opt.expectedSavings.note}</div>
                )}
              </div>
            </div>
          )}

          {Array.isArray(opt.surfaces) && opt.surfaces.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                AI surfaces affected
              </div>
              <div className="flex flex-wrap gap-1.5">
                {opt.surfaces.map((sid) => {
                  const surface = surfaceLookup.get(sid);
                  return (
                    <span
                      key={sid}
                      className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/40 dark:bg-white/5 px-2 py-0.5 text-[11px]"
                      title={surface?.endpoint || sid}
                    >
                      {surface?.name || sid}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {opt.risk && (
            <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-xs">
              <span className="font-medium">Risk: </span>
              {opt.risk}
            </div>
          )}

          {Array.isArray(opt.files) && opt.files.length > 0 && (
            <div className="text-[11px] text-muted-foreground font-mono">
              files: {opt.files.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CostOptimizationsSection() {
  const summary = useMemo(() => summarizeOptimizations(COST_OPTIMIZATIONS), []);
  const grouped = useMemo(() => groupOptimizationsByTier(COST_OPTIMIZATIONS), []);
  const surfaceLookup = useMemo(() => {
    const m = new Map();
    for (const s of AI_SURFACES) m.set(s.id, s);
    return m;
  }, []);

  if (!COST_OPTIMIZATIONS.length) return null;

  return (
    <Card className="border-emerald-500/25 bg-emerald-500/[0.03]">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-4">
        <div>
          <h3 className="text-sm font-medium">Cost optimizations shipped</h3>
          <p className="text-xs text-muted-foreground">
            {summary.total} change{summary.total === 1 ? "" : "s"} shipped · last update {summary.latest || "—"}.
            Click any row for details.
          </p>
        </div>
        <div className="inline-flex flex-wrap gap-1.5 items-center">
          {Object.entries(summary.byTier).map(([tier, count]) => (
            <span
              key={tier}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[11px] font-medium"
            >
              T{tier} · {count}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-5">
        {grouped.map(([tier, list]) => (
          <div key={tier}>
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {TIER_LABELS[tier] || `Tier ${tier}`}
              </h4>
              <span className="text-[11px] text-muted-foreground">
                ({list.length})
              </span>
            </div>
            <div className="space-y-2">
              {list.map((opt) => (
                <OptCard key={opt.id} opt={opt} surfaceLookup={surfaceLookup} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 text-[11px] text-muted-foreground border-t border-emerald-500/15 pt-2">
        Add new entries by editing
        {" "}<code className="font-mono">src/lib/admin/costOptimizationsLog.js</code>{" "}
        — they appear here automatically.
      </div>
    </Card>
  );
}

// ─── Overview view ──────────────────────────────────────────────────────────

function OverviewView({ range, setRange }) {
  const navigate = useNavigate();

  const overviewQ = useQuery({
    queryKey: ["admin-usage-overview", range],
    queryFn: () => adminFetch(`/api/admin/usage/overview?range=${encodeURIComponent(range)}`),
    refetchInterval: 30_000,
  });

  const usersQ = useQuery({
    queryKey: ["admin-usage-users", range],
    queryFn: () => adminFetch(`/api/admin/usage/users?range=${encodeURIComponent(range)}`),
    refetchInterval: 30_000,
  });

  const recentQ = useQuery({
    queryKey: ["admin-usage-recent"],
    queryFn: () => adminFetch(`/api/admin/usage/recent?limit=50`),
    refetchInterval: 15_000,
  });

  const data = overviewQ.data || {};
  const totals = data.totals || {};
  const today = data.today || {};
  const allTime = data.all_time || {};
  const byAction = data.by_action || [];
  const byProvider = data.by_provider || [];
  const byModel = data.by_model || [];
  const daily = data.daily || [];

  const users = usersQ.data?.users || [];
  const recent = recentQ.data?.rows || [];

  const errorAny = overviewQ.error || usersQ.error || recentQ.error;
  const isAdminError = String(errorAny?.message || "").toLowerCase().includes("admin only");

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Usage</h1>
          <p className="text-sm text-muted-foreground">
            Cross-user spend, by action type and model. Auto-refreshes every 30 seconds.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <RangeSelector value={range} onChange={setRange} />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              overviewQ.refetch();
              usersQ.refetch();
              recentQ.refetch();
            }}
            title="Refresh"
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {isAdminError && (
        <Card className="border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300">
          You are signed in but this account is not on the admin allowlist.
        </Card>
      )}

      <DiagnosticsBanner />

      {!isAdminError && errorAny && (
        <Card className="border-red-500/30 bg-red-500/10">
          <div className="text-sm font-semibold text-red-700 dark:text-red-300">
            One of the dashboard queries failed
          </div>
          <div className="text-xs mt-1 break-all">
            {String(errorAny.message || errorAny)}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            See the diagnostics panel above for the most likely fix.
          </div>
        </Card>
      )}

      {/* Live (last hour) — pinned at the top so you can see what's happening
          right now without scrolling. Self-contained: own polling + own range. */}
      <LiveSection />

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi
          label="Spend (today)"
          value={fmtMoney(today.total_cost_usd)}
          sub={`${fmtNum(today.request_count)} requests · ${fmtNum(today.active_users)} users`}
        />
        <Kpi
          label={`Spend (${RANGES.find((r) => r.id === range)?.label || range})`}
          value={fmtMoney(totals.total_cost_usd)}
          sub={`${fmtNum(totals.request_count)} reqs · ${fmtTokens(totals.total_tokens)} tok`}
        />
        <Kpi
          label="Active users"
          value={fmtNum(totals.active_users)}
          sub={`${fmtNum(totals.guest_requests)} guest reqs in range`}
        />
        <Kpi label="All-time spend" value={fmtMoney(allTime.total_cost_usd)} sub={`${fmtNum(allTime.request_count)} requests ever`} />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-medium">Spend by action type</h3>
              <p className="text-xs text-muted-foreground">What the AI was actually doing.</p>
            </div>
          </div>
          {byAction.length === 0 ? (
            <EmptyChart label="No usage in this range yet" />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={byAction} margin={{ left: 0, right: 8, top: 4, bottom: 8 }}>
                <CartesianGrid strokeOpacity={0.12} vertical={false} />
                <XAxis dataKey="action_type" tick={{ fontSize: 11 }} interval={0} angle={-22} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, fontSize: 12 }}
                  formatter={(value, key) => {
                    if (key === "cost_usd") return [fmtMoney(value), "Cost"];
                    if (key === "calls") return [fmtNum(value), "Calls"];
                    return [value, key];
                  }}
                />
                <Bar dataKey="cost_usd" fill="#6366f1" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <div className="mb-3">
            <h3 className="text-sm font-medium">Spend by provider</h3>
            <p className="text-xs text-muted-foreground">OpenAI · Anthropic · Google · xAI</p>
          </div>
          {byProvider.length === 0 ? (
            <EmptyChart label="No provider data" />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={byProvider}
                  dataKey="cost_usd"
                  nameKey="provider"
                  innerRadius={45}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {byProvider.map((_, idx) => (
                    <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* Daily trend */}
      <Card>
        <div className="mb-3">
          <h3 className="text-sm font-medium">Daily spend</h3>
          <p className="text-xs text-muted-foreground">Cost per day in the selected range.</p>
        </div>
        {daily.length === 0 ? (
          <EmptyChart label="No daily data" />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={daily} margin={{ left: 0, right: 16, top: 4, bottom: 8 }}>
              <CartesianGrid strokeOpacity={0.12} vertical={false} />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => fmtDateShort(v)}
              />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Number(v).toFixed(2)}`} />
              <Tooltip
                contentStyle={{ borderRadius: 12, fontSize: 12 }}
                labelFormatter={(v) => new Date(v).toLocaleDateString()}
                formatter={(value, key) => {
                  if (key === "cost_usd") return [fmtMoney(value), "Cost"];
                  if (key === "calls") return [fmtNum(value), "Calls"];
                  if (key === "active_users") return [fmtNum(value), "Active users"];
                  return [value, key];
                }}
              />
              <Line type="monotone" dataKey="cost_usd" stroke="#6366f1" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Users table */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium">Users</h3>
            <p className="text-xs text-muted-foreground">
              Click a row to drill into that user's spend.
            </p>
          </div>
          <div className="text-xs text-muted-foreground">{users.length} user(s) in range</div>
        </div>
        {usersQ.isLoading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
        ) : users.length === 0 ? (
          <EmptyChart label="No user activity in this range yet" />
        ) : (
          <UsersTable users={users} onClickUser={(u) => navigate(`/admin/usage/${u.user_id}?range=${range}`)} />
        )}
      </Card>

      {/* Top models */}
      {byModel.length > 0 && (
        <Card>
          <div className="mb-3">
            <h3 className="text-sm font-medium">Top models by spend</h3>
            <p className="text-xs text-muted-foreground">Up to 25 most expensive models in range.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left py-2 pr-4">Model</th>
                  <th className="text-left py-2 pr-4">Provider</th>
                  <th className="text-right py-2 pr-4">Calls</th>
                  <th className="text-right py-2 pr-4">Tokens</th>
                  <th className="text-right py-2 pr-0">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {byModel.map((m, i) => (
                  <tr key={`${m.model}-${m.provider}-${i}`} className="hover:bg-white/30 dark:hover:bg-white/5">
                    <td className="py-2 pr-4 font-mono text-xs">{m.model}</td>
                    <td className="py-2 pr-4">{m.provider}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtNum(m.calls)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtTokens(m.tokens)}</td>
                    <td className="py-2 pr-0 text-right tabular-nums font-medium">{fmtMoney(m.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Recent activity */}
      <Card>
        <div className="mb-3">
          <h3 className="text-sm font-medium">Recent activity</h3>
          <p className="text-xs text-muted-foreground">Last 50 AI calls. Refreshes every 15s.</p>
        </div>
        {recent.length === 0 ? (
          <EmptyChart label="No recent activity" />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left py-2 pr-4">When</th>
                  <th className="text-left py-2 pr-4">User</th>
                  <th className="text-left py-2 pr-4">Action</th>
                  <th className="text-left py-2 pr-4">Model</th>
                  <th className="text-right py-2 pr-4">Tokens</th>
                  <th className="text-right py-2 pr-0">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {recent.map((r) => (
                  <tr key={r.id} className="hover:bg-white/30 dark:hover:bg-white/5">
                    <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap">{fmtRelative(r.created_at)}</td>
                    <td className="py-2 pr-4">
                      {r.user_id ? (
                        <Link
                          to={`/admin/usage/${r.user_id}?range=${range}`}
                          className="text-xs hover:underline"
                        >
                          {r.email || "(unknown)"}
                        </Link>
                      ) : (
                        <span className="text-xs italic text-muted-foreground">(guest)</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-white/40 dark:bg-white/10 border border-white/15">
                        {r.action_type}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.model}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtTokens(r.total_tokens)}</td>
                    <td className="py-2 pr-0 text-right tabular-nums">{fmtMoney(r.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {errorAny && !isAdminError && (
        <Card className="border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 text-sm">
          Error loading dashboard: {String(errorAny.message || errorAny)}
        </Card>
      )}

      {/* Bottom row: side-by-side on wide screens (≥ xl), stacked otherwise.
            Left  = "where the AI is being used" (live spend per call site).
            Right = "where we're saving" (shipped optimizations log).
          The two are aligned to start so an entry's height in one doesn't
          drag the other taller. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <AISurfacesSection byAction={byAction} />
        <CostOptimizationsSection />
      </div>

    </div>
  );
}

function UsersTable({ users, onClickUser }) {
  const [sort, setSort] = useState({ key: "total_cost_usd", dir: "desc" });

  const sorted = useMemo(() => {
    const arr = users.slice();
    arr.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === "string" || typeof bv === "string") {
        const r = String(av || "").localeCompare(String(bv || ""));
        return sort.dir === "asc" ? r : -r;
      }
      const r = (Number(av) || 0) - (Number(bv) || 0);
      return sort.dir === "asc" ? r : -r;
    });
    return arr;
  }, [users, sort]);

  const click = (key) => {
    if (sort.key === key) setSort({ key, dir: sort.dir === "asc" ? "desc" : "asc" });
    else setSort({ key, dir: "desc" });
  };

  const head = (key, label, align = "left") => (
    <th
      className={cn(
        "py-2 pr-4 cursor-pointer select-none text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground",
        align === "right" && "text-right pr-0",
      )}
      onClick={() => click(key)}
    >
      {label}
      {sort.key === key && <span className="ml-1 text-[10px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            {head("email", "Email")}
            {head("request_count", "Requests", "right")}
            {head("total_tokens", "Tokens", "right")}
            {head("total_cost_usd", "Cost", "right")}
            {head("last_request", "Last seen", "right")}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {sorted.map((u) => (
            <tr
              key={u.user_id}
              onClick={() => onClickUser(u)}
              className="cursor-pointer hover:bg-white/30 dark:hover:bg-white/5"
            >
              <td className="py-2 pr-4">
                <div className="font-medium">{u.email}</div>
                <div className="text-[10px] font-mono text-muted-foreground">{String(u.user_id || "").slice(0, 8)}…</div>
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{fmtNum(u.request_count)}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{fmtTokens(u.total_tokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums font-medium">{fmtMoney(u.total_cost_usd)}</td>
              <td className="py-2 pr-0 text-right text-xs text-muted-foreground">{fmtRelative(u.last_request)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Drilldown view ─────────────────────────────────────────────────────────

function DrilldownView({ userId, range, setRange }) {
  const navigate = useNavigate();

  const drillQ = useQuery({
    queryKey: ["admin-usage-drilldown", userId, range],
    queryFn: () => adminFetch(`/api/admin/usage/users/${userId}?range=${encodeURIComponent(range)}`),
    refetchInterval: 30_000,
  });

  const data = drillQ.data || {};
  const user = data.user || {};
  const totals = data.totals || {};
  const byAction = data.by_action || [];
  const byModel = data.by_model || [];
  const byProvider = data.by_provider || [];
  const daily = data.daily || [];
  const recent = data.recent_logs || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(`/admin/usage?range=${range}`)} title="Back">
            <ArrowLeft className="size-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{user.email || "Loading…"}</h1>
            <p className="text-xs font-mono text-muted-foreground">{userId}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <RangeSelector value={range} onChange={setRange} />
          <Button variant="ghost" size="icon" onClick={() => drillQ.refetch()} title="Refresh">
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Spend in range" value={fmtMoney(totals.total_cost_usd)} sub={`${fmtNum(totals.request_count)} requests`} />
        <Kpi label="Tokens (in/out)" value={fmtTokens(totals.total_tokens)} sub={`${fmtTokens(totals.total_input_tokens)} in · ${fmtTokens(totals.total_output_tokens)} out`} />
        <Kpi label="Credits" value={fmtNum(totals.total_credits)} sub="Internal credit accounting" />
        <Kpi label="Last seen" value={fmtRelative(totals.last_request)} sub={totals.first_request ? `First: ${fmtRelative(totals.first_request)}` : ""} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <div className="mb-3">
            <h3 className="text-sm font-medium">Spend by action</h3>
            <p className="text-xs text-muted-foreground">What this user actually used the AI for.</p>
          </div>
          {byAction.length === 0 ? (
            <EmptyChart label="No usage in this range" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={byAction} margin={{ left: 0, right: 8, top: 4, bottom: 8 }}>
                <CartesianGrid strokeOpacity={0.12} vertical={false} />
                <XAxis dataKey="action_type" tick={{ fontSize: 11 }} interval={0} angle={-22} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} formatter={(v) => fmtMoney(v)} />
                <Bar dataKey="cost_usd" fill="#10b981" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card>
          <div className="mb-3">
            <h3 className="text-sm font-medium">Provider mix</h3>
          </div>
          {byProvider.length === 0 ? (
            <EmptyChart label="No data" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={byProvider} dataKey="cost_usd" nameKey="provider" innerRadius={45} outerRadius={80} paddingAngle={2}>
                  {byProvider.map((_, idx) => (
                    <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => fmtMoney(v)} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <Card>
        <div className="mb-3">
          <h3 className="text-sm font-medium">Daily spend</h3>
        </div>
        {daily.length === 0 ? (
          <EmptyChart label="No daily data" />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={daily} margin={{ left: 0, right: 16, top: 4, bottom: 8 }}>
              <CartesianGrid strokeOpacity={0.12} vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtDateShort(v)} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Number(v).toFixed(2)}`} />
              <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} labelFormatter={(v) => new Date(v).toLocaleDateString()} formatter={(v) => fmtMoney(v)} />
              <Line type="monotone" dataKey="cost_usd" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card>
        <div className="mb-3">
          <h3 className="text-sm font-medium">Models used</h3>
        </div>
        {byModel.length === 0 ? (
          <EmptyChart label="No model data" />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left py-2 pr-4">Model</th>
                  <th className="text-left py-2 pr-4">Provider</th>
                  <th className="text-right py-2 pr-4">Calls</th>
                  <th className="text-right py-2 pr-4">Tokens</th>
                  <th className="text-right py-2 pr-0">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {byModel.map((m, i) => (
                  <tr key={`${m.model}-${m.provider}-${i}`} className="hover:bg-white/30 dark:hover:bg-white/5">
                    <td className="py-2 pr-4 font-mono text-xs">{m.model}</td>
                    <td className="py-2 pr-4">{m.provider}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtNum(m.calls)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtTokens(m.tokens)}</td>
                    <td className="py-2 pr-0 text-right tabular-nums font-medium">{fmtMoney(m.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3">
          <h3 className="text-sm font-medium">Recent activity</h3>
          <p className="text-xs text-muted-foreground">Last 100 calls in this range.</p>
        </div>
        {recent.length === 0 ? (
          <EmptyChart label="No recent activity in range" />
        ) : (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground sticky top-0 bg-background/80 backdrop-blur">
                <tr>
                  <th className="text-left py-2 pr-4">When</th>
                  <th className="text-left py-2 pr-4">Action</th>
                  <th className="text-left py-2 pr-4">Model</th>
                  <th className="text-right py-2 pr-4">Tokens</th>
                  <th className="text-right py-2 pr-0">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {recent.map((r) => (
                  <tr key={r.id} className="hover:bg-white/30 dark:hover:bg-white/5">
                    <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap">{fmtRelative(r.created_at)}</td>
                    <td className="py-2 pr-4 text-xs">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-white/40 dark:bg-white/10 border border-white/15">
                        {r.action_type}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.model}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{fmtTokens(r.total_tokens)}</td>
                    <td className="py-2 pr-0 text-right tabular-nums">{fmtMoney(r.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function EmptyChart({ label }) {
  return (
    <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">
      {label}
    </div>
  );
}

// ─── Page entry ─────────────────────────────────────────────────────────────

export default function AdminUsage() {
  const { userId } = useParams();
  const [range, setRange] = useState(() => {
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      const r = sp.get("range");
      if (r && RANGES.find((x) => x.id === r)) return r;
    }
    return "30d";
  });

  return (
    <div className="mx-auto w-full max-w-[1400px] p-4 md:p-6">
      {userId ? (
        <DrilldownView userId={userId} range={range} setRange={setRange} />
      ) : (
        <OverviewView range={range} setRange={setRange} />
      )}
    </div>
  );
}
