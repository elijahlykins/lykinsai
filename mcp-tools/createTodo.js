// ============================================================================
// mcp-tools/createTodo.js — add a task to the user's to-do list (chat/voice)
// ============================================================================
// Write. Creates a row in lykn_todos when the user wants to track something to
// do ("add 'email Sam the contract' to my todo list", "I need to renew my
// passport", "put 'pick up dry cleaning' on my list"). The same handler backs
// text chat, the OpenAI Realtime voice path, and the ElevenLabs voice path —
// adding the tool to each surface's whitelist is all that's needed.
//
// A to-do is the sibling of a reminder + event but lighter: the due date is
// OPTIONAL. Use a TO-DO for an open task with no fixed time ("read that book"),
// a REMINDER for a point-in-time nudge ("remind me at 3pm"), and an EVENT for
// something scheduled with a start/end ("lunch Thursday at noon").
//
// Time resolution (optional):
//   If the user gives a soft deadline ("by Friday", "end of the month") YOU
//   resolve it: pass an absolute ISO 8601 `due_at` WITH timezone offset, OR a
//   relative `in_minutes` offset. Keep their phrasing in `due_at_text`. Most
//   to-dos have no due date at all — leave both off in that case.

import { jsonContent, errorContent, requireWrite } from './index.js';
import { resolveInstant } from './_time.js';
import { resolveWriteProjectTarget } from '../lib/projectWriteTarget.js';

const TITLE_MAX = 280;
const NOTES_MAX = 4000;
const TEXT_MAX = 200;
// ~2 years of minutes — guardrail so a model typo can't schedule for 9999.
const MAX_IN_MINUTES = 60 * 24 * 366 * 2;
const PRIORITIES = ['low', 'normal', 'high'];

export const createTodoTool = {
  name: 'lykn_createTodo',
  title: 'Add a task to the user\'s to-do list',
  scope: 'write',
  description: [
    'Add a task to the user\'s to-do list when they say they need or want to',
    'do something — "add \'email Sam the contract\' to my todo list", "I need',
    'to renew my passport", "put \'pick up dry cleaning\' on my list", "remind',
    'me to read that book" (no specific time).',
    '',
    'Use a TO-DO for an open task with no fixed time. Use lykn_createReminder',
    'for a point-in-time nudge ("remind me at 3pm tomorrow"), and',
    'lykn_createEvent for something scheduled with a start/end ("lunch Thursday',
    'at noon"). When the user clearly gives a CLOCK time to be nudged at,',
    'prefer a reminder; when it is just "something I have to get done", use a',
    'to-do.',
    '',
    'A due date is OPTIONAL. If the user gives a soft deadline ("by Friday",',
    '"end of the month"), resolve it and pass ONE of:',
    '  • due_at     — absolute ISO 8601 instant WITH timezone offset',
    '                 (e.g. "2026-06-12T17:00:00-06:00"). If unsure of "now",',
    '                 call lykn_get_current_time first.',
    '  • in_minutes — a relative offset from now in minutes.',
    'Pass due_at_text with the user\'s own phrasing ("by Friday"). If there is',
    'no deadline, leave the due fields off entirely.',
    '',
    'Optionally set priority ("high" for urgent/important). After saving,',
    'confirm WHAT was added in plain language. Do not invent a task the user',
    'did not ask for.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The task, phrased as the to-do itself (<=280 chars), e.g. "Email Sam the contract".',
      },
      notes: {
        type: 'string',
        description: 'Optional extra detail / context / sub-steps (<=4000 chars).',
      },
      priority: {
        type: 'string',
        enum: PRIORITIES,
        description: 'Soft priority: "high" for urgent/important, "low" for someday, "normal" (default) otherwise.',
      },
      due_at: {
        type: 'string',
        description: 'Optional absolute ISO 8601 due date WITH timezone offset, e.g. "2026-06-12T17:00:00-06:00". Provide this OR in_minutes, or neither.',
      },
      in_minutes: {
        type: 'integer',
        minimum: 1,
        description: 'Optional relative due offset from now, in minutes. Provide this OR due_at, or neither.',
      },
      due_at_text: {
        type: 'string',
        description: 'The user\'s own phrasing of the deadline ("by Friday", "end of the month"). Read back verbatim. <=200 chars.',
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone the user is in, e.g. "America/Denver". Used to interpret a naive due_at (one with no offset).',
      },
      project_id: {
        type: 'string',
        description: 'Optional id of the project this task belongs to (from lykn_listProjects / lykn_getProjectState). If omitted, the task is filed under the user\'s currently active/focused project when there is one; pass an explicit id to override that.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const title = String(args?.title || '').trim().slice(0, TITLE_MAX);
    if (!title) return errorContent('title is required — what should I add to your list?');

    const tzHint = typeof args?.timezone === 'string' ? args.timezone.trim() : '';

    // Resolve the OPTIONAL due date from at most one of due_at / in_minutes.
    let dueAt = null;
    const hasInMinutes = args?.in_minutes !== undefined && args?.in_minutes !== null && args?.in_minutes !== '';
    const hasDueAt = typeof args?.due_at === 'string' && args.due_at.trim();
    if (hasDueAt) {
      const parsed = resolveInstant(args.due_at, tzHint);
      if (!parsed) {
        return errorContent('due_at is not a valid ISO 8601 timestamp. Use e.g. "2026-06-12T17:00:00-06:00", pass in_minutes instead, or omit the due date.');
      }
      dueAt = parsed;
    } else if (hasInMinutes) {
      const mins = Number.parseInt(args.in_minutes, 10);
      if (!Number.isFinite(mins) || mins < 1) {
        return errorContent('in_minutes must be a positive integer number of minutes from now.');
      }
      if (mins > MAX_IN_MINUTES) {
        return errorContent('in_minutes is too far in the future (max ~2 years). Pass an absolute due_at for distant dates.');
      }
      dueAt = new Date(Date.now() + mins * 60_000);
    }

    const notes = typeof args?.notes === 'string' ? args.notes.trim().slice(0, NOTES_MAX) : '';
    const dueAtText = typeof args?.due_at_text === 'string'
      ? args.due_at_text.trim().slice(0, TEXT_MAX)
      : '';
    const priority = PRIORITIES.includes(args?.priority) ? args.priority : 'normal';

    // Resolve which project this task is filed under. An explicit, writable
    // project_id wins; otherwise fall back to the chat's scoped project
    // (custom-model bound / board scope) and finally the user's ACTIVE
    // project — so a task created from the overlay / voice / chat shows up on
    // the focused project's workspace instead of landing unfiled. Mirrors
    // lykn_createStewardItem so all "add to my project" writes resolve alike.
    const explicitProjectId = typeof args?.project_id === 'string' && args.project_id.trim()
      ? args.project_id.trim()
      : null;
    const { project: targetProject } = await resolveWriteProjectTarget(ctx, explicitProjectId);
    const projectId = targetProject?.id || null;

    const source = `lykn-chat-agent:${ctx.attribSurface || 'lykn-chat'}`.slice(0, 64);

    const row = {
      user_id: ctx.userId,
      title,
      notes: notes || null,
      priority,
      due_at: dueAt ? dueAt.toISOString() : null,
      due_at_text: dueAtText || null,
      project_id: projectId,
      source,
    };

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_todos')
      .insert(row)
      .select('id, title, notes, status, priority, due_at, due_at_text, project_id, created_at')
      .single();
    if (error) {
      console.warn('[mcp:createTodo]', error.message);
      return errorContent(`todo insert failed: ${error.message}`);
    }

    const whenSpoken = dueAtText
      ? ` (due ${dueAtText})`
      : dueAt
        ? ` (due ${data.due_at})`
        : '';
    const projectSpoken = targetProject?.name ? ` on "${targetProject.name}"` : '';
    return jsonContent({
      ok: true,
      message: `Added to your to-do list${projectSpoken}: "${title}"${whenSpoken}.`,
      todo: data,
      project: targetProject ? { id: targetProject.id, name: targetProject.name } : null,
    });
  },
};
