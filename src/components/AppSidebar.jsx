import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Bot,
  Brain,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Edit2,
  Bug,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Plug,
  Plus,
  SquarePen,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import FeedbackModal from "@/components/FeedbackModal";
import { supabase } from "@/lib/supabase";
import { fetchBoardsWithContext, invalidateBoardListQueries, mergeActiveRouteBoard } from "@/lib/board/fetchBoardsWithContext";
import { useAuth } from "@/lib/SupabaseAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import SignInPill from "@/components/SignInPill";
import { isAgentStudioEnabled } from "@/lib/agentStudioDev";

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

  const handleNewChat = () => {
    if (!user?.id) return;
    const newId = crypto.randomUUID();
    goTo(`/grid/${newId}`);
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
  const [searchQuery, setSearchQuery] = useState("");
  const menuRef = useRef(null);

  const { data: boards = [] } = useQuery({
    queryKey: ["boards", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      return fetchBoardsWithContext(user.id, 50);
    },
    enabled: !!user?.id,
  });

  // Filter chats by the sidebar search input. Case-insensitive match
  // against the board title; empty query passes everything through.
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleBoards = mergeActiveRouteBoard(boards, location.pathname);
  const filteredBoards = normalizedQuery
    ? visibleBoards.filter((b) =>
        (b.title || "New Chat").toLowerCase().includes(normalizedQuery),
      )
    : visibleBoards;

  useEffect(() => {
    const onBoardsChanged = () => invalidateBoardListQueries(queryClient, user?.id);
    window.addEventListener("lykinsai_boards_changed", onBoardsChanged);
    return () => {
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
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuBoardId(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuBoardId]);

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
        <SignInPill />
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
              className="w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
            >
              <MessageCircle className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
              Chat
            </button>
          </div>

          <div className="flex flex-col gap-0.5 mt-0.5">
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
              onClick={() => goTo("/vault")}
              className="w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2"
            >
              <Plug className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
              Connections
            </button>
            {isAgentStudioEnabled && user ? (
              <button
                type="button"
                onClick={() => goTo("/agents")}
                className={`w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 ${
                  location.pathname === "/agents" ? "bg-blue-500/10" : ""
                }`}
              >
                <Bot className="w-3.5 h-3.5 text-black/60 dark:text-white/60" />
                <span className="flex-1">Agents</span>
                <span className="text-[0.5625rem] uppercase tracking-wide text-violet-500/80 dark:text-violet-300/80">
                  Dev
                </span>
              </button>
            ) : null}
          </div>
        </div>

        {/* ── Chats (scrollable) ── */}
        <div className="flex-1 min-h-0 flex flex-col mt-2">
          <div className="flex-shrink-0 flex items-center justify-between px-2 py-0.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-black/50 dark:text-white/50">Chats</span>
          </div>
          <div className="flex-shrink-0">
            <button
              type="button"
              onClick={handleNewChat}
              className="w-full text-left text-[0.6875rem] px-2.5 py-1 rounded-md hover:bg-blue-500/15 transition-colors flex items-center gap-2 text-black/60 dark:text-white/60"
            >
              <Plus className="w-3.5 h-3.5" />
              Add New Chat
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide">
            <div className="flex flex-col gap-0.5">
              {!user?.id ? (
                <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1">No chats yet</div>
              ) : boards.length === 0 ? (
                <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1">No chats yet</div>
              ) : filteredBoards.length === 0 ? (
                <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1">No matches</div>
              ) : (
                filteredBoards.map((board) => {
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
                        <span className="truncate">{board.title || "New Chat"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (menuBoardId === board.id) {
                            setMenuBoardId(null);
                          } else {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setMenuPos({ top: rect.bottom + 4, left: rect.right });
                            setMenuBoardId(board.id);
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
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600 dark:text-red-400 transition-colors"
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
