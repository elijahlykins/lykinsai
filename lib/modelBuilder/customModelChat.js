import { getCustomModel } from '../../custom-models-service.js';
import {
  getLatestLoraJobForModelSynced,
  resolveLoraInferenceModelId,
} from '../lora/loraJobService.js';
import { resolveTogetherServerlessFallback } from '../lora/togetherLora.js';
import { getCustomModelTogetherChatParams } from '../lora/togetherLoraChat.js';
import { resolveTogetherServerlessLoraInference } from '../lora/togetherServerlessLora.js';
import { buildCustomModelChatOverlay } from './customModelPrompt.js';

/**
 * Load published custom model + prompt overlay for main chat.
 */
export async function resolveCustomModelChatContext(client, userId, customModelId) {
  if (!client || !userId || !customModelId) {
    return {
      model: null,
      overlay: buildCustomModelChatOverlay(null),
      loraJob: null,
    };
  }
  const row = await getCustomModel(client, userId, String(customModelId).trim());
  let loraJob = null;
  if (row?.trainingMode === 'lora') {
    loraJob = await getLatestLoraJobForModelSynced(client, userId, row.id);
  }
  const overlay = buildCustomModelChatOverlay(row, { loraJob });
  const loraOutputId = resolveLoraInferenceModelId(row, loraJob);
  if (loraOutputId) {
    const baseTogether = loraJob?.baseTogetherModel;
    const serverless = resolveTogetherServerlessLoraInference(loraOutputId, baseTogether);
    const cachedHost =
      row?.metadata?.lora_serverless_host_model || loraJob?.metadata?.lora_serverless_host_model;
    const hostCandidates = cachedHost
      ? [cachedHost, ...serverless.hostCandidates.filter((h) => h !== cachedHost)]
      : serverless.hostCandidates;

    overlay.modelId = hostCandidates[0];
    overlay.loraActive = true;
    overlay.loraOutputModelId = loraOutputId;
    overlay.loraAdapterId = loraOutputId;
    overlay.loraServerlessHostModel = hostCandidates[0];
    overlay.loraServerlessHostCandidates = hostCandidates;
    overlay.loraInferenceMode = 'serverless-multi-lora';
    overlay.loraInferenceCandidates = hostCandidates;
    overlay.loraFallbackModelId = resolveTogetherServerlessFallback({
      openSourceId: row.baseModelId,
      baseTogetherModel: baseTogether,
    });
    overlay.togetherChatParams = getCustomModelTogetherChatParams(row);
    overlay.useTogetherMultiTurn = true;
  }
  return { model: row, overlay, loraJob };
}

/**
 * Provider retry chain.
 * LoRA: try serverless host models (with `lora` adapter field), then persona-only base, then other providers.
 */
export function buildProviderModelChain(primaryModel, overlay, getFallbackModels) {
  const chain = [];
  const seen = new Set();
  const add = (m) => {
    const id = String(m || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    chain.push(id);
  };

  if (overlay?.loraActive && overlay?.loraAdapterId && overlay?.loraServerlessHostCandidates?.length) {
    for (const h of overlay.loraServerlessHostCandidates) add(h);
    const loraBase = overlay.loraFallbackModelId;
    if (loraBase) add(loraBase);
    for (const m of getFallbackModels(primaryModel) || []) add(m);
    return chain;
  }

  add(primaryModel);
  const loraBase = overlay?.loraFallbackModelId;
  if (loraBase && loraBase !== primaryModel) add(loraBase);
  for (const m of getFallbackModels(primaryModel) || []) add(m);
  return chain;
}

/**
 * Prepend [CUSTOM_MODEL] + behavior notes before the assembled prompt.
 * Runtime uses LYKN_CUSTOM_MODEL_RUNTIME_STATIC (no default LYKN identity).
 */
export function applyCustomModelOverlayToPrompt(prompt, overlay) {
  const sections = overlay?.promptSections || [];
  if (!sections.length) return prompt;
  const customBlock = sections.join('\n\n');
  return `${customBlock}\n\n${String(prompt || '').trim()}`.trim();
}

/** @param {boolean} baseSkip */
export function shouldSkipSynthesisBeliefsForCustomModel(baseSkip, overlay) {
  if (baseSkip) return true;
  return !!overlay?.skipSynthesisBeliefs;
}
