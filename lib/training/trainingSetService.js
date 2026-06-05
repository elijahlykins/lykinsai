import { generateTrainingSet } from './generateTrainingSet.js';
import { MAX_GENERATIONS_PER_USER_PER_DAY } from './constants.js';

const runningJobs = new Set();

async function countJobsStartedToday(client, userId) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count, error } = await client
    .from('lykn_training_sets')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', start.toISOString())
    .neq('status', 'failed');
  if (error) {
    console.warn('[training] countJobsStartedToday:', error.message);
    return 0;
  }
  return count || 0;
}

export async function assertCanStartGeneration(client, userId) {
  if (!Number.isFinite(MAX_GENERATIONS_PER_USER_PER_DAY)) return;
  const today = await countJobsStartedToday(client, userId);
  if (today >= MAX_GENERATIONS_PER_USER_PER_DAY) {
    const err = new Error(
      `Daily training set limit reached (${MAX_GENERATIONS_PER_USER_PER_DAY} per day). ` +
        'Failed runs no longer count — set TRAINING_SET_DAILY_LIMIT=0 in .env for unlimited (dev).',
    );
    err.code = 'daily_limit';
    throw err;
  }
}

export async function createTrainingSetJob(
  client,
  userId,
  {
    vaultSource = 'synthesis',
    includeChats = false,
    vaultTags = [],
    vaultNoteIds = [],
    synthesisMode = 'all',
    excludedBeliefIds = [],
    includedNeurons = [],
  } = {},
) {
  await assertCanStartGeneration(client, userId);

  const tags = Array.isArray(vaultTags)
    ? vaultTags.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  const noteIds = Array.isArray(vaultNoteIds)
    ? vaultNoteIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const excluded = Array.isArray(excludedBeliefIds)
    ? excludedBeliefIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const neurons = Array.isArray(includedNeurons)
    ? includedNeurons
        .map((n) => ({
          kind: String(n?.kind || '').trim(),
          id: String(n?.id || '').trim(),
        }))
        .filter((n) => n.kind && n.id)
    : [];

  const { data, error } = await client
    .from('lykn_training_sets')
    .insert({
      user_id: userId,
      status: 'queued',
      vault_source: vaultSource,
      metadata: {
        vault_source: vaultSource,
        include_chats: !!includeChats,
        ...(tags.length ? { vault_tags: tags } : {}),
        ...(noteIds.length ? { vault_note_ids: noteIds } : {}),
        synthesis_mode: synthesisMode,
        ...(excluded.length ? { excluded_synthesis_belief_ids: excluded } : {}),
        ...(neurons.length ? { included_synthesis_neurons: neurons } : {}),
      },
    })
    .select('id, user_id, status, vault_source, metadata, created_at, updated_at')
    .single();

  if (error) throw new Error(error.message || 'Failed to create training set job');
  return data;
}

async function patchJob(client, id, userId, patch) {
  const { data, error } = await client
    .from('lykn_training_sets')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, user_id, status, vault_source, model_used, error_message, metadata, created_at, updated_at, completed_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function runTrainingSetJob(client, jobId, userId) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  try {
    const { data: row } = await client
      .from('lykn_training_sets')
      .select('id, status, vault_source, metadata')
      .eq('id', jobId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!row) return;
    if (row.status === 'ready' || row.status === 'failed') return;
    if (row.status === 'running') {
      console.warn('[training] job already running, skipping duplicate worker', jobId);
      return;
    }

    await patchJob(client, jobId, userId, { status: 'running' });
    console.log('[training] job running', jobId, row.vault_source);

    const includeChats = !!row.metadata?.include_chats;
    const vaultTags = Array.isArray(row.metadata?.vault_tags) ? row.metadata.vault_tags : [];
    const vaultNoteIds = Array.isArray(row.metadata?.vault_note_ids) ? row.metadata.vault_note_ids : [];
    const out = await generateTrainingSet(client, userId, {
      vaultSource: row.vault_source || 'synthesis',
      includeChats,
      vaultTags,
      vaultNoteIds,
      synthesisMode: row.metadata?.synthesis_mode || 'all',
      excludedBeliefIds: row.metadata?.excluded_synthesis_belief_ids || [],
      includedNeurons: row.metadata?.included_synthesis_neurons || [],
    });

    await patchJob(client, jobId, userId, {
      status: 'ready',
      model_used: out.metadata.model_used,
      jsonl_content: out.jsonl,
      metadata: out.metadata,
      completed_at: new Date().toISOString(),
      error_message: null,
    });
    console.log(
      '[training] job ready',
      jobId,
      out.metadata?.total_pairs,
      'pairs',
    );
  } catch (e) {
    console.error('[training] job failed:', jobId, e?.message || e);
    const { data: prior } = await client
      .from('lykn_training_sets')
      .select('metadata')
      .eq('id', jobId)
      .eq('user_id', userId)
      .maybeSingle();
    await patchJob(client, jobId, userId, {
      status: 'failed',
      error_message: String(e?.message || e).slice(0, 2000),
      metadata: {
        ...(prior?.metadata && typeof prior.metadata === 'object' ? prior.metadata : {}),
        status: 'failed',
        error_code: e?.code || 'unknown',
      },
    }).catch(() => {});
  } finally {
    runningJobs.delete(jobId);
  }
}

export function queueTrainingSetJob(client, jobId, userId) {
  setImmediate(() => {
    runTrainingSetJob(client, jobId, userId).catch((e) => {
      console.error('[training] queue run failed:', e?.message || e);
    });
  });
}

export async function getTrainingSetJob(client, jobId, userId) {
  const { data, error } = await client
    .from('lykn_training_sets')
    .select(
      'id, user_id, status, vault_source, model_used, error_message, metadata, created_at, updated_at, completed_at',
    )
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Job to show in Model Builder: in-flight work first, else newest completed export.
 */
export async function getLatestTrainingSetJob(client, userId) {
  const cols =
    'id, user_id, status, vault_source, model_used, error_message, metadata, created_at, updated_at, completed_at';

  const { data: active, error: activeErr } = await client
    .from('lykn_training_sets')
    .select(cols)
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeErr) throw new Error(activeErr.message);
  if (active) return active;

  const { data: ready, error: readyErr } = await client
    .from('lykn_training_sets')
    .select(cols)
    .eq('user_id', userId)
    .eq('status', 'ready')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readyErr) throw new Error(readyErr.message);
  if (ready) return ready;

  const { data: fallback, error: fbErr } = await client
    .from('lykn_training_sets')
    .select(cols)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fbErr) throw new Error(fbErr.message);
  return fallback;
}

/** Re-run workers for jobs left queued after a server restart. */
export async function requeueStaleTrainingSetJobs(client, { maxAgeMinutes = 3 } = {}) {
  if (!client) return;
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const { data: rows, error } = await client
    .from('lykn_training_sets')
    .select('id, user_id, status')
    .in('status', ['queued', 'running'])
    .lt('updated_at', cutoff);
  if (error) {
    console.warn('[training] requeueStaleTrainingSetJobs:', error.message);
    return;
  }
  for (const row of rows || []) {
    if (!row?.id || !row?.user_id) continue;
    if (row.status === 'running') {
      await client
        .from('lykn_training_sets')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('user_id', row.user_id);
    }
    console.log('[training] requeue stale job', row.id);
    queueTrainingSetJob(client, row.id, row.user_id);
  }
}
