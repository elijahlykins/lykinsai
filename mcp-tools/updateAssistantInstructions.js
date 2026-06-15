// ============================================================================
// mcp-tools/updateAssistantInstructions.js — self-tuning custom instructions
// ============================================================================
// IN-APP ONLY: deliberately NOT exported from mcp-tools/index.js, so external
// MCP clients (Claude Desktop / Cursor / ChatGPT) can't rewrite a user's saved
// instructions. The in-product LYKN chat reaches for this when the user gives
// feedback about HOW the assistant should behave — its tone, voice, style, or
// the way it replies ("be more concise", "turn up the sarcasm", "stop saying
// 'great question'", "talk to me like a friend").
//
// PERSISTENCE IS CLIENT-SIDE. The user's custom instructions ("Custom
// instructions" + "Voice instructions" in Settings → Display) live in browser
// localStorage, not the DB — so this handler does NOT write anything. It
// validates the model-composed instruction text and echoes it back in the tool
// result with `persist: 'instructions'`; the chat client (chatSendOrchestrator)
// watches for that result, writes it into the user's settings, and broadcasts
// the settings-changed event. The change then appears in Settings for the user
// to review and edit by hand, and rides along on every future request via
// getAiPrefs(). This is why the model must pass the FULL updated instruction
// text (current text + the requested change), not just the delta.

import { jsonContent, errorContent, requireWrite } from './index.js';

const MAX_LEN = 1500;

export const updateAssistantInstructionsTool = {
  name: 'lykn_update_assistant_instructions',
  title: 'Update your own custom instructions (tone / behavior)',
  scope: 'write',
  description: [
    'Update the user\'s SAVED custom instructions for you — the personal',
    'directions that shape your tone, personality, and the way you reply.',
    'These persist across conversations and appear in the user\'s Settings,',
    'where they can also edit them by hand.',
    '',
    'WHEN TO CALL — call this whenever the user gives feedback about HOW you',
    'should behave or sound, and clearly wants it to STICK going forward:',
    '  • "be more concise" / "stop over-explaining" / "talk less"',
    '  • "turn up the sarcasm by 15%" / "be funnier" / "be more direct"',
    '  • "act more like a coach" / "talk to me like a friend"',
    '  • "stop saying \'great question\'" / "don\'t use bullet points"',
    '  • "always answer in Spanish first"',
    'Do NOT call it for one-off, this-message-only requests ("just this once,',
    'keep it short") — only when the user wants their default behavior changed.',
    '',
    'HOW TO USE — you are given the user\'s CURRENT custom instructions in the',
    '[USER_PREFERENCES] section of your context. Compose the FULL updated',
    'instruction text: keep everything the user did not ask to change, and fold',
    'in the requested change. Interpret relative tweaks ("turn up the sarcasm by',
    `15%", "a bit warmer") as a modest, sensible shift — never extreme. Keep it`,
    `natural prose, well under ${MAX_LEN} characters. Pass the result as`,
    '`instructions`.',
    '',
    'SCOPE — default "chat" (how you respond in text). Use "voice" ONLY when the',
    'user is specifically talking about how you sound in live voice conversations.',
    '',
    'After it succeeds, briefly confirm in plain language what you changed (e.g.',
    '"Done — I\'ll keep things more concise from now on"). Do NOT read the full',
    'instruction text back, and do NOT mention settings internals or tool names.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        description:
          'The FULL updated custom-instruction text (current instructions with the requested change folded in). '
          + 'Plain second-person directives addressed to you ("Be concise.", "Use a dry, sarcastic wit.").',
      },
      scope: {
        type: 'string',
        enum: ['chat', 'voice'],
        description: 'Which instructions to update: "chat" (default, text replies) or "voice" (live voice conversations).',
      },
      summary: {
        type: 'string',
        description: 'One short present-tense phrase describing what changed, e.g. "turned up the sarcasm". For your own confirmation line.',
      },
    },
    required: ['instructions'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const instructions = typeof args?.instructions === 'string'
      ? args.instructions.trim().slice(0, MAX_LEN)
      : '';
    if (!instructions) {
      return errorContent('instructions is required — pass the full updated custom-instruction text.');
    }
    const scope = String(args?.scope || 'chat').trim().toLowerCase() === 'voice' ? 'voice' : 'chat';
    const summary = typeof args?.summary === 'string' ? args.summary.trim().slice(0, 120) : '';

    // No DB write — the client persists this into the user's settings
    // (localStorage) when it sees `persist: 'instructions'` on the result.
    return jsonContent({
      ok: true,
      persist: 'instructions',
      scope,
      instructions,
      summary,
      message: scope === 'voice'
        ? 'Saved to your voice instructions — this shapes how I sound from now on. You can edit it in Settings.'
        : 'Saved to your custom instructions — this shapes how I reply from now on. You can edit it in Settings.',
    });
  },
};
