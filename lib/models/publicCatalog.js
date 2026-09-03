/**
 * Marketing-safe OpenRouter model list for the public landing ticker.
 * Names and lab logos only - no pricing, capabilities, or selectable ids
 * that a client could submit as a chat model.
 */

import { MODEL_VISIBILITY, listModels, listRecommendedModels } from './registry.js';

export const MODELS_DEV_LOGO_PREFIX = 'https://models.dev/logos/';

const LOGO_SLUG = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gemini',
  gemini: 'gemini',
  xai: 'xai',
  'x-ai': 'xai',
  grok: 'xai',
  'meta-llama': 'meta',
  meta: 'meta',
  llama: 'meta',
  mistralai: 'mistral',
  mistral: 'mistral',
  deepseek: 'deepseek',
  qwen: 'qwen',
  alibaba: 'alibaba',
  cohere: 'cohere',
  amazon: 'amazon',
  'amazon-bedrock': 'amazon',
  nvidia: 'nvidia',
  perplexity: 'perplexity',
  moonshotai: 'moonshot',
  moonshot: 'moonshot',
  'z-ai': 'zhipu',
  zhipuai: 'zhipu',
  zhipu: 'zhipu',
  minimax: 'minimax',
  ai21: 'ai21',
  inflection: 'inflection',
  microsoft: 'microsoft',
  nousresearch: 'nousresearch',
  huggingface: 'huggingface',
  liquid: 'liquid',
  together: 'together',
  fireworks: 'fireworks',
  cerebras: 'cerebras',
  groq: 'groq',
});

const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const SKIP_ID = /embed|rerank|whisper|tts|moderation|guard|image-preview/i;

/** Well-known OpenRouter labs shown even before the live catalog syncs. */
const MARKETING_EXTRA = Object.freeze([
  { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', provider: 'meta' },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', provider: 'deepseek' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large', provider: 'mistral' },
  { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3', provider: 'qwen' },
  { id: 'moonshotai/kimi-k2', name: 'Kimi K2', provider: 'moonshot' },
  { id: 'cohere/command-a', name: 'Command A', provider: 'cohere' },
  { id: 'z-ai/glm-4.5', name: 'GLM 4.5', provider: 'zhipu' },
  { id: 'amazon/nova-pro-v1', name: 'Amazon Nova', provider: 'amazon' },
  { id: 'nvidia/llama-nemotron', name: 'NVIDIA Nemotron', provider: 'nvidia' },
  { id: 'perplexity/sonar-pro', name: 'Sonar Pro', provider: 'perplexity' },
  { id: 'minimax/minimax-m1', name: 'MiniMax', provider: 'minimax' },
  { id: 'microsoft/phi-4', name: 'Phi-4', provider: 'microsoft' },
  { id: 'ai21/jamba-large', name: 'Jamba', provider: 'ai21' },
  { id: 'inflection/inflection-3', name: 'Inflection 3', provider: 'inflection' },
  { id: 'liquid/lfm-2', name: 'LFM 2', provider: 'liquid' },
  { id: 'nousresearch/hermes-4', name: 'Hermes 4', provider: 'nousresearch' },
]);

export function logoUrlForProvider(provider) {
  const raw = String(provider || '').toLowerCase().trim();
  const mapped = LOGO_SLUG[raw];
  const slug = mapped || (SLUG_RE.test(raw) ? raw : null);
  if (!slug) return null;
  return `${MODELS_DEV_LOGO_PREFIX}${slug}.svg`;
}

function displayName(def) {
  return String(def.label || def.id || '')
    .replace(/^[^:]+:\s*/, '')
    .trim()
    .slice(0, 80);
}

function toPublic(def) {
  if (!def || SKIP_ID.test(String(def.id || ''))) return null;
  const outputs = def.modalities?.output;
  if (Array.isArray(outputs) && outputs.length && !outputs.includes('text')) return null;
  const logoUrl = logoUrlForProvider(def.provider);
  const name = displayName(def);
  const id = String(def.id || '').trim();
  if (!id || !name || !logoUrl) return null;
  return { id, name, logoUrl };
}

function extraPublic(row) {
  const logoUrl = logoUrlForProvider(row.provider);
  if (!logoUrl) return null;
  return { id: row.id, name: row.name, logoUrl };
}

/**
 * Diverse lab sample for the landing ticker. Recommended curated models
 * first, then one flagship per other OpenRouter lab, then a short extra
 * list so the ticker still looks like the full catalog before sync.
 */
export function listPublicMarketingModels({ limit = 40 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 40, 1), 50);
  const seenIds = new Set();
  const seenProviders = new Set();
  const out = [];

  const push = (row, provider) => {
    if (!row || seenIds.has(row.id) || out.length >= max) return;
    seenIds.add(row.id);
    if (provider) seenProviders.add(provider);
    out.push(row);
  };

  for (const def of listRecommendedModels()) {
    push(toPublic(def), def.provider);
  }

  for (const def of listModels({ visibility: MODEL_VISIBILITY.CATALOG })) {
    if (seenProviders.has(def.provider)) continue;
    push(toPublic(def), def.provider);
  }

  for (const extra of MARKETING_EXTRA) {
    if (seenProviders.has(extra.provider)) continue;
    push(extraPublic(extra), extra.provider);
  }

  return { models: out.slice(0, max) };
}
