import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Edit2,
  FolderPlus,
  Home,
  Bug,
  LayoutGrid,
  Lightbulb,
  Lock,
  LogIn,
  LogOut,
  MoreHorizontal,
  Plus,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import FeedbackModal from "@/components/FeedbackModal";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const PROJECTS_CHANGED_EVENT = "lykinsai_projects_changed";

const projectColors = [
  "rgba(219,234,254,0.6)",
  "rgba(220,252,231,0.55)",
  "rgba(237,233,254,0.55)",
  "rgba(254,249,195,0.55)",
  "rgba(224,231,255,0.55)",
  "rgba(240,253,250,0.55)",
];

const flushAndNavigate = (nav, path) => {
  window.dispatchEvent(new Event("omnia_flush_save"));
  // Small delay to let the async save start its network requests
  setTimeout(() => nav(path), 80);
};

export default function AppSidebar() {
  const nav = useNavigate();
  const location = useLocation();
  const { user, signInWithOAuth, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const [menuBoardId, setMenuBoardId] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState({ top: 0, left: 0 });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState("bug");
  const menuRef = useRef(null);
  const addToProjectRef = useRef(null);
  const pickerRef = useRef(null);

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

  const deleteBoard = async (boardId) => {
    if (!user?.id) return;
    if (!window.confirm("Delete this grid? This cannot be undone.")) return;
    await supabase.from("omnia_board_states").delete().eq("board_id", boardId);
    await supabase.from("omnia_boards").delete().eq("id", boardId).eq("user_id", user.id);
    setMenuBoardId(null);
    if (localStorage.getItem("omnia_board_id") === boardId) localStorage.removeItem("omnia_board_id");
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
    if (location.pathname === `/canvas/${boardId}`) nav("/");
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
          className="flex items-center gap-2 rounded-full glass-text-card px-2 py-1 text-[0.6875rem] text-black/70 hover:bg-blue-500/15 transition-colors"
          title={user ? "Sign out" : "Sign in"}
        >
          <div className="h-6 w-6 rounded-full glass-text-card text-[0.6875rem] font-semibold text-black/70 flex items-center justify-center">
            {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
          </div>
          <span className="pr-1">{user ? "Signed in" : "Sign in"}</span>
        </button>
      </div>

      <div
        className={`fixed top-0 left-0 z-[70] h-[100svh] w-[12rem] bg-transparent p-3 pt-12 transition-transform duration-200 flex flex-col ${
          open ? "translate-x-0" : "-translate-x-[120%]"
        }`}
      >
        <div className="absolute right-0 top-0 bottom-0 w-px bg-transparent pointer-events-none" />
        <div className="mt-5 flex items-center justify-between px-2 py-1">
          <div className="text-[0.6875rem] font-semibold text-black/70">Navigation</div>
        </div>

        <div className="px-2 pt-2">
          <div className="flex items-center gap-2 rounded-xl border border-black/10 bg-transparent px-2 py-1.5 text-[0.6875rem] text-black/60">
            <SearchIcon className="w-3.5 h-3.5" />
            <input
              placeholder="Search"
              className="w-full bg-transparent outline-none placeholder:text-black/40 text-black/70"
            />
          </div>
        </div>

        <div className="mt-2 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => flushAndNavigate(nav, "/dashboard")}
            className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
          >
            <Home className="w-3.5 h-3.5 text-black/60" />
            Home
          </button>
          <button
            type="button"
            onClick={() => flushAndNavigate(nav, "/")}
            className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
          >
            <LayoutGrid className="w-3.5 h-3.5 text-black/60" />
            Grid
          </button>
          <button
            type="button"
            onClick={() => {
              const newId = crypto.randomUUID();
              flushAndNavigate(nav, `/canvas/${newId}`);
            }}
            className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
          >
            <Plus className="w-3.5 h-3.5 text-black/60" />
            New Grid
          </button>
          <button
            type="button"
            onClick={() => flushAndNavigate(nav, "/memory")}
            className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
          >
            <Lock className="w-3.5 h-3.5 text-black/60" />
            Vault
          </button>
        </div>

        <div className="mt-3 text-[0.6875rem] font-semibold text-black/70 px-2 py-1">Projects</div>
        <div className="flex flex-col gap-1 max-h-[28vh] overflow-y-auto scrollbar-hide pr-1">
          {projects.length === 0 ? (
            <div className="text-[0.6875rem] text-black/50 px-2.5 py-1.5">No projects yet.</div>
          ) : (
            projects.map((project, idx) => (
              <button
                key={project.id}
                type="button"
                onClick={() => flushAndNavigate(nav, `/project/${project.id}`)}
                className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
              >
                <span className="inline-block h-1 w-1 rounded-full bg-black/70" />
                <span className="truncate">{project.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="mt-3 text-[0.6875rem] font-semibold text-black/70 px-2 py-1">Grids</div>
        <div className="flex flex-col gap-0.5 max-h-[28vh] overflow-y-auto scrollbar-hide pr-1">
          {boards.length === 0 ? (
            <div className="text-[0.6875rem] text-black/50 px-2.5 py-1.5">No grids yet.</div>
          ) : (
            boards.map((board) => {
              const isActive = location.pathname === `/canvas/${board.id}`;
              return (
                <div key={board.id} className="group relative flex items-center">
                  <button
                    type="button"
                    onClick={() => flushAndNavigate(nav, `/canvas/${board.id}`)}
                    className={`flex-1 min-w-0 text-left text-[0.6875rem] pl-2.5 pr-7 py-1.5 rounded-md flex items-center gap-2 transition-colors ${
                      isActive ? "bg-blue-500/15" : "hover:bg-blue-500/15"
                    }`}
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${isActive ? "bg-blue-500" : "bg-black/30"}`} />
                    <span className="truncate">{board.title || "Untitled Grid"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
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
                    <MoreHorizontal className="w-3 h-3 text-black/50" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="mt-3 text-[0.6875rem] font-semibold text-black/70 px-2 py-1">Account</div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => flushAndNavigate(nav, "/settings")}
            className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
          >
            <SettingsIcon className="w-3.5 h-3.5 text-black/60" />
            Settings
          </button>
          <button
            type="button"
            onClick={() => flushAndNavigate(nav, "/billing")}
            className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
          >
            <CreditCard className="w-3.5 h-3.5 text-black/60" />
            Billing
          </button>
        </div>

        <div className="mt-auto pt-4">
          <button
            type="button"
            onClick={() => { setFeedbackType("bug"); setFeedbackOpen(true); }}
            className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
          >
            <Bug className="w-3.5 h-3.5 text-black/60" />
            Report Bug
          </button>
          <button
            type="button"
            onClick={() => { setFeedbackType("suggestion"); setFeedbackOpen(true); }}
            className="w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
          >
            <Lightbulb className="w-3.5 h-3.5 text-black/60" />
            Suggestion
          </button>

          {user && (
            <button
              type="button"
              onClick={() => signOut()}
              className="mt-2 w-full text-left text-[0.6875rem] px-2.5 py-1.5 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
            >
              <LogOut className="w-3.5 h-3.5 text-black/60" />
              Log out
            </button>
          )}
        </div>
      </div>

      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        defaultType={feedbackType}
      />

      {menuBoardId && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-44 rounded-lg border border-black/10 bg-white/95 backdrop-blur-xl shadow-lg py-1 text-[0.6875rem]"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-blue-500/15 transition-colors"
            onClick={() => renameBoard(menuBoardId)}
          >
            <Edit2 className="w-3 h-3 text-black/50" />
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
              <FolderPlus className="w-3 h-3 text-black/50" />
              Add to project
              <ChevronRight className="w-3 h-3 text-black/30 ml-auto" />
            </button>
            {showProjectPicker && ReactDOM.createPortal(
              <div
                ref={pickerRef}
                className="fixed z-[10000] w-44 rounded-lg border border-black/10 bg-white/95 backdrop-blur-xl shadow-lg py-1 text-[0.6875rem]"
                style={{ top: pickerPos.top, left: pickerPos.left }}
                onMouseEnter={() => setShowProjectPicker(true)}
                onMouseLeave={() => setShowProjectPicker(false)}
              >
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-blue-500/15 transition-colors font-medium"
                  onClick={async () => {
                    const boardToAdd = menuBoardId;
                    const name = window.prompt("Project name:");
                    if (!name?.trim() || !user?.id || !boardToAdd) return;
                    const { data } = await supabase
                      .from("omnia_projects")
                      .insert({ user_id: user.id, name: name.trim() })
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
                      flushAndNavigate(nav, `/project/${data.id}`);
                    }
                  }}
                >
                  <Plus className="w-3 h-3 text-black/50" />
                  Create new project
                </button>
                {projects.length > 0 && (
                  <div className="border-t border-black/5 mt-1 pt-1">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-blue-500/15 transition-colors"
                        onClick={() => addBoardToProject(menuBoardId, p.id)}
                      >
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-black/30 flex-shrink-0" />
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
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-red-50 text-red-600 transition-colors"
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
