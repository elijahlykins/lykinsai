"use strict";

/**
 * Bot opt-in copy when an ask can be served by a named MCP plugin
 * (Gmail, Drive, Slack, …) instead of only the browser.
 *
 * Heuristic only — it decides the question, never the execution path.
 * The user naming the browser outright keeps the original browser-only ask.
 */

const PLUGIN_OFFERS = [
  { name: "Gmail", catalogId: "lykn:gmail", re: /\b(gmail|inbox|e-?mails?|mail from|my mail)\b/i },
  { name: "Google Drive", catalogId: "lykn:google-drive", re: /\b(google drive|gdrive|google docs?|in drive)\b/i },
  { name: "Slack", catalogId: "lykn:slack", re: /\bslack\b/i },
  { name: "Notion", catalogId: "lykn:notion", re: /\bnotion\b/i },
  { name: "GitHub", catalogId: "lykn:github", re: /\bgithub\b/i },
  { name: "Linear", catalogId: "lykn:linear", re: /\blinear\b/i },
];

const EXPLICIT_BROWSER_RE =
  /\b(?:in|on|use|using|with|via|through|open)\s+(?:the\s+|my\s+|a\s+)?browser\b/i;

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pluginOfferForAsk(instruction, objective) {
  const blob = [instruction, objective].filter(Boolean).join("\n");
  if (!blob.trim()) return null;
  if (EXPLICIT_BROWSER_RE.test(blob)) return null;
  for (const offer of PLUGIN_OFFERS) {
    if (offer.re.test(blob)) {
      return { name: offer.name, catalogId: offer.catalogId };
    }
  }
  return null;
}

function browserOptInPrompt(instruction, objective) {
  const plugin = pluginOfferForAsk(instruction, objective);
  if (plugin) {
    return {
      question: `I can connect ${plugin.name} through a plugin, or open the browser and do it there. Which do you want?`,
      questionOptions: [`Connect ${plugin.name}`, "Use the browser", "Just answer here"],
      plugin,
    };
  }
  return {
    question:
      "This looks like something I'd need the browser for - want me to open it up and take care of it?",
    questionOptions: ["Yes, use the browser", "No, just answer here"],
    plugin: null,
  };
}

function classifyOptInReply(text, plugin) {
  const q = String(text || "").trim();
  if (!q) return "";
  if (plugin) {
    const name = escapeRegExp(plugin.name);
    if (new RegExp(`^\\W*connect\\s+${name}\\W*$`, "i").test(q)) return "connect";
    if (new RegExp(`\\bconnect(?:\\s+(?:my|the))?\\s+${name}\\b`, "i").test(q) && !EXPLICIT_BROWSER_RE.test(q)) {
      return "connect";
    }
  }
  if (
    /^\W*(?:connect(?:\s+(?:it|via|through|with))?(?:\s+a)?\s+plugin|use(?:\s+(?:the|a))?\s+plugin|plugin)\W*$/i.test(
      q,
    )
  ) {
    return "connect";
  }
  return "";
}

module.exports = {
  PLUGIN_OFFERS,
  pluginOfferForAsk,
  browserOptInPrompt,
  classifyOptInReply,
};
