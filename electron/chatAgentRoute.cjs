/**
 * Does a chat prompt belong to the browser agent instead of the chat model?
 *
 * The chat surface cannot decide this for itself. Telling "open up Mailchimp and
 * build the campaign" apart from "what is Mailchimp good for?" needs the skill
 * classifier and a read of where the work belongs, both of which live in the
 * main process. When nobody
 * asks, the chat does the only thing a chat can do: it writes the campaign into
 * the conversation and suggests the user paste it into Mailchimp themselves —
 * the wrong outcome, delivered confidently, for an ask that the browser agent
 * one call away could have actually carried out.
 *
 * Two conditions have to hold before a turn leaves the conversation:
 *
 * 1. The skill is one that works by operating a page.
 * 2. The user named where — any app, in their own words, or a real URL. Not a
 *    list of products: an ask that names a tool nobody here has heard of is
 *    still an ask that names where it belongs.
 *
 * The second condition is what keeps this safe. The classifier is tuned for
 * Agent Mode, where the user has already chosen an agent that drives a browser,
 * so it leans toward browsing whenever an ask is ambiguous. In the chat the
 * default has to be the opposite, because opening a browser window on someone
 * who asked a question is far more disruptive than answering someone who wanted
 * a click. Requiring a destination is what keeps "what's the best time to send a
 * newsletter?" a question.
 */

const { classifyAgentSkill } = require("./agentRuntime.cjs");
const ownedBrowserAct = require("./ownedBrowserAct.cjs");
const workDestination = require("../lib/agentWorkDestination.cjs");

/** Skills that do their work by operating a real page. */
const BROWSER_SKILLS = new Set(["browse", "tool-create", "sheets-fill"]);

/**
 * @param {string} text the user's prompt
 * @returns {{ route: "chat" | "agent", skill?: string, venue?: string,
 *   destination?: string, reason?: string }}
 */
function decideChatRoute(text) {
  const prompt = String(text || "").trim();
  if (!prompt || prompt.length > 2000) return { route: "chat", reason: "no prompt" };
  let skill = "general";
  try {
    skill = String(classifyAgentSkill(prompt) || "general");
  } catch (_) {
    return { route: "chat", reason: "classifier unavailable" };
  }
  if (!BROWSER_SKILLS.has(skill)) return { route: "chat", skill };
  let venue = "";
  let url = "";
  try {
    venue = String(workDestination.destinationFromAsk(prompt) || "");
    url = String(ownedBrowserAct.extractUrlFromText?.(prompt) || "");
  } catch (_) {
    return { route: "chat", skill, reason: "destination lookup failed" };
  }
  if (!venue && !url) return { route: "chat", skill, reason: "no destination named" };
  return {
    route: "agent",
    skill,
    // What the user called the place. This is what they get told back, and a
    // search-fallback URL is not a place worth naming.
    venue,
    destination: venue || url,
  };
}

module.exports = { decideChatRoute, BROWSER_SKILLS };
