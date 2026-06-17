import {
  listActiveBeliefsForUser,
  listActiveRulesForUser,
} from '../../beliefSystem.js';
import { listActiveFactsForUser } from '../../userModelLearning.js';
import { expandNotesToDocumentChunks } from './chunkText.js';
import { MAX_VAULT_CHUNKS_PER_JOB, MAX_CONVERSATION_EXCHANGES_FETCH } from './constants.js';
import {
  fetchConversationExchanges,
  fetchUserTrainingPreferences,
} from './fetchConversationExchanges.js';

const DEFAULT_NOTE_LIMIT = 30;
const DEFAULT_MAX_CHARS_PER_NOTE = 14_000;

function truncateText(text, maxChars) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…`;
}

function vaultIncludesDocuments(vaultSource) {
  return vaultSource === 'all' || vaultSource === 'tagged' || vaultSource === 'selected';
}

function filterSynthesisLayer(synthesis, opts = {}) {
  const mode = String(opts.synthesisMode || 'all').trim() || 'all';
  if (mode === 'selected') {
    const included = Array.isArray(opts.includedNeurons) ? opts.includedNeurons : [];
    const byKind = {
      belief: new Set(),
      fact: new Set(),
      rule: new Set(),
    };
    for (const item of included) {
      const kind = String(item?.kind || '').trim();
      const id = String(item?.id || '').trim();
      if (!id || !byKind[kind]) continue;
      byKind[kind].add(id);
    }
    return {
      beliefs: (synthesis.beliefs || []).filter((b) => byKind.belief.has(b.id)),
      rules: (synthesis.rules || []).filter((r) => byKind.rule.has(r.id)),
      facts: (synthesis.facts || []).filter((f) => byKind.fact.has(f.id)),
    };
  }

  const excluded = new Set(
    (Array.isArray(opts.excludedBeliefIds) ? opts.excludedBeliefIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );
  return {
    beliefs: (synthesis.beliefs || []).filter((b) => !excluded.has(b.id)),
    rules: synthesis.rules || [],
    facts: synthesis.facts || [],
  };
}

/**
 * Recent vault notes as raw text for document chunking.
 */
export async function fetchVaultNoteChunks(client, userId, opts = {}) {
  if (!client || !userId) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_NOTE_LIMIT, 1), 80);
  const maxChars = Math.min(
    Math.max(Number(opts.maxCharsPerNote) || DEFAULT_MAX_CHARS_PER_NOTE, 500),
    50_000,
  );

  const tags = Array.isArray(opts.tags)
    ? opts.tags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];

  const noteIds = Array.isArray(opts.noteIds)
    ? opts.noteIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 80)
    : [];

  let query = client
    .from('vault_items')
    .select('id, title, content, ai_summary, source, updated_at, tags')
    .eq('user_id', userId);

  if (noteIds.length > 0) {
    query = query.in('id', noteIds);
  } else if (tags.length > 0) {
    query = query.overlaps('tags', tags);
  }

  const { data, error } = await query
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(noteIds.length > 0 ? Math.min(noteIds.length, limit) : limit);

  if (error) {
    console.warn('[training] fetchVaultNoteChunks:', error.message);
    return [];
  }

  return (data || [])
    .map((n) => {
      const raw = n.content || n.ai_summary || '';
      const body = truncateText(raw, maxChars);
      return {
        id: n.id,
        title: (n.title || 'Untitled').trim(),
        source: n.source || null,
        updated_at: n.updated_at,
        text: body,
        char_count: body.length,
      };
    })
    .filter((c) => c.char_count >= (Number.isFinite(opts.minChars) ? opts.minChars : 80));
}

/**
 * Pull synthesis layer + optional vault slices for training generation.
 * Uses service-role Supabase client — not MCP.
 */
export async function fetchTrainingSources(client, userId, opts = {}) {
  const vaultSource = String(opts.vaultSource || 'synthesis').trim() || 'synthesis';
  const includeChats = !!opts.includeChats;

  const [beliefsRaw, rulesRaw, factsRaw, prefs] = await Promise.all([
    listActiveBeliefsForUser(client, userId),
    listActiveRulesForUser(client, userId),
    listActiveFactsForUser(client, userId, { limit: 100, minConfidence: 0.45 }),
    fetchUserTrainingPreferences(client, userId),
  ]);

  const vaultTags = Array.isArray(opts.vaultTags)
    ? opts.vaultTags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  const vaultNoteIds = Array.isArray(opts.vaultNoteIds)
    ? opts.vaultNoteIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];

  const synthesisMode = String(opts.synthesisMode || 'all').trim() || 'all';
  const { beliefs, rules, facts } = filterSynthesisLayer(
    { beliefs: beliefsRaw, rules: rulesRaw, facts: factsRaw },
    {
      synthesisMode,
      excludedBeliefIds: opts.excludedBeliefIds,
      includedNeurons: opts.includedNeurons,
    },
  );

  let vaultNotes = [];
  if (vaultIncludesDocuments(vaultSource)) {
    if (vaultSource === 'tagged' && vaultTags.length === 0) {
      vaultNotes = [];
    } else if (vaultSource === 'selected' && vaultNoteIds.length === 0) {
      vaultNotes = [];
    } else {
      const vaultOpts = { ...(opts.vault || {}) };
      if (vaultSource === 'tagged') vaultOpts.tags = vaultTags;
      if (vaultSource === 'selected') vaultOpts.noteIds = vaultNoteIds;
      vaultNotes = await fetchVaultNoteChunks(client, userId, vaultOpts);
    }
  }

  const documentChunks = expandNotesToDocumentChunks(vaultNotes, {
    maxChunks: opts.maxVaultChunks || MAX_VAULT_CHUNKS_PER_JOB,
  });

  let conversationExchanges = [];
  const chatsBlockedByOptOut = includeChats && prefs.trainingOptOut;
  if (includeChats && !prefs.trainingOptOut) {
    conversationExchanges = await fetchConversationExchanges(client, userId, {
      limit: MAX_CONVERSATION_EXCHANGES_FETCH,
      chatRetentionDays: prefs.chatRetentionDays,
    });
  }

  const stats = {
    beliefs: beliefs.length,
    rules: rules.length,
    facts: facts.length,
    vault_notes: vaultNotes.length,
    document_chunks: documentChunks.length,
    conversation_exchanges: conversationExchanges.length,
    vault_source: vaultSource,
    vault_tags: vaultSource === 'tagged' ? vaultTags : [],
    vault_note_ids: vaultSource === 'selected' ? vaultNoteIds : [],
    synthesis_mode: synthesisMode,
    include_chats: includeChats,
    training_opt_out: prefs.trainingOptOut,
  };

  return {
    vaultSource,
    synthesis: { beliefs, rules, facts },
    vaultChunks: vaultNotes,
    documentChunks,
    conversationExchanges,
    trainingPreferences: prefs,
    stats,
    hasSynthesis: beliefs.length + rules.length + facts.length > 0,
    hasVault: documentChunks.length > 0,
    hasConversations: conversationExchanges.length > 0,
    chatsBlockedByOptOut,
  };
}
