// /projects — management surface for the user's synthesis-layer projects
// (`lykn_projects` + `lykn_project_neurons`). Same rows the MCP tools
// (lykn_listProjects / lykn_getContextBlock) serve to outside AI clients.
//
// Each project opens as a popup:
//   • action bar up top — add from vault, add neurons, AI-focus toggle,
//     activate/deactivate (status active ↔ archived)
//   • two charts — member composition + AI pushes per week (usage)
//   • recent updates (AI push history), members with remove, delete.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
} from "recharts";
import {
  ArrowDownToLine,
  Brain,
  Crosshair,
  FolderKanban,
  GitBranch,
  Lightbulb,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  addNeuronsToProject,
  createUserProject,
  deleteUserProject,
  editProjectStateUpdate,
  getActiveProjectId,
  listProjectPushEvents,
  listProjectStateUpdates,
  listUserProjects,
  removeNeuronFromProject,
  setActiveProjectId,
  setUserProjectStatus,
} from "@/lib/userProjects";
import { fetchVaultNotesForPicker } from "@/lib/vault/fetchVaultNotesForPicker";
import { fetchSynthesisNeuronsForPicker } from "@/lib/synthesis/fetchSynthesisNeuronsForPicker";
import { PROJECTS_CHANGED_EVENT } from "@/lib/synthesis/projectLiveSync";

function relativeTime(ts) {
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

const KIND_META = {
  vault: { title: "Vault items", icon: Plug, color: "#3b82f6" },
  concept: { title: "Concepts", icon: Lightbulb, color: "#a855f7" },
  belief: { title: "Beliefs", icon: Brain, color: "#22c55e" },
  fact: { title: "Facts", icon: Sparkles, color: "#f59e0b" },
  rule: { title: "Rules", icon: GitBranch, color: "#06b6d4" },
  other: { title: "Other", icon: FolderKanban, color: "#94a3b8" },
};

function kindOf(member) {
  if (member.kind && KIND_META[member.kind]) return member.kind;
  return "other";
}

function splitMembers(members) {
  const groups = { vault: [], concept: [], belief: [], fact: [], rule: [], other: [] };
  for (const m of members) groups[kindOf(m)].push(m);
  return groups;
}

function SectionLabel({ children }) {
  return (
    <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/40 dark:text-white/40">
      {children}
    </div>
  );
}

// One AI-pushed state card. Pressing it opens an inline editor; saving
// supersedes the AI's row with a user-attributed correction.
function UpdateCard({ update, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(update.value);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(update.value);
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
      await onSave(update, value);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role={editing ? undefined : "button"}
      tabIndex={editing ? undefined : 0}
      onClick={editing ? undefined : startEdit}
      onKeyDown={
        editing
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
          : "border-black/[0.06] dark:border-white/[0.07] bg-black/[0.02] dark:bg-white/[0.02] cursor-pointer hover:border-blue-500/25 hover:bg-blue-500/[0.04]"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-[0.6875rem] font-medium text-black/70 dark:text-white/75 truncate">
          {update.stateKey}
        </span>
        <span className="flex-shrink-0 ml-auto text-[0.625rem] text-black/35 dark:text-white/35">
          {update.setByClient || "unknown client"} · {relativeTime(update.setAt)}
        </span>
        {!editing && (
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
            <span className="text-[0.625rem] text-black/30 dark:text-white/30">
              {draft.trim().length}/2000 · saved as your correction
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

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-800 px-2 py-1 text-[0.6875rem] text-black/75 dark:text-white/80 shadow-md">
      {label}: <span className="font-semibold">{payload[0].value}</span>
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

function VaultPicker({ userId, existingNodeIds, onAdd, adding }) {
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

function NeuronPicker({ userId, existingNodeIds, onAdd, adding }) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const { data, isLoading } = useQuery({
    queryKey: ["synthesis_neurons_picker", userId || "guest"],
    queryFn: () => fetchSynthesisNeuronsForPicker(userId),
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  // Every neuron the user has, flattened across kinds — same source the
  // Model Builder knowledge picker uses.
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
function CompositionChart({ members }) {
  const groups = splitMembers(members);
  const data = Object.entries(KIND_META)
    .map(([key, meta]) => ({ name: meta.title, count: groups[key].length, color: meta.color }))
    .filter((d) => d.count > 0);

  if (data.length === 0) {
    return (
      <p className="text-xs text-black/35 dark:text-white/35 h-28 flex items-center justify-center">
        Nothing inside yet.
      </p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={112}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "currentColor", opacity: 0.45 }}
        />
        <YAxis hide />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(59,130,246,0.06)" }} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={28}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function ActivityChart({ pushEvents }) {
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
      <BarChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 9, fill: "currentColor", opacity: 0.45 }}
        />
        <YAxis hide />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(59,130,246,0.06)" }} />
        <Bar dataKey="count" fill="#3b82f6" fillOpacity={0.85} radius={[4, 4, 0, 0]} maxBarSize={24} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Project popup.
// ---------------------------------------------------------------------------
function ProjectDialog({ project, userId, isFocus, onClose, onChanged }) {
  const [picker, setPicker] = useState(null); // null | "vault" | "neurons"
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: updates = [], isLoading: updatesLoading } = useQuery({
    queryKey: ["lykn_project_updates", userId || "guest", project.id],
    queryFn: () => listProjectStateUpdates(userId, project.id),
    staleTime: 30 * 1000,
  });

  const { data: pushEvents = [] } = useQuery({
    queryKey: ["lykn_project_pushes", userId || "guest", project.id],
    queryFn: () => listProjectPushEvents(userId, project.id),
    staleTime: 30 * 1000,
  });

  const groups = splitMembers(project.members);
  const existingNodeIds = useMemo(
    () => new Set(project.members.map((m) => m.nodeId)),
    [project.members],
  );
  const isActive = project.status === "active";

  const handleAdd = async (member) => {
    setAdding(true);
    try {
      await addNeuronsToProject(userId, project.id, [member]);
      onChanged();
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveMember = async (nodeId) => {
    await removeNeuronFromProject(userId, project.id, nodeId);
    onChanged();
  };

  const handleEditUpdate = async (update, newValue) => {
    await editProjectStateUpdate(userId, project.id, update, newValue);
    onChanged();
  };

  const handleToggleStatus = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setUserProjectStatus(userId, project.id, isActive ? "archived" : "active");
      // Deactivating the AI-focus project also clears the focus pointer —
      // archived projects shouldn't be what new conversations pick up.
      if (isActive && isFocus) await setActiveProjectId(userId, null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleToggleFocus = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setActiveProjectId(userId, isFocus ? null : project.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    await deleteUserProject(userId, project.id);
    onChanged();
    onClose();
  };

  const actionBtn = (activeState) =>
    `flex items-center gap-1.5 text-[0.6875rem] px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
      activeState
        ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
        : "bg-black/[0.04] dark:bg-white/[0.06] text-black/65 dark:text-white/70 hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-blue-400"
    }`;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl rounded-2xl border-black/10 dark:border-white/10 p-0 gap-0 overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-center gap-2 pr-8">
            <FolderKanban className="w-4 h-4 flex-shrink-0 text-black/50 dark:text-white/50" />
            <DialogTitle className="text-base font-semibold text-black/90 dark:text-white truncate">
              {project.name}
            </DialogTitle>
            <span
              className={`text-[0.625rem] px-1.5 py-0.5 rounded-full ${
                isActive
                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                  : "bg-black/[0.06] dark:bg-white/[0.08] text-black/50 dark:text-white/50"
              }`}
            >
              {isActive ? "Active" : "Deactivated"}
            </span>
            {isFocus && (
              <span className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                AI focus
              </span>
            )}
          </div>
          <DialogDescription className="text-xs text-black/45 dark:text-white/50 mt-1">
            {project.description || "No description."}{" "}
            <span className="text-black/35 dark:text-white/35">
              · used {relativeTime(project.lastActiveAt)} · {project.pushCount} AI push
              {project.pushCount === 1 ? "" : "es"} · {project.members.length} item
              {project.members.length === 1 ? "" : "s"}
            </span>
          </DialogDescription>

          {/* Action bar — add things + activation controls, up top */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPicker(picker === "vault" ? null : "vault")}
              className={actionBtn(picker === "vault")}
            >
              <Plug className="w-3 h-3" />
              Add from vault
            </button>
            <button
              type="button"
              onClick={() => setPicker(picker === "neurons" ? null : "neurons")}
              className={actionBtn(picker === "neurons")}
            >
              <Plus className="w-3 h-3" />
              Add neurons
            </button>
            <div className="flex-1" />
            <button
              type="button"
              disabled={busy || !isActive}
              onClick={handleToggleFocus}
              title={isFocus ? "Stop pointing AI clients at this project" : "Make this the project AI clients pick up first"}
              className={actionBtn(isFocus)}
            >
              <Crosshair className="w-3 h-3" />
              {isFocus ? "AI focus ✓" : "Set AI focus"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleToggleStatus}
              title={isActive ? "Archive — hides it from AI context" : "Reactivate this project"}
              className={actionBtn(false)}
            >
              {isActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {isActive ? "Deactivate" : "Activate"}
            </button>
          </div>

          {picker === "vault" && (
            <VaultPicker
              userId={userId}
              existingNodeIds={existingNodeIds}
              onAdd={handleAdd}
              adding={adding}
            />
          )}
          {picker === "neurons" && (
            <NeuronPicker
              userId={userId}
              existingNodeIds={existingNodeIds}
              onAdd={handleAdd}
              adding={adding}
            />
          )}
        </div>

        {/* Body */}
        <div className="px-5 pb-4 max-h-[56vh] overflow-y-auto scrollbar-hide border-t border-black/5 dark:border-white/5">
          {/* Charts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.07] bg-black/[0.02] dark:bg-white/[0.02] p-3">
              <SectionLabel>What's inside</SectionLabel>
              <div className="mt-1 text-black/70 dark:text-white/70">
                <CompositionChart members={project.members} />
              </div>
            </div>
            <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.07] bg-black/[0.02] dark:bg-white/[0.02] p-3">
              <SectionLabel>AI pushes · last 8 weeks</SectionLabel>
              <div className="mt-1 text-black/70 dark:text-white/70">
                <ActivityChart pushEvents={pushEvents} />
              </div>
            </div>
          </div>

          {/* Recent updates */}
          <div className="mt-5 flex items-center gap-2">
            <ArrowDownToLine className="w-3.5 h-3.5 text-black/40 dark:text-white/40" />
            <SectionLabel>Recent updates</SectionLabel>
          </div>
          {updatesLoading ? (
            <p className="text-xs text-black/40 dark:text-white/40 mt-2">Loading updates…</p>
          ) : updates.length === 0 ? (
            <p className="text-xs text-black/40 dark:text-white/40 mt-2">
              No updates yet. Connected AI clients push their working memory here as you work.
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-1.5">
              {updates.map((u) => (
                <UpdateCard key={u.id} update={u} onSave={handleEditUpdate} />
              ))}
            </div>
          )}

          {/* Members */}
          <div className="mt-5">
            {project.members.length === 0 ? (
              <p className="text-xs text-black/40 dark:text-white/40">
                Nothing saved into this project yet — add vault items or neurons above.
              </p>
            ) : (
              Object.entries(KIND_META).map(([key, { title, icon: Icon }]) => {
                const items = groups[key];
                if (items.length === 0) return null;
                return (
                  <div key={key} className="mb-3">
                    <SectionLabel>{title}</SectionLabel>
                    <div className="mt-1 flex flex-col gap-0.5">
                      {items.map((m) => (
                        <div
                          key={m.nodeId}
                          className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-blue-500/[0.06] transition-colors"
                        >
                          <Icon className="w-3.5 h-3.5 flex-shrink-0 text-black/40 dark:text-white/40" />
                          <span className="flex-1 min-w-0 truncate text-xs text-black/70 dark:text-white/70">
                            {m.label || m.nodeId}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveMember(m.nodeId)}
                            className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-black/40 dark:text-white/40 hover:text-red-500 transition-all"
                            title="Remove from project"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-black/5 dark:border-white/5 flex justify-end">
          <button
            type="button"
            onClick={handleDelete}
            className="flex items-center gap-1.5 text-[0.6875rem] px-2 py-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Delete project
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page — project list + create form; clicking a card opens the popup.
// ---------------------------------------------------------------------------
export default function ProjectsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const queryKey = ["lykn_projects", userId || "guest"];

  const { data: projects = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => listUserProjects(userId),
    staleTime: 60 * 1000,
  });

  const { data: focusProjectId = null } = useQuery({
    queryKey: ["lykn_active_project", userId || "guest"],
    queryFn: () => getActiveProjectId(userId),
    enabled: !!userId,
    staleTime: 30 * 1000,
  });

  const [openId, setOpenId] = useState(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["lykn_project_updates"] });
    queryClient.invalidateQueries({ queryKey: ["lykn_project_pushes"] });
    queryClient.invalidateQueries({ queryKey: ["lykn_active_project", userId || "guest"] });
  };

  // Stay in sync with MCP-side project writes from connected AI clients.
  useEffect(() => {
    const onChange = () => refetch();
    window.addEventListener(PROJECTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const openProject = projects.find((p) => p.id === openId) || null;

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const created = await createUserProject(userId, { name, members: [] });
      setNewName("");
      refetch();
      if (created) setOpenId(created.id);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-transparent text-black dark:text-white">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="flex items-center gap-2.5 mb-1">
          <FolderKanban className="w-5 h-5 text-black/60 dark:text-white/60" />
          <h1 className="text-xl font-semibold text-black/90 dark:text-white tracking-tight">
            Projects
          </h1>
        </div>
        <p className="text-xs text-black/45 dark:text-white/50 mb-6">
          Your synthesis-layer projects and the vault items and concepts saved into them. Every
          connected AI client sees these too.
        </p>

        <form onSubmit={handleCreate} className="flex items-center gap-2 mb-6">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New project name"
            className="flex-1 text-xs px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 bg-white/60 dark:bg-white/[0.04] outline-none focus:border-blue-500/40 placeholder:text-black/35 dark:placeholder:text-white/35 transition-colors"
          />
          <button
            type="submit"
            disabled={!newName.trim() || creating}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Create
          </button>
        </form>

        {isLoading ? (
          <p className="text-xs text-black/40 dark:text-white/40">Loading projects…</p>
        ) : projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 px-6 py-10 text-center">
            <p className="text-sm text-black/50 dark:text-white/50">No projects yet.</p>
            <p className="text-xs text-black/40 dark:text-white/40 mt-1">
              Create one above, or cluster neurons into a project from the Synthesis Layer.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {projects.map((p) => {
              const g = splitMembers(p.members);
              const isFocus = focusProjectId === p.id;
              const isActive = p.status === "active";
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setOpenId(p.id)}
                  className={`w-full text-left rounded-2xl border px-4 py-3 transition-colors ${
                    isActive
                      ? "border-black/[0.07] dark:border-white/[0.08] bg-white/60 dark:bg-white/[0.04] hover:bg-blue-500/[0.06] hover:border-blue-500/20"
                      : "border-black/[0.05] dark:border-white/[0.05] bg-black/[0.015] dark:bg-white/[0.02] opacity-60 hover:opacity-90"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-black/85 dark:text-white/90 truncate">
                      {p.name}
                    </span>
                    {isFocus && (
                      <span className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                        AI focus
                      </span>
                    )}
                    {!isActive && (
                      <span className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-black/50 dark:text-white/50">
                        Deactivated
                      </span>
                    )}
                  </div>
                  {p.description ? (
                    <p className="text-xs text-black/45 dark:text-white/45 mt-0.5 truncate">
                      {p.description}
                    </p>
                  ) : null}
                  <p className="text-[0.6875rem] text-black/40 dark:text-white/40 mt-1">
                    {g.vault.length} vault item{g.vault.length === 1 ? "" : "s"} ·{" "}
                    {g.concept.length} concept{g.concept.length === 1 ? "" : "s"} ·{" "}
                    {p.pushCount} AI push{p.pushCount === 1 ? "" : "es"} · used{" "}
                    {relativeTime(p.lastActiveAt)}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {openProject && (
        <ProjectDialog
          project={openProject}
          userId={userId}
          isFocus={focusProjectId === openProject.id}
          onClose={() => setOpenId(null)}
          onChanged={refetch}
        />
      )}
    </div>
  );
}
