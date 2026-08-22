// ============================================================================
// mcp-tools/updateTodo.js — complete / reopen / reprioritise / edit a to-do
// ============================================================================
// Write. One tool covers every mutation a user voices after a to-do exists:
//   • "mark that done" / "I did that"  → status: 'completed'
//   • "drop that / never mind"          → status: 'cancelled'
//   • "reopen that"                     → status: 'open'
//   • "make that high priority"         → priority
//   • "give it a deadline of Friday"    → due_at / in_minutes (+ due_at_text)
//   • "change it to …"                  → title / notes
// The to-do id comes from lykn_listTodos. At least one mutation must be
// supplied. Scoped to the caller's own rows (handler filters on user_id; RLS
// enforces it again under JWT).

import { jsonContent, errorContent } from './index.js';
import { resolveInstant } from './_time.js';

const TITLE_MAX = 280;
const NOTES_MAX = 4000;
const TEXT_MAX = 200;
const MAX_IN_MINUTES = 60 * 24 * 366 * 2;
const PRIORITIES = ['low', 'normal', 'high'];

export const updateTodoTool = {
  name: 'lykn_updateTodo',
  title: 'Complete, reopen, reprioritise, or edit a to-do',
  scope: 'write',
  description: [
    'Update an existing to-do. Get its id from lykn_listTodos first, then call',
    'this to:',
    '  • mark it done       → status: "completed"',
    '  • cancel/drop it     → status: "cancelled"',
    '  • reopen it          → status: "open"',
    '  • change priority    → priority: "high" | "normal" | "low"',
    '  • set/change a due   → due_at (ISO 8601 + tz) OR in_minutes (relative),',
    '                         plus due_at_text with the user\'s phrasing',
    '  • clear the due date → clear_due: true',
    '  • change the text    → title and/or notes',
    '  • file under project → project_id (from lykn_listProjects), or',
    '                         clear_project: true to unassign',
    '',
    'Supply the id plus at least one field to change. Confirm what changed in',
    'plain language afterwards.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The to-do id (from lykn_listTodos).',
      },
      status: {
        type: 'string',
        enum: ['open', 'completed', 'cancelled'],
        description: 'Set "completed" when done, "cancelled" to drop it, "open" to reopen a closed task.',
      },
      priority: {
        type: 'string',
        enum: PRIORITIES,
        description: 'New priority: "high", "normal", or "low".',
      },
      due_at: {
        type: 'string',
        description: 'Set/replace the due date with this absolute ISO 8601 instant WITH timezone offset.',
      },
      in_minutes: {
        type: 'integer',
        minimum: 1,
        description: 'Set/replace the due date to this many minutes from now (relative). Provide this OR due_at.',
      },
      due_at_text: {
        type: 'string',
        description: 'Updated human phrasing of the deadline, read back verbatim. <=200 chars.',
      },
      clear_due: {
        type: 'boolean',
        description: 'When true, remove the due date entirely (turns it into an undated task).',
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone used to interpret a naive due_at (one with no offset).',
      },
      title: {
        type: 'string',
        description: 'New task text (<=280 chars).',
      },
      notes: {
        type: 'string',
        description: 'New detail/context (<=4000 chars). Pass an empty string to clear it.',
      },
      project_id: {
        type: 'string',
        description: 'Assign this task to a project (UUID from lykn_listProjects). Use when the user says "put that on my <project> list" or "tag it to <project>".',
      },
      clear_project: {
        type: 'boolean',
        description: 'When true, unassign the task from any project.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const id = String(args?.id || '').trim();
    if (!id) return errorContent('id is required — call lykn_listTodos to find the task first.');

    const patch = {};
    const tzHint = typeof args?.timezone === 'string' ? args.timezone.trim() : '';

    // Due date: clear wins, else set from one of due_at / in_minutes.
    if (args?.clear_due === true) {
      patch.due_at = null;
      patch.due_at_text = null;
    } else {
      const hasInMinutes = args?.in_minutes !== undefined && args?.in_minutes !== null && args?.in_minutes !== '';
      const hasDueAt = typeof args?.due_at === 'string' && args.due_at.trim();
      if (hasDueAt) {
        const parsed = resolveInstant(args.due_at, tzHint);
        if (!parsed) {
          return errorContent('due_at is not a valid ISO 8601 timestamp.');
        }
        patch.due_at = parsed.toISOString();
      } else if (hasInMinutes) {
        const mins = Number.parseInt(args.in_minutes, 10);
        if (!Number.isFinite(mins) || mins < 1) {
          return errorContent('in_minutes must be a positive integer number of minutes from now.');
        }
        if (mins > MAX_IN_MINUTES) {
          return errorContent('in_minutes is too far in the future (max ~2 years).');
        }
        patch.due_at = new Date(Date.now() + mins * 60_000).toISOString();
      }
    }

    if (typeof args?.due_at_text === 'string') {
      patch.due_at_text = args.due_at_text.trim().slice(0, TEXT_MAX) || null;
    }

    if (PRIORITIES.includes(args?.priority)) {
      patch.priority = args.priority;
    }

    if (typeof args?.title === 'string') {
      const t = args.title.trim().slice(0, TITLE_MAX);
      if (!t) return errorContent('title cannot be blank.');
      patch.title = t;
    }

    if (typeof args?.notes === 'string') {
      patch.notes = args.notes.trim().slice(0, NOTES_MAX) || null;
    }

    // Project assignment: clear wins, else set from a passed project_id.
    if (args?.clear_project === true) {
      patch.project_id = null;
    } else if (typeof args?.project_id === 'string' && args.project_id.trim()) {
      patch.project_id = args.project_id.trim();
    }

    if (['open', 'completed', 'cancelled'].includes(args?.status)) {
      patch.status = args.status;
      patch.completed_at = args.status === 'completed' ? new Date().toISOString() : null;
    }

    if (Object.keys(patch).length === 0) {
      return errorContent('Nothing to update — pass a status, priority, due date (due_at/in_minutes/clear_due), project_id/clear_project, or new title/notes.');
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_todos')
      .update(patch)
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, title, notes, status, priority, due_at, due_at_text, project_id, completed_at, updated_at')
      .maybeSingle();

    if (error) {
      console.warn('[mcp:updateTodo]', error.message);
      return errorContent(`todo update failed: ${error.message}`);
    }
    if (!data) {
      return errorContent('No to-do found with that id (it may not exist or not belong to you).');
    }

    const verb = data.status === 'completed'
      ? 'marked done'
      : data.status === 'cancelled'
        ? 'dropped'
        : 'updated';

    return jsonContent({
      ok: true,
      message: `To-do "${data.title}" ${verb}.`,
      todo: data,
    });
  },
};
