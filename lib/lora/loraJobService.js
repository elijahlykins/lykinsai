// ============================================================================
// lykn_lora_jobs — queue, run, and sync Together LoRA fine-tunes
// ============================================================================

import { MIN_LORA_TRAINING_PAIRS } from './constants.js';
import {
  loraTrainingReserveCents,
  refundLoraReserve,
  reserveWalletForLora,
} from '../modelBuilder/modelBuilderWallet.js';
import {
  buildTogetherTrainingJsonl,
  createTogetherLoraJob,
  getTogetherFineTuneJob,
  mapTogetherJobStatus,
  assertTogetherServerlessLoraFinetuneBase,
  resolveTogetherBaseModel,
  togetherConfigured,
  uploadTogetherTrainingFile,
  waitForTogetherFileProcessed,
} from './togetherLora.js';
import { pickWorkingServerlessLoraPair } from './togetherServerlessLora.js';

const SELECT_COLS = [
  'id',
  'user_id',
  'custom_model_id',
  'training_set_id',
  'status',
  'provider',
  'external_job_id',
  'together_file_id',
  'output_model_id',
  'base_together_model',
  'epochs',
  'error_message',
  'metadata',
  'created_at',
  'updated_at',
  'completed_at',
].join(', ');

const runningLoraJobs = new Set();

export class LoraJobValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoraJobValidationError';
  }
}

export function loraJobRowToClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    customModelId: row.custom_model_id,
    trainingSetId: row.training_set_id,
    status: row.status,
    provider: row.provider,
    externalJobId: row.external_job_id,
    togetherFileId: row.together_file_id,
    outputModelId: row.output_model_id,
    baseTogetherModel: row.base_together_model,
    epochs: row.epochs,
    errorMessage: row.error_message,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function patchLoraJob(client, jobId, userId, patch) {
  const { data, error } = await client
    .from('lykn_lora_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('user_id', userId)
    .select(SELECT_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function getLoraJob(client, userId, jobId) {
  const { data, error } = await client
    .from('lykn_lora_jobs')
    .select(SELECT_COLS)
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return loraJobRowToClient(data);
}

export async function getLatestLoraJobForModel(client, userId, customModelId) {
  const { data, error } = await client
    .from('lykn_lora_jobs')
    .select(SELECT_COLS)
    .eq('user_id', userId)
    .eq('custom_model_id', customModelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return loraJobRowToClient(data);
}

async function loadTrainingJsonl(client, userId, trainingSetId) {
  const { data, error } = await client
    .from('lykn_training_sets')
    .select('id, status, jsonl_content, metadata')
    .eq('id', trainingSetId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new LoraJobValidationError('Training set not found.');
  if (data.status !== 'ready' || !data.jsonl_content) {
    throw new LoraJobValidationError('Generate a training set before starting LoRA.');
  }
  const pairs = Number(data.metadata?.total_pairs || 0);
  if (pairs < MIN_LORA_TRAINING_PAIRS) {
    throw new LoraJobValidationError(
      `Need at least ${MIN_LORA_TRAINING_PAIRS} training pairs (have ${pairs}). Add vault or chat sources and regenerate.`,
    );
  }
  return data;
}

export async function createLoraJob(client, userId, { customModelId, trainingSetId } = {}) {
  if (!togetherConfigured()) {
    throw new LoraJobValidationError(
      'LoRA training is not configured. Set TOGETHER_API_KEY on the server.',
    );
  }

  const modelId = String(customModelId || '').trim();
  if (!modelId) throw new LoraJobValidationError('Save your model draft before starting LoRA.');

  const { data: model, error: modelErr } = await client
    .from('lykn_custom_models')
    .select('id, base_kind, base_model_id, training_mode, training_epochs, training_set_id, name')
    .eq('id', modelId)
    .eq('user_id', userId)
    .maybeSingle();
  if (modelErr) throw new Error(modelErr.message);
  if (!model) throw new LoraJobValidationError('Custom model not found.');

  if (model.training_mode !== 'lora') {
    throw new LoraJobValidationError('Set training mode to LoRA in the Training block first.');
  }
  if (model.base_kind !== 'open_source') {
    throw new LoraJobValidationError('LoRA requires an open-weight base model (Base block).');
  }

  const togetherBase = resolveTogetherBaseModel(model.base_model_id);
  if (!togetherBase) {
    throw new LoraJobValidationError(
      `No Together LoRA base mapped for "${model.base_model_id}". Pick Qwen3 8B (LoRA) in the Base block.`,
    );
  }
  try {
    assertTogetherServerlessLoraFinetuneBase(togetherBase);
  } catch (e) {
    throw new LoraJobValidationError(e?.message || 'Invalid LoRA base for serverless inference.');
  }

  const setId = String(trainingSetId || model.training_set_id || '').trim();
  if (!setId) throw new LoraJobValidationError('Link a ready training set first.');

  await loadTrainingJsonl(client, userId, setId);

  const { data: inFlight } = await client
    .from('lykn_lora_jobs')
    .select('id, status')
    .eq('custom_model_id', modelId)
    .eq('user_id', userId)
    .in('status', ['queued', 'uploading', 'running'])
    .limit(1)
    .maybeSingle();
  if (inFlight) {
    throw new LoraJobValidationError('A LoRA job is already running for this model.');
  }

  const epochs = Math.min(20, Math.max(1, Number(model.training_epochs) || 3));
  const reserveCents = loraTrainingReserveCents();
  const { data: row, error } = await client
    .from('lykn_lora_jobs')
    .insert({
      user_id: userId,
      custom_model_id: modelId,
      training_set_id: setId,
      status: 'queued',
      provider: 'together',
      base_together_model: togetherBase,
      epochs,
      metadata: {
        open_source_id: model.base_model_id,
        model_name: model.name,
        wallet_reserve_cents: reserveCents,
      },
    })
    .select(SELECT_COLS)
    .single();
  if (error) throw new Error(error.message);

  try {
    await reserveWalletForLora(client, userId, row.id, reserveCents);
  } catch (walletErr) {
    await client.from('lykn_lora_jobs').delete().eq('id', row.id).eq('user_id', userId);
    if (walletErr.code === 'insufficient_balance') {
      const ve = new LoraJobValidationError(walletErr.message);
      ve.code = 'insufficient_balance';
      ve.balance_cents = walletErr.balance_cents;
      ve.required_cents = walletErr.required_cents;
      throw ve;
    }
    throw walletErr;
  }

  queueLoraJob(client, row.id, userId);
  return loraJobRowToClient(row);
}

export function queueLoraJob(client, jobId, userId) {
  setImmediate(() => {
    runLoraJob(client, jobId, userId).catch((e) => {
      console.error('[lora] run failed:', jobId, e?.message || e);
    });
  });
}

/** Probe Together serverless LoRA ids and persist the working model on job + custom model. */
async function persistServerlessLoraInference(client, row, outputModelId) {
  let serverlessHostModel = null;
  let serverlessAvailable = false;
  const baseTogether = row.base_together_model || row.metadata?.base_together_model;
  try {
    const picked = await pickWorkingServerlessLoraPair(outputModelId, baseTogether);
    serverlessHostModel = picked.hostModel;
    serverlessAvailable = !!picked.probed;
    if (picked.probed) {
      console.log(
        `[lora] serverless Multi-LoRA for ${row.custom_model_id}: host=${serverlessHostModel} lora=${outputModelId}`,
      );
    } else {
      console.warn(
        `[lora] no serverless host for adapter ${outputModelId} (base=${baseTogether || 'unknown'})`,
      );
    }
  } catch (e) {
    console.warn('[lora] serverless probe failed:', e?.message || e);
  }

  const jobMeta = {
    ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
    lora_output_model_id: outputModelId,
    lora_serverless_available: serverlessAvailable,
    ...(serverlessHostModel ? { lora_serverless_host_model: serverlessHostModel } : {}),
  };
  const updated = await patchLoraJob(client, row.id, row.user_id, { metadata: jobMeta });

  const { data: cm } = await client
    .from('lykn_custom_models')
    .select('metadata')
    .eq('id', row.custom_model_id)
    .eq('user_id', row.user_id)
    .maybeSingle();
  await client
    .from('lykn_custom_models')
    .update({
      metadata: {
        ...(cm?.metadata && typeof cm.metadata === 'object' ? cm.metadata : {}),
        lora_output_model_id: outputModelId,
        lora_job_id: row.id,
        lora_serverless_available: serverlessAvailable,
        ...(serverlessHostModel ? { lora_serverless_host_model: serverlessHostModel } : {}),
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.custom_model_id)
    .eq('user_id', row.user_id);

  return updated;
}

export async function syncLoraJobFromProvider(client, row) {
  if (!row?.external_job_id || !togetherConfigured()) return row;
  if (row.status === 'failed' || row.status === 'cancelled') return row;

  const outputForProbe = row.output_model_id || row.metadata?.lora_output_model_id;
  if (row.status === 'ready' && outputForProbe) {
    if (!row.metadata?.lora_serverless_host_model) {
      return persistServerlessLoraInference(client, row, String(outputForProbe));
    }
    return row;
  }

  try {
    const remote = await getTogetherFineTuneJob(row.external_job_id);
    const patch = { status: remote.status };
    if (remote.outputModelId) patch.output_model_id = remote.outputModelId;
    if (remote.errorMessage) patch.error_message = remote.errorMessage;
    if (remote.status === 'ready' || remote.status === 'failed' || remote.status === 'cancelled') {
      patch.completed_at = new Date().toISOString();
    }
    const updated = await patchLoraJob(client, row.id, row.user_id, patch);
    if (remote.status === 'failed' || remote.status === 'cancelled') {
      const reserveCents =
        Number(row.metadata?.wallet_reserve_cents) || loraTrainingReserveCents();
      await refundLoraReserve(client, row.user_id, row.id, reserveCents);
    }
    if (remote.status === 'ready' && remote.outputModelId) {
      return persistServerlessLoraInference(client, updated, remote.outputModelId);
    }
    return updated;
  } catch (e) {
    console.warn('[lora] sync:', row.id, e?.message || e);
    return row;
  }
}

export async function runLoraJob(client, jobId, userId) {
  if (runningLoraJobs.has(jobId)) return;
  runningLoraJobs.add(jobId);
  try {
    const { data: row } = await client
      .from('lykn_lora_jobs')
      .select(SELECT_COLS)
      .eq('id', jobId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!row) return;
    if (row.status === 'ready' || row.status === 'failed' || row.status === 'cancelled') return;

    if (row.external_job_id) {
      await syncLoraJobFromProvider(client, row);
      return;
    }

    await patchLoraJob(client, jobId, userId, { status: 'uploading', error_message: null });

    const training = await loadTrainingJsonl(client, userId, row.training_set_id);
    let jsonl;
    let lineCount = 0;
    try {
      const built = buildTogetherTrainingJsonl(training.jsonl_content);
      jsonl = built.jsonl;
      lineCount = built.lineCount;
    } catch (e) {
      throw new LoraJobValidationError(e?.message || 'Training data could not be formatted for Together.');
    }
    const fileId = await uploadTogetherTrainingFile(jsonl);
    await waitForTogetherFileProcessed(fileId);

    await patchLoraJob(client, jobId, userId, {
      together_file_id: fileId,
      status: 'running',
    });

    const suffix = `lykn-${String(row.custom_model_id).slice(0, 8)}`;
    const created = await createTogetherLoraJob({
      trainingFileId: fileId,
      baseModel: row.base_together_model,
      epochs: row.epochs,
      suffix,
      sampleCount: lineCount,
    });

    await patchLoraJob(client, jobId, userId, {
      external_job_id: created.jobId,
      status: mapTogetherJobStatus(created.status),
      output_model_id: created.outputModelName || null,
      metadata: {
        ...(row.metadata || {}),
        together_create: {
          status: created.status,
          lineCount,
          batchSize: lineCount < 64 ? 1 : Math.min(8, Math.max(1, Math.floor(lineCount / 4))),
        },
      },
    });

    const { data: after } = await client
      .from('lykn_lora_jobs')
      .select(SELECT_COLS)
      .eq('id', jobId)
      .single();
    if (after) await syncLoraJobFromProvider(client, after);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[lora] job error:', jobId, msg);
    try {
      const { data: failedRow } = await client
        .from('lykn_lora_jobs')
        .select('metadata')
        .eq('id', jobId)
        .eq('user_id', userId)
        .maybeSingle();
      const reserveCents = Number(failedRow?.metadata?.wallet_reserve_cents) || loraTrainingReserveCents();
      await refundLoraReserve(client, userId, jobId, reserveCents);
      await patchLoraJob(client, jobId, userId, {
        status: 'failed',
        error_message: msg.slice(0, 2000),
        completed_at: new Date().toISOString(),
      });
    } catch { /* ignore */ }
  } finally {
    runningLoraJobs.delete(jobId);
  }
}

export async function getLoraJobSynced(client, userId, jobId) {
  const { data, error } = await client
    .from('lykn_lora_jobs')
    .select(SELECT_COLS)
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const synced = await syncLoraJobFromProvider(client, data);
  return loraJobRowToClient(synced);
}

export async function getLatestLoraJobForModelSynced(client, userId, customModelId) {
  const { data, error } = await client
    .from('lykn_lora_jobs')
    .select(SELECT_COLS)
    .eq('user_id', userId)
    .eq('custom_model_id', customModelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const synced = await syncLoraJobFromProvider(client, data);
  return loraJobRowToClient(synced);
}

/** Resolve inference model id for chat (LoRA weights when ready). */
export function resolveLoraInferenceModelId(customModel, loraJob) {
  if (!customModel || customModel.trainingMode !== 'lora') return null;
  if (loraJob?.status === 'ready' && loraJob.outputModelId) {
    return loraJob.outputModelId;
  }
  const meta = customModel.metadata || {};
  if (meta.lora_output_model_id) return String(meta.lora_output_model_id);
  return null;
}
