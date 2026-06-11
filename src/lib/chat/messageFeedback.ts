import { API_BASE_URL } from "@/lib/api-config";

export type MessageRating = "like" | "dislike" | null;

export interface MessageFeedbackPayload {
  messageId: string;
  rating: MessageRating;
  boardId?: string | null;
  model?: string | null;
  prompt?: string | null;
  response?: string | null;
}

/**
 * Persist a chat thumbs up/down. Fire-and-forget — the UI already updated
 * optimistically, so a network failure must not block or surface an error.
 * Auth is attached automatically by the global fetch wrapper (installAuthFetch).
 */
export async function persistMessageFeedback(payload: MessageFeedbackPayload): Promise<void> {
  const messageId = String(payload.messageId || "").trim();
  if (!messageId) return;
  try {
    await fetch(`${API_BASE_URL}/api/ai/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId,
        rating: payload.rating,
        boardId: payload.boardId ?? null,
        model: payload.model ?? null,
        prompt: payload.prompt ?? null,
        response: payload.response ?? null,
      }),
    });
  } catch {
    // best-effort; ignore
  }
}
