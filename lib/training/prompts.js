/**
 * Claude prompts for training-pair generation.
 */

export function buildSynthesisTrainingPrompt({ beliefs = [], facts = [], rules = [], pairsCount = 20 }) {
  const beliefLines = beliefs.map((b) => `- ${b.belief_text}`).join('\n') || '(none)';
  const factLines = facts.map((f) => `- ${f.fact_text}`).join('\n') || '(none)';
  const ruleLines = rules
    .map((r) => `- IF ${r.trigger_text} THEN ${r.action_text}`)
    .join('\n') || '(none)';

  return `You are generating training data to fine-tune a language model to match a specific person's communication style and thinking patterns.

Here is what we know about this person:

BELIEFS:
${beliefLines}

FACTS:
${factLines}

RULES:
${ruleLines}

Generate ${pairsCount} realistic prompt/response training pairs that reflect this person's voice, values, and way of thinking.

The prompts should be things this person would realistically be asked — writing requests, opinion questions, explanations, advice.

The responses should sound exactly like this person would write — not generic AI output. Match their directness, vocabulary, level of formality, and reasoning style.

Return only a valid JSON array. No preamble. No explanation. No markdown code fences.
Format:
[
  {"prompt": "...", "response": "..."},
  {"prompt": "...", "response": "..."}
]`;
}

export function buildDocumentTrainingPrompt(documentChunk, pairsPerChunk = 20) {
  const n = pairsPerChunk || 20;
  return `You are generating training data to fine-tune a language model on a specific person's writing style.

Here is a sample of their writing:

${documentChunk}

Study the style carefully — sentence length, vocabulary, tone, how they open paragraphs, how they handle complexity, whether they use hedging language or are direct.

Generate ${n} prompt/response pairs where the responses are written in exactly this person's style. Do not copy their content — generate new responses that sound like them.

Return only a valid JSON array. No preamble. No explanation. No markdown code fences.
Format:
[
  {"prompt": "...", "response": "..."},
  {"prompt": "...", "response": "..."}
]`;
}
