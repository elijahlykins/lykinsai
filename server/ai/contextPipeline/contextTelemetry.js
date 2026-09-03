import { sha256 } from '../promptUtils.js';
import { CONTEXT_SECTION } from './contextConfig.js';
import { splitStablePrefix } from './stablePrefix.js';

export function estimateTokensFromText(text) {
  const n = String(text || '').length;
  return n ? Math.ceil(n / 4) : 0;
}

function sectionTokens(body) {
  return estimateTokensFromText(body);
}

export function classifyPromptSections({
  system = '',
  user = '',
  toolsText = '',
  conversationText = '',
  attachmentText = '',
} = {}) {
  const sys = String(system || '');
  const usr = String(user || '');
  const { stablePrefix } = splitStablePrefix(sys || `${sys}\n\n${usr}`);
  const stable = stablePrefix || sys;
  const convo = conversationText || extractMarkedBlock(usr, '[CONVERSATION');
  const attachments = attachmentText || extractMarkedBlock(usr, '[ATTACHED_IMAGES]');
  const currentTurn = extractMarkedBlock(usr, '[USER]') || extractMarkedBlock(usr, '[LATEST_USER_MESSAGE]');
  const personalization = [
    extractMarkedBlock(sys, '[USER_PREFERENCES]'),
    extractMarkedBlock(sys, '[ASSISTANT_IDENTITY]'),
  ].filter(Boolean).join('\n');

  const tokens = {
    [CONTEXT_SECTION.STABLE]: sectionTokens(stable),
    [CONTEXT_SECTION.PERSONALIZATION]: sectionTokens(personalization),
    [CONTEXT_SECTION.CONVERSATION]: sectionTokens(convo),
    [CONTEXT_SECTION.ATTACHMENTS]: sectionTokens(attachments),
    [CONTEXT_SECTION.TOOLS]: sectionTokens(toolsText),
    [CONTEXT_SECTION.CURRENT_TURN]: sectionTokens(currentTurn),
    [CONTEXT_SECTION.DYNAMIC]: Math.max(0, sectionTokens(usr) - sectionTokens(convo) - sectionTokens(attachments) - sectionTokens(currentTurn)),
  };

  const totalEstimated = Object.values(tokens).reduce((sum, n) => sum + n, 0);
  return {
    tokens,
    totalEstimatedTokens: totalEstimated,
    hashes: {
      stablePrefix: sha256(stable).slice(0, 12),
    },
    chars: {
      stable: stable.length,
      user: usr.length,
      tools: String(toolsText || '').length,
    },
  };
}

function extractMarkedBlock(text, marker) {
  const raw = String(text || '');
  const start = raw.indexOf(marker);
  if (start < 0) return '';
  const rest = raw.slice(start);
  const next = rest.search(/\n\n\[/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

export function cacheUsageMetrics({ inputTokens = 0, cachedInputTokens = 0 } = {}) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.max(0, Number(cachedInputTokens) || 0);
  const uncached = Math.max(0, input - cached);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    uncached_input_tokens: uncached,
    cache_hit_rate: input > 0 ? cached / input : null,
    uncached_input_ratio: input > 0 ? uncached / input : null,
  };
}

export function contextUsageMetadata(telemetry, cacheMetrics = {}) {
  const tokens = telemetry?.tokens || {};
  return {
    context_stable_tokens: tokens.stable ?? null,
    context_personalization_tokens: tokens.personalization ?? null,
    context_conversation_tokens: tokens.conversation ?? null,
    context_attachment_tokens: tokens.attachments ?? null,
    context_tool_tokens: tokens.tools ?? null,
    context_turn_tokens: tokens.currentTurn ?? null,
    context_total_estimated_tokens: telemetry?.totalEstimatedTokens ?? null,
    context_stable_hash: telemetry?.hashes?.stablePrefix || null,
    ...cacheMetrics,
  };
}
