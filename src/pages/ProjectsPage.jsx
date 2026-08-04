// /projects - the index of the user's synthesis-layer projects
// (`lykn_projects` + `lykn_project_neurons`). Same rows the MCP tools
// (lykn_listProjects / lykn_getContextBlock) serve to outside AI clients.
//
// This page is the list + create dialog. Pressing a project opens its own
// full page (/projects/:projectId - ProjectDetailPage), the workspace where
// tasks, calendar deadlines, knowledge, and AI activity for that project live.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Plus, X } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import { toast } from "@/components/ui/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createUserProject,
  getActiveProjectId,
  listUserProjects,
} from "@/lib/userProjects";
import { PROJECTS_CHANGED_EVENT } from "@/lib/synthesis/projectLiveSync";
import { relativeTime, splitMembers } from "@/components/projects/projectShared";
import { useIsDark } from "@/lib/projectChartTheme";
import VaultPickerDialog from "@/components/vault/VaultPickerDialog";
import { fetchVaultNotesByIds } from "@/lib/vault/fetchVaultNotesByIds";
import LoadingScreen from "@/components/LoadingScreen";

const FEATURED_GRADIENT_LIGHT =
  "radial-gradient(120% 90% at 50% 115%, #3b82f6 0%, #93c5fd 28%, #eef4ff 62%, #ececeb 100%)";
const FEATURED_GRADIENT_DARK =
  "radial-gradient(120% 90% at 50% 115%, #3b82f6 0%, #2563eb 32%, #152033 68%, #10141c 100%)";
// Inside the Studio's dark Glass skin the blue wash looks out of place —
// hovered cards brighten into a frostier white glass instead.
const FEATURED_GRADIENT_GLASS =
  "radial-gradient(120% 90% at 50% 115%, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.17) 42%, rgba(255,255,255,0.10) 100%)";

function projectInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "P";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function projectSubtitle(project) {
  if (project.description?.trim()) return project.description.trim();
  const g = splitMembers(project.members);
  const bits = [];
  if (g.vault.length) bits.push(`${g.vault.length} vault item${g.vault.length === 1 ? "" : "s"}`);
  if (g.concept.length) bits.push(`${g.concept.length} concept${g.concept.length === 1 ? "" : "s"}`);
  if (project.pushCount) bits.push(`${project.pushCount} AI push${project.pushCount === 1 ? "" : "es"}`);
  if (bits.length === 0) {
    return "A place for tasks, deadlines, vault items, and concepts to gather.";
  }
  return bits.join(" · ");
}

function projectRoleLine(project, isFocus) {
  if (project.isShared) return `Shared · ${project.role} access`;
  if (isFocus) return "AI focus project";
  if (project.status !== "active") return "Deactivated";
  return `Used ${relativeTime(project.lastActiveAt)}`;
}

export default function ProjectsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isDark = useIsDark();
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

  const [createOpen, setCreateOpen] = useState(false);
  const [vaultPickerOpen, setVaultPickerOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [vaultItems, setVaultItems] = useState([]); // { id, title }[]
  const [creating, setCreating] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  // Studio glass skin (html.lykn-glass-embed) — set for the document's whole
  // lifetime, so reading it once at render is safe.
  const isGlassEmbed =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("lykn-glass-embed");

  // Only light up a card while hovered/focused - otherwise they all match.
  const featuredId = hoveredId;

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["lykn_active_project", userId || "guest"] });
  };

  // Stay in sync with in-app chat/voice CustomEvents, Electron overlay IPC
  // (bridged to the same event), and direct DB writes via Realtime.
  useEffect(() => {
    const onChange = () => refetch();
    window.addEventListener(PROJECTS_CHANGED_EVENT, onChange);

    if (!userId || !supabase) {
      return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, onChange);
    }

    const channel = supabase
      .channel(`projects-page:${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_projects", filter: `user_id=eq.${userId}` },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_project_neurons", filter: `user_id=eq.${userId}` },
        onChange,
      )
      .subscribe();

    return () => {
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onChange);
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  const resetCreateForm = () => {
    setNewName("");
    setNewDescription("");
    setVaultItems([]);
    setVaultPickerOpen(false);
  };

  const handleCreateOpenChange = (open) => {
    // Don't tear down the draft when we only hide this dialog for the
    // vault picker - createOpen stays true and the form remounts after.
    if (!open && vaultPickerOpen) return;
    setCreateOpen(open);
    if (!open) resetCreateForm();
  };

  const handleVaultPicked = async (noteIds) => {
    const ids = (Array.isArray(noteIds) ? noteIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (ids.length === 0) {
      setVaultItems([]);
      return;
    }
    let titleById = new Map();
    try {
      const notes = await fetchVaultNotesByIds(userId, ids);
      titleById = new Map(notes.map((n) => [String(n.id), n.title]));
    } catch {
      /* fall back to a generic label if the title lookup fails */
    }
    setVaultItems(
      ids.map((id) => ({
        id,
        title: titleById.get(id) || "Vault item",
      })),
    );
  };

  const removeVaultItem = (id) => {
    setVaultItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const members = vaultItems.map((item) => ({
        nodeId: `vault_${item.id}`,
        label: item.title,
        kind: "vault",
      }));
      const created = await createUserProject(userId, {
        name,
        description: newDescription.trim() || null,
        members,
      });
      if (!created) {
        toast({
          title: "Couldn't create project",
          description: "Something went wrong. Please try again.",
          variant: "destructive",
        });
        return;
      }
      handleCreateOpenChange(false);
      refetch();
      navigate(`/projects/${created.id}`);
    } finally {
      setCreating(false);
    }
  };

  const inputCls =
    "w-full text-sm px-3.5 py-2.5 rounded-xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/[0.04] outline-none focus:border-blue-500/40 placeholder:text-black/35 dark:placeholder:text-white/35 transition-colors text-black dark:text-white";

  // Same initial-load takeover Vault / Synthesis use — keep the header and
  // empty-state from flashing before project cards are ready.
  if (isLoading) {
    return <LoadingScreen isLoading={true} />;
  }

  return (
    <div className="lykn-projects-page min-h-screen bg-transparent text-black dark:bg-[#121214] dark:text-white flex items-center">
      {/* Full-bleed within .app-content so the card-row clip lines up with
          the closed sidebar edge (`padding-left: 3.5rem` on .app-content). */}
      <div className="w-full py-16">
        <div className="mx-auto max-w-[88rem] px-6 sm:px-10">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-10">
            <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-tight text-black/90 dark:text-white/95">
              Your projects
            </h1>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="shrink-0 inline-flex items-center gap-1.5 text-sm px-4 py-2.5 rounded-full bg-black text-white dark:bg-white dark:text-black shadow-sm hover:scale-[1.03] hover:-translate-y-0.5 hover:shadow-[0_8px_20px_-8px_rgba(0,0,0,0.35)] dark:hover:shadow-[0_8px_20px_-8px_rgba(255,255,255,0.25)] active:scale-[0.98] active:translate-y-0 transition-all duration-200 ease-out"
            >
              <Plus className="w-3.5 h-3.5" />
              New project
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="rounded-[1.75rem] border border-dashed border-black/15 dark:border-white/15 px-8 py-16 text-center bg-white/40 dark:bg-white/[0.03]">
              <p className="font-display text-2xl font-semibold text-black/70 dark:text-white/70">
                No projects yet.
              </p>
              <p className="text-sm text-black/45 dark:text-white/40 mt-2 max-w-md mx-auto">
                Create one above to get started.
              </p>
            </div>
          ) : null}
        </div>

        {projects.length > 0 ? (
          <div
            className="overflow-x-auto pt-8 pb-20 snap-x snap-mandatory scrollbar-hide"
            onMouseLeave={() => setHoveredId(null)}
          >
            <div className="flex w-max min-w-full items-stretch justify-center gap-4 sm:gap-5 px-6 sm:px-10">
            {projects.map((p) => {
              const isFocus = focusProjectId === p.id;
              const isFeatured = featuredId === p.id;
              const isActive = p.status === "active";
              const initials = projectInitials(p.name);
              const subtitle = projectSubtitle(p);
              const roleLine = projectRoleLine(p, isFocus);

              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => navigate(`/projects/${p.id}`)}
                  onMouseEnter={() => setHoveredId(p.id)}
                  onFocus={() => setHoveredId(p.id)}
                  className={`group relative shrink-0 snap-center text-left flex flex-col overflow-hidden rounded-[1.75rem] w-[16.5rem] sm:w-[18rem] min-h-[26rem] sm:min-h-[27.5rem] p-7 sm:p-8 transition-[transform,box-shadow,opacity,background] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] outline-none focus-visible:ring-2 focus-visible:ring-black/20 dark:focus-visible:ring-white/25 ${
                    isFeatured
                      ? "scale-[1.04] z-10 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.28)]"
                      : "scale-100 opacity-[0.92] shadow-[0_8px_24px_-16px_rgba(0,0,0,0.18)]"
                  } ${!isActive && !isFeatured ? "opacity-70" : ""}`}
                  style={{
                    background: isFeatured
                      ? isDark
                        ? isGlassEmbed
                          ? FEATURED_GRADIENT_GLASS
                          : FEATURED_GRADIENT_DARK
                        : FEATURED_GRADIENT_LIGHT
                      : isDark
                        ? "rgba(255,255,255,0.07)"
                        : "#e4e4e2",
                  }}
                >

                  <div className="relative z-[1] flex flex-col h-full min-h-0">
                    <h2
                      className={`font-display text-[1.55rem] sm:text-[1.7rem] font-semibold leading-[1.2] tracking-tight ${
                        isFeatured
                          ? "text-black/90 dark:text-white"
                          : "text-black/85 dark:text-white/90"
                      }`}
                    >
                      {p.name}
                    </h2>

                    <p
                      className={`mt-4 text-[0.875rem] leading-relaxed line-clamp-5 ${
                        isFeatured
                          ? "text-black/60 dark:text-white/70"
                          : "text-black/45 dark:text-white/45"
                      }`}
                    >
                      {subtitle}
                    </p>

                    <div className="mt-auto pt-8 flex items-center gap-3">
                      <div
                        className={`shrink-0 w-10 h-10 rounded-[0.7rem] flex items-center justify-center text-[0.75rem] font-semibold tracking-wide ${
                          isFeatured
                            ? "bg-black/85 text-white dark:bg-white/90 dark:text-black"
                            : "bg-black/10 text-black/70 dark:bg-white/15 dark:text-white/80"
                        }`}
                      >
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <div
                          className={`text-[0.8125rem] font-semibold truncate ${
                            isFeatured
                              ? "text-black/85 dark:text-white"
                              : "text-black/75 dark:text-white/85"
                          }`}
                        >
                          {isFocus ? "AI focus" : isActive ? "Active" : "Paused"}
                          {p.isShared ? " · Shared" : ""}
                        </div>
                        <div
                          className={`text-[0.75rem] truncate ${
                            isFeatured
                              ? "text-black/50 dark:text-white/55"
                              : "text-black/40 dark:text-white/40"
                          }`}
                        >
                          {roleLine}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
            </div>
          </div>
        ) : null}
      </div>

      <Dialog
        // Hide (don't destroy form state) while the vault picker is open.
        // Nested Radix modal + iframe picker fights over aria-hidden /
        // pointer-events and made vault clicks look broken.
        open={createOpen && !vaultPickerOpen}
        onOpenChange={(open) => {
          if (!open && vaultPickerOpen) return;
          handleCreateOpenChange(open);
        }}
      >
        <DialogContent className="bg-panel border-black/10 dark:border-white/10 text-black dark:text-white max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-lg font-semibold tracking-tight">
              New project
            </DialogTitle>
            <DialogDescription className="text-sm text-black/50 dark:text-white/45">
              Name it, add a short description, and pull in vault items if you want.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreate} className="flex flex-col gap-4 mt-1">
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                Name
              </span>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Project name"
                maxLength={120}
                className={inputCls}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                Description
              </span>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What is this project about? (optional)"
                maxLength={320}
                rows={3}
                className={`${inputCls} resize-none`}
              />
            </label>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                  From vault
                </span>
                <button
                  type="button"
                  onClick={() => setVaultPickerOpen(true)}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border border-black/10 dark:border-white/10 text-black/70 dark:text-white/70 hover:border-blue-500/40 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                >
                  <Library className="w-3.5 h-3.5" />
                  {vaultItems.length > 0 ? "Edit selection" : "Add from vault"}
                </button>
              </div>

              {vaultItems.length === 0 ? (
                <p className="text-xs text-black/40 dark:text-white/40 px-0.5">
                  Optional. Attach notes, files, or pages from your vault.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5 max-h-36 overflow-y-auto scrollbar-hide">
                  {vaultItems.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-2 rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] px-2.5 py-2"
                    >
                      <Library className="w-3.5 h-3.5 shrink-0 text-black/35 dark:text-white/35" />
                      <span className="flex-1 min-w-0 text-xs text-black/75 dark:text-white/75 truncate">
                        {item.title}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeVaultItem(item.id)}
                        className="p-1 rounded-md text-black/35 dark:text-white/35 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                        title="Remove"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => handleCreateOpenChange(false)}
                className="text-sm px-3.5 py-2 rounded-full text-black/55 dark:text-white/55 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newName.trim() || creating}
                className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-full bg-blue-500 text-white hover:bg-blue-500/90 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                {creating ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <VaultPickerDialog
        open={vaultPickerOpen}
        onClose={() => setVaultPickerOpen(false)}
        committedNoteIds={vaultItems.map((item) => item.id)}
        onAddFiles={handleVaultPicked}
        title="Add from vault"
        subtitle="Select files to include in this project"
      />
    </div>
  );
}
