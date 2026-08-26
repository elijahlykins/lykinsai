// ============================================================================
// mcp-tools/removeProjectNeurons.js — detach Vault items from a project
// ============================================================================
// Write. Inverse of lykn_addProjectNeurons. Removes one or more
// (project_id, node_id) membership rows from `lykn_project_neurons`.
//
// This does not delete the underlying Vault item.
//
// Project resolution mirrors addProjectNeurons / pushProjectState:
// explicit `project_id` wins, otherwise we fall back to the user's
// active project.

import { jsonContent, errorContent } from './index.js';
import { resolveWriteProjectTarget } from '../lib/projectWriteTarget.js';

const NODE_ID_MAX = 200;
const MAX_NEURONS_PER_CALL = 50;

export const removeProjectNeuronsTool = {
  name: 'lykn_removeProjectNeurons',
  title: 'Remove Vault items from a project',
  scope: 'write',
  description: [
    'CALL THIS to detach one or more Vault items from a project.',
    'The Vault items are NOT deleted — only the project association.',
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
        description: `Up to ${MAX_NEURONS_PER_CALL} vault_<id> values to detach from the project.`,
        items: { type: 'string', pattern: '^vault_[A-Za-z0-9-]+$' },
      },
    },
    required: ['node_ids'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const incoming = Array.isArray(args?.node_ids) ? args.node_ids : [];
    const cleanIds = Array.from(
      new Set(
        incoming
          .map((v) => (typeof v === 'string' ? v.trim().slice(0, NODE_ID_MAX) : ''))
          .filter((v) => /^vault_[A-Za-z0-9-]+$/.test(v)),
      ),
    );
    if (!cleanIds.length) return errorContent('node_ids must contain at least one vault_<id> value.');
    if (cleanIds.length > MAX_NEURONS_PER_CALL) {
      return errorContent(`Cap is ${MAX_NEURONS_PER_CALL} node_ids per call.`);
    }

    const explicitId = args?.project_id ? String(args.project_id).trim() : null;
    const { project, reason } = await resolveWriteProjectTarget(ctx, explicitId);
    if (!project) {
      return jsonContent({
        ok: false,
        reason: reason === 'project_not_found_or_not_writable' ? 'project_not_writable' : 'no_active_project',
        message: 'No writable project resolved. Pass project_id for a user-created project.',
      });
    }
    const projectId = project.id;

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
