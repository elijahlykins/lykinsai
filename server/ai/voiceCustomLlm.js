/**
 * Overlay / ElevenLabs custom-LLM request shaping.
 * Send the tools Chat already disclosed and let the model pick. Do not apply
 * a second Voice-only capability filter.
 */

export const DEFAULT_VOICE_LLM_MODEL = 'gpt-4.1-mini';
export const LEAN_VOICE_LLM_MODEL = 'gpt-4.1-nano';
export const VOICE_LLM_MAX_TOKENS = 400;
export const VOICE_LLM_HISTORY_TAIL = 12;

export function voiceTurnKeepsTools(filteredTools, interruptForTools) {
  return Boolean(interruptForTools) || (Array.isArray(filteredTools) && filteredTools.length > 0);
}

export function resolveVoiceLlmModel({ keepTools, envModel } = {}) {
  const override = String(envModel || '').trim();
  // gpt-4o was the old Voice default. Honor any other explicit override.
  if (override && override !== 'gpt-4o') return override;
  return keepTools ? DEFAULT_VOICE_LLM_MODEL : LEAN_VOICE_LLM_MODEL;
}

export function trimVoiceLlmMessages(messages, { tail = VOICE_LLM_HISTORY_TAIL } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const head = [];
  const rest = [];
  for (const m of list) {
    if (!rest.length && m?.role === 'system') head.push(m);
    else rest.push(m);
  }
  return [...head, ...rest.slice(-tail)];
}

export function prepareVoiceCustomLlmUpstream({
  body,
  rebuiltMessages,
  filteredTools,
  interruptForTools,
  envModel = process.env.ELEVENLABS_LLM_MODEL,
} = {}) {
  const tools = Array.isArray(filteredTools) ? filteredTools : [];
  const keepTools = voiceTurnKeepsTools(tools, interruptForTools);
  const upstream = {
    ...(body && typeof body === 'object' ? body : {}),
    model: resolveVoiceLlmModel({ keepTools, envModel }),
    messages: trimVoiceLlmMessages(rebuiltMessages),
    stream: true,
  };
  if (!keepTools) {
    delete upstream.tools;
    delete upstream.tool_choice;
  } else {
    upstream.tools = tools;
  }
  const requested = Number(upstream.max_tokens || upstream.max_completion_tokens || VOICE_LLM_MAX_TOKENS);
  delete upstream.max_completion_tokens;
  upstream.max_tokens = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : VOICE_LLM_MAX_TOKENS,
    VOICE_LLM_MAX_TOKENS,
  );
  return upstream;
}
