/**
 * Background runner for async sub-model delegation tasks.
 */

import { runSubModelDelegate } from './runSubModelDelegate.js';
import {
  claimPendingSubModelTask,
  finishSubModelTask,
} from './subModelTasksService.js';

/**
 * @param {object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.client
 * @param {string} opts.taskId
 * @param {string} opts.userId
 */
export async function runSubModelTaskBackground({ client, taskId, userId }) {
  const claimed = await claimPendingSubModelTask(client, taskId, userId);
  if (!claimed) return;

  const result = await runSubModelDelegate({
    client,
    userId,
    subModelId: claimed.sub_model_id,
    taskInstruction: claimed.task_instruction,
    context: claimed.context || '',
  });

  if (result?.ok) {
    const finished = await finishSubModelTask(client, userId, taskId, {
      status: 'completed',
      report: result.report,
    });
    try {
      const { completeStewardFromSubModelTask } = await import('../nightShift/stewardCompletion.js');
      const { data: row } = await client
        .from('lykn_sub_model_tasks')
        .select('*')
        .eq('id', taskId)
        .eq('user_id', userId)
        .maybeSingle();
      if (row) await completeStewardFromSubModelTask(client, row);
    } catch (e) {
      console.warn('[sub-model-task] steward completion failed:', e?.message || e);
    }
    console.log(
      `✅ Sub-agent "${claimed.sub_model_name || claimed.sub_model_id}" completed task ${taskId}`,
    );
    return finished;
  }

  const failed = await finishSubModelTask(client, userId, taskId, {
    status: 'failed',
    error_message: result?.message || result?.error || 'delegation_failed',
  });
  try {
    const { completeStewardFromSubModelTask } = await import('../nightShift/stewardCompletion.js');
    const { data: row } = await client
      .from('lykn_sub_model_tasks')
      .select('*')
      .eq('id', taskId)
      .eq('user_id', userId)
      .maybeSingle();
    if (row) await completeStewardFromSubModelTask(client, row);
  } catch (e) {
    console.warn('[sub-model-task] steward completion failed:', e?.message || e);
  }
  console.warn(
    `⚠️ Sub-agent "${claimed.sub_model_name || claimed.sub_model_id}" failed task ${taskId}: ${result?.message || result?.error}`,
  );
}

export function enqueueSubModelTask(args) {
  setImmediate(() => {
    runSubModelTaskBackground(args).catch((err) => {
      console.error('[sub-model-task] background run failed:', err?.message || err);
    });
  });
}
