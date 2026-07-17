/**
 * Night Shift Phase 3 — complete steward items when async delegations finish.
 */

import { syncCursorBuild } from '../cursor/cursorBuilds.js';
import { getSubModelTask } from '../modelBuilder/subModelTasksService.js';
import { pushProjectStateAdmin } from './pushProjectStateAdmin.js';
import { OVERNIGHT_PROGRESS_STATE_KEY } from './stewardConstants.js';

/**
 * Mark a steward item done/blocked from a terminal Cursor build or sub-model task.
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 */
export async function finalizeStewardFromDelegation(admin, {
  stewardItemId,
  userId,
  ok,
  summary,
  blockedReason = null,
  progressLine = null,
}) {
  if (!admin || !stewardItemId || !userId) return null;

  const { data: item } = await admin
    .from('lykn_steward_items')
    .select('id, title, project_id, status')
    .eq('id', stewardItemId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!item || item.status !== 'running') return null;

  const now = new Date().toISOString();
  const patch = ok
    ? {
        status: 'done',
        result_summary: String(summary || '').slice(0, 4000),
        completed_at: now,
        blocked_reason: null,
      }
    : {
        status: 'blocked',
        blocked_reason: String(blockedReason || summary || 'Delegation failed').slice(0, 500),
        result_summary: summary ? String(summary).slice(0, 4000) : null,
      };

  const { data: updated } = await admin
    .from('lykn_steward_items')
    .update(patch)
    .eq('id', stewardItemId)
    .eq('user_id', userId)
    .eq('status', 'running')
    .select('id, title, project_id, result_summary')
    .maybeSingle();
  if (!updated) return null;

  const line = progressLine || (ok
    ? `**${item.title}** — ${String(summary || 'Done.').slice(0, 200)}`
    : `**${item.title}** — blocked: ${patch.blocked_reason}`);

  if (ok && item.project_id && summary) {
    await pushProjectStateAdmin(admin, {
      userId,
      projectId: item.project_id,
      stateKey: 'progress_summary',
      stateValue: String(summary).slice(0, 500),
      reason: `Night Shift: ${item.title}`,
    }).catch(() => {});
  }

  if (item.project_id && line) {
    await appendOvernightProgress(admin, userId, item.project_id, line).catch(() => {});
  }

  return updated;
}

async function appendOvernightProgress(admin, userId, projectId, line) {
  const { data: rows } = await admin
    .from('lykn_project_state')
    .select('state_value')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .eq('state_key', OVERNIGHT_PROGRESS_STATE_KEY)
    .is('superseded_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  const prev = rows?.[0]?.state_value ? `${rows[0].state_value}\n\n` : '';
  await pushProjectStateAdmin(admin, {
    userId,
    projectId,
    stateKey: OVERNIGHT_PROGRESS_STATE_KEY,
    stateValue: `${prev}${line}`.slice(0, 4000),
    reason: 'Night Shift delegation completed.',
  });
}

/** Called from syncCursorBuild when a build linked to a steward item finishes. */
export async function completeStewardFromCursorBuild(client, build) {
  const stewardItemId = build?.steward_item_id;
  if (!client || !stewardItemId || !build?.user_id) return;
  if (build.status === 'running') return;

  const ok = build.status === 'completed';
  const prPart = build.pr_url ? ` PR: ${build.pr_url}` : '';
  const summary = ok
    ? `Cursor build finished${prPart}. ${build.result_summary || build.instruction || ''}`.trim()
    : build.error_message || build.result_summary || 'Cursor build failed.';

  await finalizeStewardFromDelegation(client, {
    stewardItemId,
    userId: build.user_id,
    ok,
    summary: summary.slice(0, 4000),
    blockedReason: ok ? null : summary.slice(0, 500),
  });
}

/** Called from sub-model task runner when a task linked to a steward item finishes. */
export async function completeStewardFromSubModelTask(client, task) {
  const stewardItemId = task?.steward_item_id;
  if (!client || !stewardItemId || !task?.user_id) return;
  if (task.status === 'pending' || task.status === 'running') return;

  const ok = task.status === 'completed';
  const summary = ok
    ? String(task.report || task.task_instruction || '').trim()
    : task.error_message || 'Sub-agent task failed.';

  await finalizeStewardFromDelegation(client, {
    stewardItemId,
    userId: task.user_id,
    ok,
    summary: summary.slice(0, 4000),
    blockedReason: ok ? null : String(summary).slice(0, 500),
  });
}

/**
 * Poll running steward items with linked async work (Cursor builds, sub-model tasks).
 * @returns {Promise<{ synced: number, completed: number }>}
 */
export async function syncStewardDelegations(admin, { userId = null, projectId = null } = {}) {
  if (!admin) return { synced: 0, completed: 0 };

  let q = admin
    .from('lykn_steward_items')
    .select('id, user_id, project_id, title, cursor_build_id, sub_model_task_id')
    .eq('status', 'running')
    .or('cursor_build_id.not.is.null,sub_model_task_id.not.is.null')
    .limit(40);
  if (userId) q = q.eq('user_id', userId);
  if (projectId) q = q.eq('project_id', projectId);

  const { data: items } = await q;
  if (!items?.length) return { synced: 0, completed: 0 };

  let synced = 0;
  let completed = 0;

  for (const item of items) {
    try {
      if (item.cursor_build_id) {
        const { data: build } = await admin
          .from('lykn_cursor_builds')
          .select('*')
          .eq('id', item.cursor_build_id)
          .maybeSingle();
        if (!build) continue;
        synced += 1;
        const after = build.status === 'running'
          ? await syncCursorBuild(admin, build)
          : build;
        if (after?.status && after.status !== 'running') completed += 1;
        continue;
      }

      if (item.sub_model_task_id) {
        const task = await getSubModelTask(admin, item.user_id, item.sub_model_task_id);
        if (!task) continue;
        synced += 1;
        if (task.status !== 'pending' && task.status !== 'running') {
          await completeStewardFromSubModelTask(admin, {
            ...task,
            steward_item_id: item.id,
            user_id: item.user_id,
          });
          completed += 1;
        }
      }
    } catch (err) {
      console.warn('[stewardCompletion] sync error:', err?.message || err);
    }
  }

  return { synced, completed };
}
