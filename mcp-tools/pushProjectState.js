// ============================================================================
// mcp-tools/pushProjectState.js — write a key/value into project working memory
// ============================================================================
// Write. Middle-tier synthesis: like `git push` for the AI's working
// memory of a project. Each push is timestamped, attributed to the
// client that made it, and supersedes any prior unsuperseded value at
// the same (user_id, project_id, state_key).
//
// Replacement semantics, not append-and-rebuild:
//   • Read path: "get the current value of key K in project P" is a
//     single index lookup against `idx_lykn_project_state_current`
//     (partial WHERE superseded_at IS NULL).
//   • Audit path: "what did K used to be?" is a separate, slower query
//     against the same table but without the WHERE clause.
//   • The model never needs to think about the history row — it just
//     pushes the latest value and the server handles supersession.
//
// Project resolution:
//   1. Explicit `project_id` in args wins.
//   2. Otherwise fall back to lykn_user_preferences.active_project_id.
//   3. If neither resolves, return an actionable error telling the
//      model to call lykn_setActiveProject first. We deliberately do
//      NOT auto-create an "Untitled project" because that's the kind
//      of orphan-row footgun that pollutes the synthesis profile UI.

import { jsonContent, errorContent } from './content.js';
import { resolveProjectPushClient, resolveWriteProjectTarget } from '../lib/projectWriteTarget.js';

const STATE_KEY_MAX = 80;
const STATE_VALUE_MAX = 2000;
const REASON_MAX = 320;

function isValidStateKey(key) {
  // Slug-shape: lowercase letters, digits, underscores. Coach the model
  // toward stable keys so reuse-across-pushes works automatically.
  return /^[a-z][a-z0-9_]{0,79}$/.test(key);
}

export const pushProjectStateTool = {
  name: 'lykn_pushProjectState',
  title: 'Push a state update into the active project (git-style)',
  scope: 'write',
  description: [
    'CALL THIS whenever a meaningful decision, milestone, blocker, or',
    'piece of working state should be visible to the user\'s OTHER AI',
    'tools when they pick up this project. Each push at the same',
    '`state_key` supersedes the prior value (replacement semantics, not',
    'append) — think `git push` for AI working memory.',
    '',
    'Examples of good pushes:',
    '  pushProjectState({ state_key: "tech_stack",',
    '                     state_value: "Streamable HTTP MCP, hand-rolled core, no SDK" })',
    '  pushProjectState({ state_key: "current_blocker",',
    '                     state_value: "Claude Desktop tool name regex rejects dots" })',
    '  pushProjectState({ state_key: "next_milestone",',
    '                     state_value: "Project tier MCP tools shipped to Render" })',
    '',
    'Reuse keys across pushes — "current_blocker" should be the SAME key',
    'every time, not "current_blocker_2026_05_09". The server tracks',
    'history under the hood; the read path always returns the latest.',
    '',
    'Key shape: lowercase letters, digits, and underscores. 1–80 chars.',
    'Pick stable, semantically meaningful keys. Suggested vocabulary:',
    '  tech_stack | architecture | current_blocker | next_milestone |',
    '  open_questions | recent_decisions | scope | constraints |',
    '  collaborators | progress_summary | morning_brief',
    '',
    'Project resolution: omit `project_id` to push to the user\'s active',
    'project (set via lykn_setActiveProject). Pass it explicitly only',
    'when you need to update an inactive project.',
    '',
    'When NOT to push:',
    '  • Long-form notes — those belong in the vault, not project state.',
    '    state_value is capped at 2000 chars on purpose.',
    '  • Casual conversation that didn\'t produce a decision.',
    '  • Things that belong in beliefs/facts (durable about the user,',
    '    not about a specific project) — use the right tool.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      state_key: {
        type: 'string',
        description: 'Slug-shaped key (lowercase letters/digits/underscores). E.g. "tech_stack", "current_blocker". Reuse across pushes.',
      },
      state_value: {
        type: 'string',
        description: 'The current value at this key (<=2000 chars). Replaces any prior value at the same key.',
      },
      project_id: {
        type: 'string',
        description: 'Optional UUID. Omit to push to the user\'s active project (set via lykn_setActiveProject).',
      },
      message_id: {
        type: 'string',
        description: 'Optional anchor in the source conversation (host-provided id). Helps the user trace where this came from.',
      },
      reason: {
        type: 'string',
        description: 'Optional one-sentence justification (<=320 chars) — why this is worth recording.',
      },
    },
    required: ['state_key', 'state_value'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const stateKey = String(args?.state_key || '').trim().toLowerCase();
    if (!stateKey) return errorContent('state_key is required.');
    if (!isValidStateKey(stateKey)) {
      return errorContent(
        'state_key must match ^[a-z][a-z0-9_]{0,79}$ — start with a lowercase letter, then lowercase letters/digits/underscores.',
      );
    }

    const stateValue = String(args?.state_value || '').trim().slice(0, STATE_VALUE_MAX);
    if (!stateValue) return errorContent('state_value is required and must be non-empty.');

    const pushReason = args?.reason ? String(args.reason).trim().slice(0, REASON_MAX) : null;
    const messageId = args?.message_id ? String(args.message_id).trim().slice(0, 200) : null;
    const clientKind = resolveProjectPushClient(ctx);

    const explicitId = args?.project_id ? String(args.project_id).trim() : null;
    const { project, resolvedBy, reason: resolveReason } = await resolveWriteProjectTarget(ctx, explicitId);
    if (!project) {
      if (resolveReason === 'project_not_found_or_not_writable') {
        return jsonContent({
          ok: false,
          reason: 'project_not_writable',
          message:
            'That project_id is not writable. Only user-created projects (from the LYKN Projects) accept AI updates. Legacy AI-inferred projects are read-only — ask the user to create a project and pass its id.',
        });
      }
      return jsonContent({
        ok: false,
        reason: resolveReason || 'no_active_project',
        message:
          'No writable project resolved. Pass project_id for a user-created project, or ask the user to create one in synthesis (+ → Create project). Custom-model chats bind to linked_project_id automatically.',
      });
    }
    const projectId = project.id;

    // Mark prior unsuperseded row at the same key as superseded. We do
    // this BEFORE inserting the new row so a hypothetical concurrent
    // read sees either old-or-new, never both. Tiny window, but worth
    // ordering correctly.
    const supersededAt = new Date().toISOString();
    const { data: priorRows, error: supErr } = await ctx.supabaseAdmin
      .from('lykn_project_state')
      .update({ superseded_at: supersededAt })
      .eq('user_id', ctx.userId)
      .eq('project_id', projectId)
      .eq('state_key', stateKey)
      .is('superseded_at', null)
      .select('id, state_value, set_by_client, created_at');
    if (supErr) {
      return errorContent(`supersede failed: ${supErr.message}`);
    }

    const { data: inserted, error: insErr } = await ctx.supabaseAdmin
      .from('lykn_project_state')
      .insert({
        user_id: ctx.userId,
        project_id: projectId,
        state_key: stateKey,
        state_value: stateValue,
        set_by_client: clientKind,
        set_in_message_id: messageId,
        reason: pushReason,
      })
      .select('id, state_key, state_value, set_by_client, created_at')
      .single();
    if (insErr) {
      return errorContent(`state insert failed: ${insErr.message}`);
    }

    // Bump project last_active_at so this project surfaces first in the
    // synthesis profile UI and stays out of the 30-day archive sweep.
    await ctx.supabaseAdmin
      .from('lykn_projects')
      .update({ last_active_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .then(() => {}, () => { /* non-critical, swallow */ });

    return jsonContent({
      ok: true,
      resolved_by: resolvedBy,
      project: { id: project.id, name: project.name },
      pushed: {
        state_key: inserted.state_key,
        state_value: inserted.state_value,
        set_by_client: inserted.set_by_client,
        created_at: inserted.created_at,
      },
      prior_value:
        Array.isArray(priorRows) && priorRows.length
          ? {
              value: priorRows[0].state_value,
              set_by_client: priorRows[0].set_by_client,
              created_at: priorRows[0].created_at,
            }
          : null,
      message: priorRows?.length
        ? `Updated "${stateKey}" in "${project.name}" (prior value superseded).`
        : `Set "${stateKey}" in "${project.name}".`,
    });
  },
};
