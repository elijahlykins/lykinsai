/**
 * Shared conversation compression for chat prompts.
 * Used by the client (promptBuilder.ts) and server (server.js).
 *
 * Each message may carry optional attribution:
 *   • `at` / `timestamp` — ISO string when the turn was sent
 *   • `model` — model id for assistant turns (who wrote the reply)
 */

import { MODEL_GROUPS } from '../modelCatalog.js';

const MODEL_LABEL_BY_ID = Object.fromEntries(
  MODEL_GROUPS.flatMap((g) => g.items.map((i) => [i.value, i.label])),
);

const MATCH_STOP = new Set([
  'the', 'and', 'for', 'you', 'that', 'this', 'was', 'did', 'say', 'how',
  'old', 'just', 'tell', 'what', 'with', 'from', 'have', 'been', 'they',
  'them', 'your', 'are', 'but', 'not', 'can', 'will', 'would', 'could',
  'should', 'about', 'then', 'than', 'when', 'who', 'why', 'her', 'his',
  'she', 'him', 'its', 'our', 'out', 'get', 'got', 'let', 'yes', 'yeah',
  'okay', 'hey', 'hello', 'please', 'thanks', 'thank', 'again', 'part',
]);

/** Human-readable label for a model id in conversation attribution. */
export function labelForModelId(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return '';
  return MODEL_LABEL_BY_ID[id] || id;
}

function formatMessageTimestamp(iso) {
  const raw = String(iso || '').trim();
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function formatRolePrefix(role, msg, includeTimestamps) {
  const r = String(role || 'user').toLowerCase();
  const base = r === 'assistant' ? 'ASSISTANT' : r === 'system' ? 'SYSTEM' : 'USER';
  const at = includeTimestamps
    ? formatMessageTimestamp(msg?.at || msg?.timestamp || msg?.createdAt)
    : '';
  const model = r === 'assistant' ? labelForModelId(msg?.model || msg?.aiModel) : '';
  const parts = [];
  if (model) parts.push(model);
  if (at) parts.push(at);
  return parts.length ? `${base} (${parts.join(', ')})` : base;
}

function tokensForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 3 && !MATCH_STOP.has(w));
}

export function messageMatchesCurrentTurn(msg, currentUserText) {
  const current = String(currentUserText || '').trim();
  const content = String(msg?.content || '');
  if (!current || !content) return false;
  if (/\b(option|example|code|snippet|previous|before)\b/i.test(current)
    && /```|\b1\.|\b2\.|\boption\b/i.test(content)) {
    return true;
  }
  const currentTokens = new Set(tokensForMatch(current));
  if (!currentTokens.size) return false;
  const msgTokens = tokensForMatch(content);
  let hits = 0;
  for (const token of msgTokens) {
    if (currentTokens.has(token)) hits += 1;
  }
  return hits >= 1 && msgTokens.some((token) => currentTokens.has(token) && token.length >= 3);
}

/**
 * Compress a conversation array into a formatted string for prompts.
 * Recent turns stay fuller; older turns collapse to short snippets
 * unless they clearly resolve a reference in the current user turn.
 */
export function compressConversation(msgs, opts = {}) {
  const fullCount = opts.fullCount ?? 4;
  const maxChars = opts.maxChars ?? 8000;
  const recentMax = opts.recentMessageMax ?? 900;
  const olderMax = opts.olderSnippetMax ?? 60;
  const referenceMax = opts.referenceMessageMax ?? 400;
  const maxMessages = opts.maxMessages ?? 20;
  const includeTimestamps = opts.includeTimestamps === true;
  const currentUserText = String(opts.currentUserText || '');

  if (!Array.isArray(msgs) || !msgs.length) return '';

  const capped = msgs.slice(-maxMessages);
  const splitAt = Math.max(0, capped.length - fullCount);
  const older = capped.slice(0, splitAt);
  const recent = capped.slice(splitAt);

  const olderLines = older
    .map((m) => {
      const prefix = formatRolePrefix(m?.role, m, includeTimestamps);
      const keepLonger = messageMatchesCurrentTurn(m, currentUserText);
      const limit = keepLonger ? referenceMax : olderMax;
      const snippet = String(m?.content || '').replace(/\s+/g, ' ').trim().slice(0, limit);
      return snippet ? `${prefix}: ${snippet}${String(m?.content || '').trim().length > limit ? '…' : ''}` : '';
    })
    .filter(Boolean);

  const recentLines = recent
    .map((m) => {
      const prefix = formatRolePrefix(m?.role, m, includeTimestamps);
      const content = String(m?.content || '').trim();
      if (!content) return '';
      const truncated = content.length > recentMax ? `${content.slice(0, recentMax)}…` : content;
      return `${prefix}: ${truncated}`;
    })
    .filter(Boolean);

  const joined = [...olderLines, ...recentLines].join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}
