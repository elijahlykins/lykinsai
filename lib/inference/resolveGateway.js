/**
 * Decide which inference gateway serves a resolved LYKN model id.
 *
 * LYKN owns model selection. This module only picks transport:
 * OpenRouter, a direct provider, or (later) local.
 *
 * Default: when OPENROUTER_API_KEY is set, every routed chat model goes
 * through OpenRouter so billing is one ledger. LYKN_CHAT_GATEWAY=direct
 * keeps curated models on native lab APIs (debug / incident escape hatch).
 * Synced catalog models always use OpenRouter when the key is set.
 */

import {
  GATEWAYS,
  getModel,
  openRouterIdFor,
  providerForCatalogId,
  resolveUpstream,
} from '../models/registry.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const XAI_BASE_URL = 'https://api.x.ai/v1';

export function openRouterConfigured(env = process.env) {
  return Boolean(String(env.OPENROUTER_API_KEY || '').trim());
}

export function chatGatewayOverride(env = process.env) {
  const raw = String(env.LYKN_CHAT_GATEWAY || '').trim().toLowerCase();
  if (raw === GATEWAYS.OPENROUTER || raw === GATEWAYS.DIRECT) return raw;
  return null;
}

/**
 * @returns {{
 *   gateway: string,
 *   provider: string,
 *   upstreamId: string,
 *   baseUrl: string|null,
 *   keyVar: string,
 *   extraHeaders: Record<string, string>,
 * }}
 */
export function resolveInferenceTarget(modelId, env = process.env) {
  const def = getModel(modelId);
  const upstream = resolveUpstream(modelId);
  const provider = upstream?.provider || providerForCatalogId(modelId) || 'unknown';
  const override = chatGatewayOverride(env);
  const orReady = openRouterConfigured(env);
  const catalogModel = def?.visibility === 'catalog' || upstream?.gateway === GATEWAYS.OPENROUTER;
  const forceDirect = override === GATEWAYS.DIRECT;
  const openRouterId = def?.openRouterId
    || openRouterIdFor(provider, upstream?.upstreamId || modelId)
    || upstream?.upstreamId
    || modelId;

  // Catalog rows are OpenRouter-only. Curated models also go through
  // OpenRouter whenever a key is present, unless the operator pins direct.
  const wantsOpenRouter = Boolean(
    orReady && (catalogModel || !forceDirect || override === GATEWAYS.OPENROUTER),
  );

  if (wantsOpenRouter) {
    return {
      gateway: GATEWAYS.OPENROUTER,
      provider,
      upstreamId: openRouterId,
      baseUrl: OPENROUTER_BASE_URL,
      keyVar: 'OPENROUTER_API_KEY',
      extraHeaders: openRouterHeaders(env),
    };
  }

  if (provider === 'openai') {
    return {
      gateway: GATEWAYS.DIRECT,
      provider,
      upstreamId: upstream?.upstreamId || modelId,
      baseUrl: OPENAI_BASE_URL,
      keyVar: 'OPENAI_API_KEY',
      extraHeaders: {},
    };
  }
  if (provider === 'xai') {
    return {
      gateway: GATEWAYS.DIRECT,
      provider,
      upstreamId: upstream?.upstreamId || modelId,
      baseUrl: XAI_BASE_URL,
      keyVar: 'XAI_API_KEY',
      extraHeaders: {},
    };
  }
  if (provider === 'anthropic') {
    return {
      gateway: GATEWAYS.DIRECT,
      provider,
      upstreamId: upstream?.upstreamId || modelId,
      baseUrl: 'https://api.anthropic.com',
      keyVar: 'ANTHROPIC_API_KEY',
      extraHeaders: {},
    };
  }
  if (provider === 'google') {
    return {
      gateway: GATEWAYS.DIRECT,
      provider,
      upstreamId: upstream?.upstreamId || modelId,
      baseUrl: 'https://generativelanguage.googleapis.com',
      keyVar: 'GOOGLE_API_KEY',
      extraHeaders: {},
    };
  }

  return {
    gateway: GATEWAYS.DIRECT,
    provider,
    upstreamId: modelId,
    baseUrl: null,
    keyVar: '',
    extraHeaders: {},
  };
}

export function openRouterHeaders(env = process.env) {
  const referer = String(env.OPENROUTER_HTTP_REFERER || env.LYKN_PUBLIC_ORIGIN || 'https://lykn.io').trim();
  return {
    'HTTP-Referer': referer.slice(0, 200),
    'X-Title': 'LYKN',
  };
}

export function isOpenRouterTarget(modelId, env = process.env) {
  return resolveInferenceTarget(modelId, env).gateway === GATEWAYS.OPENROUTER;
}
