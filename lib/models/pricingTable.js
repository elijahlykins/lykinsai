/**
 * Static model price metadata (USD per 1K tokens).
 *
 * This table is ESTIMATE metadata: pre-request cost estimates, model
 * comparison UI, spending warnings, and the fallback when a gateway does not
 * report authoritative cost. When a gateway (OpenRouter) reports actual
 * generation cost, that figure wins for billing (see lib/usage/usageEvents.js).
 *
 * Moved out of usageTracking.js so the model registry owns price metadata.
 * usageTracking.js re-exports MODEL_PRICING for existing consumers.
 */

export const MODEL_PRICING = {
  // OpenAI
  // GPT-5.6 family (GA July 9, 2026): Sol $5/$30, Terra $2.50/$15, Luna $1/$6 per M.
  // Cached input is 10% of fresh input on the GPT-5 / 5.6 family.
  'gpt-5.6-sol':       { input: 0.005,  output: 0.030, cachedInput: 0.0005 },
  'gpt-5.6-terra':     { input: 0.0025, output: 0.015, cachedInput: 0.00025 },
  'gpt-5.6-luna':      { input: 0.001,  output: 0.006, cachedInput: 0.0001 },
  'gpt-5.5':           { input: 0.005,  output: 0.015, cachedInput: 0.0005 },
  'gpt-5.4':           { input: 0.005,  output: 0.015, cachedInput: 0.0005 },
  'gpt-5.4-pro':       { input: 0.010,  output: 0.030, cachedInput: 0.001 },
  'gpt-5.2':           { input: 0.004,  output: 0.012, cachedInput: 0.0004 },
  'gpt-5.1':           { input: 0.003,  output: 0.010, cachedInput: 0.0003 },
  'gpt-5':             { input: 0.003,  output: 0.010, cachedInput: 0.0003 },
  'gpt-5-mini':        { input: 0.001,  output: 0.004, cachedInput: 0.0001 },
  'gpt-4.1':           { input: 0.002,  output: 0.008, cachedInput: 0.0005 },
  'gpt-4.1-mini':      { input: 0.0004, output: 0.0016, cachedInput: 0.0001 },
  'gpt-4.1-nano':      { input: 0.0001, output: 0.0004, cachedInput: 0.000025 },
  'gpt-4o':            { input: 0.0025, output: 0.010, cachedInput: 0.00125 },
  'gpt-4o-mini':       { input: 0.00015,output: 0.0006, cachedInput: 0.000075 },
  'gpt-5.3-code':      { input: 0.004,  output: 0.012, cachedInput: 0.0004 },
  'o3':                { input: 0.010,  output: 0.040, cachedInput: 0.0025 },
  'o3-pro':            { input: 0.020,  output: 0.080, cachedInput: 0.005 },
  'o4-mini':           { input: 0.0011, output: 0.0044, cachedInput: 0.000275 },

  'gpt-5.5-pro':       { input: 0.010,  output: 0.030, cachedInput: 0.001 },
  'gpt-5.4-mini':      { input: 0.001,  output: 0.004, cachedInput: 0.0001 },
  'gpt-5.4-nano':      { input: 0.0002, output: 0.0008, cachedInput: 0.00002 },
  'gpt-5.2-pro':       { input: 0.010,  output: 0.030, cachedInput: 0.001 },
  'gpt-5-pro':         { input: 0.010,  output: 0.030, cachedInput: 0.001 },
  'gpt-5-nano':        { input: 0.0002, output: 0.0008, cachedInput: 0.00002 },

  // Anthropic — cache read is 10% of input.
  'claude-fable-5':               { input: 0.010, output: 0.050, cachedInput: 0.001 },
  'claude-opus-5':                { input: 0.005, output: 0.025, cachedInput: 0.0005 },
  'claude-sonnet-5':              { input: 0.002, output: 0.010, cachedInput: 0.0002 },
  'claude-sonnet-4-6':            { input: 0.003, output: 0.015, cachedInput: 0.0003 },
  'claude-sonnet-4-5':            { input: 0.003, output: 0.015, cachedInput: 0.0003 },
  'claude-opus-4-20250514':       { input: 0.015, output: 0.075, cachedInput: 0.0015 },
  'claude-opus-4-8':              { input: 0.005, output: 0.025, cachedInput: 0.0005 },
  'claude-opus-4-7':              { input: 0.005, output: 0.025, cachedInput: 0.0005 },
  'claude-opus-4-6':              { input: 0.005, output: 0.025, cachedInput: 0.0005 },
  'claude-opus-4-5':              { input: 0.005, output: 0.025, cachedInput: 0.0005 },
  'claude-sonnet-4-20250514':     { input: 0.003, output: 0.015, cachedInput: 0.0003 },
  'claude-haiku-4-5':             { input: 0.001, output: 0.005, cachedInput: 0.0001 },
  'claude-haiku-4-5-20251001':    { input: 0.001, output: 0.005, cachedInput: 0.0001 },
  'claude-3-5-haiku-20241022':    { input: 0.0008, output: 0.004, cachedInput: 0.00008 },
  'claude-3-5-sonnet-20241022':   { input: 0.003, output: 0.015, cachedInput: 0.0003 },

  // Google Gemini — explicit context-cache reads are 25% of input.
  'gemini-3.1-pro-preview':  { input: 0.00125, output: 0.005, cachedInput: 0.0003125 },
  'gemini-3.6-flash':        { input: 0.0015, output: 0.0075, cachedInput: 0.000375 },
  'gemini-3.5-flash':        { input: 0.0015, output: 0.009, cachedInput: 0.000375 },
  'gemini-3.5-flash-lite':   { input: 0.0003, output: 0.0025, cachedInput: 0.000075 },
  'gemini-3.1-flash-lite':   { input: 0.00025, output: 0.0015, cachedInput: 0.0000625 },
  'gemini-3-flash-preview':  { input: 0.00015, output: 0.0006, cachedInput: 0.0000375 },
  'gemini-2.5-pro':          { input: 0.00125, output: 0.01, cachedInput: 0.0003125 },
  'gemini-2.5-flash':        { input: 0.0003, output: 0.0025, cachedInput: 0.000075 },
  'gemini-2.5-pro-preview-05-06': { input: 0.00125, output: 0.01, cachedInput: 0.0003125 },
  'gemini-2.5-flash-preview-05-20': { input: 0.00015, output: 0.0006, cachedInput: 0.0000375 },
  'gemini-2.0-flash':        { input: 0.0001, output: 0.0004, cachedInput: 0.000025 },
  'gemini-pro-latest':       { input: 0.00125, output: 0.01, cachedInput: 0.0003125 },
  'gemini-flash-latest':     { input: 0.0001, output: 0.0004, cachedInput: 0.000025 },

  // xAI / Grok
  'grok-4.6':   { input: 0.002, output: 0.006, cachedInput: 0.0005 },
  'grok-4.5':   { input: 0.002, output: 0.006 },
  'grok-4.3':   { input: 0.00125, output: 0.0025 },
  'grok-build-0.1': { input: 0.001, output: 0.002, cachedInput: 0.0002 },
  'grok-4.1':   { input: 0.003, output: 0.015 },
  'grok-4':     { input: 0.003, output: 0.015 },
  'grok-3':     { input: 0.003, output: 0.015 },
  'grok-3-mini':{ input: 0.0005, output: 0.002 },

  // Whisper (cost per second of audio, stored as "input")
  'whisper-1': { input: 0.0001, output: 0 },

  // TTS (cost per 1K characters, stored as "input")
  'tts-1': { input: 0.015, output: 0 },
  'tts-1-hd': { input: 0.030, output: 0 },

  // OpenAI Embeddings (output cost is always 0, only input tokens billed)
  'text-embedding-3-small': { input: 0.00002, output: 0 },
  'text-embedding-3-large': { input: 0.00013, output: 0 },
  'text-embedding-ada-002': { input: 0.0001,  output: 0 },
};

/** Exact id, then substring match, then a moderate fallback assumption. */
export function findModelPricing(model) {
  if (!model) return null;
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const lower = String(model).toLowerCase();
  for (const [key, val] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return { input: 0.002, output: 0.008 };
}
