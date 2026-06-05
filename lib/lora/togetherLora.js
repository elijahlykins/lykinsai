// ============================================================================
// Together AI — LoRA fine-tune + chat (OpenAI-compatible)
// ============================================================================

import { parseJsonl } from '../training/writeJsonl.js';
import { LORA_LEARNING_RATE, LORA_WARMUP_RATIO, MIN_LORA_TRAINING_PAIRS } from './constants.js';

const TOGETHER_API_BASE = 'https://api.together.ai/v1';

const MIN_USER_CHARS = 8;
const MIN_ASSISTANT_CHARS = 20;

/**
 * Together chat models verified on the serverless API (per-token, no dedicated endpoint).
 * Note: meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo is listed but returns non-serverless on v1 chat.
 */
export const TOGETHER_DEFAULT_SERVERLESS_CHAT =
  'meta-llama/Meta-Llama-3-8B-Instruct-Lite';

/**
 * Together bases that produce adapters callable on serverless chat (no dedicated endpoint).
 * @see https://docs.together.ai/docs/fine-tuning-quickstart (Qwen3-8B LoRA)
 * @see https://www.together.ai/blog/serverless-multi-lora
 */
export const TOGETHER_LORA_SERVERLESS_FINETUNE_BASE = 'Qwen/Qwen3-8B';

export const TOGETHER_LORA_SERVERLESS_FINETUNE_BASES = new Set([
  TOGETHER_LORA_SERVERLESS_FINETUNE_BASE,
]);

/**
 * Serverless chat model(s) that accept a fine-tuned adapter via the `lora` request field.
 * @see https://www.together.ai/blog/serverless-multi-lora-fine-tune-and-deploy-hundreds-of-adapters-for-model-customization-at-scale
 */
export const TOGETHER_LORA_SERVERLESS_HOST_DEFAULT = 'Qwen/Qwen2.5-7B-Instruct-Turbo';

/** Fine-tune base → serverless host model ids (in try order). */
export const TOGETHER_FINETUNE_BASE_TO_SERVERLESS_HOSTS = {
  [TOGETHER_LORA_SERVERLESS_FINETUNE_BASE]: [
    TOGETHER_LORA_SERVERLESS_HOST_DEFAULT,
    TOGETHER_DEFAULT_SERVERLESS_CHAT,
    'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  ],
};

/** @param {string} [baseTogetherModel] */
export function resolveTogetherServerlessLoraHosts(baseTogetherModel) {
  const base = String(baseTogetherModel || '').trim();
  const mapped = TOGETHER_FINETUNE_BASE_TO_SERVERLESS_HOSTS[base];
  if (mapped?.length) {
    const out = [];
    for (const h of mapped) {
      if (h && !out.includes(h)) out.push(h);
    }
    return out;
  }
  return [TOGETHER_LORA_SERVERLESS_HOST_DEFAULT, TOGETHER_DEFAULT_SERVERLESS_CHAT];
}

/** Map Model Builder open-weight ids → Together LoRA fine-tune base (serverless inference only). */
export const OPEN_SOURCE_TO_TOGETHER_BASE = {
  'qwen3-8b-lora': TOGETHER_LORA_SERVERLESS_FINETUNE_BASE,
  'llama-3.3-70b': TOGETHER_LORA_SERVERLESS_FINETUNE_BASE,
  'qwen-3-72b': TOGETHER_LORA_SERVERLESS_FINETUNE_BASE,
  'mistral-large-3': TOGETHER_LORA_SERVERLESS_FINETUNE_BASE,
  'deepseek-r1': TOGETHER_LORA_SERVERLESS_FINETUNE_BASE,
};

/** Throw if training would produce a dedicated-only adapter (e.g. Llama Reference). */
export function assertTogetherServerlessLoraFinetuneBase(baseModel) {
  const b = String(baseModel || '').trim();
  if (!b) {
    throw new Error('LoRA fine-tune base model is required.');
  }
  if (/Reference/i.test(b)) {
    throw new Error(
      'Llama Reference adapters require a Together dedicated endpoint per model. ' +
        'LYKN uses serverless LoRA only — fine-tune on Qwen/Qwen3-8B (Qwen3 8B in Model Builder).',
    );
  }
  if (!TOGETHER_LORA_SERVERLESS_FINETUNE_BASES.has(b)) {
    throw new Error(
      `LoRA base "${b}" is not enabled for serverless chat. Use ${TOGETHER_LORA_SERVERLESS_FINETUNE_BASE}.`,
    );
  }
}

/** Persona-only fallback when the LoRA adapter id is not callable serverless. */
export const OPEN_SOURCE_TO_TOGETHER_SERVERLESS = {
  'llama-3.3-70b': TOGETHER_DEFAULT_SERVERLESS_CHAT,
  'mistral-large-3': 'Qwen/Qwen2.5-7B-Instruct-Turbo',
  'qwen-3-72b': 'Qwen/Qwen2.5-7B-Instruct-Turbo',
  'deepseek-r1': 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free',
};

/** LoRA fine-tune base id → matching serverless chat model. */
export const TOGETHER_LORA_BASE_TO_SERVERLESS = Object.fromEntries(
  Object.keys(OPEN_SOURCE_TO_TOGETHER_BASE).map((k) => [
    OPEN_SOURCE_TO_TOGETHER_BASE[k],
    OPEN_SOURCE_TO_TOGETHER_SERVERLESS[k],
  ]),
);

export function resolveTogetherBaseModel(openSourceId) {
  const key = String(openSourceId || '').trim();
  return OPEN_SOURCE_TO_TOGETHER_BASE[key] || null;
}

/**
 * Serverless model to use when LoRA / Reference weights are unreachable.
 * @param {{ openSourceId?: string, baseTogetherModel?: string }} opts
 */
export function resolveTogetherServerlessFallback({ openSourceId, baseTogetherModel } = {}) {
  const os = String(openSourceId || '').trim();
  if (os && OPEN_SOURCE_TO_TOGETHER_SERVERLESS[os]) {
    return OPEN_SOURCE_TO_TOGETHER_SERVERLESS[os];
  }
  const base = String(baseTogetherModel || '').trim();
  if (!base) return null;
  if (TOGETHER_LORA_BASE_TO_SERVERLESS[base]) return TOGETHER_LORA_BASE_TO_SERVERLESS[base];
  if (/-Reference$/i.test(base)) {
    return TOGETHER_DEFAULT_SERVERLESS_CHAT;
  }
  if (/Meta-Llama-3\.1-8B-Instruct-Turbo$/i.test(base)) {
    return TOGETHER_DEFAULT_SERVERLESS_CHAT;
  }
  if (/free$/i.test(base)) return base;
  return TOGETHER_DEFAULT_SERVERLESS_CHAT;
}

export function togetherConfigured() {
  return !!String(process.env.TOGETHER_API_KEY || '').trim();
}

function togetherHeaders(json = true) {
  const key = String(process.env.TOGETHER_API_KEY || '').trim();
  if (!key) throw new Error('TOGETHER_API_KEY is not configured');
  const h = { Authorization: `Bearer ${key}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function togetherApiError(body, fallback) {
  const err = body?.error;
  if (err && typeof err === 'object') {
    const msg = err.message || err.type;
    const param = err.param ? ` (${err.param})` : '';
    return msg ? `${msg}${param}` : fallback;
  }
  return body?.message || fallback;
}

export async function uploadTogetherTrainingFile(jsonlBody) {
  const text = String(jsonlBody || '').trim();
  if (!text) throw new Error('Training file is empty.');

  const fileName = 'lykn-training.jsonl';
  const form = new FormData();
  if (typeof File !== 'undefined') {
    form.append('file', new File([text], fileName, { type: 'application/x-ndjson' }));
  } else {
    const blob = new Blob([text], { type: 'application/x-ndjson' });
    form.append('file', blob, fileName);
  }
  form.append('file_name', fileName);
  form.append('purpose', 'fine-tune');
  form.append('file_type', 'jsonl');

  const res = await fetch(`${TOGETHER_API_BASE}/files/upload`, {
    method: 'POST',
    headers: togetherHeaders(false),
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(togetherApiError(body, `Together file upload HTTP ${res.status}`));
  }
  const id = body?.id || body?.file?.id;
  if (!id) throw new Error('Together file upload returned no file id');
  return id;
}

/** Build Together-compatible messages JSONL from canonical LYKN training export. */
export function buildTogetherTrainingJsonl(jsonlContent) {
  const pairs = parseJsonl(jsonlContent);
  const lines = [];
  for (const p of pairs) {
    const user = String(p.prompt || '').trim();
    const assistant = String(p.response || '').trim();
    if (user.length < MIN_USER_CHARS || assistant.length < MIN_ASSISTANT_CHARS) continue;
    lines.push(
      JSON.stringify({
        messages: [
          { role: 'user', content: user },
          { role: 'assistant', content: assistant },
        ],
      }),
    );
  }
  if (lines.length < MIN_LORA_TRAINING_PAIRS) {
    throw new Error(
      `Only ${lines.length} valid training examples after formatting (need ${MIN_LORA_TRAINING_PAIRS}+). ` +
        'Regenerate with vault + past chats enabled, or add more synthesis/vault content.',
    );
  }
  return { jsonl: lines.join('\n'), lineCount: lines.length };
}

export async function retrieveTogetherFile(fileId) {
  const res = await fetch(`${TOGETHER_API_BASE}/files/${encodeURIComponent(fileId)}`, {
    headers: togetherHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(togetherApiError(body, `Together GET file HTTP ${res.status}`));
  }
  return body;
}

export async function waitForTogetherFileProcessed(fileId, { timeoutMs = 180_000, intervalMs = 2500 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await retrieveTogetherFile(fileId);
    if (last?.Processed === true || last?.processed === true) {
      const bytes = Number(last?.bytes || 0);
      if (bytes < 50) {
        throw new Error(
          'Together rejected the training file (empty or invalid JSONL). Regenerate with more vault + chat pairs.',
        );
      }
      return last;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Together did not finish processing the training file in time. Retry in a minute.');
}

export async function createTogetherLoraJob({
  trainingFileId,
  baseModel,
  epochs = 3,
  suffix = 'lykn',
  sampleCount = MIN_LORA_TRAINING_PAIRS,
}) {
  const n = Math.max(1, Math.round(Number(sampleCount) || MIN_LORA_TRAINING_PAIRS));
  // Small corpora: batch 1 + more epochs so Together gets non-zero training steps.
  const batchSize = n < 64 ? 1 : Math.min(8, Math.max(1, Math.floor(n / 4)));
  let nEpochs = Math.max(3, Math.min(20, Math.round(Number(epochs) || 3)));
  if (n < 40) {
    nEpochs = Math.max(nEpochs, Math.min(20, Math.ceil(64 / n)));
  }
  const learningRate = Math.max(1e-8, Math.min(0.01, LORA_LEARNING_RATE));

  const res = await fetch(`${TOGETHER_API_BASE}/fine-tunes`, {
    method: 'POST',
    headers: togetherHeaders(),
    body: JSON.stringify({
      training_file: trainingFileId,
      model: baseModel,
      lora: true,
      n_epochs: nEpochs,
      batch_size: batchSize,
      learning_rate: learningRate,
      warmup_ratio: LORA_WARMUP_RATIO,
      weight_decay: 0,
      max_grad_norm: 1,
      n_checkpoints: 1,
      train_on_inputs: false,
      suffix: String(suffix || 'lykn').slice(0, 64),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(togetherApiError(body, `Together fine-tune HTTP ${res.status}`));
  }
  const jobId = body?.id;
  if (!jobId) throw new Error('Together fine-tune returned no job id');
  return {
    jobId,
    status: body?.status || 'pending',
    outputModelName: body?.model_output_name || body?.model_output_path || null,
    raw: body,
  };
}

/** Map Together fine-tune status → lykn_lora_jobs status. */
export function mapTogetherJobStatus(togetherStatus) {
  const s = String(togetherStatus || '').toLowerCase();
  if (s === 'completed' || s === 'succeeded' || s === 'success') return 'ready';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'uploading') return 'uploading';
  return 'running';
}

export async function getTogetherFineTuneJob(externalJobId) {
  const res = await fetch(`${TOGETHER_API_BASE}/fine-tunes/${encodeURIComponent(externalJobId)}`, {
    headers: togetherHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message || body?.message || `Together GET fine-tune HTTP ${res.status}`);
  }
  const status = mapTogetherJobStatus(body?.status);
  const outputModelId =
    body?.model_output_name ||
    body?.model_output_path ||
    body?.fine_tuned_model ||
    body?.output?.model_name ||
    null;
  const err =
    body?.error?.message ||
    body?.error ||
    (typeof body?.message === 'string' ? body.message : null);
  return {
    status,
    outputModelId: outputModelId ? String(outputModelId) : null,
    errorMessage: status === 'failed' ? String(err || 'Fine-tune failed') : null,
    raw: body,
  };
}

export function isTogetherInferenceModel(modelId) {
  const m = String(modelId || '').trim();
  if (!m.includes('/')) return false;
  const lower = m.toLowerCase();
  if (lower.startsWith('gpt-') || lower.startsWith('claude-') || lower.startsWith('gemini')) {
    return false;
  }
  return true;
}

/** LoRA weights need a running dedicated endpoint on Together. */
export function isTogetherDedicatedEndpointError(message) {
  return /non-serverless|dedicated endpoint|unable to access non-serverless/i.test(
    String(message || ''),
  );
}

/** Together rejected this model id for chat — try the next id in the LoRA fallback chain. */
export function isTogetherLoraInferenceRetryableError(message) {
  const m = String(message || '');
  return (
    isTogetherDedicatedEndpointError(m) ||
    /unable to access model|view the list of supported models|model not found|invalid model/i.test(
      m,
    )
  );
}

/** Together console page to start a dedicated endpoint for a fine-tuned / LoRA model. */
export function togetherModelDashboardUrl(modelId) {
  const m = String(modelId || '').trim();
  if (!m) return 'https://api.together.ai/';
  return `https://api.together.ai/models/${encodeURIComponent(m)}`;
}
