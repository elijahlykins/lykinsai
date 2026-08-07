import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, FolderKanban, Loader2 } from "lucide-react";
import { listUserProjects, type UserProject } from "@/lib/userProjects";

export type LyknChatScopedProject = { id: string; name: string };

export type LyknChatProjectPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
  activeProjectId?: string | null;
  onSelect: (project: LyknChatScopedProject | null) => void;
};

function projectHint(project: UserProject): string {
  const neurons = project.members?.length ?? 0;
  const pushes = project.pushCount ?? 0;
  return `${neurons} neuron${neurons === 1 ? "" : "s"} · ${pushes} push${pushes === 1 ? "" : "es"}`;
}

const LyknChatProjectPicker = React.memo(function LyknChatProjectPicker({
  open,
  onOpenChange,
  userId,
  activeProjectId,
  onSelect,
}: LyknChatProjectPickerProps) {
  const [projects, setProjects] = React.useState<UserProject[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    listUserProjects(userId)
      .then((rows) => {
        if (cancelled) return;
        setProjects((Array.isArray(rows) ? rows : []).filter((p) => p.status !== "archived"));
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setProjects([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  const pick = React.useCallback(
    (project: LyknChatScopedProject | null) => {
      onSelect(project);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  const rowCls =
    "w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-black/[0.06] dark:hover:bg-white/10";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderKanban className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            Chat about a project
          </DialogTitle>
          <DialogDescription>
            Scope this chat to a project so the assistant focuses on its neurons, working memory, and activity.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-1 max-h-[55vh] overflow-y-auto -mx-1 px-1">
          <button type="button" className={rowCls} onClick={() => pick(null)}>
            <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-black/[0.04] dark:bg-white/10 text-black/60 dark:text-white/70">
              <FolderKanban className="w-4 h-4" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13px] font-medium text-black/85 dark:text-white/90">No project</span>
              <span className="block text-[11px] text-black/50 dark:text-white/50">Chat without a project scope</span>
            </span>
            {!activeProjectId && <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />}
          </button>

          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-black/55 dark:text-white/55 px-3 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading projects…
            </div>
          ) : failed ? (
            <p className="text-[12px] text-amber-700 dark:text-amber-400 px-3 py-3">Could not load projects.</p>
          ) : projects.length === 0 ? (
            <p className="text-[12px] text-black/50 dark:text-white/50 px-3 py-4">
              No projects yet. Create one from Projects.
            </p>
          ) : (
            projects.map((project) => {
              const active = activeProjectId === project.id;
              return (
                <button
                  key={project.id}
                  type="button"
                  className={rowCls}
                  onClick={() => pick({ id: project.id, name: project.name })}
                >
                  <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    <FolderKanban className="w-4 h-4" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-medium text-black/85 dark:text-white/90 truncate">
                      {project.name || "Untitled project"}
                    </span>
                    <span className="block text-[11px] text-black/50 dark:text-white/50">{projectHint(project)}</span>
                  </span>
                  {active && <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});

export default LyknChatProjectPicker;
