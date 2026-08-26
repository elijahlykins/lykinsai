// ============================================================================
// mcp-tools/addProjectNeurons.js — add Vault knowledge to a project
// ============================================================================
// Retained project-product membership is limited to Vault items.
// It is distinct from `lykn_pushProjectState`, which stores working state.
//
// Membership is idempotent: re-adding an existing (project_id, node_id)
// pair updates label/kind in place rather than erroring. node_label and
// node_kind are SNAPSHOTS taken at cluster time so we can render the
// membership without resolving source rows.
//
// Project resolution mirrors pushProjectState: explicit `project_id`
// wins, otherwise we fall back to the user's active project.

import { jsonContent, errorContent } from './index.js';
import { resolveWriteProjectTarget } from '../lib/projectWriteTarget.js';

const NODE_ID_MAX = 200;
const NODE_LABEL_MAX = 240;
const MAX_NEURONS_PER_CALL = 50;

function cleanString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export const addProjectNeuronsTool = {
  name: 'lykn_addProjectNeurons',
  title: 'Add one or more Vault items to a project',
  scope: 'write',
  description: [
    'CALL THIS to add the user-facing "what is this project made of?"',
    'membership — Vault notes or files that belong to a project.',
    'This is distinct from lykn_pushProjectState (AI-pushed working state).',
    '',
    'Each neuron is a `{ node_id, label?, kind? }` triple:',
    '  • node_id — Vault item id in the form "vault_<uuid>".',
    '  • label — short human-readable label (≤240 chars). Snapshotted',
    '    at cluster time so the membership renders cleanly even if',
    '    the source row\'s text changes.',
    '  • kind — optional; normalized to "vault".',
    '',
    'Project resolution: omit `project_id` to add to the user\'s active',
    'project (set via lykn_setActiveProject). Pass it explicitly only',
    'when you need to cluster into a non-active project.',
    '',
    'Idempotent: re-adding an existing node_id updates its label/kind',
    'in place; no errors on duplicates.',
    '',
    'Limits: up to 50 neurons per call. Split larger imports across',
    'multiple calls so the response stays bounded.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Optional UUID. Omit to add to the user\'s active project.',
      },
      neurons: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_NEURONS_PER_CALL,
        description: `Up to ${MAX_NEURONS_PER_CALL} { node_id, label?, kind? } entries to cluster into the project.`,
        items: {
          type: 'object',
          properties: {
            node_id: {
              type: 'string',
              pattern: '^vault_[A-Za-z0-9-]+$',
              description: 'Vault item id in the form "vault_<uuid>".',
            },
            label: {
              type: 'string',
              description: 'Optional human-readable label snapshot for the panel UI.',
            },
            kind: {
              type: 'string',
              enum: ['vault'],
              description: 'Optional retained membership kind. Only "vault" is supported.',
            },
          },
          required: ['node_id'],
          additionalProperties: false,
        },
      },
    },
    required: ['neurons'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const incoming = Array.isArray(args?.neurons) ? args.neurons : [];
    if (!incoming.length) return errorContent('neurons must be a non-empty array.');
    if (incoming.length > MAX_NEURONS_PER_CALL) {
      return errorContent(`Cap is ${MAX_NEURONS_PER_CALL} neurons per call. Split larger imports across multiple calls.`);
    }

    // Dedup by node_id and clean each entry. We accept the LAST entry
    // for a given node_id (callers occasionally pass partial vs full
    // metadata for the same node within one call).
    const cleanByNode = new Map();
    for (const raw of incoming) {
      const nodeId = cleanString(raw?.node_id, NODE_ID_MAX);
      if (!nodeId || !/^vault_[A-Za-z0-9-]+$/.test(nodeId)) continue;
      cleanByNode.set(nodeId, {
        node_id: nodeId,
        node_label: cleanString(raw?.label, NODE_LABEL_MAX),
        node_kind: 'vault',
      });
    }
    const cleanMembers = Array.from(cleanByNode.values());
    if (!cleanMembers.length) {
      return errorContent('No usable vault_<id> node_id values in the neurons array.');
    }

    const explicitId = args?.project_id ? String(args.project_id).trim() : null;
    const { project, reason } = await resolveWriteProjectTarget(ctx, explicitId);
    if (!project) {
      if (reason === 'project_not_found_or_not_writable') {
        return jsonContent({
          ok: false,
          reason: 'project_not_writable',
          message:
            'That project is not writable. Only user-created projects accept Vault membership writes.',
        });
      }
      return jsonContent({
        ok: false,
        reason: 'no_active_project',
        message:
          'No writable project resolved. Pass project_id for a user-created project or ask the user to create one in Projects.',
      });
    }
    const projectId = project.id;

    // Upsert with onConflict so re-adding a node updates label/kind in
    // place without erroring. We deliberately don't use ignoreDuplicates
    // here — the model may legitimately want to refresh the snapshot
    // when a label changes upstream.
    const rows = cleanMembers.map((m) => ({
      user_id: ctx.userId,
      project_id: projectId,
      node_id: m.node_id,
      node_label: m.node_label,
      node_kind: m.node_kind,
    }));

    const { data: upserted, error: upErr } = await ctx.supabaseAdmin
      .from('lykn_project_neurons')
      .upsert(rows, { onConflict: 'user_id,project_id,node_id' })
      .select('node_id, node_label, node_kind, created_at');
    if (upErr) {
      return errorContent(`neuron upsert failed: ${upErr.message}`);
    }

    // Bump the project's last_active_at so the Projects "By Project"
    // dropdown surfaces it at the top — same heuristic the in-app
    // addNeuronsToProject path uses. Non-critical; swallow on error.
    await ctx.supabaseAdmin
      .from('lykn_projects')
      .update({ last_active_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .eq('user_id', ctx.userId)
      .then(() => {}, () => {});

    return jsonContent({
      ok: true,
      project: { id: project.id, name: project.name },
      added_count: upserted?.length || cleanMembers.length,
      neurons: (upserted || []).map((r) => ({
        node_id: r.node_id,
        label: r.node_label,
        kind: r.node_kind,
        clustered_at: r.created_at,
      })),
      message: `Clustered ${upserted?.length || cleanMembers.length} neuron(s) into "${project.name}".`,
    });
  },
};
