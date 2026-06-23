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
import { resolveRelevantProjects } from './projectResolver.js';

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
 * Is `userId` an owner/editor MEMBER of a project they don't own outright?
 * Collaboration (109/110): editors can have the AI write shared project state.
 * supabaseAdmin bypasses RLS, so we verify membership explicitly here.
 * @returns {Promise<boolean>}
 */
async function isProjectEditorMember(supabaseAdmin, userId, projectId) {
  if (!supabaseAdmin || !userId || !projectId) return false;
  const { data } = await supabaseAdmin
    .from('lykn_project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .not('accepted_at', 'is', null)
    .maybeSingle();
  return data?.role === 'owner' || data?.role === 'editor';
}

/**
 * Load a project row and verify the AI may write to it. The caller must either
 * own the project (user_id match) or be an accepted owner/editor member of a
 * project shared with them (110), and the project must be AI-writable.
 * @returns {Promise<object|null>}
 */
export async function loadWritableProject(supabaseAdmin, userId, projectId) {
  if (!supabaseAdmin || !userId || !projectId) return null;
  const { data, error } = await supabaseAdmin
    .from('lykn_projects')
    .select('id, name, status, created_by, created_by_client, description, last_active_at, user_id')
    .eq('id', projectId)
    .maybeSingle();
  if (error || !data) return null;
  // Access: owner outright, or an editor/owner member of a shared project.
  if (data.user_id !== userId) {
    const canEdit = await isProjectEditorMember(supabaseAdmin, userId, projectId);
    if (!canEdit) return null;
  }
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

function normaliseProjectNameKeyForLookup(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Resolve a writable target project from a user-supplied name OR an explicit
 * id, falling back to the active/scoped/bound project. Shared by the in-app
 * chat tool (lykn_uploadToProject) and the voice dispatch (add_to_project) so
 * "add this to my <project>" resolves identically on both surfaces.
 *
 * @returns {Promise<{ project: object|null, reason?: string }>}
 */
export async function resolveProjectByNameOrId(ctx, { projectId, projectName } = {}) {
  if (!ctx?.supabaseAdmin || !ctx?.userId) {
    return { project: null, reason: 'unauthorized' };
  }

  const id = projectId ? String(projectId).trim() : '';
  if (id) {
    const { project, reason } = await resolveWriteProjectTarget(ctx, id);
    return { project, reason };
  }

  const name = projectName ? String(projectName).trim() : '';
  if (name) {
    const nameKey = normaliseProjectNameKeyForLookup(name);
    if (nameKey) {
      const { data: exact } = await ctx.supabaseAdmin
        .from('lykn_projects')
        .select('id')
        .eq('user_id', ctx.userId)
        .eq('name_key', nameKey)
        .eq('created_by', 'user')
        .maybeSingle();
      if (exact?.id) {
        const project = await loadWritableProject(ctx.supabaseAdmin, ctx.userId, exact.id);
        if (project) return { project };
      }
    }
    // No exact match — score by relevance so a paraphrased name still lands.
    const resolved = await resolveRelevantProjects(ctx.supabaseAdmin, ctx.userId, {
      query: name,
      limit: 1,
    });
    if (resolved.best?.id) {
      const project = await loadWritableProject(ctx.supabaseAdmin, ctx.userId, resolved.best.id);
      if (project) return { project };
    }
    return { project: null, reason: 'project_name_not_found' };
  }

  const { project, reason } = await resolveWriteProjectTarget(ctx, null);
  return { project, reason };
}

// ============================================================================
// User-authorized project creation (in-product assistant only)
// ============================================================================
// The MCP `lykn_setActiveProject` tool deliberately blocks AI-driven creation
// so external clients (Claude/Cursor/etc.) can't spawn duplicate blank
// projects on a paraphrased name. The IN-PRODUCT LYKN assistant (chat + voice)
// is different: it creates a project ONLY after the user explicitly agrees to
// the assistant's suggestion, so the user is the real author. We record it
// exactly like a synthesis-UI creation (created_by='user',
// created_by_client='lykn-synthesis') so it shows on the Projects page and is
// writable by the AI, and we dedupe on name_key so "yes, start that" twice
// can't fork the same project. This helper is intentionally NOT wired into the
// external MCP surface — only the in-product chat tool + voice dispatch call it.

const PROJECT_NAME_MAX = 120;
const PROJECT_DESC_MAX = 320;

function normaliseProjectNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROJECT_NAME_MAX);
}

/**
 * Create (or reactivate, on a name-key match) a user-authorized project and
 * focus it. Returns { ok, was_created, project } or { ok:false, error }.
 *
 * @param {string} [args.client] — created_by_client trace; defaults to the
 *   canonical user-owned value so provenance stays "user" everywhere.
 */
export async function createUserAuthorizedProject(supabaseAdmin, userId, args = {}) {
  if (!supabaseAdmin || !userId) return { ok: false, error: 'unauthorized' };

  const name = String(args.name || '').trim().slice(0, PROJECT_NAME_MAX);
  if (!name) return { ok: false, error: 'name_required' };
  const description = args.description
    ? String(args.description).trim().slice(0, PROJECT_DESC_MAX)
    : null;
  // Keep provenance unambiguously user-owned (matches the synthesis UI). The
  // assistant is the scribe; the user authorized the creation.
  const client = String(args.client || 'lykn-synthesis').slice(0, 60) || 'lykn-synthesis';
  const nameKey = normaliseProjectNameKey(name);
  if (!nameKey) return { ok: false, error: 'name_required' };

  // Reuse an existing user project with the same normalized name instead of
  // forking a duplicate.
  const { data: existing, error: findErr } = await supabaseAdmin
    .from('lykn_projects')
    .select('id, name, description, status, created_at, last_active_at')
    .eq('user_id', userId)
    .eq('name_key', nameKey)
    .eq('created_by', 'user')
    .maybeSingle();
  if (findErr) return { ok: false, error: `lookup_failed: ${findErr.message}` };

  if (existing) {
    const patch = {
      last_active_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (description && !existing.description) patch.description = description;
    if (existing.status === 'archived') patch.status = 'active';
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('lykn_projects')
      .update(patch)
      .eq('id', existing.id)
      .select('id, name, description, status, created_at, last_active_at')
      .single();
    if (updErr) return { ok: false, error: `update_failed: ${updErr.message}` };
    await stampActiveProject(supabaseAdmin, userId, updated.id);
    return { ok: true, was_created: false, project: updated };
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('lykn_projects')
    .insert({
      user_id: userId,
      name,
      name_key: nameKey,
      description,
      status: 'active',
      created_by: 'user',
      created_by_client: client,
      parent_project_id: args.parentProjectId || null,
      last_active_at: new Date().toISOString(),
    })
    .select('id, name, description, status, created_at, last_active_at')
    .single();
  if (insErr) return { ok: false, error: `insert_failed: ${insErr.message}` };

  await stampActiveProject(supabaseAdmin, userId, inserted.id);
  return { ok: true, was_created: true, project: inserted };
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
