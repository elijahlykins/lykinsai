/**
 * Launch a LYKN browser agent from a desktop conversation.
 *
 * Host execution context (chatId) is trusted and never taken from model
 * tool arguments. The created tab is stamped with sourceChatId before
 * Studio projects state.
 */
import type { LocalToolResult } from "@/lib/localMode";
import { STUDIO_SHOW_BROWSER_EVENT } from "@/lib/lyknChat/openInStudioBrowser";
import { bindBrowserTabChat, markBrowserTabRevealed } from "@/lib/lyknChat/browserChatAttach";

type AgentBridge = {
  agentCreate?: (payload: {
    goal?: string;
    sourceChatId?: string;
  }) => Promise<{ ok?: boolean; agentId?: string } | null>;
  studioAgentSend?: (
    text: string,
    attachments: unknown[],
    agentId: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Trusted host execution context. Never taken from model tool arguments. */
export type LocalToolHostContext = {
  chatId?: string | null;
};

function hostChatId(host?: LocalToolHostContext): string {
  return String(host?.chatId || "").trim();
}

/**
 * local_browser_agent — the model decided this turn's work belongs in the
 * browser. Create a browser agent (its own tab), start the task, and move the
 * user to the browser so they can watch.
 *
 * `host.chatId` is the originating lykn_chats.id. Model args.chatId is ignored.
 */
export async function startBrowserAgentTask(
  args: Record<string, unknown>,
  host?: LocalToolHostContext,
): Promise<LocalToolResult> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!task) return { ok: false, error: "No task was provided for the browser agent." };
  const api =
    (typeof window !== "undefined"
      ? (window as unknown as { lykn?: AgentBridge }).lykn
      : undefined) || (globalThis as { lykn?: AgentBridge }).lykn;
  if (!api || typeof api.studioAgentSend !== "function") {
    return { ok: false, error: "The browser agent is only available in the desktop app." };
  }
  const chatId = hostChatId(host);
  const goal = url ? `${task}\n\nStart at: ${url}` : task;
  // Agents and tabs pair one-to-one, so give the task its own agent. An empty
  // id falls back to the active agent — a shared tab beats refusing the task.
  // Fallback never overwrites another conversation's tab lineage (main stamps
  // sourceChatId only when the tab is unbound or already this chat).
  let agentId = "";
  if (typeof api.agentCreate === "function") {
    try {
      const created = await api.agentCreate({
        goal,
        ...(chatId ? { sourceChatId: chatId } : {}),
      });
      if (created?.ok && created.agentId) agentId = String(created.agentId);
    } catch {
      /* fall through to the active agent */
    }
  }
  if (agentId && chatId) {
    bindBrowserTabChat(agentId, chatId);
    markBrowserTabRevealed(agentId);
  }
  try {
    // Resolves when the whole browser run finishes — must not be awaited, or
    // this chat turn would block for the length of the browser task.
    void api.studioAgentSend(
      goal,
      [],
      agentId,
      chatId ? { task: { chatId } } : {},
    ).catch(() => {});
  } catch {
    return { ok: false, error: "Couldn't start the browser agent." };
  }
  try {
    window.dispatchEvent(
      new CustomEvent(STUDIO_SHOW_BROWSER_EVENT, {
        detail: {
          agentId: agentId || undefined,
          chatId: chatId || undefined,
        },
      }),
    );
  } catch {
    /* the agent still runs; only the automatic reveal is lost */
  }
  return {
    ok: true,
    note:
      "The browser agent is now running the task in its own tab, and the user has been " +
      "moved to the browser to watch. Tell them it's underway there and they can take over " +
      "the tab anytime. Do NOT describe steps as if you performed them yourself.",
  };
}
