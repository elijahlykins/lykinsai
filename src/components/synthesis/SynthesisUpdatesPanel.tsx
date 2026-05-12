import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bookmark,
  CheckCircle2,
  CircleDashed,
  FolderPlus,
  GitCommit,
  Loader2,
  RefreshCw,
  Scale,
  Sparkles,
  User,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { API_BASE_URL } from "@/lib/api-config";

/**
 * SynthesisUpdatesPanel — "What's new" right-side pullout.
 *
 * The user's window into what changed in their synthesis layer since their
 * last visit. Auto-opens once per session on first navigation to the
 * synthesis page; the user can close it and get straight to the graph.
 * Spec lives in project state under `ui_updates_experience` (revised by
 * claude-desktop after the bottom-right card stack iteration).
 *
 * Why a pullout instead of the prior bottom-right stack:
 *   • Backed-by-the-graph context — the 3D scene stays on screen behind
 *     the panel (no backdrop), keeping the metaphor of "your brain" alive.
 *   • Same edge as BeliefWindowPanel, so the user only ever has to learn
 *     one slide direction for synthesis-layer pullouts.
 *   • Scrollable list scales gracefully when there's a lot to catch up
 *     on — the stack capped at 6 cards even when there were 50 updates.
 *   • No dismiss timer — auto-dismiss-after-6s pressured the user to
 *     read fast; pullouts are the right shape for "absorb at your pace."
 *
 * Re-open behavior:
 *   • Every fresh mount of the synthesis page → opens automatically.
 *     This includes hard reloads, route navigations, and new tabs.
 *   • Closing it (X button) hides it for the rest of THIS mount only;
 *     the user gets it back the next time they navigate in or reload.
 *   • Why no sessionStorage gate: the user explicitly wants a greeting
 *     every time they enter the synthesis page, even when nothing has
 *     changed. Persisting "dismissed" across reloads contradicts that.
 *   • The `last_visited_at` localStorage anchor still controls which
 *     events count as "new" inside the panel body, so frequent reloads
 *     don't re-show the same updates as if they're fresh.
 *
 * No backdrop. Matches BeliefWindowPanel's z-[90] right-side aside so the
 * graph (z-0) stays visible and interactive while the panel is open.
 */

// Legacy flag from the prior "dismiss for the session" iteration. Cleared
// on mount so any user who hit that code path still gets the panel back.
const LEGACY_SESSION_KEY_DISMISSED = "lykn:synthesisUpdatesSeen";
// Legacy "since when is something new" anchor. We no longer gate the
// panel by it — the panel now shows recent activity broadly — but we
// clear it on mount so it doesn't linger in localStorage forever.
const LEGACY_STORAGE_KEY_LAST_VISIT = "lykn:synthesisLastVisitedAt";
const ACTIVITY_LIMIT = 100;

// --------------------------------------------------------------------------
// Source data shape — mirrors /api/v1/synthesis/activity
// --------------------------------------------------------------------------

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
  when: string;
  by_client: string | null;
  summary: string;
  detail?: string | null;
  target_id?: string | null;
  target_label?: string | null;
  proposed_by_clients?: string[];
  ratified_by?: string | null;
  state_key?: string;
  serves_need?: string;
  status?: string;
}

interface ActivityResponse {
  ok: boolean;
  events: ActivityEvent[];
  count: number;
  total_seen: number;
}

// --------------------------------------------------------------------------
// Aggregated row shape rendered in the panel body
// --------------------------------------------------------------------------

type RowKind =
  | "belief_convergence"
  | "belief_promoted"
  | "belief_proposed"
  | "fact_added"
  | "project_created"
  | "project_updates"
  | "rule_applied";

interface BaseRow {
  id: string;
  kind: RowKind;
  whenIso: string;
  target?: { kind: "belief" | "fact" | "project" | "rule"; id: string };
}

interface BeliefConvergenceRow extends BaseRow {
  kind: "belief_convergence";
  beliefText: string;
  clients: string[];
}

interface BeliefPromotedRow extends BaseRow {
  kind: "belief_promoted";
  beliefText: string;
  byClient: string | null;
}

interface BeliefProposedRow extends BaseRow {
  kind: "belief_proposed";
  beliefText: string;
  byClient: string | null;
}

interface FactAddedRow extends BaseRow {
  kind: "fact_added";
  factText: string;
  client: string | null;
}

interface ProjectCreatedRow extends BaseRow {
  kind: "project_created";
  projectId: string;
  projectName: string;
  byClient: string | null;
}

interface ProjectUpdatesRow extends BaseRow {
  kind: "project_updates";
  projectId: string;
  projectName: string;
  count: number;
  byClient: string | null;
}

interface RuleAppliedRow extends BaseRow {
  kind: "rule_applied";
  count: number;
}

type UpdateRow =
  | BeliefConvergenceRow
  | BeliefPromotedRow
  | BeliefProposedRow
  | FactAddedRow
  | ProjectCreatedRow
  | ProjectUpdatesRow
  | RuleAppliedRow;

// --------------------------------------------------------------------------
// Client label helpers — same source-of-truth shape as RecentActivityPanel
// --------------------------------------------------------------------------

const CLIENT_LABEL: Record<string, string> = {
  claude: "Claude",
  "claude-desktop": "Claude Desktop",
  "claude-web": "Claude (web)",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  replit: "Replit",
  "notion-ai": "Notion AI",
  windsurf: "Windsurf",
  "github-copilot": "GitHub Copilot",
  perplexity: "Perplexity",
  grok: "Grok",
  zapier: "Zapier",
  "lykn-chat": "LYKN",
  "lykn-promotion": "LYKN synthesis",
  manual: "you",
  chatgpt: "ChatGPT",
  other: "An external AI",
};

function clientDisplay(slug: string | null | undefined): string {
  if (!slug) return "An AI";
  return CLIENT_LABEL[slug] || slug;
}

function joinClients(slugs: string[]): string {
  const labels = slugs.map(clientDisplay);
  if (labels.length <= 1) return labels[0] || "An AI";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
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
  return `${day}d ago`;
}

// --------------------------------------------------------------------------
// Storage helpers
// --------------------------------------------------------------------------

function clearLegacyState(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY_DISMISSED);
  } catch {
    /* silent no-op */
  }
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY_LAST_VISIT);
  } catch {
    /* silent no-op */
  }
}

// --------------------------------------------------------------------------
// Aggregation — build update rows from raw activity events
// --------------------------------------------------------------------------
// We surface recent synthesis-layer activity broadly (no time gate). The
// goal: every visit, the user can see what neurons and beliefs have been
// touched, what's new, what's pending their review, and what their AI
// tools have been adding. Aggregation rules per kind are tuned to keep
// each row carrying real information and to avoid noisy duplicates:
//
//   • belief_convergence   — 2+ clients on the same belief, rendered
//                            once per belief. Strongest signal, top.
//   • belief_proposed      — pending the user's review, individual rows
//                            (capped) so they can act on each.
//   • belief_promoted      — newly active beliefs, individual rows
//                            (capped) — keeps belief identity visible.
//   • project_created      — new project, individual rows.
//   • project_updates      — state pushes grouped by project.
//   • fact_added           — individual rows (capped).
//   • rule_applied         — collapsed into a single "N rules shaped
//                            replies recently" summary row.

const MAX_ROWS = 30;
const MAX_PROPOSED = 6;
const MAX_PROMOTED = 5;
const MAX_FACTS = 6;

function aggregateEvents(events: ActivityEvent[]): UpdateRow[] {
  if (!events.length) return [];

  const rows: UpdateRow[] = [];
  const convergenceSeen = new Set<string>();

  // 1. Cross-client convergence — render once per target_id.
  for (const e of events) {
    if (e.type !== "belief_active" && e.type !== "belief_proposed") continue;
    const clients = Array.isArray(e.proposed_by_clients) ? e.proposed_by_clients : [];
    if (clients.length < 2) continue;
    if (!e.target_id || convergenceSeen.has(e.target_id)) continue;
    convergenceSeen.add(e.target_id);
    rows.push({
      id: `convergence:${e.target_id}`,
      kind: "belief_convergence",
      whenIso: e.when,
      target: { kind: "belief", id: e.target_id },
      beliefText: e.target_label || "a new belief",
      clients,
    });
  }

  // 2. Beliefs awaiting the user's review (proposed but not in
  //    convergence). Show individually, capped.
  let proposedShown = 0;
  for (const e of events) {
    if (e.type !== "belief_proposed") continue;
    if (!e.target_id || convergenceSeen.has(e.target_id)) continue;
    if (proposedShown >= MAX_PROPOSED) break;
    proposedShown += 1;
    rows.push({
      id: `belief_proposed:${e.target_id}`,
      kind: "belief_proposed",
      whenIso: e.when,
      target: { kind: "belief", id: e.target_id },
      beliefText: e.target_label || "a new belief",
      byClient: e.by_client,
    });
  }

  // 3. Beliefs promoted to active (not in convergence). Individual.
  let promotedShown = 0;
  for (const e of events) {
    if (e.type !== "belief_active") continue;
    if (!e.target_id || convergenceSeen.has(e.target_id)) continue;
    if (promotedShown >= MAX_PROMOTED) break;
    promotedShown += 1;
    rows.push({
      id: `belief_promoted:${e.target_id}`,
      kind: "belief_promoted",
      whenIso: e.when,
      target: { kind: "belief", id: e.target_id },
      beliefText: e.target_label || "a new belief",
      byClient: e.by_client,
    });
  }

  // 4. Newly created projects.
  for (const e of events) {
    if (e.type !== "project_created") continue;
    if (!e.target_id) continue;
    rows.push({
      id: `project_created:${e.target_id}`,
      kind: "project_created",
      whenIso: e.when,
      target: { kind: "project", id: e.target_id },
      projectId: e.target_id,
      projectName: e.target_label || "a project",
      byClient: e.by_client,
    });
  }

  // 5. Project state pushes grouped by project.
  const byProject = new Map<
    string,
    { events: ActivityEvent[]; name: string }
  >();
  for (const e of events) {
    if (e.type !== "project_state") continue;
    if (!e.target_id) continue;
    const entry = byProject.get(e.target_id) || {
      events: [],
      name: e.target_label || "a project",
    };
    entry.events.push(e);
    if (e.target_label) entry.name = e.target_label;
    byProject.set(e.target_id, entry);
  }
  for (const [projectId, { events: ev, name }] of byProject) {
    const newest = ev[0];
    rows.push({
      id: `project_updates:${projectId}:${newest.id}`,
      kind: "project_updates",
      whenIso: newest.when,
      target: { kind: "project", id: projectId },
      projectId,
      projectName: name,
      count: ev.length,
      byClient: newest.by_client,
    });
  }

  // 6. Recent facts — individual rows, capped.
  let factsShown = 0;
  for (const e of events) {
    if (e.type !== "fact_added") continue;
    if (!e.target_id) continue;
    if (factsShown >= MAX_FACTS) break;
    factsShown += 1;
    rows.push({
      id: `fact_added:${e.target_id}`,
      kind: "fact_added",
      whenIso: e.when,
      target: { kind: "fact", id: e.target_id },
      factText: e.target_label || "a fact about you",
      client: e.by_client,
    });
  }

  // 7. Rules — collapse to one summary row.
  const rulesApplied = events.filter((e) => e.type === "rule_applied");
  if (rulesApplied.length > 0) {
    const newest = rulesApplied[0];
    rows.push({
      id: `rule_applied:summary:${newest.id}`,
      kind: "rule_applied",
      whenIso: newest.when,
      target: undefined,
      count: rulesApplied.length,
    });
  }

  rows.sort((a, b) => Date.parse(b.whenIso) - Date.parse(a.whenIso));
  return rows.slice(0, MAX_ROWS);
}

// --------------------------------------------------------------------------
// Authed fetch
// --------------------------------------------------------------------------

async function fetchActivity(): Promise<ActivityResponse | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token || "";
    const res = await fetch(
      `${API_BASE_URL}/api/v1/synthesis/activity?limit=${ACTIVITY_LIMIT}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as ActivityResponse;
    if (!body?.ok) return null;
    return body;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Day grouping
// --------------------------------------------------------------------------

type DayBucket = "Today" | "Yesterday" | "Earlier";

function bucketFor(when: string): DayBucket {
  const t = Date.parse(when);
  if (!Number.isFinite(t)) return "Earlier";
  const eventDate = new Date(t);
  const today = new Date();
  if (eventDate.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (eventDate.toDateString() === yesterday.toDateString()) return "Yesterday";
  return "Earlier";
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

interface SynthesisUpdatesPanelProps {
  /** Whether the parent page is mounted and showing graph content. */
  active: boolean;
  /**
   * Controlled open state. Parent owns this so it can render a separate
   * "Recent activity" reopen button in its toolbar when the panel is
   * closed, and so the auto-open-on-mount lives at the page level.
   */
  open: boolean;
  /** Called when the user clicks the close button or a row. */
  onClose: () => void;
  /**
   * Optional graph-focus callback. When the user clicks an update row, the
   * page can focus the relevant neuron in the 3D graph. The panel only
   * forwards (kind, id) — the parent maps to its own node-id convention.
   */
  onFocusTarget?: (target: { kind: "belief" | "fact" | "project" | "rule"; id: string }) => void;
}

export default function SynthesisUpdatesPanel({
  active,
  open,
  onClose,
  onFocusTarget,
}: SynthesisUpdatesPanelProps) {
  const [rows, setRows] = useState<UpdateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const resp = await fetchActivity();
    const events = resp?.events || [];
    const aggregated = aggregateEvents(events);
    setRows(aggregated);
    setHasFetched(true);
    setLoading(false);
    return aggregated;
  }, []);

  // Sweep stale state from prior iterations once on mount.
  useEffect(() => {
    clearLegacyState();
  }, []);

  // Refetch every time the panel opens, so reopening it via the toolbar
  // button always shows fresh activity. The very first open also fires
  // this — we don't pre-load before the panel is visible because the
  // page's auto-open-on-mount happens immediately and there's no need
  // to start the request earlier.
  useEffect(() => {
    if (!active) return;
    if (!open) return;
    void loadData();
  }, [active, open, loadData]);

  const handleRowClick = useCallback(
    (row: UpdateRow) => {
      if (row.target && onFocusTarget) onFocusTarget(row.target);
      onClose();
    },
    [onClose, onFocusTarget],
  );

  const grouped = useMemo(() => {
    const buckets: Record<DayBucket, UpdateRow[]> = {
      Today: [],
      Yesterday: [],
      Earlier: [],
    };
    for (const r of rows) buckets[bucketFor(r.whenIso)].push(r);
    return buckets;
  }, [rows]);

  if (!active) return null;

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="synthesis-updates-panel"
          initial={{ x: 380, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 380, opacity: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 34 }}
          className="fixed top-0 right-0 z-[81] h-full w-full sm:w-[460px] flex flex-col bg-zinc-950/95 backdrop-blur-xl border-l border-white/10 shadow-2xl"
          role="dialog"
          aria-label="What's new in your synthesis layer"
        >
          {/* Header. Layout follows the BeliefWindowPanel-aligned spec
              (`ui_updates_experience` in project state): icon + title +
              sub-line + spacer + refresh button. The page-level chevron
              toggle (z-[100], right-4) is the canonical close
              affordance for every right-side panel, so we deliberately
              do NOT render an internal X close button here — that's
              what the chevron is for. We pad-right to pr-12 so the
              title clears the always-visible chevron. The "click
              backdrop to close" line in the spec is intentionally
              skipped: the synthesis layer is meant to stay visible and
              interactive behind the panel (no dim), so a fully
              transparent backdrop wouldn't add anything beyond what
              the chevron + ESC already do. */}
          <header className="pl-4 pr-12 py-3 border-b border-white/10 flex items-center gap-2">
            <Sparkles size={14} className="text-indigo-300 flex-none" />
            <div className="min-w-0 flex-1">
              <h2 className="text-[14px] font-semibold tracking-tight text-white">
                What's new
              </h2>
              <div className="text-[11px] text-white/50">
                Since your last visit
              </div>
            </div>
            <button
              onClick={() => loadData()}
              disabled={loading}
              className="h-8 w-8 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/75 transition-colors disabled:opacity-50 flex items-center justify-center flex-none"
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </header>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 scrollbar-hide">
            {loading && !hasFetched ? (
              <div className="flex items-center justify-center py-16 text-white/45 text-xs">
                <Loader2 size={14} className="animate-spin mr-2" />
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center px-2">
                <div className="text-[13px] font-semibold text-white/85">
                  Welcome to your synthesis layer
                </div>
                <div className="mt-1.5 text-[11.5px] leading-relaxed text-white/55 max-w-[280px]">
                  This is where your beliefs, facts, and project state live across every AI tool you use.
                </div>
                <div className="mt-2 text-[11.5px] leading-relaxed text-white/45 max-w-[280px]">
                  As you work with Claude, Cursor, and other tools, new neurons and updates will show up here.
                </div>
              </div>
            ) : (
              (["Today", "Yesterday", "Earlier"] as const).map((bucket) =>
                grouped[bucket].length > 0 ? (
                  <section key={bucket} className="space-y-2">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-white/45">
                      {bucket}
                    </div>
                    <div className="space-y-2">
                      {grouped[bucket].map((row) => (
                        <UpdateRowView
                          key={row.id}
                          row={row}
                          onClick={() => handleRowClick(row)}
                        />
                      ))}
                    </div>
                  </section>
                ) : null,
              )
            )}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

// --------------------------------------------------------------------------
// Row renderer
// --------------------------------------------------------------------------

function UpdateRowView({
  row,
  onClick,
}: {
  row: UpdateRow;
  onClick: () => void;
}) {
  const interactive = !!row.target;
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      className={[
        "w-full text-left rounded-lg border border-white/10 bg-white/[0.025]",
        "px-3 py-2 space-y-1.5 transition-colors",
        interactive ? "hover:border-white/20 hover:bg-white/[0.045] cursor-pointer" : "cursor-default",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
      ].join(" ")}
    >
      {renderRow(row)}
    </button>
  );
}

function ClientChip({ slug }: { slug: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-white/70">
      {clientDisplay(slug)}
    </span>
  );
}

// Tone palette per row kind. Kept in one place so the visual language
// stays consistent — convergence reads as the "strongest signal" indigo,
// proposed is amber to suggest "needs your attention," promoted is
// emerald for "added," etc. Background is a low-opacity wash of the
// glyph color so each card scans as a categorized badge.
type Tone =
  | "indigo"
  | "amber"
  | "emerald"
  | "sky"
  | "fuchsia"
  | "cyan"
  | "rose";

const TONE_STYLES: Record<Tone, { glyph: string; bg: string; ring: string }> = {
  indigo: {
    glyph: "text-indigo-300",
    bg: "bg-indigo-400/10",
    ring: "border-indigo-400/25",
  },
  amber: {
    glyph: "text-amber-300",
    bg: "bg-amber-400/10",
    ring: "border-amber-400/25",
  },
  emerald: {
    glyph: "text-emerald-300",
    bg: "bg-emerald-400/10",
    ring: "border-emerald-400/25",
  },
  sky: {
    glyph: "text-sky-300",
    bg: "bg-sky-400/10",
    ring: "border-sky-400/25",
  },
  fuchsia: {
    glyph: "text-fuchsia-300",
    bg: "bg-fuchsia-400/10",
    ring: "border-fuchsia-400/25",
  },
  cyan: {
    glyph: "text-cyan-300",
    bg: "bg-cyan-400/10",
    ring: "border-cyan-400/25",
  },
  rose: {
    glyph: "text-rose-300",
    bg: "bg-rose-400/10",
    ring: "border-rose-400/25",
  },
};

function RowBody({
  Icon,
  tone,
  title,
  subtitle,
  meta,
}: {
  Icon: typeof Sparkles;
  tone: Tone;
  title: string;
  subtitle?: string | null;
  meta: React.ReactNode;
}) {
  const t = TONE_STYLES[tone];
  return (
    <div className="flex items-start gap-2.5">
      <div
        className={[
          "mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md border",
          t.bg,
          t.ring,
        ].join(" ")}
      >
        <Icon className={["h-3.5 w-3.5", t.glyph].join(" ")} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold leading-snug text-white">
          {title}
        </div>
        {subtitle ? (
          <div className="mt-0.5 text-[11.5px] text-white/55 line-clamp-2">
            {subtitle}
          </div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-white/45">
          {meta}
        </div>
      </div>
    </div>
  );
}

function renderRow(row: UpdateRow): React.ReactNode {
  switch (row.kind) {
    case "belief_convergence": {
      const title = `${joinClients(row.clients)} independently noticed the same principle`;
      return (
        <RowBody
          Icon={Bookmark}
          tone="indigo"
          title={title}
          subtitle={`"${row.beliefText}"`}
          meta={
            <>
              {row.clients.slice(0, 3).map((slug) => (
                <ClientChip key={slug} slug={slug} />
              ))}
              <span className="text-white/30">·</span>
              <span>{relativeTime(row.whenIso)}</span>
            </>
          }
        />
      );
    }
    case "belief_proposed": {
      return (
        <RowBody
          Icon={CircleDashed}
          tone="amber"
          title="New belief awaiting your review"
          subtitle={`"${row.beliefText}"`}
          meta={
            <>
              {row.byClient ? <ClientChip slug={row.byClient} /> : null}
              <span className="text-white/30">·</span>
              <span>{relativeTime(row.whenIso)}</span>
            </>
          }
        />
      );
    }
    case "belief_promoted": {
      return (
        <RowBody
          Icon={CheckCircle2}
          tone="emerald"
          title="New belief added to your synthesis layer"
          subtitle={`"${row.beliefText}"`}
          meta={
            <>
              {row.byClient ? <ClientChip slug={row.byClient} /> : null}
              <span className="text-white/30">·</span>
              <span>{relativeTime(row.whenIso)}</span>
            </>
          }
        />
      );
    }
    case "fact_added": {
      const who = clientDisplay(row.client);
      const title = row.client
        ? `${who} learned a new fact about you`
        : "A new fact about you was learned";
      return (
        <RowBody
          Icon={User}
          tone="sky"
          title={title}
          subtitle={`"${row.factText}"`}
          meta={
            <>
              {row.client ? <ClientChip slug={row.client} /> : null}
              <span className="text-white/30">·</span>
              <span>{relativeTime(row.whenIso)}</span>
            </>
          }
        />
      );
    }
    case "project_created": {
      return (
        <RowBody
          Icon={FolderPlus}
          tone="fuchsia"
          title={`New project: "${row.projectName}"`}
          subtitle={null}
          meta={
            <>
              {row.byClient ? <ClientChip slug={row.byClient} /> : null}
              <span className="text-white/30">·</span>
              <span>{relativeTime(row.whenIso)}</span>
            </>
          }
        />
      );
    }
    case "project_updates": {
      const title = `${row.count} update${row.count === 1 ? "" : "s"} to "${row.projectName}"`;
      return (
        <RowBody
          Icon={GitCommit}
          tone="cyan"
          title={title}
          subtitle={null}
          meta={
            <>
              {row.byClient ? <ClientChip slug={row.byClient} /> : null}
              <span className="text-white/30">·</span>
              <span>{relativeTime(row.whenIso)}</span>
            </>
          }
        />
      );
    }
    case "rule_applied": {
      const title =
        row.count === 1
          ? "A rule shaped a recent reply"
          : `${row.count} rules shaped recent replies`;
      return (
        <RowBody
          Icon={Scale}
          tone="rose"
          title={title}
          subtitle="Your synthesis layer is actively guiding AI responses."
          meta={<span>{relativeTime(row.whenIso)}</span>}
        />
      );
    }
    default:
      return null;
  }
}
