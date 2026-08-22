// ============================================================================
// mcp-tools/createNeuronLink.js — persist a connection between two neurons
// ============================================================================
// Write. Closes the missing "connect" verb in the AI toolkit. Today the
// model can FIND related neurons (lykn_findConnections) and load them
// (lykn_loadNeuron), but it can't PERSIST the realisation "X relates to
// Y" — the synthesis layer renders those edges, but only when the user
// or AI explicitly writes them.
//
// Backed by lykn_user_links (migration 062), the same table the
// synthesis page writes when the user uses the in-app "link mode" UI.
// Sharing the table means:
//   • Links the AI creates show up in the user's synthesis graph
//     immediately, no separate ingestion path.
//   • Removal works through the existing in-app "remove link" UI, no
//     new tear-down tool needed.
//   • Pair normalisation (from_node_id < to_node_id, lexicographic)
//     dedupes A↔B vs B↔A automatically — caller doesn't have to think
//     about direction.
//
// `source` is stamped 'lykn-chat-agent' so the synthesis layer can
// filter / audit AI-authored links separately from user-authored ones
// (the schema reserves this column for exactly this future-pipeline
// use case).
//
// Policy: silent auto-write is OK for AI-proposed links because they're
// reversible (one click in the synthesis layer's link mode removes
// them) and they CAN'T pollute the underlying neuron stores — links
// are pure relationship metadata sitting between unaffected nodes. The
// model's job is to be selective: only link when there's a real
// observation, not just topical overlap (findConnections already
// surfaces overlap; the link is for "the user themselves would draw
// this edge if they saw it").

import { jsonContent, errorContent } from './index.js';

const LABEL_MAX = 80;
const NODE_ID_MAX = 200;

function normalisePair(a, b) {
  // lykn_user_links uses lexicographic ordering for undirected dedup.
  // Sort here so caller can pass either direction.
  return a < b ? [a, b] : [b, a];
}

export const createNeuronLinkTool = {
  name: 'lykn_createNeuronLink',
  title: 'Connect two synthesis-layer neurons with a user-authored link',
  scope: 'write',
  description: [
    'Create an explicit, undirected link between two synthesis-layer',
    'neurons (belief, fact, concept, vault note, perspective, …) — the',
    'AI-callable mirror of the in-app "link mode" UI on the synthesis',
    'page. When you notice "the user\'s belief X relates to their fact',
    'Y" or "this vault note belongs with that concept", call this so',
    'the synthesis layer renders the edge and other AI clients see it.',
    '',
    'INPUTS:',
    '  • from_node_id, to_node_id — node ids from findConnections /',
    '    loadNeuron / getProjectNeurons output. Format:',
    '    belief_<uuid> | fact_<uuid> | concept_<slug> | vault_<uuid> |',
    '    tag_<text> | neuron_theme_<slug> | vault_source_<app>',
    '    Direction doesn\'t matter — the link is undirected and the pair',
    '    is auto-normalised.',
    '  • label — optional short relationship word (≤80 chars). Common',
    '    vocab: "supports", "contradicts", "reminds me of", "extends",',
    '    "depends on", "supersedes". Keep it tight; the link surface is',
    '    not the place for long explanations.',
    '',
    'WHEN TO CALL:',
    '  • You loaded two neurons via loadNeuron and noticed a non-obvious',
    '    relationship the user would themselves draw — the link is for',
    '    "I see how these go together" moments, not topical overlap.',
    '  • The user explicitly tells you "X and Y are connected" — link',
    '    them straight away, no need to ask.',
    '  • You\'re assembling a small constellation around a topic (e.g.',
    '    via findConnections) and want the cluster\'s internal',
    '    structure to persist past this chat. One or two well-chosen',
    '    links beat ten weak ones.',
    '',
    'WHEN NOT TO CALL:',
    '  • Both nodes are already in the same project cluster — that',
    '    relationship is already represented (via lykn_addProjectNeurons).',
    '  • The neurons share only superficial topic overlap. findConnections',
    '    surfaces that for you on demand; persisting weak edges clutters',
    '    the synthesis graph.',
    '  • Self-link (from_node_id == to_node_id) — the tool rejects these.',
    '',
    'IDEMPOTENT: re-adding the same pair updates the label in place',
    'rather than erroring.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      from_node_id: {
        type: 'string',
        description: 'One endpoint of the link. Direction doesn\'t matter — pair auto-normalised.',
      },
      to_node_id: {
        type: 'string',
        description: 'Other endpoint of the link.',
      },
      label: {
        type: 'string',
        description: 'Optional short relationship word (≤80 chars). E.g. "supports", "contradicts", "reminds me of".',
      },
    },
    required: ['from_node_id', 'to_node_id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const a = typeof args?.from_node_id === 'string' ? args.from_node_id.trim().slice(0, NODE_ID_MAX) : '';
    const b = typeof args?.to_node_id === 'string' ? args.to_node_id.trim().slice(0, NODE_ID_MAX) : '';
    if (!a || !b) {
      return errorContent('from_node_id and to_node_id are both required.');
    }
    if (a === b) {
      return errorContent('Self-links are not allowed — from_node_id and to_node_id must differ.');
    }

    const label = typeof args?.label === 'string'
      ? args.label.trim().slice(0, LABEL_MAX) || null
      : null;

    const [from, to] = normalisePair(a, b);
    const source = `lykn-chat-agent:${ctx.attribSurface || 'lykn-chat'}`.slice(0, 64);

    // Upsert by (user_id, from_node_id, to_node_id) — the unique
    // constraint dedupes the pair; we update label+source on conflict
    // so re-linking the same pair with a new label sticks.
    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_user_links')
      .upsert(
        {
          user_id: ctx.userId,
          from_node_id: from,
          to_node_id: to,
          label,
          source,
        },
        { onConflict: 'user_id,from_node_id,to_node_id' },
      )
      .select('id, from_node_id, to_node_id, label, source, created_at')
      .single();
    if (error) {
      console.warn('[mcp:createNeuronLink]', error.message);
      return errorContent(`link create failed: ${error.message}`);
    }

    return jsonContent({
      ok: true,
      link: {
        id: data.id,
        from_node_id: data.from_node_id,
        to_node_id: data.to_node_id,
        label: data.label,
        source: data.source,
        created_at: data.created_at,
      },
      message: label
        ? `Linked "${from}" ↔ "${to}" (${label}).`
        : `Linked "${from}" ↔ "${to}".`,
    });
  },
};
