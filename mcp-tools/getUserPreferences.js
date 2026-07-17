// ============================================================================
// mcp-tools/getUserPreferences.js — read the user's server-honoured prefs
// ============================================================================
// Read. Surfaces the user's `lykn_user_preferences` row (migration
// 060) — the server-side, privacy-relevant settings that govern the
// synthesis pipeline (memory_paused, training_opt_out,
// chat_retention_days, …). These are the ones the AI needs to know
// about because they affect what the AI is ALLOWED to do.
//
// The most important read here is `memory_paused`: when true, the
// nightly synthesis job and the on-demand learn-now path skip the
// user. The chat agent should respect that — don't push new
// observations as facts, don't claim "I'll remember this for next
// time," don't suggest the user view their synthesis layer as
// growing.
//
// Note: visual-only prefs (theme, font size, etc.) live in browser
// localStorage and are NOT in this row. Don't claim you can change
// the theme from chat — you can't.
//
// Defensive default: if the row is missing for any reason (legacy
// account predating the migration's backfill), we return the
// hard-coded defaults so the model never has to reason about a
// "missing prefs" state.

import { jsonContent, errorContent } from './index.js';
import { parseNightShiftTier } from '../lib/nightShift/stewardTier.js';

const PREFS_DEFAULTS = {
  memory_paused: false,
  training_opt_out: false,
  chat_retention_days: null,
  show_provenance: true,
  email_product_updates: true,
  email_synthesis_digest: false,
  night_shift_enabled: false,
  night_shift_tier: 'brief',
};

export const getUserPreferencesTool = {
  name: 'lykn_getUserPreferences',
  title: 'Read the user\'s server-honoured app preferences',
  scope: 'read',
  description: [
    'Return the user\'s `lykn_user_preferences` row — the privacy /',
    'pipeline preferences honoured server-side. The fields you care',
    'about as an AI agent:',
    '',
    '  • memory_paused — when TRUE, the nightly synthesis job skips',
    '    this user. Do not promise to "remember" things, do not push',
    '    new observations as facts mid-chat, and don\'t suggest the',
    '    synthesis layer is currently growing.',
    '  • training_opt_out — TRUE means chats are excluded from model',
    '    improvement exports. Don\'t reference training in suggestions.',
    '  • chat_retention_days — NULL = forever; integer = nightly job',
    '    purges chats older than N days. Helpful context when the user',
    '    asks "where did my old chat go?"',
    '  • show_provenance — UI hint only; controls whether the chat',
    '    surfaces "based on belief X / fact Y" citations by default.',
    '  • night_shift_enabled — when TRUE, the Night Shift cron writes',
    '    a morning_brief project-state push for each active project',
    '    overnight. Surface it in the project panel / overlay.',
    '',
    'CALL THIS at the start of any conversation that\'s about to write',
    'durable state (createVaultNote, addProjectNeurons, …) so you can',
    'check memory_paused before promising persistence. Also call when',
    'the user asks "what are my settings?" or anything privacy-shaped.',
    '',
    'CHEAP — single PK lookup. Safe to call once per session.',
    '',
    'Visual prefs (theme, font, density) live in browser localStorage',
    'and are NOT in this row. You CAN\'T change those from chat.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_user_preferences')
      .select('memory_paused, training_opt_out, chat_retention_days, show_provenance, email_product_updates, email_synthesis_digest, night_shift_enabled, night_shift_tier, metadata, updated_at')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (error) return errorContent(`prefs read failed: ${error.message}`);

    const prefs = data
      ? {
          memory_paused: !!data.memory_paused,
          training_opt_out: !!data.training_opt_out,
          chat_retention_days: data.chat_retention_days ?? null,
          show_provenance: !!data.show_provenance,
          email_product_updates: !!data.email_product_updates,
          email_synthesis_digest: !!data.email_synthesis_digest,
          night_shift_enabled: !!data.night_shift_enabled,
          night_shift_tier: parseNightShiftTier(data.night_shift_tier),
          metadata: data.metadata || {},
          updated_at: data.updated_at || null,
        }
      : { ...PREFS_DEFAULTS, metadata: {}, updated_at: null, _defaulted: true };

    const advisories = [];
    if (prefs.memory_paused) {
      advisories.push('memory_paused=TRUE — do not promise to remember or persist anything across chats; the nightly synthesis is paused.');
    }
    if (prefs.training_opt_out) {
      advisories.push('training_opt_out=TRUE — this user\'s chats are excluded from model improvement.');
    }
    if (typeof prefs.chat_retention_days === 'number') {
      advisories.push(`chat_retention_days=${prefs.chat_retention_days} — chats older than this are auto-purged nightly.`);
    }

    return jsonContent({
      ok: true,
      preferences: prefs,
      advisories,
      message: advisories.length
        ? `Loaded preferences. Heads-up: ${advisories.join(' ')}`
        : 'Loaded preferences. All defaults; no special handling required.',
    });
  },
};
