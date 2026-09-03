// useBotChatBridge owns the chat page's Bot integration: sending a turn to a
// Bot (prompt row with attachment chips + streamed reply patched in place),
// re-attaching rows to live streams after a remount (and catching up rows
// whose task settled off-screen), the "jump to a Bot's board" hop, marking a
// Bot's result seen while standing on its board, and holding a Bot send that
// arrives mid-hydration until this surface owns the chat route. Extracted
// verbatim from src/pages/LyknChat.tsx (LyknChat decomposition phase, see
// docs/REFACTOR_LOG.md).
import { useCallback, useEffect, useRef } from "react";
import {
  BOT_THREAD_PRESENT_EVENT,
  followBotTask,
  sendBotChatTurn,
} from "@/lib/bots/botChatBridge";
import { botDeliverableToolCalls } from "@/lib/bots/botDeliverableCards";
import type { BotDeliverable } from "@/lib/bots/botStore";
import {
  botHasUnseenResult,
  ensureBotSessionBoard,
  getBot,
  getBots,
  markBotSeen,
  subscribeBots,
} from "@/lib/bots/botsClient";
import {
  addOpenThread,
  dispatchThreadRuntimeChange,
  ensureThreadSnapshot,
  getThreadSnapshot,
} from "@/lib/chat/chatThreadRuntime";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import { maybeAutoNameChat } from "@/lib/ai/chatResultReconciliation";
import { notifyLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";
import { persistOffRouteThread } from "@/lib/lyknChat/persistThreadChat";
import type {
  BotSendAttachment,
  FocusedChatAttachment,
  PromptMessage,
} from "@/lib/lyknChat/chatTurnTypes";

/** One streamed update from followBotTask applied to the row it drives. */
type BotRowUpdate = {
  text: string;
  done?: boolean;
  working?: boolean;
  status?: string;
  deliverables?: BotDeliverable[];
};

/**
 * The final reply replaces everything the task streamed — so the work the
 * task produced (report document, built artifact, image) rides the settled
 * update as deliverables and lands on the row as tool calls, which the chat
 * renders as persistent artifact cards beside the closing message.
 */
function patchedBotRow(row: PromptMessage, update: BotRowUpdate): PromptMessage {
  return {
    ...row,
    aiResponse: update.text,
    botWorking: !update.done && !!update.working,
    botStatus: String(update.status || ""),
    ...(update.done && update.deliverables?.length
      ? { toolCalls: botDeliverableToolCalls(row.id, update.deliverables) }
      : {}),
  };
}

export function useBotChatBridge({
  chatId,
  routeChatId,
  nav,
  chatMessages,
  setChatMessages,
  userId,
}: {
  chatId: string | null;
  routeChatId: string | null | undefined;
  nav: (to: string) => void;
  chatMessages: PromptMessage[];
  setChatMessages: React.Dispatch<React.SetStateAction<PromptMessage[]>>;
  userId?: string | null;
}) {
  // Tasks whose stream is already patching a row in THIS mount. Reset on
  // remount by design — that's exactly when re-attaching is needed.
  const followedBotTasksRef = useRef<Set<string>>(new Set());

  // Latest committed rows — settle-time persistence reads these instead of a
  // stale closure, so the saved list includes every turn on the board.
  const rowsRef = useRef<PromptMessage[]>(chatMessages);
  rowsRef.current = chatMessages;

  /**
   * A settled Bot turn must survive like any other chat turn: thread context
   * for the next LYKN send, a durable board save, and a real title instead
   * of "New Chat". Regular sends get all of this from the chat engine; Bot
   * turns bypass the engine, so before this ran here, a bot board only
   * persisted if its 2s debounce happened to fire — and never got named, so
   * it sat in history as "New Chat" or was culled as empty.
   */
  const settleBotTurn = useCallback(
    (boardId: string, botName: string, userText: string, rowId: string, update: BotRowUpdate) => {
      if (!boardId) return;
      // Board-scoped: if the user has moved on, the mounted list belongs to
      // another board — leave this board's snapshot alone (the re-attach
      // pass catches the row up on the next visit) but still save + name it.
      const onBoard = rowsRef.current.some((m) => m.id === rowId);
      const rows = onBoard
        ? rowsRef.current.map((m) => (m.id === rowId ? patchedBotRow(m, update) : m))
        : null;
      try {
        const snap = ensureThreadSnapshot(boardId);
        if (rows) {
          snap.chatMessages = rows;
          snap.updatedAt = Date.now();
        }
        snap.aiThread.push({ role: "user", content: `(asked ${botName}) ${userText}` });
        snap.aiThread.push({ role: "assistant", content: `(${botName} replied) ${update.text}` });
        if (snap.aiThread.length > 40) snap.aiThread.splice(0, snap.aiThread.length - 40);
        dispatchThreadRuntimeChange(boardId);
      } catch {
        /* the snapshot is a convenience; never fail a bot turn over it */
      }
      // Persist only when the snapshot actually holds this board's rows — an
      // empty snapshot written to the DB would clobber a previously saved
      // state (and empty boards are exactly the ones that should not save).
      const snap = getThreadSnapshot(boardId);
      if (snap && snap.chatMessages.length > 0) {
        void persistOffRouteThread(boardId, userId);
      }
      maybeAutoNameChat({
        chatId: boardId,
        userId,
        currentTitle: "",
        userMessage: userText,
        assistantReply: update.text,
      });
    },
    [userId],
  );

  const handleBotChatSend = useCallback(
    (botId: string, text: string, attachments: BotSendAttachment[] = []) => {
      const bot = getBot(botId);
      if (!bot) return;
      const msgId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const chatIdAtSend = String(routeChatId || "");
      // The prompt row shows the same chips a regular send would, so the user
      // can see their files actually went with the ask.
      const displayAtts: FocusedChatAttachment[] = attachments.map((a, i) => ({
        id: `bot-att-${msgId}-${i}`,
        type: a.kind === "image" ? "image" : "document",
        url: a.kind === "image" ? String(a.dataUrl || "") : "",
        name: a.name || "file",
        mime: "",
        size: 0,
      }));
      setChatMessages((prev) => [
        ...prev,
        {
          id: msgId,
          role: "user",
          content: text,
          kind: "prompt",
          aiResponse: "",
          ...(displayAtts.length ? { attachments: displayAtts } : {}),
          bot: { id: bot.id, name: bot.name, face: bot.face, eyes: bot.eyes, color: bot.color },
        } as PromptMessage,
      ]);
      // The ask itself is worth saving before the task settles — quitting
      // mid-task must not lose the prompt row (the mounted board's
      // persistence listens for this and saves from live refs).
      window.setTimeout(() => window.dispatchEvent(new Event("lyknchat_flush_save")), 600);
      const taskId = sendBotChatTurn(
        botId,
        text,
        (update: BotRowUpdate) => {
          setChatMessages((prev) =>
            prev.map((m) => (m.id === msgId ? patchedBotRow(m, update) : m)),
          );
          if (update.done) settleBotTurn(chatIdAtSend, bot.name, text, msgId, update);
        },
        attachments,
      );
      // Stamp the task on the row so it can re-attach after a remount, and
      // remember we're already streaming it so the re-attach effect skips it.
      if (taskId) {
        followedBotTasksRef.current.add(taskId);
        setChatMessages((prev) =>
          prev.map((m) => (m.id === msgId ? { ...m, botTaskId: taskId } : m)),
        );
      }
    },
    [routeChatId, setChatMessages, settleBotTurn],
  );

  const attachBotTaskRow = useCallback(
    (bot: NonNullable<ReturnType<typeof getBot>>, displayText: string, taskId: string) => {
      if (!bot || !taskId || followedBotTasksRef.current.has(taskId)) return;
      const msgId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const chatIdAtSend = String(routeChatId || "");
      followedBotTasksRef.current.add(taskId);
      setChatMessages((prev) => [
        ...prev,
        {
          id: msgId,
          role: "user",
          content: displayText,
          kind: "prompt",
          aiResponse: "",
          bot: { id: bot.id, name: bot.name, face: bot.face, eyes: bot.eyes, color: bot.color },
          botTaskId: taskId,
          botWorking: true,
        } as PromptMessage,
      ]);
      followBotTask(bot.id, taskId, (update: BotRowUpdate) => {
        setChatMessages((prev) =>
          prev.map((m) => (m.id === msgId ? patchedBotRow(m, update) : m)),
        );
        if (update.done) settleBotTurn(chatIdAtSend, bot.name, displayText, msgId, update);
      });
    },
    [routeChatId, setChatMessages, settleBotTurn],
  );

  // LYKN asked a teammate from this thread: stream that work here so the
  // user can watch without hopping to the bot's private board.
  useEffect(() => {
    const onPresent = (event: Event) => {
      const e = event as CustomEvent<{ botId?: string; taskId?: string; question?: string }>;
      const bot = getBot(String(e.detail?.botId || ""));
      const taskId = String(e.detail?.taskId || "");
      if (!bot || !taskId) return;
      e.preventDefault();
      attachBotTaskRow(bot, String(e.detail?.question || "").trim() || `Asked ${bot.name}`, taskId);
    };
    window.addEventListener(BOT_THREAD_PRESENT_EVENT, onPresent);
    return () => window.removeEventListener(BOT_THREAD_PRESENT_EVENT, onPresent);
  }, [attachBotTaskRow]);

  // Coming back to a Bot's chat mid-task: rows whose task is still in flight
  // re-attach to the live stream, and rows whose task settled while this
  // board was closed catch up to the final result. The bot keeps working
  // whether or not its chat is on screen — this only re-binds the view.
  useEffect(() => {
    if (!routeChatId || chatId !== routeChatId) return;
    // Scan committed state, not the ref — hydration may land the messages a
    // beat after chatId settles, and the deps re-run this scan when it does.
    // followedBotTasksRef keeps repeat scans from double-attaching.
    const lastRowByTask = new Map<string, PromptMessage>();
    for (const m of chatMessages) {
      if (m.bot?.id && m.botTaskId) lastRowByTask.set(m.botTaskId, m);
    }
    for (const [taskId, row] of lastRowByTask) {
      if (followedBotTasksRef.current.has(taskId)) continue;
      const bot = getBot(row.bot!.id);
      const task = bot?.tasks?.find((t: { id: string }) => t.id === taskId);
      if (!bot || !task) {
        // The bot (or its task log) is gone — nothing will ever finish this
        // row, so a working indicator persisted mid-task must not spin forever.
        if (row.botWorking) {
          const rowId = row.id;
          setChatMessages((prev) =>
            prev.map((m) => (m.id === rowId ? { ...m, botWorking: false } : m)),
          );
        }
        continue;
      }
      const settled = task.status === "done" || task.status === "failed";
      const finalText = String(task.result || "").trim() || "Done.";
      // Already showing the final result — leave the row alone, but retire a
      // working indicator persisted mid-task; the task is over.
      if (settled && String(row.aiResponse || "") === finalText) {
        if (row.botWorking) {
          const rowId = row.id;
          setChatMessages((prev) =>
            prev.map((m) => (m.id === rowId ? { ...m, botWorking: false } : m)),
          );
        }
        continue;
      }
      followedBotTasksRef.current.add(taskId);
      const msgId = row.id;
      const boardId = String(routeChatId || "");
      const userText = String(row.content || "");
      const botName = bot.name;
      followBotTask(bot.id, taskId, (update: BotRowUpdate) => {
        setChatMessages((prev) =>
          prev.map((m) => (m.id === msgId ? patchedBotRow(m, update) : m)),
        );
        if (update.done) settleBotTurn(boardId, botName, userText, msgId, update);
      });
    }
  }, [chatId, routeChatId, chatMessages, setChatMessages, settleBotTurn]);

  const mintBotBoard = useCallback(async () => {
    const id = String(userId || "").trim();
    if (!id) return "";
    const { chatId: fresh } = await createNewChat(id);
    addOpenThread(fresh);
    notifyLyknChatsChanged();
    return fresh;
  }, [userId]);

  const resolveBotBoard = useCallback(
    async (botId: string) => ensureBotSessionBoard(botId, mintBotBoard),
    [mintBotBoard],
  );

  // The chat bar's working-Bots strip (and its dropdown) asks this surface to
  // jump to a Bot's own thread. A warm surface hops on the event; a cold one
  // (the click also opened this window) picks up the parked hop on mount.
  useEffect(() => {
    const hop = (botId: string) => {
      void resolveBotBoard(botId).then((board) => {
        if (board && board !== routeChatId) nav(`/chat/${board}`);
      });
    };
    try {
      const raw = sessionStorage.getItem("lykn_pending_bot_open");
      if (raw) {
        sessionStorage.removeItem("lykn_pending_bot_open");
        const p = JSON.parse(raw) as { botId?: string; chatId?: string; at?: number };
        // Recent only — a hop parked for a window that never opened must not
        // hijack a chat the user opens minutes later for something else.
        if (Date.now() - Number(p?.at || 0) < 15000) {
          hop(String(p?.botId || ""));
        }
      }
    } catch {
      /* storage blocked — the event path below still works */
    }
    const onOpenBot = (e: Event) => {
      try {
        sessionStorage.removeItem("lykn_pending_bot_open");
      } catch {
        /* already handled live */
      }
      const d = ((e as CustomEvent).detail || {}) as { botId?: string; chatId?: string };
      hop(String(d.botId || ""));
    };
    window.addEventListener("lykn-bot-chat-open", onOpenBot);
    return () => window.removeEventListener("lykn-bot-chat-open", onOpenBot);
  }, [routeChatId, nav, resolveBotBoard]);

  // Standing on a Bot's board means its latest result has been seen — that's
  // what clears the green/red dot in the chat bar's working-Bots strip. Only
  // while mounted and settled on the board, so a stream finishing in a closed
  // window keeps its dot.
  useEffect(() => {
    if (!routeChatId || chatId !== routeChatId) return;
    const check = () => {
      const owner = getBots().find((b) => b.chatId === routeChatId);
      if (owner && botHasUnseenResult(owner)) markBotSeen(owner.id);
    };
    check();
    return subscribeBots(check);
  }, [chatId, routeChatId]);

  // A Bot send that arrives while this board is still hydrating (chatId lags
  // routeChatId on a cold-opened chat) must wait: the hydration snapshot
  // replaces chatMessages and would wipe the streaming row — which is exactly
  // "the first Bot prompt does nothing, the second works". Hold it here and
  // flush the moment hydration settles.
  const pendingBotSendRef = useRef<{
    botId: string;
    text: string;
    attachments: BotSendAttachment[];
  } | null>(null);
  const chatIdLiveRef = useRef(chatId);
  chatIdLiveRef.current = chatId;
  useEffect(() => {
    if (!routeChatId || chatId !== routeChatId) return;
    const held = pendingBotSendRef.current;
    if (!held) return;
    let cancelled = false;
    void resolveBotBoard(held.botId).then((board) => {
      if (cancelled) return;
      if (board && board !== routeChatId) {
        nav(`/chat/${board}`);
        return;
      }
      pendingBotSendRef.current = null;
      handleBotChatSend(held.botId, held.text, held.attachments);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, routeChatId, nav, handleBotChatSend, resolveBotBoard]);

  return { handleBotChatSend, pendingBotSendRef, chatIdLiveRef, resolveBotBoard };
}
