// Prompt-structure versions and context budgets.
// Bump a version only when the matching stable prefix actually changes.

export const LYKN_SYSTEM_PROMPT_VERSION = '3';
export const LYKN_RUNTIME_PROMPT_VERSION = '1';
export const LYKN_TOOLSET_VERSION = '1';

export const CONTEXT_SECTION = Object.freeze({
  STABLE: 'stable',
  PERSONALIZATION: 'personalization',
  CONVERSATION: 'conversation',
  ATTACHMENTS: 'attachments',
  TOOLS: 'tools',
  CURRENT_TURN: 'currentTurn',
  DYNAMIC: 'dynamic',
});

// Markers that start uncached / per-turn content.
// Semi-stable user prefs, identity, intent, and inventory stay in the
// cacheable system prefix so consecutive normal turns keep a byte-stable head.
export const DYNAMIC_PROMPT_SECTION_MARKERS = Object.freeze([
  '[CONVERSATION',
  '[CONVERSATION_MEMORY',
  '[WORKSPACE_CONTEXT]',
  '[REQUEST_CONTEXT]',
  '[FULL_CONTEXT]',
  '[VAULT_URL_MATCHES]',
  '[PROJECT_KNOWLEDGE]',
  '[WHAT_IM_ON]',
  '[WHAT_IVE_SAVED]',
  '[CONTEXT]',
  '[ATTACHED_IMAGES]',
  '[LATEST_USER_MESSAGE]',
  '[USER]',
  '[CURRENT_TIME]',
  '[ARTIFACT_OPEN',
  '[UNTRUSTED_WEB',
  '[WEB_SEARCH_RESULTS]',
  '[DEEP_BROWSE_CONTENT]',
  '[SCRAPED_WEB_PAGES]',
  '[YOUTUBE_SEARCH_RESULTS]',
  '[CURSOR_BUILDS_FINISHED',
]);

export const SEMI_STABLE_SECTION_MARKERS = Object.freeze([
  '[USER_PREFERENCES]',
  '[ASSISTANT_IDENTITY]',
  '[INTENT]',
  '[PROJECT_ID]',
  '[RESPONSE_LENGTH]',
  '[ACTIVE_MODE]',
  '[LYKN APPS]',
  '[LYKN BOTS]',
  '[MAC APPS]',
  '[AI DRIVE]',
  '[CONNECTED_TOOLS]',
  '[CONNECTED_APPS',
]);

export const CONTEXT_BUDGETS_BY_TIER = Object.freeze({
  fast: Object.freeze({
    conversationChars: 6000,
    conversationMessages: 16,
    recentFullCount: 6,
    recentMessageMax: 900,
    olderSnippetMax: 120,
    referenceMessageMax: 420,
    conversationMemoryChars: 2000,
    mediaContextChars: 4000,
  }),
  standard: Object.freeze({
    conversationChars: 8000,
    conversationMessages: 20,
    recentFullCount: 8,
    recentMessageMax: 900,
    olderSnippetMax: 160,
    referenceMessageMax: 500,
    conversationMemoryChars: 4000,
    mediaContextChars: 8000,
  }),
  advanced: Object.freeze({
    conversationChars: 12000,
    conversationMessages: 24,
    recentFullCount: 10,
    recentMessageMax: 1100,
    olderSnippetMax: 200,
    referenceMessageMax: 700,
    conversationMemoryChars: 6000,
    mediaContextChars: 8000,
  }),
});

export function contextBudgetForTier(tier) {
  const key = String(tier || '').toLowerCase();
  return CONTEXT_BUDGETS_BY_TIER[key] || CONTEXT_BUDGETS_BY_TIER.standard;
}
