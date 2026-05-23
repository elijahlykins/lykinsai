import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Atom,
  BookOpen,
  Compass,
  FileText,
  FolderPlus,
  Hash,
  Loader2,
  MessageSquare,
  Network,
  Plus,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { listProjectStateUpdates, type UserProject } from "@/lib/userProjects";

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
  if (kind === "grid") return "Chat";
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
};

export default function ProjectPanel({
  open,
  project,
  userId,
  onClose: _onClose,
  onSelectNode,
  onAddNeurons,
  onCreateNeuron,
}: ProjectPanelProps) {
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
    staleTime: 30 * 1000,
  });

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

  return (
    <AnimatePresence>
      {open && project ? (
        <motion.aside
          key={`project-panel-${project.id}`}
          initial={{ x: 380, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 380, opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 32 }}
          className="fixed top-0 right-0 z-[90] h-full w-[380px] max-w-[92vw] flex flex-col bg-[rgba(15,15,18,0.92)] backdrop-blur-xl border-l border-white/10 shadow-[0_0_60px_rgba(0,0,0,0.45)]"
          role="dialog"
          aria-label="Project details"
        >
          {/* Header — type chip; the page-level close chevron lives
              outside this component (z-[100], right-4) so we just
              leave room for it on the right, same as NeuronPanel. */}
          <header className="pl-5 pr-12 py-4 border-b border-white/8 flex items-center gap-2">
            <FolderPlus size={14} className="text-white/70" />
            <h2 className="text-[0.65rem] uppercase tracking-[0.18em] font-semibold text-white/55">
              Project
            </h2>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 scrollbar-hide">
            {/* Name */}
            <section>
              <h3 className="text-[1rem] leading-snug text-white/95 font-medium">
                {project.name}
              </h3>
              {project.description ? (
                <p className="text-[0.75rem] text-white/70 leading-relaxed mt-2">
                  {project.description}
                </p>
              ) : null}
            </section>

            {/* Meta */}
            <section className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-white/40 mb-1">
                  Last activity
                </p>
                <p className="text-[0.75rem] text-white/75">
                  {formatRelative(project.lastActiveAt)}
                </p>
              </div>
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-white/40 mb-1">
                  Status
                </p>
                <p className="text-[0.75rem] text-white/75 capitalize">
                  {project.status}
                </p>
              </div>
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-white/40 mb-1">
                  Started in
                </p>
                <p className="text-[0.75rem] text-white/75">
                  {project.createdByClient || "—"}
                </p>
              </div>
              <div>
                <p className="text-[0.58rem] uppercase tracking-[0.18em] text-white/40 mb-1">
                  Members
                </p>
                <p className="text-[0.75rem] text-white/75">
                  {project.members.length}
                </p>
              </div>
            </section>

            {/* Updates — kv-cards from lykn_project_state */}
            <section>
              <p className="text-[0.58rem] uppercase tracking-[0.18em] text-white/40 mb-2">
                Updates ({updates.length})
              </p>
              {updatesLoading ? (
                <div className="flex items-center gap-2 text-[0.7rem] text-white/45 py-2">
                  <Loader2 size={11} className="animate-spin" />
                  Loading updates…
                </div>
              ) : updates.length === 0 ? (
                <p className="text-[0.7rem] text-white/40 leading-relaxed">
                  No updates yet. When Claude, Cursor, or any
                  connected AI client makes a decision about this
                  project they'll push an update here through MCP
                  and you'll see it land.
                </p>
              ) : (
                <div className="space-y-2">
                  {updates.map((u) => (
                    <div
                      key={`${u.stateKey}-${u.setAt}`}
                      className="px-2.5 py-2 rounded-md bg-white/[0.03] border border-white/8"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[0.65rem] font-medium text-white/85 truncate">
                          {u.stateKey}
                        </span>
                        <span className="text-[0.55rem] uppercase tracking-[0.12em] text-white/40 shrink-0">
                          {formatRelative(u.setAt)}
                        </span>
                      </div>
                      <p className="text-[0.72rem] text-white/75 leading-snug whitespace-pre-wrap break-words">
                        {u.value}
                      </p>
                      {u.setByClient ? (
                        <p className="mt-1.5 text-[0.55rem] uppercase tracking-[0.12em] text-white/35">
                          via {u.setByClient}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Connected neurons */}
            <section>
              <p className="text-[0.58rem] uppercase tracking-[0.18em] text-white/40 mb-2">
                Connected neurons ({project.members.length})
              </p>
              {sortedMembers.length === 0 ? (
                <p className="text-[0.7rem] text-white/40">
                  No neurons clustered yet — tap "Add neurons" below
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
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md bg-white/[0.025] hover:bg-white/[0.06] border border-white/8 hover:border-white/14 text-left transition-colors"
                      >
                        <Icon size={11} className="shrink-0 text-white/55" />
                        <span className="flex-1 min-w-0 text-[0.74rem] text-white/85 truncate">
                          {m.label || "(unlabeled)"}
                        </span>
                        <span className="shrink-0 text-[0.55rem] uppercase tracking-[0.12em] text-white/35">
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
                      className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 hover:border-white/20 text-white/70 hover:text-white/95 text-[0.7rem] font-medium transition-colors"
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
                      className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 hover:border-white/20 text-white/70 hover:text-white/95 text-[0.7rem] font-medium transition-colors"
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
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
