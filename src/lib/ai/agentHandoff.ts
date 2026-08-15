/**
 * Handing a chat ask over to the browser agent.
 *
 * "Open up Mailchimp and build the campaign" is not a question, and answering
 * it in the chat window is not doing it. The chat model has no browser, so its
 * best possible response is to write the campaign into the conversation and ask
 * the user to paste it in themselves — a worse outcome than the one they asked
 * for, delivered confidently. The browser agent, which can actually do the job,
 * sits one IPC call away and was simply never consulted.
 *
 * So before a send becomes a chat turn, ask the desktop whether this is browser
 * work. The decision is made in main, where the venue table and the skill
 * classifier live; this module only carries the answer across and moves the
 * user to where the work is happening.
 *
 * On the web build there is no owned browser, so nothing here applies and every
 * ask stays in chat.
 */

import { STUDIO_SHOW_BROWSER_EVENT } from "@/lib/lyknChat/openInStudioBrowser";

type RouteCheck = {
  route?: "chat" | "agent";
  skill?: string;
  /** Set only when the user named a product we recognize. */
  venue?: string;
  destination?: string;
};

type DesktopBridge = {
  agentRouteCheck?: (text: string) => Promise<RouteCheck | null>;
  agentCreate?: (payload: {
    title?: string;
    goal?: string;
  }) => Promise<{ ok?: boolean; agentId?: string } | null>;
  studioAgentSend?: (
    text: string,
    attachments: unknown[],
    agentId: string,
    opts?: { fromSuggestion?: boolean },
  ) => Promise<unknown>;
};

function bridge(): DesktopBridge | null {
  const api = (globalThis as { lykn?: DesktopBridge }).lykn;
  if (!api || typeof api.agentRouteCheck !== "function") return null;
  if (typeof api.studioAgentSend !== "function") return null;
  return api;
}

/**
 * A tab of its own for this task.
 *
 * Agents and browser tabs are paired one to one, so a task without its own agent
 * has to borrow someone else's tab. Sending with a blank id does not avoid this:
 * the runtime resolves a blank id to whichever agent is currently active, so the
 * second task handed over from a chat lands on top of the first one's work and
 * appears under its heading.
 *
 * Returns "" when no new agent could be made — at the ceiling of 20 workers, for
 * instance — which the caller treats as "use the active agent", since finishing
 * the task in a shared tab beats refusing to start it.
 */
async function freshAgentFor(api: DesktopBridge, prompt: string): Promise<string> {
  if (typeof api.agentCreate !== "function") return "";
  try {
    // The runtime titles the agent from the goal, and pairs a browser tab with
    // it, focused. It does not begin the task — the send below does that.
    const created = await api.agentCreate({ goal: prompt });
    if (created?.ok && created.agentId) return String(created.agentId);
  } catch {
    /* fall through to the active agent */
  }
  return "";
}

/** "https://admin.mailchimp.com" → "Mailchimp", for telling the user where we went. */
export function productNameFromUrl(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    return "";
  }
  // Drop the account/app subdomain and the TLD — "admin.mailchimp.com" and
  // "app.hubspot.com" should both read as the product, not the deployment.
  const parts = host.replace(/^www\./i, "").split(".").filter(Boolean);
  if (parts.length < 2) return "";
  const name = parts[parts.length - 2];
  if (!name || name.length < 2) return "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export type HandoffResult = {
  handed: boolean;
  /** What to show in the chat thread in place of an answer. */
  note?: string;
};

/**
 * Give the ask to the browser agent if it belongs there.
 *
 * @param text the user's prompt
 * @param opts.hasAttachments chat attachments do not survive the trip to the
 *   agent (it takes local file paths, the chat holds uploaded URLs), so an ask
 *   carrying files stays in chat rather than arriving there half-delivered
 */
export async function handOffAskToBrowserAgent(
  text: string,
  opts: { hasAttachments?: boolean } = {},
): Promise<HandoffResult> {
  const prompt = String(text || "").trim();
  if (!prompt || opts.hasAttachments) return { handed: false };
  const api = bridge();
  if (!api) return { handed: false };

  let check: RouteCheck | null = null;
  try {
    check = await api.agentRouteCheck!(prompt);
  } catch {
    return { handed: false };
  }
  if (!check || check.route !== "agent") return { handed: false };

  const agentId = await freshAgentFor(api, prompt);
  try {
    // Resolves only when the whole run finishes, so it must not be awaited —
    // the composer would stay frozen for the length of the task.
    void api.studioAgentSend!(prompt, [], agentId, {}).catch(() => {});
  } catch {
    return { handed: false };
  }

  // Move the user to the browser, since that is where the work is now visible.
  try {
    window.dispatchEvent(new CustomEvent(STUDIO_SHOW_BROWSER_EVENT));
  } catch {
    /* the agent still runs; only the automatic reveal is lost */
  }

  const product = productNameFromUrl(check.venue || "");
  return {
    handed: true,
    note: product
      ? `Opening **${product}** in the browser and doing this there — you can watch each step, and take over the tab whenever you want.`
      : `Doing this in the browser — you can watch each step, and take over the tab whenever you want.`,
  };
}
