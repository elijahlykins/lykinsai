/**
 * In-memory chat thread runtime — lets multiple boards stream concurrently
 * while the user switches between open chat tabs.
 */

import type { PromptMessage } from "@/lib/ai/chatSendOrchestrator";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";

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
  /** Side-panel artifact open for THIS chat only — never shared across boards. */
  activeArtifact: ChatArtifact | null;
  updatedAt: number;
};

const OPEN_THREADS_KEY = "lykn_open_chat_threads_v1";
const MAX_OPEN_THREADS = 10;
const RUNTIME_EVENT = "lykn_chat_thread_runtime_changed";

const snapshots = new Map<string, ThreadSnapshot>();
let activeChatId: string | null = null;

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
    activeArtifact: null,
    updatedAt: Date.now(),
  };
}

export function dispatchThreadRuntimeChange(chatId?: string | null) {
  try {
    window.dispatchEvent(
      new CustomEvent(RUNTIME_EVENT, { detail: { chatId: chatId || null } }),
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

export function getActiveThreadChatId() {
  return activeChatId;
}

export function setActiveThreadChatId(chatId: string | null) {
  activeChatId = chatId ? String(chatId) : null;
}

export function ensureThreadSnapshot(chatId: string): ThreadSnapshot {
  const id = String(chatId);
  let snap = snapshots.get(id);
  if (!snap) {
    snap = emptySnapshot();
    snapshots.set(id, snap);
  }
  return snap;
}

export function getThreadSnapshot(chatId: string | null | undefined): ThreadSnapshot | null {
  if (!chatId) return null;
  return snapshots.get(String(chatId)) || null;
}

export function patchThreadSnapshot(
  chatId: string,
  patch: Partial<Omit<ThreadSnapshot, "updatedAt">> & { updatedAt?: number },
) {
  const snap = ensureThreadSnapshot(chatId);
  Object.assign(snap, patch, { updatedAt: patch.updatedAt ?? Date.now() });
  snapshots.set(String(chatId), snap);
  dispatchThreadRuntimeChange(chatId);
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

export function addOpenThread(chatId: string) {
  const id = String(chatId);
  if (!id) return;
  const ids = readOpenThreadIds().filter((x) => x !== id);
  ids.unshift(id);
  writeOpenThreadIds(ids);
}

export function removeOpenThread(chatId: string) {
  const id = String(chatId);
  writeOpenThreadIds(readOpenThreadIds().filter((x) => x !== id));
  snapshots.delete(id);
}

export function isThreadLoading(chatId: string) {
  return !!getThreadSnapshot(chatId)?.isChatLoading;
}

/** Wrap orchestrator state callbacks so updates land on the stream's board. */
export function bindThreadStateCallbacks(
  streamChatId: string,
  react: {
    setChatStatusText: (text: string) => void;
    setChatMessages: (updater: (prev: PromptMessage[]) => PromptMessage[]) => void;
    setIsChatLoading: (v: boolean) => void;
    setChatFlowMode: (v: ChatFlowMode) => void;
  },
) {
  const bid = String(streamChatId);

  return {
    setChatStatusText: (text: string) => {
      patchThreadSnapshot(bid, { chatStatusText: text });
      if (getActiveThreadChatId() === bid) react.setChatStatusText(text);
    },
    setChatMessages: (updater: (prev: PromptMessage[]) => PromptMessage[]) => {
      const snap = ensureThreadSnapshot(bid);
      snap.chatMessages = updater(snap.chatMessages);
      snap.updatedAt = Date.now();
      snapshots.set(bid, snap);
      dispatchThreadRuntimeChange(bid);
      if (getActiveThreadChatId() === bid) {
        react.setChatMessages(() => snap.chatMessages);
      }
    },
    setIsChatLoading: (v: boolean) => {
      patchThreadSnapshot(bid, { isChatLoading: v });
      if (getActiveThreadChatId() === bid) react.setIsChatLoading(v);
    },
    setChatFlowMode: (v: ChatFlowMode) => {
      patchThreadSnapshot(bid, { chatFlowMode: v });
      if (getActiveThreadChatId() === bid) react.setChatFlowMode(v);
    },
  };
}

export function snapshotActiveThreadFromReact(
  chatId: string,
  data: Partial<ThreadSnapshot>,
) {
  patchThreadSnapshot(chatId, data);
}

export function hydrateActiveThreadToReact(
  chatId: string,
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
  const snap = getThreadSnapshot(chatId);
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

export function registerStreamAbortController(chatId: string, controller: AbortController | null) {
  patchThreadSnapshot(chatId, { abortController: controller });
}
