// ============================================================================
// mcp-tools/getNeuronLinks.js — list user-authored neuron-to-neuron links
// ============================================================================
// Read. Companion to lykn_createNeuronLink. Two query modes:
//
//   1. node_id mode  — "what is this neuron connected to?"
//      Returns every link where node_id is either endpoint, the OTHER
//      endpoint id, and the optional relationship label. The most
//      useful mode 90% of the time: loadNeuron + getNeuronLinks gives
//      the model the full local neighbourhood of a starter neuron.
//
//   2. inventory mode — "show me the user's recent connections"
//      Omit node_id. Returns the most recent links the user (or AI)
//      has drawn. Useful at the start of a chat for catching up on
//      what the user has been connecting lately.
//
// Returns BOTH endpoints' node ids (untouched), so the caller can
// hand either side straight to lykn_loadNeuron for hydration. The
// stored pair is normalised (from < to lexicographic) but we don't
// expose that detail to the model — both endpoints are returned in
// a stable order with the queried node first when node_id is set.

import { jsonContent, errorContent } from './index.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const getNeuronLinksTool = {
  name: 'lykn_getNeuronLinks',
  title: 'List the user\'s authored connections between neurons',
  scope: 'read',
  description: [
    'Return the user\'s explicit synthesis-layer connections — every',
    'link they (or an AI client) has drawn between two neurons via',
    'lykn_createNeuronLink or the in-app link-mode UI.',
    '',
    'TWO MODES:',
    '  • Pass `node_id` to get every link that touches that neuron.',
    '    Returns the OTHER endpoint of each link, plus the label.',
    '    Common pattern: findConnections → pick a node_id →',
    '    loadNeuron + getNeuronLinks to get full body + neighbourhood.',
    '  • Omit `node_id` to get the user\'s most recent links overall.',
    '    Useful at the start of a chat: "what have they been connecting',
    '    lately?"',
    '',
    'Each result is { from, to, label, created_at }. The `from` and',
    '`to` ids are in lykn_loadNeuron-acceptable format so the model can',
    'hydrate either side directly. When you queried by node_id, the',
    'queried node is always returned as `from` and the related neuron',
    'as `to` for visual clarity.',
    '',
    'CHEAP, READ-ONLY, IDEMPOTENT. Safe to call alongside loadNeuron at',
    'the start of any "what do I think about X?" turn.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        description: 'Optional anchor node id (from findConnections / loadNeuron / getProjectNeurons). When set, returns links touching this node.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max links to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const limit = Number.isFinite(args?.limit)
      ? Math.max(1, Math.min(MAX_LIMIT, args.limit))
      : DEFAULT_LIMIT;
    const nodeId = typeof args?.node_id === 'string' ? args.node_id.trim() : '';

    let q = ctx.supabaseAdmin
      .from('lykn_user_links')
      .select('id, from_node_id, to_node_id, label, source, created_at')
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (nodeId) {
      // PostgREST OR filter — either endpoint matches.
      q = q.or(`from_node_id.eq.${nodeId},to_node_id.eq.${nodeId}`);
    }

    const { data: rows, error } = await q;
    if (error) {
      return errorContent(`link read failed: ${error.message}`);
    }

    const links = (rows || []).map((row) => {
      // When the caller anchored on node_id, present the anchor as
      // `from` and the other endpoint as `to` so the model doesn't
      // have to inspect both fields to find "the related neuron."
      if (nodeId && row.to_node_id === nodeId) {
        return {
          id: row.id,
          from: row.to_node_id,
          to: row.from_node_id,
          label: row.label,
          source: row.source,
          created_at: row.created_at,
        };
      }
      return {
        id: row.id,
        from: row.from_node_id,
        to: row.to_node_id,
        label: row.label,
        source: row.source,
        created_at: row.created_at,
      };
    });

    return jsonContent({
      ok: true,
      count: links.length,
      ...(nodeId ? { anchor: nodeId } : {}),
      links,
      message: links.length === 0
        ? (nodeId
          ? `No links for "${nodeId}" yet.`
          : 'No user-authored links yet.')
        : `Found ${links.length} link${links.length === 1 ? '' : 's'}.`,
    });
  },
};
