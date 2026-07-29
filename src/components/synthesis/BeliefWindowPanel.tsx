import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Atom,
  Check,
  ChevronDown,
  Compass,
  Heart,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";

/**
 * CORE BELIEFS PANEL (component name kept as BeliefWindowPanel for stable
 * import paths; the user-facing label is "Core Beliefs").
 *
 * The user-facing surface for the layer ABOVE atomic facts. Lives as a
 * right-side slide-out on the synthesis layer page (SynthesisLayer.tsx).
 * Shows three sections:
 *
 *   1. PROPOSED  — beliefs the AI promoted from fact clusters but the user
 *                  has not yet ratified. Each card has Accept / Dismiss /
 *                  Edit affordances. Accepting moves it to Active and
 *                  auto-proposes 2-3 rules underneath.
 *
 *   2. ACTIVE    — ratified beliefs + their (proposed and active) rules.
 *                  Rules can be ratified, retired, or edited inline.
 *                  Each belief is tagged with the need it serves (live /
 *                  love / value / variety) so the user can see balance.
 *
 *   3. WHY LOG   — recent attribution rows. Each entry shows the message
 *                  id, the rule snapshot, and the belief snapshot. The
 *                  user can mark an attribution good/bad; on bad we ask
 *                  one follow-up: rule wrong, belief wrong, or generation
 *                  miss?
 *
 * The panel is a thin orchestrator — every mutation is one POST/PATCH
 * call to the belief-window endpoints in server.js, then a refetch.
 *
 * Honesty principle: no entry on the Why log is fabricated. Attributions
 * are only created when the chat model emitted a verified <applied> tag.
 */

// ---------------------------------------------------------------------------
// Types — match the shape of /api/beliefs's response
// ---------------------------------------------------------------------------

type Need = "live" | "love" | "value" | "variety";

interface Belief {
  id: string;
  belief_text: string;
  serves_need: Need;
  status: "proposed" | "active" | "retired" | "superseded";
  confidence: number;
  rationale: string | null;
  promoted_from_facts: string[];
  invocation_count: number;
  good_feedback_count: number;
  bad_feedback_count: number;
  ratified_at: string | null;
  retired_at: string | null;
  created_at: string;
}

interface Rule {
  id: string;
  belief_id: string;
  trigger_text: string;
  action_text: string;
  status: "proposed" | "active" | "retired" | "draft";
  priority: number;
  confidence: number;
  invocation_count: number;
  good_feedback_count: number;
  bad_feedback_count: number;
  ratified_at: string | null;
  retired_at: string | null;
  created_at: string;
}

interface Attribution {
  id: string;
  message_id: string;
  surface: string | null;
  surface_id: string | null;
  rule_id: string | null;
  belief_id: string | null;
  rule_snapshot: string | null;
  belief_snapshot: string | null;
  serves_need: Need | null;
  reason: string | null;
  user_feedback: "good" | "bad" | null;
  rule_was_bad: boolean;
  belief_was_bad: boolean;
  feedback_note: string | null;
  created_at: string;
}

interface BeliefsResponse {
  ok: boolean;
  beliefs: Belief[];
  rules: Rule[];
  attributions: Attribution[];
  needs: Need[];
}

// ---------------------------------------------------------------------------
// Visual config — needs map to icons + accent colors
// ---------------------------------------------------------------------------

const NEED_THEME: Record<
  Need,
  { label: string; icon: typeof Shield; ring: string; chip: string; dot: string }
> = {
  live: {
    label: "Live",
    icon: Shield,
    ring: "border-emerald-400/40",
    chip: "bg-emerald-500/12 text-emerald-200 border-emerald-400/30",
    dot: "bg-emerald-300",
  },
  // Need-themes are restricted to blue / yellow / green — no purple, no
  // pink. Live keeps emerald, value keeps amber. Love and variety both
  // sit on the blue ramp but use different shades (sky for love, blue
  // for variety) so the four needs still read as visually distinct
  // categories at a glance.
  love: {
    label: "Love",
    icon: Heart,
    ring: "border-sky-400/40",
    chip: "bg-sky-500/12 text-sky-200 border-sky-400/30",
    dot: "bg-sky-300",
  },
  value: {
    label: "Value",
    icon: Star,
    ring: "border-amber-400/40",
    chip: "bg-amber-500/12 text-amber-200 border-amber-400/30",
    dot: "bg-amber-300",
  },
  variety: {
    label: "Variety",
    icon: Compass,
    ring: "border-blue-400/40",
    chip: "bg-blue-500/12 text-blue-200 border-blue-400/30",
    dot: "bg-blue-300",
  },
};

// ---------------------------------------------------------------------------
// Tiny fetch helpers (no react-query; this panel mounts ad-hoc and we want
// instant reactive refetch after each mutation)
// ---------------------------------------------------------------------------

async function fetchBeliefs(): Promise<BeliefsResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/beliefs`);
    if (!res.ok) return null;
    const body = (await res.json()) as BeliefsResponse;
    if (!body?.ok) return null;
    return body;
  } catch {
    return null;
  }
}

async function postJson(path: string, body?: Record<string, unknown>) {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message || "fetch_failed" };
  }
}

async function patchJson(path: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message || "fetch_failed" };
  }
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

/**
 * Perspective summary the parent page passes in so the Perspectives
 * tab can list them without owning its own fetch. We deliberately
 * keep this lightweight — title, optional summary, created_at — so
 * the parent (which already fetches the full Vault notes list and
 * filters for the `_perspective` marker tag) can derive these in one
 * pass. Click-through opens the perspective in the synthesis-layer
 * 3D scene via `onSelectPerspective`, where the existing
 * DetailPanel handles the body.
 */
export interface PerspectiveSummary {
  id: string;
  title: string;
  ai_summary?: string | null;
  created_at?: string | null;
}

export type BeliefWindowPanelProps = {
  open: boolean;
  onClose: () => void;
  /**
   * When set, the new-belief composer at the top of the Beliefs tab opens
   * pre-expanded the next time the panel goes from closed → open. Used by
   * the "+ → Core Belief neuron" entry point on the synthesis page so the
   * user lands directly in the write-in form. Each `open` cycle only
   * honors the flag once; closing + reopening the panel goes back to the
   * collapsed default.
   */
  initialComposerOpen?: boolean;
  /**
   * When set, the panel hoists the matching belief to the very top and
   * auto-expands it. Drives the "click a belief neuron in 3D → that
   * belief is the one already opened in the panel" interaction. Pass
   * just the belief uuid (not the `belief_` node-id prefix).
   */
  focusBeliefId?: string | null;
  /**
   * Perspective notes (Vault rows tagged with the `_perspective`
   * marker). Powers the Perspectives sub-tab. Pass an empty array
   * when the parent doesn't have notes loaded yet — the tab will
   * render its empty state. Beliefs + Perspectives are the two
   * halves of the unified Belief cluster in the 5-category model,
   * which is why they share this panel.
   */
  perspectives?: PerspectiveSummary[];
  /**
   * Triggers the parent's Perspective composer (the same flow the
   * synthesis-layer "+" menu uses). When undefined, the "+ Add" CTA
   * on the Perspectives tab is hidden.
   */
  onCreatePerspective?: () => void;
  /**
   * Click handler for an individual perspective row. Receives the
   * raw note uuid (no prefix) so the parent can translate to its
   * `perspective_<uuid>` node id and focus the 3D scene.
   */
  onSelectPerspective?: (perspectiveId: string) => void;
};

export default function BeliefWindowPanel({
  open,
  onClose,
  initialComposerOpen,
  focusBeliefId,
  perspectives,
  onCreatePerspective,
  onSelectPerspective,
}: BeliefWindowPanelProps) {
  const [data, setData] = useState<BeliefsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Non-null when the most recent mutation (ratify/retire/edit/…) failed.
  // Surfaced as an inline banner so failures aren't silently swallowed.
  const [actionError, setActionError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  // Tabs: Beliefs (ratify + create principles), Perspectives (long-form
  // stories — the other half of the Belief cluster), Rules (belief-derived
  // triggers), Why log (attribution audit). Perspectives slots
  // immediately after Beliefs since they share the same cluster.
  const [activeTab, setActiveTab] = useState<
    "beliefs" | "perspectives" | "rules" | "log"
  >("beliefs");
  const perspectivesList = perspectives ?? [];
  // Tracks per-row pending mutation state so spinners don't flicker globally.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const lastLoadedAt = useRef<number>(0);
  // One-shot signal to NewBeliefComposer to start expanded. Bumped each
  // time the panel transitions closed → open while initialComposerOpen is
  // true; the composer reads it via useEffect and resets after honoring it.
  const [composerOpenToken, setComposerOpenToken] = useState(0);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current && initialComposerOpen) {
      setComposerOpenToken((n) => n + 1);
      setActiveTab("beliefs");
    }
    wasOpenRef.current = open;
  }, [open, initialComposerOpen]);

  // When the user clicks a belief neuron in the 3D scene, snap to the
  // Beliefs tab so the focused belief is visible at the top (rather
  // than stranding them on Rules or Why-log).
  useEffect(() => {
    if (open && focusBeliefId) {
      setActiveTab("beliefs");
    }
  }, [open, focusBeliefId]);

  const loadData = useMemo(
    () => async () => {
      setLoading(true);
      const next = await fetchBeliefs();
      if (next) {
        setData(next);
        setLoadError(false);
        lastLoadedAt.current = Date.now();
      } else {
        // Keep any previously-loaded data on screen; only flag the error
        // so a failed fetch doesn't render as a silently empty panel.
        setLoadError(true);
      }
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (Date.now() - lastLoadedAt.current < 5_000 && data) return;
    void loadData();
  }, [open, loadData, data]);

  const beliefs = data?.beliefs || [];
  const rules = data?.rules || [];
  const attributions = data?.attributions || [];

  const proposedBeliefs = beliefs.filter((b) => b.status === "proposed");
  const activeBeliefs = beliefs.filter((b) => b.status === "active");

  const rulesByBelief = useMemo(() => {
    const m = new Map<string, Rule[]>();
    for (const r of rules) {
      if (r.status === "retired") continue;
      const arr = m.get(r.belief_id) || [];
      arr.push(r);
      m.set(r.belief_id, arr);
    }
    return m;
  }, [rules]);

  const markPending = (id: string, on: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // postJson/patchJson never throw — they return { ok: false } on any
  // failure. Every mutation used to ignore that and clear its spinner as
  // if it worked; route all of them through here so failures surface.
  const reportResult = (res: { ok?: boolean } | null | undefined) => {
    if (!res || res.ok === false) {
      setActionError("That change didn't save — please try again.");
    } else {
      setActionError(null);
    }
  };

  const promoteBeliefs = async () => {
    if (promoting) return;
    setPromoting(true);
    reportResult(await postJson("/api/beliefs/promote"));
    await loadData();
    setPromoting(false);
  };

  const ratifyBelief = async (id: string) => {
    markPending(id, true);
    reportResult(await postJson(`/api/beliefs/${id}/ratify`));
    await loadData();
    markPending(id, false);
  };

  const retireBelief = async (id: string) => {
    markPending(id, true);
    reportResult(await postJson(`/api/beliefs/${id}/retire`));
    await loadData();
    markPending(id, false);
  };

  const editBelief = async (
    id: string,
    patch: { text?: string; servesNeed?: Need },
  ) => {
    const body: Record<string, unknown> = {};
    if (patch.text != null) body.text = patch.text;
    if (patch.servesNeed != null) body.servesNeed = patch.servesNeed;
    if (!Object.keys(body).length) return;
    markPending(id, true);
    reportResult(await patchJson(`/api/beliefs/${id}`, body));
    await loadData();
    markPending(id, false);
  };

  const createBelief = async (text: string, servesNeed: Need) => {
    const tempId = `__create_${Date.now()}`;
    markPending(tempId, true);
    reportResult(await postJson("/api/beliefs/manual", { text, servesNeed }));
    await loadData();
    markPending(tempId, false);
  };

  const proposeMoreRules = async (id: string) => {
    markPending(`rules-${id}`, true);
    reportResult(await postJson(`/api/beliefs/${id}/propose-rules`));
    await loadData();
    markPending(`rules-${id}`, false);
  };

  const ratifyRule = async (id: string) => {
    markPending(id, true);
    reportResult(await postJson(`/api/rules/${id}/ratify`));
    await loadData();
    markPending(id, false);
  };

  const retireRule = async (id: string) => {
    markPending(id, true);
    reportResult(await postJson(`/api/rules/${id}/retire`));
    await loadData();
    markPending(id, false);
  };

  const editRule = async (id: string, patch: Record<string, unknown>) => {
    markPending(id, true);
    reportResult(await patchJson(`/api/rules/${id}`, patch));
    await loadData();
    markPending(id, false);
  };

  const sendAttributionFeedback = async (
    id: string,
    payload: {
      action: "good" | "bad";
      ruleWasBad?: boolean;
      beliefWasBad?: boolean;
      note?: string;
    },
  ) => {
    markPending(id, true);
    reportResult(await postJson(`/api/applied/${id}/feedback`, payload));
    await loadData();
    markPending(id, false);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="belief-window-panel"
          initial={{ x: 380, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 380, opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 32 }}
          className="fixed top-0 right-0 z-[90] h-full w-[380px] max-w-[92vw] flex flex-col bg-[rgba(15,15,18,0.92)] backdrop-blur-xl border-l border-white/10 shadow-[0_0_60px_rgba(99,102,241,0.16)]"
          role="dialog"
          aria-label="Core Beliefs"
        >
          {/* Header. No internal close button — the page-level chevron
              toggle in SynthesisLayer (z-[100], right-4) is the canonical
              close affordance for every right-side panel and already
              wires through to setBeliefWindowOpen(false). We right-pad
              so the title clears that toggle when it's visible. */}
          <header className="pl-5 pr-12 py-4 border-b border-white/8 flex items-center gap-2.5">
            <Atom size={15} className="text-blue-300" />
            <h2 className="text-sm font-semibold text-white/90 tracking-wide">
              Core Beliefs
            </h2>
            <span className="ml-auto text-[0.6rem] uppercase tracking-wider text-white/40 font-medium">
              Legacy
            </span>
          </header>

          {/* Synthesis v2: personalization moved to chat-ratified User Facts. */}
          <div className="mx-3 mt-3 px-3 py-2.5 rounded-lg border border-amber-400/25 bg-amber-500/10 text-amber-100/90 text-[0.7rem] leading-relaxed">
            Preferences now save as <span className="font-medium text-amber-50">User Facts</span> inside chat
            (Yes / Edit / No). This panel is kept for existing beliefs; new durable claims should be confirmed in chat.
          </div>

          {/* Sub-tabs */}
          <div className="px-3 pt-3 pb-2 flex items-center gap-1 border-b border-white/6">
            {(
              [
                { id: "beliefs" as const, label: "Beliefs", count: activeBeliefs.length + proposedBeliefs.length },
                { id: "perspectives" as const, label: "Stories", count: perspectivesList.length },
                { id: "rules" as const, label: "Rules", count: rules.filter((r) => r.status !== "retired").length },
                { id: "log" as const, label: "Why log", count: attributions.length },
              ]
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 px-1.5 py-1.5 text-[0.7rem] font-medium rounded-md transition-colors ${
                  activeTab === tab.id
                    ? "bg-white/10 text-white"
                    : "text-white/55 hover:text-white/85 hover:bg-white/5"
                }`}
              >
                {tab.label}
                <span className="ml-1 text-white/40 tabular-nums">{tab.count}</span>
              </button>
            ))}
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-hide">
            {actionError && (
              <div className="mb-3 px-3 py-2 rounded-lg border border-red-400/30 bg-red-500/10 text-red-200 text-[0.7rem] flex items-center justify-between gap-2">
                <span>{actionError}</span>
                <button
                  onClick={() => setActionError(null)}
                  className="text-red-200/70 hover:text-red-100 shrink-0"
                  aria-label="Dismiss error"
                >
                  ✕
                </button>
              </div>
            )}
            {loading && !data && (
              <div className="flex items-center justify-center py-16 text-white/45 text-xs">
                <Loader2 size={14} className="animate-spin mr-2" />
                Loading…
              </div>
            )}
            {!loading && !data && loadError && (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                <p className="text-white/60 text-xs">
                  Couldn't load your beliefs right now.
                </p>
                <button
                  onClick={() => loadData()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/8 hover:bg-white/12 text-white/80 text-[0.7rem] transition-colors"
                >
                  <RefreshCw size={11} />
                  Try again
                </button>
              </div>
            )}

            {activeTab === "beliefs" && data && (
              <BeliefsTab
                proposed={proposedBeliefs}
                active={activeBeliefs}
                rulesByBelief={rulesByBelief}
                pendingIds={pendingIds}
                promoting={promoting}
                composerOpenToken={composerOpenToken}
                focusBeliefId={focusBeliefId || null}
                onPromote={promoteBeliefs}
                onCreate={createBelief}
                onRatify={ratifyBelief}
                onRetire={retireBelief}
                onEdit={editBelief}
                onProposeRules={proposeMoreRules}
                onViewRules={() => setActiveTab("rules")}
              />
            )}
            {activeTab === "perspectives" && (
              <PerspectivesTab
                perspectives={perspectivesList}
                onCreate={onCreatePerspective}
                onSelect={onSelectPerspective}
              />
            )}
            {activeTab === "rules" && data && (
              <RulesTab
                rules={rules}
                beliefsById={new Map(beliefs.map((b) => [b.id, b]))}
                pendingIds={pendingIds}
                onRatify={ratifyRule}
                onRetire={retireRule}
                onEdit={editRule}
              />
            )}
            {activeTab === "log" && data && (
              <WhyLogTab
                attributions={attributions}
                pendingIds={pendingIds}
                onFeedback={sendAttributionFeedback}
              />
            )}
          </div>

          {/* Footer */}
          <footer className="px-4 py-3 border-t border-white/8 flex items-center justify-between text-[0.65rem] text-white/45">
            <span>
              {activeBeliefs.length} active · {proposedBeliefs.length} proposed
            </span>
            <button
              onClick={() => loadData()}
              className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/8 hover:text-white/80 transition-colors"
              disabled={loading}
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </footer>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Perspectives tab — long-form stories the user has written about
// themselves. Lives next to Beliefs because both express the deepest
// self (Belief cluster in the 5-category model). This tab is a thin
// list view: the actual editor + creation flow lives in the
// synthesis-layer "+ → Perspective" composer and the Vault detail
// route. Click a row to focus that perspective in the 3D scene.
// ---------------------------------------------------------------------------

function PerspectivesTab(p: {
  perspectives: PerspectiveSummary[];
  onCreate?: () => void;
  onSelect?: (perspectiveId: string) => void;
}) {
  const sorted = useMemo(() => {
    const arr = [...p.perspectives];
    arr.sort((a, b) => {
      const aT = a.created_at ? Date.parse(a.created_at) : 0;
      const bT = b.created_at ? Date.parse(b.created_at) : 0;
      return bT - aT;
    });
    return arr;
  }, [p.perspectives]);

  return (
    <div className="space-y-3">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[0.78rem] font-semibold text-white/90">
            Your perspectives
          </h3>
          <p className="text-[0.68rem] text-white/55 leading-snug mt-0.5">
            Long-form stories and points of view that shape how you see
            the world. Sits next to your beliefs in the Belief cluster.
          </p>
        </div>
        {p.onCreate ? (
          <button
            onClick={p.onCreate}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-white/10 hover:bg-white/15 border border-white/15 text-[0.7rem] font-medium text-white/90 transition-colors flex-shrink-0"
          >
            <Plus size={11} />
            New
          </button>
        ) : null}
      </header>

      {sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 bg-white/3 px-3 py-6 text-center text-[0.7rem] text-white/55 leading-relaxed">
          You haven't written any perspectives yet.
          {p.onCreate ? " Tap " : null}
          {p.onCreate ? (
            <button
              onClick={p.onCreate}
              className="text-white/85 underline underline-offset-2 hover:text-white"
            >
              New
            </button>
          ) : null}
          {p.onCreate
            ? " above to write a short story about how you see something."
            : " Use the + menu on the synthesis layer to write one."}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {sorted.map((per) => (
            <li key={per.id}>
              <button
                onClick={() => p.onSelect?.(per.id)}
                className="w-full text-left rounded-lg border border-white/10 bg-white/4 hover:bg-white/8 hover:border-white/20 px-3 py-2.5 transition-colors"
              >
                <div className="text-[0.74rem] font-medium text-white/92 leading-snug truncate">
                  {per.title || "Untitled perspective"}
                </div>
                {per.ai_summary ? (
                  <div className="text-[0.66rem] text-white/55 leading-snug mt-1 line-clamp-2">
                    {per.ai_summary}
                  </div>
                ) : null}
                {per.created_at ? (
                  <div className="text-[0.6rem] text-white/35 mt-1.5 tabular-nums">
                    {new Date(per.created_at).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beliefs tab — one collapsed row per belief. Proposed rows surface first
// because they need an Accept/Dismiss decision. Each row opens individually
// to read, edit, or act on a single belief. Rules live on the Rules tab.
// ---------------------------------------------------------------------------

function BeliefsTab(p: {
  proposed: Belief[];
  active: Belief[];
  rulesByBelief: Map<string, Rule[]>;
  pendingIds: Set<string>;
  promoting: boolean;
  composerOpenToken: number;
  /** When set, hoist this belief to the very top of the list and
   *  auto-expand it. Driven by belief-neuron clicks in the 3D scene. */
  focusBeliefId: string | null;
  onPromote: () => void;
  onCreate: (text: string, servesNeed: Need) => void | Promise<void>;
  onRatify: (id: string) => void;
  onRetire: (id: string) => void;
  onEdit: (id: string, patch: { text?: string; servesNeed?: Need }) => void;
  onProposeRules: (beliefId: string) => void;
  onViewRules: () => void;
}) {
  // The focused belief (if any) is pulled out of its origin section and
  // pinned to the top of the list. It's also auto-expanded via the
  // `defaultOpen` + `focusToken` props on BeliefCard. Re-tapping a
  // different neuron updates `focusBeliefId`, which both moves the new
  // belief to the top and re-opens its card.
  const focusBelief =
    (p.focusBeliefId
      ? p.proposed.find((b) => b.id === p.focusBeliefId) ||
        p.active.find((b) => b.id === p.focusBeliefId)
      : null) || null;
  const proposedRest = focusBelief
    ? p.proposed.filter((b) => b.id !== focusBelief.id)
    : p.proposed;
  const activeRest = focusBelief
    ? p.active.filter((b) => b.id !== focusBelief.id)
    : p.active;

  const renderCard = (b: Belief, opts?: { defaultOpen?: boolean; focusToken?: string | null }) => (
    <BeliefCard
      key={b.id}
      belief={b}
      rulesCount={(p.rulesByBelief.get(b.id) || []).length}
      pending={p.pendingIds.has(b.id)}
      defaultOpen={opts?.defaultOpen}
      focusToken={opts?.focusToken ?? null}
      onRatify={() => p.onRatify(b.id)}
      onRetire={() => p.onRetire(b.id)}
      onEdit={(patch) => p.onEdit(b.id, patch)}
      onProposeRules={() => p.onProposeRules(b.id)}
      onViewRules={p.onViewRules}
      proposingRules={p.pendingIds.has(`rules-${b.id}`)}
    />
  );

  return (
    <div className="space-y-5">
      {/* Focused belief — the one the user just tapped in 3D. Sits above
          everything else (composer, sections) so the user sees the
          belief they clicked immediately, already open. */}
      {focusBelief && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-blue-200/80">
              Selected
            </h3>
          </div>
          {renderCard(focusBelief, { defaultOpen: true, focusToken: focusBelief.id })}
        </section>
      )}

      {/* Manual composer — primary write-in path. */}
      <NewBeliefComposer onCreate={p.onCreate} openToken={p.composerOpenToken} />

      {/* Promotion CTA — secondary, smaller. */}
      <button
        onClick={p.onPromote}
        disabled={p.promoting}
        className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 hover:text-white/90 text-[0.65rem] font-medium transition-colors disabled:opacity-50"
      >
        {p.promoting ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <Sparkles size={11} />
        )}
        {p.promoting ? "Looking for patterns…" : "Or have AI find patterns from your facts"}
      </button>

      {/* Proposed section — one collapsed row per belief; tap to review,
          accept, edit, or dismiss. */}
      {proposedRest.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-amber-200/80">
              Awaiting your review
            </h3>
            <span className="text-[0.6rem] text-amber-200/60 tabular-nums">
              {proposedRest.length}
            </span>
          </div>
          <div className="space-y-1.5">{proposedRest.map((b) => renderCard(b))}</div>
        </section>
      )}

      {/* Active section — one collapsed row per ratified belief. */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/45">
            Your beliefs
          </h3>
          {activeRest.length > 0 && (
            <span className="text-[0.6rem] text-white/35 tabular-nums">
              {activeRest.length}
            </span>
          )}
        </div>
        {activeRest.length === 0 && !focusBelief ? (
          <p className="text-[0.7rem] text-white/40 leading-relaxed">
            No ratified beliefs yet. Write one above, or let the AI{" "}
            <span className="text-white/65">find patterns from your facts</span> and accept the ones that ring true.
          </p>
        ) : (
          <div className="space-y-1.5">{activeRest.map((b) => renderCard(b))}</div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NewBeliefComposer — collapsed-by-default "+ Write a new belief" entry that
// expands into a small form (textarea + need picker + save/cancel). Manual
// authorship lands the belief in `active` status with high confidence and
// auto-proposes starter rules; the user is taking explicit ownership.
// ---------------------------------------------------------------------------

function NewBeliefComposer(p: {
  onCreate: (text: string, servesNeed: Need) => void | Promise<void>;
  /** When this number changes, force the composer open. */
  openToken?: number;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Honor external requests to open (e.g. + → "Core Belief neuron"). The
  // first render has token=0 and shouldn't auto-open; only subsequent
  // changes do.
  const lastTokenRef = useRef<number | undefined>(p.openToken);
  useEffect(() => {
    if (p.openToken == null) return;
    if (p.openToken !== lastTokenRef.current && p.openToken > 0) {
      setOpen(true);
    }
    lastTokenRef.current = p.openToken;
  }, [p.openToken]);

  const reset = () => {
    setText("");
    setOpen(false);
    setSubmitting(false);
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    // The "serves which need?" picker used to live here, but it was
    // friction the user wanted to skip on the create path. Default to
    // "value" — the closest fit for craft-identity / how-you-work
    // principles, which is what most user-authored beliefs are. The
    // user can re-categorize from the inline edit affordance on the
    // resulting belief card if they want a different bucket.
    await p.onCreate(t, "value");
    reset();
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/30 text-blue-100 text-[0.72rem] font-semibold transition-colors"
      >
        <Plus size={13} />
        Write a new belief
      </button>
    );
  }

  return (
    <div className="rounded-xl bg-white/[0.04] border border-blue-400/30 px-3 py-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-blue-200/85">
          New belief
        </span>
        <button
          onClick={reset}
          className="p-1 rounded-md hover:bg-white/8 text-white/50 hover:text-white/90 transition-colors"
          aria-label="Cancel"
        >
          <X size={12} />
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        rows={2}
        maxLength={140}
        placeholder="A principle that should guide your AI. e.g. 'Legacy tools are friction.'"
        className="w-full bg-black/30 border border-white/15 rounded-md px-2.5 py-2 text-[0.78rem] text-white/95 leading-snug placeholder:text-white/30 focus:outline-none focus:border-blue-300/40 resize-none"
      />

      <div className="pt-0.5">
        <button
          onClick={submit}
          disabled={!text.trim() || submitting}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border bg-blue-500/22 hover:bg-blue-500/32 border-blue-400/40 text-blue-100 text-[0.7rem] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Save belief
        </button>
      </div>

      <p className="text-[0.6rem] text-white/40 leading-relaxed">
        Lands as <span className="text-white/65">active</span>. We'll auto-suggest 2–3 starter rules.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * BeliefCard — unified, collapsed-by-default row for ONE belief. Works for
 * both proposed and active beliefs; the only visual difference is a "New"
 * badge + warmer ring on proposed rows so they read as needing attention.
 *
 * Collapsed: need icon + belief text (single line, truncated) + chevron.
 * Expanded: full text, rationale, status meta, and the right action set
 * for the belief's status — Accept/Edit/Dismiss for proposed; Edit/Retire
 * + a quiet "+ Propose rules" affordance for active.
 *
 * Rules themselves don't render inline here on purpose — they live on the
 * Rules tab. Keeping this card focused on the ONE belief is the whole
 * point of the simplification.
 */
function BeliefCard(p: {
  belief: Belief;
  rulesCount: number;
  pending: boolean;
  proposingRules: boolean;
  /** Start expanded. Used for the focused/selected belief at the top. */
  defaultOpen?: boolean;
  /** Re-open the card whenever this token changes (used to re-trigger
   *  the "selected" state when the user clicks a different belief
   *  neuron in 3D while the panel is already open). Pass the belief id
   *  itself; collapsing it manually still works until the next change. */
  focusToken?: string | null;
  onRatify: () => void;
  onRetire: () => void;
  onEdit: (patch: { text?: string; servesNeed?: Need }) => void;
  onProposeRules: () => void;
  onViewRules: () => void;
}) {
  const isProposed = p.belief.status === "proposed";
  const [expanded, setExpanded] = useState(p.defaultOpen ?? false);
  const [editing, setEditing] = useState(false);
  // Reset open-state whenever a new focusToken arrives (different
  // belief neuron clicked, or the same one re-clicked after collapse).
  const lastFocusTokenRef = useRef<string | null | undefined>(p.focusToken);
  useEffect(() => {
    if (p.focusToken && p.focusToken !== lastFocusTokenRef.current) {
      setExpanded(true);
      setEditing(false);
    }
    lastFocusTokenRef.current = p.focusToken;
  }, [p.focusToken]);
  const [draft, setDraft] = useState(p.belief.belief_text);
  const theme = NEED_THEME[p.belief.serves_need] || NEED_THEME.value;
  const Icon = theme.icon;

  const commitEdit = () => {
    const patch: { text?: string; servesNeed?: Need } = {};
    const trimmed = draft.trim();
    if (trimmed && trimmed !== p.belief.belief_text) patch.text = trimmed;
    if (Object.keys(patch).length) p.onEdit(patch);
    setEditing(false);
  };

  const cancelEdit = () => {
    setDraft(p.belief.belief_text);
    setEditing(false);
  };

  const ringClass = isProposed ? "border-amber-400/40" : theme.ring;
  const bgClass = isProposed ? "bg-amber-500/[0.04]" : "bg-white/[0.025]";

  return (
    <div className={`rounded-xl ${bgClass} border ${ringClass} overflow-hidden`}>
      {/* Collapsed header — single-tap to expand. Kept deliberately
          minimal: the user should be able to scan a long list. */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-white/[0.02] transition-colors"
        aria-expanded={expanded}
      >
        <Icon size={12} className={`shrink-0 ${theme.chip.split(" ").find((c) => c.startsWith("text-")) || "text-white/70"}`} />
        <span className="flex-1 min-w-0 text-[0.76rem] text-white/90 leading-snug truncate">
          {p.belief.belief_text}
        </span>
        {isProposed && (
          <span className="shrink-0 text-[0.55rem] uppercase tracking-[0.14em] font-semibold text-amber-200 bg-amber-500/15 border border-amber-400/30 rounded-sm px-1.5 py-0.5">
            New
          </span>
        )}
        <ChevronDown
          size={13}
          className={`shrink-0 text-white/40 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {/* Expanded body — focus on this ONE belief. */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-white/5">
          {editing ? (
            <div className="space-y-2 pt-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                rows={3}
                maxLength={140}
                className="w-full bg-black/30 border border-white/15 rounded-md px-2.5 py-2 text-[0.78rem] text-white/95 leading-snug focus:outline-none focus:border-blue-300/40 resize-none"
              />
              <div className="flex items-center gap-1.5 pt-0.5">
                <button
                  onClick={commitEdit}
                  className="flex-1 px-2 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-200 text-[0.7rem] font-medium transition-colors"
                >
                  Save changes
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/55 text-[0.7rem] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="pt-2 text-[0.82rem] text-white/95 leading-relaxed">
                {p.belief.belief_text}
              </p>

              {p.belief.rationale && (
                <p className="text-[0.68rem] text-white/55 leading-relaxed italic">
                  {p.belief.rationale}
                </p>
              )}

              {(!isProposed && p.rulesCount > 0) || p.belief.invocation_count > 0 ? (
                <div className="flex items-center gap-2 text-[0.62rem] text-white/45">
                  {!isProposed && p.rulesCount > 0 && (
                    <button
                      onClick={p.onViewRules}
                      className="hover:text-white/80 underline-offset-2 hover:underline transition-colors"
                    >
                      {p.rulesCount} rule{p.rulesCount === 1 ? "" : "s"}
                    </button>
                  )}
                  {p.belief.invocation_count > 0 && (
                    <span>used {p.belief.invocation_count}×</span>
                  )}
                </div>
              ) : null}

              {/* Action row — different per status. Accept is the big
                  primary action when proposed; for active beliefs the
                  emphasis shifts to Edit. */}
              {isProposed ? (
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    onClick={p.onRatify}
                    disabled={p.pending}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-200 text-[0.72rem] font-semibold transition-colors disabled:opacity-50"
                  >
                    {p.pending ? <Loader2 size={11} className="animate-spin" /> : <Check size={12} />}
                    Accept
                  </button>
                  <button
                    onClick={() => setEditing(true)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 hover:text-white/95 text-[0.68rem] transition-colors"
                  >
                    <Pencil size={10} /> Edit
                  </button>
                  <button
                    onClick={p.onRetire}
                    disabled={p.pending}
                    className="px-2 py-1.5 rounded-md bg-white/5 hover:bg-rose-500/15 text-white/65 hover:text-rose-200 transition-colors disabled:opacity-50"
                    aria-label="Dismiss"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    onClick={() => setEditing(true)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 hover:text-white text-[0.7rem] font-medium transition-colors"
                  >
                    <Pencil size={11} /> Edit
                  </button>
                  <button
                    onClick={p.onProposeRules}
                    disabled={p.proposingRules}
                    className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-blue-500/12 hover:bg-blue-500/22 border border-blue-400/25 text-blue-200 text-[0.65rem] transition-colors disabled:opacity-50"
                  >
                    {p.proposingRules ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Plus size={10} />
                    )}
                    Rules
                  </button>
                  <button
                    onClick={p.onRetire}
                    className="px-2 py-1.5 rounded-md bg-white/5 hover:bg-rose-500/15 text-white/65 hover:text-rose-200 transition-colors"
                    aria-label="Retire"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RuleRow(p: {
  rule: Rule;
  pending: boolean;
  proposed?: boolean;
  onRatify: () => void;
  onRetire: () => void;
  onEdit: (patch: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [trigger, setTrigger] = useState(p.rule.trigger_text);
  const [action, setAction] = useState(p.rule.action_text);

  const commit = () => {
    const patch: Record<string, unknown> = {};
    if (trigger.trim() && trigger.trim() !== p.rule.trigger_text) patch.trigger_text = trigger.trim();
    if (action.trim() && action.trim() !== p.rule.action_text) patch.action_text = action.trim();
    if (Object.keys(patch).length) p.onEdit(patch);
    setEditing(false);
  };

  return (
    <div className="ml-3 px-2 py-1.5">
      {editing ? (
        <div className="space-y-1.5">
          <input
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            placeholder="If…"
            className="w-full bg-black/30 border border-white/15 rounded-md px-2 py-1 text-[0.7rem] text-white/90 focus:outline-none focus:border-white/30"
          />
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="Then…"
            className="w-full bg-black/30 border border-white/15 rounded-md px-2 py-1 text-[0.7rem] text-white/90 focus:outline-none focus:border-white/30"
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={commit}
              className="flex-1 px-2 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-200 text-[0.65rem] font-medium transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => {
                setTrigger(p.rule.trigger_text);
                setAction(p.rule.action_text);
                setEditing(false);
              }}
              className="px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/55 text-[0.65rem] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-[0.7rem] text-white/85 leading-snug">
            <span className="text-blue-300/85 font-semibold">If</span> {p.rule.trigger_text}{" "}
            <span className="text-blue-300/85 font-semibold">then</span> {p.rule.action_text}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5 text-[0.6rem] text-white/40">
            {p.proposed ? (
              <>
                <button
                  onClick={p.onRatify}
                  disabled={p.pending}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-200 text-[0.6rem] font-medium transition-colors disabled:opacity-50"
                >
                  {p.pending ? <Loader2 size={9} className="animate-spin" /> : <Check size={9} />}
                  Accept rule
                </button>
                <button
                  onClick={() => setEditing(true)}
                  className="px-1.5 py-0.5 rounded-md hover:bg-white/8 text-white/55 hover:text-white/90 transition-colors"
                  aria-label="Edit rule"
                >
                  <Pencil size={9} />
                </button>
                <button
                  onClick={p.onRetire}
                  className="px-1.5 py-0.5 rounded-md hover:bg-rose-500/15 text-white/55 hover:text-rose-200 transition-colors"
                  aria-label="Dismiss rule"
                >
                  <Trash2 size={9} />
                </button>
              </>
            ) : (
              <>
                {p.rule.invocation_count > 0 && (
                  <span>fired {p.rule.invocation_count}×</span>
                )}
                <button
                  onClick={() => setEditing(true)}
                  className="ml-auto px-1.5 py-0.5 rounded-md hover:bg-white/8 text-white/55 hover:text-white/90 transition-colors"
                  aria-label="Edit rule"
                >
                  <Pencil size={9} />
                </button>
                <button
                  onClick={p.onRetire}
                  className="px-1.5 py-0.5 rounded-md hover:bg-rose-500/15 text-white/55 hover:text-rose-200 transition-colors"
                  aria-label="Retire rule"
                >
                  <Trash2 size={9} />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rules tab — flat view of all rules sorted by status, then priority
// ---------------------------------------------------------------------------

function RulesTab(p: {
  rules: Rule[];
  beliefsById: Map<string, Belief>;
  pendingIds: Set<string>;
  onRatify: (id: string) => void;
  onRetire: (id: string) => void;
  onEdit: (id: string, patch: Record<string, unknown>) => void;
}) {
  const visible = p.rules.filter((r) => r.status !== "retired");
  if (!visible.length) {
    return (
      <p className="text-[0.7rem] text-white/40 leading-relaxed pt-4">
        No rules yet. Ratify a belief to auto-propose 2-3 rules.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {visible.map((r) => {
        const belief = p.beliefsById.get(r.belief_id);
        const theme = belief ? NEED_THEME[belief.serves_need] || NEED_THEME.value : NEED_THEME.value;
        return (
          <div
            key={r.id}
            className={`rounded-lg bg-white/[0.025] border ${
              r.status === "proposed" ? "border-amber-400/35" : theme.ring
            } px-3 py-2`}
          >
            {belief ? (
              <p className="text-[0.62rem] text-white/40 mb-1 truncate">
                <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${theme.dot}`} />
                {belief.belief_text}
              </p>
            ) : null}
            <RuleRow
              rule={r}
              pending={p.pendingIds.has(r.id)}
              proposed={r.status === "proposed"}
              onRatify={() => p.onRatify(r.id)}
              onRetire={() => p.onRetire(r.id)}
              onEdit={(patch) => p.onEdit(r.id, patch)}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Why log tab — recent attributions with three-state feedback
// ---------------------------------------------------------------------------

function WhyLogTab(p: {
  attributions: Attribution[];
  pendingIds: Set<string>;
  onFeedback: (
    id: string,
    payload: {
      action: "good" | "bad";
      ruleWasBad?: boolean;
      beliefWasBad?: boolean;
      note?: string;
    },
  ) => void;
}) {
  if (!p.attributions.length) {
    return (
      <p className="text-[0.7rem] text-white/40 leading-relaxed pt-4">
        No rule applications yet. The log fills up as ratified rules fire on real chats.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {p.attributions.map((a) => (
        <AttributionRow
          key={a.id}
          attribution={a}
          pending={p.pendingIds.has(a.id)}
          onFeedback={(payload) => p.onFeedback(a.id, payload)}
        />
      ))}
    </div>
  );
}

function AttributionRow(p: {
  attribution: Attribution;
  pending: boolean;
  onFeedback: (payload: {
    action: "good" | "bad";
    ruleWasBad?: boolean;
    beliefWasBad?: boolean;
    note?: string;
  }) => void;
}) {
  const [showRepair, setShowRepair] = useState(false);
  const a = p.attribution;
  const theme = a.serves_need ? NEED_THEME[a.serves_need] || NEED_THEME.value : NEED_THEME.value;
  const ts = new Date(a.created_at);
  const tsLabel = `${ts.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${ts.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;

  const alreadyFedback = a.user_feedback != null;

  return (
    <div className="rounded-lg bg-white/[0.025] border border-white/8 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className={`text-[0.6rem] flex items-center gap-1 ${theme.chip} px-1.5 py-0.5 border rounded-md`}>
          <span className={`w-1 h-1 rounded-full ${theme.dot}`} />
          {a.serves_need || "—"}
        </div>
        <span className="text-[0.6rem] text-white/35">{tsLabel}</span>
      </div>

      {a.belief_snapshot && (
        <p className="text-[0.7rem] text-white/85 leading-snug">{a.belief_snapshot}</p>
      )}
      {a.rule_snapshot && (
        <p className="mt-1 text-[0.65rem] text-white/55 leading-snug italic">
          {a.rule_snapshot}
        </p>
      )}
      {a.reason && (
        <p className="mt-1.5 text-[0.65rem] text-white/65 leading-snug">"{a.reason}"</p>
      )}

      {!alreadyFedback && !showRepair && (
        <div className="mt-2 flex items-center gap-1.5">
          <button
            onClick={() => p.onFeedback({ action: "good" })}
            disabled={p.pending}
            className="flex-1 px-2 py-1 rounded-md bg-emerald-500/12 hover:bg-emerald-500/22 border border-emerald-400/25 text-emerald-200 text-[0.65rem] transition-colors disabled:opacity-50"
          >
            Good call
          </button>
          <button
            onClick={() => setShowRepair(true)}
            className="flex-1 px-2 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-400/25 text-rose-200 text-[0.65rem] transition-colors"
          >
            Off the mark
          </button>
        </div>
      )}

      {!alreadyFedback && showRepair && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[0.62rem] text-white/55">What was wrong?</p>
          <div className="space-y-1">
            <button
              onClick={() => {
                p.onFeedback({ action: "bad", ruleWasBad: true });
                setShowRepair(false);
              }}
              disabled={p.pending}
              className="w-full text-left px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/85 text-[0.65rem] transition-colors disabled:opacity-50"
            >
              The <span className="text-amber-200 font-medium">rule</span> doesn't fit this case
            </button>
            <button
              onClick={() => {
                p.onFeedback({ action: "bad", beliefWasBad: true });
                setShowRepair(false);
              }}
              disabled={p.pending}
              className="w-full text-left px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/85 text-[0.65rem] transition-colors disabled:opacity-50"
            >
              The <span className="text-rose-200 font-medium">belief</span> itself is off
            </button>
            <button
              onClick={() => {
                p.onFeedback({ action: "bad" });
                setShowRepair(false);
              }}
              disabled={p.pending}
              className="w-full text-left px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/85 text-[0.65rem] transition-colors disabled:opacity-50"
            >
              Both are fine — it was just a <span className="text-white/65">generation miss</span>
            </button>
          </div>
        </div>
      )}

      {alreadyFedback && (
        <p className="mt-2 text-[0.62rem] text-white/40">
          You marked this <span className="text-white/65">{a.user_feedback}</span>
          {a.user_feedback === "bad" && (a.rule_was_bad || a.belief_was_bad) && (
            <>
              {" "}— blamed the {a.rule_was_bad ? "rule" : "belief"}.
            </>
          )}
        </p>
      )}
    </div>
  );
}
