// Thread-projection for the chat engine. ONE owner for projecting
// `chatThreadRuntime` snapshots into React: board-switch hydration, per-thread
// message patches, composer-draft persist, latest-message expand, conversation
// summary, and the invoke-fallback word typewriter. Extracted VERBATIM from
// useChatEngine.ts; useChatEngine remains the Chat engine facade and composes
// this hook. Stream / abort / send ownership stays in useChatEngine — this
// hook only reads the abort + streamChatId refs it is handed.
import React, { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import type { PromptMessage } from "@/lib/lyknChat/chatTurnTypes";
import {
  addOpenThread,
  ensureThreadSnapshot,
  getActiveThreadChatId,
  getThreadSnapshot,
  hydrateActiveThreadToReact,
  patchThreadSnapshot,
  setActiveThreadChatId,
  snapshotActiveThreadFromReact,
} from "@/lib/chat/chatThreadRuntime";

export interface UseChatThreadProjectionDeps {
  chatId: string | null;
  routeChatId: string | undefined;
  chatMessages: PromptMessage[];
  setChatMessages: Dispatch<SetStateAction<PromptMessage[]>>;
  chatMessagesRef: React.MutableRefObject<PromptMessage[]>;
  aiThreadRef: React.MutableRefObject<Array<{ role: "user" | "assistant"; content: string }>>;
  convoSummaryRef: React.MutableRefObject<string>;
  convoTurnsSinceSummaryRef: React.MutableRefObject<number>;
  chatInputRef: React.MutableRefObject<string>;
  chatInputHasText: boolean;
  setChatInput: (valOrFn: string | ((prev: string) => string)) => void;
  isChatLoading: boolean;
  setIsChatLoading: Dispatch<SetStateAction<boolean>>;
  chatStatusText: string;
  setChatStatusText: Dispatch<SetStateAction<string>>;
  chatFlowMode: "idle" | "clarifying" | "generating";
  setChatFlowMode: Dispatch<SetStateAction<"idle" | "clarifying" | "generating">>;
  /** Engine-owned. Restored from the incoming snapshot on board switch. */
  activeAiAbortRef: React.MutableRefObject<AbortController | null>;
  /** Engine-owned. Restored / read so typewriter writes stay on the stream's board. */
  streamChatIdRef: React.MutableRefObject<string | null>;
  activeArtifactRef: React.MutableRefObject<ChatArtifact | null>;
  setActiveArtifactState: Dispatch<SetStateAction<ChatArtifact | null>>;
  setExpandedAiMsgIds: Dispatch<SetStateAction<Set<string>>>;
  chatScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  chatUserScrolledUpRef: React.MutableRefObject<boolean>;
  chatProgrammaticScrollRef: React.MutableRefObject<boolean>;
}

export interface UseChatThreadProjectionReturn {
  patchThreadMessages: (
    updater: (prev: PromptMessage[]) => PromptMessage[],
    targetChatId?: string | null,
  ) => void;
  typeResponseIntoChat: (promptId: string, fullText: string, targetChatId?: string | null) => Promise<void>;
  maybeRunConversationSummary: (targetChatId?: string | null) => Promise<void>;
  cleanupDraftTimers: () => void;
  flushTypingForStop: (bid: string) => void;
}

export function useChatThreadProjection(
  deps: UseChatThreadProjectionDeps,
): UseChatThreadProjectionReturn {
  const {
    chatId, routeChatId,
    chatMessages, setChatMessages, chatMessagesRef, aiThreadRef,
    convoSummaryRef, convoTurnsSinceSummaryRef,
    chatInputRef, chatInputHasText, setChatInput,
    isChatLoading, setIsChatLoading,
    chatStatusText, setChatStatusText,
    chatFlowMode, setChatFlowMode,
    activeAiAbortRef, streamChatIdRef,
    activeArtifactRef, setActiveArtifactState,
    setExpandedAiMsgIds,
    chatScrollRef, chatUserScrolledUpRef, chatProgrammaticScrollRef,
  } = deps;

  const prevChatIdRef = useRef<string | null>(null);
  const prevLastMsgIdRef = useRef<string | null>(null);
  // Per-board typewriter state (non-streaming invoke fallback). Keyed by
  // chat id so two chats animating at once never clear each other's timer.
  const chatTypingTimersRef = useRef<Map<string, number>>(new Map());
  const chatTypingPendingsRef = useRef<Map<string, { promptId: string; fullText: string; resolve: () => void; chatId: string | null }>>(new Map());

  const patchThreadMessages = useCallback((
    updater: (prev: PromptMessage[]) => PromptMessage[],
    targetChatId?: string | null,
  ) => {
    const bid = targetChatId || streamChatIdRef.current || chatId || routeChatId;
    if (!bid) {
      setChatMessages(updater);
      return;
    }
    const snap = ensureThreadSnapshot(String(bid));
    snap.chatMessages = updater(snap.chatMessages);
    snap.updatedAt = Date.now();
    if (getActiveThreadChatId() === String(bid)) {
      setChatMessages(() => snap.chatMessages);
    }
    chatMessagesRef.current = snap.chatMessages;
  }, [chatId, routeChatId, setChatMessages]);

  // Switch threads without aborting background streams
  useEffect(() => {
    const incoming = chatId ? String(chatId) : null;
    const outgoing = prevChatIdRef.current;

    if (outgoing && outgoing !== incoming) {
      const outSnap = getThreadSnapshot(outgoing);
      // If the outgoing chat has a stream in flight, the orchestrator is
      // the source of truth for its snapshot — DON'T overwrite its
      // messages from the shared React refs. (Board navigation resets
      // those refs to [] before this effect runs, which would otherwise
      // wipe the in-flight prompt/response from the snapshot.)
      const outStreaming = !!outSnap?.isChatLoading;
      const refMessages = chatMessagesRef.current;
      const snapHasMore = (outSnap?.chatMessages?.length ?? 0) > (refMessages?.length ?? 0);

      const patch: Parameters<typeof snapshotActiveThreadFromReact>[1] = {
        chatStatusText: chatStatusText,
        chatFlowMode: chatFlowMode,
        chatInput: chatInputRef.current,
        // Park the open panel on the outgoing board (null for closed).
        activeArtifact: activeArtifactRef.current,
      };
      if (!outStreaming) {
        // Only persist React-side messages when they aren't a stale/empty
        // reset that would clobber a more complete snapshot.
        if (!snapHasMore) {
          patch.chatMessages = refMessages;
          patch.aiThread = [...aiThreadRef.current];
          patch.convoSummary = convoSummaryRef.current;
          patch.convoTurnsSinceSummary = convoTurnsSinceSummaryRef.current;
        }
        patch.isChatLoading = isChatLoading;
        patch.abortController = activeAiAbortRef.current;
      }
      snapshotActiveThreadFromReact(outgoing, patch);
    }

    if (incoming) {
      setActiveThreadChatId(incoming);
      addOpenThread(incoming);
      const snap = getThreadSnapshot(incoming);
      activeAiAbortRef.current = snap?.abortController ?? null;
      streamChatIdRef.current = snap?.isChatLoading ? incoming : null;

      // Always sync the lightweight status flags to the board we're
      // switching to — these are per-chat and must NEVER inherit the
      // outgoing chat's "thinking" state. Message hydration stays
      // conditional below (so a fresh board doesn't clobber a DB load),
      // but loading/status/flow always reflect the incoming board.
      setIsChatLoading(snap?.isChatLoading ?? false);
      setChatStatusText(snap?.chatStatusText ?? "");
      setChatFlowMode(snap?.chatFlowMode ?? "idle");

      // Restore THIS board's panel artifact (or close it on a fresh chat).
      // Do not go through setActiveArtifact — that would re-patch the snap.
      // Drop untagged / wrong-chat leftovers so a new board never inherits
      // another chat's open game.
      const restoredRaw = snap?.activeArtifact ?? null;
      const restoredSrc = String(restoredRaw?.sourceChatId || "").trim();
      const restored =
        restoredRaw && restoredSrc && restoredSrc === incoming ? restoredRaw : null;
      activeArtifactRef.current = restored;
      setActiveArtifactState(restored);
      if (restoredRaw && !restored) {
        patchThreadSnapshot(incoming, { activeArtifact: null });
      }

      requestAnimationFrame(() => {
        hydrateActiveThreadToReact(
          incoming,
          {
            setChatMessages,
            setIsChatLoading,
            setChatStatusText,
            setChatFlowMode,
            setChatInput,
          },
          {
            chatMessagesRef,
            aiThreadRef,
            convoSummaryRef,
            convoTurnsSinceSummaryRef,
            chatInputRef,
            activeAiAbortRef,
          },
          chatMessagesRef.current,
        );
      });
    } else {
      setActiveThreadChatId(null);
      activeArtifactRef.current = null;
      setActiveArtifactState(null);
    }

    prevChatIdRef.current = incoming;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on board switch
  }, [chatId]);

  // Persist composer draft per thread when typing
  useEffect(() => {
    if (!chatId) return;
    patchThreadSnapshot(String(chatId), { chatInput: chatInputRef.current });
  }, [chatId, chatInputHasText]);

  // Sync ref
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);

  // Auto-expand the latest message — but ONLY collapse the others when the
  // last message is genuinely NEW (a fresh user turn or a switch to a
  // different chat). Keying on the last message *id* instead of the array
  // length means background re-hydrations (per-board snapshot restores,
  // attachment re-signing, thread routing) that re-set `chatMessages` to an
  // array ending in the SAME message no longer collapse the response the user
  // is currently reading. The open response now stays open until the user
  // actually writes another prompt.
  useEffect(() => {
    const count = chatMessages.length;
    if (count === 0) { prevLastMsgIdRef.current = null; return; }
    const latestId = chatMessages[count - 1]?.id ?? null;
    if (latestId && latestId !== prevLastMsgIdRef.current) {
      setExpandedAiMsgIds(new Set([latestId]));
    }
    prevLastMsgIdRef.current = latestId;
  }, [chatMessages]);

  // Working memory: refresh often enough that goals/open questions stick
  // across mid-length chats without summarizing every turn.
  const SUMMARIZE_EVERY_N_TURNS = 4;
  const maybeRunConversationSummary = useCallback(async (targetChatId?: string | null) => {
    // Operate on the stream's own board snapshot so summaries don't mix
    // conversation history across chats in a thread.
    const bid = targetChatId ? String(targetChatId) : null;
    const snap = bid ? ensureThreadSnapshot(bid) : null;
    if (snap) {
      snap.convoTurnsSinceSummary += 1;
      if (snap.convoTurnsSinceSummary < SUMMARIZE_EVERY_N_TURNS) return;
      if (snap.aiThread.length < 6) return;
      snap.convoTurnsSinceSummary = 0;
    } else {
      convoTurnsSinceSummaryRef.current += 1;
      if (convoTurnsSinceSummaryRef.current < SUMMARIZE_EVERY_N_TURNS) return;
      if (aiThreadRef.current.length < 6) return;
      convoTurnsSinceSummaryRef.current = 0;
    }
    const thread = snap ? snap.aiThread : aiThreadRef.current;
    try {
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/summarize-conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: thread.slice(0, -4) }),
      });
      if (res.ok) {
        const { summary } = await res.json();
        if (summary) {
          if (snap) snap.convoSummary = summary;
          if (!bid || getActiveThreadChatId() === bid) convoSummaryRef.current = summary;
        }
      }
    } catch {}
  }, []);

  const typeResponseIntoChat = useCallback((promptId: string, fullText: string, targetChatId?: string | null): Promise<void> => {
    return new Promise((resolve) => {
      // Pin every write for this animation to the board that owns the
      // stream. Without this, switching chat tabs mid-stream reroutes the
      // typewriter into whatever board is now active (cross-chat bleed).
      const bid = targetChatId ?? streamChatIdRef.current ?? chatId ?? routeChatId ?? null;
      const key = String(bid || "");
      // Only supersede a previous animation on the SAME board — a second
      // chat starting its own typewriter must not cut off the first.
      const prevTimer = chatTypingTimersRef.current.get(key);
      if (prevTimer) { window.clearInterval(prevTimer); chatTypingTimersRef.current.delete(key); }
      const prev = chatTypingPendingsRef.current.get(key);
      if (prev) {
        patchThreadMessages((msgs) => msgs.map((m) => (m.id === prev.promptId ? { ...m, aiResponse: prev.fullText } : m)), prev.chatId);
        prev.resolve();
        chatTypingPendingsRef.current.delete(key);
      }
      const isActiveBoard = () => getActiveThreadChatId() === String(bid);
      const words = fullText.split(/(\s+)/);
      let idx = 0;
      chatTypingPendingsRef.current.set(key, { promptId, fullText, resolve, chatId: bid });
      patchThreadMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)), bid);
      const timer = window.setInterval(() => {
        idx += 3;
        const partial = words.slice(0, idx).join("");
        patchThreadMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: partial } : m)), bid);
        if (isActiveBoard() && !chatUserScrolledUpRef.current) {
          const el = chatScrollRef.current;
          if (el) { chatProgrammaticScrollRef.current = true; el.scrollTop = el.scrollHeight; }
        }
        if (idx >= words.length) {
          window.clearInterval(timer);
          if (chatTypingTimersRef.current.get(key) === timer) chatTypingTimersRef.current.delete(key);
          if (chatTypingPendingsRef.current.get(key)?.promptId === promptId) chatTypingPendingsRef.current.delete(key);
          patchThreadMessages((msgs) => msgs.map((m) => (m.id === promptId ? { ...m, aiResponse: fullText } : m)), bid);
          resolve();
        }
      }, 30);
      chatTypingTimersRef.current.set(key, timer);
    });
  }, [patchThreadMessages, chatId, routeChatId]);

  const flushTypingForStop = useCallback((bid: string) => {
    const stoppedTimer = chatTypingTimersRef.current.get(bid);
    if (stoppedTimer) { window.clearInterval(stoppedTimer); chatTypingTimersRef.current.delete(bid); }
    const pending = chatTypingPendingsRef.current.get(bid);
    if (pending) {
      patchThreadMessages((prev) => prev.map((m) => (m.id === pending.promptId ? { ...m, aiResponse: pending.fullText } : m)), pending.chatId);
      pending.resolve();
      chatTypingPendingsRef.current.delete(bid);
    }
  }, [patchThreadMessages]);

  const cleanupDraftTimers = useCallback(() => {
    for (const timer of chatTypingTimersRef.current.values()) window.clearInterval(timer);
    chatTypingTimersRef.current.clear();
    chatTypingPendingsRef.current.clear();
  }, []);

  return {
    patchThreadMessages,
    typeResponseIntoChat,
    maybeRunConversationSummary,
    cleanupDraftTimers,
    flushTypingForStop,
  };
}
