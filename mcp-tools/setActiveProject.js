// ============================================================================
// mcp-tools/setActiveProject.js — name + activate the user's current project
// ============================================================================
// Write. Middle-tier synthesis: marks "the user is currently working on X"
// so that subsequent pushProjectState / getProjectState calls (and
// getContextBlock auto-inject) all bind to the same project.
//
// Two input modes:
//   1. `project_id` (preferred when known): activate an existing project by
//      id. Pair with lykn_listProjects to discover the id first. Strict —
//      a bad id returns project_not_found.
//   2. `name`: look up by normalised name_key (lowercase + whitespace-
//      collapse). If a project matches, reuse it (and unarchive if
//      archived). If nothing matches, behaviour depends on the `create`
//      flag (default false):
//        • create=false → return ok:false with reason='project_not_found'
//          and a `recent_projects` array so the model can re-call with
//          the right project_id.
//        • create=true → insert a new row. This is the only path that
//          creates projects, and it must be opt-in.
//
// Why `create` is opt-in:
// The Projects workspace used to silently create a project on any name miss,
// which meant AI clients across Claude/Cursor/Claude Code accidentally
// spawned blank duplicates whenever they paraphrased the project name.
// Strict-by-default forces the model to first discover what already
// exists (via lykn_listProjects) and only spawn new projects when the
// user has genuinely shifted to new work.

import { jsonContent, errorContent } from './index.js';
import { isAiWritableProject } from '../lib/projectWriteTarget.js';

const NAME_MAX = 120;
const DESC_MAX = 320;
const RECENT_HINT_LIMIT = 5;

function normaliseNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

async function recentProjectsForHint(ctx) {
  const { data } = await ctx.supabaseAdmin
    .from('lykn_projects')
    .select('id, name, description, status, created_by_client, last_active_at')
    .eq('user_id', ctx.userId)
    .eq('status', 'active')
    .eq('created_by', 'user')
    .order('last_active_at', { ascending: false })
    .limit(RECENT_HINT_LIMIT);
  return Array.isArray(data) ? data : [];
}

async function stampActive(ctx, projectId) {
  const { error } = await ctx.supabaseAdmin
    .from('lykn_user_preferences')
    .upsert(
      {
        user_id: ctx.userId,
        active_project_id: projectId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
  if (error) {
    console.warn('[mcp:setActiveProject] active link failed:', error.message);
  }
}

export const setActiveProjectTool = {
  name: 'lykn_setActiveProject',
  title: 'Set the user\'s currently active project',
  scope: 'write',
  description: [
    'CALL THIS when the user clearly shifts focus to a project the',
    'Projects workspace should track. Marks the project as the user\'s active',
    'working context, so subsequent lykn_pushProjectState pushes (and',
    'lykn_getContextBlock auto-injection in other AI clients) all bind to',
    'the same project.',
    '',
    'TWO MODES — pick the right one:',
    '  • RESUME existing project (preferred):',
    '      lykn_setActiveProject({ project_id: "<uuid from listProjects>" })',
    '    Call lykn_listProjects or lykn_resolveProject first to find the id.',
    '    This is how you avoid spawning duplicate projects when the user works',
    '    across multiple AI clients.',
    '',
    '  • PROJECT CREATION is USER-ONLY:',
    '    AI agents must NEVER create projects. If nothing matches, ask the user',
    '    to create a main project or branch in the LYKN Projects',
    '    (+ → Create project). Then lykn_setActiveProject({ project_id }).',
    '',
    'NAME-ONLY lookup (no create, no project_id):',
    '  lykn_setActiveProject({ name: "..." }) does a case-insensitive',
    '  whitespace-collapsed lookup. If a match exists it activates and',
    '  unarchives it; if not, you get project_not_found + recent_projects.',
    '  Use this to "switch back into" a project whose name you know but',
    '  whose id you don\'t.',
    '',
    'Idempotent: safe to call at the start of any conversation where the',
    'project is already obvious.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'UUID of an existing project (from lykn_listProjects). Preferred when known — resumes an existing project without risk of paraphrase-driven duplicates.',
      },
      name: {
        type: 'string',
        description: 'Short descriptive project name, 3–8 words. E.g. "LYKN MCP integration", "Q1 fundraising deck". Used for lookup, and (when create=true) for the new project\'s display name.',
      },
      description: {
        type: 'string',
        description: 'Optional one-sentence description (<=320 chars) summarising what the project is about.',
      },
      create: {
        type: 'boolean',
        description: 'IGNORED — project creation is user-only in LYKN. Always returns creation_not_allowed if true.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const projectIdArg = typeof args?.project_id === 'string' ? args.project_id.trim() : '';
    const rawName = typeof args?.name === 'string' ? args.name : '';
    const create = Boolean(args?.create);

    const description = args?.description
      ? String(args.description).trim().slice(0, DESC_MAX)
      : null;

    if (!projectIdArg && !rawName.trim()) {
      return errorContent('Pass either project_id (preferred — call lykn_listProjects to find it) or name.');
    }

    const clientKind = 'lykn-chat';

    // -------------------------------------------------------------------
    // Mode 1: project_id lookup. Strict — bad id is a hard error so the
    // model can\'t silently fall through into the create path.
    // -------------------------------------------------------------------
    if (projectIdArg) {
      const { data: byId, error: byIdErr } = await ctx.supabaseAdmin
        .from('lykn_projects')
        .select('id, name, description, status, created_at, last_active_at, created_by_client, created_by')
        .eq('user_id', ctx.userId)
        .eq('id', projectIdArg)
        .maybeSingle();
      if (byIdErr) {
        return errorContent(`project lookup failed: ${byIdErr.message}`);
      }
      if (!byId) {
        const recent = await recentProjectsForHint(ctx);
        return jsonContent({
          ok: false,
          reason: 'project_not_found',
          message: 'That project_id is not in the user\'s project list. Call lykn_listProjects or lykn_resolveProject to see what exists.',
          recent_projects: recent,
        });
      }
      if (!isAiWritableProject(byId)) {
        const recent = await recentProjectsForHint(ctx);
        return jsonContent({
          ok: false,
          reason: 'legacy_project_not_writable',
          message:
            'That project was AI-inferred (legacy) and is read-only. Ask the user to create a project in the LYKN Projects, then activate it by project_id.',
          recent_projects: recent,
        });
      }

      const patch = {
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (description) patch.description = description;
      if (byId.status === 'archived') patch.status = 'active';

      const { data: updated, error: updErr } = await ctx.supabaseAdmin
        .from('lykn_projects')
        .update(patch)
        .eq('id', byId.id)
        .select('id, name, description, status, created_at, last_active_at, created_by_client')
        .single();
      if (updErr) {
        return errorContent(`project update failed: ${updErr.message}`);
      }

      await stampActive(ctx, updated.id);

      return jsonContent({
        ok: true,
        was_created: false,
        resolved_by: 'project_id',
        project: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          status: updated.status,
          created_by_client: updated.created_by_client,
          last_active_at: updated.last_active_at,
        },
        message: `Project "${updated.name}" reactivated and set as the current context.`,
      });
    }

    // -------------------------------------------------------------------
    // Mode 2: name lookup. Reuse on match. On miss, gate behind `create`.
    // -------------------------------------------------------------------
    const name = rawName.trim().slice(0, NAME_MAX);
    if (!name) return errorContent('name must contain visible characters.');
    const nameKey = normaliseNameKey(name);
    if (!nameKey) return errorContent('name must contain visible characters.');

    const { data: existing, error: findErr } = await ctx.supabaseAdmin
      .from('lykn_projects')
      .select('id, name, description, status, created_at, last_active_at, created_by_client, created_by')
      .eq('user_id', ctx.userId)
      .eq('name_key', nameKey)
      .eq('created_by', 'user')
      .maybeSingle();
    if (findErr) {
      return errorContent(`project lookup failed: ${findErr.message}`);
    }

    if (existing) {
      const patch = {
        last_active_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      // Only overwrite description if the caller passed one — don't blow
      // away the user's edits because Claude felt like restating it.
      if (description) patch.description = description;
      if (existing.status === 'archived') patch.status = 'active';

      const { data: updated, error: updErr } = await ctx.supabaseAdmin
        .from('lykn_projects')
        .update(patch)
        .eq('id', existing.id)
        .select('id, name, description, status, created_at, last_active_at, created_by_client')
        .single();
      if (updErr) {
        return errorContent(`project update failed: ${updErr.message}`);
      }

      await stampActive(ctx, updated.id);

      return jsonContent({
        ok: true,
        was_created: false,
        resolved_by: 'name_match',
        project: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          status: updated.status,
          created_by_client: updated.created_by_client,
          last_active_at: updated.last_active_at,
        },
        message: `Project "${updated.name}" reactivated and set as the current context.`,
      });
    }

    if (!create) {
      const recent = await recentProjectsForHint(ctx);
      return jsonContent({
        ok: false,
        reason: 'project_not_found',
        message: `No project matches "${name}". Projects are user-created only — ask the user to create one in the LYKN Projects, or call lykn_setActiveProject with a project_id from lykn_listProjects / lykn_resolveProject.`,
        searched_name: name,
        recent_projects: recent,
      });
    }

    const recent = await recentProjectsForHint(ctx);
    return jsonContent({
      ok: false,
      reason: 'creation_not_allowed',
      message: 'Projects are user-created only in the LYKN Projects (+ → Create project). AI agents may read and update any existing project but cannot create new ones. Ask the user to create a main project or branch, then call lykn_setActiveProject({ project_id }).',
      recent_projects: recent,
    });
  },
};
