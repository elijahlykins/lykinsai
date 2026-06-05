import { pairsFromConversationExchanges } from './cleanConversationPairs.js';
import { MAX_CONVERSATION_PAIRS_PER_JOB } from './constants.js';

/**
 * Direct prompt/response pairs from stored chat exchanges (cleaned, no Claude).
 */
export function generatePairsFromConversations(conversationExchanges, opts = {}) {
  const out = pairsFromConversationExchanges(conversationExchanges, {
    maxPairs: opts.maxPairs || MAX_CONVERSATION_PAIRS_PER_JOB,
  });
  return {
    pairs: out.pairs,
    exchangesConsidered: out.exchangesConsidered,
    exchangesUsed: out.exchangesUsed,
    exchangesFiltered: out.exchangesFiltered,
  };
}
