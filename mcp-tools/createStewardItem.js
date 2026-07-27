// ============================================================================
// mcp-tools/createStewardItem.js — add work to the Night Shift queue
// ============================================================================

import { jsonContent, errorContent, requireWrite } from './index.js';
import { resolveProjectPushClient, resolveWriteProjectTarget } from '../lib/projectWriteTarget.js';

const TITLE_MAX = 280;

export const createStewardItemTool = {
  name: 'lykn_createStewardItem',
  title: 'Queue overnight project work (Night Shift backlog)',
  scope: 'write',
  description: [
    'Add a vague project idea to the Night Shift steward queue (backlog).',
    'Overnight, Night Shift expands it into a concrete spec (ready) for the',
    'user to approve and schedule.',
    '',
    'WHEN TO CALL:',
    '  • User says "look into X tonight", "work on Y while I sleep",',
    '    "add to my project queue", or drops a multi-step idea for later.',
    '  • NOT for immediate tasks — use lykn_createTodo for those.',
    '',
    'Requires night_shift_enabled on the user account (Settings → Privacy).',
    'Confirm the one-line title with the user when ambiguous.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short description of the work (<=280 chars).',
      },
      project_id: {
        type: 'string',
        description: 'Optional project UUID. Omit for active project.',
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

    const title = String(args.title || '').trim().slice(0, TITLE_MAX);
    if (!title) return errorContent('title is required.');

    const { project, reason } = await resolveWriteProjectTarget(ctx, args.project_id || null);
    if (!project) {
      return errorContent(reason === 'no_active_project'
        ? 'No active project — call lykn_setActiveProject or pass project_id.'
        : 'Project not writable.');
    }

    const clientKind = resolveProjectPushClient(ctx);
    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_steward_items')
      .insert({
        user_id: ctx.userId,
        project_id: project.id,
        title,
        status: 'backlog',
        source: clientKind,
      })
      .select('id, title, status, project_id, created_at')
      .single();
    if (error) return errorContent(`steward insert failed: ${error.message}`);

    return jsonContent({
      ok: true,
      item: data,
      project: { id: project.id, name: project.name },
      message: `Queued "${title}" on Night Shift backlog for "${project.name}".`,
    });
  },
};
