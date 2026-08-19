/**
 * Holo 3.1 as a dedicated grounding stage.
 *
 * lib/holo/browserAgent.js runs Holo as the whole agent loop — it decides what
 * to do AND where to click. This module uses the same model for one job only:
 * given a screenshot and a natural-language description of a target, return the
 * point on that screenshot. Deciding what to aim at belongs to the middle model.
 *
 * Grounding is deliberately STATELESS — one screenshot, one description, no
 * message history. That caps the cost at a single image per call and makes
 * accuracy measurable in isolation: a wrong point is the grounder's error, not
 * a consequence of a conversation that drifted.
 *
 * Coordinates are integers in [0, 1000] on the image, matching the convention
 * ownedBrowserAct.mapNormCoordToClient already expects.
 */

const HOLO_API_BASE = 'https://api.hcompany.ai/v1/';
const DEFAULT_HOLO_MODEL = 'holo3-1-35b-a3b';

/** What the grounder must return. Kept tiny — this is perception, not planning. */
export const HOLO_GROUND_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'true only if the described element is visible in the screenshot' },
    x: { type: 'integer', description: 'Center X of the element as an integer in [0, 1000]; 0 is the left edge' },
    y: { type: 'integer', description: 'Center Y of the element as an integer in [0, 1000]; 0 is the top edge' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string', description: 'What is actually at that point' },
  },
  required: ['found'],
};

/** Clamp to the 0-1000 image space; null when the model returned nothing usable. */
function clampCoord(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1000, Math.round(n)));
}

export function pickGroundingModel() {
  return String(
    process.env.BROWSER_AGENT_GROUND_MODEL ||
      process.env.BROWSER_CONTROL_HOLO_MODEL ||
      DEFAULT_HOLO_MODEL,
  ).trim();
}

function buildSystemPrompt() {
  return [
    'You locate a single user-interface element in a screenshot.',
    '',
    'You are given a screenshot and a description of one element. Return the',
    'center point of that element as integers in [0, 1000], where (0,0) is the',
    'top-left of the image and (1000,1000) the bottom-right.',
    '',
    'Rules:',
    '- Return found=false if the described element is not visible. It may be',
    '  below the fold, inside a closed menu, or simply absent. A wrong point is',
    '  far more costly than an honest miss, because the click lands on something',
    '  else and the page changes in a way nobody asked for.',
    '- Point at the element the description actually names, not a similar one',
    '  nearby. If two candidates match, pick the one the description locates',
    '  ("in the header", "bottom-right of the dialog") and say so in note.',
    '- note describes what is really at your point, so a wrong click can be',
    '  diagnosed afterwards.',
  ].join('\n');
}

function buildUserMessage({ description, intent, url, title, hint }) {
  const lines = [];
  if (url) lines.push(`PAGE: ${String(url).slice(0, 500)}`);
  if (title) lines.push(`TITLE: ${String(title).slice(0, 200)}`);
  lines.push(`INTENT: ${intent || 'click'}`);
  lines.push(`FIND: ${description}`);
  if (hint) lines.push(`NOTE: ${String(hint).slice(0, 300)}`);
  return lines.join('\n');
}

/**
 * Locate one described element in a screenshot.
 *
 * @param {object} opts
 * @param {string} opts.description natural-language target, e.g. "the blue Checkout button in the header"
 * @param {string} opts.imageUrl    data:image/... screenshot
 * @param {string} [opts.intent]    click | type | drag_from | drag_to
 * @param {string} [opts.url]
 * @param {string} [opts.title]
 * @param {string} [opts.hint]      e.g. why a previous attempt missed
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:true, found:boolean, x?:number, y?:number, confidence:string, note:string,
 *                    model:string, usage:object, upstreamMs:number}
 *                 | {ok:false, status?:number, error:string, upstreamMs:number}>}
 */
export async function runHoloGrounding({
  description,
  imageUrl,
  intent = 'click',
  url = '',
  title = '',
  hint = '',
  model = '',
  apiKey = '',
  signal = null,
}) {
  const startedAt = Date.now();
  const key = apiKey || process.env.HAI_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'HAI_API_KEY not configured', upstreamMs: 0 };
  if (!description || !String(imageUrl || '').startsWith('data:image/')) {
    return { ok: false, status: 400, error: 'Missing description or screenshot', upstreamMs: 0 };
  }

  const holoModel = model || pickGroundingModel();
  const body = {
    model: holoModel,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: buildUserMessage({ description, intent, url, title, hint }) },
        ],
      },
    ],
    // Perception, not deliberation: no sampling spread, a tight cap, and the
    // lowest reasoning tier. Anything more is paid latency per round.
    temperature: 0,
    max_tokens: 300,
    reasoning_effort: 'low',
    structured_outputs: { json: HOLO_GROUND_SCHEMA },
  };

  let r;
  try {
    r = await fetch(`${HOLO_API_BASE}chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    return { ok: false, status: 502, error: `grounding request failed: ${String(e?.message || e).slice(0, 200)}`, upstreamMs: Date.now() - startedAt };
  }

  const d = await r.json().catch(() => ({}));
  const upstreamMs = Date.now() - startedAt;
  if (!r.ok) {
    return { ok: false, status: r.status, error: String(d?.error?.message || 'grounding call failed').slice(0, 300), upstreamMs };
  }

  const raw = d.choices?.[0]?.message?.content;
  let parsed = null;
  if (raw && typeof raw === 'object') parsed = raw;
  else {
    try {
      parsed = JSON.parse(String(raw || ''));
    } catch {
      const m = /\{[\s\S]*\}/.exec(String(raw || ''));
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* unparseable */ } }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, status: 502, error: 'grounder returned unparseable output', upstreamMs };
  }

  const found = parsed.found === true;
  const x = clampCoord(parsed.x);
  const y = clampCoord(parsed.y);
  const u = d.usage || {};

  // found=true with no usable point is a miss, not a success — treating it as
  // one would click (0,0) on every malformed reply.
  if (found && (x === null || y === null)) {
    return {
      ok: true, found: false, confidence: 'low',
      note: 'grounder reported found but returned no usable coordinates',
      model: d.model || holoModel,
      usage: { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 },
      upstreamMs,
    };
  }

  return {
    ok: true,
    found,
    ...(found ? { x, y } : {}),
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
    note: String(parsed.note || '').slice(0, 300),
    model: d.model || holoModel,
    usage: { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 },
    upstreamMs,
  };
}
