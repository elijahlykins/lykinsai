// ============================================================================
// mcp-tools/proposeBelief.js — outside-client belief proposal
// ============================================================================
// Write. The synthesis layer "learns from elsewhere" — when an outside AI
// client realises during a conversation that the user has expressed a
// durable principle (not just a passing fact), it calls this so a
// ratification card appears the next time the user opens LYKN.
//
// CRITICAL safety constraint: outside-proposed beliefs land as `proposed`,
// NEVER `active`, regardless of confidence. Only the user can ratify a
// belief into the prompt-shaping layer. This protects against:
//   • prompt-injected models promoting attacker-friendly principles
//   • over-eager AIs reading too much into a casual statement
//   • cross-client write loops where two AIs propose, ratify, propose...
//
// Implementation note: we cannot reuse `createManualBelief` directly because
// that lands beliefs in `active`. We mint a `proposed` row by hand and
// stamp the `rationale` with the source client so the user knows where it
// came from when they see the ratification card.

import { normalizeBeliefKey, NEEDS } from '../beliefSystem.js';
import { jsonContent, errorContent, requireWrite } from './index.js';

const NEED_SET = new Set(NEEDS);

export const proposeBeliefTool = {
  name: 'lykn.proposeBelief',
  title: 'Propose a new durable belief for the user to ratify',
  scope: 'write',
  description: [
    'Propose a new durable belief — a short, third-person principle that',
    'shapes how an AI should respond to this user — for them to ratify in',
    'LYKN. Examples: "Legacy tools are friction", "Visual thinking beats',
    'text-first thinking", "Shipping matters more than polishing".',
    '',
    'When to call this:',
    '  • The user has stated a clear preference / value / principle that',
    '    is not just a one-off fact but a generalisation across many',
    '    decisions ("I always reject X", "I care about Y in everything").',
    '  • You\'ve already checked lykn.getBeliefs and the principle is not',
    '    already there.',
    '',
    'When NOT to call this:',
    '  • Casual / situational statements ("I\'m tired today"). Use',
    '    lykn.proposeFact instead — facts cluster into beliefs over time.',
    '  • The user said something controversial / under stress — beliefs',
    '    are durable, not heat-of-the-moment.',
    '',
    'Result: lands as `proposed`, NEVER `active`. The user gets a ratify',
    'card next time they open LYKN. They alone decide whether the belief',
    'enters the prompt-shaping layer.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The belief, as a short third-person principle (<=140 chars). E.g. "Legacy tools are friction".',
      },
      serves_need: {
        type: 'string',
        enum: ['live', 'love', 'value', 'variety'],
        description: 'Which of the four basic needs this belief most directly serves.',
      },
      rationale: {
        type: 'string',
        description: 'One sentence (<=240 chars) explaining the pattern across statements that supports this belief.',
      },
    },
    required: ['text', 'serves_need'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const text = String(args?.text || '').trim().slice(0, 140);
    if (!text) return errorContent('text is required.');
    const need = String(args?.serves_need || '').trim().toLowerCase();
    if (!NEED_SET.has(need)) {
      return errorContent('serves_need must be one of: live, love, value, variety.');
    }
    const key = normalizeBeliefKey(text);
    if (!key) return errorContent('text is not normalisable into a belief key.');

    const surface = ctx.attribSurface || 'mcp:other';
    const rationaleRaw = args?.rationale ? String(args.rationale).trim().slice(0, 240) : '';
    const rationale = rationaleRaw
      ? `${rationaleRaw} (proposed via ${surface})`
      : `Proposed by external AI client (${surface}). User has not seen this yet.`;

    const insertRow = {
      user_id: ctx.userId,
      belief_text: text,
      belief_key: key,
      serves_need: need,
      // CRITICAL: 'proposed', not 'active'. User must ratify in LYKN.
      status: 'proposed',
      confidence: 0.5,
      promoted_from_facts: [],
      rationale,
      first_seen_at: new Date().toISOString(),
    };

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_beliefs')
      .upsert(insertRow, { onConflict: 'user_id,belief_key' })
      .select('id, belief_text, serves_need, status, rationale, created_at')
      .maybeSingle();
    if (error) return errorContent(`belief upsert failed: ${error.message}`);
    if (!data) return errorContent('belief insert returned no row.');

    return jsonContent({
      ok: true,
      message: 'Belief proposed. The user will see a ratify card next time they open LYKN.',
      belief: {
        id: data.id,
        text: data.belief_text,
        serves_need: data.serves_need,
        status: data.status,
        rationale: data.rationale,
        created_at: data.created_at,
      },
    });
  },
};
