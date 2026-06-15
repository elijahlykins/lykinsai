// /projects — the index of the user's synthesis-layer projects
// (`lykn_projects` + `lykn_project_neurons`). Same rows the MCP tools
// (lykn_listProjects / lykn_getContextBlock) serve to outside AI clients.
//
// This page is just the list + create form. Pressing a project opens its own
// full page (/projects/:projectId — ProjectDetailPage), the workspace where
// tasks, calendar deadlines, knowledge, and AI activity for that project live.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  createUserProject,
  getActiveProjectId,
  listUserProjects,
} from "@/lib/userProjects";
import { PROJECTS_CHANGED_EVENT } from "@/lib/synthesis/projectLiveSync";
import { relativeTime, splitMembers } from "@/components/projects/projectShared";

export default function ProjectsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
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

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["lykn_active_project", userId || "guest"] });
  };

  // Stay in sync with MCP-side project writes from connected AI clients.
  useEffect(() => {
    const onChange = () => refetch();
    window.addEventListener(PROJECTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, onChange);
  }, [userId]);

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const created = await createUserProject(userId, { name, members: [] });
      setNewName("");
      refetch();
      if (created) navigate(`/projects/${created.id}`);
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
          Your synthesis-layer projects and the tasks, deadlines, vault items, and concepts inside
          them. Every connected AI client sees these too.
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
                  onClick={() => navigate(`/projects/${p.id}`)}
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
    </div>
  );
}
