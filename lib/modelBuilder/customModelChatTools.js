import { CHAT_TOOL_NAMES } from '../../mcp-tools/chatTools.js';
import {
  DEFAULT_MODEL_CAPABILITIES,
  capabilitiesToRuntimeToolNames,
  runtimeToolsToCapabilities,
  sanitizeModelCapabilities,
} from './modelCapabilitiesCatalog.js';

/** @deprecated Use DEFAULT_MODEL_CAPABILITIES — kept for legacy imports. */
export const DEFAULT_CUSTOM_MODEL_CHAT_TOOLS = capabilitiesToRuntimeToolNames(
  DEFAULT_MODEL_CAPABILITIES,
);

const CHAT_TOOL_NAME_SET = new Set(CHAT_TOOL_NAMES);

/** @param {unknown} raw */
export function sanitizeChatToolNames(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const name of raw) {
    const n = String(name || '').trim();
    if (!n || !CHAT_TOOL_NAME_SET.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Resolve tool config from model metadata.
 * - `chat_tools_enabled: false` → off
 * - `model_capabilities` → mapped runtime tools (preferred)
 * - `chat_tool_names` array → explicit legacy list
 * - otherwise → default capability pack
 */
export function resolveCustomModelChatTools(metadata = {}) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  if (meta.chat_tools_enabled === false || meta.chatToolsEnabled === false) {
    return { enabled: false, toolNames: [], tools: [] };
  }

  const capsRaw = meta.model_capabilities ?? meta.modelCapabilities ?? null;
  if (Array.isArray(capsRaw)) {
    const capabilities = sanitizeModelCapabilities(capsRaw);
    const toolNames = sanitizeChatToolNames(capabilitiesToRuntimeToolNames(capabilities));
    return {
      enabled: toolNames.length > 0,
      toolNames,
      capabilities,
    };
  }

  const raw =
    meta.chat_tool_names ?? meta.chatToolNames ?? meta.enabled_chat_tools ?? null;
  if (Array.isArray(raw)) {
    const toolNames = sanitizeChatToolNames(raw);
    return {
      enabled: toolNames.length > 0,
      toolNames,
      capabilities: runtimeToolsToCapabilities(toolNames),
    };
  }

  const toolNames = sanitizeChatToolNames(
    capabilitiesToRuntimeToolNames(DEFAULT_MODEL_CAPABILITIES),
  );
  return {
    enabled: toolNames.length > 0,
    toolNames,
    capabilities: [...DEFAULT_MODEL_CAPABILITIES],
  };
}
