// ============================================================================
// mcp-tools/recordRuleApplication.js — outside-client attribution write
// ============================================================================
// Write. Outside AI clients (Claude.ai, Cursor, Claude Code, etc.) call
// this when a rule they fetched via lykn_getRules / lykn_getContextBlock
// genuinely shaped a reply. The handler is the SAME `recordRuleApplication`
// function the in-LYKN hidden-tag parser calls — `surface` distinguishes
// where the attribution came from.
//
// Why this exists at all: we used to rely on a hidden <applied rule_id="…">
// tag emitted by the in-LYKN model and parsed server-side. That breaks the
// moment Claude.ai is the chat surface — there is no post-stream parser
// inside someone else's app. Tool calls are the cross-client equivalent.
//
// Honesty-over-attribution: we validate ownership + active status server-
// side. A misbehaving model can't fake-attribute to a rule it doesn't own,
// and tag-less / call-less replies are encouraged whenever the rule didn't
// genuinely change the answer.

import { recordRuleApplication } from '../beliefSystem.js';
import { jsonContent, errorContent, requireWrite } from './index.js';

export const recordRuleApplicationTool = {
  name: 'lykn_recordRuleApplication',
  title: 'Record that one of the user\'s rules shaped this reply',
  scope: 'write',
  description: [
    'Record that one of the LYKN user\'s active rules genuinely shaped your',
    'most recent reply. Pass the exact `rule_id` you got from lykn_getRules',
    'or the [BELIEFS_AND_RULES] block from lykn_getContextBlock.',
    '',
    'CALL THIS SPARINGLY. Only when the rule actually changed your answer —',
    'tone, structure, what you recommended, what you refused. Generic',
    'replies that didn\'t really lean on a rule should NOT be recorded; the',
    'audit trail is only useful when it\'s honest. Most turns are not',
    'rule-driven.',
    '',
    'On success this row appears in the user\'s LYKN belief-window panel',
    'where they can mark it good or bad, which feeds back into the rule\'s',
    'confidence (and may auto-retire it on repeated bad feedback).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      rule_id: {
        type: 'string',
        description: 'UUID of the rule from lykn_getRules / [BELIEFS_AND_RULES]. Verbatim — do not invent.',
      },
      message_id: {
        type: 'string',
        description: 'A stable identifier for the reply this attribution is for (whatever id the host client exposes). Free-form.',
      },
      reason: {
        type: 'string',
        description: 'One short sentence (<=320 chars) explaining HOW the rule shaped this specific reply.',
      },
      surface_id: {
        type: 'string',
        description: 'Optional: a thread / project / file id from the host client.',
      },
    },
    required: ['rule_id', 'message_id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const ruleId = String(args?.rule_id || '').trim();
    const messageId = String(args?.message_id || '').trim();
    const reason = args?.reason ? String(args.reason).trim().slice(0, 320) : null;
    const surfaceId = args?.surface_id ? String(args.surface_id).trim().slice(0, 200) : null;
    if (!ruleId) return errorContent('rule_id is required.');
    if (!messageId) return errorContent('message_id is required.');

    const out = await recordRuleApplication(ctx.supabaseAdmin, ctx.userId, {
      ruleId,
      messageId,
      reason,
      surface: ctx.attribSurface || 'mcp:other',
      surfaceId,
    });
    if (!out.ok) {
      // Soft-fail: a misbehaving model attributing to a retired or wrong
      // rule should get a structured explanation, not break the chat.
      return jsonContent({
        ok: false,
        reason: out.reason,
        message:
          out.reason === 'rule_not_found'
            ? 'That rule_id is not in the user\'s active rule set. Re-fetch via lykn_getRules.'
            : out.reason === 'rule_not_active' || out.reason === 'belief_not_active'
              ? 'That rule (or its parent belief) has been retired. Stop attributing to it.'
              : 'Attribution rejected.',
      });
    }
    return jsonContent({ ok: true, attribution: out.attribution });
  },
};
