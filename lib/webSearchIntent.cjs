// Shared web-search intent helpers for server pre-fetch + Glass forceWebSearch.
// Keep "ask first" for casual browsing; auto-search when the ask needs
// knowledge past gpt-4.1-nano's ~June 2024 cutoff (or any stale training).

'use strict';

/** Explicit user opt-in: "search the web", "google it", "look it up online". */
const EXPLICIT_WEB_SEARCH_INTENT =
  /\b(search\s+(?:the\s+web|online|for\s+)|browse\s+(?:the\s+web|online|for\s+)|look\s+(?:it|that|this)?\s*up(?:\s+online)?|google\s+(?:it|that|this|for|\w+)|find\s+(?:.{1,40}?)\s+online)\b/i;

// Workspace-scoped asks stay Vault-only ("compare my models", "what's on my board").
const WORKSPACE_SCOPED_FOR_SEARCH =
  /\b(my\s+(?:board|notes?|project|ideas?|media|files?|workspace|vault|saved|bricks?|blocks?|grid|canvas|stuff|content|work|progress|models?|agents?|reminders?)|(?:models?|agents?|reminders?)\s+(?:i|we)\s+(?:built|made|created|have|set\s*up)|model\s+builder|on\s+(?:the|this)\s+(?:board|grid|canvas)|(?:in|from)\s+(?:my|the)\s+(?:project|workspace|notes?|media|vault))\b/i;

const GREETING_FOR_SEARCH =
  /^(?:(?:hi|hello|hey|yo|thanks|thank\s*you|ok(?:ay)?|sure|yes|no|yep|nope|got\s*it|cool)[\s,!.?…-]*)+$/i;

/**
 * True when the message needs live / post-cutoff facts — news, prices,
 * weather, or current AI/model landscape comparisons. Used to auto-run
 * Serper so nano doesn't invent a 2023–2024 table from memory.
 */
function needsLiveFreshnessSearch(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 8 || t.length > 500) return false;
  if (GREETING_FOR_SEARCH.test(t)) return false;
  if (WORKSPACE_SCOPED_FOR_SEARCH.test(t)) return false;

  // Hard live-world asks.
  if (
    /\b(?:today'?s\s+news|breaking\s+news|who\s+won|stock\s+price|share\s+price|weather\s+(?:in|today|tonight)|election\s+results?)\b/i.test(
      t,
    )
  ) {
    return true;
  }

  // Recency marker + something that changes over time.
  const hasRecency =
    /\b(?:latest|newest|current|currently|recent|up[- ]to[- ]date|right\s+now|as\s+of|this\s+(?:week|month|year)|in\s+202[5-9]|202[5-9])\b/i.test(
      t,
    );
  const hasLiveTopic =
    /\b(?:news|headline|price|pricing|weather|score|scores|stock|market|election|announce(?:d|ment)?|launch(?:ed)?|release(?:d)?|shipping|models?|llms?|ai\s+models?|frontier|chatgpt|claude|gemini|grok|llama|deepseek)\b/i.test(
      t,
    );
  if (hasRecency && hasLiveTopic) return true;

  // AI / model landscape — the Glass failure mode ("chart comparing all models").
  const hasModelTopic =
    /\b(?:models?|llms?|ai\s+models?|language\s+models?|frontier(?:\s+models?)?|gpt|chatgpt|claude|gemini|grok|llama|deepseek|openai|anthropic|mistral|qwen)\b/i.test(
      t,
    );
  const hasLandscapeFrame =
    /\b(?:compare|comparison|versus|vs\.?|rank(?:ing)?s?|leaderboard|landscape|state\s+of(?:\s+the)?\s+art|which\s+(?:model|llm)\s+is\s+best)\b/i.test(
      t,
    ) ||
    /\b(?:all|every|best|top)\s+(?:the\s+)?(?:current\s+|latest\s+|newest\s+)?(?:ai\s+|llm\s+|language\s+)?models?\b/i.test(
      t,
    ) ||
    /\b(?:list|chart|table|graph)\b.{0,50}\b(?:models?|llms?)\b/i.test(t) ||
    /\b(?:models?|llms?)\b.{0,50}\b(?:list|chart|table|graph|compare|comparison)\b/i.test(t);
  if (hasModelTopic && hasLandscapeFrame) return true;

  return false;
}

function hasExplicitWebSearchIntent(text) {
  return EXPLICIT_WEB_SEARCH_INTENT.test(String(text || ''));
}

/** Explicit opt-in OR live-freshness — either should arm pre-fetch / forceWebSearch. */
function shouldForceWebSearch(text) {
  const t = String(text || '');
  return hasExplicitWebSearchIntent(t) || needsLiveFreshnessSearch(t);
}

module.exports = {
  EXPLICIT_WEB_SEARCH_INTENT,
  needsLiveFreshnessSearch,
  hasExplicitWebSearchIntent,
  shouldForceWebSearch,
};
