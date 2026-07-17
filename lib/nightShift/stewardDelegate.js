/**
 * Night Shift Phase 3 — delegate scheduled items to Cursor builds or sub-agents.
 */

import { launchCursorBuild } from '../cursor/cursorBuilds.js';
import { getCustomModel } from '../../custom-models-service.js';
import {
  readIsMainAgent,
  readSubModelIds,
} from '../modelBuilder/mainAgentOrchestration.js';
import {
  createSubModelTask,
} from '../modelBuilder/subModelTasksService.js';
import { enqueueSubModelTask } from '../modelBuilder/subModelTaskRunner.js';
import { searchVaultLite } from './stewardAdminWrites.js';
import { parseExecutionKind } from './stewardTier.js';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {string} userId
 */
export async function resolveNightShiftMainModelId(admin, userId) {
  const envId = String(process.env.NIGHT_SHIFT_MAIN_MODEL_ID || '').trim();
  if (envId) return envId;

  const { data: mainRow } = await admin
    .from('lykn_custom_models')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'published')
    .eq('is_main_agent', true)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (mainRow?.id) return mainRow.id;

  const { data: fallback } = await admin
    .from('lykn_custom_models')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return fallback?.id || null;
}

async function blockItem(admin, userId, itemId, runId, reason) {
  await admin
    .from('lykn_steward_items')
    .update({
      status: 'blocked',
      blocked_reason: String(reason).slice(0, 500),
      run_id: runId,
    })
    .eq('id', itemId)
    .eq('user_id', userId);
}

async function resolveSubModel(admin, userId, item) {
  if (item.sub_model_id) {
    const row = await getCustomModel(admin, userId, item.sub_model_id);
    if (row?.status === 'published') {
      return { id: row.id, name: row.name };
    }
    return null;
  }

  const mainModelId = await resolveNightShiftMainModelId(admin, userId);
  if (!mainModelId) return null;

  const main = await getCustomModel(admin, userId, mainModelId);
  const subIds = readIsMainAgent(main) ? readSubModelIds(main) : [];
  if (!subIds.length) return null;

  for (const id of subIds) {
    const row = await getCustomModel(admin, userId, id);
    if (row?.status === 'published') return { id: row.id, name: row.name };
  }
  return null;
}

/**
 * @returns {Promise<string|null>} progress line if delegation started
 */
export async function executeDelegateItem(admin, userId, project, item, runId, kind) {
  const executionKind = parseExecutionKind(kind);

  await admin
    .from('lykn_steward_items')
    .update({ status: 'running', run_id: runId })
    .eq('id', item.id)
    .eq('user_id', userId);

  if (executionKind === 'code') {
    return executeCodeDelegation(admin, userId, project, item, runId);
  }
  if (executionKind === 'agent') {
    return executeAgentDelegation(admin, userId, project, item, runId);
  }
  return null;
}

async function executeCodeDelegation(admin, userId, project, item, runId) {
  const instruction = [
    item.title,
    item.spec ? `\n\n${item.spec}` : '',
  ].join('').trim();

  const launch = await launchCursorBuild({
    client: admin,
    userId,
    instruction,
    repo: item.repo || null,
    projectId: project.id,
    stewardItemId: item.id,
  });

  if (!launch.ok) {
    await blockItem(admin, userId, item.id, runId, launch.message || launch.error || 'Cursor build failed to start.');
    return null;
  }

  const buildId = launch.build?.id;
  if (buildId) {
    await admin
      .from('lykn_steward_items')
      .update({ cursor_build_id: buildId })
      .eq('id', item.id)
      .eq('user_id', userId);
  }

  const urlPart = launch.build?.agent_url ? ` (${launch.build.agent_url})` : '';
  return `**${item.title}** — Cursor build started${urlPart}. You'll get a PR when it finishes.`;
}

async function executeAgentDelegation(admin, userId, project, item, runId) {
  const mainModelId = await resolveNightShiftMainModelId(admin, userId);
  if (!mainModelId) {
    await blockItem(
      admin,
      userId,
      item.id,
      runId,
      'No published custom model found. Publish a main agent or set NIGHT_SHIFT_MAIN_MODEL_ID.',
    );
    return null;
  }

  const sub = await resolveSubModel(admin, userId, item);
  if (!sub) {
    await blockItem(
      admin,
      userId,
      item.id,
      runId,
      'No sub-agent available. Configure sub-models on your main agent or set sub_model_id on this item.',
    );
    return null;
  }

  const query = `${item.title} ${item.spec || ''}`.trim().slice(0, 200);
  const vaultSnippets = await searchVaultLite(admin, userId, query, 4);
  const contextLines = [
    `Project: ${project.name}`,
    item.spec ? `Spec:\n${item.spec}` : '',
    vaultSnippets.length
      ? `Vault:\n${vaultSnippets.map((v) => `• ${v.title}: ${v.snippet}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  const created = await createSubModelTask(admin, {
    userId,
    mainModelId,
    subModelId: sub.id,
    subModelName: sub.name,
    chatId: null,
    taskInstruction: [item.title, item.spec].filter(Boolean).join('\n\n').trim(),
    context: contextLines,
    stewardItemId: item.id,
  });

  if (!created.ok || !created.task?.id) {
    await blockItem(
      admin,
      userId,
      item.id,
      runId,
      created.message || created.error || 'Could not create sub-agent task.',
    );
    return null;
  }

  await admin
    .from('lykn_steward_items')
    .update({ sub_model_task_id: created.task.id, sub_model_id: sub.id })
    .eq('id', item.id)
    .eq('user_id', userId);

  enqueueSubModelTask({ client: admin, taskId: created.task.id, userId });

  return `**${item.title}** — delegated to sub-agent "${sub.name}". Results land when the task completes.`;
}
