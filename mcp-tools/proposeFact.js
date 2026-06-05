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
  name: 'lykn_proposeFact',
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
    'and NOT for principles / values (beliefs are user-authored in Synthesis Layer).',
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
      conversation_id: {
        type: 'string',
        description: 'Optional host-provided id for the conversation this fact was observed in. Lets the synthesis layer group facts by source thread.',
      },
      message_id: {
        type: 'string',
        description: 'Optional host-provided id for the specific message that disclosed this fact. Lets the digest UI deep-link to the source message.',
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

    // Provenance plumbing (migration 047). The MCP context tells us which
    // client wrote this fact; the user's synthesis profile tells us
    // which project (if any) is currently active. Both stamp first-class
    // columns the nightly synthesis job will use for cluster thresholds.
    const clientSlug = ctx.mcpAuth?.clientKind
      ? String(ctx.mcpAuth.clientKind).toLowerCase().slice(0, 64)
      : 'lykn-chat';

    let activeProjectId = null;
    try {
      const { data: profile } = await ctx.supabaseAdmin
        .from('lykn_user_synthesis_profile')
        .select('active_project_id')
        .eq('user_id', ctx.userId)
        .maybeSingle();
      activeProjectId = profile?.active_project_id || null;
    } catch {
      // Profile lookup failure shouldn't block the fact write — the
      // synthesis job just treats the fact as project-agnostic.
    }

    const conversationId = args?.conversation_id
      ? String(args.conversation_id).slice(0, 128)
      : null;
    const messageId = args?.message_id
      ? String(args.message_id).slice(0, 128)
      : null;

    const out = await recordLearnedFactFromChat(ctx.supabaseAdmin, ctx.userId, {
      text,
      kind,
      reason,
      sourceId,
      client: clientSlug,
      projectId: activeProjectId,
      conversationId,
      messageId,
    });
    if (!out?.ok) {
      const rawReason = String(out?.reason || '');
      // Synthesis-layer free-tier cap (066_synthesis_neuron_cap_trigger.sql)
      // — `recordLearnedFactFromChat` forwards the PG trigger message via
      // `reason`, so a cap hit lands here as a recognisable substring.
      // Translate to a stable code + a model-readable explanation so the
      // outside client can tell the user without parsing SQL noise.
      // proposeFact lands manual facts with status='stated' (the explicit
      // neuron status), which is exactly what the trigger guards on.
      if (rawReason.includes('synthesis_neuron_cap_reached')) {
        return jsonContent({
          ok: false,
          reason: 'synthesis_neuron_cap_reached',
          message:
            'The user is on the Free plan and has reached their explicit-neuron cap (chats + vault notes + ratified beliefs + manual facts). Suggest they upgrade to Pro in LYKN to keep adding facts to their synthesis profile.',
        });
      }
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
