/**
 * FIFO of prompts the user sent while LYKN is already working.
 * One list per chat so Studio, Home, and the browser rail stay in sync.
 */
import type { BrowserSurfaceContext } from "@/lib/lyknChat/browserChatSend";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";
import { setDesktopWorkHold } from "@/lib/desktop/workHold";

export const PROMPT_QUEUE_EVENT = "lykn-prompt-queue-changed";
export const PROMPT_QUEUE_DRAIN_EVENT = "lykn-prompt-queue-drain";
export const IMAGINE_BUSY_EVENT = "lykn-imagine-busy";
export const MAX_QUEUED_PROMPTS = 20;

export type QueuedPromptKind = "chat" | "imagine";

export type QueuedPrompt = {
  id: string;
  chatId: string;
  text: string;
  attachments: FocusedChatAttachment[];
  composerMode?: string;
  kind: QueuedPromptKind;
  surfaceContext?: BrowserSurfaceContext;
};

const queues = new Map<string, QueuedPrompt[]>();

function newId() {
  return (
    (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
    `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

function listFor(chatId: string): QueuedPrompt[] {
  return queues.get(chatId) || [];
}

function emit(chatId: string) {
  try {
    window.dispatchEvent(
      new CustomEvent(PROMPT_QUEUE_EVENT, { detail: { chatId } }),
    );
  } catch {
    /* SSR */
  }
}

export function listQueuedPrompts(chatId?: string | null): QueuedPrompt[] {
  const id = String(chatId || "").trim();
  if (!id) return [];
  return listFor(id).slice();
}

export function enqueuePrompt(
  input: Omit<QueuedPrompt, "id"> & { id?: string; prepend?: boolean },
): QueuedPrompt | null {
  const chatId = String(input.chatId || "").trim();
  const text = String(input.text || "").trim();
  const attachments = Array.isArray(input.attachments) ? input.attachments.slice() : [];
  if (!chatId || (!text && !attachments.length)) return null;
  const current = listFor(chatId);
  if (current.length >= MAX_QUEUED_PROMPTS) return null;
  if (!input.prepend) {
    const last = current[current.length - 1];
    if (
      last &&
      last.text === text &&
      last.kind === (input.kind || "chat") &&
      last.attachments.length === attachments.length
    ) {
      return last;
    }
  }
  const item: QueuedPrompt = {
    id: String(input.id || "").trim() || newId(),
    chatId,
    text,
    attachments,
    kind: input.kind || "chat",
    ...(input.composerMode ? { composerMode: input.composerMode } : {}),
    ...(input.surfaceContext ? { surfaceContext: input.surfaceContext } : {}),
  };
  queues.set(chatId, input.prepend ? [item, ...current] : [...current, item]);
  emit(chatId);
  return item;
}

export function removeQueuedPrompt(chatId: string | null | undefined, id: string): boolean {
  const cid = String(chatId || "").trim();
  const itemId = String(id || "").trim();
  if (!cid || !itemId) return false;
  const current = listFor(cid);
  const next = current.filter((item) => item.id !== itemId);
  if (next.length === current.length) return false;
  if (next.length) queues.set(cid, next);
  else queues.delete(cid);
  emit(cid);
  return true;
}

export function clearQueuedPrompts(chatId: string | null | undefined): void {
  const cid = String(chatId || "").trim();
  if (!cid) return;
  if (!queues.has(cid)) return;
  queues.delete(cid);
  emit(cid);
}

export function takeNextQueuedPrompt(chatId: string | null | undefined): QueuedPrompt | null {
  const cid = String(chatId || "").trim();
  if (!cid) return null;
  const current = listFor(cid);
  if (!current.length) return null;
  const [next, ...rest] = current;
  if (rest.length) queues.set(cid, rest);
  else queues.delete(cid);
  emit(cid);
  return next;
}

export function subscribePromptQueue(cb: (chatId?: string | null) => void) {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ chatId?: string | null }>).detail;
    cb(detail?.chatId ?? null);
  };
  window.addEventListener(PROMPT_QUEUE_EVENT, handler);
  return () => window.removeEventListener(PROMPT_QUEUE_EVENT, handler);
}

export function queuedPromptPreview(item: Pick<QueuedPrompt, "text" | "attachments">): string {
  const text = String(item.text || "").trim();
  if (text) return text;
  const n = item.attachments?.length || 0;
  if (n === 1) return item.attachments[0]?.name || "1 attachment";
  if (n > 1) return `${n} attachments`;
  return "Queued prompt";
}

export function runNextQueuedPrompt(
  chatId: string | null | undefined,
  sendChat: (item: QueuedPrompt) => void,
) {
  const bid = String(chatId || "").trim();
  if (!bid) return false;
  if (consumeSkipQueueDrain(bid)) return false;
  const next = takeNextQueuedPrompt(bid);
  if (!next) return false;
  if (next.kind === "imagine") {
    try {
      window.dispatchEvent(new CustomEvent(PROMPT_QUEUE_DRAIN_EVENT, { detail: next }));
    } catch {
      /* SSR */
    }
    return true;
  }
  sendChat(next);
  return true;
}

const skipDrain = new Set<string>();

export function skipNextQueueDrain(chatId: string | null | undefined) {
  const bid = String(chatId || "").trim();
  if (bid) skipDrain.add(bid);
}

export function consumeSkipQueueDrain(chatId: string | null | undefined) {
  const bid = String(chatId || "").trim();
  if (!bid || !skipDrain.has(bid)) return false;
  skipDrain.delete(bid);
  return true;
}

let imagineBusyFlag = false;

export function isImagineBusy() {
  return imagineBusyFlag;
}

export function setImagineBusy(busy: boolean, chatId?: string | null) {
  imagineBusyFlag = !!busy;
  setDesktopWorkHold("imagine", imagineBusyFlag);
  try {
    window.dispatchEvent(
      new CustomEvent(IMAGINE_BUSY_EVENT, {
        detail: { busy: imagineBusyFlag, chatId: chatId || null },
      }),
    );
  } catch {
    /* SSR */
  }
}
