// Shared web-search intent helpers for server pre-fetch + Glass forceWebSearch.
// Keep "ask first" for casual browsing; auto-search when the ask needs
// knowledge past gpt-4.1-nano's ~June 2024 cutoff (or any stale training).
// Regular chat (no Web / Deep research composer mode) uses the same detector.

'use strict';

/** Explicit user opt-in: "search the web", "google it", "look it up online". */
const EXPLICIT_WEB_SEARCH_INTENT =
  /\b(search\s+(?:the\s+web|online|for\s+)|browse\s+(?:the\s+web|online|for\s+)|look\s+(?:it|that|this)?\s*up(?:\s+online)?|google\s+(?:it|that|this|for|\w+)|find\s+(?:.{1,40}?)\s+online)\b/i;

/** "do live research on X" / "research the latest …" — a topic, not a capability Q. */
const RESEARCH_TOPIC_INTENT =
  /\b(?:(?:do|run|perform)\s+(?:some\s+|a\s+)?(?:live\s+)?research\s+(?:on|into|about|for)|(?:live\s+)?research\s+(?:on|into|about|for)\s+\S|research\s+(?:the|this|that)\s+)/i;

// Workspace-scoped asks stay Vault-only ("compare my models", "what's on my board").
const WORKSPACE_SCOPED_FOR_SEARCH =
  /\b(my\s+(?:board|notes?|project|ideas?|media|files?|workspace|vault|saved|bricks?|blocks?|grid|canvas|stuff|content|work|progress|models?|agents?|reminders?)|(?:models?|agents?|reminders?)\s+(?:i|we)\s+(?:built|made|created|have|set\s*up)|model\s+builder|on\s+(?:the|this)\s+(?:board|grid|canvas)|(?:in|from)\s+(?:my|the)\s+(?:project|workspace|notes?|media|vault))\b/i;

const GREETING_FOR_SEARCH =
  /^(?:(?:hi|hello|hey|yo|thanks|thank\s*you|ok(?:ay)?|sure|yes|no|yep|nope|got\s*it|cool)[\s,!.?…-]*)+$/i;

/** Well-known newsrooms — naming one is enough to go fetch, no pasted URL. */
const NEWS_OUTLETS = [
  { re: /\bfox\s*news\b/i, name: 'Fox News' },
  { re: /\bcnn\b/i, name: 'CNN' },
  { re: /\bmsnbc\b/i, name: 'MSNBC' },
  { re: /\bbbc(?:\s+news)?\b/i, name: 'BBC News' },
  { re: /\bnpr\b/i, name: 'NPR' },
  { re: /\breuters\b/i, name: 'Reuters' },
  { re: /\b(?:associated\s+press|\bap\s+news)\b/i, name: 'Associated Press' },
  { re: /\b(?:new\s+york\s+times|nytimes|\bnyt\b)\b/i, name: 'New York Times' },
  { re: /\b(?:washington\s+post|wapo)\b/i, name: 'Washington Post' },
  { re: /\b(?:wall\s+street\s+journal|\bwsj\b)\b/i, name: 'Wall Street Journal' },
  { re: /\busa\s+today\b/i, name: 'USA Today' },
  { re: /\bpolitico\b/i, name: 'Politico' },
  { re: /\bthe\s+hill\b/i, name: 'The Hill' },
  { re: /\bbloomberg\b/i, name: 'Bloomberg' },
  { re: /\bthe\s+guardian\b/i, name: 'The Guardian' },
  { re: /\bal\s*jazeera\b/i, name: 'Al Jazeera' },
  { re: /\babc\s+news\b/i, name: 'ABC News' },
  { re: /\bcbs\s+news\b/i, name: 'CBS News' },
  { re: /\bnbc\s+news\b/i, name: 'NBC News' },
  { re: /\bnewsweek\b/i, name: 'Newsweek' },
];

const HEADLINE_FRONT_ASK =
  /\b(?:top\s+)?headlines?|front\s*pages?|home\s*pages?|breaking(?:\s+news)?|what(?:'s| is)\s+(?:on\s+)?(?:the\s+)?(?:front|home)\b/i;

const SOURCE_READ_VERB =
  /\b(?:read|pull|fetch|get|summarize|summarise|cover(?:age)?|from|on|via|according\s+to)\b/i;

/**
 * "Can you do live research?" / "do you have web access?" — capability, not a
 * topic to search. Regular chat should answer YES (web tools stay available)
 * without firing Serper on the question itself.
 */
function isLiveWebCapabilityAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 160) return false;
  if (isReadSourceCapabilityAsk(t)) return true;
  if (
    /^(?:so\s+|hey\s*,?\s*|hi\s*,?\s*|hello\s*,?\s*|ok(?:ay)?\s*,?\s*|wait\s*,?\s*)?(?:can|could|do|does|are|is|will|would)\s+(?:you|u|lykn|this)\s+(?:actually\s+|really\s+|even\s+)?(?:do\s+|run\s+|perform\s+|handle\s+|use\s+|have\s+|access\s+)?(?:live\s+)?(?:research|web\s+search(?:es)?|search(?:es)?(?:\s+the\s+web)?|look(?:ing)?\s+things\s+up|browse(?:\s+the\s+web)?|live\s+web(?:\s+access)?|web\s+access)\s*[?.!]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  return /^(?:do\s+you\s+have\s+(?:live\s+)?(?:web\s+access|web\s+search|live\s+search|search)|have\s+you\s+got\s+(?:live\s+)?web)\s*[?.!]*$/i.test(
    t,
  );
}

/** "Can you read from a specific source I ask you?" — confirm, then wait for the name. */
function isReadSourceCapabilityAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 180) return false;
  return /^(?:so\s+|hey\s*,?\s*|ok(?:ay)?\s*,?\s*)?(?:can|could|do|will|would)\s+(?:you|u|lykn)\s+(?:read|pull|fetch|get|summarize|summarise|look)\s+(?:from\s+)?(?:a\s+|any\s+|the\s+)?specific\s+source\b/i.test(
    t,
  );
}

function extractNamedOutlet(text) {
  const t = String(text || '');
  if (!t) return '';
  for (const outlet of NEWS_OUTLETS) {
    if (outlet.re.test(t)) return outlet.name;
  }
  return '';
}

function recentThreadBlob(conversation, maxTurns = 8) {
  const turns = Array.isArray(conversation) ? conversation : [];
  return turns
    .slice(-maxTurns)
    .map((turn) => `${turn?.role || ''}: ${turn?.content || turn?.text || ''}`)
    .join('\n');
}

/**
 * Named outlet and/or "top headlines" — go fetch. Do not wait for a pasted URL.
 */
function needsNamedSourceRead(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 500) return false;
  if (GREETING_FOR_SEARCH.test(t)) return false;
  if (WORKSPACE_SCOPED_FOR_SEARCH.test(t)) return false;
  if (isLiveWebCapabilityAsk(t)) return false;

  const hasOutlet = !!extractNamedOutlet(t);
  const wantsHeadlines = HEADLINE_FRONT_ASK.test(t);
  if (hasOutlet && wantsHeadlines) return true;
  if (hasOutlet && SOURCE_READ_VERB.test(t)) return true;
  if (hasOutlet && t.length <= 48) return true;
  if (wantsHeadlines && t.length <= 64) return true;
  return false;
}

function conversationImpliesNamedSourceRead(text, conversation) {
  const t = String(text || '').trim();
  if (!t) return false;
  const blob = recentThreadBlob(conversation);
  if (!blob) return false;
  const priorOutlet = extractNamedOutlet(blob);
  const priorSourceTalk =
    /\b(?:specific source|name the source|send (?:the )?(?:link|url)|read (?:from )?(?:a )?(?:specific )?(?:source|outlet)|top (?:fox )?headlines|fox news|current top headlines)\b/i.test(
      blob,
    );
  if (needsNamedSourceRead(t) && (priorOutlet || priorSourceTalk)) return true;
  if (HEADLINE_FRONT_ASK.test(t) && (priorOutlet || priorSourceTalk)) return true;
  if (extractNamedOutlet(t) && priorSourceTalk) return true;
  if (
    /^(yes|yeah|yep|sure|please|do it|go ahead|that|those|ok|okay)[.!?]*$/i.test(t) &&
    (priorOutlet || priorSourceTalk)
  ) {
    return true;
  }
  return false;
}

/**
 * Expand "top headlines" / "fox news" into a search query that includes the
 * outlet from this turn or the recent thread.
 */
function resolveWebSearchQuery(text, conversation) {
  const t = String(text || '').trim();
  const fromTurn = extractNamedOutlet(t);
  const fromThread = extractNamedOutlet(recentThreadBlob(conversation));
  const outlet = fromTurn || fromThread;
  if (fromTurn && (HEADLINE_FRONT_ASK.test(t) || t.length <= 48)) {
    return `${fromTurn} top headlines`;
  }
  if (outlet && HEADLINE_FRONT_ASK.test(t)) {
    return `${outlet} top headlines`;
  }
  if (
    outlet &&
    /^(yes|yeah|yep|sure|please|do it|go ahead|that|those|ok|okay)[.!?]*$/i.test(t)
  ) {
    return `${outlet} top headlines`;
  }
  return t;
}

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
  if (isLiveWebCapabilityAsk(t)) return false;

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
  const t = String(text || '');
  if (EXPLICIT_WEB_SEARCH_INTENT.test(t)) return true;
  if (WORKSPACE_SCOPED_FOR_SEARCH.test(t)) return false;
  return RESEARCH_TOPIC_INTENT.test(t);
}

/** Explicit opt-in OR live-freshness — either should arm pre-fetch / forceWebSearch. */
function shouldForceWebSearch(text, opts = {}) {
  const t = String(text || '');
  if (isLiveWebCapabilityAsk(t)) return false;
  if (hasExplicitWebSearchIntent(t) || needsLiveFreshnessSearch(t) || needsNamedSourceRead(t)) {
    return true;
  }
  if (opts.conversation && conversationImpliesNamedSourceRead(t, opts.conversation)) {
    return true;
  }
  return false;
}

/**
 * Keep lykn_web_search attached (no Serper pre-fetch). Capability questions
 * and live/explicit asks all need the tool loop in regular chat.
 */
function messageWantsWebTools(text, opts = {}) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (isLiveWebCapabilityAsk(t)) return true;
  if (shouldForceWebSearch(t, opts)) return true;
  return /\b(?:search (?:the )?web|web search|google|look\s+(?:it|that|this)\s+up|browse|latest|current\s+(?:news|price|prices|weather|score|scores|models?)|what(?:'s|\s+is)\s+the\s+(?:weather|score|price)|compare\s+(?:current|latest)|live\s+research|web\s+access|headlines?|specific source)\b/i.test(
    t,
  );
}

module.exports = {
  EXPLICIT_WEB_SEARCH_INTENT,
  RESEARCH_TOPIC_INTENT,
  NEWS_OUTLETS,
  needsLiveFreshnessSearch,
  hasExplicitWebSearchIntent,
  shouldForceWebSearch,
  isLiveWebCapabilityAsk,
  isReadSourceCapabilityAsk,
  needsNamedSourceRead,
  extractNamedOutlet,
  resolveWebSearchQuery,
  conversationImpliesNamedSourceRead,
  messageWantsWebTools,
};
