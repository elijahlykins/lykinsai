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

function formatRolePrefix(role, msg) {
  const r = String(role || 'user').toLowerCase();
  const base = r === 'assistant' ? 'ASSISTANT' : r === 'system' ? 'SYSTEM' : 'USER';
  const at = formatMessageTimestamp(msg?.at || msg?.timestamp || msg?.createdAt);
  const model = r === 'assistant' ? labelForModelId(msg?.model || msg?.aiModel) : '';
  const parts = [];
  if (model) parts.push(model);
  if (at) parts.push(at);
  return parts.length ? `${base} (${parts.join(', ')})` : base;
}

/**
 * Compress a conversation array into a formatted string for prompts.
 * Recent turns stay fuller; older turns collapse to short snippets.
 */
export function compressConversation(msgs, opts = {}) {
  const fullCount = opts.fullCount ?? 4;
  const maxChars = opts.maxChars ?? 8000;
  const recentMax = opts.recentMessageMax ?? 900;
  const olderMax = opts.olderSnippetMax ?? 60;

  if (!Array.isArray(msgs) || !msgs.length) return '';

  const capped = msgs.slice(-20);
  const splitAt = Math.max(0, capped.length - fullCount);
  const older = capped.slice(0, splitAt);
  const recent = capped.slice(splitAt);

  const olderLines = older
    .map((m) => {
      const prefix = formatRolePrefix(m?.role, m);
      const snippet = String(m?.content || '').replace(/\s+/g, ' ').trim().slice(0, olderMax);
      return snippet ? `${prefix}: ${snippet}…` : '';
    })
    .filter(Boolean);

  const recentLines = recent
    .map((m) => {
      const prefix = formatRolePrefix(m?.role, m);
      const content = String(m?.content || '').trim();
      if (!content) return '';
      const truncated = content.length > recentMax ? `${content.slice(0, recentMax)}…` : content;
      return `${prefix}: ${truncated}`;
    })
    .filter(Boolean);

  const joined = [...olderLines, ...recentLines].join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}
