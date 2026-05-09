// ============================================================================
// mcp-tools/getContextBlock.js — single-shot context dump for "lazy" clients
// ============================================================================
// Read-only. Returns a pre-rendered text block summarising the user's
// active beliefs + rules, suitable for stuffing at the top of a system
// prompt. Wraps `formatBeliefsAndRulesForPromptOutsideClient` from
// beliefSystem.js so the in-LYKN model and outside clients converge on
// shared content with surface-appropriate attribution instructions.
//
// When to call this vs lykn.getBeliefs / lykn.getRules:
//   • Use this once per CONVERSATION when you just want "who is this user".
//   • Use the structured tools when you need to walk individual rules /
//     filter by need / surface specific rule_ids in your reasoning.

import {
  listActiveBeliefsForUser,
  listActiveRulesForUser,
  formatBeliefsAndRulesForPromptOutsideClient,
} from '../beliefSystem.js';
import { textContent, errorContent } from './index.js';

export const getContextBlockTool = {
  name: 'lykn.getContextBlock',
  title: 'Get a one-shot summary of the user\'s active beliefs + rules',
  scope: 'read',
  description: [
    'Return a single pre-formatted text block summarising the LYKN user\'s',
    'active beliefs and the if-then rules they\'ve agreed should shape an',
    'AI\'s replies. Designed to be pasted at the top of your system prompt',
    'for the rest of this conversation.',
    '',
    'Call this ONCE per conversation as an upfront context-load step. For',
    'finer-grained control (filtering by need, citing specific rule_ids,',
    'searching by trigger), use lykn.getBeliefs / lykn.getRules instead.',
    '',
    'When you follow one of the rules in this block, call',
    'lykn.recordRuleApplication with the rule_id so LYKN can show the user',
    'an audit trail. Tag-less / call-less replies are normal — only record',
    'when a rule actually changed how you responded.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      max_chars: {
        type: 'integer',
        minimum: 200,
        maximum: 8000,
        description: 'Cap the block size. Defaults to 2400 (~600 tokens).',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const maxChars = Number.isFinite(args.max_chars)
      ? Math.max(200, Math.min(8000, args.max_chars))
      : 2400;

    const [beliefs, rules] = await Promise.all([
      listActiveBeliefsForUser(ctx.supabaseAdmin, ctx.userId),
      listActiveRulesForUser(ctx.supabaseAdmin, ctx.userId),
    ]);

    if (!beliefs.length) {
      return textContent(
        'This LYKN user has no active beliefs yet. Treat them as a fresh' +
        ' conversation — but you can call lykn.getFacts for atomic identity' +
        ' facts, or lykn.proposeBelief if a clear durable principle emerges' +
        ' from this chat.',
      );
    }

    const block = formatBeliefsAndRulesForPromptOutsideClient(beliefs, rules, {
      maxChars,
    });
    return textContent(block || '(no active beliefs returned)');
  },
};
