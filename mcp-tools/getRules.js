// ============================================================================
// mcp-tools/getRules.js — list the user's active if-then rules
// ============================================================================
// Read-only. Wraps `listActiveRulesForUser`. Rules are the operationalised
// half of beliefs — each one ties a TRIGGER pattern to an ACTION the AI
// should take. The MCP description leans hard on this so external models
// understand they're concrete, not slogans.

import { listActiveRulesForUser } from '../beliefSystem.js';
import { jsonContent, errorContent } from './index.js';

export const getRulesTool = {
  name: 'lykn.getRules',
  title: 'Get the user\'s active if-then rules',
  scope: 'read',
  description: [
    'Return the LYKN user\'s active rules — concrete IF-THEN behaviours the',
    'user has ratified as "this is how an AI should respond to me". Each',
    'rule has a `trigger_text` describing when it applies and an',
    '`action_text` describing what to do.',
    '',
    'Use this tool together with lykn.getBeliefs at the start of a',
    'conversation. When the current user message matches a rule\'s trigger,',
    'follow that rule\'s action — and then call lykn.recordRuleApplication',
    'with the rule_id so LYKN can show the user an audit trail.',
    '',
    'Honesty over attribution: only record an application when the rule',
    'genuinely changed your reply. Tag-less replies are normal and expected.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      belief_id: {
        type: 'string',
        description: 'Optional UUID — only return rules attached to this belief.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Max rules to return. Defaults to 50.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    let rules = await listActiveRulesForUser(ctx.supabaseAdmin, ctx.userId);
    const beliefId = typeof args.belief_id === 'string' ? args.belief_id.trim() : '';
    if (beliefId) rules = rules.filter((r) => r.belief_id === beliefId);
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 50;
    rules = rules.slice(0, limit);

    return jsonContent({
      ok: true,
      count: rules.length,
      rules: rules.map((r) => ({
        id: r.id,
        belief_id: r.belief_id,
        trigger_text: r.trigger_text,
        action_text: r.action_text,
        priority: r.priority,
        confidence: r.confidence,
        invocation_count: r.invocation_count || 0,
        last_fired_at: r.last_fired_at || null,
      })),
    });
  },
};
