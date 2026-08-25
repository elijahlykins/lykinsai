export const RESPONSE_LENGTH_OPTIONS = [
  {
    id: 'concise',
    label: 'Concise',
    hint: 'Short answers — a few sentences when possible.',
  },
  {
    id: 'medium',
    label: 'Balanced',
    hint: 'Direct answer first, then brief detail when useful.',
  },
  {
    id: 'detailed',
    label: 'Detailed',
    hint: 'Thorough answers with examples and context.',
  },
];

export const RESPONSE_TONE_OPTIONS = [
  { id: 'casual', label: 'Casual', hint: 'Friendly and conversational.' },
  { id: 'balanced', label: 'Balanced', hint: 'Clear and approachable — default LYKN style.' },
  { id: 'formal', label: 'Formal', hint: 'Professional and precise.' },
];

const LENGTH_IDS = new Set(RESPONSE_LENGTH_OPTIONS.map((o) => o.id));
const TONE_IDS = new Set(RESPONSE_TONE_OPTIONS.map((o) => o.id));

export function normalizeResponseTone(input = {}) {
  const raw = input?.responseTone ?? input?.response_tone ?? '';
  const s = String(raw).trim();
  if (!s) return '';
  if (TONE_IDS.has(s)) {
    return RESPONSE_TONE_OPTIONS.find((o) => o.id === s)?.hint || s;
  }
  return s;
}

export function normalizeModelBehavior(input = {}) {
  const raw = input?.behavior && typeof input.behavior === 'object' ? input.behavior : input;
  const responseLength = LENGTH_IDS.has(raw?.responseLength || raw?.response_length)
    ? raw.responseLength || raw.response_length
    : 'medium';
  return {
    responseLength,
    responseTone: normalizeResponseTone(raw),
  };
}

function optionLines(options, id) {
  const opt = options.find((o) => o.id === id);
  if (!opt) return `- ${id}`;
  return `- ${opt.label}: ${opt.hint}`;
}

export function mergeBehaviorIntoSystemPrompt(systemPrompt, behavior = {}) {
  const base = String(systemPrompt || '').trim();
  const { responseLength, responseTone } = normalizeModelBehavior(behavior);

  const block = [
    '## Response style',
    optionLines(RESPONSE_LENGTH_OPTIONS, responseLength),
    responseTone ? `- Tone: ${responseTone}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const re = /## Response style[\s\S]*?(?=\n## |\n*$)/;
  if (re.test(base)) {
    return base.replace(re, block).trim();
  }

  const identityRe = /## Identity[\s\S]*?(?=\n## |\n*$)/;
  if (identityRe.test(base)) {
    return base.replace(identityRe, (m) => `${m.trim()}\n\n${block}`).trim();
  }

  return `${block}\n\n${base}`.trim();
}

export function formatResponseLengthPromptNote(responseLength) {
  const id = normalizeModelBehavior({ responseLength }).responseLength;
  if (id === 'concise') {
    return '[RESPONSE_LENGTH]\nThe user set response length to CONCISE. Keep replies short — a few sentences when possible, never more than one short paragraph. Answer directly and stop.';
  }
  if (id === 'detailed') {
    return '[RESPONSE_LENGTH]\nThe user set response length to DETAILED. Be thorough and in-depth: cover the topic fully, break multi-part answers into sections, and include concrete examples, trade-offs, and specifics. Long, complete answers are expected.';
  }
  // Balanced — real questions get developed, multi-paragraph answers; only
  // trivial turns (greetings, quick facts, confirmations) stay short.
  return '[RESPONSE_LENGTH]\nThe user set response length to BALANCED. Substantive questions get developed answers: several paragraphs with real reasoning, relevant specifics, and an example where it helps. Do NOT compress a real answer into one or two sentences. Only greetings, quick facts, and simple confirmations stay short.';
}

export function formatTonePromptNote(responseTone) {
  const tone = normalizeResponseTone({ responseTone });
  if (!tone) return '';
  return `[MODEL_TONE]\n${tone}`;
}

export function getModelBehaviorFromMetadata(metadata = {}) {
  const nested = metadata?.behavior;
  if (nested && typeof nested === 'object') {
    return normalizeModelBehavior(nested);
  }
  return normalizeModelBehavior({
    responseLength: metadata?.response_length ?? metadata?.responseLength,
    responseTone: metadata?.response_tone ?? metadata?.responseTone,
  });
}
