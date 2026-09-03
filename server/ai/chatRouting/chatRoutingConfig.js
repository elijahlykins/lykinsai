// Single configuration surface for Auto chat routing.
// Model IDs come from the existing catalog (modelInvoke / modelCatalog),
// not invented provider aliases.

export const CHAT_MODEL_TIERS = Object.freeze({
  FAST: 'fast',
  STANDARD: 'standard',
  ADVANCED: 'advanced',
});

export const ROUTING_SOURCES = Object.freeze({
  HEURISTIC: 'heuristic',
  CLASSIFIER: 'classifier',
  OVERRIDE: 'override',
  FALLBACK: 'fallback',
  USER_SETUP: 'user_setup',
  ROUTE: 'route',
});

// Lowest-cost quality-appropriate OpenAI chat model currently in LYKN pricing.
export const CHAT_ROUTE_MODELS = Object.freeze({
  fast: 'gpt-5.6-luna',
  standard: 'gpt-5.6-terra',
  advanced: 'gpt-5.6-sol',
});

export const AUTO_ROUTED_MODEL_IDS = Object.freeze([
  'lykn',
  'lykn-lite',
  'lykn-fast',
  'lykn-deep',
  'unified-auto',
  'lykn-setup',
]);

export const REASONING_EFFORTS = Object.freeze([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

// Quality-biased defaults. Cheap only when we are confident quality matches.
export const CHAT_ROUTING_THRESHOLDS = Object.freeze({
  // Escalate away from fast unless we are this sure cheap is equivalent.
  fastMinConfidence: 0.78,
  // Escalate to advanced when we are at least this sure standard will underperform.
  advancedMinConfidence: 0.7,
  // Max may use the strongest model a bit more readily.
  maxAdvancedMinConfidence: 0.55,
  classifierTimeoutMs: 400,
  classifierMaxOutputTokens: 60,
  classifierModel: 'gpt-4.1-nano',
});

export const CHAT_ROUTING_LENGTHS = Object.freeze({
  // Structural bands only - not keyword lists.
  maybeFastMaxChars: 240,
  advancedSoftChars: 1200,
  advancedHardChars: 2500,
  largeContextChars: 4000,
});

export const PLAN_REASONING_DEFAULTS = Object.freeze({
  default: {
    fast: 'none',
    standard: 'low',
    advanced: 'high',
  },
  max: {
    fast: 'none',
    standard: 'medium',
    advanced: 'high',
  },
});

export const BILLABLE_COMPUTE_TOOL_NAMES = Object.freeze([
  'lykn_generate_image',
  'lykn_process_image',
  'lykn_render_video',
  'lykn_generate_video',
]);

export const CHAT_ACTION_TYPES = Object.freeze([
  'chat_short',
  'chat_long',
  'chat_complex',
]);

export const CHAT_USAGE_GATE_PATHS = Object.freeze([
  '/api/ai/stream',
  '/api/ai/invoke',
]);

export function isAutoRoutedModelId(modelId) {
  return AUTO_ROUTED_MODEL_IDS.includes(String(modelId || '').trim());
}

export function isChatActionType(actionType) {
  return CHAT_ACTION_TYPES.includes(String(actionType || ''));
}

export function isBillableComputeTool(name) {
  return BILLABLE_COMPUTE_TOOL_NAMES.includes(String(name || ''));
}

export function classifierEnabled() {
  if (process.env.CHAT_ROUTING_CLASSIFIER === '0') return false;
  if (process.env.CHAT_ROUTING_CLASSIFIER === '1') return true;
  return Boolean(process.env.OPENAI_API_KEY);
}
