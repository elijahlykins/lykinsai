// /projects - the index of the user's synthesis-layer projects
// (`lykn_projects` + `lykn_project_neurons`). Same rows the MCP tools
// (lykn_listProjects / lykn_getContextBlock) serve to outside AI clients.
//
// This page is the list + create dialog. Pressing a project opens its own
// full page (/projects/:projectId - ProjectDetailPage), the workspace where
// tasks, calendar deadlines, knowledge, and AI activity for that project live.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Library, Plus, X } from "lucide-react";
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
import { fetchVaultNotesByIds } from "@/lib/vault/fetchVaultNotesByIds";
import {
  VAULT_PICK_CLOSED_EVENT,
  VAULT_PICK_PROJECT_EVENT,
  openVaultPicker,
} from "@/lib/vault/vaultPicker";
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
  const [searchParams] = useSearchParams();
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
  const [canPagePrev, setCanPagePrev] = useState(false);
  const [canPageNext, setCanPageNext] = useState(false);
  const railRef = useRef(null);
  // Studio glass skin (html.lykn-glass-embed) — set for the document's whole
  // lifetime, so reading it once at render is safe.
  const isGlassEmbed =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("lykn-glass-embed");

  // Deep-link into the new-project dialog via ?new= (the Studio desktop
  // projects widget's + button). The value changes per click so re-entry
  // works even when the surface is already on /projects.
  const newParam = searchParams.get("new");
  useEffect(() => {
    if (!newParam) return;
    setCreateOpen(true);
  }, [newParam]);

  // Only light up a card while hovered/focused - otherwise they all match.
  const featuredId = hoveredId;

  const updatePageAffordance = useCallback(() => {
    const el = railRef.current;
    if (!el) {
      setCanPagePrev(false);
      setCanPageNext(false);
      return;
    }
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanPagePrev(el.scrollLeft > 4);
    setCanPageNext(maxScroll > 4 && el.scrollLeft < maxScroll - 4);
  }, []);

  const pageRail = useCallback((direction) => {
    const el = railRef.current;
    if (!el) return;
    // Advance by roughly one viewport of cards so the next set lands in view.
    const step = Math.max(el.clientWidth * 0.85, 280);
    el.scrollBy({ left: direction * step, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (isLoading || projects.length === 0) return;
    const el = railRef.current;
    if (!el) return;
    updatePageAffordance();
    el.addEventListener("scroll", updatePageAffordance, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updatePageAffordance) : null;
    ro?.observe(el);
    window.addEventListener("resize", updatePageAffordance);
    return () => {
      el.removeEventListener("scroll", updatePageAffordance);
      ro?.disconnect();
      window.removeEventListener("resize", updatePageAffordance);
    };
  }, [isLoading, projects.length, updatePageAffordance]);

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

  // The Finder hands back what was chosen in that round, not the whole
  // selection, so picking twice adds to the draft rather than replacing it.
  const handleVaultPicked = async (noteIds) => {
    const ids = (Array.isArray(noteIds) ? noteIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    let titleById = new Map();
    try {
      const notes = await fetchVaultNotesByIds(userId, ids);
      titleById = new Map(notes.map((n) => [String(n.id), n.title]));
    } catch {
      /* fall back to a generic label if the title lookup fails */
    }
    setVaultItems((prev) => {
      const seen = new Set(prev.map((item) => item.id));
      const added = ids
        .filter((id) => !seen.has(id))
        .map((id) => ({ id, title: titleById.get(id) || "Vault item" }));
      return added.length ? [...prev, ...added] : prev;
    });
  };

  // "Add from vault" opens the Finder window in pick mode, so the chosen rows
  // arrive as an event. Held in a ref because the handler closes over the
  // draft, which changes far more often than this subscription should.
  const vaultPickedRef = useRef(handleVaultPicked);
  vaultPickedRef.current = handleVaultPicked;
  useEffect(() => {
    const onPicked = (e) => {
      const noteIds = e.detail?.noteIds;
      if (Array.isArray(noteIds) && noteIds.length) void vaultPickedRef.current(noteIds);
    };
    const onClosed = () => setVaultPickerOpen(false);
    window.addEventListener(VAULT_PICK_PROJECT_EVENT, onPicked);
    window.addEventListener(VAULT_PICK_CLOSED_EVENT, onClosed);
    return () => {
      window.removeEventListener(VAULT_PICK_PROJECT_EVENT, onPicked);
      window.removeEventListener(VAULT_PICK_CLOSED_EVENT, onClosed);
    };
  }, []);

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
    <div className="lykn-projects-page h-full min-h-0 overflow-y-auto bg-transparent text-black dark:bg-[#121214] dark:text-white flex flex-col">
      {/* Full-bleed within .app-content so the card-row clip lines up with
          the closed sidebar edge (`padding-left: 3.5rem` on .app-content).
          No `min-h-0` here on purpose: the cards and the rail's paging arrows
          keep their full height and the page scrolls, rather than the row
          collapsing and clipping them in a short window. */}
      <div className="w-full flex-1 flex flex-col justify-center py-8">
        <div className="w-full px-6 sm:px-10 shrink-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
            <h1 className="lykn-projects-title font-display text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-tight text-black/90 dark:text-white/95">
              Your projects
            </h1>
            <div className="lykn-projects-new shrink-0">
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-1.5 text-sm px-4 py-2.5 rounded-full bg-black text-white dark:bg-white dark:text-black shadow-sm hover:scale-[1.03] hover:-translate-y-0.5 hover:shadow-[0_8px_20px_-8px_rgba(0,0,0,0.35)] dark:hover:shadow-[0_8px_20px_-8px_rgba(255,255,255,0.25)] active:scale-[0.98] active:translate-y-0 transition-all duration-200 ease-out"
              >
                <Plus className="w-3.5 h-3.5" />
                New project
              </button>
            </div>
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
          <div className="relative">
            <div
              ref={railRef}
              className="lykn-projects-rail overflow-x-auto overflow-y-hidden pt-6 pb-4 snap-x snap-mandatory"
              onMouseLeave={() => setHoveredId(null)}
            >
              <div className="flex w-max min-w-full items-stretch justify-start gap-4 sm:gap-5 px-6 sm:px-10">
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
                    className={`group relative shrink-0 snap-center text-left flex flex-col overflow-hidden rounded-[1.5rem] w-[14rem] sm:w-[15.25rem] min-h-[21rem] sm:min-h-[22.5rem] p-6 sm:p-7 transition-[transform,box-shadow,opacity,background] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] outline-none focus-visible:ring-2 focus-visible:ring-black/20 dark:focus-visible:ring-white/25 ${
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
                        className={`font-display text-[1.3rem] sm:text-[1.4rem] font-semibold leading-[1.2] tracking-tight ${
                          isFeatured
                            ? "text-black/90 dark:text-white"
                            : "text-black/85 dark:text-white/90"
                        }`}
                      >
                        {p.name}
                      </h2>

                      <p
                        className={`mt-3 text-[0.8125rem] leading-relaxed line-clamp-4 ${
                          isFeatured
                            ? "text-black/60 dark:text-white/70"
                            : "text-black/45 dark:text-white/45"
                        }`}
                      >
                        {subtitle}
                      </p>

                      <div className="mt-auto pt-6 flex items-center gap-2.5">
                        <div
                          className={`shrink-0 w-9 h-9 rounded-[0.6rem] flex items-center justify-center text-[0.6875rem] font-semibold tracking-wide ${
                            isFeatured
                              ? "bg-black/85 text-white dark:bg-white/90 dark:text-black"
                              : "bg-black/10 text-black/70 dark:bg-white/15 dark:text-white/80"
                          }`}
                        >
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <div
                            className={`text-[0.75rem] font-semibold truncate ${
                              isFeatured
                                ? "text-black/85 dark:text-white"
                                : "text-black/75 dark:text-white/85"
                            }`}
                          >
                            {isFocus ? "AI focus" : isActive ? "Active" : "Paused"}
                            {p.isShared ? " · Shared" : ""}
                          </div>
                          <div
                            className={`text-[0.6875rem] truncate ${
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

            {(canPagePrev || canPageNext) ? (
              <div className="relative flex items-center justify-between px-6 sm:px-10 pt-1 pb-4 min-h-[2rem]">
                {canPagePrev ? (
                  <button
                    type="button"
                    aria-label="Previous projects"
                    onClick={() => pageRail(-1)}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-black/10 dark:border-white/15 bg-white/45 dark:bg-white/[0.08] text-black/70 dark:text-white/85 backdrop-blur-xl shadow-[0_6px_18px_-10px_rgba(0,0,0,0.35)] hover:bg-white/70 dark:hover:bg-white/[0.14] hover:scale-105 active:scale-95 transition-all duration-200"
                  >
                    <ChevronLeft className="w-4 h-4" strokeWidth={2} />
                  </button>
                ) : (
                  <span className="w-8" aria-hidden />
                )}
                {canPageNext ? (
                  <button
                    type="button"
                    aria-label="Next projects"
                    onClick={() => pageRail(1)}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-black/10 dark:border-white/15 bg-white/45 dark:bg-white/[0.08] text-black/70 dark:text-white/85 backdrop-blur-xl shadow-[0_6px_18px_-10px_rgba(0,0,0,0.35)] hover:bg-white/70 dark:hover:bg-white/[0.14] hover:scale-105 active:scale-95 transition-all duration-200"
                  >
                    <ChevronRight className="w-4 h-4" strokeWidth={2} />
                  </button>
                ) : (
                  <span className="w-8" aria-hidden />
                )}
              </div>
            ) : null}
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
        <DialogContent className="lykn-new-project-dialog max-w-md">
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
                  onClick={() => {
                    setVaultPickerOpen(true);
                    openVaultPicker("project");
                  }}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.06] text-black/70 dark:text-white/70 hover:border-blue-500/40 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
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
                      className="flex items-center gap-2 rounded-xl border border-black/[0.06] dark:border-white/[0.1] bg-black/[0.03] dark:bg-white/[0.06] px-2.5 py-2"
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
                className="text-sm px-3.5 py-2 rounded-full text-black/55 dark:text-white/55 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newName.trim() || creating}
                className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-full bg-black text-white dark:bg-white dark:text-black hover:bg-black/90 dark:hover:bg-white/90 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                {creating ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

    </div>
  );
}
