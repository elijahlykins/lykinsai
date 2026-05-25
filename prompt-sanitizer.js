// ============================================================================
// prompt-sanitizer.js — strip tool-call & system-prompt syntax from USER input
// ============================================================================
// LYKN's chat agent loop already runs a streaming tool-syntax stripper on
// model OUTPUT (`makeToolSyntaxStripper` in chat-agent-loop.js). That handles
// "model echoes literal [lykn_x({...})] syntax in its reply" by deleting the
// pattern before it reaches the user.
//
// This module is the INPUT-side equivalent. User-controlled text — prompts,
// conversation turns, custom AI instructions, and any user-typed content
// pulled from the vault on a re-summarisation pass — is sanitised BEFORE it
// is concatenated into the prompt sent to the AI provider.
//
// WHY THIS MATTERS:
//   The agent loop only dispatches tool calls via the provider's native
//   function-calling channel — bracketed syntax in user text is NOT parsed
//   as a tool invocation. So why strip it on input?
//
//   1. Defense in depth. A future code path (e.g. a prompt template that
//      builds plain-text "previous turns" without going through native
//      tool messages) could re-introduce the risk that smaller models
//      treat the literal text as a callable suggestion.
//   2. System-prompt-injection markers ([SYSTEM], [INST], <|im_start|>) are
//      noise to our four supported providers but actively confuse smaller
//      open-source models we may add later. Stripping them now is cheap
//      insurance for "switch the cheap fallback to a Llama variant" later.
//   3. Vault-roundtrip injection. A user can paste injection syntax into
//      a vault note today; tomorrow that note may be summarised and fed
//      back into the prompt. Sanitising on every read into a prompt path
//      breaks that round-trip.
//
// USAGE:
//   import { sanitizeUserContent } from './prompt-sanitizer.js';
//
//   // top-level prompt fields
//   const safePrompt = sanitizeUserContent(req.body.prompt);
//
//   // EVERY message in a conversation array — not just the latest
//   const safeConversation = (req.body.conversation || []).map((m) => ({
//     ...m,
//     content: sanitizeUserContent(m?.content),
//   }));
//
// All replacements drop the offending fragment and leave a `[removed]`
// marker so the user (and a debugger reading logs) can see something was
// stripped. Pure string in / string out — non-string inputs are returned
// unchanged so the helper is safe to apply across heterogeneous fields.

const REMOVED = '[removed]';

const STRIP_PATTERNS = [
  // [lykn_xxx({...})] — bracketed call (the most common imitation pattern,
  // and what shows up when smaller models echo OpenAI tool descriptors).
  /\[\s*lykn_\w+\s*\([\s\S]*?\)\s*\]/g,
  // lykn_xxx({...}) — bare JSON-shaped call
  /\blykn_\w+\s*\(\s*\{[\s\S]*?\}\s*\)/g,
  // lykn_xxx() — empty-args call
  /\blykn_\w+\s*\(\s*\)/g,
  // <tool>...</tool>, <tool_call>...</tool_call>, etc. — block form.
  /<tool[_a-z]*[^>]*>[\s\S]*?<\/tool[_a-z]*>/gi,
  // Lone opening / closing tool tags (in case the close was on a
  // different chunk or got mangled mid-stream).
  /<\/?tool[_a-z]*[^>]*>/gi,
  // <function_call>...</function_call>, <function_calls>...</function_calls>, etc.
  /<function[_a-z]*[^>]*>[\s\S]*?<\/function[_a-z]*>/gi,
  /<\/?function[_a-z]*[^>]*>/gi,
  // System-prompt injection markers from common open-source model templates.
  /\[\s*SYSTEM\s*\]/gi,
  /\[\s*INST\s*\]/gi,
  /\[\s*\/\s*INST\s*\]/gi,
  // ChatML-style markers (Llama, Mistral, Qwen).
  /<\|im_(?:start|end)\|>/gi,
  // Anthropic-style human/assistant turn markers.
  /<\|(?:human|assistant|system)\|>/gi,
];

/**
 * Strip tool-call and system-prompt-injection syntax from a string.
 *
 * Non-string input is returned unchanged (so callers don't have to type-
 * narrow before invoking — pass req.body.prompt and a non-string body
 * field flows through harmlessly).
 *
 * Idempotent — running twice on the same input produces the same output.
 */
export function sanitizeUserContent(content) {
  if (typeof content !== 'string') return content;
  if (!content) return content;
  let out = content;
  for (const re of STRIP_PATTERNS) {
    out = out.replace(re, REMOVED);
  }
  return out;
}

/**
 * Apply sanitizeUserContent to every `.content` field in an array of
 * { role, content } turns. Returns a new array (originals untouched).
 *
 * Used to harden the FULL conversation/history array, not just the
 * top-level latest message — a prior turn that contains injection
 * syntax is just as risky as a fresh message because the model sees
 * it on every hop of the agent loop.
 */
export function sanitizeTurnArray(turns) {
  if (!Array.isArray(turns)) return turns;
  return turns.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.content !== 'string') return m;
    return { ...m, content: sanitizeUserContent(m.content) };
  });
}

// ---------------------------------------------------------------------------
// Counted variants (Agent 06)
// ---------------------------------------------------------------------------
//
// Same sanitisation logic, but ALSO returns how many fragments were stripped.
// Used at the AI streaming endpoints to emit ONE SecurityEvent.INJECTION_STRIPPED
// per request (with the match count) without changing the existing call-site
// signature for the un-counted variants. NEVER returns the actual matched
// text — only the count — so a log aggregator never receives injection
// payloads from real attempts.
//
// Idempotent: running twice on the same input produces removed=0 on the
// second pass (everything is already [removed]).

/**
 * @returns { content: string, removed: number }
 *   For non-string input: { content, removed: 0 }.
 */
export function sanitizeUserContentWithCount(content) {
  if (typeof content !== 'string' || !content) {
    return { content, removed: 0 };
  }
  let out = content;
  let removed = 0;
  for (const re of STRIP_PATTERNS) {
    out = out.replace(re, () => { removed += 1; return REMOVED; });
  }
  return { content: out, removed };
}

/**
 * @returns { turns: Array, removed: number }
 *   Mirrors sanitizeTurnArray but sums removal counts across every turn.
 *   Non-array input returns { turns, removed: 0 }.
 */
export function sanitizeTurnArrayWithCount(turns) {
  if (!Array.isArray(turns)) return { turns, removed: 0 };
  let total = 0;
  const next = turns.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.content !== 'string') return m;
    const { content, removed } = sanitizeUserContentWithCount(m.content);
    total += removed;
    return { ...m, content };
  });
  return { turns: next, removed: total };
}
