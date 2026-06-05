// ============================================================================
// lib/projectWriteTarget.js — where AI/chat project writes should land
// ============================================================================
// Resolution order (when tool omits project_id):
//   1. ctx.boundProjectId  — custom model linked_project_id
//   2. ctx.boardProjectId  — chat/board scope from req.body.projectId
//   3. active_project_id   — only if the row is user-created (created_by=user)
//
// Explicit project_id in tool args is always honoured first, but must pass
// isAiWritableProject() — legacy AI-spawned projects are read-only.

/**
 * @param {object|null|undefined} row — lykn_projects row (needs created_by, created_by_client)
 */
export function isAiWritableProject(row) {
  if (!row) return false;
  if (row.created_by === 'user') return true;
  if (row.created_by === 'agent') return false;
  // Pre-084 fallback: synthesis UI paths are user-owned; MCP inference is not.
  const client = row.created_by_client;
  if (!client || client === 'lykn-synthesis' || client === 'user') return true;
  return false;
}

/**
 * Load a project row and verify the AI may write to it.
 * @returns {Promise<object|null>}
 */
export async function loadWritableProject(supabaseAdmin, userId, projectId) {
  if (!supabaseAdmin || !userId || !projectId) return null;
  const { data, error } = await supabaseAdmin
    .from('lykn_projects')
    .select('id, name, status, created_by, created_by_client, description, last_active_at')
    .eq('user_id', userId)
    .eq('id', projectId)
    .maybeSingle();
  if (error || !data) return null;
  if (!isAiWritableProject(data)) return null;
  return data;
}

/**
 * Resolve which project a write tool should target.
 * @returns {Promise<{ project: object|null, resolvedBy: string|null, reason?: string }>}
 */
export async function resolveWriteProjectTarget(ctx, explicitProjectId = null) {
  if (!ctx?.supabaseAdmin || !ctx?.userId) {
    return { project: null, resolvedBy: null, reason: 'unauthorized' };
  }

  const explicit = explicitProjectId ? String(explicitProjectId).trim() : '';
  if (explicit) {
    const project = await loadWritableProject(ctx.supabaseAdmin, ctx.userId, explicit);
    if (!project) {
      return {
        project: null,
        resolvedBy: null,
        reason: 'project_not_found_or_not_writable',
      };
    }
    return { project, resolvedBy: 'project_id' };
  }

  const bound = ctx.boundProjectId ? String(ctx.boundProjectId).trim() : '';
  if (bound) {
    const project = await loadWritableProject(ctx.supabaseAdmin, ctx.userId, bound);
    if (project) return { project, resolvedBy: 'bound_project' };
  }

  const board = ctx.boardProjectId ? String(ctx.boardProjectId).trim() : '';
  if (board) {
    const project = await loadWritableProject(ctx.supabaseAdmin, ctx.userId, board);
    if (project) return { project, resolvedBy: 'board_project' };
  }

  const { data: profile, error: profileErr } = await ctx.supabaseAdmin
    .from('lykn_user_synthesis_profile')
    .select('active_project_id')
    .eq('user_id', ctx.userId)
    .maybeSingle();
  if (profileErr) {
    return { project: null, resolvedBy: null, reason: 'profile_lookup_failed' };
  }

  const activeId = profile?.active_project_id || null;
  if (activeId) {
    const project = await loadWritableProject(ctx.supabaseAdmin, ctx.userId, activeId);
    if (project) return { project, resolvedBy: 'active_project' };
  }

  return { project: null, resolvedBy: null, reason: 'no_writable_project' };
}

/** Stamp synthesis profile focus to a user-owned project (custom model bind). */
export async function stampActiveProject(supabaseAdmin, userId, projectId) {
  if (!supabaseAdmin || !userId || !projectId) return;
  const project = await loadWritableProject(supabaseAdmin, userId, projectId);
  if (!project) return;
  await supabaseAdmin
    .from('lykn_user_synthesis_profile')
    .upsert(
      {
        user_id: userId,
        active_project_id: project.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .then(() => {}, () => {});
}

export function formatBoundProjectGuidance(project) {
  if (!project?.id) return '';
  return [
    '[BOUND_PROJECT — mandatory write target]',
    `This chat is scoped to project_id="${project.id}" (${project.name || 'project'}).`,
    'ALL lykn_pushProjectState and lykn_addProjectNeurons calls MUST include',
    `project_id="${project.id}" (or omit project_id only when this bound id is set in context).`,
    'Do NOT write to legacy or AI-inferred projects. Do NOT call lykn_setActiveProject',
    'to switch projects unless the user explicitly asks.',
  ].join('\n');
}
