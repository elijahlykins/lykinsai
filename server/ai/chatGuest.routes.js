// POST /api/ai/stream-guest — public SSE guest chat.
import fetch from 'node-fetch';
import crypto from 'crypto';
import {
  getOrCreateSession,
  logAiUsage,
  classifyActionType,
  estimateTokens,
  detectProvider,
  extractOpenAIUsage,
  extractAnthropicUsage,
  extractGeminiUsage,
  extractGrokUsage,
} from '../../usageTracking.js';
import {
  sanitizeUserContentWithCount,
} from '../../prompt-sanitizer.js';
import { SecurityEvent, logSecurityEvent } from '../../security-logger.js';
import {
  getOrCreateGeminiCache,
} from './promptUtils.js';
import {
  GUEST_SYSTEM_PROMPT,
  GLASS_DEMO_ADDENDUM,
  buildLandingOnboardingSystemPrompt,
} from './chatGuidance.js';
import { AI_TEMPORARY_FAILURE_TEXT, resolveAnthropicModel } from './modelInvoke.js';
import {
  extractOpenRouterUsage,
  openRouterConfigured,
  resolveInferenceTarget,
} from '../../lib/inference/index.js';

export function registerAiGuestStreamRoute(app, {
  guestAiGlobalLimiter,
  guestAiLimiter,
  guestAiHourlyLimiter,
  guestAiDailyLimiter,
}) {
  /* ------------------------------------------------------------------ */
  /*  Guest streaming chat (no auth, IP-rate-limited)                   */
  /*  Powers the logged-out landing-page grid demo + landing prototype. */
  /*                                                                    */
  /*  Tries providers in order; falls back to the next on a connection  */
  /*  error or non-OK HTTP response BEFORE any tokens are streamed to   */
  /*  the client. Once a provider starts emitting tokens we commit to   */
  /*  it (no mid-stream switching — that would corrupt the user's view).*/
  /* ------------------------------------------------------------------ */
  // Guest chat is intentionally cheap by default — logged-out visitors should
  // not be burning premium-tier calls on small-talk. The ONE exception is the
  // very first turn of the landing-prototype onboarding flow: that reply sets
  // the product tone, so it is worth spending a slightly meatier call on it. Every subsequent
  // guest message (and every non-onboarding guest call) drops to Flash-Lite.
  //
  // LYKN runs Gemini-only end-to-end, so there are no cross-provider
  // fallbacks here. If GOOGLE_API_KEY is missing, the request will fail
  // fast in the streaming path rather than silently routing elsewhere.
  const GUEST_MODEL_CHAIN_ONBOARDING_FIRST = [
    // First-turn neuron creation — Gemini 3 Flash gives a warmer, more
    // specific reply than Flash-Lite,
    // but stays cheap enough for an unauthenticated visitor. Mirrors the
    // LYKN Fast Reasoning tier so guests get the same flagship Flash
    // variant on their very first message. (Google has not released a
    // standard non-lite text-gen Gemini 3.1 Flash, so 3-flash-preview is
    // still the right middle-tier choice — see LYKN_ROUTED_MODELS above.)
    { provider: 'google', model: 'gemini-3-flash-preview', envKey: 'GOOGLE_API_KEY' },
    // Last-ditch fallback to the latest Flash alias in case the preview
    // variant is rate-limited or temporarily unavailable.
    { provider: 'google', model: 'gemini-flash-latest', envKey: 'GOOGLE_API_KEY' },
  ];
  const GUEST_MODEL_CHAIN_DEFAULT = [
    // Cheap + fast default for unauthenticated guest surfaces: walkthrough
    // chat preview, subsequent onboarding turns, landing-grid demo, etc.
    // Guest stays on gpt-4.1-nano for cost/TTFT; authenticated `lykn` chat
    // routes to gpt-5.6-terra separately. Gemini Flash-Lite / Flash stay as
    // fallbacks so a missing OpenAI key or an OpenAI outage still serves a
    // guest reply.
    { provider: 'openai', model: 'gpt-4.1-nano', envKey: 'OPENAI_API_KEY' },
    { provider: 'google', model: 'gemini-3.1-flash-lite', envKey: 'GOOGLE_API_KEY' },
    { provider: 'google', model: 'gemini-flash-latest', envKey: 'GOOGLE_API_KEY' },
  ];
  const GUEST_MAX_PROMPT_CHARS = 6000;
  const GUEST_MAX_HISTORY_TURNS = 8;
  const GUEST_MAX_HISTORY_CHARS = 4000;

  // chatGuidance (personas): ./server/ai/chatGuidance.js


  // localToolBridge: ./server/ai/localToolBridge.js


  // chatGuidance (tool guidance): ./server/ai/chatGuidance.js


  app.post('/api/ai/stream-guest', guestAiGlobalLimiter, guestAiLimiter, guestAiHourlyLimiter, guestAiDailyLimiter, async (req, res) => {
    // The actual chain is picked below once we know the mode + history,
    // but bail out early if no provider key is configured at all.
    const anyProviderConfigured = openRouterConfigured()
      || GUEST_MODEL_CHAIN_DEFAULT.some((p) => process.env[p.envKey])
      || GUEST_MODEL_CHAIN_ONBOARDING_FIRST.some((p) => process.env[p.envKey]);
    if (!anyProviderConfigured) {
      return res.status(503).json({ error: 'Guest chat is temporarily unavailable' });
    }

    const rawPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    // SECURITY (Agent 04): strip tool-call & system-prompt-injection syntax
    // from user-supplied content BEFORE it enters the prompt-builder / model
    // call chain. The output stripper in chat-agent-loop.js handles model
    // echoes; this is the input-side defense.
    // SECURITY (Agent 06): with-count variant lets us emit ONE
    // INJECTION_STRIPPED event per request with the aggregate match count
    // across the prompt + history. No event when count is zero.
    let _injectionStripCount = 0;
    const _promptStrip = sanitizeUserContentWithCount(rawPrompt.trim().slice(0, GUEST_MAX_PROMPT_CHARS));
    const prompt = _promptStrip.content;
    _injectionStripCount += _promptStrip.removed;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Optional client-supplied mode. The landing-prototype wake screen sets
    // 'landing-onboarding' so we swap in the preview onboarding addendum.
    // Anything else falls back
    // to the default guest system prompt — which is what the landing-page
    // grid demo (chatSendOrchestrator) wants.
    const mode = typeof req.body?.mode === 'string' ? req.body.mode : '';

    // Glass-demo only: the overlay sends a snapshot of the landing page text it
    // is floating over, so LYKN can answer questions about the page from the
    // real, current content rather than a hardcoded summary. Capped + sanitized
    // (it is untrusted DOM text) before it enters the prompt.
    let glassPageContext = '';
    if (mode === 'glass-demo' && typeof req.body?.pageContext === 'string') {
      const _ctx = sanitizeUserContentWithCount(req.body.pageContext.slice(0, 14000));
      glassPageContext = _ctx.content;
      _injectionStripCount += _ctx.removed;
    }

    const buildGlassDemoPrompt = () => {
      let p = `${GUEST_SYSTEM_PROMPT}\n\n${GLASS_DEMO_ADDENDUM}`;
      if (glassPageContext) {
        p += '\n\n=== EXACT LANDING PAGE CONTENT (verbatim — what the visitor is looking at right now) ===\n'
          + 'This is the real text of the page behind you, captured live. It is your SOURCE OF TRUTH for anything about the page, the site, LYKN\'s features, the FAQ, pricing, or any copy written here. When the visitor asks about the page or what it says, answer from this — accurately, quoting or paraphrasing it — and never contradict or invent beyond it:\n'
          + '"""\n' + glassPageContext + '\n"""';
      }
      return p;
    };

    const systemPrompt = mode === 'landing-onboarding'
      ? buildLandingOnboardingSystemPrompt()
      : mode === 'glass-demo'
        ? buildGlassDemoPrompt()
        : GUEST_SYSTEM_PROMPT;

    // Lightly sanitized conversation history — role + content only.
    // SECURITY (Agent 04): sanitize the content of EVERY prior turn, not
    // just the latest one. A previous turn that contains injection syntax
    // is reintroduced to the model on every hop of the loop.
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const history = rawHistory
      .filter((m) => m && typeof m === 'object' && typeof m.content === 'string')
      .map((m) => {
        const _r = sanitizeUserContentWithCount(String(m.content || '').trim().slice(0, 2000));
        _injectionStripCount += _r.removed;
        return {
          role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
          content: _r.content,
        };
      })
      .filter((m) => m.content)
      .slice(-GUEST_MAX_HISTORY_TURNS);

    // Agent 06: emit ONE INJECTION_STRIPPED event per request when any
    // fragments were stripped across prompt + history.
    if (_injectionStripCount > 0) {
      logSecurityEvent(SecurityEvent.INJECTION_STRIPPED, {
        matchCount: _injectionStripCount,
        route: '/api/ai/stream-guest',
        fieldsScanned: ['prompt'],
        hadConversation: rawHistory.length > 0,
      }, { req });
    }

    let historyChars = 0;
    const trimmedHistory = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (historyChars + msg.content.length > GUEST_MAX_HISTORY_CHARS) break;
      trimmedHistory.unshift(msg);
      historyChars += msg.content.length;
    }

    // Pick the model chain. The very first turn of the landing-prototype
    // onboarding flow (no prior history yet) gets Gemini Flash because that
    // reply is what mints the user's first synthesis-layer neuron — every
    // other guest call (subsequent onboarding turns + the landing-grid
    // demo + anything else) drops to Gemini Flash-Lite to keep guest cost
    // negligible.
    const isFirstOnboardingTurn = mode === 'landing-onboarding' && trimmedHistory.length === 0;
    const chain = isFirstOnboardingTurn
      ? GUEST_MODEL_CHAIN_ONBOARDING_FIRST
      : GUEST_MODEL_CHAIN_DEFAULT;
    const availableProviders = chain.filter((p) => process.env[p.envKey]);
    if (availableProviders.length === 0) {
      return res.status(503).json({ error: 'Guest chat is temporarily unavailable' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // SECURITY (Agent 04): drop stuck guest streams after 2 minutes. Without
    // this, a guest client that opens an SSE connection and never closes it
    // pins the socket indefinitely — a low-cost DoS vector against the free
    // demo (especially because guests don't authenticate so there's no
    // per-user limit besides the 4 IP-based limiters above). 120s is well
    // beyond any legitimate guest-tier model latency.
    try { req.setTimeout?.(120_000, () => { try { res.end(); } catch { /* socket already closed */ } }); } catch { /* req.setTimeout missing on some test transports */ }

    // Guest usage tracking: stable per-browser-per-day id (no PII stored — just
    // a hash of IP + UA + date so multiple guest calls roll up sensibly).
    const guestSessionId = (() => {
      const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || 'unknown';
      const ua = String(req.headers['user-agent'] || '').slice(0, 200);
      const day = new Date().toISOString().slice(0, 10);
      return crypto.createHash('sha256').update(`${ip}|${ua}|${day}`).digest('hex').slice(0, 32);
    })();

    let ended = false;
    let emittedChars = 0;
    let winner = null; // { provider, model } once a provider successfully streams
    let guestUsage = null;
    let usageLogged = false;
    const inputChars = systemPrompt.length + historyChars + prompt.length;

    const logGuestUsageOnce = () => {
      if (usageLogged || !winner) return;
      usageLogged = true;
      logAiUsage({
        userId: null,
        guestSessionId,
        actionType: 'guest_chat',
        model: winner.model,
        provider: winner.provider,
        inputTokens: guestUsage?.input_tokens || estimateTokens('x'.repeat(inputChars)),
        outputTokens: guestUsage?.output_tokens || estimateTokens('x'.repeat(emittedChars)),
        metadata: {
          mode: mode || 'default',
          is_first_onboarding_turn: isFirstOnboardingTurn,
          gateway: openRouterConfigured() ? 'openrouter' : 'direct',
          upstream_cost_usd: Number.isFinite(Number(guestUsage?.cost_usd))
            ? guestUsage.cost_usd
            : undefined,
        },
      }).catch((e) => console.warn('[Usage] guest_chat log failed:', e?.message || e));
    };

    const _guestTextStripper = makeToolSyntaxStripper((text) => {
      if (ended || res.writableEnded) return;
      emittedChars += String(text || '').length;
      res.write(`data: ${JSON.stringify({ t: text })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    });
    const sendChunk = (text) => _guestTextStripper.ingest(text);
    const sendError = (msg) => {
      if (ended || res.writableEnded) return;
      ended = true;
      logGuestUsageOnce();
      try { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); } catch {}
      try { res.end(); } catch {}
    };
    const sendDone = () => {
      if (ended || res.writableEnded) return;
      _guestTextStripper.flush();
      ended = true;
      logGuestUsageOnce();
      try { res.write('data: [DONE]\n\n'); } catch {}
      try { res.end(); } catch {}
    };

    req.on('close', () => {
      if (!ended) {
        _guestTextStripper.flush();
        logGuestUsageOnce();
      }
      ended = true;
    });

    /* ---------------------------------------------------------------- */
    /*  Per-provider stream attempts                                     */
    /*                                                                   */
    /*  Each returns:                                                    */
    /*    { started: true }  — tokens were emitted to the client; the   */
    /*                         caller must NOT try the next provider.   */
    /*    { started: false } — connection failed before any tokens; the */
    /*                         caller MAY try the next provider.        */
    /*                                                                   */
    /*  All three set up their own inactivity watchdog and call         */
    /*  sendDone() / sendError() when the stream completes or fails    */
    /*  mid-stream.                                                      */
    /* ---------------------------------------------------------------- */

    const tryAnthropic = async (model) => {
      const messages = [
        ...trimmedHistory.map((m) => ({
          role: m.role === 'model' ? 'assistant' : 'user',
          content: m.content,
        })),
        { role: 'user', content: prompt },
      ];
      // System prompt for guest chat is identical across every guest turn,
      // so we mark it as ephemeral cache content. Anthropic returns the
      // cached input tokens at ~10% the normal price after the first read,
      // saving ~50%+ on input cost for repeat guests.
      const body = {
        model,
        messages,
        max_tokens: 2048,
        stream: true,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      };
      const abort = new AbortController();
      const connectTimer = setTimeout(() => { try { abort.abort(); } catch {} }, 12_000);
      let resp;
      try {
        resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'prompt-caching-2024-07-31',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      } catch (err) {
        clearTimeout(connectTimer);
        console.error(`❌ Guest Anthropic (${model}) connect failed:`, err?.message || err);
        return { started: false };
      }
      clearTimeout(connectTimer);
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        console.error(`❌ Guest Anthropic (${model}) HTTP ${resp.status}:`, errJson?.error?.message || resp.statusText);
        return { started: false };
      }

      let started = false;
      const reader = resp.body;
      let buffer = '';
      let inactivityRef = setTimeout(() => { try { abort.abort(); } catch {} sendError(AI_TEMPORARY_FAILURE_TEXT); }, 45_000);
      const bumpInactivity = () => {
        clearTimeout(inactivityRef);
        inactivityRef = setTimeout(() => { try { abort.abort(); } catch {} sendError(AI_TEMPORARY_FAILURE_TEXT); }, 45_000);
      };

      return await new Promise((resolve) => {
        const processClaudePayload = (payload) => {
          try {
            const parsed = JSON.parse(payload);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              if (!started) { started = true; resolve({ started: true }); }
              sendChunk(parsed.delta.text);
            }
            if (parsed.type === 'message_stop') sendDone();
          } catch { /* ignore partial json */ }
        };
        reader.on('data', (chunk) => {
          if (ended) return;
          bumpInactivity();
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            processClaudePayload(trimmed.slice(6));
          }
        });
        reader.on('end', () => {
          clearTimeout(inactivityRef);
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              processClaudePayload(trimmed.slice(6));
            }
            buffer = '';
          }
          if (!started) { resolve({ started: false }); return; }
          sendDone();
        });
        reader.on('error', (err) => {
          clearTimeout(inactivityRef);
          console.error(`❌ Guest Anthropic (${model}) stream error:`, err?.message || err);
          if (!started) { resolve({ started: false }); return; }
          // Don't wipe the partial reply with a generic error — close the
          // SSE cleanly so the client keeps the text it already rendered.
          sendDone();
        });
      });
    };

    const tryGemini = async (model) => {
      const contents = [
        ...trimmedHistory.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
        { role: 'user', parts: [{ text: prompt }] },
      ];
      const body = {
        contents,
        // Output cap is a safety net only — it should NEVER be the reason a
        // reply ends mid-sentence. We give plenty of headroom (4K tokens, way
        // above any reasonable visible reply) so the model always has space
        // to finish its thought. Per-token billing means this upper bound
        // only matters when a reply actually runs long; typical short replies
        // still cost short-reply prices.
        generationConfig: { maxOutputTokens: 4000, temperature: 0.7 },
      };
      // Cache the static guest system prompt — it's identical across all
      // guest sessions, so this hit-rate is effectively 100% after the first
      // request of the hour.
      const _guestGemCache = await getOrCreateGeminiCache(systemPrompt, model);
      if (_guestGemCache) {
        body.cachedContent = _guestGemCache;
      } else {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
      }
      const abort = new AbortController();
      const connectTimer = setTimeout(() => { try { abort.abort(); } catch {} }, 12_000);
      let resp;
      try {
        resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: abort.signal,
          }
        );
      } catch (err) {
        clearTimeout(connectTimer);
        console.error(`❌ Guest Gemini (${model}) connect failed:`, err?.message || err);
        return { started: false };
      }
      clearTimeout(connectTimer);
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        console.error(`❌ Guest Gemini (${model}) HTTP ${resp.status}:`, errJson?.error?.message || resp.statusText);
        return { started: false };
      }

      let started = false;
      const reader = resp.body;
      let buffer = '';
      let lastFinishReason = '';
      let blockReason = '';
      // Accumulate the full visible reply server-side so we can detect when
      // the model emits malformed hidden syntax mid-sentence
      // Used purely for observability —
      // the client already trims dangling fragments back to a sentence
      // boundary; this just lets us see how often it happens per model.
      let accumulatedText = '';
      let inactivityRef = setTimeout(() => { try { abort.abort(); } catch {} sendError(AI_TEMPORARY_FAILURE_TEXT); }, 45_000);
      const bumpInactivity = () => {
        clearTimeout(inactivityRef);
        inactivityRef = setTimeout(() => { try { abort.abort(); } catch {} sendError(AI_TEMPORARY_FAILURE_TEXT); }, 45_000);
      };

      // Pull every text part out of a Gemini SSE payload, skipping the
      // thought-summary parts (Gemini 2.5+ "thinking" mode marks them with
      // `thought: true`). Also concatenates ALL parts, not just parts[0] —
      // longer answers are returned as multiple parts in a single candidate.
      const extractGeminiText = (parsed) => {
        const cand = parsed?.candidates?.[0];
        if (!cand) return '';
        const parts = cand?.content?.parts;
        if (!Array.isArray(parts)) return '';
        let out = '';
        for (const part of parts) {
          if (part?.thought === true) continue;
          if (typeof part?.text === 'string') out += part.text;
        }
        return out;
      };

      return await new Promise((resolve) => {
        const processGeminiPayload = (payload) => {
          if (!payload || payload === '[DONE]') return;
          let parsed;
          try { parsed = JSON.parse(payload); } catch { return; }
          if (parsed?.error) {
            blockReason = parsed.error?.message || blockReason || 'gemini_error';
            return;
          }
          if (parsed?.promptFeedback?.blockReason) {
            blockReason = parsed.promptFeedback.blockReason;
          }
          const text = extractGeminiText(parsed);
          if (text) {
            if (!started) { started = true; resolve({ started: true }); }
            accumulatedText += text;
            sendChunk(text);
          }
          const fr = parsed?.candidates?.[0]?.finishReason;
          if (fr) lastFinishReason = fr;
        };
        reader.on('data', (chunk) => {
          if (ended) return;
          bumpInactivity();
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            processGeminiPayload(trimmed.slice(6));
          }
        });
        reader.on('end', () => {
          clearTimeout(inactivityRef);
          // Drain any trailing content in the buffer — Gemini occasionally
          // closes the connection without a final newline after the last
          // `data: {...}` event, which used to silently drop the final
          // sentence(s) of a reply.
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              processGeminiPayload(trimmed.slice(6));
            }
            buffer = '';
          }
          if (!started) {
            if (blockReason) {
              console.warn(`⚠️ Guest Gemini (${model}) blocked: ${blockReason}`);
            }
            resolve({ started: false });
            return;
          }
          if (lastFinishReason === 'MAX_TOKENS') {
            // Don't push a "Sign in for the full version" notice into the
            // visible reply — it reads as an abdication AND as a sales push,
            // both of which break the onboarding voice. Server-log only so
            // we can monitor how often 4000 tokens still isn't enough for
            // the guest onboarding turn (it shouldn't be — onboarding replies
            // are 1-3 sentences by design).
            console.warn(`⚠️ Guest Gemini (${model}) hit MAX_TOKENS at 4000-token cap. Onboarding reply ran ~3000 words — prompt may be drifting from the 1-3 sentence target.`);
          } else if (lastFinishReason === 'SAFETY' || lastFinishReason === 'PROHIBITED_CONTENT' || blockReason) {
            sendChunk('\n\n_…response stopped early (safety filter)._');
          }
          // Observability: log when the model started a hidden tag right
          // after a non-terminal character. This is the failure mode that
          // surfaced as "Elijah... we're a husband and soon-to-be father,
          // which fuels our obsession with efficiency and our rejection of
          // legacy, document-first tools…" — the client trims it cleanly,
          // but we want to know which model is doing this so we can keep
          // tuning the prompt or move that tier off Flash.
          const tagStart = accumulatedText.search(/<(?:learned|updated)\b/i);
          if (tagStart > 0) {
            const before = accumulatedText.slice(0, tagStart).trimEnd();
            const lastChar = before.slice(-1);
            if (before && !/[.!?…:]/.test(lastChar)) {
              console.warn(`⚠️ Guest Gemini (${model}) emitted tag mid-sentence after "${before.slice(-40)}" — client will trim. Consider model upgrade if this recurs.`);
            }
          }
          sendDone();
        });
        reader.on('error', (err) => {
          clearTimeout(inactivityRef);
          console.error(`❌ Guest Gemini (${model}) stream error:`, err?.message || err);
          if (!started) { resolve({ started: false }); return; }
          // Already streamed text — close cleanly so client keeps the partial.
          sendDone();
        });
      });
    };

    const tryOpenAI = async (model) => {
      // Chat Completions stream — well-documented SSE format that mirrors
      // Anthropic / Gemini's "data: {...}" + "data: [DONE]" pattern.
      const inferTarget = resolveInferenceTarget(model);
      const inferKey = process.env[inferTarget.keyVar];
      if (!inferKey) return { started: false };
      const messages = [
        { role: 'system', content: systemPrompt },
        ...trimmedHistory.map((m) => ({
          role: m.role === 'model' ? 'assistant' : 'user',
          content: m.content,
        })),
        { role: 'user', content: prompt },
      ];
      const body = {
        model: inferTarget.upstreamId || model,
        messages,
        stream: true,
        max_tokens: 2048,
        temperature: 0.7,
      };
      const abort = new AbortController();
      const connectTimer = setTimeout(() => { try { abort.abort(); } catch {} }, 12_000);
      let resp;
      try {
        resp = await fetch(`${inferTarget.baseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${inferKey}`,
            'Content-Type': 'application/json',
            ...(inferTarget.extraHeaders || {}),
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      } catch (err) {
        clearTimeout(connectTimer);
        console.error(`❌ Guest ${inferTarget.gateway} (${model}) connect failed:`, err?.message || err);
        return { started: false };
      }
      clearTimeout(connectTimer);
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        console.error(`❌ Guest OpenAI (${model}) HTTP ${resp.status}:`, errJson?.error?.message || resp.statusText);
        return { started: false };
      }

      let started = false;
      const reader = resp.body;
      let buffer = '';
      let inactivityRef = setTimeout(() => { try { abort.abort(); } catch {} sendError(AI_TEMPORARY_FAILURE_TEXT); }, 45_000);
      const bumpInactivity = () => {
        clearTimeout(inactivityRef);
        inactivityRef = setTimeout(() => { try { abort.abort(); } catch {} sendError(AI_TEMPORARY_FAILURE_TEXT); }, 45_000);
      };

      return await new Promise((resolve) => {
        const processOaiPayload = (payload) => {
          if (!payload || payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload);
            const text = parsed.choices?.[0]?.delta?.content;
            if (parsed.usage) guestUsage = extractOpenRouterUsage(parsed);
            if (text) {
              if (!started) { started = true; resolve({ started: true }); }
              sendChunk(text);
            }
          } catch { /* ignore partial json */ }
        };
        reader.on('data', (chunk) => {
          if (ended) return;
          bumpInactivity();
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') { sendDone(); return; }
            processOaiPayload(payload);
          }
        });
        reader.on('end', () => {
          clearTimeout(inactivityRef);
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              const payload = trimmed.slice(6);
              if (payload === '[DONE]') { sendDone(); return; }
              processOaiPayload(payload);
            }
            buffer = '';
          }
          if (!started) { resolve({ started: false }); return; }
          sendDone();
        });
        reader.on('error', (err) => {
          clearTimeout(inactivityRef);
          console.error(`❌ Guest OpenAI (${model}) stream error:`, err?.message || err);
          if (!started) { resolve({ started: false }); return; }
          sendDone();
        });
      });
    };

    // Walk the chain in order. The first provider that successfully starts
    // emitting tokens "wins"; failures before any tokens are streamed are
    // silent (the user just sees the next provider's output).
    const viaOpenRouter = openRouterConfigured();
    for (const cfg of availableProviders) {
      if (ended) return;
      let outcome;
      if (viaOpenRouter) outcome = await tryOpenAI(cfg.model);
      else if (cfg.provider === 'anthropic') outcome = await tryAnthropic(cfg.model);
      else if (cfg.provider === 'google') outcome = await tryGemini(cfg.model);
      else if (cfg.provider === 'openai') outcome = await tryOpenAI(cfg.model);
      else continue;
      if (outcome.started) {
        winner = {
          provider: viaOpenRouter ? 'openrouter' : cfg.provider,
          model: cfg.model,
        };
        console.log(`✅ Guest stream served by ${winner.provider} (${cfg.model})`);
        return;
      }
      console.warn(`⚠️ Guest stream falling back from ${cfg.provider} (${cfg.model})`);
    }

    // All providers failed before streaming a single token.
    return sendError(AI_TEMPORARY_FAILURE_TEXT);
  });
}
