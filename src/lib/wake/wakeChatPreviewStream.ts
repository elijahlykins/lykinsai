import { API_BASE_URL } from "@/lib/api-config";
import { stripModelTruncationNoteFromStream } from "@/lib/ai/learnedTag";
import { AI_GUEST_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";

export const WAKE_CHAT_PREVIEW_MESSAGE_CAP = 5;

export const WAKE_CHAT_PREVIEW_COUNT_KEY = "lykn_wake_chat_preview_send_count";

export const WAKE_CHAT_PREVIEW_LIMIT_TEXT =
  "You have used your 5 preview messages. Create an account to keep chatting.";

export type WakeChatPreviewHistoryMsg = {
  role: "user" | "model";
  content: string;
};

export function readWakeChatPreviewSendCount(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.sessionStorage.getItem(WAKE_CHAT_PREVIEW_COUNT_KEY);
    const n = parseInt(raw || "0", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function incrementWakeChatPreviewSendCount(): number {
  if (typeof window === "undefined") return 0;
  const next = readWakeChatPreviewSendCount() + 1;
  try {
    window.sessionStorage.setItem(WAKE_CHAT_PREVIEW_COUNT_KEY, String(next));
  } catch {
    // ignore
  }
  return next;
}

export function wakeChatPreviewCapReached(): boolean {
  return readWakeChatPreviewSendCount() >= WAKE_CHAT_PREVIEW_MESSAGE_CAP;
}

export async function streamWakeChatPreview(
  prompt: string,
  history: WakeChatPreviewHistoryMsg[],
  onChunk: (visibleText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/ai/stream-guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, history }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error("chat: bad response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

  const consumeLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6);
    if (payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed.t === "string") {
        result += parsed.t;
        onChunk(stripModelTruncationNoteFromStream(result));
      }
      if (parsed.error && !result) throw new Error(AI_GUEST_TEMPORARY_FAILURE_TEXT);
    } catch {
      // Ignore partial JSON chunks.
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode(undefined, { stream: false });
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const raw of lines) consumeLine(raw);
  }

  if (buffer.trim()) {
    for (const raw of buffer.split("\n")) consumeLine(raw);
  }

  return stripModelTruncationNoteFromStream(result);
}
