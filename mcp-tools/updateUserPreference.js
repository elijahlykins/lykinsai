// ============================================================================
// mcp-tools/updateUserPreference.js — change ONE preference, ask-first
// ============================================================================
// Write. Mirrors the in-app settings UI: lets the AI change one
// preference at a time, the same way a user would tick / untick a
// box. Deliberately one-field-per-call so the model can't drift into
// "fix everything" territory by accident, and so the audit trail
// (updated_at + future row history) shows discrete decisions.
//
// Policy — ASK FIRST:
//   These prefs are user-policy, not chat ephemera. The model should
//   propose a change and wait for explicit user confirmation BEFORE
//   calling this tool. The guidance block in server.js spells this
//   out, but the tool also defensively validates the input so a
//   hallucinated value (e.g. "training_opt_out": "maybe") gets a
//   clean rejection rather than corrupting the row.
//
// Forbidden fields:
//   • `metadata` is excluded from chat writes — it's a forward-compat
//     bucket used by the in-app settings page for tutorial dismissals
//     and beta flags. Letting the chat agent fiddle with it would
//     silently break UI state the user manages elsewhere.

import { jsonContent, errorContent } from './index.js';

const BOOL_FIELDS = new Set([
  'memory_paused',
  'training_opt_out',
  'email_product_updates',
  'night_shift_enabled',
]);

const INT_FIELDS = new Map([
  // [field, [minOrNull, max]] — null in min means "null is also allowed"
  ['chat_retention_days', [1, 3650]],
]);

const STRING_FIELDS = new Map([
  ['night_shift_tier', new Set(['brief', 'research', 'delegate'])],
]);

const ALLOWED = new Set([...BOOL_FIELDS, ...INT_FIELDS.keys(), ...STRING_FIELDS.keys()]);

export const updateUserPreferenceTool = {
  name: 'lykn_updateUserPreference',
  title: 'Change ONE user preference (after asking the user)',
  scope: 'write',
  description: [
    'Update a single field on the user\'s lykn_user_preferences row.',
    '',
    'POLICY — ASK FIRST. Every field here is user-policy, not chat',
    'ephemera. Propose the change in your reply ("Want me to pause',
    'memory extraction?"), wait for an explicit yes from the user,',
    'THEN call this tool. Never flip these silently — they govern',
    'privacy, retention, and pipeline behaviour the user explicitly',
    'opted into.',
    '',
    'ALLOWED FIELDS:',
    '  • memory_paused (bool) — pause personal-memory writes',
    '  • training_opt_out (bool) — exclude from model improvement',
    '  • chat_retention_days (int 1-3650 or null) — auto-purge older',
    '    chats. null = keep forever.',
    '  • email_product_updates (bool) — product update emails',
    '  • night_shift_enabled (bool) — overnight project morning briefs',
    '    (Night Shift cron). Ask before enabling.',
    '  • night_shift_tier (string) — "brief" (morning handoff only),',
    '    "research" (triage + overnight research), or "delegate" (also Cursor',
    '    builds + sub-agents for scheduled items). Requires night_shift_enabled.',
    '',
    'Visual / theme prefs are NOT here (they live in browser',
    'localStorage). Don\'t accept "change my theme" requests via this',
    'tool.',
    '',
    'EXACTLY ONE field per call. Multiple changes = multiple calls,',
    'each preceded by user confirmation. This is intentional — it',
    'forces the model to slow down and reduces the blast radius of a',
    'misunderstood instruction.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      field: {
        type: 'string',
        enum: [...ALLOWED],
        description: 'Which preference to change.',
      },
      value: {
        description: 'New value. Type depends on field — bool for toggles, integer 1-3650 or null for chat_retention_days.',
      },
    },
    required: ['field', 'value'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const field = typeof args?.field === 'string' ? args.field.trim() : '';
    if (!ALLOWED.has(field)) {
      return errorContent(`field must be one of: ${[...ALLOWED].join(', ')}.`);
    }

    let value = args?.value;
    if (BOOL_FIELDS.has(field)) {
      if (typeof value !== 'boolean') {
        return errorContent(`${field} must be a boolean.`);
      }
    } else if (INT_FIELDS.has(field)) {
      const [min, max] = INT_FIELDS.get(field);
      if (value === null) {
        // explicit null is allowed for chat_retention_days only;
        // model passes null to mean "keep forever."
      } else if (!Number.isInteger(value) || value < min || value > max) {
        return errorContent(`${field} must be an integer between ${min} and ${max}, or null.`);
      }
    } else if (STRING_FIELDS.has(field)) {
      const allowed = STRING_FIELDS.get(field);
      const s = String(value || '').trim();
      if (!allowed.has(s)) {
        return errorContent(`${field} must be one of: ${[...allowed].join(', ')}.`);
      }
      value = s;
    }

    // Upsert so the call works even if the row was somehow missing
    // (the migration backfills it, but defending against drift is
    // cheap and avoids a silent "0 rows updated" hole).
    const patch = { user_id: ctx.userId, [field]: value };
    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_user_preferences')
      .upsert(patch, { onConflict: 'user_id' })
      .select(`${field}, updated_at`)
      .single();
    if (error) return errorContent(`prefs update failed: ${error.message}`);

    return jsonContent({
      ok: true,
      field,
      value: data[field],
      updated_at: data.updated_at,
      message: `Set ${field} to ${JSON.stringify(data[field])}.`,
    });
  },
};
