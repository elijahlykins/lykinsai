// Bottom dock — the studio sidebar, macOS style: the LYKN icon with its chat
// history popover and context menu, the app buttons (built-in, installed, and
// synced Mac apps), and dock tiles for minimized file windows.
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  File as FileIcon,
  Loader2,
  MessageCircle,
  Search,
  SquarePen,
} from "lucide-react";
import lyknIconUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-master.png";
import lyknIconBlueUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-BLUE-master.png";
import {
  fetchLyknChatsPage,
  searchLyknChatsByTitle,
  SIDEBAR_PAGE_SIZE,
} from "@/lib/lyknChat/fetchLyknChatsWithContext";
import StudioPop from "@/components/macdesktop/StudioPop";
import MacAppDock from "@/components/macdock/MacAppDock";
import InstalledAppDock from "@/components/macdock/InstalledAppDock";
import { DockContextMenu, openLyknChat } from "@/components/macdock/DockContextMenu";
import BrowserMark from "@/components/macdesktop/BrowserMark";
import { fileSourceName } from "@/lib/files/fileSource";
import {
  BAR,
  CUSTOM_APP_NEIGHBORS,
  DOCK_ITEMS,
  DRAG,
  NO_DRAG,
} from "@/components/studio/studioAppRegistry";

function relTime(ms) {
  const t = typeof ms === "string" ? new Date(ms).getTime() : Number(ms);
  if (!t || Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Dock icon popover — paginates the full chat history, same as the in-app sidebar. */
function DockChatsList({ userId, search, onOpen }) {
  const needle = String(search || "").trim().toLowerCase();
  const sentinelRef = useRef(null);

  const {
    data: pageData,
    isLoading: listLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["sidebar-boards-paged", userId],
    queryFn: ({ pageParam }) => fetchLyknChatsPage(userId, pageParam, SIDEBAR_PAGE_SIZE),
    enabled: !!userId && !needle,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });

  const { data: searchResults = [], isLoading: searchLoading } = useQuery({
    queryKey: ["sidebar-boards-search", userId, needle],
    queryFn: () => searchLyknChatsByTitle(userId, needle, 200),
    enabled: !!userId && !!needle,
  });

  const listChats = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const page of pageData?.pages || []) {
      for (const chat of page.rows || []) {
        if (seen.has(chat.id)) continue;
        seen.add(chat.id);
        out.push(chat);
      }
    }
    return out;
  }, [pageData]);

  const chats = needle ? searchResults : listChats;
  const isLoading = needle ? searchLoading : listLoading;

  useEffect(() => {
    if (needle) return;
    const el = sentinelRef.current;
    if (!el) return;
    let root = el.parentElement;
    while (root && root !== document.body) {
      const oy = getComputedStyle(root).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      root = root.parentElement;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { root: root && root !== document.body ? root : null, rootMargin: "120px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [needle, hasNextPage, isFetchingNextPage, fetchNextPage, isLoading, chats.length]);

  if (!userId) {
    return <p className="px-3 py-2 text-[0.68rem] text-white/35">No chats yet</p>;
  }

  if (isLoading && chats.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[0.68rem] text-white/35">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </div>
    );
  }

  const waitingOnOlder = !needle && (hasNextPage || isFetchingNextPage);
  if (chats.length === 0 && !waitingOnOlder) {
    return (
      <p className="px-3 py-2 text-[0.68rem] text-white/35">
        {needle ? "No matches" : "No chats yet"}
      </p>
    );
  }

  return (
    <>
      {chats.map((chat) => (
        <button
          key={chat.id}
          type="button"
          onClick={() => onOpen(chat.id)}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left hover:bg-white/[0.08] transition-colors"
        >
          <MessageCircle className="h-3.5 w-3.5 flex-shrink-0 text-white/35" />
          <span className="min-w-0 flex-1 truncate text-[0.74rem] text-white/80">
            {chat.title || "Untitled chat"}
          </span>
          <span className="flex-shrink-0 text-[0.58rem] text-white/30">
            {relTime(chat.updated_at)}
          </span>
        </button>
      ))}
      {!needle && (
        <>
          <div ref={sentinelRef} aria-hidden className="h-px w-full" />
          {isFetchingNextPage ? (
            <div className="flex items-center gap-2 px-3 py-1.5 text-[0.68rem] text-white/35">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </div>
          ) : hasNextPage ? (
            <button
              type="button"
              onClick={() => fetchNextPage()}
              className="w-full rounded-xl px-3 py-1.5 text-left text-[0.68rem] text-white/45 hover:bg-white/[0.08] hover:text-white/70 transition-colors"
            >
              Load older chats
            </button>
          ) : null}
        </>
      )}
    </>
  );
}

export function CircleIconButton({
  icon: Icon,
  active,
  label,
  onClick,
  expanded = false,
  menuItems,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="relative flex-shrink-0" style={NO_DRAG}>
      <button
        type="button"
        onClick={(e) => {
          setMenuOpen(false);
          onClick?.(e);
        }}
        onContextMenu={
          menuItems
            ? (e) => {
                e.preventDefault();
                setMenuOpen((v) => !v);
              }
            : undefined
        }
        title={expanded ? undefined : `${label} · ⌥-click to split`}
        aria-label={label}
        style={NO_DRAG}
        className={`flex h-10 flex-shrink-0 items-center overflow-hidden rounded-full transition-all duration-200 active:scale-90 ${
          expanded ? "w-full px-3" : "w-10 justify-center"
        } ${
          active
            ? "bg-black/85 text-white shadow-lg dark:bg-white dark:text-black"
            : "text-white/65 hover:bg-white/15"
        }`}
      >
        <Icon
          className={`${
            Icon === BrowserMark ? "h-[1.25rem] w-[1.25rem]" : "h-[1.05rem] w-[1.05rem]"
          } flex-shrink-0`}
        />
        {/* Always mounted so the label slides/fades with the width animation
            instead of popping in mid-transition. */}
        <span
          aria-hidden={!expanded}
          className={`min-w-0 truncate text-[0.78rem] font-medium transition-all duration-150 ${
            expanded ? "ml-2.5 max-w-full opacity-100 delay-75" : "ml-0 max-w-0 opacity-0"
          }`}
        >
          {label}
        </span>
      </button>
      {menuItems ? (
        <DockContextMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={menuItems}
        />
      ) : null}
    </div>
  );
}

export default function StudioDock({
  user,
  dark,
  desktop,
  hidden,
  split,
  coveringZoom,
  chatsOpen,
  setChatsOpen,
  startNewChat,
  openTab,
  homeChat,
  setHomeChat,
  hiddenDockIds,
  keepInDock,
  navActive,
  handleNavItem,
  dockMenuFor,
  handleEditApp,
  appWins,
  closeAppWindow,
  focusAppWindow,
  minimizedFileWins,
}) {
  // Dock chats popover — the LYKN icon opens a panel with search + the full
  // chat history, like the in-app sidebar.
  const [chatsSearch, setChatsSearch] = useState("");
  const [lyknMenuOpen, setLyknMenuOpen] = useState(false);
  const dockRef = useRef(null);

  // Close the dock's chats popover on outside click / Escape.
  useEffect(() => {
    if (!chatsOpen) return;
    const onDown = (e) => {
      if (dockRef.current && !dockRef.current.contains(e.target)) setChatsOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setChatsOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [chatsOpen, setChatsOpen]);

  // The chats popover hangs off the dock; a hidden dock must not leave it
  // floating (or reappear with a stale popover already open).
  useEffect(() => {
    if (hidden) setChatsOpen(false);
  }, [hidden, setChatsOpen]);

  const dockNeighbors = CUSTOM_APP_NEIGHBORS.filter(
    (item) => !hiddenDockIds.includes(item.id) || appWins.includes(item.id),
  );

  return (
    <div
      ref={dockRef}
      className={`relative z-30 mt-3 flex-shrink-0 select-none transition-all duration-300 ${
        split || coveringZoom
          ? "hidden"
          : hidden
            ? "pointer-events-none translate-y-[135%] opacity-0"
            : ""
      }`}
    >
      {/* Chats popover — search + new chat + full history, like the
          in-app sidebar. Hangs above the dock, macOS-Dock style. */}
      <StudioPop
        open={chatsOpen}
        origin="12% 100%"
        className={`absolute bottom-full left-0 z-10 mb-3 flex max-h-[32rem] w-80 flex-col rounded-[1.6rem] p-2 ${BAR}`}
      >
          <div className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap px-1">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-white/55">
              <Search className="h-3.5 w-3.5 flex-shrink-0" />
              <input
                autoFocus
                value={chatsSearch}
                onChange={(e) => setChatsSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setChatsSearch("");
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Search chats"
                autoComplete="off"
                className="w-full min-w-0 bg-transparent text-[0.72rem] text-white/85 outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 placeholder:text-white/35"
              />
            </div>
            <button
              type="button"
              onClick={startNewChat}
              title="New chat"
              aria-label="New chat"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-white/55 hover:bg-white/15 hover:text-white transition-colors"
            >
              <SquarePen className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-1.5 flex-shrink-0 whitespace-nowrap px-3">
            <span className="text-[0.6rem] font-semibold uppercase tracking-widest text-white/40">
              Chat history
            </span>
          </div>
          <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5 scrollbar-hide">
            <DockChatsList
              userId={user?.id}
              search={chatsSearch}
              onOpen={(id) =>
                openTab("chat", `/chat/${encodeURIComponent(id)}`)
              }
            />
          </div>
      </StudioPop>

      {/* The pill itself is a window drag surface; every control inside
          opts out with no-drag so clicks land normally. */}
      <div
        className={`flex items-center gap-1 rounded-full p-1.5 ${BAR}`}
        style={DRAG}
        onContextMenu={(e) => {
          e.preventDefault();
          setChatsOpen(false);
        }}
      >
        {/* LYKN icon — full chat history, like the app sidebar's header. */}
        <div className="relative flex-shrink-0" style={NO_DRAG}>
          <button
            type="button"
            onClick={() => {
              setLyknMenuOpen(false);
              setChatsOpen((v) => !v);
            }}
            onDoubleClick={() => openTab("dashboard")}
            onContextMenu={(e) => {
              e.preventDefault();
              setChatsOpen(false);
              setLyknMenuOpen((v) => !v);
            }}
            title={chatsOpen ? "Close chats" : "Chat history · Double-click for Home"}
            aria-label={chatsOpen ? "Close chats" : "Chat history"}
            aria-expanded={chatsOpen}
            className={`grid h-10 w-10 flex-shrink-0 place-items-center rounded-full transition-colors ${
              chatsOpen || lyknMenuOpen ? "bg-white/15" : "hover:bg-white/15"
            }`}
          >
            <img
              src={dark ? lyknIconUrl : lyknIconBlueUrl}
              alt=""
              className="h-8 w-8 object-contain"
              draggable={false}
            />
          </button>
          <DockContextMenu
            open={lyknMenuOpen}
            onClose={() => setLyknMenuOpen(false)}
            align="start"
            items={[
              { label: "Chat with LYKN", onClick: () => openLyknChat() },
              { label: "New Chat", onClick: () => void startNewChat() },
              {
                label: chatsOpen ? "Hide chat history" : "Chat history",
                onClick: () => setChatsOpen((v) => !v),
              },
              { separator: true },
              { label: "Home", onClick: () => openTab("dashboard") },
              ...(homeChat
                ? [{ label: "Close chat", onClick: () => setHomeChat(false) }]
                : []),
              ...(hiddenDockIds.length
                ? [
                    { separator: true },
                    ...CUSTOM_APP_NEIGHBORS.filter((item) =>
                      hiddenDockIds.includes(item.id),
                    ).map((item) => ({
                      label: `Add ${item.label} to Dock`,
                      onClick: () => keepInDock(item.id),
                    })),
                  ]
                : []),
            ]}
          />
        </div>
        {DOCK_ITEMS.map((item) => (
          <CircleIconButton
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={navActive(item)}
            onClick={(e) => handleNavItem(item, e)}
            menuItems={dockMenuFor(item)}
          />
        ))}
        {/* Apps LYKN built for this user. Each opens in its own window on
            its own origin, so these launch rather than open a stage tab.
            Renders nothing until something is installed. */}
        {desktop && (
          <InstalledAppDock
            noDragStyle={NO_DRAG}
            onEdit={handleEditApp}
            openIds={appWins}
            onCloseWindow={closeAppWindow}
          />
        )}
        {dockNeighbors.map((item) => (
          <CircleIconButton
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={navActive(item)}
            onClick={(e) => handleNavItem(item, e)}
            menuItems={dockMenuFor(item)}
          />
        ))}
        {/* The user's Mac apps — launchable from inside LYKN, with
            running indicators (Sync with Mac). */}
        {desktop && (
          <div style={NO_DRAG} className="flex items-center">
            <MacAppDock />
          </div>
        )}
        {/* Minimized file windows. A file has no dock icon of its own to
            drop back into, so it keeps a tile here while it's tucked away
            — otherwise the yellow light would be a one-way door. */}
        {minimizedFileWins.map((entry) => (
          <CircleIconButton
            key={entry.id}
            icon={FileIcon}
            label={fileSourceName(entry.source)}
            onClick={() => focusAppWindow(entry.id)}
            menuItems={[
              { label: "Open", onClick: () => focusAppWindow(entry.id) },
              { label: "Close", onClick: () => closeAppWindow(entry.id) },
            ]}
          />
        ))}
      </div>
    </div>
  );
}
