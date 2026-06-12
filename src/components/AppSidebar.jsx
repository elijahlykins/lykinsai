import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Blocks,
  Brain,
  CalendarDays,
  CreditCard,
  Edit2,
  Bug,
  LogOut,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  SquarePen,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import lyknIconUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-master.png";
import lyknWordmarkUrl from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-NEUTRAL-master.png";
import FeedbackModal from "@/components/FeedbackModal";
import LyknCalendarDialog from "@/components/calendar/LyknCalendarDialog";
import { supabase } from "@/lib/supabase";
import { addOpenThread } from "@/lib/chat/chatThreadRuntime";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import ChatThreadSidebarGroups from "@/components/chat/ChatThreadSidebarGroups";
import { fetchBoardsWithContext, invalidateBoardListQueries } from "@/lib/board/fetchBoardsWithContext";
import { fetchPublishedCustomModels } from "@/lib/modelBuilder/customModelsClient";
import ChatModelFilterSelect from "@/components/chat/ChatModelFilterSelect";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import SignInPill from "@/components/SignInPill";

export default function AppSidebar({
  controlledOpen,
  onOpenChange,
  highlightSynthesis = false,
  restrictToSynthesis = false,
} = {}) {
  const nav = useNavigate();
  const location = useLocation();
  const { user, signOut } = useAuth();

  const effectiveHighlightSynthesis = highlightSynthesis;
  const lockedDestination = restrictToSynthesis ? "/synthesis-layer" : null;
  const isLocked = restrictToSynthesis;

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

  const handleNewChat = async () => {
    if (!user?.id) return;
    try {
      const { boardId } = await createNewChat(user.id);
      addOpenThread(boardId);
      invalidateBoardListQueries(queryClient, user.id);
      goTo(`/grid/${boardId}`);
    } catch {
      /* ignore */
    }
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

  const queryClient = useQueryClient();
  const [menuBoardId, setMenuBoardId] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState("bug");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarPanel, setCalendarPanel] = useState("calendar"); // "calendar" | "todos"
  const [searchQuery, setSearchQuery] = useState("");
  const [modelFilter, setModelFilter] = useState("all");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const { data: boards = [] } = useQuery({
    queryKey: ["boards", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      return fetchBoardsWithContext(user.id, 50);
    },
    enabled: !!user?.id,
  });

  const { data: customModels = [] } = useQuery({
    queryKey: ["published-custom-models", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      return fetchPublishedCustomModels();
    },
    enabled: !!user?.id,
  });

  // Sidebar search — passed to thread groups
  const normalizedQuery = searchQuery.trim();

  useEffect(() => {
    const onBoardsChanged = () => invalidateBoardListQueries(queryClient, user?.id);
    const onModelsChanged = () => {
      queryClient.invalidateQueries({ queryKey: ["published-custom-models", user?.id] });
    };
    const onOpenCalendar = () => { setCalendarPanel("calendar"); setCalendarOpen(true); };
    const onOpenTodos = () => { setCalendarPanel("todos"); setCalendarOpen(true); };
    window.addEventListener("lykinsai_boards_changed", onBoardsChanged);
    window.addEventListener("lykn_custom_models_changed", onModelsChanged);
    window.addEventListener("lykn_open_calendar", onOpenCalendar);
    window.addEventListener("lykn_open_todos", onOpenTodos);
    return () => {
      window.removeEventListener("lykinsai_boards_changed", onBoardsChanged);
      window.removeEventListener("lykn_custom_models_changed", onModelsChanged);
      window.removeEventListener("lykn_open_calendar", onOpenCalendar);
      window.removeEventListener("lykn_open_todos", onOpenTodos);
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
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuBoardId(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuBoardId]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onClick = (e) => {
      if (!e.target?.closest?.("[data-user-menu]")) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [userMenuOpen]);

  useEffect(() => { setUserMenuOpen(false); }, [open]);

  const deleteBoard = async (boardId) => {
    if (!user?.id) return;
    if (!window.confirm("Delete this chat? This cannot be undone.")) return;
    await supabase.from("omnia_board_states").delete().eq("board_id", boardId);
    await supabase.from("omnia_boards").delete().eq("id", boardId).eq("user_id", user.id);
    setMenuBoardId(null);
    if (localStorage.getItem("omnia_board_id") === boardId) localStorage.removeItem("omnia_board_id");
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
    if (location.pathname === `/grid/${boardId}`) nav("/app");
  };

  const renameBoard = async (boardId) => {
    if (!user?.id) return;
    const board = boards.find((b) => b.id === boardId);
    const currentTitle = board?.title || "New Chat";
    const next = window.prompt("Rename chat", currentTitle);
    if (next === null) return;
    const name = next.trim() || "New Chat";
    await supabase
      .from("omnia_boards")
      .update({ title: name, updated_at: new Date().toISOString() })
      .eq("id", boardId)
      .eq("user_id", user.id);
    setMenuBoardId(null);
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
  };

  const userMenuItems = (
    <>
      <button
        type="button"
        onClick={() => { setUserMenuOpen(false); goTo("/settings"); }}
        className="w-full text-left rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
      >
        <SettingsIcon className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
        Settings
      </button>
      <button
        type="button"
        onClick={() => { setUserMenuOpen(false); goTo("/billing"); }}
        className="w-full text-left rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
      >
        <CreditCard className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
        Billing
      </button>
      <button
        type="button"
        onClick={() => { setUserMenuOpen(false); setFeedbackType("bug"); setFeedbackOpen(true); }}
        className="w-full text-left rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
      >
        <Bug className="w-3.5 h-3.5 text-black/50 dark:text-white/50" />
        Report a bug
      </button>
      <div className="my-1 border-t border-black/5 dark:border-white/5" />
      <button
        type="button"
        onClick={() => { setUserMenuOpen(false); signOut(); }}
        className="w-full text-left rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-red-500/10 text-red-600 dark:text-red-400 transition-colors"
      >
        <LogOut className="w-3.5 h-3.5" />
        Log out
      </button>
    </>
  );

  return (
    <>
      <div className="fixed left-2.5 top-3 z-[80] flex items-center gap-0">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group/toggle relative rounded-full w-9 h-9 hover:bg-blue-500/15 dark:hover:bg-blue-400/20 transition-colors flex items-center justify-center"
          title="Show panel"
        >
          {open ? (
            <img src={lyknIconUrl} alt="LYKN" className="w-7 h-7 object-contain" draggable={false} />
          ) : (
            <>
              <img
                src={lyknIconUrl}
                alt="LYKN"
                className="w-7 h-7 object-contain transition-opacity duration-150 group-hover/toggle:opacity-0"
                draggable={false}
              />
              <PanelLeftOpen className="absolute w-4 h-4 text-black/70 dark:text-white/70 opacity-0 transition-opacity duration-150 group-hover/toggle:opacity-100" />
            </>
          )}
        </button>
        <img
          src={lyknWordmarkUrl}
          alt="LYKN"
          className={`h-5 w-auto object-contain select-none pointer-events-none -ml-1.5 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            open ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2"
          }`}
          draggable={false}
        />
      </div>

      {/* ── Collapsed icon rail (cross-fades in over the panel as it collapses) ── */}
      <div
        className={`fixed top-0 left-0 z-[72] h-[100svh] w-14 bg-[hsl(var(--sidebar-surface))] dark:bg-[hsl(0_0%_16%)] pt-16 pb-3 flex flex-col items-center transition-opacity duration-200 ease-out ${
          open ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
        aria-hidden={open}
      >
        <div className="flex-shrink-0 flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={handleNewChat}
            className="w-9 h-9 rounded-lg hover:bg-blue-500/15 transition-colors flex items-center justify-center text-black/60 dark:text-white/60"
            title="New chat"
          >
            <SquarePen className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => goTo("/app")}
            className={`w-9 h-9 rounded-lg hover:bg-blue-500/15 transition-colors flex items-center justify-center ${
              location.pathname === "/app" || location.pathname.startsWith("/grid/") ? "bg-blue-500/10" : ""
            }`}
            title="Chat"
          >
            <MessageCircle className="w-4 h-4 text-black/60 dark:text-white/60" />
          </button>
          <button
            type="button"
            onClick={() => goTo("/vault")}
            className={`w-9 h-9 rounded-lg hover:bg-blue-500/15 transition-colors flex items-center justify-center ${
              location.pathname === "/vault" || location.pathname.startsWith("/vault/") ? "bg-blue-500/10" : ""
            }`}
            title="Vault"
          >
            <Plug className="w-4 h-4 text-black/60 dark:text-white/60" />
          </button>
          <button
            type="button"
            onClick={() => { setCalendarPanel("calendar"); setCalendarOpen(true); }}
            className="w-9 h-9 rounded-lg hover:bg-blue-500/15 transition-colors flex items-center justify-center"
            title="Calendar / To-do"
          >
            <CalendarDays className="w-4 h-4 text-black/60 dark:text-white/60" />
          </button>
          <button
            type="button"
            onClick={() => nav("/synthesis-layer")}
            title="Synthesis Layer"
            className={`w-9 h-9 rounded-lg hover:bg-blue-500/15 transition-colors flex items-center justify-center ${
              effectiveHighlightSynthesis ? "lykn-sidebar-synthesis-glow" : ""
            }`}
          >
            <Brain className={`w-4 h-4 ${effectiveHighlightSynthesis ? "text-blue-400" : "text-black/60 dark:text-white/60"}`} />
          </button>
          {user ? (
            <button
              type="button"
              onClick={() => goTo("/builder")}
              className={`w-9 h-9 rounded-lg hover:bg-blue-500/15 transition-colors flex items-center justify-center ${
                location.pathname === "/builder" ? "bg-blue-500/10" : ""
              }`}
              title="Model builder"
            >
              <Blocks className="w-4 h-4 text-black/60 dark:text-white/60" />
            </button>
          ) : null}
        </div>

        <div className="flex-1" />

        <div className="flex-shrink-0 flex flex-col items-center pt-2 border-t border-black/5 dark:border-white/5 w-9">
          {user ? (
            <div className="relative" data-user-menu>
              {userMenuOpen && !open && (
                <div className="absolute bottom-0 left-full ml-2 w-44 rounded-2xl glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md p-1.5 text-[0.6875rem] text-black/85 dark:text-white/90">
                  {userMenuItems}
                </div>
              )}
              <button
                type="button"
                onClick={() => setUserMenuOpen((v) => !v)}
                className="w-9 h-9 rounded-lg hover:bg-blue-500/15 transition-colors flex items-center justify-center"
                title="Account"
              >
                <div className="h-6 w-6 rounded-full bg-blue-500/15 dark:bg-blue-400/20 text-[0.6875rem] font-semibold text-blue-600 dark:text-blue-400 flex items-center justify-center">
                  {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
                </div>
              </button>
            </div>
          ) : (
            <SignInPill compact />
          )}
        </div>
      </div>

      <div
        className={`fixed top-0 left-0 z-[70] h-[100svh] overflow-hidden bg-[hsl(var(--sidebar-surface))] dark:bg-[hsl(0_0%_16%)] transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] ${
          open ? "w-[12rem]" : "w-0"
        } ${isLocked ? "lykn-sidebar-locked" : ""}`}
      >
       <div
         className={`relative w-[12rem] h-full p-3 pt-14 flex flex-col transition-opacity duration-200 ease-out ${
           open ? "opacity-100" : "opacity-0"
         }`}
       >
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute top-3 right-2 z-10 w-7 h-7 rounded-md hover:bg-blue-500/15 transition-colors flex items-center justify-center"
          title="Close panel"
          aria-label="Close panel"
        >
          <PanelLeftClose className="w-4 h-4 text-black/60 dark:text-white/60" />
        </button>
        {/* ── Top: nav links (fixed, never scrolls) ── */}
        <div className="flex-shrink-0 mt-3">
          <div className="flex items-center gap-1">
            <div className="flex-1 min-w-0 flex items-center gap-2 rounded-xl border border-transparent bg-transparent px-2 py-1 text-[0.6875rem] text-black/60 dark:text-white/60">
              <SearchIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <input
                placeholder="Search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    e.currentTarget.blur();
                  }
                }}
                className="w-full bg-transparent outline-none placeholder:text-black/40 dark:placeholder:text-white/40 text-black/70 dark:text-white/70"
              />
            </div>
            <button
              type="button"
              onClick={handleNewChat}
              className="flex-shrink-0 w-7 h-7 rounded-md hover:bg-blue-500/15 transition-colors flex items-center justify-center text-black/60 dark:text-white/60"
              title="New chat"
            >
              <SquarePen className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="mt-1.5 flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => goTo("/app")}
              className={`w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 ${
                location.pathname === "/app" || location.pathname.startsWith("/grid/") ? "bg-blue-500/10" : ""
              }`}
            >
              <MessageCircle className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
              Chat
            </button>
            <button
              type="button"
              onClick={() => goTo("/vault")}
              className={`w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 ${
                location.pathname === "/vault" || location.pathname.startsWith("/vault/") ? "bg-blue-500/10" : ""
              }`}
            >
              <Plug className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
              Vault
            </button>
            <button
              type="button"
              onClick={() => { setCalendarPanel("calendar"); setCalendarOpen(true); }}
              className="w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
            >
              <CalendarDays className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
              Calendar / To-do
            </button>
          </div>

          <div className="flex flex-col gap-0.5 mt-1.5 pt-1.5 border-t border-black/5 dark:border-white/5">
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
            {user ? (
              <button
                type="button"
                onClick={() => goTo("/builder")}
                className={`w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 ${
                  location.pathname === "/builder" ? "bg-blue-500/10" : ""
                }`}
              >
                <Blocks className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
                <span className="flex-1">Model builder</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* ── Chats (scrollable) ── */}
        <div className="flex-1 min-h-0 flex flex-col mt-2">
          <div className="flex-shrink-0 flex items-center justify-between px-2 py-0.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/50 dark:text-white/50">Chats</span>
          </div>
          {user?.id ? (
            <ChatModelFilterSelect
              customModels={customModels}
              value={modelFilter}
              onChange={setModelFilter}
            />
          ) : null}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide">
            <ChatThreadSidebarGroups
              userId={user?.id}
              modelFilter={modelFilter}
              searchQuery={normalizedQuery}
              onOpenChat={(boardId) => {
                addOpenThread(boardId);
                goTo(`/grid/${boardId}`);
              }}
              menuBoardId={menuBoardId}
              onMenuBoardId={setMenuBoardId}
              onMenuPos={setMenuPos}
            />
          </div>
        </div>

        {/* ── Bottom: user bar (pinned) ── */}
        <div className="flex-shrink-0 pt-2 border-t border-black/5 dark:border-white/5 mt-1">
          {user ? (
            <div className="relative" data-user-menu>
              {userMenuOpen && open && (
                <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md p-1.5 text-[0.6875rem] text-black/85 dark:text-white/90">
                  {userMenuItems}
                </div>
              )}
              <button
                type="button"
                onClick={() => setUserMenuOpen((v) => !v)}
                className="w-full flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                title="Account"
              >
                <div className="h-6 w-6 rounded-full bg-blue-500/15 dark:bg-blue-400/20 text-[0.6875rem] font-semibold text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">
                  {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
                </div>
                <span className="flex-1 min-w-0 truncate text-left text-[0.6875rem] text-black/70 dark:text-white/70">Signed in</span>
              </button>
            </div>
          ) : (
            <SignInPill className="w-full justify-center" />
          )}
        </div>
       </div>
      </div>

      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        defaultType={feedbackType}
      />

      <LyknCalendarDialog open={calendarOpen} onOpenChange={setCalendarOpen} initialPanel={calendarPanel} />

      {menuBoardId && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-44 rounded-2xl glass-control border border-white/16 dark:border-white/8 bg-white/22 dark:bg-white/8 backdrop-blur-md shadow-md p-1.5 text-[0.6875rem] text-black/85 dark:text-white/90"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <button
            type="button"
            className="w-full text-left rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
            onClick={() => renameBoard(menuBoardId)}
          >
            <Edit2 className="w-3 h-3 text-black/50 dark:text-white/50" />
            Rename
          </button>
          <button
            type="button"
            className="w-full text-left rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-red-500/10 text-red-600 dark:text-red-400 transition-colors"
            onClick={() => deleteBoard(menuBoardId)}
          >
            <Trash2 className="w-3 h-3" />
            Delete chat
          </button>
        </div>,
        document.body
      )}
    </>
  );
}
