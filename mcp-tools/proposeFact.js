// ============================================================================
// mcp-tools/proposeFact.js — outside-client fact proposal
// ============================================================================
// Write. Atomic facts, not durable principles. When an outside AI client
// learns something concrete about the user during a chat ("I work at
// Acme", "I'm building a spatial UI"), it calls this so the fact is
// recorded in the synthesis profile and can later cluster into beliefs.
//
// Wraps `recordLearnedFactFromChat` from userModelLearning.js, which is
// the same function that handles in-LYKN <learned> tags. `sourceId` is
// stamped with the MCP surface so the synthesis layer's audit trail
// shows where the fact came from.
//
// Unlike beliefs, facts do NOT require user ratification — facts are the
// raw observation layer, and the user reviews them in the synthesis-profile
// panel where they can thumbs-down dismiss anything that's wrong.

import { recordLearnedFactFromChat, FACT_KINDS } from '../userModelLearning.js';
import { jsonContent, errorContent, requireWrite } from './index.js';

const FACT_KIND_LIST = Array.isArray(FACT_KINDS) && FACT_KINDS.length
  ? FACT_KINDS
  : ['identity', 'focus', 'theme', 'preference', 'constraint', 'goal'];

export const proposeFactTool = {
  name: 'lykn.proposeFact',
  title: 'Add an atomic fact to the user\'s synthesis profile',
  scope: 'write',
  description: [
    'Record an atomic fact you\'ve learned about the LYKN user during this',
    'conversation — short, third-person, observation-shaped. Examples:',
    '"works as a designer in Brooklyn", "is exploring spatial UIs",',
    '"prefers Gemini over Claude for everyday chat".',
    '',
    'Call this when the user discloses something concrete and durable',
    'about themselves — identity, focus, preferences, constraints, goals.',
    'NOT for casual / transient state ("I\'m tired", "I\'m at the airport")',
    'and NOT for principles / values (use lykn.proposeBelief instead).',
    '',
    'Facts inserted here flow into the same synthesis-profile review surface',
    'the user already uses; they can thumbs-down anything that\'s wrong. No',
    'ratification gate — the synthesis layer treats facts as observation',
    'and beliefs as governance.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The fact, third-person, <=240 chars. E.g. "works as a designer in Brooklyn".',
      },
      kind: {
        type: 'string',
        enum: FACT_KIND_LIST,
        description: `Fact kind. One of: ${FACT_KIND_LIST.join(', ')}. Defaults to "identity".`,
      },
      reason: {
        type: 'string',
        description: 'Optional one-sentence justification (<=240 chars) — what the user said that justifies this fact.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const text = String(args?.text || '').trim();
    if (!text) return errorContent('text is required.');
    const kind = typeof args?.kind === 'string' ? args.kind.trim().toLowerCase() : 'identity';
    const reason = args?.reason ? String(args.reason).trim().slice(0, 240) : null;
    const sourceId = `mcp:${ctx.attribSurface || 'mcp:other'}`.slice(0, 200);

    const out = await recordLearnedFactFromChat(ctx.supabaseAdmin, ctx.userId, {
      text,
      kind,
      reason,
      sourceId,
    });
    if (!out?.ok) {
      return jsonContent({
        ok: false,
        reason: out?.reason || 'fact_record_failed',
        message:
          'Fact was rejected. Common reasons: empty text, unkeyable text, or a duplicate of an existing dismissed fact.',
      });
    }
    return jsonContent({
      ok: true,
      message: out.fact?.isNew
        ? 'New fact added to the synthesis profile.'
        : 'Existing fact reinforced.',
      fact: out.fact || null,
    });
  },
};
