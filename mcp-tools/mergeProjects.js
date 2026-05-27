// ============================================================================
// mcp-tools/mergeProjects.js — fold one project into another, atomically
// ============================================================================
// Write. Calls the SQL function `public.lykn_merge_projects` (migration
// 067) which runs the entire merge inside a single Postgres transaction:
//   • repoint every lykn_project_state row from source → target,
//     reconcile supersession so each (target, state_key) ends up with
//     at most one non-superseded row (newer-wins),
//   • dedupe + repoint lykn_project_neurons membership,
//   • repoint lykn_user_model_facts.project_id (best-effort if 047
//     hasn't been applied),
//   • redirect lykn_user_synthesis_profile.active_project_id if it
//     pointed at source,
//   • hard-delete the source row (cascades clean up any stragglers).
//
// Two-phase by default:
//   1. confirm:false (default) → dry run. The RPC returns a preview:
//      counts of state rows that would move, neurons that would be
//      deduped, whether the focus pointer would redirect. Nothing is
//      written. This lets the model show the user "here's what merging
//      these two projects will do" before committing.
//   2. confirm:true + source_name match → live merge, irreversible.
//      Source project is deleted at the end.
//
// Why a name-match guardrail (same as lykn_deleteProject):
//   The merge destroys the source project — including any state pushes
//   the model itself didn't know about. Requiring the model to echo
//   back the source's CURRENT display name forces it to verify the id
//   it parsed from the user's last message actually points at the
//   project the user thinks it does. Mismatch returns ok:false with
//   the canonical name so the AI can re-confirm with the user before
//   retrying.

import { jsonContent, errorContent, requireWrite } from './index.js';

function normaliseNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export const mergeProjectsTool = {
  name: 'lykn_mergeProjects',
  title: 'Merge one project into another (atomic, two-phase)',
  scope: 'write',
  description: [
    'CALL THIS when the user wants to consolidate two projects into one',
    '— typically because Claude / Cursor / Claude Code / ChatGPT spawned',
    'paraphrased duplicates ("LYKN MCP integration" vs "LYKN MCP work")',
    'and the user wants to keep ONE going forward. The merge is atomic',
    '(single Postgres transaction inside a SECURITY DEFINER function),',
    'so it cannot leave the synthesis layer half-folded.',
    '',
    'TWO-PHASE FLOW (always run both unless the user has already',
    'reviewed the preview):',
    '  1. Dry run — call with `confirm: false` (the default).',
    '     The tool returns a `preview` object: how many state rows',
    '     will be re-pointed, how many neurons get deduped, whether',
    '     the active-project focus will redirect to the target.',
    '     SHOW that preview to the user verbatim and ask them to',
    '     confirm.',
    '  2. Commit — call again with `confirm: true` AND',
    '     `source_name` matching the source\'s current display name',
    '     (case-insensitive). Source is hard-deleted; target keeps',
    '     its name + description.',
    '',
    'WHAT GETS MERGED:',
    '  • Project state (lykn_project_state) — every row\'s project_id',
    '    re-points to target. After re-pointing, any state_key that',
    '    now has multiple non-superseded rows in target gets reduced',
    '    to one (newest survives, older are stamped superseded). Push',
    '    history is preserved.',
    '  • Clustered neurons (lykn_project_neurons) — node_ids unique to',
    '    source move into target; node_ids already in target are',
    '    dropped from source (target\'s snapshot wins).',
    '  • Identity facts (lykn_user_model_facts.project_id) — re-pointed.',
    '  • Active focus pointer — redirected to target if it was on source.',
    '',
    'WHAT IS NOT TOUCHED:',
    '  • Target\'s name / description (use lykn_updateProject after the',
    '    merge if the user wants to rename).',
    '  • Beliefs, vault notes, conversations — those don\'t live in the',
    '    project tier and aren\'t affected.',
    '',
    'GUARDRAILS:',
    '  • Both projects must belong to the same user (verified server-side).',
    '  • source_project_id ≠ target_project_id.',
    '  • source_name match required for the live commit. A bad match',
    '    returns ok:false with the canonical name so you can re-confirm.',
    '  • If you don\'t know which is which, call lykn_listProjects first',
    '    and PRESENT BOTH project rows to the user before merging — the',
    '    operation is irreversible.',
    '',
    'For non-destructive alternatives:',
    '  • To rename a project          → lykn_updateProject',
    '  • To archive without merging   → lykn_updateProject({ status: "archived" })',
    '  • To drop a few neurons        → lykn_removeProjectNeurons',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      source_project_id: {
        type: 'string',
        description: 'UUID of the project that will be FOLDED INTO the target and then deleted. Get this from lykn_listProjects.',
      },
      target_project_id: {
        type: 'string',
        description: 'UUID of the project that will SURVIVE and inherit the source\'s state + neurons. Get this from lykn_listProjects.',
      },
      confirm: {
        type: 'boolean',
        description: 'Default false. Pass true to commit; the tool will then require source_name. With confirm=false the tool returns a preview without writing.',
      },
      source_name: {
        type: 'string',
        description: 'Required when confirm=true. The source project\'s CURRENT display name (case-insensitive, whitespace-collapsed). Guardrail against deleting the wrong project from a stale id — same shape as lykn_deleteProject.',
      },
    },
    required: ['source_project_id', 'target_project_id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const sourceId = String(args?.source_project_id || '').trim();
    const targetId = String(args?.target_project_id || '').trim();
    if (!sourceId || !targetId) {
      return errorContent('Both source_project_id and target_project_id are required.');
    }
    if (sourceId === targetId) {
      return errorContent('source_project_id and target_project_id must differ.');
    }

    const confirm = args?.confirm === true;

    // -----------------------------------------------------------------
    // Live commit gate. The dry run path doesn't need name verification —
    // it doesn't write anything and surfaces the canonical names back
    // to the model so it can show them to the user. Confirmation,
    // however, requires the model to echo the source's current name
    // back as proof it knows what it's about to destroy.
    // -----------------------------------------------------------------
    if (confirm) {
      const passed = typeof args?.source_name === 'string' ? args.source_name : '';
      const passedKey = normaliseNameKey(passed);
      if (!passedKey) {
        return jsonContent({
          ok: false,
          reason: 'source_name_required',
          message: 'When confirm=true you must also pass source_name (the source project\'s current display name).',
        });
      }

      const { data: src, error: findErr } = await ctx.supabaseAdmin
        .from('lykn_projects')
        .select('id, name, name_key')
        .eq('user_id', ctx.userId)
        .eq('id', sourceId)
        .maybeSingle();
      if (findErr) {
        return errorContent(`source project lookup failed: ${findErr.message}`);
      }
      if (!src) {
        return jsonContent({
          ok: false,
          reason: 'project_not_found',
          message: 'source_project_id is not in the user\'s project list. Already deleted, merged, or wrong id.',
        });
      }
      if (src.name_key !== passedKey) {
        return jsonContent({
          ok: false,
          reason: 'name_mismatch',
          message: 'The source_name you passed does not match the project\'s current name. Re-confirm with the user before retrying.',
          actual_name: src.name,
        });
      }
    }

    // -----------------------------------------------------------------
    // Dispatch to the SQL function. p_user_id is required from the
    // service-role context (we are running with supabaseAdmin); the
    // function verifies ownership of both projects internally.
    // -----------------------------------------------------------------
    const { data, error } = await ctx.supabaseAdmin.rpc('lykn_merge_projects', {
      p_source: sourceId,
      p_target: targetId,
      p_dry_run: !confirm,
      p_user_id: ctx.userId,
    });

    if (error) {
      // Postgres RAISE EXCEPTION messages surface here; passing them
      // through verbatim is fine because they don't leak schema —
      // they're shaped for the model to retry intelligently
      // ("source project not found or not owned by user" tells the
      // AI it should re-discover via lykn_listProjects).
      return errorContent(`merge failed: ${error.message}`);
    }

    return jsonContent(data);
  },
};
