// Model catalog, provider routing, and non-stream OpenAI invoke.
import fetch from 'node-fetch';
import {
  isTogetherDedicatedEndpointError,
  isTogetherInferenceModel,
} from '../../lib/lora/togetherLora.js';
import { splitPromptForProvider, pickOutputCap, clampForProvider } from './promptUtils.js';

export function internalHeaders(req) {
  const h = { 'Content-Type': 'application/json' };
  if (req?.headers?.authorization) h['Authorization'] = req.headers.authorization;
  return h;
}

export const MODEL_CATALOG = [
  { id: 'lykn', label: 'LYKN', provider: 'system', env: 'OPENAI_API_KEY' },
];

// Brand alias → real model. Keep in sync with `LYKN_ROUTED_MODELS`
// in `src/lib/modelCatalog.js` (client-side doc constant). The server is
// the source of truth — clients only ever send the LYKN ids.
//
// LYKN brand alias → real model. `gpt-5.6-terra` for everyday accuracy
// (Glass + in-app chat). Pro frontier picker still exposes Sol separately.
// Retired tier ids (lykn-lite / lykn-fast / lykn-deep) still resolve here
// so cached preferences and older clients keep working.
export const LYKN_ROUTED_MODELS = {
  lykn: 'gpt-5.6-terra',
  'lykn-lite': 'gpt-5.6-terra',
  'lykn-fast': 'gpt-5.6-terra',
  'lykn-deep': 'gpt-5.6-terra',
};
export const LYKN_ROUTED_FALLBACK = 'gemini-pro-latest';

export const resolveLyknAlias = (model) => {
  const routed = LYKN_ROUTED_MODELS[model];
  if (!routed) return model;
  if (routed.startsWith('gpt-') && process.env.OPENAI_API_KEY) return routed;
  if (routed.startsWith('gemini-') && process.env.GOOGLE_API_KEY) return routed;
  if (process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY) return routed;
  return LYKN_ROUTED_FALLBACK;
};

export const normalizeRequestedModel = (model) => {
  const value = String(model || '').trim();
  if (!value) return 'gemini-flash-latest';
  return value;
};

// Fast/cheap models whose NATIVE vision is weak at reading dense, small,
// or handwritten text in images (the everyday LYKN route lands on
// gpt-4.1-nano, which is exactly this case). When a turn actually carries
// image(s) we transparently upgrade these to a strong vision reader so
// "read the text in this screenshot" works. Text-only turns are never
// touched — this only fires when images are attached.
export const WEAK_VISION_MODELS = new Set([
  'gpt-4.1-nano', 'gpt-4o-mini', 'gpt-3.5-turbo',
  'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite',
  'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash',
  'claude-3-5-haiku-latest', 'claude-haiku-4-5-20251001',
  'grok-4-fast', 'grok-4-fast-non-reasoning',
]);

// Same-provider-first strong vision reader, degrading by available API key
// so we never route to a provider that isn't configured. Gemini Pro and
// GPT-4.1 are both strong, cost-effective text readers.
export const pickStrongVisionModel = (model) => {
  const m = String(model || '');
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasGoogle = !!process.env.GOOGLE_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasXAI = !!process.env.XAI_API_KEY;
  if ((m.startsWith('gpt-') || OPENAI_O_SERIES.has(m)) && hasOpenAI) return 'gpt-4.1';
  if (m.startsWith('gemini-') && hasGoogle) return 'gemini-pro-latest';
  if (m.startsWith('claude') && hasAnthropic) return resolveAnthropicModel('claude-sonnet-4-6');
  if (m.startsWith('grok') && hasXAI) return 'grok-4.3';
  // Cross-provider fallback (prefer the strong, low-cost readers first).
  if (hasGoogle) return 'gemini-pro-latest';
  if (hasOpenAI) return 'gpt-4.1';
  if (hasAnthropic) return resolveAnthropicModel('claude-sonnet-4-6');
  if (hasXAI) return 'grok-4.3';
  return m;
};

export const upgradeModelForVision = (model, hasImages) => {
  if (!hasImages) return model;
  if (!WEAK_VISION_MODELS.has(model)) return model;
  const upgraded = pickStrongVisionModel(model);
  if (upgraded && upgraded !== model) {
    console.log(`🔬 Vision upgrade: ${model} → ${upgraded} (image turn — stronger reader)`);
    return upgraded;
  }
  return model;
};

// Coded-artifact turns (forced lykn_build_react_artifact build, or an open
// React artifact being edited) route to a dedicated CODING model instead of
// whatever chat model the turn arrived on:
//
//   1. Cheap/fast chat models (and historically the everyday `lykn` route
//      when it was gpt-4.1-nano; Glass still always sends `lykn`) reliably
//      FAIL at writing a complete React component into a tool-call argument
//      — they emit the forced call with an empty `code`, get the
//      `code_required` error back, and apologize in a loop instead of coding.
//   2. Grok 4.5 is xAI's frontier coding model ($2/M in, $6/M out — cheaper
//      than sonnet/gpt frontier tiers) and writes full apps/sites/worksheets
//      in one shot, so when the xAI key is configured EVERY coded-artifact
//      turn goes there regardless of the incoming model.
//
// Without an xAI key we fall back to the old behavior: bump weak models to
// the same strong same-provider models the vision upgrade uses. Normal
// (non-artifact) turns are never touched.
//
// CODED_ARTIFACT_MODEL env var overrides the default (e.g. when the xAI
// account runs out of credits, point it at gemini-3.1-pro-preview or
// gpt-4.1 until credits are topped up).
export const CODED_ARTIFACT_MODEL = String(process.env.CODED_ARTIFACT_MODEL || 'grok-4.5').trim();
export const codedArtifactModelAvailable = () => {
  if (CODED_ARTIFACT_MODEL.includes('grok')) return !!process.env.XAI_API_KEY;
  if (CODED_ARTIFACT_MODEL.includes('claude')) return !!process.env.ANTHROPIC_API_KEY;
  if (CODED_ARTIFACT_MODEL.includes('gemini')) return !!process.env.GOOGLE_API_KEY;
  return !!process.env.OPENAI_API_KEY;
};
// Does a BUILD request lean on what's currently on screen? ("build a chart
// based off of this data", "make me a website like this one", "recreate
// this page"). When it does, the overlay screenshot is real input — keep it
// and route to a vision-capable coder instead of dropping it for grok.
// Deliberately narrow: bare "this"/"it" without a screen-ish noun or a
// "based on/off / like / from" frame does NOT match, so self-contained
// requests ("build me a website for this idea: …") stay on the cheap path.
export const BUILD_SCREEN_REF_RE = new RegExp(
  [
    // "…my screen / the screen / on screen"
    /\b(?:on\s+)?(?:my|the)\s+screen\b/.source,
    // "what you see / what I'm looking at"
    /\bwhat\s+(?:you|i)(?:'m|\s+am)?\s+(?:can\s+)?(?:see|see(?:ing)?|look(?:ing)?\s+at)\b/.source,
    // "this <screen-ish thing>" — data, table, page, design, one, …
    /\b(?:this|that)\s+(?:data|dataset|table|chart|graph|figure|numbers?|stats?|page|site|website|web\s?page|article|design|layout|ui|mockup|screenshot|image|picture|spreadsheet|sheet|doc(?:ument)?|form|list|dashboard|one)\b/.source,
    // "these numbers / those values"
    /\b(?:these|those)\s+(?:numbers?|stats?|values?|results?|figures?|rows?|entries|data)\b/.source,
    // "based on/off (of) this|that", "like this|that", "from this|that",
    // "off of this" — reference frames where the pronoun stands alone
    /\b(?:based\s+(?:on|off)(?:\s+of)?|like|from|off\s+of|copy(?:ing)?|recreate|rebuild|clone)\s+(?:this|that|it)\b/.source,
  ].join('|'),
  'i',
);

// Video-render turns (lykn_render_video) are model-chosen, not a forced mode,
// so we can only sniff intent from the text. Used to (a) extend the SSE hard
// timeout — server-side Remotion renders take 1-4 real minutes on top of code
// generation — and (b) surface the [USER_IMAGES]/[GENERATED_IMAGES] URL blocks
// so the model can feed hosted images into <Img>. Deliberately loose: a false
// positive just means a longer ceiling and an extra prompt block, both benign.
export const VIDEO_RENDER_INTENT_RE =
  /\b(?:mp4|video|animat(?:e|ed|ion|ions)|motion\s+graphics?|ken\s*burns|(?:intro|title|logo)\s+(?:clip|reel|animation)|clip\s+for\b)\b/i;

export const upgradeModelForCodedArtifact = (model, needsCodedArtifact) => {
  if (!needsCodedArtifact) return model;
  if (codedArtifactModelAvailable()) {
    if (model !== CODED_ARTIFACT_MODEL) {
      console.log(`🧑‍💻 Code-artifact route: ${model} → ${CODED_ARTIFACT_MODEL} (React artifact turn — dedicated coding model)`);
    }
    return CODED_ARTIFACT_MODEL;
  }
  if (!WEAK_VISION_MODELS.has(model)) return model;
  const upgraded = pickStrongVisionModel(model);
  if (upgraded && upgraded !== model) {
    console.log(`🧑‍💻 Code-artifact upgrade: ${model} → ${upgraded} (React artifact turn — stronger code writer)`);
    return upgraded;
  }
  return model;
};

export const OPENAI_O_SERIES = new Set(['o3', 'o3-pro', 'o4-mini']);
export const isOpenAIModel = (m) => m.startsWith('gpt-') || OPENAI_O_SERIES.has(m);
export const isTogetherModel = (m) => isTogetherInferenceModel(m);

export const RETRYABLE_STATUSES = new Set([429, 503, 529]);
// "Retryable" here means "another provider in the fallback chain can still
// answer" — that includes account-level failures on ONE provider (credits
// exhausted, spending limit, billing/permission 403s), not just transient
// capacity errors. xAI's out-of-credits message is "used all available
// credits or reached its monthly spending limit" (code permission-denied).
// Auth failures (invalid/stale API key, revoked token) also count: they are
// account-level failures on ONE provider, and another provider in the chain
// can still answer. Without this, a bad XAI_API_KEY in the deployed env made
// every build-mode turn die with the generic "trouble connecting" error
// instead of falling back to Claude/GPT/Gemini.
export const isRetryableProviderError = (errMsg) =>
  /429|rate.?limit|overloaded|529|503|too many|capacity|resource.?exhaust|quota.?exceed|credits?|spending.?limit|permission.?denied|billing|insufficient.?funds|invalid.?(api.?)?key|incorrect.?api.?key|unauthorized|authentication|401|403|forbidden/i.test(errMsg) ||
  isTogetherDedicatedEndpointError(errMsg);

export function getFallbackModels(failedModel) {
  // Multi-tier fallback chain. Walked in order by the streaming + invoke
  // recursion (`tryStreamAt` / `_invokeModels`) until one provider returns
  // visible text. Order intent:
  //
  //   1. Same-provider, faster variant (Gemini Flash before Pro, etc.) —
  //      cheapest swap, near-zero behavior change for the user. Catches
  //      ~80% of failures (single-model rate limits, MAX_TOKENS thought-
  //      only burns, transient HTTP 5xx from Google).
  //
  //   2. Cross-provider, cheap/fast tier from every OTHER provider that
  //      has a key configured. Catches the remaining ~20% of failures
  //      (whole-region Google outage, Anthropic capacity events, OpenAI
  //      streaming endpoint flapping). With OPENAI/ANTHROPIC/XAI/GOOGLE
  //      keys all set, the probability that EVERY provider is down at
  //      the same instant is small enough that the "this model isn't
  //      working" message becomes essentially unreachable in practice.
  //
  // Intentional choices:
  //   • The cross-provider tier uses the cheapest fast model from each
  //     provider, NOT a like-for-like swap. The user already saw their
  //     preferred model fail; getting them ANY good answer beats no
  //     answer or a "switch models" error. We log the swap so we can
  //     audit which providers we landed on.
  //   • We only enqueue providers whose API key is actually present —
  //     no point falling through to OpenAI if OPENAI_API_KEY is unset.
  //   • Models are deduped against `failedModel` so we don't retry the
  //     exact model that just failed.
  const fb = [];
  const seen = new Set([String(failedModel || '')]);
  const add = (m) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    fb.push(m);
  };

  // Same-provider Gemini fallbacks first.
  if (process.env.GOOGLE_API_KEY) {
    add('gemini-flash-latest');
    add('gemini-pro-latest');
  }

  // Cross-provider safety nets — one cheap/fast model per provider.
  if (process.env.OPENAI_API_KEY) add('gpt-4.1-nano');
  if (process.env.ANTHROPIC_API_KEY) add('claude-3-5-haiku-latest');
  if (process.env.XAI_API_KEY) add('grok-4-fast-non-reasoning');

  // If GOOGLE_API_KEY was missing above (no Gemini), still queue Gemini
  // last in case the env was repaired mid-process — cheap to try.
  if (process.env.GOOGLE_API_KEY) add('gemini-flash-latest');

  return fb;
}

// ---------------------------------------------------------------------------
// User-facing fallback copy.
// ---------------------------------------------------------------------------
// Single source of truth for what we say when the entire provider chain has
// been exhausted (which after the cross-provider expansion of getFallbackModels
// should be functionally never). Callers used to scatter "this model isn't
// working — try another model" everywhere; that copy was honest about the
// failure but it (a) blamed the model, (b) put the recovery work back on the
// user, and (c) implied the user had a working alternative at hand. The new
// copy is honest about being temporary and never tells the user to manually
// switch — the AUTOMATIC fallback chain already tried every available
// alternative on their behalf.
// Soft copy — never "trouble connecting". That phrasing fired on stalls
// (image gen / long builds) that were not real network failures.
export const AI_TEMPORARY_FAILURE_TEXT = "That didn't work — try again in a moment.";
export const IMAGE_GEN_FAILURE_TEXT = "Couldn't create that image — try again in a moment.";

export function extractPureUserMessage(text, prompt) {
  const raw = String(text || '').trim();
  if (!raw) return String(prompt || '').trim().slice(0, 500);
  const latestMarker = raw.indexOf('Latest user message:\n');
  if (latestMarker >= 0) {
    return raw.slice(latestMarker + 'Latest user message:\n'.length).trim().slice(0, 500);
  }
  const convMarker = raw.indexOf('Conversation so far:\n');
  if (convMarker === 0) {
    const lastUserIdx = raw.lastIndexOf('\nUser: ');
    if (lastUserIdx >= 0) {
      const afterUser = raw.slice(lastUserIdx + '\nUser: '.length);
      const nextNewline = afterUser.indexOf('\n');
      return (nextNewline >= 0 ? afterUser.slice(0, nextNewline) : afterUser).trim().slice(0, 500);
    }
  }
  return raw.slice(0, 500);
}

export const resolveAnthropicModel = (model) => {
  const value = String(model || '').trim();
  const aliasMap = {
    // Preferred "latest" aliases -> concrete Anthropic model IDs
    'claude-3-7-sonnet-latest': 'claude-sonnet-4-6',
    'claude-3-5-sonnet-latest': 'claude-sonnet-4-6',
    'claude-3-5-haiku-latest': 'claude-haiku-4-5-20251001',
    'claude-3-haiku': 'claude-haiku-4-5-20251001',
    'claude-3-haiku-20240307': 'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',

    // Legacy IDs -> current supported IDs
    'claude-3-5-sonnet-20240620': 'claude-sonnet-4-6',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
    'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6',
    'claude-3-opus-20240229': 'claude-opus-4-8',
    'claude-3-sonnet-20240229': 'claude-sonnet-4-6',
    'claude-opus-4-6': 'claude-opus-4-8',
    'claude-opus-4-6-code': 'claude-opus-4-8',
    'claude-opus-4-7': 'claude-opus-4-8',
  };
  return aliasMap[value] || value;
};

export const OPENAI_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export let openaiModelsCache = {
  expiresAt: 0,
  models: [],
};

export const parseOpenAIResponsesText = (data) => {
  const direct = String(data?.output_text || '').trim();
  if (direct) return direct;

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = String(part?.text || '').trim();
      if (text) return text;
    }
  }
  return '';
};

// Models that REQUIRE the /v1/responses endpoint. Everything else uses
// /v1/chat/completions exclusively — the previous "try Responses, fall back
// to Chat" pattern cost us a duplicate billed request on every model that
// silently returned empty from Responses.
export const OPENAI_RESPONSES_ONLY = new Set(['o3', 'o3-pro', 'o4-mini']);

export const invokeOpenAIModel = async (model, promptInput, imageUrls = [], opts = {}) => {
  const headers = {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const { system: sysPrompt, user: userPrompt } = typeof promptInput === 'string'
    ? splitPromptForProvider(promptInput)
    : promptInput;
  const fullPromptText = sysPrompt ? `${sysPrompt}\n\n${userPrompt}` : userPrompt;
  const hasImages = imageUrls.length > 0;
  const cap = clampForProvider(pickOutputCap({
    wantsActions: Boolean(opts.wantsActions),
    hasImages,
    intent: opts.intent,
    override: opts.maxTokens,
  }), model);
  const cacheKey = `lykn-${String(opts.userId || 'anon').slice(0, 32)}`;

  // Responses API only for models that need it (o-series, no vision).
  // For every other model — including the entire gpt-* family — go straight
  // to chat completions, which avoids the historical "Responses fails
  // silently → fall back to Chat → pay twice" pattern.
  if (OPENAI_RESPONSES_ONLY.has(model) && !hasImages) {
    const responsesBody = {
      model,
      input: userPrompt,
      max_output_tokens: cap,
      prompt_cache_key: cacheKey,
    };
    if (sysPrompt) responsesBody.instructions = sysPrompt;
    const responsesRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(responsesBody),
    });

    if (!responsesRes.ok) {
      const errorData = await responsesRes.json().catch(() => ({}));
      throw new Error(`OpenAI Responses (${responsesRes.status}): ${errorData.error?.message || responsesRes.statusText}`);
    }
    const data = await responsesRes.json();
    const responseText = parseOpenAIResponsesText(data);
    const usage = data.usage
      ? { input_tokens: data.usage.input_tokens || 0, output_tokens: data.usage.output_tokens || 0 }
      : { input_tokens: estimateTokens(fullPromptText), output_tokens: estimateTokens(responseText) };
    return { text: responseText, usage };
  }

  const messages = [];
  if (sysPrompt) messages.push({ role: 'system', content: sysPrompt });
  const userContent = hasImages
    ? [{ type: 'text', text: userPrompt }, ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } }))]
    : userPrompt;
  messages.push({ role: 'user', content: userContent });

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_completion_tokens: cap,
      prompt_cache_key: cacheKey,
    }),
  });

  if (!openaiRes.ok) {
    const errorData = await openaiRes.json().catch(() => ({}));
    throw new Error(`OpenAI (${openaiRes.status}): ${errorData.error?.message || openaiRes.statusText}`);
  }
  const data = await openaiRes.json();
  const text = data.choices?.[0]?.message?.content?.trim() || '';
  const usage = extractOpenAIUsage(data);
  return { text, usage };
};

export const getDynamicOpenAIGptModels = async () => {
  if (!process.env.OPENAI_API_KEY) return [];
  const now = Date.now();
  if (openaiModelsCache.expiresAt > now && openaiModelsCache.models.length) {
    return openaiModelsCache.models;
  }
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      console.warn('⚠️ Failed to fetch OpenAI model list:', errorData?.error?.message || res.statusText);
      return openaiModelsCache.models;
    }

    const data = await res.json();
    const ids = Array.isArray(data?.data)
      ? data.data
          .map((m) => String(m?.id || '').trim())
          .filter((id) => isOpenAIModel(id))
      : [];
    const models = [...new Set(ids)].sort();
    openaiModelsCache = {
      expiresAt: now + OPENAI_MODEL_CACHE_TTL_MS,
      models,
    };
    return models;
  } catch (error) {
    console.warn('⚠️ Failed to fetch OpenAI models:', error?.message || error);
    return openaiModelsCache.models;
  }
};
