import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Brain,
  CalendarDays,
  CreditCard,
  Bug,
  FolderKanban,
  LogOut,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Lock,
  SquarePen,
  Search as SearchIcon,
  Settings as SettingsIcon,
} from "lucide-react";
import lyknIconUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-master.png";
import lyknIconBlueUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-BLUE-master.png";
import lyknLogoUrl from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";
import lyknLogoBlueUrl from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import FeedbackModal from "@/components/FeedbackModal";
import LyknCalendarDialog from "@/components/calendar/LyknCalendarDialog";
import { supabase } from "@/lib/supabase";
import { addOpenThread } from "@/lib/chat/chatThreadRuntime";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import ChatThreadSidebarGroups from "@/components/chat/ChatThreadSidebarGroups";
import {
  invalidateLyknChatListQueries,
  markLyknChatDeleted,
  patchLyknChatPinnedInListQueries,
  removeLyknChatFromListQueries,
} from "@/lib/lyknChat/fetchLyknChatsWithContext";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQueryClient } from "@tanstack/react-query";
import SignInPill from "@/components/SignInPill";

// LYKN icon mark — blue in light mode, neutral (near-white) in dark mode.
function LyknMark({ className = "", draggable = false }) {
  return (
    <>
      <img src={lyknIconBlueUrl} alt="LYKN" className={`${className} block dark:hidden`} draggable={draggable} />
      <img src={lyknIconUrl} alt="LYKN" className={`${className} hidden dark:block`} draggable={draggable} />
    </>
  );
}

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
    window.dispatchEvent(new Event("lyknchat_flush_save"));
    setTimeout(() => nav(path), 80);
  };

  const handleNewChat = async () => {
    if (!user?.id) return;
    try {
      const { chatId } = await createNewChat(user.id);
      addOpenThread(chatId);
      invalidateLyknChatListQueries(queryClient, user.id);
      goTo(`/chat/${chatId}`);
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
  const [menuChatId, setMenuChatId] = useState(null);
  const [menuChatPinned, setMenuChatPinned] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  const closeChatMenu = () => {
    setMenuChatId(null);
    setMenuChatPinned(false);
  };

  const openChatMenu = ({ id, pinned, top, left }) => {
    setMenuChatId(id);
    setMenuChatPinned(Boolean(pinned));
    setMenuPos({ top, left });
  };
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState("bug");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarPanel, setCalendarPanel] = useState("calendar"); // "calendar" | "todos"
  const [searchQuery, setSearchQuery] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userMenuPos, setUserMenuPos] = useState({ bottom: 8, left: 8, width: 176 });
  const menuRef = useRef(null);
  const userMenuRef = useRef(null);
  const userBtnCollapsedRef = useRef(null);
  const userBtnExpandedRef = useRef(null);

  const placeUserMenu = () => {
    const btn = open ? userBtnExpandedRef.current : userBtnCollapsedRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    if (open) {
      // Expanded sidebar: menu opens upward above the account row.
      const width = Math.max(176, rect.width);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const bottom = Math.max(8, window.innerHeight - rect.top + 8);
      setUserMenuPos({ bottom, left, width });
    } else {
      // Collapsed rail: menu opens to the right, bottom-aligned with the avatar.
      const width = 176;
      const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8));
      const bottom = Math.max(8, window.innerHeight - rect.bottom);
      setUserMenuPos({ bottom, left, width });
    }
  };

  // Sidebar search — passed to thread groups
  const normalizedQuery = searchQuery.trim();

  useEffect(() => {
    const onBoardsChanged = () => invalidateLyknChatListQueries(queryClient, user?.id);
    const onOpenCalendar = () => { setCalendarPanel("calendar"); setCalendarOpen(true); };
    const onOpenTodos = () => { setCalendarPanel("todos"); setCalendarOpen(true); };
    window.addEventListener("lykinsai_chats_changed", onBoardsChanged);
    window.addEventListener("lykn_open_calendar", onOpenCalendar);
    window.addEventListener("lykn_open_todos", onOpenTodos);
    return () => {
      window.removeEventListener("lykinsai_chats_changed", onBoardsChanged);
      window.removeEventListener("lykn_open_calendar", onOpenCalendar);
      window.removeEventListener("lykn_open_todos", onOpenTodos);
    };
  }, [queryClient, user?.id]);

  useEffect(() => {
    if (!open) {
      document.body.classList.remove("sidebar-open");
      document.body.classList.remove("sidebar-push");
      // Collapsed: the icon rail still occupies the left edge, so reserve
      // its width on .app-content to keep page content from sitting under it.
      document.body.classList.add("sidebar-collapsed");
      return () => {
        document.body.classList.remove("sidebar-open");
        document.body.classList.remove("sidebar-push");
        document.body.classList.remove("sidebar-collapsed");
      };
    }

    document.body.classList.add("sidebar-open");
    document.body.classList.add("sidebar-push");
    document.body.classList.remove("sidebar-collapsed");

    return () => {
      document.body.classList.remove("sidebar-open");
      document.body.classList.remove("sidebar-push");
      document.body.classList.remove("sidebar-collapsed");
    };
  }, [open]);

  useEffect(() => {
    if (!menuChatId) return;
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        closeChatMenu();
      }
    };
    document.addEventListener("mousedown", onClick);
    // Close on any scroll so the fixed-position menu doesn't float detached
    // from its chat row when the sidebar list scrolls.
    const onScroll = () => closeChatMenu();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [menuChatId]);

  useEffect(() => {
    if (!userMenuOpen) return;
    placeUserMenu();
    const onClick = (e) => {
      if (e.target?.closest?.("[data-user-menu]")) return;
      if (userMenuRef.current?.contains(e.target)) return;
      setUserMenuOpen(false);
    };
    const onReposition = () => placeUserMenu();
    document.addEventListener("mousedown", onClick);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMenuOpen, open]);

  useEffect(() => { setUserMenuOpen(false); }, [open]);

  const deleteBoard = async (chatId) => {
    if (!user?.id) return;
    if (!window.confirm("Delete this chat? This cannot be undone.")) return;
    closeChatMenu();
    // Optimistic remove + block route-merge resurrection so the row doesn't
    // flash as a duplicate while the DB delete / navigation catch up.
    markLyknChatDeleted(chatId);
    removeLyknChatFromListQueries(queryClient, user.id, chatId);
    if (localStorage.getItem("lyknchat_active_id") === chatId) {
      localStorage.removeItem("lyknchat_active_id");
    }
    if (location.pathname === `/chat/${chatId}`) nav("/app", { replace: true });

    const [, chatRes] = await Promise.all([
      supabase.from("lykn_chat_states").delete().eq("chat_id", chatId),
      supabase.from("lykn_chats").delete().eq("id", chatId).eq("user_id", user.id),
    ]);
    if (chatRes?.error) {
      invalidateLyknChatListQueries(queryClient, user.id);
      return;
    }
    window.dispatchEvent(new Event("lykinsai_chats_changed"));
  };

  const renameBoard = async (chatId) => {
    if (!user?.id) return;
    let currentTitle = "New Chat";
    try {
      const { data } = await supabase
        .from("lykn_chats")
        .select("title")
        .eq("id", chatId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (data?.title) currentTitle = data.title;
    } catch { /* fall back to default title */ }
    const next = window.prompt("Rename chat", currentTitle);
    if (next === null) return;
    const name = next.trim() || "New Chat";
    await supabase
      .from("lykn_chats")
      .update({ title: name, updated_at: new Date().toISOString() })
      .eq("id", chatId)
      .eq("user_id", user.id);
    closeChatMenu();
    window.dispatchEvent(new Event("lykinsai_chats_changed"));
  };

  const togglePinBoard = async (chatId, currentlyPinned) => {
    if (!user?.id) return;
    closeChatMenu();
    const nextPinnedAt = currentlyPinned ? null : new Date().toISOString();
    patchLyknChatPinnedInListQueries(queryClient, user.id, chatId, nextPinnedAt);
    const { error } = await supabase
      .from("lykn_chats")
      .update({ pinned_at: nextPinnedAt })
      .eq("id", chatId)
      .eq("user_id", user.id);
    if (error) {
      invalidateLyknChatListQueries(queryClient, user.id);
      return;
    }
    window.dispatchEvent(new Event("lykinsai_chats_changed"));
  };

  const userMenuItems = (
    <>
      <button
        type="button"
        onClick={() => { setUserMenuOpen(false); nav("/synthesis-layer"); }}
        title="Synthesis Layer"
        className={`w-full text-left rounded-lg px-3 py-1.5 flex items-center gap-2 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors ${
          effectiveHighlightSynthesis ? "lykn-sidebar-synthesis-glow" : ""
        }`}
      >
        <Brain className={`w-3.5 h-3.5 ${effectiveHighlightSynthesis ? "text-blue-400" : "text-black/50 dark:text-white/50"}`} />
        Synthesis Layer
      </button>
      <div className="my-1 border-t border-black/5 dark:border-white/5" />
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
      {/* Both the full wordmark (open) and the collapsed icon toggle (closed)
          stay mounted, stacked at the same anchor, and cross-fade. The full
          logo fades in with a short delay so it lands as the panel finishes
          sliding open instead of popping in over the still-opening panel
          (the previous instant conditional swap caused that glitch). */}
      <div className="fixed left-2.5 top-3 z-[80] grid h-9 items-center">
        <span
          className={`col-start-1 row-start-1 flex items-center pl-1 select-none pointer-events-none transition-opacity duration-200 ${
            open ? "opacity-100 delay-150" : "opacity-0"
          }`}
          aria-hidden={!open}
        >
          <img
            src={lyknLogoBlueUrl}
            alt="LYKN"
            className="h-9 w-auto object-contain block dark:hidden"
            draggable={false}
          />
          <img
            src={lyknLogoUrl}
            alt="LYKN"
            className="h-9 w-auto object-contain hidden dark:block"
            draggable={false}
          />
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`group/toggle col-start-1 row-start-1 justify-self-start rounded-full w-9 h-9 hover:bg-blue-500/15 dark:hover:bg-blue-400/20 transition-opacity duration-150 flex items-center justify-center ${
            open ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
          title="Show panel"
          aria-hidden={open}
          tabIndex={open ? -1 : 0}
        >
          <LyknMark className="w-7 h-7 object-contain transition-opacity duration-150 group-hover/toggle:opacity-0" />
          <PanelLeftOpen className="absolute w-4 h-4 text-black/70 dark:text-white/70 opacity-0 transition-opacity duration-150 group-hover/toggle:opacity-100" />
        </button>
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
              location.pathname === "/app" || location.pathname.startsWith("/chat/") ? "bg-blue-500/10" : ""
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
            <Lock className="w-4 h-4 text-black/60 dark:text-white/60" />
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
            onClick={() => goTo("/projects")}
            className={`w-9 h-9 rounded-lg hover:bg-blue-500/15 transition-colors flex items-center justify-center ${
              location.pathname === "/projects" ? "bg-blue-500/10" : ""
            }`}
            title="Projects"
          >
            <FolderKanban className="w-4 h-4 text-black/60 dark:text-white/60" />
          </button>
        </div>

        <div className="flex-1" />

        <div className="flex-shrink-0 flex flex-col items-center pt-2 border-t border-black/5 dark:border-white/5 w-9">
          {user ? (
            <div className="relative" data-user-menu>
              <button
                ref={userBtnCollapsedRef}
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
                location.pathname === "/app" || location.pathname.startsWith("/chat/") ? "bg-blue-500/10" : ""
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
              <Lock className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
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
              onClick={() => goTo("/projects")}
              className={`w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 ${
                location.pathname === "/projects" ? "bg-blue-500/10" : ""
              }`}
            >
              <FolderKanban className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
              <span className="flex-1">Projects</span>
            </button>
          </div>
        </div>

        {/* ── Chats (scrollable) ── */}
        <div className="flex-1 min-h-0 flex flex-col mt-2">
          <div className="flex-shrink-0 flex items-center justify-between px-2 py-0.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/50 dark:text-white/50">Chats</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide">
            <ChatThreadSidebarGroups
              userId={user?.id}
              searchQuery={normalizedQuery}
              onOpenChat={(chatId) => {
                addOpenThread(chatId);
                goTo(`/chat/${chatId}`);
              }}
              menuChatId={menuChatId}
              onMenuOpen={openChatMenu}
              onMenuClose={closeChatMenu}
            />
          </div>
        </div>

        {/* ── Bottom: user bar (pinned) ── */}
        <div className="flex-shrink-0 pt-2 border-t border-black/5 dark:border-white/5 mt-1">
          {user ? (
            <div className="relative" data-user-menu>
              <button
                ref={userBtnExpandedRef}
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

      {menuChatId && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-40 rounded-lg border border-black/10 dark:border-white/12 bg-white dark:bg-[hsl(0_0%_16%)] shadow-lg p-1 text-[0.6875rem] text-black/85 dark:text-white/90"
          style={{
            // Clamp so the menu never renders past the viewport edge (rows near
            // the bottom of the chat list would otherwise push Delete off-screen).
            top: Math.max(8, Math.min(menuPos.top, window.innerHeight - 120)),
            left: Math.max(8, Math.min(menuPos.left, window.innerWidth - 168)),
          }}
        >
          <button
            type="button"
            className="w-full text-left rounded-md px-2.5 py-1.5 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
            onClick={() => renameBoard(menuChatId)}
          >
            Rename
          </button>
          <button
            type="button"
            className="w-full text-left rounded-md px-2.5 py-1.5 hover:bg-black/[0.06] dark:hover:bg-white/10 transition-colors"
            onClick={() => togglePinBoard(menuChatId, menuChatPinned)}
          >
            {menuChatPinned ? "Unpin chat" : "Pin chat"}
          </button>
          <button
            type="button"
            className="w-full text-left rounded-md px-2.5 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
            onClick={() => deleteBoard(menuChatId)}
          >
            Delete chat
          </button>
        </div>,
        document.body
      )}

      {/* Account menu portaled above vault trash (z-200) — opaque so trash can't bleed through. */}
      {userMenuOpen && user && ReactDOM.createPortal(
        <div
          ref={userMenuRef}
          data-user-menu
          className="fixed z-[9999] rounded-2xl border border-black/10 dark:border-white/12 bg-white dark:bg-[hsl(0_0%_16%)] shadow-lg p-1.5 text-[0.6875rem] text-black/85 dark:text-white/90"
          style={{
            bottom: userMenuPos.bottom,
            left: userMenuPos.left,
            width: userMenuPos.width,
          }}
        >
          {userMenuItems}
        </div>,
        document.body
      )}
    </>
  );
}
