import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FolderKanban, Loader2, Plus } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/SupabaseAuth";
import { listUserProjects } from "@/lib/userProjects";
import {
  buildLinkedProjectPatch,
  neuronKey,
  projectMembersToSynthesisNeurons,
  projectMembersToVaultNoteIds,
} from "@/lib/modelBuilder/knowledgeSelection";
import ModelBuilderCreateProjectDialog from "@/components/modelBuilder/ModelBuilderCreateProjectDialog";

const NONE_VALUE = "__none__";
const CREATE_VALUE = "__create_new__";

function projectHint(project) {
  const neurons = project.members?.length ?? 0;
  const pushes = project.pushCount ?? 0;
  return `${neurons} neuron${neurons === 1 ? "" : "s"} · ${pushes} push${pushes === 1 ? "" : "es"}`;
}

export default function ModelBuilderProjectSelect({ draft, patch, triggerId = "model-project-select" }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const loadProjects = useCallback(() => {
    if (!user?.id) {
      setProjects([]);
      return Promise.resolve();
    }
    setLoading(true);
    setLoadFailed(false);
    return listUserProjects(user.id)
      .then((rows) => setProjects(Array.isArray(rows) ? rows : []))
      .catch(() => {
        setLoadFailed(true);
        setProjects([]);
      })
      .finally(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const linkedProjectId = draft.linkedProjectId || null;

  useEffect(() => {
    if (!linkedProjectId || loading || !projects.length) return;
    const project = projects.find((p) => p.id === linkedProjectId);
    if (!project) {
      patch({ linkedProjectId: null });
      return;
    }

    const projectNeurons = projectMembersToSynthesisNeurons(project.members);
    const projectVaultIds = projectMembersToVaultNoteIds(project.members);
    if (!projectNeurons.length && !projectVaultIds.length) return;

    const included = draft.includedSynthesisNeurons || [];
    const selectedKeys = new Set(included.map((n) => neuronKey(n.kind, n.id)));
    const missingProjectNeuron = projectNeurons.some(
      (n) => !selectedKeys.has(neuronKey(n.kind, n.id)),
    );
    const needsSelectedMode =
      projectNeurons.length > 0 && (draft.synthesisKnowledgeMode || "all") !== "selected";

    const includedVault = new Set(draft.includedVaultNoteIds || []);
    const missingProjectVault = projectVaultIds.some((id) => !includedVault.has(id));
    const needsPickMode =
      projectVaultIds.length > 0 && (draft.vaultKnowledgeMode || "off") !== "pick";

    if (missingProjectNeuron || needsSelectedMode || missingProjectVault || needsPickMode) {
      patch(buildLinkedProjectPatch(draft, project, { forceSelected: true }));
    }
  }, [
    draft.includedSynthesisNeurons,
    draft.includedVaultNoteIds,
    draft.synthesisKnowledgeMode,
    draft.vaultKnowledgeMode,
    linkedProjectId,
    loading,
    patch,
    projects,
  ]);

  const selectValue = linkedProjectId || NONE_VALUE;

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === linkedProjectId) || null,
    [linkedProjectId, projects],
  );

  const handleValueChange = useCallback(
    (next) => {
      if (next === CREATE_VALUE) {
        setCreateOpen(true);
        return;
      }
      const previousProject = projects.find((p) => p.id === draft.linkedProjectId) || null;
      if (next === NONE_VALUE) {
        patch(buildLinkedProjectPatch(draft, null, { previousProject }));
        return;
      }
      const project = projects.find((p) => p.id === next);
      if (!project) return;
      patch(buildLinkedProjectPatch(draft, project, { previousProject, forceSelected: true }));
    },
    [draft, patch, projects],
  );

  const handleProjectCreated = useCallback(
    (project) => {
      if (!project?.id) return;
      setProjects((prev) => {
        const without = prev.filter((p) => p.id !== project.id);
        return [project, ...without];
      });
      const previousProject = projects.find((p) => p.id === draft.linkedProjectId) || null;
      patch(buildLinkedProjectPatch(draft, project, { previousProject, forceSelected: true }));
    },
    [draft, patch, projects],
  );

  if (!user?.id) {
    return (
      <section className="space-y-2">
        <Label className="text-[12px]">Connected project</Label>
        <p className="text-[11px] text-muted-foreground rounded-xl border border-black/8 dark:border-white/10 px-3.5 py-2.5">
          <Link to="/login" className="text-blue-600 dark:text-blue-400 font-medium hover:underline">
            Sign in
          </Link>{" "}
          to connect a LYKN project to this model.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="space-y-2">
        <div className="flex items-start gap-2">
          <FolderKanban className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
          <div>
            <Label htmlFor={triggerId} className="text-[12px]">
              Connected project
            </Label>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              Link a LYKN project to auto-connect its synthesis and vault neurons below and load its
              working memory in chat.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading projects…
          </div>
        ) : loadFailed ? (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            Could not load projects.{" "}
            <button type="button" className="underline font-medium" onClick={() => void loadProjects()}>
              Retry
            </button>
          </p>
        ) : (
          <Select value={selectValue} onValueChange={handleValueChange}>
            <SelectTrigger
              id={triggerId}
              className="h-10 text-[13px] rounded-xl border-black/10 dark:border-white/12"
            >
              <SelectValue placeholder="Select a project">
                {selectedProject ? selectedProject.name : "No project linked"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="z-[110] max-h-72 model-builder-select-content scrollbar-hide">
              <SelectItem value={NONE_VALUE} className="text-[12px]">
                No project linked
              </SelectItem>
              {projects.map((project) => (
                <SelectItem
                  key={project.id}
                  value={project.id}
                  hint={projectHint(project)}
                  className="text-[12px]"
                >
                  {project.name}
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value={CREATE_VALUE} className="text-[12px] font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <Plus className="h-3.5 w-3.5 opacity-70" />
                  Create new project
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        )}
      </section>

      <ModelBuilderCreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleProjectCreated}
      />
    </>
  );
}
