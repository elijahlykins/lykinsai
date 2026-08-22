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
 * classifier live; this module only carries the answer across.
 *
 * What it does NOT do is act on that answer straight away. Being moved into the
 * browser mid-thought is disruptive when it was not what the user wanted: the
 * view changes under them, a tab starts clicking through a product, and the
 * question they were actually asking goes unanswered. The classifier is reading
 * intent from a sentence, and it cannot know whether "set up the Mailchimp
 * campaign" meant "go do it" or "talk me through it". So a browser-shaped ask
 * becomes a question — jump to the browser and do it there, or stay here — and
 * the next message decides. Nothing is created, sent, or revealed until then.
 *
 * The ask is skipped only where consent is already on the record: the prompt
 * itself named the browser, or the user answered an earlier offer in this chat
 * with "always".
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
  /**
   * Set when the ask looked like browser work but we put the choice to the user
   * instead of acting. The turn ends here — no agent, no tab, no view change —
   * and the next send answers.
   */
  asked?: boolean;
  /** What to show in the chat thread in place of an answer. */
  note?: string;
};

/** An offer waiting on a yes or a no, per chat. */
type PendingOffer = { prompt: string; venue: string; askedAt: number };

const pendingOffers = new Map<string, PendingOffer>();
/** Chats where the user said "always", so we stop asking there. */
const standingConsent = new Set<string>();

/**
 * An unanswered offer goes stale. Past this, a lone "yeah" is far more likely to
 * be about whatever is being discussed now than about a browser task the user
 * left hanging half an hour ago.
 */
const OFFER_TTL_MS = 10 * 60 * 1000;

function offerKey(chatId?: string): string {
  return String(chatId || "").trim() || "default";
}

/** "no", "stay here", "just tell me" — anything that means keep it in chat. */
function readsAsDecline(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /^\s*(?:no|nope|nah|not now|maybe later|later|don'?t|do not|stay|keep|rather|skip|neither)\b/.test(t) ||
    /\b(?:stay (?:here|in (?:the )?chat)|keep it (?:here|in (?:the )?chat)|here is fine|no browser|without (?:the )?browser|just (?:tell|show|explain|answer|write))\b/.test(t)
  );
}

/** "yes", "go ahead", "jump to the browser" — anything that means go. */
function readsAsAccept(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /^\s*(?:ok(?:ay)?|yes|yeah|yep|yup|sure|please|alright|fine|perfect|great|absolutely|always|sounds good|that works|lgtm|go ahead|go for it|do it|jump|open it|browser)\b/.test(t) ||
    /\b(?:jump to (?:the )?browser|(?:open|use|go to) (?:the |a )?browser|do it (?:in|on) (?:the )?browser|in the browser)\b/.test(t)
  );
}

/**
 * Whatever the user added on top of the yes.
 *
 * "yes, and make the subject line shorter" is consent plus an instruction, and
 * the instruction has to travel with the task or the agent works from the older,
 * incomplete version of the ask.
 */
function extraInstructionInAccept(text: string): string {
  const rest = text
    .replace(
      /^\s*(?:ok(?:ay)?|yes|yeah|yep|yup|sure|please|alright|fine|perfect|great|absolutely|always|sounds good|that works|lgtm|go ahead|go for it|do it|jump to (?:the )?browser|jump|open it|browser)\b/i,
      "",
    )
    .replace(/^[\s,.!?—–-]*(?:and|then|also|but|plus)?\b/i, "")
    .trim();
  // Punctuation and filler ("yes please!", "sure thing") is not an instruction.
  return rest.length > 8 ? rest : "";
}

/** The user already named the browser, so there is nothing left to ask. */
function namesTheBrowser(text: string): boolean {
  return /\b(?:browser|new tab|in a tab|browser window)\b/i.test(text);
}

/** Create the agent, start the task, and move the user to where it happens. */
async function startInBrowser(
  api: DesktopBridge,
  prompt: string,
  venue: string,
): Promise<HandoffResult> {
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

  const product = productNameFromUrl(venue);
  return {
    handed: true,
    note: product
      ? `Opening **${product}** in the browser and doing this there — you can watch each step, and take over the tab whenever you want.`
      : `Doing this in the browser — you can watch each step, and take over the tab whenever you want.`,
  };
}

/** The offer itself, worded so that either answer is an obvious next move. */
function offerNote(venue: string): string {
  const product = productNameFromUrl(venue);
  return product
    ? `This one I'd normally do in the browser — open **${product}** in a tab and work through it while you watch. Want me to jump over and do that, or stay here and work it out with you?`
    : `This one I'd normally do in the browser — open a tab and work through it while you watch. Want me to jump over and do that, or stay here and work it out with you?`;
}

/**
 * Offer the browser agent the ask if it belongs there — and act on the answer.
 *
 * @param text the user's prompt
 * @param opts.hasAttachments chat attachments do not survive the trip to the
 *   agent (it takes local file paths, the chat holds uploaded URLs), so an ask
 *   carrying files stays in chat rather than arriving there half-delivered
 * @param opts.chatId scopes a pending offer to the conversation it was made in,
 *   so a "yes" in one chat cannot start a task queued up in another
 */
export async function handOffAskToBrowserAgent(
  text: string,
  opts: { hasAttachments?: boolean; chatId?: string } = {},
): Promise<HandoffResult> {
  const prompt = String(text || "").trim();
  if (!prompt || opts.hasAttachments) return { handed: false };
  const api = bridge();
  if (!api) return { handed: false };

  const key = offerKey(opts.chatId);
  const pending = pendingOffers.get(key);
  if (pending) {
    if (Date.now() - pending.askedAt > OFFER_TTL_MS) {
      pendingOffers.delete(key);
    } else if (readsAsDecline(prompt)) {
      // Stay put. The ask and the offer are both in the thread, so the chat
      // model picks the work up from here.
      pendingOffers.delete(key);
      return { handed: false };
    } else if (readsAsAccept(prompt)) {
      pendingOffers.delete(key);
      if (/\balways\b/i.test(prompt)) standingConsent.add(key);
      const extra = extraInstructionInAccept(prompt);
      const task = extra ? `${pending.prompt}\n\n${extra}` : pending.prompt;
      return startInBrowser(api, task, pending.venue);
    } else {
      // Neither answer — the user moved on. Drop the offer and judge the new
      // message on its own merits below.
      pendingOffers.delete(key);
    }
  }

  let check: RouteCheck | null = null;
  try {
    check = await api.agentRouteCheck!(prompt);
  } catch {
    return { handed: false };
  }
  if (!check || check.route !== "agent") return { handed: false };

  const venue = String(check.venue || "");
  if (standingConsent.has(key) || namesTheBrowser(prompt)) {
    return startInBrowser(api, prompt, venue);
  }

  pendingOffers.set(key, { prompt, venue, askedAt: Date.now() });
  return { handed: false, asked: true, note: offerNote(venue) };
}

/** Test seam: forget every pending offer and standing yes. */
export function resetBrowserHandoffOffers(): void {
  pendingOffers.clear();
  standingConsent.clear();
}
