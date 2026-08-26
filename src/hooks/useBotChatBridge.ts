// useBotChatBridge owns the chat page's Bot integration: sending a turn to a
// Bot (prompt row with attachment chips + streamed reply patched in place),
// re-attaching rows to live streams after a remount (and catching up rows
// whose task settled off-screen), the "jump to a Bot's board" hop, marking a
// Bot's result seen while standing on its board, and holding a Bot send that
// arrives mid-hydration until this surface owns the chat route. Extracted
// verbatim from src/pages/LyknChat.tsx (LyknChat decomposition phase, see
// docs/REFACTOR_LOG.md).
import { useCallback, useEffect, useRef } from "react";
import { followBotTask, sendBotChatTurn } from "@/lib/bots/botChatBridge";
import {
  botHasUnseenResult,
  getBot,
  getBots,
  markBotSeen,
  subscribeBots,
} from "@/lib/bots/botsClient";
import { ensureThreadSnapshot } from "@/lib/chat/chatThreadRuntime";
import type {
  BotSendAttachment,
  FocusedChatAttachment,
  PromptMessage,
} from "@/lib/lyknChat/chatTurnTypes";

export function useBotChatBridge({
  chatId,
  routeChatId,
  nav,
  chatMessages,
  setChatMessages,
}: {
  chatId: string | null;
  routeChatId: string | null | undefined;
  nav: (to: string) => void;
  chatMessages: PromptMessage[];
  setChatMessages: React.Dispatch<React.SetStateAction<PromptMessage[]>>;
}) {
  // Tasks whose stream is already patching a row in THIS mount. Reset on
  // remount by design — that's exactly when re-attaching is needed.
  const followedBotTasksRef = useRef<Set<string>>(new Set());
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
      const taskId = sendBotChatTurn(
        botId,
        text,
        ({ text: reply, done, working, status, trail }: {
          text: string;
          done?: boolean;
          working?: boolean;
          status?: string;
          trail?: string[];
        }) => {
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === msgId
                ? {
                    ...m,
                    aiResponse: reply,
                    botWorking: !done && !!working,
                    botStatus: String(status || ""),
                    botTrail: Array.isArray(trail) ? trail : [],
                  }
                : m,
            ),
          );
          if (done && chatIdAtSend) {
            try {
              const snap = ensureThreadSnapshot(chatIdAtSend);
              snap.aiThread.push({ role: "user", content: `(asked ${bot.name}) ${text}` });
              snap.aiThread.push({ role: "assistant", content: `(${bot.name} replied) ${reply}` });
              if (snap.aiThread.length > 40) snap.aiThread.splice(0, snap.aiThread.length - 40);
            } catch {
              /* the snapshot is a convenience; never fail a bot turn over it */
            }
          }
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
    [routeChatId, setChatMessages],
  );

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
      followBotTask(bot.id, taskId, ({ text: reply, done, working, status, trail }: {
        text: string;
        done?: boolean;
        working?: boolean;
        status?: string;
        trail?: string[];
      }) => {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  aiResponse: reply,
                  botWorking: !done && !!working,
                  botStatus: String(status || ""),
                  botTrail: Array.isArray(trail) ? trail : [],
                }
              : m,
          ),
        );
      });
    }
  }, [chatId, routeChatId, chatMessages, setChatMessages]);

  // The chat bar's working-Bots strip (and its dropdown) asks this surface to
  // jump to a Bot's own thread. A warm surface hops on the event; a cold one
  // (the click also opened this window) picks up the parked hop on mount.
  useEffect(() => {
    const hop = (botId: string, chatIdIn: string) => {
      const board = String(chatIdIn || getBot(botId)?.chatId || "");
      if (board && board !== routeChatId) nav(`/chat/${board}`);
    };
    try {
      const raw = sessionStorage.getItem("lykn_pending_bot_open");
      if (raw) {
        sessionStorage.removeItem("lykn_pending_bot_open");
        const p = JSON.parse(raw) as { botId?: string; chatId?: string; at?: number };
        // Recent only — a hop parked for a window that never opened must not
        // hijack a chat the user opens minutes later for something else.
        if (Date.now() - Number(p?.at || 0) < 15000) {
          hop(String(p?.botId || ""), String(p?.chatId || ""));
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
      hop(String(d.botId || ""), String(d.chatId || ""));
    };
    window.addEventListener("lykn-bot-chat-open", onOpenBot);
    return () => window.removeEventListener("lykn-bot-chat-open", onOpenBot);
  }, [routeChatId, nav]);

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
    // The send belongs on the bot's own board — if this surface settled
    // somewhere else in the meantime, steer back before firing it.
    const board = String(getBot(held.botId)?.chatId || "");
    if (board && board !== routeChatId) {
      nav(`/chat/${board}`);
      return;
    }
    pendingBotSendRef.current = null;
    handleBotChatSend(held.botId, held.text, held.attachments);
  }, [chatId, routeChatId, nav, handleBotChatSend]);

  return { handleBotChatSend, pendingBotSendRef, chatIdLiveRef };
}
