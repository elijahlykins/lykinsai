/**
 * Format a published custom model for injection into /api/ai chat prompts.
 */

import {
  formatResponseLengthPromptNote,
  formatTonePromptNote,
  getModelBehaviorFromMetadata,
} from './modelBehavior.js';
import { resolveCustomModelChatTools } from './customModelChatTools.js';
import { resolvePublishedModelSystemPrompt } from './syncSystemPromptBasics.js';
import { customModelVaultKnowledgeInstruction } from './customModelKnowledge.js';

export function resolveCustomModelChatModelId(model) {
  const id = String(model?.baseModelId || '').trim();
  return id || null;
}

export function formatCustomModelBeliefsSection(model) {
  const beliefs = Array.isArray(model?.beliefs) ? model.beliefs : [];
  const rules = Array.isArray(model?.rules) ? model.rules : [];
  if (!beliefs.length && !rules.length) {
    return { text: '', hasOverrides: false };
  }
  const lines = [
    '[CUSTOM_MODEL_BELIEFS_AND_RULES]',
    `Model: ${model.name}`,
    'These beliefs and if-then rules come from the user\'s Model Builder publish. Prefer them over generic synthesis defaults when they conflict.',
    '',
  ];
  if (beliefs.length) {
    lines.push('Beliefs:');
    for (const b of beliefs) lines.push(`- ${String(b).trim()}`);
    lines.push('');
  }
  if (rules.length) {
    lines.push('Rules:');
    for (const r of rules) {
      const iff = String(r?.if || '').trim();
      const then = String(r?.then || '').trim();
      if (iff && then) lines.push(`- IF ${iff} THEN ${then}`);
    }
    lines.push('');
  }
  return { text: lines.join('\n').trim(), hasOverrides: true };
}

export function formatCustomModelSystemSection(model, { loraJob } = {}) {
  const name = String(model?.name || 'Custom model').trim();
  const prompt = resolvePublishedModelSystemPrompt(model);
  if (!prompt) return '';

  const mode = model.trainingMode || 'prompt_only';
  let modeLine =
    'Training: prompt assembly — beliefs and system prompt injected each turn (no weight change).';
  if (mode === 'lora') {
    if (loraJob?.status === 'ready' && loraJob.outputModelId) {
      modeLine =
        `Training: LoRA adapter trained (${loraJob.outputModelId}). Chat uses Together serverless Multi-LoRA (host + lora fields, per-token). If unavailable, falls back to open-weight base with this persona.`;
    } else if (loraJob?.status === 'running' || loraJob?.status === 'uploading' || loraJob?.status === 'queued') {
      modeLine = 'Training: LoRA job in progress — using prompt stack until the adapter is ready.';
    } else {
      modeLine =
        'Training: LoRA selected — start a LoRA run in Model Builder when your JSONL is ready. Until then, prompt stack only.';
    }
  }

  const lines = [
    '[CUSTOM_MODEL]',
    `You are "${name}". "${name}" is YOUR name (the assistant), not the user's name.`,
    '',
    'Name / identity questions — answer ONLY the latest question, one or two short sentences:',
    `- "What's your name?" / "Who are you?" → "I'm ${name}." (optional: one line on what you do). NEVER say "you are ${name}" — that would name the user wrong.`,
    `- "Are you ${name}?" / "Is this ${name}?" → "Yes — I'm ${name}."`,
    `- "Which model is this?" → Name yourself as ${name}; mention LYKN only if they ask about the platform.`,
    `Do NOT say you are not ${name}. Do NOT call the user "${name}".`,
    `Do NOT open with "How can I help you today?", "I'm here to assist…", or generic chatbot greetings unless they asked for help.`,
    `Do NOT re-introduce yourself after a long thread unless they asked who you are.`,
    modeLine,
    '',
    '[CUSTOM_MODEL_CHAT_RULES]',
    '- Answer the LATEST user message only; use prior turns for context, not as separate questions to re-answer.',
    '- Do not repeat introductions or re-hash old answers unless the user asks.',
    '- Short follow-ups ("yes", "that one", "what\'s your name") refer to the immediately previous exchange or the literal question.',
    '',
    'Persona brief (tone, boundaries, response style):',
    '',
    prompt,
  ];
  return lines.join('\n').trim();
}

export function buildCustomModelChatOverlay(model, { loraJob } = {}) {
  if (!model) {
    return {
      promptSections: [],
      beliefText: '',
      modelId: null,
      responseLength: null,
      loraFallbackModelId: null,
    };
  }
  const system = formatCustomModelSystemSection(model, { loraJob });
  const { text: beliefText } = formatCustomModelBeliefsSection(model);
  const behavior = getModelBehaviorFromMetadata(model?.metadata || {});
  const behaviorNotes = [
    formatResponseLengthPromptNote(behavior.responseLength),
    formatTonePromptNote(behavior.responseTone),
  ].filter(Boolean);
  const toolsCfg = resolveCustomModelChatTools(model?.metadata || {});
  const toolsNote =
    toolsCfg.enabled && toolsCfg.toolNames.length
      ? [
          '[CUSTOM_MODEL_TOOLS]',
          `Agent mode: you may call these LYKN tools when needed (do not invent tool names): ${toolsCfg.toolNames.join(', ')}.`,
          'Prefer reads before writes; confirm before destructive project actions.',
        ].join('\n')
      : '';
  const vaultKnowledgeNote = customModelVaultKnowledgeInstruction(model);
  const promptSections = [system, ...behaviorNotes, vaultKnowledgeNote, toolsNote].filter(Boolean);
  return {
    promptSections,
    beliefText,
    modelId: resolveCustomModelChatModelId(model),
    modelName: model.name,
    loraActive: false,
    chatToolsEnabled: toolsCfg.enabled,
    chatToolNames: toolsCfg.toolNames,
    responseLength:
      behavior.responseLength && behavior.responseLength !== 'medium'
        ? behavior.responseLength
        : null,
    loraFallbackModelId: null,
  };
}
