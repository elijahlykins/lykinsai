import { buildSynthesisTrainingPrompt } from './prompts.js';
import { callClaudeForTraining } from './callClaude.js';
import { parseClaudePairs } from './parseClaudePairs.js';
import {
  GENERIC_RESPONSE_PATTERNS,
  MIN_RESPONSE_CHARS,
  SYNTHESIS_PAIRS_PER_CALL,
} from './constants.js';

/**
 * One Claude call → validated pairs from beliefs/facts/rules.
 */
export async function generatePairsFromSynthesis(synthesis, opts = {}) {
  const pairsPerCall = opts.pairsPerCall || SYNTHESIS_PAIRS_PER_CALL;
  const userPrompt = buildSynthesisTrainingPrompt({
    beliefs: synthesis.beliefs || [],
    facts: synthesis.facts || [],
    rules: synthesis.rules || [],
    pairsCount: pairsPerCall,
  });

  const { text, model, usage } = await callClaudeForTraining({
    userPrompt,
    model: opts.model,
  });

  const { pairs, errors } = parseClaudePairs(text, {
    minResponseChars: MIN_RESPONSE_CHARS,
    genericPatterns: GENERIC_RESPONSE_PATTERNS,
  });

  return {
    pairs,
    model,
    usage,
    parseErrors: errors,
    rawLength: text.length,
  };
}
