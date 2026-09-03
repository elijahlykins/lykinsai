import type { BrowserSurfaceContext } from "@/lib/lyknChat/browserChatSend";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";

export type ChatSendOpts = {
  chatId?: string;
  text?: string;
  surfaceContext?: BrowserSurfaceContext;
  attachments?: FocusedChatAttachment[];
};

export function resolveChatSendTarget(
  opts: ChatSendOpts | undefined,
  routeChatId: string | null | undefined,
  engineChatId: string | null | undefined,
) {
  const explicitChatId = String(opts?.chatId || "").trim();
  const mountedChatId = String(routeChatId || engineChatId || "").trim();
  const streamChatId = explicitChatId || mountedChatId;
  const browserSend = opts?.surfaceContext?.surface === "browser";
  return {
    streamChatId,
    mountedChatId,
    explicitChatId,
    browserSend,
    offRoute: Boolean(explicitChatId && explicitChatId !== mountedChatId),
    tabId: browserSend ? String(opts?.surfaceContext?.tabId || "").trim() : "",
  };
}
