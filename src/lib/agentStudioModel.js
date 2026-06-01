import {
  AGENT_BUILDER_DEFAULT_MODEL,
  AGENT_BUILDER_MODEL_IDS,
} from "./modelCatalog";
import { isAgentStudioEnabled } from "./agentStudioDev";
import {
  canonicalizeAgentBuilderModelId,
  defaultAgentBuilderModelForPlan,
  isAgentBuilderModelAllowed,
} from "./modelTiers";

const agentStudioOpts = () => ({ devUnlock: isAgentStudioEnabled });

export function isAgentStudioModelAllowed(modelId, planModelTier) {
  return isAgentBuilderModelAllowed(modelId, planModelTier, agentStudioOpts());
}

const STORAGE_KEY = "lykinsai_agent_studio_model";

export function getAgentStudioModel(fallback = AGENT_BUILDER_DEFAULT_MODEL) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const id = canonicalizeAgentBuilderModelId(raw);
    if (id) return id;
  } catch {
    // ignore
  }
  return canonicalizeAgentBuilderModelId(fallback) || AGENT_BUILDER_DEFAULT_MODEL;
}

export function setAgentStudioModel(modelId) {
  const id = canonicalizeAgentBuilderModelId(modelId);
  if (!id) return null;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
  return id;
}

export {
  AGENT_BUILDER_MODEL_IDS,
  AGENT_BUILDER_DEFAULT_MODEL,
  canonicalizeAgentBuilderModelId,
  defaultAgentBuilderModelForPlan,
  isAgentBuilderModelAllowed,
};
