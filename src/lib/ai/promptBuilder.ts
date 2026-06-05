/**
 * Shared AI context-building utilities.
 *
 * Canonical source for context budgets, conversation compression,
 * and prompt assembly used by both the Astro API route (invoke.ts)
 * and the Express streaming endpoint (server.js).
 */

import { compressConversation as compressConversationMessages } from "./conversationFormat.js";

export const CONTEXT_BUDGETS = {
  focusedBlocks: 6000,
  nearbyBlocks: 6000,
  compactSummary: 2000,
  canvasTotal: 14000,
  projectSummary: 2000,
  projectSummaryInProject: 4000,
  workspaceContext: 28000,
  conversation: 8000,
  userPrompt: 3000,
  mediaContext: 8000,
} as const;

/**
 * Compress a conversation array into a formatted string.
 * The most recent `fullCount` messages are kept in full;
 * older messages are summarised to role + first 80 chars.
 * Optional `model` / `at` on each message label who sent what and when.
 */
export function compressConversation(
  messages: Array<{ role: string; content: string; model?: string; aiModel?: string; at?: string; timestamp?: string; createdAt?: string }> | undefined | null,
  opts?: { fullCount?: number; maxChars?: number },
): string {
  return compressConversationMessages(messages, {
    fullCount: opts?.fullCount ?? 6,
    maxChars: opts?.maxChars ?? CONTEXT_BUDGETS.conversation,
    recentMessageMax: 2000,
    olderSnippetMax: 80,
  });
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
  const psBudget = input.projectId
    ? CONTEXT_BUDGETS.projectSummaryInProject
    : CONTEXT_BUDGETS.projectSummary;
  const ps = String(input.projectSummary || "")
    .trim()
    .slice(0, psBudget);
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
    ws
      ? `[WORKSPACE_CONTEXT]\nBelow are the user's entire Vault contents. This is real data.\n${ws}`
      : "",
    media
      ? `[VAULT]\nThe user asked for saved content. Below are items from their Vault. Reference them in chat by title; do NOT emit pull/embed markers — there is no canvas to place items on.\nEach item shows: "title" (id=<noteId>) — files: <type>[<index>]\n\n${media}`
      : "",
    input.fullContext && input.fullContext !== user
      ? `[REQUEST_CONTEXT]\n${String(input.fullContext).slice(0, 16000)}`
      : "",
    ps ? `[PROJECT_KNOWLEDGE]\n${ps}` : "",
    ctx ? `[CONTEXT]\n${ctx}` : "",
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
