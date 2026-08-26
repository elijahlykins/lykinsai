// ============================================================================
// mcp-tools/resolveProject.js — pick the best project for this conversation
// ============================================================================
// Read-only. Scores the user's active projects (main + branches) against a
// topic string so agents can focus the right project without paraphrasing
// names into duplicates. Projects are user-created only — this tool never
// inserts rows.

import { resolveRelevantProjects } from '../lib/projectResolver.js';
import { loadProjectContextById } from '../lib/projectContext.js';

function jsonContent(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorContent(msg) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }, null, 2) }],
    isError: true,
  };
}

export const resolveProjectTool = {
  name: 'lykn_resolveProject',
  title: 'Find the most relevant project for this conversation topic',
  scope: 'read',
  description: [
    'Score the user\'s active projects (main + branches) against a topic',
    'string and return the best match plus ranked candidates.',
    '',
    'CALL THIS when:',
    '  • The user mentions work but you\'re not sure which project fits',
    '  • lykn_getProjectState returned project=null (no focus set yet)',
    '  • The topic might belong to a branch, not the current focus',
    '',
    'GitHub-style model:',
    '  • Main projects = user-created containers (parent_project_id is null)',
    '  • Branches = exploratory threads under a main',
    '  • Only the USER creates projects in LYKN synthesis UI',
    '  • Any agent may read/update any project by id',
    '',
    'After resolving, call lykn_setActiveProject({ project_id }) with the',
    'best match, then lykn_getProjectState / lykn_pushProjectState as needed.',
    'NEVER pass create:true — AI agents cannot create projects.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Topic, user message, or keywords to match against project names/descriptions.',
      },
      include_state_preview: {
        type: 'boolean',
        description: 'If true, attach a compact state preview for the best match. Defaults to false.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Max candidates to return. Defaults to 8.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const query = String(args?.query || '').trim();
    const includePreview = Boolean(args?.include_state_preview);
    const limit = args?.limit;

    const resolved = await resolveRelevantProjects(ctx.supabaseAdmin, ctx.userId, {
      query,
      limit,
    });

    let statePreview = null;
    if (includePreview && resolved.best?.id) {
      const full = await loadProjectContextById(ctx.supabaseAdmin, ctx.userId, resolved.best.id);
      if (full?.state) {
        statePreview = Object.fromEntries(
          Object.entries(full.state)
            .slice(0, 12)
            .map(([k, v]) => [k, { value: v.value, set_at: v.set_at, set_by_client: v.set_by_client }]),
        );
      }
    }

    return jsonContent({
      ok: true,
      active_project_id: resolved.activeProjectId,
      best_match: resolved.best,
      candidates: resolved.candidates,
      ...(statePreview ? { state_preview: statePreview } : {}),
      message: resolved.best
        ? `Best match: "${resolved.best.name}" (score=${resolved.best.relevance_score}). Call lykn_setActiveProject({ project_id: "${resolved.best.id}" }) to focus it.`
        : 'No active projects found. Ask the user to create one in the LYKN Projects (+ → Create project).',
    });
  },
};
