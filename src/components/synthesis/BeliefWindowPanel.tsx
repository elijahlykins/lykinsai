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
};

export default function BeliefWindowPanel({ open, onClose, initialComposerOpen }: BeliefWindowPanelProps) {
  const [data, setData] = useState<BeliefsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [activeTab, setActiveTab] = useState<"beliefs" | "rules" | "log">("beliefs");
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

  const loadData = useMemo(
    () => async () => {
      setLoading(true);
      const next = await fetchBeliefs();
      if (next) {
        setData(next);
        lastLoadedAt.current = Date.now();
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

  const promoteBeliefs = async () => {
    if (promoting) return;
    setPromoting(true);
    await postJson("/api/beliefs/promote");
    await loadData();
    setPromoting(false);
  };

  const ratifyBelief = async (id: string) => {
    markPending(id, true);
    await postJson(`/api/beliefs/${id}/ratify`);
    await loadData();
    markPending(id, false);
  };

  const retireBelief = async (id: string) => {
    markPending(id, true);
    await postJson(`/api/beliefs/${id}/retire`);
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
    await patchJson(`/api/beliefs/${id}`, body);
    await loadData();
    markPending(id, false);
  };

  const createBelief = async (text: string, servesNeed: Need) => {
    const tempId = `__create_${Date.now()}`;
    markPending(tempId, true);
    await postJson("/api/beliefs/manual", { text, servesNeed });
    await loadData();
    markPending(tempId, false);
  };

  const proposeMoreRules = async (id: string) => {
    markPending(`rules-${id}`, true);
    await postJson(`/api/beliefs/${id}/propose-rules`);
    await loadData();
    markPending(`rules-${id}`, false);
  };

  const ratifyRule = async (id: string) => {
    markPending(id, true);
    await postJson(`/api/rules/${id}/ratify`);
    await loadData();
    markPending(id, false);
  };

  const retireRule = async (id: string) => {
    markPending(id, true);
    await postJson(`/api/rules/${id}/retire`);
    await loadData();
    markPending(id, false);
  };

  const editRule = async (id: string, patch: Record<string, unknown>) => {
    markPending(id, true);
    await patchJson(`/api/rules/${id}`, patch);
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
    await postJson(`/api/applied/${id}/feedback`, payload);
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
          </header>

          {/* Sub-tabs */}
          <div className="px-3 pt-3 pb-2 flex items-center gap-1 border-b border-white/6">
            {(
              [
                { id: "beliefs" as const, label: "Beliefs", count: activeBeliefs.length + proposedBeliefs.length },
                { id: "rules" as const, label: "Rules", count: rules.filter((r) => r.status !== "retired").length },
                { id: "log" as const, label: "Why log", count: attributions.length },
              ]
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 px-2.5 py-1.5 text-[0.7rem] font-medium rounded-md transition-colors ${
                  activeTab === tab.id
                    ? "bg-white/10 text-white"
                    : "text-white/55 hover:text-white/85 hover:bg-white/5"
                }`}
              >
                {tab.label}
                <span className="ml-1.5 text-white/40 tabular-nums">{tab.count}</span>
              </button>
            ))}
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-hide">
            {loading && !data && (
              <div className="flex items-center justify-center py-16 text-white/45 text-xs">
                <Loader2 size={14} className="animate-spin mr-2" />
                Loading…
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
                onPromote={promoteBeliefs}
                onCreate={createBelief}
                onRatify={ratifyBelief}
                onRetire={retireBelief}
                onEdit={editBelief}
                onProposeRules={proposeMoreRules}
                onRatifyRule={ratifyRule}
                onRetireRule={retireRule}
                onEditRule={editRule}
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
// Beliefs tab — proposed cards on top, then active beliefs with their rules
// ---------------------------------------------------------------------------

function BeliefsTab(p: {
  proposed: Belief[];
  active: Belief[];
  rulesByBelief: Map<string, Rule[]>;
  pendingIds: Set<string>;
  promoting: boolean;
  composerOpenToken: number;
  onPromote: () => void;
  onCreate: (text: string, servesNeed: Need) => void | Promise<void>;
  onRatify: (id: string) => void;
  onRetire: (id: string) => void;
  onEdit: (id: string, patch: { text?: string; servesNeed?: Need }) => void;
  onProposeRules: (beliefId: string) => void;
  onRatifyRule: (id: string) => void;
  onRetireRule: (id: string) => void;
  onEditRule: (id: string, patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Manual composer — primary write-in path. Lives at the very top so
          users can author principles directly without waiting for the LLM
          to promote candidates. */}
      <NewBeliefComposer onCreate={p.onCreate} openToken={p.composerOpenToken} />

      {/* Promotion CTA — secondary, smaller. The AI looks for patterns in
          your facts; the composer above is the explicit way to declare one. */}
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

      {/* Proposed section */}
      {p.proposed.length > 0 && (
        <section>
          <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/45 mb-2">
            Proposed
          </h3>
          <div className="space-y-2">
            {p.proposed.map((b) => (
              <ProposedBeliefCard
                key={b.id}
                belief={b}
                pending={p.pendingIds.has(b.id)}
                onRatify={() => p.onRatify(b.id)}
                onRetire={() => p.onRetire(b.id)}
                onEdit={(patch) => p.onEdit(b.id, patch)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Active section */}
      <section>
        <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/45 mb-2">
          Active
        </h3>
        {p.active.length === 0 ? (
          <p className="text-[0.7rem] text-white/40 leading-relaxed">
            No ratified beliefs yet. Write one above, or let the AI{" "}
            <span className="text-white/65">find patterns from your facts</span> and accept the ones that ring true.
          </p>
        ) : (
          <div className="space-y-3">
            {p.active.map((b) => (
              <ActiveBeliefCard
                key={b.id}
                belief={b}
                rules={p.rulesByBelief.get(b.id) || []}
                pendingIds={p.pendingIds}
                onRetire={() => p.onRetire(b.id)}
                onEdit={(patch) => p.onEdit(b.id, patch)}
                onProposeRules={() => p.onProposeRules(b.id)}
                onRatifyRule={p.onRatifyRule}
                onRetireRule={p.onRetireRule}
                onEditRule={p.onEditRule}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NeedSelect — 4-button row for picking which need a belief serves. Reused
// by the manual composer + the inline edit flows so the UI is consistent
// everywhere a user assigns or re-assigns a need.
// ---------------------------------------------------------------------------

function NeedSelect(p: {
  value: Need | null;
  onChange: (v: Need) => void;
  size?: "sm" | "md";
}) {
  const compact = p.size === "sm";
  const NEEDS_ORDER: Need[] = ["live", "love", "value", "variety"];
  return (
    <div className={`grid grid-cols-4 gap-1 ${compact ? "" : "mt-1.5"}`}>
      {NEEDS_ORDER.map((need) => {
        const theme = NEED_THEME[need];
        const Icon = theme.icon;
        const selected = p.value === need;
        return (
          <button
            key={need}
            type="button"
            onClick={() => p.onChange(need)}
            className={`flex items-center justify-center gap-1 ${
              compact ? "px-1.5 py-1" : "px-2 py-1.5"
            } rounded-md border text-[0.62rem] font-medium transition-all ${
              selected
                ? `${theme.chip} ring-1 ring-white/15`
                : "bg-white/[0.025] border-white/10 text-white/55 hover:bg-white/8 hover:text-white/85"
            }`}
            aria-pressed={selected}
          >
            <Icon size={compact ? 9 : 10} />
            {theme.label}
          </button>
        );
      })}
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

function ProposedBeliefCard(p: {
  belief: Belief;
  pending: boolean;
  onRatify: () => void;
  onRetire: () => void;
  onEdit: (patch: { text?: string; servesNeed?: Need }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.belief.belief_text);
  const [needDraft, setNeedDraft] = useState<Need>(p.belief.serves_need);
  const theme = NEED_THEME[p.belief.serves_need] || NEED_THEME.value;
  const Icon = theme.icon;

  const commitEdit = () => {
    const patch: { text?: string; servesNeed?: Need } = {};
    const trimmed = draft.trim();
    if (trimmed && trimmed !== p.belief.belief_text) patch.text = trimmed;
    if (needDraft !== p.belief.serves_need) patch.servesNeed = needDraft;
    if (Object.keys(patch).length) p.onEdit(patch);
    setEditing(false);
  };

  const cancelEdit = () => {
    setDraft(p.belief.belief_text);
    setNeedDraft(p.belief.serves_need);
    setEditing(false);
  };

  return (
    <div className={`rounded-xl bg-white/[0.025] border ${theme.ring} px-3 py-2.5`}>
      <div className="flex items-start gap-2">
        <div className={`mt-0.5 rounded-md px-1.5 py-0.5 border text-[0.6rem] flex items-center gap-1 ${theme.chip}`}>
          <Icon size={10} />
          {theme.label}
        </div>
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            rows={2}
            maxLength={140}
            className="w-full bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-[0.78rem] text-white/90 leading-snug focus:outline-none focus:border-white/30 resize-none"
          />
          <NeedSelect value={needDraft} onChange={setNeedDraft} size="sm" />
          <div className="flex items-center gap-1.5">
            <button
              onClick={commitEdit}
              className="flex-1 px-2 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-200 text-[0.65rem] font-medium transition-colors"
            >
              Save
            </button>
            <button
              onClick={cancelEdit}
              className="px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/55 text-[0.65rem] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[0.78rem] text-white/90 leading-snug">{p.belief.belief_text}</p>
      )}
      {p.belief.rationale && !editing && (
        <p className="mt-1.5 text-[0.65rem] text-white/45 leading-snug italic">
          {p.belief.rationale}
        </p>
      )}
      {!editing && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            onClick={p.onRatify}
            disabled={p.pending}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-200 text-[0.7rem] font-medium transition-colors disabled:opacity-50"
          >
            {p.pending ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
            Accept
          </button>
          <button
            onClick={() => setEditing(true)}
            className="px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/65 hover:text-white/95 transition-colors"
            aria-label="Edit"
          >
            <Pencil size={11} />
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
      )}
    </div>
  );
}

function ActiveBeliefCard(p: {
  belief: Belief;
  rules: Rule[];
  pendingIds: Set<string>;
  onRetire: () => void;
  onEdit: (patch: { text?: string; servesNeed?: Need }) => void;
  onProposeRules: () => void;
  onRatifyRule: (id: string) => void;
  onRetireRule: (id: string) => void;
  onEditRule: (id: string, patch: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.belief.belief_text);
  const [needDraft, setNeedDraft] = useState<Need>(p.belief.serves_need);
  const theme = NEED_THEME[p.belief.serves_need] || NEED_THEME.value;
  const Icon = theme.icon;
  const proposedRules = p.rules.filter((r) => r.status === "proposed");
  const activeRules = p.rules.filter((r) => r.status === "active");
  const proposingRules = p.pendingIds.has(`rules-${p.belief.id}`);

  const commitEdit = () => {
    const patch: { text?: string; servesNeed?: Need } = {};
    const trimmed = draft.trim();
    if (trimmed && trimmed !== p.belief.belief_text) patch.text = trimmed;
    if (needDraft !== p.belief.serves_need) patch.servesNeed = needDraft;
    if (Object.keys(patch).length) p.onEdit(patch);
    setEditing(false);
  };

  const cancelEdit = () => {
    setDraft(p.belief.belief_text);
    setNeedDraft(p.belief.serves_need);
    setEditing(false);
  };

  return (
    <div className={`rounded-xl bg-white/[0.03] border ${theme.ring}`}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2.5 flex items-start gap-2 text-left"
      >
        <div className={`mt-0.5 rounded-md px-1.5 py-0.5 border text-[0.6rem] flex items-center gap-1 ${theme.chip}`}>
          <Icon size={10} />
          {theme.label}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[0.78rem] text-white/95 leading-snug">{p.belief.belief_text}</p>
          <p className="mt-1 text-[0.62rem] text-white/40">
            {activeRules.length} rule{activeRules.length === 1 ? "" : "s"}
            {proposedRules.length > 0 && (
              <span className="text-amber-300 font-medium"> · {proposedRules.length} pending</span>
            )}
            {p.belief.invocation_count > 0 && ` · used ${p.belief.invocation_count}×`}
          </p>
        </div>
        <ChevronDown
          size={13}
          className={`text-white/40 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                rows={2}
                maxLength={140}
                className="w-full bg-black/30 border border-white/15 rounded-md px-2 py-1.5 text-[0.78rem] text-white/90 leading-snug focus:outline-none focus:border-white/30 resize-none"
              />
              <div>
                <p className="text-[0.6rem] text-white/45 mb-1">Serves which need?</p>
                <NeedSelect value={needDraft} onChange={setNeedDraft} size="sm" />
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={commitEdit}
                  className="flex-1 px-2 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-200 text-[0.65rem] font-medium transition-colors"
                >
                  Save changes
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/55 text-[0.65rem] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setEditing((v) => !v)}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/55 hover:text-white/90 text-[0.65rem] transition-colors"
            >
              <Pencil size={10} /> Edit
            </button>
            <button
              onClick={p.onRetire}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 hover:bg-rose-500/15 text-white/55 hover:text-rose-200 text-[0.65rem] transition-colors"
            >
              <Trash2 size={10} /> Retire
            </button>
            <button
              onClick={p.onProposeRules}
              disabled={proposingRules}
              className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/30 text-blue-200 text-[0.65rem] transition-colors disabled:opacity-50"
            >
              {proposingRules ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <Plus size={10} />
              )}
              Propose rules
            </button>
          </div>

          {/* Rules sub-list */}
          {(activeRules.length > 0 || proposedRules.length > 0) && (
            <div className="space-y-1.5 pl-1 border-l border-white/8">
              {proposedRules.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  pending={p.pendingIds.has(r.id)}
                  proposed
                  onRatify={() => p.onRatifyRule(r.id)}
                  onRetire={() => p.onRetireRule(r.id)}
                  onEdit={(patch) => p.onEditRule(r.id, patch)}
                />
              ))}
              {activeRules.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  pending={p.pendingIds.has(r.id)}
                  onRatify={() => p.onRatifyRule(r.id)}
                  onRetire={() => p.onRetireRule(r.id)}
                  onEdit={(patch) => p.onEditRule(r.id, patch)}
                />
              ))}
            </div>
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
