import { fetchTrainingSources } from './fetchTrainingSources.js';
import { generatePairsFromSynthesis } from './generateFromSynthesis.js';
import { generatePairsFromDocuments } from './generateFromDocuments.js';
import { generatePairsFromConversations } from './generateFromConversations.js';
import { dedupeAndShufflePairs } from './parseClaudePairs.js';
import { pairsToJsonl } from './writeJsonl.js';
import { MAX_PAIRS_V1, TRAINING_SET_MODEL } from './constants.js';

function vaultIncludesDocuments(vaultSource) {
  return vaultSource === 'all' || vaultSource === 'tagged' || vaultSource === 'selected';
}

/** Proportional shrink of per-source counts after global dedupe/cap. */
export function sourceCountsAfterDedupe(rawBySource, finalCount) {
  const keys = Object.keys(rawBySource);
  const totalRaw = keys.reduce((sum, k) => sum + (rawBySource[k] || 0), 0);
  const empty = Object.fromEntries(keys.map((k) => [k, 0]));
  if (!totalRaw || !finalCount) return empty;
  if (finalCount >= totalRaw) return { ...rawBySource };

  const ratio = finalCount / totalRaw;
  const out = {};
  let allocated = 0;
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (i === keys.length - 1) {
      out[k] = Math.max(0, finalCount - allocated);
    } else {
      out[k] = Math.round((rawBySource[k] || 0) * ratio);
      allocated += out[k];
    }
  }
  return out;
}

/**
 * Orchestrate training set: synthesis + optional vault docs + optional chats.
 */
export async function generateTrainingSet(client, userId, opts = {}) {
  const vaultSource = opts.vaultSource || 'synthesis';
  const includeChats = !!opts.includeChats;

  const sources = await fetchTrainingSources(client, userId, {
    vaultSource,
    vault: opts.vault,
    includeChats,
    vaultTags: opts.vaultTags,
    vaultNoteIds: opts.vaultNoteIds,
    synthesisMode: opts.synthesisMode,
    excludedBeliefIds: opts.excludedBeliefIds,
    includedNeurons: opts.includedNeurons,
  });

  if (includeChats && sources.chatsBlockedByOptOut) {
    const err = new Error(
      'Chat training is disabled in your privacy settings (training opt-out). Turn it off in Settings to include conversations.',
    );
    err.code = 'training_opt_out';
    throw err;
  }

  const includeSynthesis = sources.hasSynthesis;
  const includeDocuments =
    vaultIncludesDocuments(vaultSource) && (sources.documentChunks?.length || 0) > 0;
  const includeConversations = includeChats && sources.hasConversations;

  if (!includeSynthesis && !includeDocuments && !includeConversations) {
    const parts = [];
    if (!includeSynthesis) {
      parts.push('beliefs, facts, or rules in your synthesis layer');
    }
    if (vaultIncludesDocuments(vaultSource) && !includeDocuments) {
      parts.push('vault notes with enough text');
    }
    if (includeChats && !includeConversations) {
      parts.push('saved chat exchanges (chat in grid, project, or vault)');
    }
    const err = new Error(
      `Add at least one training source: ${parts.join('; ')}.`,
    );
    err.code = 'insufficient_data';
    throw err;
  }

  const allPairs = [];
  const parseErrors = [];
  let modelUsed = TRAINING_SET_MODEL;
  const rawBySource = {
    synthesis_layer: 0,
    raw_documents: 0,
    past_conversations: 0,
  };
  let documentChunksProcessed = 0;
  let documentChunksFailed = 0;
  let conversationExchangesUsed = 0;
  let conversationExchangesFiltered = 0;

  if (includeSynthesis) {
    const syn = await generatePairsFromSynthesis(sources.synthesis, {
      model: opts.model,
      pairsPerCall: opts.pairsPerCall,
    });
    if (syn.model) modelUsed = syn.model;
    if (syn.parseErrors?.length) parseErrors.push(...syn.parseErrors);
    rawBySource.synthesis_layer = syn.pairs.length;
    allPairs.push(...syn.pairs);
  }

  if (includeDocuments) {
    const doc = await generatePairsFromDocuments(sources.documentChunks, {
      model: opts.model || modelUsed,
    });
    if (doc.model) modelUsed = doc.model;
    if (doc.parseErrors?.length) parseErrors.push(...doc.parseErrors);
    rawBySource.raw_documents = doc.pairs.length;
    documentChunksProcessed = doc.chunksProcessed;
    documentChunksFailed = doc.chunksFailed;
    allPairs.push(...doc.pairs);
  }

  if (includeConversations) {
    const conv = generatePairsFromConversations(sources.conversationExchanges);
    rawBySource.past_conversations = conv.pairs.length;
    conversationExchangesUsed = conv.exchangesUsed;
    conversationExchangesFiltered = conv.exchangesFiltered;
    allPairs.push(...conv.pairs);
  }

  const pairs = dedupeAndShufflePairs(allPairs, opts.maxPairs || MAX_PAIRS_V1);
  if (!pairs.length) {
    const err = new Error('No valid training pairs after filtering. Try again or add more source data.');
    err.code = 'no_pairs';
    throw err;
  }

  const sourceCounts = sourceCountsAfterDedupe(rawBySource, pairs.length);

  const metadata = {
    user_id: userId,
    generated_at: new Date().toISOString(),
    total_pairs: pairs.length,
    sources: {
      synthesis_layer: sourceCounts.synthesis_layer ?? 0,
      raw_documents: sourceCounts.raw_documents ?? 0,
      past_conversations: sourceCounts.past_conversations ?? 0,
    },
    model_used: modelUsed,
    status: 'ready',
    vault_source: vaultSource,
    include_chats: includeChats,
    input_stats: sources.stats,
    document_chunks_processed: documentChunksProcessed,
    document_chunks_failed: documentChunksFailed,
    conversation_exchanges_used: conversationExchangesUsed,
    conversation_exchanges_filtered: conversationExchangesFiltered,
    pairs_before_dedupe: allPairs.length,
    parse_errors: parseErrors.slice(0, 50),
  };

  return {
    jsonl: pairsToJsonl(pairs),
    metadata,
    pairs,
  };
}
