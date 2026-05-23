// ============================================================================
// mcp-tools/getProjectNeurons.js — read a project's clustered neurons
// ============================================================================
// Read-only. The synthesis layer's "project" is a named bag of neurons
// (beliefs, facts, concepts, vault notes, perspectives, …) that the user
// or an AI has explicitly grouped together via lykn_addProjectNeurons.
// This tool returns that membership list — the user-grouped cluster, as
// snapshots taken at cluster time (label + kind frozen) — so the model
// can answer "what's IN my project?" without having to re-derive it from
// findConnections or guess from project state.
//
// Why a separate read tool (instead of inlining in getProjectState):
//   • getProjectState returns the AI working-memory key-value store
//     (current_blocker, tech_stack, …). It's used at the start of
//     every project conversation. Inlining a potentially-large neuron
//     list would balloon the context cost of that hot path.
//   • Neuron membership and project state have different update
//     cadences: state changes constantly (every push), membership
//     changes rarely (the user clusters something maybe once a week).
//     Splitting the reads lets each one be cached / called when
//     actually needed.
//   • External MCP clients (Cursor, Claude Desktop) and the in-app
//     chat have different needs — some want state, some want membership,
//     few want both at once. Separate tools = pick what you need.
//
// Common pattern (the "auto-connect" flow):
//   user mentions a project →
//     setActiveProject({ name }) →
//     getProjectState({}) → load working memory →
//     getProjectNeurons({}) → load clustered neurons →
//     [optionally] loadNeuron({ node_id }) → hydrate one specific neuron
//
// Returns:
//   • project header (id, name, description, status, last_active_at)
//   • neurons array, ordered by cluster time (oldest first — preserves
//     the order the user clustered them, which often encodes intent)
//   • counts grouped by kind, so the model can summarise without
//     iterating ("this project is mostly beliefs + a few vault notes")
//
// node_ids in the response are the SAME format lykn_loadNeuron accepts
// (belief_<uuid>, fact_<uuid>, concept_<slug>, vault_<uuid>, …), so a
// hydrate-everything-in-this-project pipeline is straightforward.

import { jsonContent, errorContent } from './index.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const getProjectNeuronsTool = {
  name: 'lykn_getProjectNeurons',
  title: 'List the neurons clustered into a LYKN project',
  scope: 'read',
  description: [
    'Return the LYKN user\'s clustered neuron membership for a project —',
    'every belief, fact, concept, vault note, perspective, or other',
    'synthesis-layer node they\'ve explicitly grouped here. Defaults to',
    'the user\'s ACTIVE project so most callers can omit project_id.',
    '',
    'CALL THIS as part of the "auto-connect" flow whenever a project',
    'becomes relevant to the conversation:',
    '  1. lykn_setActiveProject({ name }) — switch focus',
    '  2. lykn_getProjectState({}) — load AI working memory',
    '  3. lykn_getProjectNeurons({}) — load clustered neurons',
    'After step 3 you have the FULL picture of what the user has',
    'grouped under this project and can reason about it accurately.',
    '',
    'When you need the FULL body of any returned neuron (vault note',
    'content, full belief rationale, concept relations), call',
    'lykn_loadNeuron({ node_id }) — the node_ids returned here are',
    'in exactly the right format.',
    '',
    'CHEAP, IDEMPOTENT, READ-ONLY. Safe to call at the start of any',
    'project conversation. Membership is sorted oldest-first so the',
    'order encodes the user\'s clustering intent.',
    '',
    'If there is no active project (the user hasn\'t set one yet, or',
    'this is a brand-new account), returns ok=true with project=null.',
    'Don\'t treat that as an error.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Optional UUID. Omit to read the user\'s active project.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max neurons to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
      kind: {
        type: 'string',
        description: 'Optional kind filter (e.g. "belief", "fact", "concept", "vault"). Omit to return every kind.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const limit = Number.isFinite(args?.limit)
      ? Math.max(1, Math.min(MAX_LIMIT, args.limit))
      : DEFAULT_LIMIT;
    const kindFilter = typeof args?.kind === 'string'
      ? args.kind.trim().toLowerCase()
      : null;

    // Resolve project: explicit > active. Mirrors getProjectState /
    // pushProjectState exactly so the three tools agree on "which
    // project are we talking about" within a single turn.
    let projectId = args?.project_id ? String(args.project_id).trim() : null;
    if (!projectId) {
      const { data: profile, error: profileErr } = await ctx.supabaseAdmin
        .from('lykn_user_synthesis_profile')
        .select('active_project_id')
        .eq('user_id', ctx.userId)
        .maybeSingle();
      if (profileErr) {
        return errorContent(`profile lookup failed: ${profileErr.message}`);
      }
      projectId = profile?.active_project_id || null;
    }

    if (!projectId) {
      return jsonContent({
        ok: true,
        project: null,
        neurons: [],
        counts: {},
        message:
          'No active project. Call lykn_setActiveProject first, or pass an explicit project_id.',
      });
    }

    const { data: project, error: pjErr } = await ctx.supabaseAdmin
      .from('lykn_projects')
      .select('id, name, description, status, created_by_client, created_at, last_active_at')
      .eq('id', projectId)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (pjErr) {
      return errorContent(`project lookup failed: ${pjErr.message}`);
    }
    if (!project) {
      return jsonContent({
        ok: false,
        reason: 'project_not_found',
        message: 'That project_id is not in the user\'s project list.',
      });
    }

    let q = ctx.supabaseAdmin
      .from('lykn_project_neurons')
      .select('node_id, node_label, node_kind, created_at')
      .eq('user_id', ctx.userId)
      .eq('project_id', projectId)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (kindFilter) q = q.eq('node_kind', kindFilter);

    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) {
      return errorContent(`neuron membership read failed: ${rowsErr.message}`);
    }

    const neurons = (rows || []).map((row) => ({
      node_id: row.node_id,
      label: row.node_label || '(unlabelled)',
      kind: row.node_kind || 'unknown',
      clustered_at: row.created_at,
    }));

    const counts = {};
    for (const n of neurons) {
      const k = n.kind || 'unknown';
      counts[k] = (counts[k] || 0) + 1;
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
      count: neurons.length,
      counts,
      neurons,
      ...(kindFilter ? { kind_filter: kindFilter } : {}),
      message: neurons.length === 0
        ? `"${project.name}" doesn't have any clustered neurons yet.`
        : `"${project.name}" has ${neurons.length} clustered neuron${neurons.length === 1 ? '' : 's'}.`,
    });
  },
};
