/**
 * Together serverless Multi-LoRA — per-token adapter chat (no dedicated GPU).
 *
 * Fine-tune `output_name` is NOT the chat `model` on serverless. Pass:
 *   { model: <serverless host>, lora: <fine-tune output_name> }
 *
 * @see https://www.together.ai/blog/serverless-multi-lora-fine-tune-and-deploy-hundreds-of-adapters-for-model-customization-at-scale
 */

import {
  isTogetherLoraInferenceRetryableError,
  resolveTogetherServerlessLoraHosts,
  TOGETHER_LORA_SERVERLESS_HOST_DEFAULT,
} from './togetherLora.js';

/** Errors that mean "this host/adapter pair isn't available on serverless right now". */
export function isTogetherServerlessLoraUnavailableError(message) {
  return isTogetherLoraInferenceRetryableError(message);
}

/**
 * @param {string} adapterModelId Fine-tune output_name (e.g. admin_f613/Qwen3-8B-lykn-…)
 * @param {string} [baseTogetherModel] Together base used for training (e.g. Qwen/Qwen3-8B)
 */
export function resolveTogetherServerlessLoraInference(adapterModelId, baseTogetherModel) {
  const adapterId = String(adapterModelId || '').trim();
  const hostCandidates = resolveTogetherServerlessLoraHosts(baseTogetherModel);
  return {
    adapterId,
    hostModel: hostCandidates[0] || TOGETHER_LORA_SERVERLESS_HOST_DEFAULT,
    hostCandidates,
    mode: 'serverless-multi-lora',
  };
}

/** @deprecated Use resolveTogetherServerlessLoraInference — adapter id alone is not a serverless model. */
export function buildTogetherLoraInferenceCandidates(outputModelId) {
  const inf = resolveTogetherServerlessLoraInference(outputModelId);
  return inf.hostCandidates;
}

/** @deprecated */
export function resolveTogetherServerlessLoraChatModel(outputModelId, baseTogetherModel) {
  const inf = resolveTogetherServerlessLoraInference(outputModelId, baseTogetherModel);
  return {
    modelId: inf.hostModel,
    candidates: inf.hostCandidates,
    adapterId: inf.adapterId,
    mode: inf.mode,
  };
}

/**
 * Probe serverless Multi-LoRA: host model + `lora` adapter field.
 */
export async function probeTogetherServerlessLoraPair(
  hostModel,
  adapterId,
  { timeoutMs = 25_000 } = {},
) {
  const model = String(hostModel || '').trim();
  const lora = String(adapterId || '').trim();
  if (!model || !lora || !process.env.TOGETHER_API_KEY) {
    return { ok: false, error: 'not_configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.together.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        lora,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    const errMsg = body?.error?.message || '';
    if (res.ok) {
      return { ok: true, hostModel: model, adapterId: lora };
    }
    if (isTogetherServerlessLoraUnavailableError(errMsg)) {
      return { ok: false, error: 'serverless_unavailable', message: errMsg };
    }
    return { ok: false, error: 'request_failed', status: res.status, message: errMsg };
  } catch (e) {
    return { ok: false, error: 'fetch_failed', message: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Pick first host that serves this adapter on serverless Multi-LoRA. */
export async function pickWorkingServerlessLoraPair(adapterId, baseTogetherModel) {
  const adapter = String(adapterId || '').trim();
  const hostCandidates = resolveTogetherServerlessLoraHosts(baseTogetherModel);
  for (const hostModel of hostCandidates) {
    const probe = await probeTogetherServerlessLoraPair(hostModel, adapter);
    if (probe.ok) {
      return { hostModel, adapterId: adapter, hostCandidates, probed: true };
    }
  }
  return {
    hostModel: hostCandidates[0] || TOGETHER_LORA_SERVERLESS_HOST_DEFAULT,
    adapterId: adapter,
    hostCandidates,
    probed: false,
  };
}

/** @deprecated Use probeTogetherServerlessLoraPair */
export async function probeTogetherServerlessLoraModel(modelId, opts) {
  return probeTogetherServerlessLoraPair(modelId, '', opts);
}

/** @deprecated Use pickWorkingServerlessLoraPair */
export async function pickWorkingServerlessLoraModel(outputModelId, baseTogetherModel) {
  return pickWorkingServerlessLoraPair(outputModelId, baseTogetherModel);
}

/**
 * Build Together chat/completions JSON body (stream optional).
 * @param {{
 *   model: string,
 *   messages: object[],
 *   max_tokens: number,
 *   stream?: boolean,
 *   overlay?: object,
 *   chatParams?: { temperature?: number, top_p?: number, repetition_penalty?: number },
 * }} opts
 */
export function buildTogetherChatBody({ model, messages, max_tokens, stream, overlay, chatParams }) {
  const payload = { messages, max_tokens };
  if (stream) payload.stream = true;

  const hosts = overlay?.loraServerlessHostCandidates || [];
  const attachLora =
    overlay?.loraActive &&
    overlay?.loraAdapterId &&
    hosts.includes(String(model || '').trim());

  if (attachLora) {
    payload.model = model;
    payload.lora = overlay.loraAdapterId;
  } else {
    payload.model = model;
  }

  const params = chatParams || overlay?.togetherChatParams;
  if (params && typeof params === 'object') {
    if (params.temperature != null) payload.temperature = params.temperature;
    if (params.top_p != null) payload.top_p = params.top_p;
    if (params.repetition_penalty != null) payload.repetition_penalty = params.repetition_penalty;
  }

  return payload;
}
