// ============================================================================
// mcp-tools/updateProject.js — rename / re-describe / archive a project
// ============================================================================
// Write. Edit metadata on an existing project — the other half of the
// project lifecycle that lykn_setActiveProject doesn't cover. Sister
// to lykn_setActiveProject, but does NOT change which project is
// active; this is purely a metadata edit.
//
// What this can change:
//   • name + name_key   (rename — collisions with other projects of the
//                        same user are reported back so the model can
//                        fall back to merging via setActiveProject)
//   • description       (one-sentence summary, ≤320 chars)
//   • status            ('active' | 'archived')
//
// What it deliberately can't do (kept on the lykn_setActiveProject /
// lykn_pushProjectState surfaces so each tool has one job):
//   • Mark a project active (setActiveProject)
//   • Push working memory kv-state (pushProjectState)
//   • Mutate clustered neurons (addProjectNeurons / removeProjectNeurons)
//   • Delete the project (deleteProject)
//
// Strict on project_id: bad/foreign id is a hard `project_not_found`
// rather than a fuzzy fallback. The model should always have called
// lykn_listProjects first to pick the right id.

import { jsonContent, errorContent } from './index.js';

const NAME_MAX = 120;
const DESC_MAX = 320;

function normaliseNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

export const updateProjectTool = {
  name: 'lykn_updateProject',
  title: 'Edit a project\'s name, description, or status',
  scope: 'write',
  description: [
    'CALL THIS to edit metadata on an EXISTING project — rename it,',
    'rewrite its description, or archive/unarchive it. This does NOT',
    'change which project is active (use lykn_setActiveProject for that)',
    'and does NOT push working memory (use lykn_pushProjectState).',
    '',
    'Discover the project id with lykn_listProjects first. Pass at least',
    'one of name / description / status — the rest stay untouched.',
    '',
    'Renames check the user\'s other projects for a name_key collision',
    '(case-insensitive, whitespace-collapsed). On collision the call',
    'returns ok:false with reason="name_conflict" and the conflicting',
    'project id, so the model can either pick a different name or',
    'merge into the existing project via lykn_setActiveProject.',
    '',
    'Archive (status="archived") hides the project from the default',
    'lykn_listProjects view but does NOT delete its state or clustered',
    'neurons. Re-activate by calling this tool with status="active",',
    'or simply call lykn_setActiveProject({ project_id }) which auto-',
    'reactivates archived projects when resumed.',
    '',
    'When NOT to call:',
    '  • To start tracking new project work — call lykn_setActiveProject',
    '    with create:true instead.',
    '  • To capture a decision or blocker — call lykn_pushProjectState.',
    '  • To remove a project entirely — call lykn_deleteProject.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'UUID of the project to edit (from lykn_listProjects). Required.',
      },
      name: {
        type: 'string',
        description: 'New display name (3–8 words, ≤120 chars). Optional.',
      },
      description: {
        type: 'string',
        description: 'New one-sentence description (≤320 chars). Pass an empty string to clear it. Optional.',
      },
      status: {
        type: 'string',
        enum: ['active', 'archived'],
        description: 'Set to "archived" to hide from default lists; "active" to surface again. Optional.',
      },
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const projectId = String(args?.project_id || '').trim();
    if (!projectId) return errorContent('project_id is required.');

    const hasName = typeof args?.name === 'string' && args.name.trim().length > 0;
    const hasDescription = typeof args?.description === 'string';
    const hasStatus = args?.status === 'active' || args?.status === 'archived';

    if (!hasName && !hasDescription && !hasStatus) {
      return errorContent(
        'Pass at least one of name, description, or status. To set the active project use lykn_setActiveProject.',
      );
    }

    const { data: existing, error: findErr } = await ctx.supabaseAdmin
      .from('lykn_projects')
      .select('id, name, description, status, created_by_client, created_at, last_active_at')
      .eq('user_id', ctx.userId)
      .eq('id', projectId)
      .maybeSingle();
    if (findErr) {
      return errorContent(`project lookup failed: ${findErr.message}`);
    }
    if (!existing) {
      return jsonContent({
        ok: false,
        reason: 'project_not_found',
        message: 'That project_id is not in the user\'s project list. Call lykn_listProjects to discover the right id.',
      });
    }

    const patch = { updated_at: new Date().toISOString() };

    if (hasName) {
      const newName = args.name.trim().slice(0, NAME_MAX);
      const newKey = normaliseNameKey(newName);
      if (!newKey) return errorContent('name must contain visible characters.');

      // Collision check — same user, different project, same name_key.
      // The unique constraint would surface this as a 23505 anyway, but
      // we'd rather give the model a structured error it can reason
      // about than a Postgres error string.
      const { data: collision } = await ctx.supabaseAdmin
        .from('lykn_projects')
        .select('id, name')
        .eq('user_id', ctx.userId)
        .eq('name_key', newKey)
        .neq('id', projectId)
        .maybeSingle();
      if (collision) {
        return jsonContent({
          ok: false,
          reason: 'name_conflict',
          message:
            'Another project already uses that name. Pick a different name, or call lykn_setActiveProject with the existing project_id below to merge into it.',
          conflict_project: { id: collision.id, name: collision.name },
        });
      }

      patch.name = newName;
      patch.name_key = newKey;
    }

    if (hasDescription) {
      const trimmed = args.description.trim().slice(0, DESC_MAX);
      patch.description = trimmed || null;
    }

    if (hasStatus) {
      patch.status = args.status;
    }

    const { data: updated, error: updErr } = await ctx.supabaseAdmin
      .from('lykn_projects')
      .update(patch)
      .eq('id', projectId)
      .eq('user_id', ctx.userId)
      .select('id, name, description, status, created_by_client, created_at, last_active_at')
      .single();
    if (updErr) {
      return errorContent(`project update failed: ${updErr.message}`);
    }

    const changes = [];
    if (hasName && existing.name !== updated.name) changes.push(`renamed "${existing.name}" → "${updated.name}"`);
    if (hasDescription && (existing.description || '') !== (updated.description || '')) changes.push('description updated');
    if (hasStatus && existing.status !== updated.status) changes.push(`status ${existing.status} → ${updated.status}`);

    return jsonContent({
      ok: true,
      project: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        status: updated.status,
        created_by_client: updated.created_by_client,
        last_active_at: updated.last_active_at,
      },
      changes,
      message: changes.length
        ? `Project "${updated.name}" updated: ${changes.join('; ')}.`
        : `Project "${updated.name}" — no effective changes.`,
    });
  },
};
