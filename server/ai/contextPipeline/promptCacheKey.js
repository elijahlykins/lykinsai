import crypto from 'crypto';
import {
  LYKN_RUNTIME_PROMPT_VERSION,
  LYKN_SYSTEM_PROMPT_VERSION,
  LYKN_TOOLSET_VERSION,
} from './contextConfig.js';

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

export function inferModelFamily(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return 'unknown';
  if (id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4') || id.startsWith('lykn')) return 'openai';
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gemini')) return 'google';
  if (id.startsWith('grok')) return 'xai';
  return id.split('-')[0] || 'unknown';
}

export function personalizationFingerprint(parts = {}) {
  const body = [
    String(parts.userPrompt || '').trim(),
    String(parts.aiName || '').trim(),
    String(parts.responseLength || '').trim(),
  ].join('\n');
  if (!body.trim()) return 'none';
  return shortHash(body);
}

export function buildPromptCacheKey({
  userId,
  modelId,
  systemPromptVersion = LYKN_SYSTEM_PROMPT_VERSION,
  runtimePromptVersion = LYKN_RUNTIME_PROMPT_VERSION,
  toolsetVersion = LYKN_TOOLSET_VERSION,
  personalizationVersion = 'none',
} = {}) {
  const userBound = shortHash(userId || 'anon');
  const family = inferModelFamily(modelId);
  const key = [
    'lykn',
    systemPromptVersion,
    runtimePromptVersion,
    toolsetVersion,
    personalizationVersion || 'none',
    family,
    userBound,
  ].join(':');
  return key.slice(0, 128);
}
