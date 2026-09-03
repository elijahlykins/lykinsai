/**
 * Provider-agnostic structured-output calls for the browser agent.
 *
 * The browser agent's four stages (plan / decide / verify / learn) each need a
 * JSON object matching a schema, and the eval harness needs to point different
 * stages at different providers — an Opus 5 planner in front of a GPT-5.6 or
 * Gemini decider. The original /api/desktop/agent-model handler was hardwired
 * to OpenAI from its first line, so that split was impossible.
 *
 * This module owns the three structured-output dialects and nothing else:
 *   OpenAI     response_format.json_schema
 *   Anthropic  output_config.format.json_schema   (JSON arrives in a text block)
 *   Gemini     generationConfig.responseSchema    (OpenAPI subset — see sanitize)
 *
 * It deliberately uses raw fetch rather than a vendor SDK: every other provider
 * call in this repo does, and a dispatcher where one branch is an SDK and three
 * are fetch is worse than one that is uniform.
 */

import {
  isOpenRouterTarget,
  OPENROUTER_BASE_URL,
  openRouterHeaders,
  resolveInferenceTarget,
} from './inference/resolveGateway.js';

/**
 * Mirror of providerForModel in mcp-tools/chatTools.js.
 *
 * Deliberately duplicated rather than imported: that module pulls in
 * beliefSystem.js, which imports node-fetch (not installed), so importing it
 * here would make every agent-model call depend on an unrelated broken chain.
 * Eight lines of duplication beats that coupling — keep the two in sync.
 *
 * @param {string} model
 * @returns {'openai'|'anthropic'|'grok'|'gemini'|null}
 */
export function providerForModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (m.includes('/')) return 'openrouter';
  if (m.startsWith('gpt-') || m === 'o3' || m === 'o3-pro' || m === 'o4-mini') return 'openai';
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('grok')) return 'grok';
  if (m.startsWith('gemini-') || m.includes('gemini')) return 'gemini';
  return null;
}

/** Reasoning-effort levels every provider here understands, in ascending order. */
export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Gemini's responseSchema is an OpenAPI 3.0 subset, not full JSON Schema: it
 * rejects `additionalProperties` and `$schema` outright, which every schema in
 * runtime/model.cjs sets. Strip what it cannot parse rather than maintaining a
 * second copy of each schema.
 *
 * @param {any} node
 * @returns {any}
 */
/**
 * Anthropic's structured output rejects OPEN objects outright:
 *   "For 'object' type, 'additionalProperties: true' is not supported."
 *
 * Found by a live run, not by the earlier model verification — that used a
 * hand-written schema with no nested open map, so it passed and hid this. The
 * real PLAN_SCHEMA has `knownFacts: {type:'object', additionalProperties:true}`,
 * an arbitrary fact map, and every plan call 400'd. The loop swallows a failed
 * plan by design ("planning is guidance"), so the only visible symptom was that
 * Opus 5 silently never ran and every task fell back to "Work toward: <goal>".
 *
 * Closing the object is the only option the API allows. The cost is real and
 * worth stating: a closed object with no declared properties can only ever come
 * back as {}, so `knownFacts` is always empty on the Anthropic path. Planning
 * still works — the model returns steps and constraints — it just cannot hand
 * back a free-form fact map. Fixing that properly means reshaping the field
 * into something every provider can express (an array of strings), which is a
 * production change rather than a transport one.
 */
export function anthropicSchema(node) {
  if (Array.isArray(node)) return node.map(anthropicSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    out[k] = anthropicSchema(v);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

export function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

/**
 * Flatten a JSON Schema's `description` fields into a prose field reference.
 *
 * Gemini's responseSchema is an OpenAPI subset that silently DROPS `description`
 * on every property, so a model behind it never sees the per-field guidance that
 * OpenAI and Anthropic read straight out of the schema. Measured effect on the
 * browser agent's DECISION_SCHEMA: Gemini omitted the `action.target` element
 * reference on 3 of 3 sampled decisions and substituted x/y coordinates, which
 * `normalizeDecision` rejects as invalid — an arm would score near zero for a
 * dialect artifact rather than for anything about the model.
 *
 * Re-emitting the descriptions as text restores parity. It does not grant Gemini
 * anything the other providers lack; it hands back what its own schema format
 * threw away.
 *
 * @param {any} node
 * @param {string} [path]
 * @param {string[]} [out]
 * @returns {string[]} lines like "action.target: Element reference like e12 ..."
 */
export function flattenDescriptions(node, path = '', out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.description === 'string' && node.description.trim() && path) {
    out.push(`- ${path}: ${node.description.trim()}`);
  }
  if (Array.isArray(node.enum) && path) {
    out.push(`- ${path}: one of ${node.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [k, v] of Object.entries(node.properties)) {
      flattenDescriptions(v, path ? `${path}.${k}` : k, out);
    }
  }
  if (node.items) flattenDescriptions(node.items, path ? `${path}[]` : '[]', out);
  return out;
}

/** Split a data: URL into the media type and bare base64 payload. */
function splitDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  return m ? { mediaType: m[1], data: m[2] } : null;
}

/** Cap and normalise the image list callers may pass as imageUrl or imageUrls. */
function normaliseImages(imageUrl, imageUrls, max = 10) {
  const all = []
    .concat(Array.isArray(imageUrls) ? imageUrls : [])
    .concat(imageUrl ? [imageUrl] : [])
    .map((u) => String(u || '').trim())
    .filter((u) => u.startsWith('data:image/'));
  return all.slice(0, max);
}

/**
 * Extract and parse the FIRST complete top-level JSON object in a string.
 *
 * Exists because `strict: false` json_schema does not constrain decoding, and
 * gpt-5.6-terra through OpenRouter emits TWO schema-valid objects back to back
 * (an `act` decision followed by a speculative `finish`) on roughly one decide
 * call in five. A first-`{`-to-last-`}` slice spans both objects and fails to
 * parse, which surfaced to users as "agent model unavailable (502)". The scan
 * is string-aware, so braces inside quoted values do not confuse the depth.
 */
export function firstJsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Models occasionally wrap JSON in a fenced block despite the schema.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    if (fenced) {
      const fromFence = firstJsonObject(fenced[1]);
      if (fromFence != null) return fromFence;
    }
    // Leading prose, trailing prose, or a second concatenated object — take
    // the first complete object and ignore the rest.
    return firstJsonObject(raw);
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

/**
 * x.ai speaks the OpenAI dialect, which is why grok shares this client. It does
 * NOT share OpenAI's endpoint or key — routing it here without swapping both
 * sent every Grok request to api.openai.com with the OpenAI credential.
 */
const OPENAI_COMPATIBLE = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', keyVar: 'OPENAI_API_KEY' },
  grok: { url: 'https://api.x.ai/v1/chat/completions', keyVar: 'XAI_API_KEY' },
  openrouter: { url: `${OPENROUTER_BASE_URL}/chat/completions`, keyVar: 'OPENROUTER_API_KEY' },
};

async function callOpenAi({ model, system, user, images, schema, maxTokens, effort, name, signal, cacheKey = '', provider = 'openai' }) {
  const target = OPENAI_COMPATIBLE[provider] || OPENAI_COMPATIBLE.openai;
  const key = process.env[target.keyVar];
  if (!key) return { ok: false, status: 503, error: `${target.keyVar} not configured` };

  // `detail: 'low'` downsamples the image to roughly 512px on its long edge.
  // The agent reads 0-1000 coordinates off these frames, so anything it is
  // asked to click has to survive the downsample — send them at full detail.
  const content = images.length
    ? [{ type: 'text', text: user }, ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } }))]
    : user;

  // GPT-5 family: max_completion_tokens + reasoning_effort, and temperature is
  // rejected. Reasoning tokens count against the cap, so leave headroom.
  const isGpt5 = /(?:^|\/)gpt-5/.test(model);
  const tokenParams = isGpt5
    ? {
        max_completion_tokens: effort && effort !== 'none' ? maxTokens + 2000 : maxTokens,
        ...(effort && effort !== 'none' ? { reasoning_effort: effort } : {}),
      }
    : { max_tokens: maxTokens, temperature: 0.15 };

  // `prompt_cache_key` does not create or configure a cache — OpenAI caches
  // prefixes over ~1024 tokens automatically. It is a routing hint: same key,
  // same backend machine, so repeat calls land on a warm cache instead of a
  // cold one. Omitting it or sending a stale one costs nothing beyond the miss
  // you would already have had.
  //
  // WORTH CHECKING BEFORE YOU ASSUME IT HELPS HERE. The hint only pays off
  // where a *stable* prefix clears the ~1024-token bar. Across these stages
  // only the system prompt is stable — screenshot, element catalog, DOM text,
  // plan state and last-action diff all change every turn — so the whole win
  // rides on how long that one prompt is. The gpt-5.6-luna paths are the
  // marginal case: luna's system prompt sits right around the threshold, so it
  // may cache nothing at all while a longer-prompted stage on the same route
  // caches well. Read `cached_tokens` off a real run before concluding either
  // way; a key that never hits is harmless, but it is not evidence of savings.
  const body = {
    model,
    ...tokenParams,
    ...(cacheKey ? { prompt_cache_key: String(cacheKey).slice(0, 128) } : {}),
    response_format: { type: 'json_schema', json_schema: { name, schema, strict: false } },
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content },
    ],
  };

  const r = await fetch(target.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(provider === 'openrouter' ? openRouterHeaders() : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: String(d?.error?.message || `${provider} call failed`).slice(0, 300) };

  const json = parseJsonLoose(d.choices?.[0]?.message?.content);
  const u = d.usage || {};
  return {
    ok: json != null,
    json,
    error: json == null ? 'model returned unparseable output' : '',
    model: d.model || model,
    usage: { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 },
  };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function callAnthropic({ model, system, user, images, schema, maxTokens, effort, signal }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'ANTHROPIC_API_KEY not configured' };

  const parts = [];
  for (const url of images) {
    const img = splitDataUrl(url);
    if (img) parts.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  parts.push({ type: 'text', text: user });

  // Opus 5 rejects temperature outright, and thinking is on by default — depth
  // is controlled through output_config.effort, never a sampling parameter.
  // `disabled` thinking is only legal at effort <= high, so we never send it.
  const body = {
    model,
    max_tokens: maxTokens,
    output_config: {
      ...(effort && effort !== 'none' ? { effort } : {}),
      format: { type: 'json_schema', schema: anthropicSchema(schema) },
    },
    messages: [{ role: 'user', content: parts }],
  };
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: String(d?.error?.message || 'anthropic call failed').slice(0, 300) };

  // A refusal is a successful HTTP 200 with empty/partial content — check the
  // stop reason before reading content, or this throws on an empty array.
  if (d.stop_reason === 'refusal') {
    return { ok: false, status: 200, error: `anthropic refused (${d.stop_details?.category || 'unknown'})`, refusal: true };
  }
  const text = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = parseJsonLoose(text);
  return {
    ok: json != null,
    json,
    error: json == null ? 'model returned unparseable output' : '',
    model: d.model || model,
    usage: { inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0 },
  };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function callGemini({ model, system, user, images, schema, maxTokens, effort, signal }) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'GOOGLE_API_KEY not configured' };

  const parts = [];
  for (const url of images) {
    const img = splitDataUrl(url);
    if (img) parts.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
  }

  // Re-attach the schema field descriptions Gemini's responseSchema drops, so
  // this provider sees the same contract the others read out of the schema.
  const fieldRef = flattenDescriptions(schema);
  const userText = fieldRef.length
    ? `${user}\n\n# Field Reference\n\nThe response schema's fields mean:\n${fieldRef.join('\n')}`
    : user;
  parts.push({ text: userText });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      responseSchema: geminiSchema(schema),
      ...(effort && effort !== 'none' ? { thinkingConfig: { thinkingLevel: effort } } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal },
  );
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: String(d?.error?.message || 'gemini call failed').slice(0, 300) };

  const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('');
  const json = parseJsonLoose(text);
  const um = d.usageMetadata || {};
  return {
    ok: json != null,
    json,
    error: json == null ? 'model returned unparseable output' : '',
    model: d.modelVersion || model,
    // Thought tokens are billed as output but reported separately.
    usage: {
      inputTokens: um.promptTokenCount || 0,
      outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Call any supported provider and get back a validated JSON object.
 *
 * @param {object} opts
 * @param {string} opts.model      provider is inferred from the id
 * @param {string} [opts.system]
 * @param {string} opts.user
 * @param {string} [opts.imageUrl]   single data: URL (legacy callers)
 * @param {string[]} [opts.imageUrls] up to 10 data: URLs
 * @param {object} opts.schema     JSON Schema the response must match
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.effort]   none|low|medium|high|xhigh|max
 * @param {string} [opts.name]     schema name, for OpenAI's json_schema block
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, json?:any, error?:string, status?:number,
 *                    model?:string, provider:string, usage?:{inputTokens:number,outputTokens:number},
 *                    upstreamMs:number}>}
 */
export async function callStructured({
  model,
  system = '',
  user,
  imageUrl = '',
  imageUrls = null,
  schema,
  maxTokens = 900,
  effort = 'low',
  name = 'structured_output',
  signal = null,
  cacheKey = '',
}) {
  const provider = providerForModel(model);
  const images = normaliseImages(imageUrl, imageUrls);
  const args = { model, system, user, images, schema, maxTokens, effort, name, signal, cacheKey };
  const startedAt = Date.now();

  let out;
  try {
    if (isOpenRouterTarget(model)) {
      const target = resolveInferenceTarget(model);
      out = await callOpenAi({ ...args, model: target.upstreamId || model, provider: 'openrouter' });
    } else if (provider === 'openai' || provider === 'grok') out = await callOpenAi({ ...args, provider });
    else if (provider === 'anthropic') out = await callAnthropic(args);
    else if (provider === 'gemini') out = await callGemini(args);
    else out = { ok: false, status: 400, error: `unsupported model for structured output: ${model}` };
  } catch (e) {
    out = { ok: false, status: 502, error: `provider call threw: ${String(e?.message || e).slice(0, 200)}` };
  }

  return {
    ...out,
    provider: (isOpenRouterTarget(model) ? 'openrouter' : provider) || 'unknown',
    upstreamMs: Date.now() - startedAt,
  };
}

/**
 * Which model runs a browser-agent stage.
 *
 * Two selection paths. Normally the stage decides, from env, exactly as before.
 * The eval harness instead names an ARM — never a model — because this is an
 * authenticated route and letting a client pass an arbitrary model id is an
 * open cost hole. Arms map to models server-side and are gated behind a flag
 * plus a user allowlist.
 *
 * @param {{stage:string, arm:string, userId:string}} opts
 * @returns {{model?:string, effort?:string, armError?:string}}
 */
export function resolveAgentStageModel({ stage, arm, userId, env = process.env }) {
  if (arm) {
    if (env.BROWSER_AGENT_EVAL_ARMS_ENABLED !== '1') {
      return { armError: 'Eval arms are not enabled on this server' };
    }
    const allow = String(env.BROWSER_AGENT_EVAL_USER_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(String(userId || ''))) {
      return { armError: 'Not authorized for eval arms' };
    }
    const key = arm.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    // Planner is fixed across arms so the comparison isolates the middle model.
    if (stage === 'plan') {
      return {
        model: String(env.BROWSER_AGENT_PLAN_MODEL || 'claude-opus-5').trim(),
        effort: String(env.BROWSER_AGENT_PLAN_EFFORT || 'low').trim(),
      };
    }
    const model = String(env[`BROWSER_AGENT_ARM_${key}_MODEL`] || '').trim();
    if (!model) return { armError: `Unknown eval arm: ${arm}` };
    return {
      model,
      effort: String(env[`BROWSER_AGENT_ARM_${key}_EFFORT`] || 'low').trim(),
    };
  }

  // gpt-5.6-terra by default — 4.1-mini misread element catalogs (random
  // clicks, wrong fields) and mis-verified steps. Verify can still be
  // pointed at a cheaper model via BROWSER_AGENT_VERIFY_MODEL.
  // Learning runs once per completed task and is plain summarization of text
  // the agent already produced, so it does not need the reasoning model.
  const base = String(env.BROWSER_AGENT_MODEL || 'gpt-5.6-terra').trim();
  let model = base;
  if (stage === 'plan') {
    model = String(env.BROWSER_AGENT_PLAN_MODEL || base).trim();
  } else if (stage === 'verify') {
    model = String(env.BROWSER_AGENT_VERIFY_MODEL || base).trim();
  } else if (stage === 'learn') {
    model = String(env.BROWSER_AGENT_LEARN_MODEL || 'gpt-4.1-mini').trim();
  } else if (stage === 'route' || stage === 'offer') {
    // One small judgement before a turn starts, on a few hundred tokens.
    // route: is this prompt browser work? offer: did the user's reply accept
    // a pending browser offer? Both run in front of the user, so speed
    // matters more than depth.
    model = String(env.BROWSER_AGENT_ROUTE_MODEL || 'gpt-4.1-mini').trim();
  } else if (stage === 'monitor_semantic') {
    model = String(env.MONITOR_SEMANTIC_MODEL || env.BROWSER_AGENT_ROUTE_MODEL || 'gpt-4.1-mini').trim();
  } else if (stage === 'monitor_vision') {
    model = String(env.MONITOR_VISION_MODEL || env.BROWSER_AGENT_ROUTE_MODEL || 'gpt-4.1-mini').trim();
  } else if (stage === 'describe') {
    // Local screenshots and recordings. Needs a vision-capable model; default
    // to the same stack the desktop agent already uses for seeing pixels.
    model = String(env.DESCRIBE_MEDIA_MODEL || env.MONITOR_VISION_MODEL || base).trim();
  } else if (stage === 'judge') {
    model = String(env.BROWSER_AGENT_JUDGE_MODEL || 'claude-opus-5').trim();
  }
  return { model, effort: String(env.BROWSER_AGENT_REASONING || 'low').trim() };
}
