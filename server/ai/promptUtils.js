// Shared Chat/server prompt utilities. Process-singleton caches live here
// (`_memCaches`, Gemini context-cache store) so every importer shares identity.
import crypto from 'crypto';
import fetch from 'node-fetch';

// ============================================
// UTILITY — deterministic hash for AI caching
// ============================================
export function sha256(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

// ── Lightweight in-memory TTL cache (avoids repeat LLM calls across page reloads) ──
export const _memCaches = {};
export function memCache(namespace, { maxSize = 256, ttlMs = 30 * 60 * 1000 } = {}) {
  if (_memCaches[namespace]) return _memCaches[namespace];
  const store = new Map();
  const api = {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.ts > ttlMs) { store.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value) {
      if (store.size >= maxSize) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
      }
      store.set(key, { value, ts: Date.now() });
    },
  };
  _memCaches[namespace] = api;
  return api;
}

// ============================================
// STALE-SURFACE SANITIZER
// ----------------------------------------
// The grid / board / canvas / bricks surface no longer exists, but
// stored data (ai_conversation_memory rows, project preferences
// narratives and vault-retrieval snippets were written when it
// did. Sentences like "you organized your grid" or "we added a brick"
// in conversation continuity or vault retrieval can cause
// the live AI to mirror that language back at the user. We scrub the
// most obvious surface mentions before they reach the model.
//
// This is intentionally narrow — we don't rewrite all grammar, just
// drop sentences that are exclusively about the dead surface and
// replace inline phrases that refer to it. Anything ambiguous is left
// alone; the system-prompt MEMORY HYGIENE block tells the model to
// translate any remaining mentions silently.
// ============================================
export const STALE_SURFACE_SENTENCE_RE = /(^|[\n.!?]\s+)([^\n.!?]*\b(?:grid|board|canvas|brick|wire(?:d|s)?|block(?:s)?)\b[^\n.!?]*?(?:[.!?](?=\s|$)|\n|$))/gi;
export const STALE_SURFACE_INLINE_RE = /\b(?:on (?:the |your |our |my |this |that )?(?:grid|board|canvas)|onto (?:the |your |our |my )?(?:grid|board|canvas)|in (?:the |your |our |my )?(?:grid|board|canvas)|to (?:the |your |our |my )?(?:grid|board|canvas)|the (?:current |active )?(?:grid|board|canvas)|your (?:grid|board|canvas)|our (?:grid|board|canvas)|my (?:grid|board|canvas))\b/gi;
// Words that, when paired with grid-surface language, make a sentence
// almost certainly an old-surface operation we want to drop entirely
// rather than partially rewrite.
export const STALE_SURFACE_OP_VERBS = /\b(?:created|added|placed|put|dropped|moved|arranged|organized|resized|deleted|cleared|connected|wired|linked|embedded|pulled|tagged|coloured|colored)\b/i;

export function sanitizeStaleSurfaceLanguage(text) {
  if (!text || typeof text !== 'string') return text || '';
  const before = text;
  let out = text;
  // 1) Drop sentences that are clearly grid operations.
  out = out.replace(STALE_SURFACE_SENTENCE_RE, (match, lead, sentence) => {
    if (STALE_SURFACE_OP_VERBS.test(sentence)) return lead || '';
    return match;
  });
  // 2) Replace inline references like "on your grid" with neutral phrasing
  //    so the surrounding sentence still parses but no longer mentions a
  //    surface the user can't see.
  out = out.replace(STALE_SURFACE_INLINE_RE, 'in chat');
  if (out !== before && out.length < before.length * 0.3) {
    // Filter ate too much; safer to keep the original.
    return before;
  }
  return out;
}

// ============================================
// UTILITY — split assembled prompt into system + user for provider caching
// ============================================
export const PROMPT_SECTION_MARKERS = [
  '[USER_PREFERENCES]', '[INTENT]', '[CONVERSATION]', '[CONVERSATION_MEMORY',
  '[WORKSPACE_CONTEXT]', '[REQUEST_CONTEXT]', '[FULL_CONTEXT]',
  '[VAULT_URL_MATCHES]',
  '[PROJECT_KNOWLEDGE]', '[WHAT_IM_ON]', '[WHO_I_AM]', '[WHAT_IVE_SAVED]', '[PROJECT_ID]', '[CONTEXT]',
  '[ATTACHED_IMAGES]', '[LATEST_USER_MESSAGE]', '[USER]',
];

export function splitPromptForProvider(fullPrompt) {
  if (!fullPrompt) return { system: '', user: fullPrompt || '' };
  let splitIdx = fullPrompt.length;
  for (const m of PROMPT_SECTION_MARKERS) {
    const idx = fullPrompt.indexOf(m);
    if (idx >= 0 && idx < splitIdx) splitIdx = idx;
  }
  if (splitIdx === 0 || splitIdx >= fullPrompt.length) {
    return { system: '', user: fullPrompt };
  }
  return {
    system: fullPrompt.slice(0, splitIdx).trimEnd(),
    user: fullPrompt.slice(splitIdx).trimStart(),
  };
}

// ============================================
// UTILITY — Google Gemini context caching (cachedContents API)
// ============================================
// Caches a static system prompt under a (model + content-hash) key and
// returns the `cachedContents/...` resource name to attach via
// `cachedContent` on a generate / streamGenerateContent call. Returns
// null when caching isn't possible (prompt below model minimum, missing
// API key, model doesn't support cached content, transient API error)
// so callers fall back silently to inline systemInstruction.
//
// Concurrent calls for the same key are coalesced via the in-flight
// promise map — we only POST cachedContents once per (model, prompt).
export const _geminiCacheStore = memCache('gemini-context-cache', {
  maxSize: 64,
  // Server-side TTL is 1h; expire ours a touch earlier so we don't try
  // to attach a name Google has already evicted.
  ttlMs: 55 * 60 * 1000,
});
export const _geminiCacheInflight = new Map();
// Lowest documented minimum across current Gemini models is ~1024
// tokens. ~4 chars/token gives a safe lower bound; below this Google
// returns 400 INVALID_ARGUMENT and we'd just be burning a round-trip.
export const GEMINI_CACHE_MIN_CHARS = 4096;

export async function getOrCreateGeminiCache(systemPrompt, model) {
  if (!process.env.GOOGLE_API_KEY) return null;
  const text = String(systemPrompt || '').trim();
  if (!text || !model) return null;
  if (text.length < GEMINI_CACHE_MIN_CHARS) return null;

  const cleanModel = String(model).replace(/^models\//, '');
  const key = sha256(`${cleanModel}::${text}`);

  const cached = _geminiCacheStore.get(key);
  if (cached) return cached;

  // CRITICAL: cache creation is NON-BLOCKING.
  //
  // `cachedContents.create` is a write call that uploads the full system
  // prompt to Google, makes them tokenise + persist it, and returns a
  // resource handle. For our ~27K-char persona that round-trip is
  // routinely 5-30s — and for moving aliases like `gemini-flash-latest`
  // it sometimes 404s entirely (the alias has no stable cache target).
  // If we awaited it on the request path the user paid that latency on
  // every cold start (server restart, 55-min TTL flip, scale-out, etc.)
  // before a single token streamed back. That was the dominant cause of
  // 20-30s "first message after restart" hangs.
  //
  // New shape: on a cold miss we fire-and-forget the create and return
  // null immediately. The caller falls back to inline `systemInstruction`
  // for *this* request (same payload it would have sent anyway). Once
  // the background create resolves, subsequent requests within the TTL
  // pick up the warm name and get the cost reduction. We never block
  // streaming on cache creation.
  if (!_geminiCacheInflight.has(key)) {
    const work = (async () => {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${process.env.GOOGLE_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: `models/${cleanModel}`,
              systemInstruction: { parts: [{ text }] },
              // cachedContents.create requires `contents` even when the
              // payload we actually want to cache is the system prompt.
              // A single-char placeholder is enough; Google counts the
              // systemInstruction toward the minimum-token threshold.
              contents: [{ role: 'user', parts: [{ text: '.' }] }],
              ttl: '3600s',
            }),
          }
        );
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          // 400 = below minimum tokens for this model, 404 = model
          // doesn't support cachedContents. Both are expected and we
          // fall back silently to inline systemInstruction.
          if (resp.status !== 400 && resp.status !== 404) {
            console.warn(`⚠️ Gemini cachedContents create failed (${resp.status}):`, String(errBody).slice(0, 200));
          }
          return null;
        }
        const json = await resp.json().catch(() => null);
        const name = json?.name;
        if (!name) return null;
        _geminiCacheStore.set(key, name);
        console.log(`💾 Gemini context cache warmed in background (${cleanModel} → ${name})`);
        return name;
      } catch (err) {
        console.warn('⚠️ Gemini cachedContents create error:', err?.message || err);
        return null;
      } finally {
        _geminiCacheInflight.delete(key);
      }
    })();
    _geminiCacheInflight.set(key, work);
    // Swallow unhandled rejections — work() already catches everything,
    // but Node still warns on a Promise we never await/then.
    work.catch(() => {});
  }

  return null;
}

// ============================================
// OUTPUT TOKEN CAPS — intent-based, applied to every chat path
// ============================================
// The rule of thumb here: the model must ALWAYS be able to finish its
// answer in one pass. Caps are sized so a long multi-section reply
// (essay, code walkthrough, deep brief) ends naturally on punctuation —
// MAX_TOKENS should never be the reason a sentence trails off, and the
// model should never self-emit a "_…response truncated. Ask continue
// for the rest._" meta-note because it thinks it's about to run out
// of room.
//
// Cost stays bounded because per-token billing means a higher cap only
// matters when the reply actually runs long; short replies still cost
// short-reply prices.
//
// Per-provider single-call output ceilings (from upstream model docs):
//   - Gemini 2.5 Flash / Pro:  65,536 tokens
//   - Claude Sonnet 4 / 4.5:    64,000 tokens
//   - Claude 3.5 Sonnet:         8,192 tokens
//   - GPT-4o / GPT-4.1:         16,384 tokens (gpt-4.1 supports 32,768)
//   - Grok 2 / Grok 4:        131,072+ tokens
// We don't try to dial each provider to its theoretical max — we pick
// a "good range" that's universally safe and finishes ~99% of replies
// in one call. Anything that genuinely needs more belongs in a follow-up.
export const OUTPUT_CAPS = {
  // 12k tokens ≈ 9,000 words — comfortably more room than any natural
  // chat reply would need, and well within every provider's per-call
  // ceiling (Claude 3.5 Sonnet's 8,192 is the lowest, and Claude
  // requests will get clamped to that automatically by clampForProvider
  // below before they hit the API).
  chat: 12000,
  chat_short: 3000,
  chat_long: 8000,
  chat_complex: 12000,
  // The action-path JSON envelope shape is `{ assistant, follow_up_questions,
  // actions }`. The CHAT TEXT inside `assistant` shares this budget with the
  // action array, so 800 was way too small — when the canvas-chat heuristic
  // routed a normal conversational turn here (any verb like "change" / "edit"
  // / "update" / "set" / "put" with any blocks on the board), the model would
  // hit MAX_TOKENS in the middle of its reply and the user would see a few
  // sentences before the response abruptly stopped. 4000 leaves room for a
  // full conversational answer (~3,000 words) PLUS several actions; the prompt
  // still tells the model to keep the JSON small so cost-on-typical-action-
  // turn doesn't change.
  json_action: 4000,
  image_analysis: 4000,
  board_analysis_deep: 4500,
  board_analysis_light: 2500,
  file_large: 4500,
  file_small: 2500,
  vault_search: 800,
  // Coded-artifact turns (lykn_build_react_artifact): the model writes a
  // complete React app/site/worksheet into a tool-call argument, so it needs
  // far more room than a chat reply. 30k tokens ≈ 120KB of code — matches
  // the tool's MAX_CODE_LEN. clampForProvider still bounds this per provider
  // (grok/gemini 32k ceilings pass it through; openai/claude clamp lower).
  coded_artifact: 30000,
  // Deep research reports are long markdown with stock/chart/sheet embeds.
  // 12k was truncating mid-fence so the client rendered raw embed JSON.
  // 24k + continue-on-length in chat-agent-loop finishes the Sources section.
  deep_research: 24576,
  // `max` is the hard ceiling for caller `override` values — aligned with
  // modern provider ceilings (Gemini/Claude/Grok 32k). OpenAI still clamps
  // lower via PROVIDER_OUTPUT_CEILINGS; research continues when that hits.
  max: 32768,
};

// Per-provider single-call output ceilings. Used to clamp our caps right
// before the request goes out so we never get a 400 "max_tokens too
// large" from any provider — no matter how generous OUTPUT_CAPS gets.
// Keep these conservative: when in doubt, use the lower model in the
// family. Claude was 8,192 (the 3.5 Sonnet floor) but resolveAnthropicModel
// now maps every legacy id to 4.x models (64K output), and coded-artifact
// builds on Opus need well past 8K for the component source — 32,768
// matches the gemini/grok ceiling and stays under every 4.x model's limit.
export const PROVIDER_OUTPUT_CEILINGS = {
  gemini: 32768,
  openai: 16384,
  claude: 32768,
  grok: 32768,
};

export function getProviderForModel(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('grok')) return 'grok';
  if (m.includes('gemini')) return 'gemini';
  return 'openai';
}

export function clampForProvider(cap, model) {
  const provider = getProviderForModel(model);
  const ceiling = PROVIDER_OUTPUT_CEILINGS[provider] || OUTPUT_CAPS.max;
  return Math.min(Math.floor(cap), ceiling);
}

export function pickOutputCap({ wantsActions = false, hasImages = false, intent, override, deepResearch = false } = {}) {
  // Explicit caller override always wins, bounded by the hard ceiling so a
  // bad caller can't reintroduce the runaway-cost problem we just fixed.
  if (Number.isFinite(override) && override > 0) {
    return Math.min(Math.floor(override), OUTPUT_CAPS.max);
  }
  if (wantsActions) return OUTPUT_CAPS.json_action;
  if (deepResearch) return OUTPUT_CAPS.deep_research;
  if (intent && OUTPUT_CAPS[intent]) return OUTPUT_CAPS[intent];
  if (hasImages) return OUTPUT_CAPS.image_analysis;
  return OUTPUT_CAPS.chat;
}

// Constant-time string equality. Returns false on length mismatch (the length
// itself isn't secret here) without leaking a per-character timing signal.
export function timingSafeEqualStr(a, b) {
  try {
    const bufA = Buffer.from(String(a ?? ''), 'utf8');
    const bufB = Buffer.from(String(b ?? ''), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
