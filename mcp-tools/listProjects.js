// ============================================================================
// mcp-tools/listProjects.js — discovery surface for the user's projects
// ============================================================================
// Read-only. Returns the LYKN user's projects ordered by recent activity so
// outside AI clients (Claude Desktop, Cursor, Claude Code, ChatGPT) can
// discover what work the synthesis layer is already tracking BEFORE they
// call lykn_setActiveProject.
//
// Why this exists:
//   Before this tool, the only way for an AI client to switch into the
//   user's active context was to call lykn_setActiveProject with a name.
//   The lookup is fuzzy (lowercase + whitespace-collapse) but not fuzzy
//   enough to forgive every paraphrase — "LYKN MCP work" and "LYKN
//   platform improvements" are different name_keys. With a strict
//   setActiveProject (which we now ship), the AI needs a way to *see*
//   what already exists so it can either:
//     • call setActiveProject({ project_id: <existing id> }) to resume
//     • call setActiveProject({ name: '...', create: true }) to start new
//
// Default sort is last_active_at DESC so the user's current work is at
// the top of the response — that's almost always the one a new
// conversation should bind to.
//
// Status filter defaults to 'active' to keep the response signal-dense.
// Archived projects are still queryable with status='archived' or
// status='all' when the user explicitly asks to resume something old.

import { jsonContent, errorContent } from './index.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const listProjectsTool = {
  name: 'lykn_listProjects',
  title: 'List the user\'s projects ordered by recent activity',
  scope: 'read',
  description: [
    'Return the LYKN user\'s projects, most-recently-active first. This is',
    'the DISCOVERY surface for the project tier: call it before',
    'lykn_setActiveProject if you aren\'t certain which existing project',
    'this conversation belongs to. The user works across multiple AI',
    'clients, so the project you\'re about to set active probably already',
    'exists — picking it up by id avoids polluting the project list with',
    'paraphrased duplicates ("LYKN MCP work" vs "LYKN MCP integration").',
    '',
    'CALL THIS at the start of any conversation that touches the user\'s',
    'work IF lykn_getProjectState returned project=null OR if the topic',
    'doesn\'t obviously map to the active project. Skim the top few',
    'results, pick the best match by name + description + last_active_at,',
    'then call lykn_setActiveProject({ project_id: "<that id>" }).',
    '',
    'Each result includes id, name, description, status (active|archived),',
    'created_by_client (which AI tool first inferred the project),',
    'last_active_at (used to sort), is_focus (true for the ONE project',
    'lykn_getContextBlock currently auto-injects), state_key_count (how',
    'much working memory has been pushed to it), and neuron_count (how',
    'many synthesis nodes the user hand-grouped into it). NB: status',
    '"active" just means "not archived" — it does NOT mean "currently in',
    'focus." Use `is_focus` for that. Status defaults to "active"; pass',
    '"archived" or "all" only when the user explicitly asks to resume',
    'older work.',
    '',
    'If the right project genuinely doesn\'t exist yet, ask the user to create',
    'a main project or branch in the LYKN synthesis layer (+ → Create project).',
    'AI agents cannot create projects — only read and update them.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'archived', 'all'],
        description: 'Filter by project status. Defaults to "active" — the projects the user is currently working on.',
      },
      query: {
        type: 'string',
        description: 'Optional case-insensitive substring filter against project name + description.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max projects to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const status = args?.status === 'archived' || args?.status === 'all'
      ? args.status
      : 'active';

    const rawQuery = typeof args?.query === 'string' ? args.query.trim() : '';
    const limit = Math.min(
      Math.max(parseInt(args?.limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    let q = ctx.supabaseAdmin
      .from('lykn_projects')
      .select('id, name, description, status, created_by_client, created_by, parent_project_id, created_at, last_active_at')
      .eq('user_id', ctx.userId)
      .eq('created_by', 'user')
      .order('last_active_at', { ascending: false })
      .limit(limit);

    if (status !== 'all') q = q.eq('status', status);
    if (rawQuery) {
      // PostgREST `or` filter — substring match on name OR description.
      // Escape commas/parens in the query so a user with a comma in their
      // project name doesn't break the filter syntax.
      const safe = rawQuery.replace(/[,()]/g, ' ');
      q = q.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`);
    }

    const { data: rows, error } = await q;
    if (error) {
      return errorContent(`projects list failed: ${error.message}`);
    }

    // Resolve which one is currently active so the model can tell at a
    // glance whether the project it cares about is already the active
    // one (no need to call setActiveProject again in that case).
    const { data: profile } = await ctx.supabaseAdmin
      .from('lykn_user_synthesis_profile')
      .select('active_project_id')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const activeId = profile?.active_project_id || null;

    // ----------------------------------------------------------------
    // User-clustered neurons (migration 063 / lykn_project_neurons).
    // The synthesis layer's "+ Create project" flow lets the user
    // explicitly group neurons (beliefs, facts, concepts, vault notes,
    // perspectives, …) into a project. We piggyback that membership
    // onto every list response so outside AI clients (Claude /
    // Cursor / Claude Code / ChatGPT) can see WHAT the project
    // contains — the user-facing meaning of the project — rather
    // than only seeing the AI-pushed working state. We snapshot
    // node_label + node_kind at cluster time, so we can render the
    // membership without resolving heterogeneous synthesis-layer
    // node ids back to source rows.
    //
    // Best-effort: if the table is missing (063 not yet applied) we
    // skip silently and the response shape stays backward-compatible.
    // ----------------------------------------------------------------
    const projectIds = (rows || []).map((r) => r.id);
    let neuronsByProject = new Map();
    if (projectIds.length > 0) {
      try {
        const { data: members } = await ctx.supabaseAdmin
          .from('lykn_project_neurons')
          .select('project_id, node_id, node_label, node_kind, created_at')
          .eq('user_id', ctx.userId)
          .in('project_id', projectIds)
          .order('created_at', { ascending: true });
        for (const m of members || []) {
          const arr = neuronsByProject.get(m.project_id) || [];
          arr.push({
            node_id: m.node_id,
            label: m.node_label,
            kind: m.node_kind,
          });
          neuronsByProject.set(m.project_id, arr);
        }
      } catch (err) {
        console.warn('[mcp:listProjects] neuron load failed:', err?.message || err);
      }
    }

    // ----------------------------------------------------------------
    // Per-project working state count. The agent failure mode this
    // fixes: a project with 5 pushed state keys but 0 clustered
    // neurons used to read as "empty" because we only surfaced
    // neuron_count. state_key_count tells the model "this project
    // has accumulated working memory, just no hand-grouped neurons."
    // One round-trip for the whole batch.
    // ----------------------------------------------------------------
    const stateCountByProject = new Map();
    if (projectIds.length > 0) {
      try {
        const { data: stateRows } = await ctx.supabaseAdmin
          .from('lykn_project_state')
          .select('project_id, state_key')
          .eq('user_id', ctx.userId)
          .in('project_id', projectIds)
          .is('superseded_at', null);
        for (const sr of stateRows || []) {
          stateCountByProject.set(
            sr.project_id,
            (stateCountByProject.get(sr.project_id) || 0) + 1,
          );
        }
      } catch (err) {
        console.warn('[mcp:listProjects] state count load failed:', err?.message || err);
      }
    }

    const projects = (rows || []).map((row) => {
      const neurons = neuronsByProject.get(row.id) || [];
      const parent = row.parent_project_id
        ? (rows || []).find((r) => r.id === row.parent_project_id)
        : null;
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        created_by: row.created_by || 'user',
        created_by_client: row.created_by_client,
        created_at: row.created_at,
        last_active_at: row.last_active_at,
        parent_project_id: row.parent_project_id || null,
        is_branch: Boolean(row.parent_project_id),
        main_project_id: row.parent_project_id || row.id,
        main_project_name: parent?.name || null,
        // `is_focus` (renamed from the previous `is_active`) means
        // "this is the project lykn_getContextBlock auto-injects."
        // The old field name collided with `status: 'active'` and
        // confused agents into contradicting themselves ("active but
        // not active"). `is_focus` is unambiguous.
        is_focus: row.id === activeId,
        // How much working memory has been pushed to this project by
        // any AI client. Use this to distinguish "empty shell" from
        // "rich context, just no clustered neurons."
        state_key_count: stateCountByProject.get(row.id) || 0,
        neuron_count: neurons.length,
        // Cap the inline preview so the response stays under model
        // context limits even for users with very large clusters; the
        // count alone tells the model "ask for more if needed."
        neurons: neurons.slice(0, 25),
      };
    });

    return jsonContent({
      ok: true,
      count: projects.length,
      active_project_id: activeId,
      filter: {
        status,
        query: rawQuery || null,
        limit,
      },
      projects,
      message: projects.length
        ? null
        : status === 'active'
          ? 'No active projects yet. Ask the user to create a main project in the LYKN synthesis layer (+ → Create project). AI agents cannot create projects.'
          : 'No projects matched that filter.',
    });
  },
};
