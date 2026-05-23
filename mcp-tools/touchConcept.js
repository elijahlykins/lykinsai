// ============================================================================
// mcp-tools/touchConcept.js — bump a concept's last_touched_at
// ============================================================================
// Write. The synthesis layer's concept store (migration 056) tracks
// recency via `last_touched_at`. That column drives the synthesis
// layer's decay logic — concepts that stop getting touched eventually
// age out / get archived in favour of more active themes. It also
// feeds the "What's hot for you right now?" ribbon on the synthesis
// page (idx_lykn_concepts_user_status orders by it).
//
// Today only the nightly concepts job and explicit user clicks in the
// in-app concept ribbon bump these counters. That means concepts the
// USER talks about in chat (without explicitly clicking) don't get
// reinforced — over weeks, the synthesis layer's view of "what the
// user cares about" drifts from what's actually surfacing in their
// conversations.
//
// This tool closes that loop: when the AI loads a concept (via
// loadNeuron or findConnections) AND the conversation is genuinely
// engaging with that concept (not just topically adjacent), it can
// bump the touch counters so the synthesis layer's recency model
// stays honest.
//
// Idempotent in the sense that re-touching the same concept just
// increments the counter again — that's the point. The DB cap on
// touch_count is huge (BIGINT), so runaway calls are bounded by
// per-turn tool-call limits, not the column.

import { jsonContent, errorContent, requireWrite } from './index.js';

const NODE_PREFIX = 'concept_';

export const touchConceptTool = {
  name: 'lykn_touchConcept',
  title: 'Mark a concept as recently surfaced in this conversation',
  scope: 'write',
  description: [
    'Reinforce a synthesis-layer concept by bumping its last_touched_at',
    'timestamp. The synthesis layer\'s decay model uses this to decide',
    'which concepts stay surfaced in the user\'s "hot right now" ribbon',
    'and which age out — touching a concept whenever the user is',
    'actively engaging with it keeps the model\'s view of their current',
    'focus accurate.',
    '',
    'CALL THIS when:',
    '  • The user is meaningfully discussing a concept that already',
    '    exists in their synthesis layer (you found it via',
    '    findConnections or loadNeuron) — not when you\'ve only',
    '    mentioned it in passing.',
    '  • A single conversation legitimately engages multiple concepts',
    '    — touch each one (one tool call per concept), don\'t batch',
    '    them into a "they\'re kind of related" call.',
    '',
    'WHEN NOT TO CALL:',
    '  • The concept doesn\'t exist yet — there\'s no concept-creation',
    '    tool exposed to chat (the nightly concepts job mints those',
    '    from chunk clusters). For new themes that should become',
    '    concepts, recording them as facts is the right path; the',
    '    nightly job will promote durable patterns to concepts.',
    '  • The user only mentioned the topic glancingly. Touching a',
    '    concept on every word that brushes its label corrupts the',
    '    recency signal.',
    '  • You\'re calling findConnections and getting hits across many',
    '    concepts — DON\'T touch every hit. Touch the 1-2 the',
    '    conversation actually centres on.',
    '',
    'INPUT: node_id in concept_<slug> format (the same shape',
    'lykn_findConnections and lykn_loadNeuron use). The tool resolves',
    'the slug back to the concept row and bumps the counters in place.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        description: 'Concept node id in concept_<slug> format. From findConnections / loadNeuron / getProjectNeurons output.',
      },
    },
    required: ['node_id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const nodeId = typeof args?.node_id === 'string' ? args.node_id.trim() : '';
    if (!nodeId) return errorContent('node_id is required.');
    if (!nodeId.startsWith(NODE_PREFIX)) {
      return errorContent(`node_id must start with "${NODE_PREFIX}" (got "${nodeId}").`);
    }
    const slug = nodeId.slice(NODE_PREFIX.length);
    if (!slug) return errorContent('node_id is missing a slug after the concept_ prefix.');

    // Look up by slug first so we can return a clean not_found
    // rather than silently no-op on an unknown concept. Also lets
    // us short-circuit dismissed concepts so the model gets an
    // explicit signal that the user hid it.
    const { data: existing, error: readErr } = await ctx.supabaseAdmin
      .from('lykn_concepts')
      .select('id, label, kind, status, last_touched_at')
      .eq('user_id', ctx.userId)
      .eq('slug', slug)
      .maybeSingle();
    if (readErr) return errorContent(`concept lookup failed: ${readErr.message}`);
    if (!existing) {
      return jsonContent({
        ok: false,
        reason: 'not_found',
        node_id: nodeId,
        message: `No concept with slug "${slug}" in the user's synthesis layer. New themes that should become concepts need to be recorded as facts; the nightly synthesis job promotes durable patterns to concepts.`,
      });
    }
    if (existing.status === 'dismissed') {
      // Respect the user's "I don't want this concept" signal — never
      // resurrect a dismissed concept via touch. Surfacing this
      // outcome to the model lets it know not to re-suggest the
      // concept rather than silently failing.
      return jsonContent({
        ok: false,
        reason: 'concept_dismissed',
        node_id: nodeId,
        message: `Concept "${existing.label}" was previously dismissed by the user. Not bumping touch counters — the dismissal floor is honoured.`,
      });
    }

    const now = new Date().toISOString();
    const { data: updated, error: updErr } = await ctx.supabaseAdmin
      .from('lykn_concepts')
      .update({ last_touched_at: now })
      .eq('id', existing.id)
      .select('id, label, slug, kind, status, last_touched_at')
      .single();
    if (updErr) return errorContent(`concept touch failed: ${updErr.message}`);

    return jsonContent({
      ok: true,
      node_id: nodeId,
      concept: {
        id: updated.id,
        label: updated.label,
        slug: updated.slug,
        kind: updated.kind,
        status: updated.status,
        last_touched_at: updated.last_touched_at,
      },
      message: `Touched "${updated.label}" — recency bumped.`,
    });
  },
};
