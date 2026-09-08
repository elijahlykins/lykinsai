/**
 * Launch a LYKN browser agent from a desktop conversation.
 *
 * The agent tab is its OWN conversation: it is never bound to the chat
 * that launched it, so the launching LYKN chat and the agent's rail chat
 * can run side by side without mixing. The rail mints a fresh lykn_chats
 * row on the first Ask-LYKN send (startChatForUnboundBrowserTab).
 */
import type { LocalToolResult } from "@/lib/localMode";
import { STUDIO_SHOW_BROWSER_EVENT } from "@/lib/lyknChat/openInStudioBrowser";
import { markBrowserTabRevealed } from "@/lib/lyknChat/browserChatAttach";

type AgentBridge = {
  agentCreate?: (payload: {
    goal?: string;
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

/**
 * local_browser_agent — the model decided this turn's work belongs in the
 * browser. Create a browser agent (its own tab), start the task, and move the
 * user to the browser so they can watch.
 *
 * Separation contract: the launching chat's id is deliberately NOT stamped
 * onto the tab (no renderer bind, no main-process sourceChatId, no
 * task.chatId lineage). Any of those would make the agent rail render the
 * launching LYKN chat instead of the agent's own thread.
 */
export async function startBrowserAgentTask(
  args: Record<string, unknown>,
  _host?: LocalToolHostContext,
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
  const goal = url ? `${task}\n\nStart at: ${url}` : task;
  // Agents and tabs pair one-to-one, so give the task its own agent. An empty
  // id falls back to the active agent — a shared tab beats refusing the task.
  let agentId = "";
  if (typeof api.agentCreate === "function") {
    try {
      const created = await api.agentCreate({ goal });
      if (created?.ok && created.agentId) agentId = String(created.agentId);
    } catch {
      /* fall through to the active agent */
    }
  }
  if (agentId) markBrowserTabRevealed(agentId);
  try {
    // Resolves when the whole browser run finishes — must not be awaited, or
    // this chat turn would block for the length of the browser task.
    void api.studioAgentSend(goal, [], agentId, {}).catch(() => {});
  } catch {
    return { ok: false, error: "Couldn't start the browser agent." };
  }
  try {
    window.dispatchEvent(
      new CustomEvent(STUDIO_SHOW_BROWSER_EVENT, {
        detail: {
          agentId: agentId || undefined,
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
      "moved to the browser to watch. It runs as its own separate conversation — this " +
      "chat stays independent. Tell the user it's underway there and they can take over " +
      "the tab anytime. Do NOT describe steps as if you performed them yourself.",
  };
}
