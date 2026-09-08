// Which (provider, model) attempts a forced-tool turn gets, in order.
//
// Forced-tool turns — an artifact build, an artifact patch, an image
// generation — can fail in a way an ordinary chat turn cannot: the provider
// streams reasoning or introductory prose and then ends the turn with zero
// tool calls, leaving the user with no preview and no error. Grok does this
// reproducibly on forced-tool requests that carry an image. When the forced
// tool never completes, the whole turn re-runs on the next attempt.
//
// Extracted from chatStream.routes.js so the ordering is testable on its own
// (see builderAttempts.test.mjs) instead of only observable in production.

/** Coded-artifact preference order for the fallback tail. */
export const FORCED_TOOL_FALLBACK_MODELS = Object.freeze([
  'claude-opus-4-8',
  'gpt-5.6-sol',
  'gemini-3.1-pro-preview',
]);

const DIRECT_PROVIDER_BY_MODEL = Object.freeze({
  'claude-opus-4-8': 'anthropic',
  'gpt-5.6-sol': 'openai',
  'gemini-3.1-pro-preview': 'gemini',
});

const DIRECT_KEY_BY_PROVIDER = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
});

/**
 * @param {object} input
 * @param {string} input.provider          Primary provider for this turn.
 * @param {string} input.model             Primary model for this turn.
 * @param {string|undefined} input.forcedToolName  Tool forced on hop 0, if any.
 * @param {boolean} [input.workspaceTurn]  Build-workspace turn — same recovery
 *   tail as forced-tool turns. A workspace build that dies before doing any
 *   work (provider 400, reasoning burnout, transport failure) must re-run on
 *   another coding model; falling to the toolless legacy stream turns "build
 *   me a game" into prose.
 * @param {string[]|null} input.routeFallbackModelIds  From the route decision.
 * @param {(id: string) => string|null} input.providerForModel
 * @param {boolean} input.openRouterReady  OpenRouter is the chat gateway.
 * @param {Record<string,string|undefined>} [input.env]
 * @returns {{provider: string, model: string}[]}
 */
export function buildAgentAttempts({
  provider,
  model,
  forcedToolName,
  workspaceTurn = false,
  routeFallbackModelIds,
  providerForModel,
  openRouterReady,
  env = process.env,
}) {
  const attempts = [{ provider, model }];
  const push = (p, m) => {
    if (!p || !m) return;
    if (attempts.some((a) => a.model === m)) return;
    attempts.push({ provider: p, model: m });
  };

  // A user's own fallback chain (My Setup / a named route) comes first — it
  // is an explicit preference, not a recovery guess.
  if (Array.isArray(routeFallbackModelIds)) {
    for (const id of routeFallbackModelIds) push(providerForModel(id), id);
  }

  if (!forcedToolName && !workspaceTurn) return attempts;

  // Recovery tail. Through OpenRouter every fallback is the same
  // OpenAI-compatible transport, so availability is a single check.
  for (const id of FORCED_TOOL_FALLBACK_MODELS) {
    if (openRouterReady) {
      push('openrouter', id);
      continue;
    }
    const direct = DIRECT_PROVIDER_BY_MODEL[id];
    if (direct && env[DIRECT_KEY_BY_PROVIDER[direct]]) push(direct, id);
  }
  return attempts;
}
