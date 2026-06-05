// ============================================================================
// mcp-tools/addProjectNeurons.js — cluster synthesis-layer neurons into a project
// ============================================================================
// Write. The MCP-side mirror of the in-app "+ Add neurons" button on the
// synthesis page. Outside AI clients (Claude Desktop, Cursor, Claude
// Code, ChatGPT) call this when the conversation surfaces a node the
// user is implicitly grouping into the project — a belief, fact,
// concept, vault note, perspective, or any other synthesis-layer node.
//
// This is the "user-grouped meaning" of the project — distinct from
// `lykn_pushProjectState` (which is AI-pushed working memory). Adding
// a neuron here surfaces the connection in the project panel on the
// synthesis page, in lykn_listProjects responses across other AI
// clients, and in the [CURRENT_PROJECT] block in lykn_getContextBlock.
//
// Membership is idempotent: re-adding an existing (project_id, node_id)
// pair updates label/kind in place rather than erroring. node_label and
// node_kind are SNAPSHOTS taken at cluster time so we can render the
// membership without resolving heterogeneous synthesis-layer node_ids
// back to source rows.
//
// Project resolution mirrors pushProjectState: explicit `project_id`
// wins, otherwise we fall back to the user's active project.

import { jsonContent, errorContent, requireWrite } from './index.js';
import { resolveWriteProjectTarget } from '../lib/projectWriteTarget.js';

const NODE_ID_MAX = 200;
const NODE_LABEL_MAX = 240;
const NODE_KIND_MAX = 64;
const MAX_NEURONS_PER_CALL = 50;

function cleanString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export const addProjectNeuronsTool = {
  name: 'lykn_addProjectNeurons',
  title: 'Cluster one or more synthesis-layer neurons into a project',
  scope: 'write',
  description: [
    'CALL THIS to add the user-facing "what is this project made of?"',
    'membership — neurons (beliefs, facts, concepts, vault notes,',
    'perspectives, …) that belong to a project. This is distinct from',
    'lykn_pushProjectState (AI-pushed working memory) — addProjectNeurons',
    'is the user-grouped cluster of synthesis-layer nodes.',
    '',
    'Each neuron is a `{ node_id, label?, kind? }` triple:',
    '  • node_id — STRING id of the synthesis-layer node. The synthesis',
    '    page uses ids like "belief_<uuid>", "fact_<uuid>",',
    '    "concept_<slug>", "tag_<text>", "vault_<uuid>", etc. If you',
    '    don\'t already have one, call lykn_listProjects to see what',
    '    shape the project\'s existing neurons take, or skip this and',
    '    use lykn_pushProjectState for free-form AI working memory.',
    '  • label — short human-readable label (≤240 chars). Snapshotted',
    '    at cluster time so the membership renders cleanly even if',
    '    the source row\'s text changes.',
    '  • kind — type tag (e.g. "belief", "fact", "concept", "vault",',
    '    "tag", "perspective"). Optional but useful for the panel UI.',
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
              description: 'Synthesis-layer node id (e.g. "belief_<uuid>", "concept_<slug>"). Stable identifier used to dedup membership.',
            },
            label: {
              type: 'string',
              description: 'Optional human-readable label snapshot for the panel UI.',
            },
            kind: {
              type: 'string',
              description: 'Optional kind tag — "belief" | "fact" | "concept" | "vault" | "tag" | "perspective" | …',
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
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
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
      if (!nodeId) continue;
      cleanByNode.set(nodeId, {
        node_id: nodeId,
        node_label: cleanString(raw?.label, NODE_LABEL_MAX),
        node_kind: cleanString(raw?.kind, NODE_KIND_MAX),
      });
    }
    const cleanMembers = Array.from(cleanByNode.values());
    if (!cleanMembers.length) {
      return errorContent('No usable node_id values in the neurons array.');
    }

    const explicitId = args?.project_id ? String(args.project_id).trim() : null;
    const { project, reason } = await resolveWriteProjectTarget(ctx, explicitId);
    if (!project) {
      if (reason === 'project_not_found_or_not_writable') {
        return jsonContent({
          ok: false,
          reason: 'project_not_writable',
          message:
            'That project is not writable. Only user-created synthesis projects accept AI clustering.',
        });
      }
      return jsonContent({
        ok: false,
        reason: 'no_active_project',
        message:
          'No writable project resolved. Pass project_id for a user-created project or ask the user to create one in synthesis.',
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

    // Bump the project's last_active_at so the synthesis "By Project"
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
