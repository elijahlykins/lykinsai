/**
 * In-memory chat thread runtime — lets multiple boards stream concurrently
 * while the user switches between open chat tabs.
 */

import type { PromptMessage } from "@/lib/ai/chatSendOrchestrator";

export type ChatFlowMode = "idle" | "clarifying" | "generating";

export type ThreadSnapshot = {
  chatMessages: PromptMessage[];
  aiThread: Array<{ role: "user" | "assistant"; content: string }>;
  convoSummary: string;
  convoTurnsSinceSummary: number;
  isChatLoading: boolean;
  chatStatusText: string;
  chatFlowMode: ChatFlowMode;
  chatInput: string;
  abortController: AbortController | null;
  updatedAt: number;
};

const OPEN_THREADS_KEY = "lykn_open_chat_threads_v1";
const MAX_OPEN_THREADS = 10;
const RUNTIME_EVENT = "lykn_chat_thread_runtime_changed";

const snapshots = new Map<string, ThreadSnapshot>();
let activeBoardId: string | null = null;

function emptySnapshot(): ThreadSnapshot {
  return {
    chatMessages: [],
    aiThread: [],
    convoSummary: "",
    convoTurnsSinceSummary: 0,
    isChatLoading: false,
    chatStatusText: "",
    chatFlowMode: "idle",
    chatInput: "",
    abortController: null,
    updatedAt: Date.now(),
  };
}

export function dispatchThreadRuntimeChange(boardId?: string | null) {
  try {
    window.dispatchEvent(
      new CustomEvent(RUNTIME_EVENT, { detail: { boardId: boardId || null } }),
    );
  } catch {
    /* SSR */
  }
}

export function subscribeThreadRuntime(cb: () => void) {
  const handler = () => cb();
  window.addEventListener(RUNTIME_EVENT, handler);
  return () => window.removeEventListener(RUNTIME_EVENT, handler);
}

export function getActiveThreadBoardId() {
  return activeBoardId;
}

export function setActiveThreadBoardId(boardId: string | null) {
  activeBoardId = boardId ? String(boardId) : null;
}

export function ensureThreadSnapshot(boardId: string): ThreadSnapshot {
  const id = String(boardId);
  let snap = snapshots.get(id);
  if (!snap) {
    snap = emptySnapshot();
    snapshots.set(id, snap);
  }
  return snap;
}

export function getThreadSnapshot(boardId: string | null | undefined): ThreadSnapshot | null {
  if (!boardId) return null;
  return snapshots.get(String(boardId)) || null;
}

export function patchThreadSnapshot(
  boardId: string,
  patch: Partial<Omit<ThreadSnapshot, "updatedAt">> & { updatedAt?: number },
) {
  const snap = ensureThreadSnapshot(boardId);
  Object.assign(snap, patch, { updatedAt: patch.updatedAt ?? Date.now() });
  snapshots.set(String(boardId), snap);
  dispatchThreadRuntimeChange(boardId);
}

export function shouldPreferRuntimeSnapshot(
  runtime: ThreadSnapshot | null,
  loadedMessages: PromptMessage[],
) {
  if (!runtime) return false;
  if (runtime.isChatLoading) return true;
  if (runtime.chatMessages.length > loadedMessages.length) return true;
  if (runtime.chatMessages.length === loadedMessages.length && runtime.chatMessages.length > 0) {
    const rLast = runtime.chatMessages[runtime.chatMessages.length - 1];
    const lLast = loadedMessages[loadedMessages.length - 1];
    const rText = String(rLast?.aiResponse || "");
    const lText = String(lLast?.aiResponse || "");
    // The disk copy has no (or a much shorter) response for the last
    // turn but the in-memory snapshot does — this is the "prompt sits
    // there with 0 response" case after a background stream finished
    // while the user was on another chat. Prefer the snapshot regardless
    // of age; within a session the snapshot is always >= disk.
    if (rText.length > 0 && lText.length === 0) return true;
    if (runtime.updatedAt > Date.now() - 60_000 && rText.length > lText.length + 20) return true;
  }
  return false;
}

export function readOpenThreadIds(): string[] {
  try {
    const raw = sessionStorage.getItem(OPEN_THREADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.ids) ? parsed.ids : [];
    return ids.map((id: unknown) => String(id)).filter(Boolean).slice(0, MAX_OPEN_THREADS);
  } catch {
    return [];
  }
}

function writeOpenThreadIds(ids: string[]) {
  try {
    sessionStorage.setItem(
      OPEN_THREADS_KEY,
      JSON.stringify({ ids: ids.slice(0, MAX_OPEN_THREADS) }),
    );
  } catch {
    /* ignore */
  }
  dispatchThreadRuntimeChange(null);
}

export function addOpenThread(boardId: string) {
  const id = String(boardId);
  if (!id) return;
  const ids = readOpenThreadIds().filter((x) => x !== id);
  ids.unshift(id);
  writeOpenThreadIds(ids);
}

export function removeOpenThread(boardId: string) {
  const id = String(boardId);
  writeOpenThreadIds(readOpenThreadIds().filter((x) => x !== id));
  snapshots.delete(id);
}

export function isThreadLoading(boardId: string) {
  return !!getThreadSnapshot(boardId)?.isChatLoading;
}

/** Wrap orchestrator state callbacks so updates land on the stream's board. */
export function bindThreadStateCallbacks(
  streamBoardId: string,
  react: {
    setChatStatusText: (text: string) => void;
    setChatMessages: (updater: (prev: PromptMessage[]) => PromptMessage[]) => void;
    setIsChatLoading: (v: boolean) => void;
    setChatFlowMode: (v: ChatFlowMode) => void;
  },
) {
  const bid = String(streamBoardId);

  return {
    setChatStatusText: (text: string) => {
      patchThreadSnapshot(bid, { chatStatusText: text });
      if (getActiveThreadBoardId() === bid) react.setChatStatusText(text);
    },
    setChatMessages: (updater: (prev: PromptMessage[]) => PromptMessage[]) => {
      const snap = ensureThreadSnapshot(bid);
      snap.chatMessages = updater(snap.chatMessages);
      snap.updatedAt = Date.now();
      snapshots.set(bid, snap);
      dispatchThreadRuntimeChange(bid);
      if (getActiveThreadBoardId() === bid) {
        react.setChatMessages(() => snap.chatMessages);
      }
    },
    setIsChatLoading: (v: boolean) => {
      patchThreadSnapshot(bid, { isChatLoading: v });
      if (getActiveThreadBoardId() === bid) react.setIsChatLoading(v);
    },
    setChatFlowMode: (v: ChatFlowMode) => {
      patchThreadSnapshot(bid, { chatFlowMode: v });
      if (getActiveThreadBoardId() === bid) react.setChatFlowMode(v);
    },
  };
}

export function snapshotActiveThreadFromReact(
  boardId: string,
  data: Partial<ThreadSnapshot>,
) {
  patchThreadSnapshot(boardId, data);
}

export function hydrateActiveThreadToReact(
  boardId: string,
  react: {
    setChatMessages: (msgs: PromptMessage[]) => void;
    setIsChatLoading: (v: boolean) => void;
    setChatStatusText: (text: string) => void;
    setChatFlowMode: (v: ChatFlowMode) => void;
    setChatInput: (v: string) => void;
  },
  refs: {
    chatMessagesRef: { current: PromptMessage[] };
    aiThreadRef: { current: ThreadSnapshot["aiThread"] };
    convoSummaryRef: { current: string };
    convoTurnsSinceSummaryRef: { current: number };
    chatInputRef: { current: string };
    activeAiAbortRef: { current: AbortController | null };
  },
  loadedMessages: PromptMessage[],
) {
  const snap = getThreadSnapshot(boardId);
  if (!snap || !shouldPreferRuntimeSnapshot(snap, loadedMessages)) return false;

  refs.chatMessagesRef.current = snap.chatMessages;
  refs.aiThreadRef.current = [...snap.aiThread];
  refs.convoSummaryRef.current = snap.convoSummary;
  refs.convoTurnsSinceSummaryRef.current = snap.convoTurnsSinceSummary;
  refs.chatInputRef.current = snap.chatInput;
  refs.activeAiAbortRef.current = snap.abortController;

  react.setChatMessages(snap.chatMessages);
  react.setIsChatLoading(snap.isChatLoading);
  react.setChatStatusText(snap.chatStatusText);
  react.setChatFlowMode(snap.chatFlowMode);
  react.setChatInput(snap.chatInput);
  return true;
}

export function registerStreamAbortController(boardId: string, controller: AbortController | null) {
  patchThreadSnapshot(boardId, { abortController: controller });
}
