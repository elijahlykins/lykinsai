// ============================================================================
// mcp-tools/loadNeuron.js — hydrate one vault item into chat
// ============================================================================
// Project membership and Voice search return snippets + node_id. This tool
// loads the selected vault item's full body when the user asks to read it.
//
// Vault content cap: 16KB. Bigger than the per-hop tool-result cap in
// chat-agent-loop.js (also 16KB) so the full note can fit when there
// isn't a parallel-tool-call competing for budget; smaller than the
// hard `notes.content` 120KB DB cap so we still send "use the link"
// if the note is huge.

import { jsonContent, errorContent } from './index.js';

const VAULT_CONTENT_CAP = 16000;

// Per-kind cap for batch loads via lykn_loadNeurons. When the batch tool
// calls into a vault row it tightens this cap so a 10-item bring-in
// doesn't blow the chat-agent-loop's 16KB tool-result envelope.
const VAULT_CONTENT_CAP_BATCH = 4000;

function maybeTruncate(text, cap) {
  const str = String(text || '');
  if (str.length <= cap) return { text: str, truncated: false };

  // Prefer keeping `[ATTACHMENTS_JSON:…]` intact. A mid-marker slice makes
  // chat Pull-up / neuron cards drop the attachment entirely (blank preview)
  // until a full vault_items re-fetch lands.
  const marker = '[ATTACHMENTS_JSON:';
  const markerAt = str.indexOf(marker);
  if (markerAt >= 0) {
    const markerChunk = str.slice(markerAt);
    if (markerChunk.length <= cap) {
      const bodyBudget = Math.max(0, cap - markerChunk.length - 2);
      const body = str.slice(0, markerAt).slice(0, bodyBudget).trimEnd();
      return {
        text: body ? `${body}\n\n${markerChunk}` : markerChunk,
        truncated: true,
        full_length: str.length,
      };
    }
  }

  return {
    text: str.slice(0, cap),
    truncated: true,
    full_length: str.length,
  };
}

export const loadNeuronTool = {
  name: 'lykn_loadNeuron',
  title: 'Load a vault item\'s full content into the chat',
  scope: 'read',
  description: [
    'Load a specific vault item from a vault_<uuid> node_id returned by',
    'lykn_getProjectNeurons or a prior vault card. Returns the full body so',
    'you can quote, summarize, or display the saved item accurately.',
    '',
    'TYPICAL FLOW:',
    '  1. lykn_getProjectNeurons or an existing vault_<uuid> in context',
    '  2. lykn_loadNeuron({ node_id })',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        description: 'Stable vault item id prefixed vault_<uuid> (from project members or a prior vault card).',
      },
    },
    required: ['node_id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const nodeIdRaw = typeof args?.node_id === 'string' ? args.node_id.trim() : '';
    if (!nodeIdRaw) return errorContent('node_id is required.');
    const result = await loadNeuronById(nodeIdRaw, ctx, { vaultCap: VAULT_CONTENT_CAP });
    if (result?.__error) return errorContent(result.__error);
    return jsonContent(result);
  },
};

// ---------------------------------------------------------------------------
// Shared per-id loader — used by both lykn_loadNeuron (single) and
// lykn_loadNeurons (batch). Returns the bare payload object (NOT wrapped
// in jsonContent) so the batch tool can collect many results into a
// single response array. On hard failures (DB error) returns
// `{ __error: '<msg>' }` so the caller can decide whether to surface the
// failure for THIS id or stop the whole batch.
// ---------------------------------------------------------------------------

export async function loadNeuronById(nodeIdRaw, ctx, options = {}) {
  const vaultCap = Number.isFinite(options.vaultCap) ? options.vaultCap : VAULT_CONTENT_CAP;

  // ── Vault note ────────────────────────────────────────────────
  if (nodeIdRaw.startsWith('vault_')) {
    const id = nodeIdRaw.slice('vault_'.length);
    const { data, error } = await ctx.supabaseAdmin
      .from('vault_items')
      .select('id, title, content, tags, folder, source, created_at, updated_at')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (error) return { __error: `vault note load failed: ${error.message}` };
    if (!data) {
      return { ok: false, reason: 'not_found', node_id: nodeIdRaw, message: 'That vault note id is not in the user\'s vault.' };
    }
    const body = maybeTruncate(data.content, vaultCap);
    return {
      ok: true,
      kind: 'vault',
      node_id: nodeIdRaw,
      display: `Vault note: "${data.title || '(untitled)'}"\n\n${body.text}${body.truncated ? `\n\n[truncated — full note is ${body.full_length} chars; open ${`/vault?note=${data.id}`} for the rest]` : ''}`,
      note: {
        id: data.id,
        title: data.title,
        content: body.text,
        truncated: body.truncated,
        full_length: body.truncated ? body.full_length : body.text.length,
        tags: data.tags || [],
        folder: data.folder,
        source: data.source,
        created_at: data.created_at,
        updated_at: data.updated_at,
        url: `/vault?note=${encodeURIComponent(data.id)}`,
      },
    };
  }

  return {
    ok: false,
    reason: 'unrecognised_node_id',
    node_id: nodeIdRaw,
    message: 'node_id must be prefixed with vault_.',
  };
}

export { VAULT_CONTENT_CAP_BATCH };
