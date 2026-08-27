/**
 * /app resume must not steal an in-flight first send on a provisional chat.
 */
export function shouldReplaceProvisionalChat({
  targetId,
  provisionalId,
  isChatLoading = false,
  hasUserMessages = false,
  isSending = false,
}: {
  targetId?: string | null;
  provisionalId?: string | null;
  isChatLoading?: boolean;
  hasUserMessages?: boolean;
  isSending?: boolean;
} = {}): boolean {
  if (!targetId || !provisionalId || targetId === provisionalId) return false;
  if (isSending || isChatLoading || hasUserMessages) return false;
  return true;
}

export function provisionalChatHasUserMessages(messages: Array<{ role?: string; content?: string }> | null | undefined): boolean {
  return (messages || []).some(
    (message) => message?.role === "user" && String(message.content || "").trim(),
  );
}
