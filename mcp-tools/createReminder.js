// ============================================================================
// mcp-tools/createReminder.js — set a time-anchored reminder from chat/voice
// ============================================================================
// Write. Creates a row in lykn_reminders when the user asks to be reminded of
// something ("remind me to call the dentist tomorrow at 3", "in an hour, nudge
// me about the deploy"). The same handler backs text chat, the OpenAI Realtime
// voice path, and the ElevenLabs voice path — adding the tool to each surface's
// whitelist is all that's needed.
//
// Time resolution:
//   The model resolves the WHEN. It can pass an absolute ISO 8601 instant in
//   `remind_at` (preferred — include the timezone offset), OR a relative
//   `in_minutes` offset from now when it doesn't know the wall clock (common in
//   voice: "remind me in 20 minutes"). Exactly one of the two is required.
//   `remind_at_text` keeps the user's own phrasing for natural read-back.
//
// Delivery (v1):
//   Pull-based. There is no push/SMS/email worker yet, so the handler does NOT
//   promise the user a notification will fire. It confirms the reminder was
//   SAVED and will be surfaced (e.g. in their next voice briefing / when they
//   ask "what are my reminders").

import { jsonContent, errorContent } from './index.js';

const TITLE_MAX = 280;
const BODY_MAX = 4000;
const TEXT_MAX = 200;
// Guardrails on the relative path so a model typo can't schedule a reminder
// for the year 9999. ~2 years of minutes.
const MAX_IN_MINUTES = 60 * 24 * 366 * 2;

export const createReminderTool = {
  name: 'lykn_createReminder',
  title: 'Set a reminder for the user',
  scope: 'write',
  description: [
    'Create a time-anchored reminder when the user asks to be reminded of',
    'something — "remind me to call the dentist tomorrow at 3", "in an hour,',
    'nudge me about the deploy", "don\'t let me forget to email Sam Monday".',
    '',
    'You must resolve WHEN it should fire. Provide ONE of:',
    '  • remind_at   — an absolute ISO 8601 instant WITH timezone offset',
    '                  (e.g. "2026-06-07T15:00:00-06:00"). Preferred when you',
    '                  know the current date/time. If unsure of "now", call',
    '                  lykn_get_current_time first, or use in_minutes.',
    '  • in_minutes  — a relative offset from now in minutes (e.g. 60 for "in',
    '                  an hour", 1440 for "tomorrow"). Use this when you don\'t',
    '                  know the wall clock (common in voice).',
    '',
    'Always pass remind_at_text with the user\'s own phrasing ("tomorrow at',
    '3pm", "in 20 minutes") — it is read back to them verbatim and is clearer',
    'than a reformatted timestamp.',
    '',
    'After saving, confirm in plain language WHAT you\'ll remind them about and',
    'WHEN. NOTE: reminders are surfaced when the user next engages (e.g. in',
    'their voice briefing or when they ask for their reminders) — there is no',
    'push notification yet, so do not promise an alert will pop up at the exact',
    'minute. Do not invent a reminder the user did not ask for.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'What to remind the user about, phrased as the reminder itself (<=280 chars), e.g. "Call the dentist".',
      },
      remind_at: {
        type: 'string',
        description: 'Absolute ISO 8601 instant WITH timezone offset, e.g. "2026-06-07T15:00:00-06:00". Provide this OR in_minutes.',
      },
      in_minutes: {
        type: 'integer',
        minimum: 1,
        description: 'Relative offset from now, in minutes (e.g. 60 = in an hour). Provide this OR remind_at.',
      },
      remind_at_text: {
        type: 'string',
        description: 'The user\'s own phrasing of the time ("tomorrow at 3pm", "in 20 minutes"). Read back verbatim. <=200 chars.',
      },
      body: {
        type: 'string',
        description: 'Optional extra detail/context for the reminder (<=4000 chars).',
      },
      project_id: {
        type: 'string',
        description: 'Optional id of the project this reminder relates to (from lykn_listProjects / lykn_getProjectState).',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const title = String(args?.title || '').trim().slice(0, TITLE_MAX);
    if (!title) return errorContent('title is required — what should I remind you about?');

    // Resolve the fire time from exactly one of remind_at / in_minutes.
    let remindAt = null;
    const hasInMinutes = args?.in_minutes !== undefined && args?.in_minutes !== null && args?.in_minutes !== '';
    const hasRemindAt = typeof args?.remind_at === 'string' && args.remind_at.trim();

    if (hasRemindAt) {
      const parsed = new Date(args.remind_at.trim());
      if (Number.isNaN(parsed.getTime())) {
        return errorContent('remind_at is not a valid ISO 8601 timestamp. Use e.g. "2026-06-07T15:00:00-06:00", or pass in_minutes instead.');
      }
      remindAt = parsed;
    } else if (hasInMinutes) {
      const mins = Number.parseInt(args.in_minutes, 10);
      if (!Number.isFinite(mins) || mins < 1) {
        return errorContent('in_minutes must be a positive integer number of minutes from now.');
      }
      if (mins > MAX_IN_MINUTES) {
        return errorContent('in_minutes is too far in the future (max ~2 years). Pass an absolute remind_at for distant dates.');
      }
      remindAt = new Date(Date.now() + mins * 60_000);
    } else {
      return errorContent('When should I remind you? Provide remind_at (ISO 8601) or in_minutes (relative).');
    }

    const bodyRaw = typeof args?.body === 'string' ? args.body.trim().slice(0, BODY_MAX) : '';
    const remindAtText = typeof args?.remind_at_text === 'string'
      ? args.remind_at_text.trim().slice(0, TEXT_MAX)
      : '';
    const projectId = typeof args?.project_id === 'string' && args.project_id.trim()
      ? args.project_id.trim()
      : null;

    const source = `lykn-chat-agent:${ctx.attribSurface || 'lykn-chat'}`.slice(0, 64);

    const row = {
      user_id: ctx.userId,
      title,
      body: bodyRaw || null,
      remind_at: remindAt.toISOString(),
      remind_at_text: remindAtText || null,
      project_id: projectId,
      source,
    };

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_reminders')
      .insert(row)
      .select('id, title, body, remind_at, remind_at_text, status, project_id, created_at')
      .single();
    if (error) {
      console.warn('[mcp:createReminder]', error.message);
      return errorContent(`reminder insert failed: ${error.message}`);
    }

    const whenSpoken = remindAtText || `at ${data.remind_at}`;
    return jsonContent({
      ok: true,
      message: `Reminder set: "${title}" — ${whenSpoken}. I'll surface it next time you check in (no push alert yet).`,
      reminder: {
        id: data.id,
        title: data.title,
        body: data.body,
        remind_at: data.remind_at,
        remind_at_text: data.remind_at_text,
        status: data.status,
        project_id: data.project_id,
        created_at: data.created_at,
      },
    });
  },
};
