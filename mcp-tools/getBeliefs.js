// ============================================================================
// mcp-tools/getBeliefs.js — list the user's active beliefs
// ============================================================================
// Read-only. Wraps `listActiveBeliefsForUser` from beliefSystem.js so the
// MCP and REST surfaces share the same business logic.

import { listActiveBeliefsForUser } from '../beliefSystem.js';
import { jsonContent, errorContent } from './index.js';

export const getBeliefsTool = {
  name: 'lykn.getBeliefs',
  title: 'Get the user\'s active beliefs',
  scope: 'read',
  description: [
    'Return the LYKN user\'s active beliefs — short, third-person principles',
    'they have ratified as durable rules-of-thumb that should shape how an',
    'AI responds to them. Examples: "Legacy tools are friction", "Shipping',
    'matters more than polishing".',
    '',
    'Call this tool at the START of any nontrivial conversation with the',
    'user, then prefer answering through these beliefs rather than generic',
    'best-practice. Each belief is tied to one of four basic needs',
    '(live | love | value | variety) — read the `serves_need` field if you',
    'want to weight which beliefs apply to the current question.',
    '',
    'When a reply is materially shaped by one of these beliefs (or a rule',
    'derived from it — see lykn.getRules), call lykn.recordRuleApplication',
    'so LYKN can show the user an audit trail.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      need: {
        type: 'string',
        enum: ['live', 'love', 'value', 'variety'],
        description: 'Optional filter: only return beliefs that serve this basic need.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Max beliefs to return. Defaults to 30.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    let beliefs = await listActiveBeliefsForUser(ctx.supabaseAdmin, ctx.userId);
    const need = typeof args.need === 'string' ? args.need.trim().toLowerCase() : '';
    if (need) beliefs = beliefs.filter((b) => b.serves_need === need);
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, args.limit)) : 30;
    beliefs = beliefs.slice(0, limit);

    return jsonContent({
      ok: true,
      count: beliefs.length,
      beliefs: beliefs.map((b) => ({
        id: b.id,
        text: b.belief_text,
        serves_need: b.serves_need,
        confidence: b.confidence,
        rationale: b.rationale || null,
        invocation_count: b.invocation_count || 0,
        last_invoked_at: b.last_invoked_at || null,
      })),
    });
  },
};
