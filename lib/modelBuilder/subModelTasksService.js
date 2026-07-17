/**
 * CRUD for async sub-model delegation tasks (main agent → sub-agent).
 */

const ACTIVE_STATUSES = new Set(['pending', 'running']);
const MAX_ACTIVE_PER_USER = 8;
const MAX_INSTRUCTION_CHARS = 6000;
const MAX_CONTEXT_CHARS = 4000;
const MAX_REPORT_CHARS = 24_000;

function trimTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    main_model_id: row.main_model_id,
    sub_model_id: row.sub_model_id,
    sub_model_name: row.sub_model_name || '',
    chat_id: row.chat_id || null,
    task_instruction: row.task_instruction || '',
    context: row.context || null,
    status: row.status,
    report: row.report || null,
    error_message: row.error_message || null,
    main_notified_at: row.main_notified_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
  };
}

export async function countActiveSubModelTasks(client, userId) {
  if (!client || !userId) return 0;
  const { count, error } = await client
    .from('lykn_sub_model_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['pending', 'running']);
  if (error) throw error;
  return count || 0;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
export async function createSubModelTask(client, {
  userId,
  mainModelId,
  subModelId,
  subModelName,
  chatId = null,
  taskInstruction,
  context = '',
  stewardItemId = null,
}) {
  if (!client || !userId || !mainModelId || !subModelId) {
    return { ok: false, error: 'invalid_args', message: 'Missing required task fields.' };
  }

  const active = await countActiveSubModelTasks(client, userId);
  if (active >= MAX_ACTIVE_PER_USER) {
    return {
      ok: false,
      error: 'too_many_active',
      message: `Too many sub-agents running (${MAX_ACTIVE_PER_USER} max). Wait for one to finish or check status.`,
    };
  }

  const instruction = String(taskInstruction || '').trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!instruction) {
    return { ok: false, error: 'missing_task', message: 'task_instruction is required.' };
  }

  const ctx = String(context || '').trim().slice(0, MAX_CONTEXT_CHARS) || null;
  const now = new Date().toISOString();

  const insertRow = {
    user_id: userId,
    main_model_id: String(mainModelId).trim(),
    sub_model_id: String(subModelId).trim(),
    sub_model_name: String(subModelName || '').trim().slice(0, 120),
    chat_id: chatId ? String(chatId).trim() : null,
    task_instruction: instruction,
    context: ctx,
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
  if (stewardItemId) insertRow.steward_item_id = String(stewardItemId).trim();

  const { data, error } = await client
    .from('lykn_sub_model_tasks')
    .insert(insertRow)
    .select('*')
    .single();

  if (error) {
    return { ok: false, error: 'insert_failed', message: error.message || String(error) };
  }
  return { ok: true, task: trimTask(data) };
}

export async function claimPendingSubModelTask(client, taskId, userId) {
  if (!client || !taskId || !userId) return null;

  const { data: row, error: fetchErr } = await client
    .from('lykn_sub_model_tasks')
    .select('*')
    .eq('id', taskId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .maybeSingle();
  if (fetchErr || !row) return null;

  const now = new Date().toISOString();
  const { data, error } = await client
    .from('lykn_sub_model_tasks')
    .update({ status: 'running', started_at: now, updated_at: now })
    .eq('id', taskId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error || !data) return null;
  return trimTask(data);
}

export async function finishSubModelTask(client, userId, taskId, patch) {
  if (!client || !userId || !taskId) return null;
  const now = new Date().toISOString();
  const body = {
    updated_at: now,
    completed_at: now,
    ...patch,
  };
  if (typeof body.report === 'string') {
    body.report = body.report.slice(0, MAX_REPORT_CHARS);
  }
  const { data, error } = await client
    .from('lykn_sub_model_tasks')
    .update(body)
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return trimTask(data);
}

export async function getSubModelTask(client, userId, taskId) {
  if (!client || !userId || !taskId) return null;
  const { data, error } = await client
    .from('lykn_sub_model_tasks')
    .select('*')
    .eq('id', taskId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return trimTask(data);
}

export async function listSubModelTasks(client, userId, {
  mainModelId = null,
  chatId = null,
  status = null,
  limit = 20,
} = {}) {
  if (!client || !userId) return [];
  let q = client
    .from('lykn_sub_model_tasks')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 40));

  if (mainModelId) q = q.eq('main_model_id', String(mainModelId).trim());
  if (chatId) q = q.eq('chat_id', String(chatId).trim());
  if (status) {
    const statuses = String(status)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length === 1) q = q.eq('status', statuses[0]);
    else if (statuses.length > 1) q = q.in('status', statuses);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(trimTask);
}

/** Completed tasks not yet injected into the main agent prompt. */
export async function listUndeliveredCompletedTasks(client, userId, mainModelId) {
  if (!client || !userId || !mainModelId) return [];
  const { data, error } = await client
    .from('lykn_sub_model_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('main_model_id', String(mainModelId).trim())
    .eq('status', 'completed')
    .is('main_notified_at', null)
    .order('completed_at', { ascending: true })
    .limit(12);
  if (error) throw error;
  return (data || []).map(trimTask);
}

export async function markSubModelTasksNotified(client, userId, taskIds) {
  if (!client || !userId || !taskIds?.length) return;
  const now = new Date().toISOString();
  await client
    .from('lykn_sub_model_tasks')
    .update({ main_notified_at: now, updated_at: now })
    .eq('user_id', userId)
    .in('id', taskIds);
}

export function isActiveSubModelTaskStatus(status) {
  return ACTIVE_STATUSES.has(String(status || '').trim());
}
