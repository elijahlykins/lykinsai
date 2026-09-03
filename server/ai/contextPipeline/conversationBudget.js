import { contextBudgetForTier } from './contextConfig.js';

const ANAPHORA_RE =
  /\b(same thing|as before|second (?:option|part|one)|first (?:option|part|one)|the previous|previous (?:code|example|one)|continue|what did i(?: just)? tell|how old|that code|the example|explain the second)\b/i;

export function conversationOptionsForTier(tier, extras = {}) {
  const budget = contextBudgetForTier(tier);
  const currentUserText = String(extras.currentUserText || '');
  const anaphoric = ANAPHORA_RE.test(currentUserText);
  return {
    fullCount: anaphoric ? Math.max(budget.recentFullCount, 8) : budget.recentFullCount,
    maxChars: budget.conversationChars,
    maxMessages: budget.conversationMessages,
    recentMessageMax: budget.recentMessageMax,
    olderSnippetMax: budget.olderSnippetMax,
    referenceMessageMax: budget.referenceMessageMax,
    includeTimestamps: false,
    currentUserText,
  };
}

export function conversationMemoryBudget(tier) {
  return contextBudgetForTier(tier).conversationMemoryChars;
}

export function looksLikeAnaphoricFollowUp(text) {
  return ANAPHORA_RE.test(String(text || ''));
}
