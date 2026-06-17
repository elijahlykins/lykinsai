import { isLowQualityPair } from './parseClaudePairs.js';
import {
  GENERIC_RESPONSE_PATTERNS,
  MIN_CONVERSATION_ASSISTANT_CHARS,
  MIN_CONVERSATION_USER_CHARS,
} from './constants.js';
import { stripAttachmentsMarker } from '../vault/attachmentsMarker.js';

/**
 * Remove streaming artifacts, neuron tags, and attachment payloads.
 */
export function stripChatArtifacts(text) {
  let s = String(text || '');
  // Span-aware strip (preserves any connector body that follows the marker)
  // instead of the old "delete to EOF" regex.
  s = stripAttachmentsMarker(s).trim();
  s = s.replace(/<learned[\s\S]*?<\/learned>/gi, '').trim();
  s = s.replace(/<updated[\s\S]*?<\/updated>/gi, '').trim();
  const learnedIdx = s.indexOf('<learned');
  const updatedIdx = s.indexOf('<updated');
  let cutIdx = -1;
  if (learnedIdx !== -1 && updatedIdx !== -1) cutIdx = Math.min(learnedIdx, updatedIdx);
  else if (learnedIdx !== -1) cutIdx = learnedIdx;
  else if (updatedIdx !== -1) cutIdx = updatedIdx;
  if (cutIdx !== -1) s = s.slice(0, cutIdx).trimEnd();
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Map one stored exchange → canonical training pair (or null if unusable).
 */
export function exchangeToTrainingPair(exchange) {
  const prompt = stripChatArtifacts(exchange?.user_message);
  const response = stripChatArtifacts(exchange?.assistant_message);
  if (prompt.length < MIN_CONVERSATION_USER_CHARS) return null;
  if (response.length < MIN_CONVERSATION_ASSISTANT_CHARS) return null;
  const row = { prompt, response };
  if (isLowQualityPair(row, {
    minResponseChars: MIN_CONVERSATION_ASSISTANT_CHARS,
    genericPatterns: GENERIC_RESPONSE_PATTERNS,
  })) {
    return null;
  }
  return row;
}

/**
 * Turn cleaned conversation memory rows into training pairs (no Claude call).
 */
export function pairsFromConversationExchanges(exchanges, opts = {}) {
  const maxPairs = Math.max(1, opts.maxPairs || 80);
  const pairs = [];
  let filtered = 0;

  for (const ex of exchanges || []) {
    const row = exchangeToTrainingPair(ex);
    if (!row) {
      filtered += 1;
      continue;
    }
    pairs.push(row);
    if (pairs.length >= maxPairs) break;
  }

  return {
    pairs,
    exchangesConsidered: (exchanges || []).length,
    exchangesUsed: pairs.length,
    exchangesFiltered: filtered,
  };
}
