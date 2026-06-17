import React, { useEffect, useMemo } from "react";
import { Loader2, MoreHorizontal } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { isThreadLoading, subscribeThreadRuntime } from "@/lib/chat/chatThreadRuntime";
import { fetchLyknChatsWithContext, mergeActiveRouteLyknChat } from "@/lib/lyknChat/fetchLyknChatsWithContext";
import { filterLyknChatsByChatModel } from "@/lib/lyknChat/chatModelKey";

const COLLAPSED_GROUP_SIZE = 5;

function normalizeSearch(q) {
  return String(q || "").trim().toLowerCase();
}

function boardTime(board) {
  return new Date(board.updated_at || board.created_at || 0).getTime();
}

const TIME_GROUPS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 Days" },
  { key: "last30", label: "Last 30 Days" },
  { key: "older", label: "Older" },
];

function bucketForTime(time, now) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (time >= startOfTodayMs) return "today";
  if (time >= startOfTodayMs - dayMs) return "yesterday";
  if (time >= startOfTodayMs - 7 * dayMs) return "last7";
  if (time >= startOfTodayMs - 30 * dayMs) return "last30";
  return "older";
}

function groupBoardsByTime(boards) {
  const now = Date.now();
  const buckets = new Map(TIME_GROUPS.map((g) => [g.key, []]));
  for (const board of boards) {
    buckets.get(bucketForTime(boardTime(board), now)).push(board);
  }
  return TIME_GROUPS.map((g) => ({ ...g, boards: buckets.get(g.key) })).filter(
    (g) => g.boards.length > 0,
  );
}

function ChatRow({ board, isActive, loading, onOpen, menuChatId, onMenuChatId, onMenuPos }) {
  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        onClick={() => onOpen(board.id)}
        className={cn(
          "flex-1 min-w-0 text-left text-[0.6875rem] pl-2.5 pr-7 py-1 rounded-md flex items-center gap-2 transition-colors",
          isActive ? "bg-blue-500/15" : "hover:bg-blue-500/10",
        )}
      >
        {loading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-500" />
        ) : (
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full flex-shrink-0",
              isActive ? "bg-blue-500" : "bg-black/30 dark:bg-white/30",
            )}
          />
        )}
        <span className="truncate">{board.title || "New Chat"}</span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (menuChatId === board.id) {
            onMenuChatId(null);
          } else {
            const rect = e.currentTarget.getBoundingClientRect();
            onMenuPos({ top: rect.bottom + 4, left: rect.right });
            onMenuChatId(board.id);
          }
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-blue-500/15 transition-opacity"
      >
        <MoreHorizontal className="w-3 h-3 text-black/50 dark:text-white/50" />
      </button>
    </div>
  );
}

export default function ChatThreadSidebarGroups({
  userId,
  modelFilter,
  searchQuery,
  onOpenChat,
  menuChatId,
  onMenuChatId,
  onMenuPos,
}) {
  const location = useLocation();
  const needle = normalizeSearch(searchQuery);
  const [, bump] = React.useReducer((n) => n + 1, 0);
  const [expandedGroups, setExpandedGroups] = React.useState(() => new Set());

  const toggleGroup = React.useCallback((key) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => subscribeThreadRuntime(() => bump()), []);

  const { data: boards = [], isLoading } = useQuery({
    queryKey: ["boards", userId],
    queryFn: () => fetchLyknChatsWithContext(userId, 50),
    enabled: !!userId,
  });

  const visibleBoards = useMemo(
    () => mergeActiveRouteLyknChat(boards, location.pathname),
    [boards, location.pathname],
  );

  const filteredBoards = useMemo(() => {
    let list = filterLyknChatsByChatModel(visibleBoards, modelFilter);
    if (needle) {
      list = list.filter((b) =>
        String(b.title || "New Chat").toLowerCase().includes(needle),
      );
    }
    return list;
  }, [visibleBoards, modelFilter, needle]);

  const groupedBoards = useMemo(
    () => groupBoardsByTime(filteredBoards),
    [filteredBoards],
  );

  if (!userId) {
    return (
      <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1">
        No chats yet
      </div>
    );
  }

  if (isLoading && !filteredBoards.length) {
    return (
      <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </div>
    );
  }

  if (!filteredBoards.length) {
    return (
      <div className="text-[0.6875rem] text-black/40 dark:text-white/40 px-2.5 py-1">
        {needle || modelFilter !== "all" ? "No matches" : "No chats yet"}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {groupedBoards.map((group) => {
        const isExpanded = expandedGroups.has(group.key);
        const hasOverflow = group.boards.length > COLLAPSED_GROUP_SIZE;
        const visible =
          isExpanded || !hasOverflow
            ? group.boards
            : group.boards.slice(0, COLLAPSED_GROUP_SIZE);
        const hiddenCount = group.boards.length - visible.length;

        return (
          <div key={group.key} className="flex flex-col gap-0.5">
            <div className="px-2.5 pt-1 pb-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
              {group.label}
            </div>
            {visible.map((board) => (
              <ChatRow
                key={board.id}
                board={board}
                isActive={location.pathname === `/chat/${board.id}`}
                loading={isThreadLoading(board.id)}
                onOpen={onOpenChat}
                menuChatId={menuChatId}
                onMenuChatId={onMenuChatId}
                onMenuPos={onMenuPos}
              />
            ))}
            {hasOverflow && (
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                className="text-left text-[0.6875rem] pl-2.5 pr-2 py-1 rounded-md text-black/50 dark:text-white/50 hover:bg-blue-500/10 hover:text-black/70 dark:hover:text-white/70 transition-colors"
              >
                {isExpanded ? "Show less" : `More (${hiddenCount})`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
