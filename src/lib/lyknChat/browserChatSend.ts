/**
 * Browser rail send identity. Display and send share one resolved chat id.
 * Home route is not consulted.
 */
import { resolveRailChatId } from "@/lib/lyknChat/browserChatAttach";

export const LYKN_CHAT_SEND_EVENT = "lykn-chat-send";
export const LYKN_CHAT_STOP_EVENT = "lykn-chat-stop";

export type BrowserSurfaceContext = {
  surface: "browser";
  tabId: string;
  page?: {
    url?: string;
    title?: string;
    text?: string;
  };
};

export type LyknChatSendPayload = {
  chatId: string;
  text: string;
  tabId: string;
  surface: "browser";
  files?: File[];
};

/** One resolver for rail display and rail send. They cannot diverge. */
export function browserRailIdentity(input: {
  tabId?: string | null;
  attachedChatId?: string | null;
}): { displayChatId: string | null; sendChatId: string | null } {
  const chatId = resolveRailChatId(input);
  return { displayChatId: chatId, sendChatId: chatId };
}

export function parseLyknChatSendDetail(raw: unknown): {
  chatId: string;
  text: string;
  tabId: string;
  files: File[];
} | null {
  const d = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!d) return null;
  const chatId = String(d.chatId || "").trim();
  const text = String(d.text || "").trim();
  const tabId = String(d.tabId || "").trim();
  const files = Array.isArray(d.files)
    ? d.files.filter((f): f is File => typeof File !== "undefined" && f instanceof File)
    : [];
  if (!text && !files.length) return null;
  if (!chatId && !tabId) return null;
  return { chatId, text, tabId, files };
}

export function browserAskComposerPayload(input: {
  chatId?: string | null;
  tabId?: string | null;
  text?: string | null;
  files?: File[] | null;
}): LyknChatSendPayload | null {
  const chatId = String(input.chatId || "").trim();
  const text = String(input.text || "").trim();
  const tabId = String(input.tabId || "").trim();
  const files = Array.isArray(input.files)
    ? input.files.filter((f): f is File => typeof File !== "undefined" && f instanceof File)
    : [];
  if ((!text && !files.length) || !tabId) return null;
  return files.length
    ? { chatId, text, tabId, surface: "browser", files }
    : { chatId, text, tabId, surface: "browser" };
}

export function parseLyknChatStopDetail(raw: unknown): { chatId: string } | null {
  const d = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!d) return null;
  const chatId = String(d.chatId || "").trim();
  if (!chatId) return null;
  return { chatId };
}

export function browserAskStopPayload(input: {
  chatId?: string | null;
}): { chatId: string } | null {
  const chatId = String(input.chatId || "").trim();
  if (!chatId) return null;
  return { chatId };
}
