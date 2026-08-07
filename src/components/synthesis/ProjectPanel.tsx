import { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Atom,
  BookOpen,
  ChevronDown,
  Combine,
  Compass,
  FileText,
  FolderPlus,
  Hash,
  Loader2,
  MessageSquare,
  Network,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toUserFacingError } from "@/lib/ai/userFacingErrors";
import {
  listProjectStateUpdates,
  mergeUserProjects,
  type ProjectMergePreview,
  type UserProject,
} from "@/lib/userProjects";
import {
  PROJECTS_CHANGED_EVENT,
  type ProjectsChangedDetail,
} from "@/lib/synthesis/projectLiveSync";
import { findMorningBrief, isFreshMorningBrief } from "@/lib/morningBrief";
import MorningBriefCard from "@/components/projects/MorningBriefCard";
import { formatPushClientLabel } from "@/components/projects/projectShared";

/**
 * ProjectPanel — the right-side detail surface that opens when the
 * user clicks a project in the "By Project" filter dropdown. Mirrors
 * `NeuronPanel`'s shape (header chip, sections, scrollable body)
 * so the synthesis layer reads as one consistent panel system
 * regardless of what the user clicked.
 *
 * What it shows:
 *   - The project name + description + meta (last activity,
 *     starting AI client, member count).
 *   - "Updates" — the latest non-superseded `lykn_project_state`
 *     rows pushed by outside AI clients (Claude Desktop / Cursor /
 *     Claude Code / ChatGPT) through MCP. This is the working
 *     memory tier; the user-facing answer to "what has the AI
 *     decided about this project lately?"
 *   - "Connected neurons" — every clustered member, click-through
 *     to that neuron's NeuronPanel.
 *   - "Add neurons" — re-enters the cluster selection mode, but
 *     anchored to THIS project so newly-tapped neurons append to
 *     it instead of spawning a new one.
 */

const KIND_ICON: Record<string, LucideIcon> = {
  belief: Atom,
  concept: Sparkles,
  vault: FileText,
  perspective: BookOpen,
  grid: MessageSquare,
  tag: Hash,
  neuron: Network,
  root: Compass,
  category: Compass,
};

function kindLabel(kind: string | null): string {
  if (!kind) return "Neuron";
  if (kind === "belief") return "Belief";
  if (kind === "concept") return "Concept";
  if (kind === "vault") return "Note";
  if (kind === "perspective") return "Perspective";
  if (kind === "chat") return "Chat";
  if (kind === "tag") return "Tag";
  if (kind === "neuron") return "Fact";
  return "Neuron";
}

function formatRelative(ms: number | null): string {
  if (!ms) return "—";
  const now = Date.now();
  const diff = now - ms;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60 * 1000) return "just now";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))}m ago`;
  if (diff < day) return `${Math.floor(diff / (60 * 60 * 1000))}h ago`;
  if (diff < 2 * day) return "yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
  try {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: now - ms > 365 * day ? "numeric" : undefined,
    });
  } catch {
    return "—";
  }
}

export type ProjectPanelProps = {
  open: boolean;
  project: UserProject | null;
  userId: string | null | undefined;
  onClose: () => void;
  /** Jump to a clustered neuron by graph node id (closes this
   *  panel and opens the standard NeuronPanel for that node). */
  onSelectNode: (nodeId: string) => void;
  /** Enter cluster-selection mode anchored to this project so the
   *  user's next set of taps appends members rather than creating
   *  a new project. Wired through to the page-level
   *  `beginAddNeuronsToProject` callback. */
  onAddNeurons?: (projectId: string) => void;
  /** Spawn a brand-new neuron and queue it into THIS project's
   *  membership. Wired through to the page so the existing
   *  creation modal infrastructure can be reused; the parent
   *  also flips into project add mode for this project so the
   *  freshly-formed neuron auto-lands in the cluster selection
   *  (see `pendingFormingNodeId` watcher in SynthesisLayer). */
  onCreateNeuron?: (projectId: string) => void;
  /** Full project list, used as the merge target picker. The panel
   *  shows every other project the user has so they can fold THIS
   *  project into one of them. Pass [] to disable the merge button
   *  entirely (e.g. while projects are still loading or when the
   *  user only has one project). */
  allProjects?: UserProject[];
  /** Fired AFTER a live merge succeeds. Parent uses this to bust the
   *  React Query cache for the project list, redirect any focus /
   *  selection that was pinned on the source, and close the panel.
   *  The panel never assumes it can do those things itself because
   *  the source row + its query keys are owned by the parent. */
  onMergeComplete?: (sourceProjectId: string, targetProjectId: string) => void;
};

export default function ProjectPanel({
  open,
  project,
  userId,
  onClose: _onClose,
  onSelectNode,
  onAddNeurons,
  onCreateNeuron,
  allProjects = [],
  onMergeComplete,
}: ProjectPanelProps) {
  const queryClient = useQueryClient();
  // Local merge state. We deliberately keep ALL of this inside the
  // panel rather than lifting it to the page: the picker, the dry-run
  // preview, the inflight flag, and any error messaging are entirely
  // scoped to "is the user currently looking at this panel?" The
  // moment the panel closes (or the user picks a different project),
  // the state resets cleanly. Parent only finds out about the merge
  // through the `onMergeComplete` callback.
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [mergePreview, setMergePreview] = useState<ProjectMergePreview | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  // Two distinct inflight flags so the UI can show "previewing…" vs
  // "committing…" copy: the dry-run pass is cheap (single SELECT-only
  // SQL function) and clears in <500ms; the commit pass writes across
  // four tables and feels sluggish enough to deserve its own spinner.
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);

  // Project list to render in the picker — every project EXCEPT the
  // one we're currently viewing. Sorted by recent activity so the
  // user's working projects float to the top of the picker, mirroring
  // the page-level "By Project" dropdown's ordering. Memoised so the
  // sort doesn't re-run on every keystroke / re-render.
  const mergeCandidates = useMemo(() => {
    if (!project) return [] as UserProject[];
    return allProjects
      .filter((p) => p.id !== project.id)
      .slice()
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [allProjects, project]);

  const resetMerge = () => {
    setMergePickerOpen(false);
    setMergeTargetId(null);
    setMergePreview(null);
    setMergeError(null);
    setPreviewing(false);
    setCommitting(false);
  };

  const startPreview = async (targetId: string) => {
    if (!project || !userId) return;
    setMergeTargetId(targetId);
    setMergePreview(null);
    setMergeError(null);
    setPreviewing(true);
    try {
      const preview = await mergeUserProjects(userId, project.id, targetId, {
        dryRun: true,
      });
      setMergePreview(preview);
    } catch (err) {
      setMergeError(toUserFacingError(err));
    } finally {
      setPreviewing(false);
    }
  };

  const commitMerge = async () => {
    if (!project || !userId || !mergeTargetId) return;
    setMergeError(null);
    setCommitting(true);
    try {
      await mergeUserProjects(userId, project.id, mergeTargetId, {
        dryRun: false,
      });
      const sourceId = project.id;
      const targetId = mergeTargetId;
      resetMerge();
      onMergeComplete?.(sourceId, targetId);
    } catch (err) {
      setMergeError(toUserFacingError(err));
      setCommitting(false);
    }
  };

  // Lazily fetch the project's working-memory state. We don't
  // bundle this into `listUserProjects` because the projects
  // dropdown only needs name + member count, and pulling state
  // for every project on every dropdown render would be a lot
  // of round-trips for context that's only displayed when the
  // user actually opens a panel.
  const { data: updates = [], isLoading: updatesLoading } = useQuery({
    queryKey: ["lykn_project_state", userId || "guest", project?.id || "none"],
    queryFn: () => listProjectStateUpdates(userId, project?.id || ""),
    enabled: open && !!project?.id && !!userId,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: open ? 15_000 : false,
  });

  useEffect(() => {
    if (!open || !project?.id || !userId) return;
    const onProjectsChanged = (evt: Event) => {
      const detail = (evt as CustomEvent<ProjectsChangedDetail>).detail;
      if (detail?.userId && detail.userId !== userId) return;
      // Always refresh the projects list (create of project B while viewing A).
      queryClient.invalidateQueries({
        queryKey: ["lykn_projects", userId],
      });
      if (detail?.projectId && detail.projectId !== project.id) return;
      queryClient.invalidateQueries({
        queryKey: ["lykn_project_state", userId || "guest", project.id],
      });
    };
    window.addEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
  }, [open, project?.id, userId, queryClient]);

  const sortedMembers = useMemo(() => {
    if (!project) return [];
    // Stable, kind-grouped, alphabetical-within-kind ordering so
    // the connected-neurons list reads predictably across opens.
    const kindOrder: Record<string, number> = {
      belief: 0,
      concept: 1,
      perspective: 2,
      vault: 3,
      neuron: 4,
      grid: 5,
      tag: 6,
    };
    return [...project.members].sort((a, b) => {
      const ak = kindOrder[a.kind || "neuron"] ?? 9;
      const bk = kindOrder[b.kind || "neuron"] ?? 9;
      if (ak !== bk) return ak - bk;
      return (a.label || "").localeCompare(b.label || "");
    });
  }, [project]);

  const morningBrief = useMemo(() => findMorningBrief(updates), [updates]);
  const showMorningBrief = useMemo(
    () => isFreshMorningBrief(morningBrief),
    [morningBrief],
  );
  const displayUpdates = useMemo(
    () => (showMorningBrief ? updates.filter((u) => u.stateKey !== "morning_brief") : updates),
    [updates, showMorningBrief],
  );

  return (
    <AnimatePresence>
      {open && project ? (
        <motion.aside
          key={`project-panel-${project.id}`}
          initial={{ x: 380, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 380, opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 32 }}
          className="fixed top-0 right-0 z-[90] h-full w-[380px] max-w-[92vw] flex flex-col bg-panel backdrop-blur-xl border-l border-black/[0.08] dark:border-white/10 shadow-[0_8px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_0_60px_rgba(0,0,0,0.45)] text-black/85 dark:text-white/90"
          role="dialog"
          aria-label="Project details"
        >
          {/* Header — type chip; the page-level close chevron lives
              outside this component (z-[100], right-4) so we just
              leave room for it on the right, same as NeuronPanel. */}
          <header className="pl-5 pr-12 py-4 border-b border-black/8 dark:border-white/8 flex items-center gap-2">
            <FolderPlus size={14} className="text-black/70 dark:text-white/70" />
            <h2 className="text-[0.65rem] uppercase tracking-[0.18em] font-semibold text-black/55 dark:text-white/55">
              Project
            </h2>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 scrollbar-hide">
            {/* Name */}
            <section>
              <h3 className="text-[1rem] leading-snug text-black/95 dark:text-white/95 font-medium">
                {project.name}
              </h3>
              {project.description ? (
                <p className="text-[0.75rem] text-black/70 dark:text-white/70 leading-relaxed mt-2">
                  {project.description}
                </p>
              ) : null}
            </section>

            {/* Meta */}
            <section className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                  Last activity
                </p>
                <p className="text-[0.75rem] text-black/75 dark:text-white/75">
                  {formatRelative(project.lastActiveAt)}
                </p>
              </div>
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                  Status
                </p>
                <p className="text-[0.75rem] text-black/75 dark:text-white/75 capitalize">
                  {project.status}
                </p>
              </div>
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                  Started in
                </p>
                <p className="text-[0.75rem] text-black/75 dark:text-white/75">
                  {project.createdByClient || "—"}
                </p>
              </div>
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                  AI pushes
                </p>
                <p className="text-[0.75rem] text-black/75 dark:text-white/75">
                  {project.pushCount || 0}
                </p>
              </div>
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-1">
                  Members
                </p>
                <p className="text-[0.75rem] text-black/75 dark:text-white/75">
                  {project.members.length}
                </p>
              </div>
            </section>

            {showMorningBrief && morningBrief ? (
              <MorningBriefCard brief={morningBrief} projectName={project.name} compact />
            ) : null}

            {/* Updates — kv-cards from lykn_project_state */}
            <section>
              <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-2">
                Updates ({displayUpdates.length})
              </p>
              {updatesLoading ? (
                <div className="flex items-center gap-2 text-[0.7rem] text-black/45 dark:text-white/45 py-2">
                  <Loader2 size={11} className="animate-spin" />
                  Loading updates…
                </div>
              ) : displayUpdates.length === 0 ? (
                <p className="text-[0.7rem] text-black/40 dark:text-white/40 leading-relaxed">
                  No updates yet. When a model in LYKN chat, Claude, Cursor,
                  or any connected client records a decision about this
                  project, it lands here: working memory the whole brain
                  can read back.
                </p>
              ) : (
                <div className="space-y-2">
                  {displayUpdates.map((u) => (
                    <div
                      key={`${u.stateKey}-${u.setAt}`}
                      className="px-2.5 py-2 rounded-md bg-black/[0.03] dark:bg-white/[0.03] border border-black/8 dark:border-white/8"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[0.65rem] font-medium text-black/85 dark:text-white/85 truncate">
                          {u.stateKey}
                        </span>
                        <span className="text-[0.55rem] uppercase tracking-[0.12em] text-black/40 dark:text-white/40 shrink-0">
                          {formatRelative(u.setAt)}
                        </span>
                      </div>
                      <p className="text-[0.72rem] text-black/75 dark:text-white/75 leading-snug whitespace-pre-wrap break-words">
                        {u.value}
                      </p>
                      {u.setByClient ? (
                        <p className="mt-1.5 text-[0.55rem] uppercase tracking-[0.12em] text-black/35 dark:text-white/35">
                          via {formatPushClientLabel(u.setByClient)}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Connected neurons */}
            <section>
              <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-2">
                Connected neurons ({project.members.length})
              </p>
              {sortedMembers.length === 0 ? (
                <p className="text-[0.7rem] text-black/40 dark:text-white/40">
                  No neurons clustered yet. Tap "Add neurons" below
                  to connect a few.
                </p>
              ) : (
                <div className="space-y-1">
                  {sortedMembers.map((m) => {
                    const Icon = KIND_ICON[m.kind || "neuron"] || Atom;
                    return (
                      <button
                        key={m.nodeId}
                        onClick={() => onSelectNode(m.nodeId)}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md bg-black/[0.025] dark:bg-white/[0.025] hover:bg-black/[0.06] dark:hover:bg-white/[0.06] border border-black/8 dark:border-white/8 hover:border-black/14 dark:hover:border-white/14 text-left transition-colors"
                      >
                        <Icon size={11} className="shrink-0 text-black/55 dark:text-white/55" />
                        <span className="flex-1 min-w-0 text-[0.74rem] text-black/85 dark:text-white/85 truncate">
                          {m.label || "(unlabeled)"}
                        </span>
                        <span className="shrink-0 text-[0.55rem] uppercase tracking-[0.12em] text-black/35 dark:text-white/35">
                          {kindLabel(m.kind)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Action row — two paths to grow the cluster.
                  "Add neurons" picks from existing nodes in
                  the brain (re-enters cluster selection mode
                  anchored to this project). "Create new
                  neuron" spawns a fresh neuron via the standard
                  creation modal and queues it directly into
                  this project. Same neutral white-on-dark
                  treatment as the rest of the chrome. */}
              {(onAddNeurons || onCreateNeuron) && (
                <div className="mt-2 flex items-center gap-1.5">
                  {onAddNeurons && (
                    <button
                      onClick={() => onAddNeurons(project.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.04] hover:bg-black/[0.08] dark:hover:bg-white/[0.08] border border-black/10 dark:border-white/10 hover:border-black/20 dark:hover:border-white/20 text-black/70 dark:text-white/70 hover:text-black/95 dark:hover:text-white/95 text-[0.7rem] font-medium transition-colors"
                      aria-label="Add neurons to this project"
                      title="Add neurons to this project"
                    >
                      <Plus size={11} />
                      Add neurons
                    </button>
                  )}
                  {onCreateNeuron && (
                    <button
                      onClick={() => onCreateNeuron(project.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.04] hover:bg-black/[0.08] dark:hover:bg-white/[0.08] border border-black/10 dark:border-white/10 hover:border-black/20 dark:hover:border-white/20 text-black/70 dark:text-white/70 hover:text-black/95 dark:hover:text-white/95 text-[0.7rem] font-medium transition-colors"
                      aria-label="Create a new neuron in this project"
                      title="Create a new neuron in this project"
                    >
                      <Plus size={11} />
                      Create new
                    </button>
                  )}
                </div>
              )}
            </section>

            {/* Manage — destructive-leaning project operations live
                at the bottom so they don't compete with the daily-
                use affordances above. Today this surfaces a single
                "Merge into…" entry; the corresponding chat-side path
                is the lykn_mergeProjects MCP tool, which calls the
                same `public.lykn_merge_projects` SQL function under
                the hood (migration 067). Hidden entirely when the
                user has no other projects to merge into so the
                section doesn't render as a dead button. Sign-in is
                also required because the merge contract assumes
                server-side rows; localStorage-only guests can't
                produce a meaningful preview. */}
            {userId && mergeCandidates.length > 0 && (
              <section className="border-t border-black/8 dark:border-white/8 pt-4">
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-black/40 dark:text-white/40 mb-2">
                  Manage
                </p>

                {/* Closed state — single button that flips the panel
                    into picker mode. Combine icon (the "merge"
                    metaphor users already recognise from git tools)
                    in white-on-dark to match the chrome elsewhere
                    in the panel. The destructive nature is explained
                    in the confirm step, not here, so the entry point
                    stays low-anxiety. */}
                {!mergePickerOpen && (
                  <button
                    onClick={() => setMergePickerOpen(true)}
                    className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.04] hover:bg-black/[0.08] dark:hover:bg-white/[0.08] border border-black/10 dark:border-white/10 hover:border-black/20 dark:hover:border-white/20 text-black/70 dark:text-white/70 hover:text-black/95 dark:hover:text-white/95 text-[0.7rem] font-medium transition-colors"
                    aria-label="Merge this project into another"
                    title="Fold this project's neurons + state into another project"
                  >
                    <Combine size={11} />
                    Merge into…
                  </button>
                )}

                {/* Open state, target NOT yet picked — list of every
                    OTHER project, sorted recent-first. Each row is a
                    button; clicking it kicks off a dry-run preview.
                    No commit happens at this step. */}
                {mergePickerOpen && !mergeTargetId && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[0.7rem] text-black/65 dark:text-white/65">
                        Pick a project to fold "{project.name}" into:
                      </p>
                      <button
                        onClick={resetMerge}
                        className="shrink-0 p-1 rounded text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/85 hover:bg-black/[0.06] dark:hover:bg-white/8 transition-colors"
                        aria-label="Cancel merge"
                        title="Cancel"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-1 pr-0.5 scrollbar-hide">
                      {mergeCandidates.map((cand) => (
                        <button
                          key={cand.id}
                          onClick={() => startPreview(cand.id)}
                          disabled={previewing}
                          className="w-full text-left px-2.5 py-2 rounded-md bg-black/[0.025] dark:bg-white/[0.025] hover:bg-black/[0.06] dark:hover:bg-white/[0.06] border border-black/8 dark:border-white/8 hover:border-black/14 dark:hover:border-white/14 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-start gap-2"
                        >
                          <FolderPlus size={11} className="mt-0.5 shrink-0 text-black/45 dark:text-white/45" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[0.72rem] text-black/85 dark:text-white/85 truncate">
                              {cand.name}
                            </div>
                            <div className="text-[0.6rem] text-black/45 dark:text-white/45 mt-0.5">
                              {cand.members.length} neuron
                              {cand.members.length === 1 ? "" : "s"}
                              {" · "}
                              {cand.pushCount || 0} push
                              {(cand.pushCount || 0) === 1 ? "" : "es"}
                            </div>
                          </div>
                          <ChevronDown
                            size={11}
                            className="shrink-0 text-black/35 dark:text-white/35 -rotate-90 mt-1.5"
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Target picked — show the dry-run preview + a
                    confirm/cancel pair. Numbers come straight from
                    the SQL function so the user sees the truth, not
                    a UI guess. The "Confirm merge" button is the
                    only red-tinted control in the panel — making it
                    visually loud is on purpose; this is irreversible. */}
                {mergePickerOpen && mergeTargetId && (
                  <div className="space-y-3">
                    {previewing && (
                      <div className="flex items-center gap-2 text-[0.7rem] text-black/55 dark:text-white/55 py-1">
                        <Loader2 size={11} className="animate-spin" />
                        Calculating preview…
                      </div>
                    )}

                    {mergePreview && !previewing && (
                      <div className="rounded-md bg-black/[0.03] dark:bg-white/[0.03] border border-black/10 dark:border-white/10 px-2.5 py-2.5 space-y-1.5">
                        <p className="text-[0.7rem] text-black/85 dark:text-white/85 leading-snug">
                          Folding{" "}
                          <span className="font-medium text-black/95 dark:text-white/95">
                            "{project.name}"
                          </span>{" "}
                          into{" "}
                          <span className="font-medium text-black/95 dark:text-white/95">
                            "{mergePreview.target?.name || "target"}"
                          </span>
                          .
                        </p>
                        <ul className="text-[0.66rem] text-black/65 dark:text-white/65 space-y-0.5 leading-snug pl-3 list-disc marker:text-black/30 dark:marker:text-white/30">
                          <li>
                            {mergePreview.stateRowsMoved} state row
                            {mergePreview.stateRowsMoved === 1 ? "" : "s"} moved
                            {mergePreview.stateKeysSupersededInTarget > 0
                              ? ` (${mergePreview.stateKeysSupersededInTarget} key${
                                  mergePreview.stateKeysSupersededInTarget === 1
                                    ? ""
                                    : "s"
                                } in target will be superseded)`
                              : ""}
                          </li>
                          <li>
                            {mergePreview.neuronsMoved} neuron
                            {mergePreview.neuronsMoved === 1 ? "" : "s"} moved
                            {mergePreview.neuronsDroppedAsDuplicate > 0
                              ? `, ${mergePreview.neuronsDroppedAsDuplicate} dropped as duplicate`
                              : ""}
                          </li>
                          {mergePreview.factsRepointed > 0 && (
                            <li>
                              {mergePreview.factsRepointed} identity fact
                              {mergePreview.factsRepointed === 1 ? "" : "s"}{" "}
                              re-pointed
                            </li>
                          )}
                          {mergePreview.activeProjectPointerRepointed && (
                            <li>
                              Your active-project focus will move to the
                              target.
                            </li>
                          )}
                          <li className="text-rose-600 dark:text-rose-300/85">
                            "{project.name}" will be permanently deleted.
                          </li>
                        </ul>
                      </div>
                    )}

                    {mergeError && (
                      <p className="text-[0.7rem] text-rose-600 dark:text-rose-300/90 leading-snug">
                        {mergeError}
                      </p>
                    )}

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={resetMerge}
                        disabled={committing}
                        className="flex-1 px-2.5 py-1.5 rounded-md bg-black/[0.04] dark:bg-white/[0.04] hover:bg-black/[0.08] dark:hover:bg-white/[0.08] border border-black/10 dark:border-white/10 hover:border-black/20 dark:hover:border-white/20 text-black/70 dark:text-white/70 hover:text-black/95 dark:hover:text-white/95 text-[0.7rem] font-medium transition-colors disabled:opacity-60"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={commitMerge}
                        disabled={committing || previewing || !mergePreview}
                        className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/30 hover:border-rose-400/50 text-rose-700 dark:text-rose-100 hover:text-rose-900 dark:hover:text-white text-[0.7rem] font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {committing ? (
                          <>
                            <Loader2 size={11} className="animate-spin" />
                            Merging…
                          </>
                        ) : (
                          <>
                            <Combine size={11} />
                            Confirm merge
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
