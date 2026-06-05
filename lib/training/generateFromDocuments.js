import { buildDocumentTrainingPrompt } from './prompts.js';
import { callClaudeForTraining } from './callClaude.js';
import { parseClaudePairs } from './parseClaudePairs.js';
import { runPool } from './runPool.js';
import {
  DOCUMENT_PAIRS_PER_CHUNK,
  GENERIC_RESPONSE_PATTERNS,
  MAX_CONCURRENT_CLAUDE,
  MIN_RESPONSE_CHARS,
  TRAINING_SET_MODEL,
} from './constants.js';

/**
 * Claude call per vault document chunk, with concurrency cap.
 */
export async function generatePairsFromDocuments(documentChunks, opts = {}) {
  const chunks = (documentChunks || []).filter((c) => c?.text?.length >= 200);
  if (!chunks.length) {
    return {
      pairs: [],
      model: opts.model || TRAINING_SET_MODEL,
      chunksProcessed: 0,
      chunksFailed: 0,
      parseErrors: [],
    };
  }

  const pairsPerChunk = opts.pairsPerChunk || DOCUMENT_PAIRS_PER_CHUNK;
  const concurrency = opts.concurrency || MAX_CONCURRENT_CLAUDE;
  let lastModel = opts.model || TRAINING_SET_MODEL;
  const allPairs = [];
  const parseErrors = [];
  let chunksFailed = 0;

  const results = await runPool(chunks, concurrency, async (chunk) => {
    const userPrompt = buildDocumentTrainingPrompt(chunk.text, pairsPerChunk);
    const { text, model, usage } = await callClaudeForTraining({
      userPrompt,
      model: opts.model,
      maxTokens: 8192,
    });
    const { pairs, errors } = parseClaudePairs(text, {
      minResponseChars: MIN_RESPONSE_CHARS,
      genericPatterns: GENERIC_RESPONSE_PATTERNS,
    });
    return {
      pairs,
      errors,
      model,
      usage,
      note_id: chunk.note_id,
      chunk_index: chunk.chunk_index,
    };
  });

  for (const r of results) {
    if (!r?.ok) {
      chunksFailed += 1;
      console.warn('[training] document chunk failed:', r?.error?.message || r?.error);
      continue;
    }
    const v = r.value;
    if (v.model) lastModel = v.model;
    if (v.errors?.length) parseErrors.push(...v.errors);
    if (v.pairs?.length) allPairs.push(...v.pairs);
  }

  return {
    pairs: allPairs,
    model: lastModel,
    chunksProcessed: chunks.length - chunksFailed,
    chunksFailed,
    parseErrors,
  };
}
