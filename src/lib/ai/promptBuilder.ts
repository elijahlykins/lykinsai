/**
 * Shared AI context-building utilities.
 *
 * Canonical source for context budgets, conversation compression,
 * and prompt assembly used by both the Astro API route (invoke.ts)
 * and the Express streaming endpoint (server.js).
 */

export const CONTEXT_BUDGETS = {
  focusedBlocks: 6000,
  nearbyBlocks: 6000,
  compactSummary: 2000,
  canvasTotal: 14000,
  projectSummary: 2000,
  workspaceContext: 2000,
  conversation: 8000,
  userPrompt: 3000,
  mediaContext: 8000,
} as const;

/**
 * Compress a conversation array into a formatted string.
 * The most recent `fullCount` messages are kept in full;
 * older messages are summarised to role + first 80 chars.
 */
export function compressConversation(
  messages: Array<{ role: string; content: string }> | undefined | null,
  opts?: { fullCount?: number; maxChars?: number },
): string {
  if (!Array.isArray(messages) || !messages.length) return "";

  const fullCount = opts?.fullCount ?? 6;
  const maxChars = opts?.maxChars ?? CONTEXT_BUDGETS.conversation;

  const capped = messages.slice(-20);
  const splitAt = Math.max(0, capped.length - fullCount);
  const older = capped.slice(0, splitAt);
  const recent = capped.slice(splitAt);

  const olderLines = older
    .map((m) => {
      const role = String(m?.role || "user").toUpperCase();
      const snippet = String(m?.content || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      return snippet ? `${role}: ${snippet}…` : "";
    })
    .filter(Boolean);

  const recentLines = recent
    .map((m) => {
      const role = String(m?.role || "user").toUpperCase();
      const content = String(m?.content || "").trim();
      if (!content) return "";
      const truncated =
        content.length > 2000 ? `${content.slice(0, 2000)}…` : content;
      return `${role}: ${truncated}`;
    })
    .filter(Boolean);

  const joined = [...olderLines, ...recentLines].join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

export type BuildPromptInput = {
  systemPrompt?: string;
  context?: string;
  projectSummary?: string;
  workspaceContext?: string;
  conversation?: string;
  userPrompt?: string;
  mediaContext?: string;
  intent?: string;
  projectId?: string;
  /** Raw prompt that may contain extra context (transcripts, etc.) */
  fullContext?: string;
};

/**
 * Assemble a final prompt string from a system prompt and structured
 * data sections, enforcing per-section budget limits.
 */
export function buildPrompt(input: BuildPromptInput): string {
  const ctx = String(input.context || "")
    .trim()
    .slice(0, CONTEXT_BUDGETS.canvasTotal);
  const ps = String(input.projectSummary || "")
    .trim()
    .slice(0, CONTEXT_BUDGETS.projectSummary);
  const ws = String(input.workspaceContext || "")
    .trim()
    .slice(0, CONTEXT_BUDGETS.workspaceContext);
  const convo = String(input.conversation || "")
    .trim()
    .slice(0, CONTEXT_BUDGETS.conversation);
  const user = String(input.userPrompt || "")
    .trim()
    .slice(0, CONTEXT_BUDGETS.userPrompt);
  const media = String(input.mediaContext || "")
    .trim()
    .slice(0, CONTEXT_BUDGETS.mediaContext);

  let finalPrompt = [
    input.systemPrompt || "",
    input.intent
      ? `[INTENT]\n${String(input.intent).trim().toLowerCase() || "ask"}`
      : "",
    input.projectId ? `[PROJECT_ID]\n${String(input.projectId)}` : "",
    convo ? `[CONVERSATION]\n${convo}` : "",
    ctx ? `[GRID_CONTEXT]\n${ctx}` : "",
    ps ? `[PROJECT_KNOWLEDGE]\n${ps}` : "",
    ws
      ? `[WORKSPACE_CONTEXT]\nBelow are the user's OTHER boards and their entire Media page contents. This is real data.\n${ws}`
      : "",
    media
      ? `[MEDIA_PAGE]\nThe user asked for saved content. Below are items from their Media page. Use [PULL_MEDIA:noteId|attachmentIndex] at the END of your response to pull items onto the board.\nEach item shows: "title" (id=<noteId>) — files: <type>[<index>]\nExample: [PULL_MEDIA:abc123|0]\n\n${media}`
      : "",
    input.fullContext && input.fullContext !== user
      ? `[REQUEST_CONTEXT]\n${String(input.fullContext).slice(0, 16000)}`
      : "",
    `[LATEST_USER_MESSAGE]\n${user || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const MAX_CONTEXT_CHARS = 28000;
  if (finalPrompt.length > MAX_CONTEXT_CHARS) {
    finalPrompt = finalPrompt.slice(0, MAX_CONTEXT_CHARS);
    if (process.env.NODE_ENV !== "production") {
      console.warn("AI prompt truncated to fit context budget");
    }
  }
  return finalPrompt;
}
