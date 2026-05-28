import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Edit2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search as SearchIcon,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { fetchBoardsWithContext, invalidateBoardListQueries, mergeActiveRouteBoard } from "@/lib/board/fetchBoardsWithContext";
import { useAuth } from "@/lib/SupabaseAuth";
import { isDemoGridId } from "@/lib/demoGrids";
import { requestGuestSignIn } from "@/lib/guestChatLimits";

const flushAndNavigate = (nav, path) => {
  window.dispatchEvent(new Event("omnia_flush_save"));
  setTimeout(() => nav(path), 80);
};

/**
 * Mobile-only entry point for switching between saved chats while in
 * focused chat mode. Renders a small icon button at the top-left of the
 * focused chat. Tapping it opens a bottom sheet with the user's chats
 * (and a "New Chat" affordance) so people can hop between conversations
 * without ever leaving the chat-only mobile shell.
 */
export default function MobileFocusedChatGrids() {
  const nav = useNavigate();
  const location = useLocation();
  const { boardId: routeBoardId } = useParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [actionFor, setActionFor] = useState(null); // { id, title }
  const actionSheetRef = useRef(null);

  const { data: boards = [] } = useQuery({
    queryKey: ["boards", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      return fetchBoardsWithContext(user.id, 100);
    },
    enabled: !!user?.id,
  });

  useEffect(() => {
    const onBoardsChanged = () => invalidateBoardListQueries(queryClient, user?.id);
    window.addEventListener("lykinsai_boards_changed", onBoardsChanged);
    return () => window.removeEventListener("lykinsai_boards_changed", onBoardsChanged);
  }, [queryClient, user?.id]);

  // Lock body scroll while the sheet is open so the page underneath
  // doesn't bounce when users scroll inside the drawer on iOS.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const list = useMemo(() => {
    if (!user) {
      const activeId = routeBoardId || "app";
      const title =
        location.pathname === "/app" || !routeBoardId ? "Your preview chat" : "Your chat";
      return [{ id: activeId, title, updated_at: null }];
    }
    return mergeActiveRouteBoard(boards, location.pathname);
  }, [user, boards, location.pathname, routeBoardId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((b) => String(b.title || "New Chat").toLowerCase().includes(needle));
  }, [list, search]);

  const goToGrid = (id) => {
    setOpen(false);
    if (!user) {
      const activeId = routeBoardId || "app";
      if (String(id) !== String(activeId)) {
        requestGuestSignIn("second_chat");
        return;
      }
    }
    if (id === "app") {
      if (location.pathname === "/app") return;
      flushAndNavigate(nav, "/app");
      return;
    }
    if (location.pathname === `/grid/${id}`) return;
    flushAndNavigate(nav, `/grid/${id}`);
  };

  const createNewGrid = () => {
    if (!user) {
      setOpen(false);
      requestGuestSignIn("new_chat");
      return;
    }
    const newId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setOpen(false);
    // Navigating to /grid/:id mounts a fresh OmniaGrid. On phone-class
    // viewports OmniaGrid auto-forces chatMode=true, so the user stays
    // in focused chat — no extra wiring needed here.
    flushAndNavigate(nav, `/grid/${newId}`);
  };

  const renameGrid = async (boardId, currentTitle) => {
    if (!user?.id) return;
    if (isDemoGridId(boardId)) return;
    const next = window.prompt("Rename chat", currentTitle || "New Chat");
    if (next === null) return;
    const name = next.trim() || "New Chat";
    const { error } = await supabase
      .from("omnia_boards")
      .update({ title: name, updated_at: new Date().toISOString() })
      .eq("id", boardId)
      .eq("user_id", user.id);
    setActionFor(null);
    if (error) {
      window.alert("Couldn't rename chat: " + error.message);
      return;
    }
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
    // Tell OmniaGrid (and anyone else mounted) so the in-memory title
    // for the active grid stays in sync — otherwise the next autosave
    // could clobber the new name with the stale local copy.
    window.dispatchEvent(
      new CustomEvent("omnia_board_renamed", { detail: { boardId, title: name } })
    );
  };

  const deleteGrid = async (boardId) => {
    if (!user?.id) return;
    if (isDemoGridId(boardId)) return;
    const ok = window.confirm("Delete this chat? This cannot be undone.");
    if (!ok) return;
    await supabase.from("omnia_board_states").delete().eq("board_id", boardId);
    const { error } = await supabase
      .from("omnia_boards")
      .delete()
      .eq("id", boardId)
      .eq("user_id", user.id);
    setActionFor(null);
    if (error) {
      window.alert("Couldn't delete chat: " + error.message);
      return;
    }
    if (localStorage.getItem("omnia_board_id") === boardId) {
      localStorage.removeItem("omnia_board_id");
    }
    window.dispatchEvent(new Event("lykinsai_boards_changed"));
    // If the user just nuked the grid they were sitting on, kick them
    // back to "/app" so OmniaGrid mounts a fresh board instead of trying
    // to load the one we just deleted.
    if (String(routeBoardId || "") === String(boardId) || location.pathname === `/grid/${boardId}`) {
      setOpen(false);
      flushAndNavigate(nav, "/app");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed top-2 left-3 z-[71] inline-flex items-center gap-1.5 h-8 pl-2 pr-3 rounded-full bg-background/85 backdrop-blur-md border border-black/8 dark:border-white/10 shadow-sm text-[0.6875rem] font-medium text-black/75 dark:text-white/80 hover:bg-background transition-colors active:scale-[0.98]"
        aria-label="Open chats"
        title="Switch chats"
      >
        <MessageSquare className="w-3.5 h-3.5 opacity-80" />
        Chats
      </button>

      {open && ReactDOM.createPortal(
        <div
          className="fixed inset-0 z-[260] flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="Your chats"
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
          />
          <div
            className="relative mt-auto w-full max-h-[85vh] flex flex-col rounded-t-2xl bg-white dark:bg-[#1c1c1e] border-t border-black/10 dark:border-white/10 shadow-2xl"
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            <div className="flex justify-center pt-2 pb-1">
              <span className="block w-10 h-1 rounded-full bg-black/15 dark:bg-white/20" />
            </div>

            <div className="flex items-center justify-between px-4 pt-1 pb-2">
              <h2 className="text-base font-semibold text-black dark:text-white">Your chats</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-9 h-9 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center"
                aria-label="Close chats"
              >
                <X className="w-4 h-4 text-black/70 dark:text-white/70" />
              </button>
            </div>

            <div className="px-4 pb-2 flex items-center gap-2">
              <div className="flex-1 min-w-0 flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/5 px-3 py-2 text-sm">
                <SearchIcon className="w-4 h-4 text-black/40 dark:text-white/40 flex-shrink-0" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search chats"
                  className="w-full bg-transparent outline-none placeholder:text-black/40 dark:placeholder:text-white/40 text-black dark:text-white"
                />
              </div>
              <button
                type="button"
                onClick={createNewGrid}
                className="flex-shrink-0 inline-flex items-center gap-1.5 h-10 px-3 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 active:scale-[0.98] transition-all"
                title="New chat"
              >
                <SquarePen className="w-4 h-4" />
                New
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
              {!user ? (
                <div className="px-3 pt-1 pb-2 text-[0.75rem] text-black/55 dark:text-white/55">
                  One free preview chat per visit. Sign in to save work and start more chats.
                </div>
              ) : null}
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <div className="w-12 h-12 rounded-2xl bg-black/[0.04] dark:bg-white/5 flex items-center justify-center mb-3">
                    <MessageSquare className="w-5 h-5 text-black/40 dark:text-white/40" />
                  </div>
                  <p className="text-sm text-black/60 dark:text-white/60 mb-3">
                    {search ? "No chats match your search." : "You don't have any chats yet."}
                  </p>
                  <button
                    type="button"
                    onClick={createNewGrid}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Start your first chat
                  </button>
                </div>
              ) : (
                <ul className="flex flex-col">
                  {filtered.map((b) => {
                    const isActive =
                      String(routeBoardId || "") === String(b.id) ||
                      location.pathname === `/grid/${b.id}`;
                    const canEdit = !!user && !isDemoGridId(b.id);
                    return (
                      <li key={b.id} className="relative">
                        <div
                          className={`w-full flex items-center gap-3 pl-3 pr-1 py-2 rounded-xl transition-colors ${
                            isActive
                              ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                              : "hover:bg-black/[0.04] dark:hover:bg-white/5 text-black/85 dark:text-white/85"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => goToGrid(b.id)}
                            className="flex-1 min-w-0 flex items-center gap-3 py-1 text-left"
                          >
                            <span
                              className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                                isActive
                                  ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                  : "bg-black/[0.05] dark:bg-white/5 text-black/55 dark:text-white/55"
                              }`}
                            >
                              <MessageSquare className="w-4 h-4" />
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm font-medium truncate">
                                {b.title || "New Chat"}
                              </span>
                              {b.updated_at && (
                                <span className="block text-[0.6875rem] text-black/45 dark:text-white/45 truncate">
                                  Updated {formatRelative(b.updated_at)}
                                </span>
                              )}
                            </span>
                            {isActive && (
                              <span className="flex-shrink-0 text-[0.625rem] uppercase tracking-wider font-semibold text-blue-600 dark:text-blue-400">
                                Open
                              </span>
                            )}
                          </button>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setActionFor({ id: b.id, title: b.title || "New Chat" });
                              }}
                              className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-black/55 dark:text-white/55 hover:bg-black/[0.05] dark:hover:bg-white/8 active:scale-95 transition-all"
                              aria-label={`More options for ${b.title || "New Chat"}`}
                              title="More"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {actionFor && (
            <div
              className="absolute inset-0 z-[10] flex items-end"
              onClick={() => setActionFor(null)}
            >
              <div className="absolute inset-0 bg-black/30" />
              <div
                ref={actionSheetRef}
                className="relative w-full mx-2 mb-2 rounded-2xl bg-white dark:bg-[#2a2a2c] border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden"
                style={{ marginBottom: "max(env(safe-area-inset-bottom, 0px), 8px)" }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-4 pt-3 pb-2 border-b border-black/5 dark:border-white/5">
                  <p className="text-[0.6875rem] uppercase tracking-wider text-black/45 dark:text-white/45 font-semibold">
                    Chat options
                  </p>
                  <p className="text-sm text-black/85 dark:text-white/85 truncate mt-0.5">
                    {actionFor.title}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => renameGrid(actionFor.id, actionFor.title)}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left text-sm text-black/85 dark:text-white/85 hover:bg-black/[0.04] dark:hover:bg-white/5 active:bg-black/[0.08] dark:active:bg-white/10 transition-colors"
                >
                  <Edit2 className="w-4 h-4 opacity-70" />
                  Rename chat
                </button>
                <button
                  type="button"
                  onClick={() => deleteGrid(actionFor.id)}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-500/5 active:bg-red-500/10 transition-colors border-t border-black/5 dark:border-white/5"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete chat
                </button>
                <button
                  type="button"
                  onClick={() => setActionFor(null)}
                  className="w-full flex items-center justify-center px-4 py-3.5 text-sm font-medium text-black/70 dark:text-white/70 border-t border-black/5 dark:border-white/5 hover:bg-black/[0.04] dark:hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}

function formatRelative(iso) {
  try {
    const then = new Date(iso).getTime();
    if (!isFinite(then)) return "";
    const diff = Date.now() - then;
    const m = Math.round(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d}d ago`;
    const w = Math.round(d / 7);
    if (w < 5) return `${w}w ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return "";
  }
}
