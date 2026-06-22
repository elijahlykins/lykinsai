// ============================================================================
// mcp-tools/updateAssistantInstructions.js — let the in-app chat retune itself
// ============================================================================
// Text-chat parity for the voice agent's `update_voice_instructions` tool. When
// the user gives durable feedback about HOW the assistant should behave ("be
// more concise", "turn up the sarcasm by 15%", "stop saying 'great question'",
// "talk to me like a coach"), the chat model composes the FULL updated custom-
// instruction text (it has the current text in the [USER_PREFERENCES] block)
// and calls this tool with `instructions` set to that text.
//
// Persistence is CLIENT-SIDE: the user's custom-instruction prompt lives in
// browser localStorage (lykinsai_settings → userPrompt / voicePrompt), not the
// DB — exactly like the voice path (see src/lib/voice/tuneInstructions.ts). So
// this server tool just validates + echoes { ok, scope, instructions } back;
// the chat orchestrator (chatSendOrchestrator.ts) sees the tool result, calls
// persistInstructionPrompt(scope, instructions), and the change sticks for
// future turns (it rides along on every request via getAiPrefs).
//
// In-app ONLY: intentionally NOT in mcp-tools/index.js, because external MCP
// clients have no LYKN settings store to write back into.

import { jsonContent, errorContent } from './content.js';

const INSTRUCTIONS_MAX = 8000;

export const updateAssistantInstructionsTool = {
  name: 'lykn_update_assistant_instructions',
  title: 'Change how LYKN behaves (persist custom instructions)',
  scope: 'write',
  description: [
    'Change the assistant\'s OWN default behavior — tone, personality, reply',
    'style, formatting — so the change STICKS across future conversations, not',
    'just this turn. Call this whenever the user gives feedback about HOW you',
    'should sound or act and wants it to persist: "be more concise", "stop',
    'over-explaining", "turn up the sarcasm by 15%", "act more like a coach",',
    '"talk to me like a friend", "stop saying \'great question\'", "don\'t use',
    'bullet points".',
    '',
    'COMPOSE THE FULL TEXT: the user\'s CURRENT custom instructions are in the',
    '[USER_PREFERENCES] section of your context. Keep everything they did NOT',
    'ask to change and fold the new request in, then pass the COMPLETE rewritten',
    'text as `instructions` (never just the delta). Treat relative tweaks ("by',
    '15%", "a bit warmer") as a modest shift.',
    '',
    'scope defaults to "chat" (the typed-chat custom instructions). Use "voice"',
    'ONLY when the user means how you sound in live voice conversations.',
    '',
    'Do NOT call this for a one-message-only request ("just keep THIS answer',
    'short") — only when they want your DEFAULT behavior changed. After it',
    'returns, confirm in one plain line what changed; do not read the full',
    'instruction text back to them.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        description:
          'The COMPLETE updated custom-instruction text (current instructions with the user\'s requested change folded in). Not a diff.',
      },
      scope: {
        type: 'string',
        enum: ['chat', 'voice'],
        description:
          'Which instruction set to update: "chat" (default — typed chat behavior) or "voice" (live voice behavior).',
      },
      summary: {
        type: 'string',
        description:
          'Optional one-line, plain-English summary of what changed (e.g. "more concise, fewer bullet points"). Shown back to the user.',
      },
    },
    required: ['instructions'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    if (!ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const raw = typeof args.instructions === 'string' ? args.instructions.trim() : '';
    if (!raw) {
      return jsonContent({
        ok: false,
        error: 'missing_instructions',
        message: "I didn't catch how you want me to change — say it again and I'll adjust.",
      });
    }

    const scope = args.scope === 'voice' ? 'voice' : 'chat';
    const instructions = raw.slice(0, INSTRUCTIONS_MAX);
    const summary =
      typeof args.summary === 'string' && args.summary.trim()
        ? args.summary.trim().slice(0, 240)
        : null;

    // Persistence happens client-side (localStorage via persistInstructionPrompt
    // in the chat orchestrator) because the user's instruction prompt lives in
    // their browser settings, not the DB. We just hand back the validated text.
    return jsonContent({
      ok: true,
      scope,
      instructions,
      summary,
      message:
        scope === 'voice'
          ? 'Saved — this will shape how I sound in voice from now on.'
          : 'Saved — this will shape how I respond from now on.',
    });
  },
};
