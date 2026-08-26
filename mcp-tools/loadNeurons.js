// ============================================================================
// mcp-tools/loadNeurons.js — bring multiple Vault items into chat
// ============================================================================
// Read. Batch sibling of lykn_loadNeuron. Same per-id payload shape, but
// takes an ARRAY of node_ids and returns an array of results in a single
// call. Designed for the "show me everything I have on X" pattern in the
// in-app chat — without a batch tool the agent loop has to spend one of
// its limited hops per item, and MAX_TOOL_CALLS_PER_HOP (5) bounds how
// many items the user can have brought into a turn.
//
// Each result entry is the exact Vault shape lykn_loadNeuron returns for
// a single node_id, so the chat surface's ChatNeuronCard renderer
// and the orchestrator's tool_call → aiNeurons translation both work
// for free — we just iterate the batch result and push each entry.
//
// Limits, tuned so the whole response stays inside chat-agent-loop.js's
// 16KB per-tool-result envelope:
//   • node_ids: hard cap at 10. The agent loop runs cards one stack
//     anyway; 10 is well past what a single user turn ever wants and
//     keeps the JSON envelope well under the cap.
//   • Vault body cap PER ENTRY: 4000 chars (vs. 16000 in the single
//     tool). Vault notes dominate the size budget; clipping them in
//     batch context keeps room for 10 entries without truncation
//     kicking in at the envelope level (which would lose ALL entries
//     instead of just clipping the heavy ones).

import { jsonContent, errorContent } from './index.js';
import { loadNeuronById, VAULT_CONTENT_CAP_BATCH } from './loadNeuron.js';

const MAX_BATCH = 10;

export const loadNeuronsTool = {
  name: 'lykn_loadNeurons',
  title: 'Bring multiple Vault items into chat in one call',
  scope: 'read',
  description: [
    'Batch version of lykn_loadNeuron. Hydrate the FULL content of up to',
    `${MAX_BATCH} Vault items in a single call and bring each into the chat as a`,
    'separate user-visible card. The result is an array of per-id payloads —',
    'each entry has the same shape lykn_loadNeuron returns for a single id.',
    '',
    'WHEN TO CALL:',
    '  • The user asks to see EVERY note / saved item about a topic ("pull',
    '    up all my notes on robotics", "show me what I have on the Q1 deck").',
    '  • You ran lykn_searchVault and the user wants to actually look at',
    '    several of the matches in the chat — not just hear them summarised.',
    '  • You want to present a small set of related Vault items together so',
    '    the user can compare them side by side.',
    '',
    'WHEN NOT TO CALL:',
    '  • Just one node_id → call lykn_loadNeuron instead (cheaper, simpler).',
    '  • You haven\'t verified the node_ids exist → call lykn_searchVault first.',
    '  • The user only asked for a SUMMARY — bringing in 10 cards spams',
    '    the chat. Use lykn_searchVault and concise prose instead.',
    '',
    'EACH VAULT CARD RENDERS AUTOMATICALLY under your reply with its body',
    'and attachments. Do',
    'NOT paste any of the loaded content back as text in your reply — the',
    'cards already show it. Your prose should frame WHY you brought them in.',
    '',
    'Per-id results follow the SAME shape lykn_loadNeuron returns, so a',
    'missing id lands as `{ ok: false, reason: "not_found", node_id }` in',
    'the array rather than failing the whole call.',
    '',
    `Hard cap: ${MAX_BATCH} node_ids per call. Extras are dropped with a`,
    'warning in the response.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      node_ids: {
        type: 'array',
        description: `Array of vault_<uuid> node_ids returned by lykn_searchVault. Capped at ${MAX_BATCH}.`,
        items: { type: 'string', pattern: '^vault_[A-Za-z0-9-]+$' },
        minItems: 1,
        maxItems: MAX_BATCH,
      },
    },
    required: ['node_ids'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const raw = Array.isArray(args?.node_ids) ? args.node_ids : [];
    const cleaned = [];
    const seen = new Set();
    for (const v of raw) {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s.startsWith('vault_') || seen.has(s)) continue;
      seen.add(s);
      cleaned.push(s);
      if (cleaned.length >= MAX_BATCH) break;
    }
    if (cleaned.length === 0) {
      return errorContent('node_ids must contain at least one vault_<id> value.');
    }
    const dropped = Math.max(0, raw.length - cleaned.length);

    // Run the per-id loader in parallel — each one is a single
    // indexed Supabase row read, so 10-way parallelism is cheap and
    // bounded by the user's session pool. Any per-id DB error becomes
    // an in-band `{ ok: false, reason: 'error', message }` entry so
    // a single failed id doesn't blow up the whole batch.
    const settled = await Promise.all(
      cleaned.map(async (nodeId) => {
        try {
          const result = await loadNeuronById(nodeId, ctx, { vaultCap: VAULT_CONTENT_CAP_BATCH });
          if (result?.__error) {
            return { ok: false, reason: 'error', node_id: nodeId, message: result.__error };
          }
          return result;
        } catch (err) {
          return {
            ok: false,
            reason: 'error',
            node_id: nodeId,
            message: String(err?.message || err),
          };
        }
      }),
    );

    const okCount = settled.filter((r) => r?.ok).length;
    const notFound = settled.filter((r) => !r?.ok && r?.reason === 'not_found').length;
    const errored = settled.filter((r) => !r?.ok && r?.reason === 'error').length;

    return jsonContent({
      ok: true,
      count: settled.length,
      requested: raw.length,
      loaded: okCount,
      not_found: notFound,
      errors: errored,
      dropped_for_cap: dropped,
      results: settled,
      message: `Brought in ${okCount} of ${cleaned.length} neuron${cleaned.length === 1 ? '' : 's'}${dropped ? ` (${dropped} dropped — cap is ${MAX_BATCH})` : ''}.`,
    });
  },
};
