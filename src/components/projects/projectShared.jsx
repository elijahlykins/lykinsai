// Shared building blocks for the Projects surfaces (the /projects list and the
// /projects/:id detail page). These were originally inline in ProjectsPage;
// they're hoisted here so the full-page project dashboard can reuse the exact
// same metadata, charts, pickers, and AI-update cards without duplicating them.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  PieChart,
  Pie,
} from "recharts";
import {
  Brain,
  FolderKanban,
  GitBranch,
  Lightbulb,
  Pencil,
  Plug,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { fetchVaultNotesForPicker } from "@/lib/vault/fetchVaultNotesForPicker";
import { fetchSynthesisNeuronsForPicker } from "@/lib/synthesis/fetchSynthesisNeuronsForPicker";
import { useIsDark, chartSeries } from "@/lib/projectChartTheme";

export function relativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export const KIND_META = {
  vault: { title: "Vault items", icon: Plug, color: "#3b82f6" },
  concept: { title: "Concepts", icon: Lightbulb, color: "#a855f7" },
  belief: { title: "Beliefs", icon: Brain, color: "#22c55e" },
  fact: { title: "Facts", icon: Sparkles, color: "#f59e0b" },
  rule: { title: "Rules", icon: GitBranch, color: "#06b6d4" },
  other: { title: "Other", icon: FolderKanban, color: "#94a3b8" },
};

export function kindOf(member) {
  if (member.kind && KIND_META[member.kind]) return member.kind;
  return "other";
}

export function splitMembers(members) {
  const groups = { vault: [], concept: [], belief: [], fact: [], rule: [], other: [] };
  for (const m of members) groups[kindOf(m)].push(m);
  return groups;
}

export function SectionLabel({ children }) {
  return (
    <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/40 dark:text-white/40">
      {children}
    </div>
  );
}

// One AI-pushed state card. Pressing it opens an inline editor; saving
// supersedes the AI's row with a user-attributed correction.
// `canEdit` gates the editor for shared-project viewers — RLS would
// reject their write anyway (editProjectStateUpdate requires the edit
// role), so opening the editor just sets them up for a silent failure.
export function UpdateCard({ update, onSave, canEdit = true }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(update.value);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const startEdit = () => {
    if (!canEdit) return;
    setDraft(update.value);
    setSaveError(false);
    setEditing(true);
  };

  const handleSave = async () => {
    const value = draft.trim();
    if (!value || value === update.value || saving) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      // onSave resolves false when the supersede write was rejected
      // (viewer role, network) — keep the editor open so the user sees
      // their correction didn't land instead of silently closing.
      const ok = await onSave(update, value);
      if (ok === false) {
        setSaveError(true);
        return;
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const interactive = canEdit && !editing;

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? startEdit : undefined}
      onKeyDown={
        !interactive
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                startEdit();
              }
            }
      }
      className={`rounded-xl border px-3 py-2 transition-colors ${
        editing
          ? "border-blue-500/30 bg-blue-500/[0.04]"
          : `border-black/[0.06] dark:border-white/[0.07] bg-black/[0.02] dark:bg-white/[0.02] ${
              canEdit ? "cursor-pointer hover:border-blue-500/25 hover:bg-blue-500/[0.04]" : ""
            }`
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[0.6875rem] font-medium text-black/70 dark:text-white/75 truncate">
          {update.stateKey}
        </span>
        <span className="flex-shrink-0 ml-auto text-[0.625rem] text-black/35 dark:text-white/35">
          {update.setByClient || "unknown client"} · {relativeTime(update.setAt)}
        </span>
        {!editing && canEdit && (
          <Pencil className="w-3 h-3 flex-shrink-0 text-black/30 dark:text-white/30" />
        )}
      </div>
      {editing ? (
        <div className="mt-1.5">
          <textarea
            autoFocus
            value={draft}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSave();
            }}
            rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))}
            className="w-full text-xs leading-relaxed px-2.5 py-2 rounded-lg border border-black/10 dark:border-white/10 bg-white/70 dark:bg-zinc-900/60 text-black/80 dark:text-white/80 outline-none focus:border-blue-500/40 resize-y scrollbar-hide"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className={`text-[0.625rem] ${saveError ? "text-red-500 dark:text-red-400" : "text-black/30 dark:text-white/30"}`}>
              {saveError
                ? "Couldn't save. Please try again"
                : `${draft.trim().length}/2000 · saved as your correction`}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="text-[0.6875rem] px-2 py-1 rounded-md text-black/55 dark:text-white/55 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || !draft.trim() || draft.trim() === update.value}
                onClick={handleSave}
                className="text-[0.6875rem] px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-xs text-black/55 dark:text-white/55 mt-1 line-clamp-3 whitespace-pre-wrap break-words">
          {update.value}
        </p>
      )}
    </div>
  );
}

export function ChartTooltip({ active = false, payload = null, label = "" }) {
  if (!active || !payload?.length) return null;
  // Pie/donut slices don't pass `label`; fall back to the slice's own name.
  const name = label || payload[0]?.name || payload[0]?.payload?.name || "";
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-800 px-2 py-1 text-[0.6875rem] text-black/75 dark:text-white/80 shadow-md">
      {name}: <span className="font-semibold">{payload[0].value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pickers — searchable click-to-add lists (vault notes / synthesis neurons).
// ---------------------------------------------------------------------------
function PickerShell({ placeholder, children, query, onQuery }) {
  return (
    <div className="mt-2 rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02] p-2">
      <div className="flex items-center gap-2 px-1.5 py-1 mb-1">
        <Search className="w-3.5 h-3.5 flex-shrink-0 text-black/35 dark:text-white/35" />
        <input
          autoFocus
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent outline-none text-xs placeholder:text-black/35 dark:placeholder:text-white/35 text-black/75 dark:text-white/75"
        />
      </div>
      <div className="max-h-44 overflow-y-auto scrollbar-hide flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function PickerRow({ icon: Icon, label, meta, onClick, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full text-left flex items-center gap-2 rounded-md px-2 py-1 hover:bg-blue-500/[0.08] disabled:opacity-50 transition-colors"
    >
      <Plus className="w-3 h-3 flex-shrink-0 text-blue-500" />
      <Icon className="w-3 h-3 flex-shrink-0 text-black/40 dark:text-white/40" />
      <span className="flex-1 min-w-0 truncate text-xs text-black/70 dark:text-white/70">{label}</span>
      {meta ? (
        <span className="flex-shrink-0 text-[0.625rem] text-black/30 dark:text-white/30">{meta}</span>
      ) : null}
    </button>
  );
}

export function VaultPicker({ userId, existingNodeIds, onAdd, adding }) {
  const [query, setQuery] = useState("");
  const { data: notes = [], isLoading } = useQuery({
    queryKey: ["vault_notes_picker", userId || "guest"],
    queryFn: () => fetchVaultNotesForPicker(userId),
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes
      .filter((n) => !existingNodeIds.has(`vault_${n.id}`))
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .slice(0, 40);
  }, [notes, existingNodeIds, query]);

  return (
    <PickerShell placeholder="Search your vault…" query={query} onQuery={setQuery}>
      {isLoading ? (
        <p className="text-xs text-black/40 dark:text-white/40 px-2 py-1.5">Loading vault…</p>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-black/40 dark:text-white/40 px-2 py-1.5">
          {query ? "No matching vault items." : "Everything in your vault is already in this project."}
        </p>
      ) : (
        candidates.map((n) => (
          <PickerRow
            key={n.id}
            icon={Plug}
            label={n.title}
            meta={n.updated_at ? relativeTime(new Date(n.updated_at).getTime()) : null}
            disabled={adding}
            onClick={() =>
              onAdd({ nodeId: `vault_${n.id}`, label: n.title, kind: "vault" })
            }
          />
        ))
      )}
    </PickerShell>
  );
}

const NEURON_FILTERS = [
  { value: "all", label: "All neurons" },
  { value: "belief", label: "Beliefs" },
  { value: "fact", label: "Facts" },
  { value: "rule", label: "Rules" },
  { value: "concept", label: "Concepts" },
];

export function NeuronPicker({ userId, existingNodeIds, onAdd, adding }) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const { data, isLoading } = useQuery({
    queryKey: ["synthesis_neurons_picker", userId || "guest"],
    queryFn: () => fetchSynthesisNeuronsForPicker(userId),
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const allNeurons = useMemo(() => {
    if (!data) return [];
    return [
      ...data.beliefs.map((b) => ({ ...b, kind: "belief", nodeId: `belief_${b.id}` })),
      ...data.facts.map((f) => ({ ...f, nodeId: `fact_${f.id}` })),
      ...data.rules.map((r) => ({ ...r, nodeId: `rule_${r.id}` })),
      ...data.concepts.map((c) => ({ ...c, nodeId: `concept_${c.id}` })),
    ].filter((n) => n.label && !existingNodeIds.has(n.nodeId));
  }, [data, existingNodeIds]);

  const counts = useMemo(() => {
    const c = { all: allNeurons.length, belief: 0, fact: 0, rule: 0, concept: 0 };
    for (const n of allNeurons) if (c[n.kind] !== undefined) c[n.kind] += 1;
    return c;
  }, [allNeurons]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allNeurons
      .filter((n) => kindFilter === "all" || n.kind === kindFilter)
      .filter((n) => !q || n.label.toLowerCase().includes(q));
  }, [allNeurons, kindFilter, query]);

  return (
    <div className="mt-2 rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02] p-2">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1">
          <Search className="w-3.5 h-3.5 flex-shrink-0 text-black/35 dark:text-white/35" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your neurons…"
            className="w-full bg-transparent outline-none text-xs placeholder:text-black/35 dark:placeholder:text-white/35 text-black/75 dark:text-white/75"
          />
        </div>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="flex-shrink-0 text-[0.6875rem] px-2 py-1 rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-zinc-800 text-black/70 dark:text-white/70 outline-none focus:border-blue-500/40 cursor-pointer"
        >
          {NEURON_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label} ({counts[f.value] ?? 0})
            </option>
          ))}
        </select>
      </div>
      <div className="max-h-52 overflow-y-auto scrollbar-hide flex flex-col gap-0.5">
        {isLoading ? (
          <p className="text-xs text-black/40 dark:text-white/40 px-2 py-1.5">Loading neurons…</p>
        ) : candidates.length === 0 ? (
          <p className="text-xs text-black/40 dark:text-white/40 px-2 py-1.5">
            {query || kindFilter !== "all"
              ? "No matching neurons."
              : "All your neurons are already in this project."}
          </p>
        ) : (
          candidates.map((n) => (
            <PickerRow
              key={n.nodeId}
              icon={(KIND_META[n.kind] || KIND_META.other).icon}
              label={n.label}
              meta={n.kind}
              disabled={adding}
              onClick={() => onAdd({ nodeId: n.nodeId, label: n.label, kind: n.kind })}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts — what's inside + how often the project is used.
// ---------------------------------------------------------------------------
// A donut ("wheel") of what's inside the project. Pass a `data` array of
// `{ name, count, color }` (the project page builds it from vault file-type
// counts + synthesis-kind counts). The total sits in the hole; a compact
// legend lists each slice with its count.
export function CompositionChart({ data = [] }) {
  const slices = (data || []).filter((d) => d.count > 0);
  const total = slices.reduce((sum, d) => sum + d.count, 0);

  if (total === 0) {
    return (
      <p className="text-xs text-black/35 dark:text-white/35 h-28 flex items-center justify-center">
        Nothing inside yet.
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <div className="relative w-[100px] h-[100px] flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="count"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={28}
              outerRadius={46}
              paddingAngle={slices.length > 1 ? 2 : 0}
              stroke="none"
            >
              {slices.map((d) => (
                <Cell key={d.name} fill={d.color} fillOpacity={0.9} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-sm font-semibold leading-none text-black/80 dark:text-white/85">{total}</span>
          <span className="text-[0.5625rem] uppercase tracking-wide text-black/35 dark:text-white/35">items</span>
        </div>
      </div>
      <ul className="flex-1 min-w-0 grid grid-cols-1 gap-y-0.5 text-[0.6875rem]">
        {slices.map((d) => (
          <li key={d.name} className="flex items-center gap-1.5 min-w-0">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />
            <span className="truncate text-black/60 dark:text-white/55">{d.name}</span>
            <span className="ml-auto font-medium text-black/75 dark:text-white/75">{d.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function ActivityChart({ pushEvents }) {
  const dark = useIsDark();
  const lineColor = chartSeries(dark).line;
  const data = useMemo(() => {
    const weeks = [];
    const now = Date.now();
    for (let i = 7; i >= 0; i--) {
      const start = now - (i + 1) * WEEK_MS;
      const end = now - i * WEEK_MS;
      const count = pushEvents.filter((t) => t > start && t <= end).length;
      weeks.push({ name: i === 0 ? "now" : `${i}w`, count });
    }
    return weeks;
  }, [pushEvents]);

  if (pushEvents.length === 0) {
    return (
      <p className="text-xs text-black/35 dark:text-white/35 h-28 flex items-center justify-center">
        No AI activity yet.
      </p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={112}>
      <AreaChart data={data} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
        <defs>
          <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.28} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "currentColor", opacity: 0.45 }}
        />
        <YAxis hide allowDecimals={false} />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: lineColor, strokeOpacity: 0.25, strokeWidth: 1 }} />
        <Area
          type="monotone"
          dataKey="count"
          stroke={lineColor}
          strokeWidth={2}
          fill="url(#activityFill)"
          dot={{ r: 2.5, fill: lineColor, strokeWidth: 0 }}
          activeDot={{ r: 4, fill: lineColor, stroke: "#ffffff", strokeWidth: 1.5 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
