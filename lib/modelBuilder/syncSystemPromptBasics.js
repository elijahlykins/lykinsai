import {
  getModelBehaviorFromMetadata,
  mergeBehaviorIntoSystemPrompt,
} from './modelBehavior.js';

const DEFAULT_ROLE =
  "Personal knowledge assistant grounded in their beliefs and saved work.";

/**
 * Rebuild the ## Identity block from Basics name + description.
 * @param {string} systemPrompt
 * @param {{ name?: string, description?: string }} basics
 */
export function mergeBasicsIntoSystemPrompt(systemPrompt, { name, description } = {}) {
  const base = String(systemPrompt || "").trim();
  const desc = String(description || "").trim();

  const identityLines = [
    "## Identity",
    `- Name: {{model_name}}`,
    ...(desc ? [`- Purpose: ${desc}`] : []),
    `- Role: ${DEFAULT_ROLE}`,
  ];
  const identityBlock = identityLines.join("\n");

  const identityRe = /## Identity[\s\S]*?(?=\n## |\n*$)/;
  if (identityRe.test(base)) {
    return base.replace(identityRe, identityBlock).trim();
  }

  return `${identityBlock}\n\n${base}`.trim();
}

/** Chat-time prompt: merge Basics + behavior from metadata + substitute model name. */
export function resolvePublishedModelSystemPrompt(model) {
  const name = String(model?.name || "Custom model").trim();
  const description =
    String(model?.metadata?.description || model?.metadata?.modelDescription || "").trim();
  const behavior = getModelBehaviorFromMetadata(model?.metadata || {});
  let prompt = mergeBehaviorIntoSystemPrompt(
    mergeBasicsIntoSystemPrompt(model?.systemPrompt, {
      name: model?.name,
      description,
    }),
    behavior,
  );
  prompt = prompt.replace(/\{\{model_name\}\}/gi, name);
  return prompt.trim();
}
