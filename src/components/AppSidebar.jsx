import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Compass,
  CreditCard,
  Edit2,
  FolderPlus,
  Bug,
  Lock,
  LogOut,
  MoreHorizontal,
  Plug,
  Plus,
  SquarePen,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import FeedbackModal from "@/components/FeedbackModal";
import { GridIcon } from "@/components/ui/GridIcon";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  hasPrototypeNeurons,
  PROTOTYPE_STEP_EVENT,
  readPrototypeStep,
} from "@/lib/prototypeHandoff";

const PROJECTS_CHANGED_EVENT = "lykinsai_projects_changed";

const projectColors = [
  "rgba(219,234,254,0.6)",
  "rgba(220,252,231,0.55)",
  "rgba(237,233,254,0.55)",
  "rgba(254,249,195,0.55)",
  "rgba(224,231,255,0.55)",
  "rgba(240,253,250,0.55)",
];

export default function AppSidebar({
  controlledOpen,
  onOpenChange,
  highlightSynthesis = false,
  restrictToSynthesis = false,
} = {}) {
  const nav = useNavigate();
  const location = useLocation();
  const { user, signInWithOAuth, signOut } = useAuth();
  // Prototype-handoff "preview" mode: when a guest came from the landing
  // prototype with at least one neuron in localStorage, suppress the demo
  // grid list so the sidebar reads as a brand-new, empty workspace.
  const isPrototypePreview = !user && hasPrototypeNeurons();

  // Walkthrough step (read from localStorage). Drives the auto-mounted
  // sidebar's nudges on /synthesis-layer and beyond — e.g. opens itself
  // and glows the Vault button when the user reaches step "vault".
  // Components that own their own AppSidebar (LandingPrototype passes
  // `highlightSynthesis` + `restrictToSynthesis` directly) keep the
  // explicit-prop path; this state is the fallback.
  const [walkStep, setWalkStep] = useState(() =>
    typeof window === "undefined" ? null : readPrototypeStep(),
  );
  useEffect(() => {
    const sync = () => setWalkStep(readPrototypeStep());
    window.addEventListener(PROTOTYPE_STEP_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PROTOTYPE_STEP_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Effective walkthrough state — explicit props from a parent (e.g. the
  // landing prototype) win over the localStorage-driven default. The
  // walkthrough only nudges guests who actually came from the prototype.
  const walkActive =
    isPrototypePreview &&
    (walkStep === "synthesis" || walkStep === "vault" || walkStep === "grid");
  const effectiveHighlightSynthesis = highlightSynthesis || (walkActive && walkStep === "synthesis");
  const effectiveHighlightVault = walkActive && walkStep === "vault";
  const effectiveHighlightGrid = walkActive && walkStep === "grid";
  // Centralized navigation lock: during a walkthrough step only the
  // highlighted destination (synthesis layer, vault, or grid) is
  // clickable. Explicit `restrictToSynthesis` from the prototype page
  // still wins.
  const lockedDestination = restrictToSynthesis
    ? "/synthesis-layer"
    : effectiveHighlightVault
      ? "/vault"
      : effectiveHighlightGrid
        ? "/app"
        : null;
  const isLocked = restrictToSynthesis || effectiveHighlightVault || effectiveHighlightGrid;

  // Centralized navigation: when locked to a single destination, every
  // nav attempt EXCEPT that destination is silently swallowed. This is
  // the primary lock — the matching CSS class only handles the visual
  // dim. (Logic is inlined rather than calling flushAndNavigate so the
  // callsite replacements `goTo(...)` stay simple.)
  const goTo = (path) => {
    if (lockedDestination && path !== lockedDestination) return;
    window.dispatchEvent(new Event("omnia_flush_save"));
    setTimeout(() => nav(path), 80);
  };

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined && controlledOpen !== null;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next) => {
    const value = typeof next === "function" ? next(open) : next;
    if (isControlled) {
      onOpenChange?.(value);
    } else {
      setInternalOpen(value);
    }
  };

  // Auto-open the (uncontrolled) sidebar each time the walkthrough
  // advances to a new "highlight + restrict" step. Fires once per step
  // value so manually closing the sidebar mid-step doesn't immediately
  // reopen it. Only fires when not controlled by a parent (e.g. the
  // landing prototype owns its own open-state).
  const lastAutoOpenedStepRef = useRef(null);
  useEffect(() => {
    if (isControlled) return;
    if (!effectiveHighlightVault && !effectiveHighlightGrid) return;
    if (lastAutoOpenedStepRef.current === walkStep) return;
    lastAutoOpenedStepRef.current = walkStep;
    setInternalOpen(true);
  }, [isControlled, effectiveHighlightVault, effectiveHighlightGrid, walkStep]);
  const queryClient = useQueryClient();
  const [menuBoardId, setMenuBoardId] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState({ top: 0, left: 0 });
  const [menuProjectId, setMenuProjectId] = useState(null);
  const [menuProjectPos, setMenuProjectPos] = useState({ top: 0, left: 0 });
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState("bug");
  const menuRef = useRef(null);
  const addToProjectRef = useRef(null);
  const pickerRef = useRef(null);
  const projectMenuRef = useRef(null);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("omnia_projects")
        .select("id, name, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(50);
      return data || [];
    },
    enabled: !!user?.id,
  });

  const { data: boards = [] } = useQuery({
    queryKey: ["boards", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("omnia_boards")
        .select("id, title, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(50);
      return data || [];
    },
    enabled: !!user?.id,
  });

  useEffect(() => {
    const onProjectsChanged = () => queryClient.invalidateQueries({ queryKey: ["projects", user?.id] });
    const onBoardsChanged = () => queryClient.invalidateQueries({ queryKey: ["boards", user?.id] });
    window.addEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    window.addEventListener("lykinsai_boards_changed", onBoardsChanged);
    return () => {
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
      window.removeEventListener("lykinsai_boards_changed", onBoardsChanged);
    };
  }, [queryClient, user?.id]);

  useEffect(() => {
    if (!open) {
      document.body.classList.remove("sidebar-open");
      document.body.classList.remove("sidebar-push");
      return () => {
        document.body.classList.remove("sidebar-open");
        document.body.classList.remove("sidebar-push");
      };
    }

    document.body.classList.add("sidebar-open");
    document.body.classList.add("sidebar-push");

    return () => {
      document.body.classList.remove("sidebar-open");
      document.body.classList.remove("sidebar-push");
    };
  }, [open]);

  useEffect(() => {
    if (!menuBoardId) return;
    const onClick = (e) => {
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      const inPicker = pickerRef.current && pickerRef.current.contains(e.target);
      if (!inMenu && !inPicker) {
        setMenuBoardId(null);
        setShowProjectPicker(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuBoardId]);

  useEffect(() => {
    if (!menuProjectId) return;
    const onClick = (e) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target)) {
        setMenuProjectId(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuProjectId]);

  const deleteProject = async (projectId) => {
    if (!user?.id) return;
    if (!window.confirm("Delete this project and unlink its grids? This cannot be undone.")) return;
    await supabase
      .from("omnia_boards")
      .update({ project_id: null })
      .eq("project_id", projectId)
      .eq("user_id", user.id);
    await supabase.from("omnia_projects").delete().eq("id", projectId).eq("user_id", user.id);
    setMenuProjectId(null);
    window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
    if (location.pathname === `/project/${projectId}`) nav("/app");
  };

  const renameProject = async (projectId) => {
    if (!user?.id) return;
    const project = projects.find((p) => p.id === projectId);
    const currentName = project?.name || "Untitled Project";
    const next = window.prompt("Rename project", currentName);
    if (next === null) return;
    const name = next.trim() || "Untitled Project";
    await supabase
      .from("omnia_projects")
      .update({ name, updated_at: new Date().toISOString() })
      .eq("id", projectId)
      .eq("user_id", user.id);
    setMenuProjectId(null);
    window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
  };

  const deleteBoard = async (boardId) => {
    if (!user?.id) return;
    if (!window.confirm("Delete this grid? This cannot be undone.")) return;
    await supabase.from("omnia_board_states").delete().eq("board_id", boardId);
    await supabase.from("omnia_boards").delete().eq("id", boardId).eq("user_id", user.id);
    setMenuBoardId(null);
    if (localStorage.getItem("omnia_board_id") === boardId) localStorage.removeItem("omnia_board_id");
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
    if (location.pathname === `/grid/${boardId}`) nav("/app");
  };

  const addBoardToProject = async (boardId, projectId) => {
    if (!user?.id) return;
    await supabase
      .from("omnia_boards")
      .update({ project_id: projectId })
      .eq("id", boardId)
      .eq("user_id", user.id);
    setMenuBoardId(null);
    setShowProjectPicker(false);
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
    window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
  };

  const renameBoard = async (boardId) => {
    if (!user?.id) return;
    const board = boards.find((b) => b.id === boardId);
    const currentTitle = board?.title || "New Grid";
    const next = window.prompt("Rename grid", currentTitle);
    if (next === null) return;
    const name = next.trim() || "New Grid";
    await supabase
      .from("omnia_boards")
      .update({ title: name, updated_at: new Date().toISOString() })
      .eq("id", boardId)
      .eq("user_id", user.id);
    setMenuBoardId(null);
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
  };

  return (
    <>
      <div className="fixed left-4 top-4 z-[80] flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-full w-8 h-8 hover:bg-blue-500/15 dark:hover:bg-blue-400/20 transition-colors flex items-center justify-center"
          title={open ? "Hide panel" : "Show panel"}
        >
          {open ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => {
            if (user) {
              const ok = window.confirm("Sign out of your account?");
              if (ok) signOut();
            } else {
              signInWithOAuth("google");
            }
          }}
          className="flex items-center gap-1.5 rounded-full bg-white/45 dark:bg-[rgba(60,60,60,0.14)] backdrop-blur-sm border border-black/6 dark:border-white/10 pl-1 pr-3 py-1 text-[0.6875rem] text-black/70 dark:text-white/70 hover:bg-white/60 dark:hover:bg-white/15 shadow-sm transition-colors"
          title={user ? "Sign out" : "Sign in"}
        >
          <div className="h-6 w-6 rounded-full bg-blue-500/15 dark:bg-blue-400/20 text-[0.6875rem] font-semibold text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">
            {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
          </div>
          <span>{user ? "Signed in" : "Sign in"}</span>
        </button>
      </div>

      <div
        className={`fixed top-0 left-0 z-[70] h-[100svh] w-[12rem] bg-[hsl(var(--sidebar-surface))] dark:bg-[hsl(0_0%_16%)] p-3 pt-12 transition-transform duration-200 flex flex-col ${
          open ? "translate-x-0" : "-translate-x-[120%]"
        } ${isLocked ? "lykn-sidebar-locked" : ""}`}
      >
        {/* ── Top: nav links (fixed, never scrolls) ── */}
        <div className="flex-shrink-0 mt-3">
          <div className="flex items-center gap-1">
            <div className="flex-1 min-w-0 flex items-center gap-2 rounded-xl border border-transparent bg-transparent px-2 py-1 text-[0.6875rem] text-black/60 dark:text-white/60">
              <SearchIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <input
                placeholder="Search"
                className="w-full bg-transparent outline-none placeholder:text-black/40 dark:placeholder:text-white/40 text-black/70 dark:text-white/70"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                const newId = crypto.randomUUID();
                goTo(`/grid/${newId}`);
              }}
              className="flex-shrink-0 w-7 h-7 rounded-md hover:bg-blue-500/15 transition-colors flex items-center justify-center text-black/60 dark:text-white/60"
              title="New grid"
            >
              <SquarePen className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="mt-1.5 flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => goTo("/app")}
              className={`w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 ${
                effectiveHighlightGrid ? "lykn-sidebar-grid-glow" : ""
              }`}
            >
              <GridIcon
                className={`w-3.5 h-3.5 ${
                  effectiveHighlightGrid
                    ? "text-amber-300"
                    : "text-black/60 dark:text-white/60"
                }`}
              />
              Grid
            </button>
            <button
              type="button"
              onClick={() => goTo("/vault")}
              className={`w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 ${
                effectiveHighlightVault ? "lykn-sidebar-vault-glow" : ""
              }`}
            >
              <Lock
                className={`w-3.5 h-3.5 ${
                  effectiveHighlightVault
                    ? "text-emerald-300"
                    : "text-black/60 dark:text-white/60"
                }`}
              />
              Vault
            </button>
          </div>

          <div className="my-2 border-t border-black/5 dark:border-white/5" />

          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Direct navigation — bypasses goTo / flushAndNavigate so
                // there's no setTimeout, no event dispatch, nothing that
                // could swallow the click. This is the prototype handoff's
                // ONE escape hatch and it must just work.
                // eslint-disable-next-line no-console
                console.log("[AppSidebar] Synthesis Layer clicked, navigating →", "/synthesis-layer");
                nav("/synthesis-layer");
              }}
              title="Synthesis Layer"
              className={`w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 ${
                effectiveHighlightSynthesis ? "lykn-sidebar-synthesis-glow" : ""
              }`}
            >
              <Brain
                className={`w-3.5 h-3.5 ${
                  effectiveHighlightSynthesis
                    ? "text-blue-400"
                    : "text-black/60 dark:text-white/60"
                }`}
              />
              <span className="flex-1">Synthesis Layer</span>
            </button>
            <button
              type="button"
              onClick={() => goTo("/discover")}
              className="w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
            >
              <Compass className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
              Discover
            </button>
            <button
              type="button"
              onClick={() => goTo("/connections")}
              className="w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
            >
              <Plug className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
              Connections
            </button>
          </div>
        </div>

        {/* ── Projects (fixed, collapsible) ── */}
        <div className="flex-shrink-0 mt-2">
          <button
            type="button"
            onClick={() => setProjectsExpanded((v) => !v)}
            className="flex items-center gap-1.5 px-2 py-0.5 w-full text-left hover:bg-blue-500/10 rounded-md transition-colors"
          >
            <ChevronDown className={`w-3 h-3 text-black/40 dark:text-white/40 transition-transform ${projectsExpanded ? "" : "-rotate-90"}`} />
            <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/50 dark:text-white/50">Projects</span>
          </button>
          {projectsExpanded && (
            <div>
              <button
                type="button"
                onClick={async () => {
                  if (!user?.id) return;
                  const { data } = await supabase
                    .from("omnia_projects")
                    .insert({ user_id: user.id, name: "New Project" })
                    .select("id")
                    .single();
                  if (data?.id) {
                    window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
                    goTo(`/project/${data.id}`);
                  }
                }}
                className="w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 text-black/60 dark:text-white/60"
              >
                <Plus className="w-3.5 h-3.5" />
                Add New Project
              </button>
              <div className="flex flex-col gap-0.5">
                {projects.length === 0 ? (
                  <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1">No projects yet</div>
                ) : (
                  projects.map((project) => {
                    const isActive = location.pathname === `/project/${project.id}`;
                    return (
                      <div key={project.id} className="group relative flex items-center">
                        <button
                          type="button"
                          onClick={() => goTo(`/project/${project.id}`)}
                          className={`flex-1 min-w-0 text-left text-[0.6875rem] pl-2.5 pr-7 py-1 rounded-md flex items-center gap-2 transition-colors ${
                            isActive ? "bg-blue-500/15" : "hover:bg-blue-500/15"
                          }`}
                        >
                          <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${isActive ? "bg-blue-500" : "bg-black/30 dark:bg-white/30"}`} />
                          <span className="truncate">{project.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuBoardId(null);
                            setShowProjectPicker(false);
                            if (menuProjectId === project.id) {
                              setMenuProjectId(null);
                            } else {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setMenuProjectPos({ top: rect.bottom + 4, left: rect.right });
                              setMenuProjectId(project.id);
                            }
                          }}
                          className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-blue-500/15 transition-opacity"
                        >
                          <MoreHorizontal className="w-3 h-3 text-black/50 dark:text-white/50" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Grids (scrollable) ── */}
        <div className="flex-1 min-h-0 flex flex-col mt-2">
          <div className="flex-shrink-0 flex items-center justify-between px-2 py-0.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/50 dark:text-white/50">Grids</span>
          </div>
          <div className="flex-shrink-0">
            <button
              type="button"
              onClick={() => {
                const newId = crypto.randomUUID();
                goTo(`/grid/${newId}`);
              }}
              className="w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 text-black/60 dark:text-white/60"
            >
              <Plus className="w-3.5 h-3.5" />
              Add New Grid
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide">
            <div className="flex flex-col gap-0.5">
              {!user && !isPrototypePreview ? (
                // Signed-out, no walkthrough yet: show nothing. We used to
                // render `DEMO_GRID_LIST` (3 prebuilt demo boards) here so
                // the sidebar wasn't empty, but that surfaced fake content
                // as if it were the visitor's own work — confusing for
                // anyone trying out LYKN cold. Now signed-out users only
                // ever see what THEY create through the walkthrough.
                <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1">No grids yet</div>
              ) : !user && isPrototypePreview ? (
                // Prototype-handoff preview: the user has exactly one
                // "grid" — the saved transcript of their first chat
                // with LYKN. Surfaces it in the sidebar so it's a real
                // navigable artifact, not just a node in the synthesis
                // layer they happened to see once.
                (() => {
                  const path = "/grid/__prototype_first_chat__";
                  const isActive = location.pathname === path;
                  return (
                    <div className="group relative flex items-center">
                      <button
                        type="button"
                        onClick={() => goTo(path)}
                        className={`flex-1 min-w-0 text-left text-[0.6875rem] px-2.5 py-1 rounded-md flex items-center gap-2 transition-colors ${
                          isActive ? "bg-blue-500/15" : "hover:bg-blue-500/15"
                        }`}
                      >
                        <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${isActive ? "bg-blue-500" : "bg-black/30 dark:bg-white/30"}`} />
                        <span className="truncate">First Conversation</span>
                      </button>
                    </div>
                  );
                })()
              ) : boards.length === 0 ? (
                <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1">No grids yet</div>
              ) : (
                boards.map((board) => {
                  const isActive = location.pathname === `/grid/${board.id}`;
                  return (
                    <div key={board.id} className="group relative flex items-center">
                      <button
                        type="button"
                        onClick={() => goTo(`/grid/${board.id}`)}
                        className={`flex-1 min-w-0 text-left text-[0.6875rem] pl-2.5 pr-7 py-1 rounded-md flex items-center gap-2 transition-colors ${
                          isActive ? "bg-blue-500/15" : "hover:bg-blue-500/15"
                        }`}
                      >
                        <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${isActive ? "bg-blue-500" : "bg-black/30 dark:bg-white/30"}`} />
                        <span className="truncate">{board.title || "New Grid"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuProjectId(null);
                          if (menuBoardId === board.id) {
                            setMenuBoardId(null);
                            setShowProjectPicker(false);
                          } else {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setMenuPos({ top: rect.bottom + 4, left: rect.right });
                            setMenuBoardId(board.id);
                            setShowProjectPicker(false);
                          }
                        }}
                        className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-blue-500/15 transition-opacity"
                      >
                        <MoreHorizontal className="w-3 h-3 text-black/50 dark:text-white/50" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ── Bottom: icon row (pinned) ── */}
        <div className="flex-shrink-0 pt-2 border-t border-black/5 dark:border-white/5 mt-1 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => goTo("/settings")}
            className="w-7 h-7 rounded-md hover:bg-blue-500/15 transition-colors flex items-center justify-center"
            title="Settings"
          >
            <SettingsIcon className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
          </button>
          <button
            type="button"
            onClick={() => goTo("/billing")}
            className="w-7 h-7 rounded-md hover:bg-blue-500/15 transition-colors flex items-center justify-center"
            title="Billing"
          >
            <CreditCard className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
          </button>
          <button
            type="button"
            onClick={() => { setFeedbackType("bug"); setFeedbackOpen(true); }}
            className="w-7 h-7 rounded-md hover:bg-blue-500/15 transition-colors flex items-center justify-center"
            title="Report Bug"
          >
            <Bug className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
          </button>
          {user && (
            <button
              type="button"
              onClick={() => signOut()}
              className="w-7 h-7 rounded-md hover:bg-blue-500/15 transition-colors flex items-center justify-center"
              title="Log out"
            >
              <LogOut className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
            </button>
          )}
        </div>
      </div>

      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        defaultType={feedbackType}
      />

      {menuProjectId && ReactDOM.createPortal(
        <div
          ref={projectMenuRef}
          className="fixed z-[9999] w-44 rounded-lg border border-white/8 bg-neutral-800 shadow-md py-1 text-[0.6875rem] text-white/80"
          style={{ top: menuProjectPos.top, left: menuProjectPos.left }}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-blue-500/15 transition-colors"
            onClick={() => renameProject(menuProjectId)}
          >
            <Edit2 className="w-3 h-3 text-black/50 dark:text-white/50" />
            Rename
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600 dark:text-red-400 transition-colors"
            onClick={() => deleteProject(menuProjectId)}
          >
            <Trash2 className="w-3 h-3" />
            Delete project
          </button>
        </div>,
        document.body
      )}

      {menuBoardId && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-44 rounded-lg border border-white/8 bg-neutral-800 shadow-md py-1 text-[0.6875rem] text-white/80"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-blue-500/15 transition-colors"
            onClick={() => renameBoard(menuBoardId)}
          >
            <Edit2 className="w-3 h-3 text-black/50 dark:text-white/50" />
            Rename
          </button>
          <div
            ref={addToProjectRef}
            className="relative"
            onMouseEnter={() => {
              if (addToProjectRef.current) {
                const r = addToProjectRef.current.getBoundingClientRect();
                setPickerPos({ top: r.top, left: r.right + 4 });
              }
              setShowProjectPicker(true);
            }}
            onMouseLeave={() => setShowProjectPicker(false)}
          >
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-blue-500/15 transition-colors"
            >
              <FolderPlus className="w-3 h-3 text-black/50 dark:text-white/50" />
              Add to project
              <ChevronRight className="w-3 h-3 text-black/30 dark:text-white/30 ml-auto" />
            </button>
            {showProjectPicker && ReactDOM.createPortal(
              <div
                ref={pickerRef}
                className="fixed z-[10000] w-44 rounded-lg border border-white/8 bg-neutral-800 shadow-md py-1 text-[0.6875rem] text-white/80"
                style={{ top: pickerPos.top, left: pickerPos.left }}
                onMouseEnter={() => setShowProjectPicker(true)}
                onMouseLeave={() => setShowProjectPicker(false)}
              >
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-blue-500/15 transition-colors font-medium"
                  onClick={async () => {
                    const boardToAdd = menuBoardId;
                    if (!user?.id || !boardToAdd) return;
                    const { data } = await supabase
                      .from("omnia_projects")
                      .insert({ user_id: user.id, name: "New Project" })
                      .select("id")
                      .single();
                    if (data?.id) {
                      await supabase
                        .from("omnia_boards")
                        .update({ project_id: data.id })
                        .eq("id", boardToAdd)
                        .eq("user_id", user.id);
                      setMenuBoardId(null);
                      setShowProjectPicker(false);
                      window.dispatchEvent(new Event("lykinsai_boards_changed"));
                      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
                      goTo(`/project/${data.id}`);
                    }
                  }}
                >
                  <Plus className="w-3 h-3 text-black/50 dark:text-white/50" />
                  Create new project
                </button>
                {projects.length > 0 && (
                  <div className="border-t border-black/5 dark:border-white/5 mt-1 pt-1">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-blue-500/15 transition-colors"
                        onClick={() => addBoardToProject(menuBoardId, p.id)}
                      >
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-black/30 dark:bg-white/30 flex-shrink-0" />
                        <span className="truncate">{p.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>,
              document.body
            )}
          </div>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600 dark:text-red-400 transition-colors"
            onClick={() => deleteBoard(menuBoardId)}
          >
            <Trash2 className="w-3 h-3" />
            Delete grid
          </button>
        </div>,
        document.body
      )}
    </>
  );
}
