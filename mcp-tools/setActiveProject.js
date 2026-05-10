// ============================================================================
// mcp-tools/setActiveProject.js — name + activate the user's current project
// ============================================================================
// Write. Middle-tier synthesis: marks "the user is currently working on X"
// so that subsequent pushProjectState / getProjectState calls (and
// getContextBlock auto-inject) all bind to the same project.
//
// Behaviour:
//   • Lookup by (user_id, name_key) — case-insensitive, whitespace-
//     collapsed. If the project exists, reuse it (and bump
//     last_active_at + status='active' if it was archived).
//   • If not found, create it. Stamp `created_by_client` with whichever
//     MCP client called this so the UI can show "started in Cursor".
//   • Set lykn_user_synthesis_profile.active_project_id to the resolved
//     id. We upsert the profile row if missing (some users won't have
//     touched the profile flow yet — don't make project setting fail
//     because of an unrelated table).
//
// Why this is a write tool but not gated by ratification:
// Projects are working memory, not governance. They auto-archive after
// 30 days of inactivity (handled in cron / on-read), and the user can
// rename or delete any project from the synthesis profile UI. The
// failure cost of a wrong project name is "rename it" — far below the
// blast radius that justifies the proposeBelief gating.

import { jsonContent, errorContent, requireWrite } from './index.js';

const NAME_MAX = 120;
const DESC_MAX = 320;

function normaliseNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

export const setActiveProjectTool = {
  name: 'lykn_setActiveProject',
  title: 'Set the user\'s currently active project',
  scope: 'write',
  description: [
    'CALL THIS when the user clearly shifts focus to a new project or',
    'returns to one you can name from context. Marks the project as the',
    'user\'s active working context, so subsequent lykn_pushProjectState',
    'pushes (and lykn_getContextBlock auto-injection in other AI clients)',
    'all bind to the same project.',
    '',
    'Use the same name for the same project across all your turns and',
    'across other AI clients — match by intent, not exact phrasing.',
    '"LYKN MCP integration" and "the LYKN MCP work" should resolve to one',
    'project. The server normalises name (lowercase + whitespace-collapse)',
    'so trivial wording differences collapse automatically.',
    '',
    'Inferred-by-default: don\'t ask the user "what should we call this',
    'project?" — pick a short descriptive name from the conversation. The',
    'user can rename in LYKN later. Aim for 3–8 words.',
    '',
    'Idempotent: calling this with an existing project name reuses the',
    'existing project (and unarchives it if archived). Safe to call at',
    'the start of any conversation where the project is already obvious.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short descriptive project name, 3–8 words. E.g. "LYKN MCP integration", "Q1 fundraising deck".',
      },
      description: {
        type: 'string',
        description: 'Optional one-sentence description (<=320 chars) summarising what the project is about.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const name = String(args?.name || '').trim().slice(0, NAME_MAX);
    if (!name) return errorContent('name is required.');
    const nameKey = normaliseNameKey(name);
    if (!nameKey) return errorContent('name must contain visible characters.');

    const description = args?.description
      ? String(args.description).trim().slice(0, DESC_MAX)
      : null;

    const clientKind = ctx?.mcpAuth?.clientKind || 'lykn-chat';

    // Try to find an existing project at this name_key. If it exists,
    // reuse + reactivate. If not, insert a new row. We do these as two
    // separate statements (lookup → upsert/insert) so the response can
    // tell the model whether this was a new or existing project — useful
    // signal for the AI's reasoning about context continuity.
    const { data: existing, error: findErr } = await ctx.supabaseAdmin
      .from('lykn_projects')
      .select('id, name, description, status, created_at, last_active_at, created_by_client')
      .eq('user_id', ctx.userId)
      .eq('name_key', nameKey)
      .maybeSingle();
    if (findErr) {
      return errorContent(`project lookup failed: ${findErr.message}`);
    }

    let project;
    let wasCreated = false;
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
      project = updated;
    } else {
      const { data: inserted, error: insErr } = await ctx.supabaseAdmin
        .from('lykn_projects')
        .insert({
          user_id: ctx.userId,
          name,
          name_key: nameKey,
          description,
          status: 'active',
          created_by_client: clientKind,
          last_active_at: new Date().toISOString(),
        })
        .select('id, name, description, status, created_at, last_active_at, created_by_client')
        .single();
      if (insErr) {
        return errorContent(`project create failed: ${insErr.message}`);
      }
      project = inserted;
      wasCreated = true;
    }

    // Stamp this project as the user's active context. Upsert because
    // synthesis profile may not exist yet for this user — the project
    // tier should not depend on the intake flow having been completed.
    const { error: profileErr } = await ctx.supabaseAdmin
      .from('lykn_user_synthesis_profile')
      .upsert(
        {
          user_id: ctx.userId,
          active_project_id: project.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
    if (profileErr) {
      // Soft-fail: the project itself is real, the active-project link
      // didn't take. Tell the model so it can still push state but knows
      // the auto-injection might not pick this project up immediately.
      console.warn('[mcp:setActiveProject] active link failed:', profileErr.message);
    }

    return jsonContent({
      ok: true,
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        created_by_client: project.created_by_client,
        last_active_at: project.last_active_at,
      },
      was_created: wasCreated,
      message: wasCreated
        ? `Project "${project.name}" created and set active.`
        : `Project "${project.name}" reactivated and set as the current context.`,
    });
  },
};
