// ============================================================================
// mcp-tools/proposeBelief.js — outside-client belief proposal
// ============================================================================
// Write. The synthesis layer "learns from elsewhere" — when an outside AI
// client realises during a conversation that the user has expressed a
// durable principle (not just a passing fact), it records it here.
//
// Two paths, gated by the `user_confirmed` argument:
//
//   user_confirmed=false (default)
//     → lands as `proposed`. User must ratify in LYKN.
//     For: things the AI noticed but the user didn't explicitly approve
//     in the chat. Conservative path.
//
//   user_confirmed=true
//     → lands as `active` immediately.
//     For: things the AI ASKED the user about in chat ("Should I add 'X'
//     as a core belief?") and the user said yes. The user's in-chat "yes"
//     IS the ratification — no separate UI step needed.
//     The starter Project Instructions tell models to use this path for
//     core beliefs, with the explicit ask-first contract.
//
// Why this design preserves safety despite auto-active:
//   • Prompt-injection threat: the model still has to be in a chat where
//     the user actually said yes; the LYKN attribSurface is stamped onto
//     the rationale so weekly digest reviewers can see "Claude marked
//     this active in conversation X" and roll back.
//   • Over-eager AIs: the in-chat ask creates a friction point that
//     filters out casual / one-off statements before they ever become
//     active beliefs.
//   • Cross-client loops: two AIs each independently asking + getting
//     "yes" still requires two real human consents — that's converging
//     evidence, not a loop.
//
// Implementation note: we cannot reuse `createManualBelief` directly because
// it expects an in-LYKN context. We mint the row by hand and stamp the
// first-class provenance columns added in migration 046:
//   • source                       — clientKind that wrote this row
//   • proposed_in_conversation_id  — host-provided thread id (when given)
//   • proposed_in_message_id       — host-provided message id (when given)
//   • proposed_by_clients[]        — append-only deduplicated set of every
//                                    client that has proposed THIS
//                                    belief_key. Two clients independently
//                                    surfacing the same belief is a strong
//                                    promotion signal.
//   • ratified_by                  — 'in-chat' when user_confirmed=true
//                                    landed the row active; NULL otherwise.
//
// The rationale is now back to being prose-for-the-user — the activity
// feed reads provenance off the columns, not by regex-parsing rationale.

import { normalizeBeliefKey, NEEDS } from '../beliefSystem.js';
import { jsonContent, errorContent, requireWrite } from './index.js';

const NEED_SET = new Set(NEEDS);

export const proposeBeliefTool = {
  name: 'lykn_proposeBelief',
  title: 'Propose a new durable belief for the user to ratify',
  scope: 'write',
  description: [
    'Propose a new durable belief — a short, third-person principle that',
    'shapes how an AI should respond to this user. Examples: "Legacy tools',
    'are friction", "Visual thinking beats text-first thinking", "Shipping',
    'matters more than polishing".',
    '',
    'TWO PATHS — choose carefully:',
    '',
    '1. CORE BELIEF (auto-active):',
    '   ASK THE USER FIRST in chat: "I noticed you might hold the principle',
    '   \'X\' — should I add it to your synthesis layer as a core belief that',
    '   shapes how all your AIs respond?" If they say yes in their next',
    '   message, call this tool with user_confirmed=true. The belief lands',
    '   active immediately and starts shaping replies in every connected',
    '   client. Use this path ONLY when the user has explicitly approved',
    '   in the conversation. Don\'t infer consent from silence or enthusiasm.',
    '',
    '2. OBSERVATION (proposed, awaits ratify):',
    '   Call without user_confirmed (or with user_confirmed=false) when',
    '   you noticed a candidate belief but didn\'t ask in chat. The belief',
    '   lands as `proposed` and the user reviews it in their LYKN belief',
    '   window. Lower friction for you, higher friction for them.',
    '',
    'When to call AT ALL (either path):',
    '  • The user has stated a clear principle that generalises across',
    '    many decisions ("I always reject X", "I care about Y in',
    '    everything") — not a one-off fact.',
    '  • You\'ve already checked lykn_getBeliefs and the principle is not',
    '    already there.',
    '',
    'When NOT to call:',
    '  • Casual / situational statements ("I\'m tired today"). Use',
    '    lykn_proposeFact instead — facts are observation, beliefs are',
    '    governance.',
    '  • Heat-of-the-moment statements. Beliefs are durable.',
    '  • Anything you wouldn\'t feel right ASKING about — if asking the',
    '    user "should I make this a core belief?" feels weird, the candidate',
    '    isn\'t belief-shaped yet.',
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
      user_confirmed: {
        type: 'boolean',
        description: 'Set to true ONLY if you asked the user in chat ("Should I add X as a core belief?") and they said yes. true → lands active immediately. false / omitted → lands proposed for ratification in LYKN.',
      },
      conversation_id: {
        type: 'string',
        description: 'Optional host-provided id for the conversation this belief was proposed in. If your client tracks thread ids, pass them here so the digest UI can group beliefs by source thread.',
      },
      message_id: {
        type: 'string',
        description: 'Optional host-provided id for the message in which the user expressed this principle. Lets the digest UI deep-link to the source message.',
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

    const userConfirmed = Boolean(args?.user_confirmed);
    // Provenance: clientKind drives the new `source` and proposed_by_clients
    // columns. Falls back to 'lykn-chat' for JWT (in-LYKN web) requests
    // matching the attribSurface convention, and 'other' as a final guard.
    const source = String(ctx.mcpAuth?.clientKind || 'lykn-chat')
      .toLowerCase()
      .slice(0, 64) || 'other';
    const conversationId = args?.conversation_id
      ? String(args.conversation_id).slice(0, 128)
      : null;
    const messageId = args?.message_id
      ? String(args.message_id).slice(0, 128)
      : null;
    const rationale = args?.rationale
      ? String(args.rationale).trim().slice(0, 240)
      : null;

    // We need the existing row's status AND its proposed_by_clients[] so
    // we can (a) honour the dismissed-floor safety guard and (b) merge
    // this client into the cross-client convergence set without
    // clobbering whatever previous clients put there.
    const { data: existing } = await ctx.supabaseAdmin
      .from('lykn_beliefs')
      .select('status, proposed_by_clients')
      .eq('user_id', ctx.userId)
      .eq('belief_key', key)
      .maybeSingle();

    const dismissedFloor = existing?.status === 'dismissed';
    const status = userConfirmed && !dismissedFloor ? 'active' : 'proposed';
    const confidence = userConfirmed && !dismissedFloor ? 0.7 : 0.5;

    // Dedup-merge: never grow unbounded — cap at 8 distinct clients.
    // After 8, additional convergence is overwhelmingly redundant for
    // the digest UI but unbounded would let a misbehaving client spam
    // the column.
    const priorClients = Array.isArray(existing?.proposed_by_clients)
      ? existing.proposed_by_clients
      : [];
    const proposedByClients = priorClients.includes(source)
      ? priorClients
      : [...priorClients, source].slice(0, 8);

    const ratifiedBy = status === 'active' ? 'in-chat' : null;
    const ratifiedAt = status === 'active' ? new Date().toISOString() : null;

    const insertRow = {
      user_id: ctx.userId,
      belief_text: text,
      belief_key: key,
      serves_need: need,
      status,
      confidence,
      promoted_from_facts: [],
      rationale,
      first_seen_at: new Date().toISOString(),
      // 046 provenance columns:
      source,
      proposed_in_conversation_id: conversationId,
      proposed_in_message_id: messageId,
      proposed_by_clients: proposedByClients,
      ratified_by: ratifiedBy,
      ...(ratifiedAt ? { ratified_at: ratifiedAt } : {}),
    };

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_beliefs')
      .upsert(insertRow, { onConflict: 'user_id,belief_key' })
      .select('id, belief_text, serves_need, status, rationale, source, proposed_by_clients, ratified_by, created_at')
      .maybeSingle();
    if (error) return errorContent(`belief upsert failed: ${error.message}`);
    if (!data) return errorContent('belief insert returned no row.');

    const message = data.status === 'active'
      ? `Belief "${data.belief_text}" added as active. It will start shaping replies across all your connected AI clients.`
      : dismissedFloor && userConfirmed
        ? 'You previously dismissed this belief in LYKN. Re-routing to ratification rather than auto-activating.'
        : 'Belief proposed. The user will see a ratify card next time they open LYKN.';

    return jsonContent({
      ok: true,
      message,
      belief: {
        id: data.id,
        text: data.belief_text,
        serves_need: data.serves_need,
        status: data.status,
        rationale: data.rationale,
        source: data.source,
        proposed_by_clients: data.proposed_by_clients || [],
        ratified_by: data.ratified_by,
        created_at: data.created_at,
      },
    });
  },
};
