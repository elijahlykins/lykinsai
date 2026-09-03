// ============================================================================
// mcp-tools/deleteProject.js — permanently remove a project + its membership
// ============================================================================
// Write. Hard delete on `lykn_projects`. The schema's foreign-key
// cascades clean up the related rows:
//   • lykn_project_state           — ON DELETE CASCADE
//   • lykn_project_neurons (063)   — ON DELETE CASCADE
//
// `lykn_user_preferences.active_project_id` references this row
// with ON DELETE SET NULL (per migration 045), so deleting the
// currently-active project leaves the user with no active project —
// the next conversation gets a `project=null` from
// lykn_getProjectState / lykn_listProjects, and the model is expected
// to call lykn_setActiveProject again to start a new working context.
//
// Confirmation guardrail:
//   The model MUST pass `confirm: true` AND a `name` matching the
//   project's current display name (case-insensitive). This is a
//   destructive operation that wipes user-grouped cluster membership
//   and AI-pushed working memory in one shot — every other surface in
//   the Projects workspace (rename, archive, remove neurons, supersede
//   state) is reversible, but this is not. The double-gate forces the
//   model to demonstrate it actually knows which project it's about
//   to remove rather than blindly forwarding a UUID it parsed out of
//   the user's last message.

import { jsonContent, errorContent } from './index.js';
import { deleteUserRowById, getUserRowById } from '../lib/security/userOwnedAccess.js';

function normaliseNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export const deleteProjectTool = {
  name: 'lykn_deleteProject',
  title: 'Permanently delete a project (and all its membership + state)',
  scope: 'write',
  description: [
    'CALL THIS only when the user has explicitly asked to delete a',
    'project. This is the one IRREVERSIBLE write in the project tier:',
    'it cascades into project membership and',
    '`lykn_project_state` (AI-pushed working memory). The user\'s',
    'active project pointer is cleared if it was pointing here.',
    '',
    'For ANY other intent prefer a reversible tool:',
    '  • To stop showing it in the default project list →',
    '    lykn_updateProject({ project_id, status: "archived" })',
    '  • To rename it → lykn_updateProject({ project_id, name: "..." })',
    '  • To switch to a different active project →',
    '    lykn_setActiveProject({ project_id })',
    '',
    'CONFIRMATION GUARDRAIL — both required:',
    '  • confirm: true',
    '  • name: the project\'s CURRENT display name (case-insensitive,',
    '    whitespace-collapsed). Mismatch returns ok:false with the',
    '    actual name, so the model can re-confirm with the user.',
    '',
    'Discover the id + canonical name with lykn_listProjects first.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'UUID of the project to delete (from lykn_listProjects). Required.',
      },
      name: {
        type: 'string',
        description: 'The project\'s current display name. Must match (case-insensitive, whitespace-collapsed). Guardrail against deleting the wrong project from a stale id.',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Explicit opt-in required because the operation is irreversible.',
      },
    },
    required: ['project_id', 'name', 'confirm'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const projectId = String(args?.project_id || '').trim();
    if (!projectId) return errorContent('project_id is required.');

    if (args?.confirm !== true) {
      return jsonContent({
        ok: false,
        reason: 'confirmation_missing',
        message: 'Pass `confirm: true` AND the project\'s current `name` to delete. This is irreversible.',
      });
    }

    const passedName = typeof args?.name === 'string' ? args.name : '';
    const passedKey = normaliseNameKey(passedName);
    if (!passedKey) return errorContent('name is required for the delete confirmation.');

    const { data: existing, error: findErr } = await getUserRowById(
      ctx.supabaseAdmin,
      'lykn_projects',
      ctx.userId,
      projectId,
      'id, name, name_key, status',
    );
    if (findErr) {
      return errorContent(`project lookup failed: ${findErr.message}`);
    }
    if (!existing) {
      return jsonContent({
        ok: false,
        reason: 'project_not_found',
        message: 'That project_id is not in the user\'s project list. Already deleted, or wrong id.',
      });
    }

    if (existing.name_key !== passedKey) {
      return jsonContent({
        ok: false,
        reason: 'name_mismatch',
        message: 'The name you passed does not match the project\'s current name. Re-confirm with the user before retrying.',
        actual_name: existing.name,
      });
    }

    const { error: delErr, deleted } = await deleteUserRowById(
      ctx.supabaseAdmin,
      'lykn_projects',
      ctx.userId,
      projectId,
    );
    if (delErr) {
      return errorContent(`project delete failed: ${delErr.message}`);
    }
    if (!deleted) {
      return jsonContent({
        ok: false,
        reason: 'project_not_found',
        message: 'That project_id is not in the user\'s project list. Already deleted, or wrong id.',
      });
    }

    return jsonContent({
      ok: true,
      deleted: { id: existing.id, name: existing.name },
      message: `Project "${existing.name}" deleted along with its clustered neurons and pushed state.`,
    });
  },
};
