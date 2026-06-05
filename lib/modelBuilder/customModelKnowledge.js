/**
 * Load vault knowledge configured on a published custom model for in-app chat.
 */

import { fetchVaultNoteChunks } from '../training/fetchTrainingSources.js';

const MAX_NOTES_ALL = 25;
const MAX_NOTES_SELECTED = 40;
const MAX_NOTES_TAGGED = 30;
const MAX_CHARS_PER_NOTE = 10_000;
const MAX_SECTION_CHARS = 32_000;

function sanitizeVaultNoteIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    const n = String(id || '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function vaultIncludesDocuments(vaultSource) {
  return vaultSource === 'all' || vaultSource === 'tagged' || vaultSource === 'selected';
}

/**
 * @param {object | null | undefined} model
 */
export function readCustomModelKnowledgeConfig(model) {
  const meta = model?.metadata || {};
  const vaultSource = String(model?.vaultSource || 'synthesis').trim() || 'synthesis';
  const vaultTags = (Array.isArray(meta.vault_tags) ? meta.vault_tags : meta.vaultTags || [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const vaultNoteIds = sanitizeVaultNoteIds(
    meta.included_vault_note_ids ?? meta.includedVaultNoteIds,
  );
  return {
    vaultSource,
    vaultTags,
    vaultNoteIds,
    includesVaultDocuments: vaultIncludesDocuments(vaultSource),
  };
}

function orderNotesByIds(notes, noteIds) {
  if (!noteIds?.length) return notes;
  const byId = new Map((notes || []).map((n) => [String(n.id), n]));
  const ordered = noteIds.map((id) => byId.get(String(id))).filter(Boolean);
  const seen = new Set(ordered.map((n) => n.id));
  for (const note of notes || []) {
    if (!seen.has(note.id)) ordered.push(note);
  }
  return ordered;
}

function formatVaultNotesForCustomModelPrompt(notes, model, vaultSource) {
  const name = String(model?.name || 'Custom model').trim();
  const scopeLabel =
    vaultSource === 'selected'
      ? 'selected vault files'
      : vaultSource === 'tagged'
        ? 'tagged vault files'
        : vaultSource === 'all'
          ? 'vault files'
          : 'vault knowledge';

  const lines = [
    '[CUSTOM_MODEL_KNOWLEDGE]',
    `Model "${name}" is grounded in these ${scopeLabel}. Treat them as primary source material for this conversation.`,
    'The excerpts below are real content from the user\'s vault — do not say you cannot access their saved files.',
    'When the user asks about topics covered here, answer from these excerpts first. Quote or paraphrase faithfully.',
    '',
  ];

  for (const note of notes) {
    lines.push(`--- ${note.title || 'Untitled'} (note id: ${note.id}) ---`);
    if (note.source) lines.push(`Source: ${note.source}`);
    lines.push(String(note.text || '').trim() || '(no text body available)');
    lines.push('');
  }

  let text = lines.join('\n').trim();
  if (text.length > MAX_SECTION_CHARS) {
    text = `${text.slice(0, MAX_SECTION_CHARS)}\n\n[…truncated for context budget]`;
  }
  return text;
}

/**
 * Fetch and format vault notes scoped to a custom model's knowledge config.
 * @returns {Promise<string>}
 */
export async function loadCustomModelVaultKnowledgeSection(client, userId, model) {
  if (!client || !userId || !model) return '';

  const { vaultSource, vaultTags, vaultNoteIds, includesVaultDocuments } =
    readCustomModelKnowledgeConfig(model);
  if (!includesVaultDocuments) return '';

  const fetchOpts = {
    maxCharsPerNote: MAX_CHARS_PER_NOTE,
    minChars: 0,
  };

  if (vaultSource === 'selected') {
    if (!vaultNoteIds.length) return '';
    fetchOpts.noteIds = vaultNoteIds;
    fetchOpts.limit = Math.min(vaultNoteIds.length, MAX_NOTES_SELECTED);
  } else if (vaultSource === 'tagged') {
    if (!vaultTags.length) return '';
    fetchOpts.tags = vaultTags;
    fetchOpts.limit = MAX_NOTES_TAGGED;
  } else if (vaultSource === 'all') {
    fetchOpts.limit = MAX_NOTES_ALL;
  } else {
    return '';
  }

  let notes = await fetchVaultNoteChunks(client, userId, fetchOpts);
  if (vaultSource === 'selected') {
    notes = orderNotesByIds(notes, vaultNoteIds);
  }
  notes = notes.filter((n) => String(n.text || '').trim().length > 0);
  if (!notes.length) return '';

  return formatVaultNotesForCustomModelPrompt(notes, model, vaultSource);
}

export function customModelVaultKnowledgeInstruction(model) {
  const { includesVaultDocuments } = readCustomModelKnowledgeConfig(model);
  if (!includesVaultDocuments) return '';
  return [
    '[CUSTOM_MODEL_KNOWLEDGE_RULES]',
    'Each turn may include a [CUSTOM_MODEL_KNOWLEDGE] block with vault excerpts chosen for this model.',
    'Prefer that block over generic workspace context when answering about the user\'s saved work.',
  ].join('\n');
}
