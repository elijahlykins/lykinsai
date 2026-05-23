// ============================================================================
// mcp-tools/removeProjectNeurons.js — drop neurons from a project's cluster
// ============================================================================
// Write. Inverse of lykn_addProjectNeurons. Removes one or more
// (project_id, node_id) membership rows from `lykn_project_neurons`.
//
// Does NOT delete the underlying synthesis-layer node — only the
// project membership. The neuron itself stays around (it's a belief
// row in `lykn_beliefs`, a fact in `lykn_user_model_facts`, a vault
// note in `notes`, etc.) and can be re-clustered into another
// project later.
//
// Project resolution mirrors addProjectNeurons / pushProjectState:
// explicit `project_id` wins, otherwise we fall back to the user's
// active project.

import { jsonContent, errorContent, requireWrite } from './index.js';

const NODE_ID_MAX = 200;
const MAX_NEURONS_PER_CALL = 50;

export const removeProjectNeuronsTool = {
  name: 'lykn_removeProjectNeurons',
  title: 'Remove neurons from a project\'s cluster',
  scope: 'write',
  description: [
    'CALL THIS to drop one or more neurons from a project\'s membership',
    '(the user-grouped cluster of synthesis-layer nodes). The neurons',
    'themselves are NOT deleted — only the project association.',
    '',
    'Discover existing node_ids via lykn_listProjects (each project',
    'response includes a `neurons` preview array with their ids), or',
    'via the [CURRENT_PROJECT] block in lykn_getContextBlock.',
    '',
    'Project resolution: omit `project_id` to remove from the user\'s',
    'active project. Pass it explicitly only when targeting a non-',
    'active project.',
    '',
    'Idempotent: removing a node_id that isn\'t a member is not an',
    'error — the response just reports `removed_count: 0` for that id.',
    '',
    'When NOT to call:',
    '  • To delete the entire project — use lykn_deleteProject.',
    '  • To clear AI working memory — neurons are user-grouped',
    '    membership, not pushed state. Pushed state lives at',
    '    lykn_pushProjectState / lykn_getProjectState.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Optional UUID. Omit to remove from the user\'s active project.',
      },
      node_ids: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_NEURONS_PER_CALL,
        description: `Up to ${MAX_NEURONS_PER_CALL} synthesis-layer node ids to drop from the project's cluster.`,
        items: { type: 'string' },
      },
    },
    required: ['node_ids'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const incoming = Array.isArray(args?.node_ids) ? args.node_ids : [];
    const cleanIds = Array.from(
      new Set(
        incoming
          .map((v) => (typeof v === 'string' ? v.trim().slice(0, NODE_ID_MAX) : ''))
          .filter(Boolean),
      ),
    );
    if (!cleanIds.length) return errorContent('node_ids must be a non-empty array of strings.');
    if (cleanIds.length > MAX_NEURONS_PER_CALL) {
      return errorContent(`Cap is ${MAX_NEURONS_PER_CALL} node_ids per call.`);
    }

    let projectId = args?.project_id ? String(args.project_id).trim() : null;
    if (!projectId) {
      const { data: profile } = await ctx.supabaseAdmin
        .from('lykn_user_synthesis_profile')
        .select('active_project_id')
        .eq('user_id', ctx.userId)
        .maybeSingle();
      projectId = profile?.active_project_id || null;
    }
    if (!projectId) {
      return jsonContent({
        ok: false,
        reason: 'no_active_project',
        message: 'No active project. Pass project_id explicitly or call lykn_setActiveProject first.',
      });
    }

    const { data: project, error: pjErr } = await ctx.supabaseAdmin
      .from('lykn_projects')
      .select('id, name')
      .eq('id', projectId)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (pjErr) {
      return errorContent(`project verify failed: ${pjErr.message}`);
    }
    if (!project) {
      return jsonContent({
        ok: false,
        reason: 'project_not_found',
        message: 'That project_id is not in the user\'s project list. Call lykn_listProjects.',
      });
    }

    const { data: deleted, error: delErr } = await ctx.supabaseAdmin
      .from('lykn_project_neurons')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('project_id', projectId)
      .in('node_id', cleanIds)
      .select('node_id, node_label, node_kind');
    if (delErr) {
      return errorContent(`neuron delete failed: ${delErr.message}`);
    }

    const removedSet = new Set((deleted || []).map((r) => r.node_id));
    const notFound = cleanIds.filter((id) => !removedSet.has(id));

    await ctx.supabaseAdmin
      .from('lykn_projects')
      .update({ last_active_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .eq('user_id', ctx.userId)
      .then(() => {}, () => {});

    return jsonContent({
      ok: true,
      project: { id: project.id, name: project.name },
      removed_count: deleted?.length || 0,
      removed: (deleted || []).map((r) => ({
        node_id: r.node_id,
        label: r.node_label,
        kind: r.node_kind,
      })),
      not_found: notFound,
      message: `Removed ${deleted?.length || 0} neuron(s) from "${project.name}"${notFound.length ? ` (${notFound.length} were not members)` : ''}.`,
    });
  },
};
