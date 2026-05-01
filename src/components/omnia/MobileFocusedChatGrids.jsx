import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { LayoutGrid, Plus, Search as SearchIcon, SquarePen, X } from "lucide-react";
import { GridIcon } from "@/components/ui/GridIcon";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";
import { DEMO_GRID_LIST } from "@/lib/demoGrids";

const flushAndNavigate = (nav, path) => {
  window.dispatchEvent(new Event("omnia_flush_save"));
  setTimeout(() => nav(path), 80);
};

/**
 * Mobile-only entry point for switching between saved grids while in
 * focused chat mode. Renders a small icon button at the top-left of the
 * focused chat. Tapping it opens a bottom sheet with the user's grids
 * (and a "New Grid" affordance) so people can hop between conversations
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

  const { data: boards = [] } = useQuery({
    queryKey: ["boards", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data } = await supabase
        .from("omnia_boards")
        .select("id, title, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(100);
      return data || [];
    },
    enabled: !!user?.id,
  });

  useEffect(() => {
    const onBoardsChanged = () => queryClient.invalidateQueries({ queryKey: ["boards", user?.id] });
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
      return DEMO_GRID_LIST.map((g) => ({ id: g.id, title: g.title, updated_at: null }));
    }
    return boards;
  }, [user, boards]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((b) => String(b.title || "New Grid").toLowerCase().includes(needle));
  }, [list, search]);

  const goToGrid = (id) => {
    setOpen(false);
    if (location.pathname === `/grid/${id}`) return;
    flushAndNavigate(nav, `/grid/${id}`);
  };

  const createNewGrid = () => {
    const newId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setOpen(false);
    // Navigating to /grid/:id mounts a fresh OmniaGrid. On phone-class
    // viewports OmniaGrid auto-forces chatMode=true, so the user stays
    // in focused chat — no extra wiring needed here.
    flushAndNavigate(nav, `/grid/${newId}`);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed top-2 left-3 z-[71] inline-flex items-center gap-1.5 h-8 pl-2 pr-3 rounded-full bg-background/85 backdrop-blur-md border border-black/8 dark:border-white/10 shadow-sm text-[0.6875rem] font-medium text-black/75 dark:text-white/80 hover:bg-background transition-colors active:scale-[0.98]"
        aria-label="Open grids"
        title="Switch grids"
      >
        <LayoutGrid className="w-3.5 h-3.5 opacity-80" />
        Grids
      </button>

      {open && ReactDOM.createPortal(
        <div
          className="fixed inset-0 z-[260] flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="Your grids"
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
              <h2 className="text-base font-semibold text-black dark:text-white">Your grids</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-9 h-9 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center"
                aria-label="Close grids"
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
                  placeholder="Search grids"
                  className="w-full bg-transparent outline-none placeholder:text-black/40 dark:placeholder:text-white/40 text-black dark:text-white"
                />
              </div>
              <button
                type="button"
                onClick={createNewGrid}
                className="flex-shrink-0 inline-flex items-center gap-1.5 h-10 px-3 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 active:scale-[0.98] transition-all"
                title="New grid"
              >
                <SquarePen className="w-4 h-4" />
                New
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
              {!user ? (
                <div className="px-3 pt-1 pb-2 text-[0.75rem] text-black/55 dark:text-white/55">
                  Sign in to save and switch between your own grids. The list below is a demo.
                </div>
              ) : null}
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <div className="w-12 h-12 rounded-2xl bg-black/[0.04] dark:bg-white/5 flex items-center justify-center mb-3">
                    <LayoutGrid className="w-5 h-5 text-black/40 dark:text-white/40" />
                  </div>
                  <p className="text-sm text-black/60 dark:text-white/60 mb-3">
                    {search ? "No grids match your search." : "You don't have any grids yet."}
                  </p>
                  <button
                    type="button"
                    onClick={createNewGrid}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Create your first grid
                  </button>
                </div>
              ) : (
                <ul className="flex flex-col">
                  {filtered.map((b) => {
                    const isActive =
                      String(routeBoardId || "") === String(b.id) ||
                      location.pathname === `/grid/${b.id}`;
                    return (
                      <li key={b.id}>
                        <button
                          type="button"
                          onClick={() => goToGrid(b.id)}
                          className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors ${
                            isActive
                              ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                              : "hover:bg-black/[0.04] dark:hover:bg-white/5 text-black/85 dark:text-white/85"
                          }`}
                        >
                          <span
                            className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                              isActive
                                ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                : "bg-black/[0.05] dark:bg-white/5 text-black/55 dark:text-white/55"
                            }`}
                          >
                            <GridIcon className="w-4 h-4" />
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm font-medium truncate">
                              {b.title || "New Grid"}
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
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
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
