// =====================================================================
// lib/synthesisPrompt.js — prompt builder for the nightly synthesis job
// =====================================================================
// The synthesis job pulls clusters of related facts and asks Claude:
// "Looking at these facts together, is there a higher-order belief
// that explains them? If so, propose it."
//
// We deliberately constrain the model heavily:
//
//   • One cluster → at most one belief proposal. Multiple proposals
//     per cluster would inflate the user's review queue with noise;
//     the strongest pattern wins.
//
//   • Strict JSON output. No prose. The cron parses the response with
//     JSON.parse and skips anything that doesn't fit the schema.
//
//   • Model says "no proposal" → we honor it. The point of cluster
//     filtering is to surface the AI's strongest signals; a cluster
//     where Claude can't find a coherent belief is a cluster that
//     shouldn't generate noise.
//
//   • All belief text must be 1st-person about the user ("I value..."
//     "I'm focused on...") because that's how the existing belief UI
//     renders them. The system prompt enforces this.
//
// Schema returned (parsed by jobs/synthesisJob.js):
//   { propose: boolean,
//     belief_text: string,    // present iff propose === true
//     serves_need: string,    // present iff propose === true; one of
//                             //   'identity' | 'autonomy' | 'mastery'
//                             //   | 'relatedness' | 'security'
//                             //   | 'meaning'   | 'growth'
//     confidence: number,     // 0..1
//     reasoning: string }     // optional, for the audit log

const NEED_VOCAB = [
  'identity',
  'autonomy',
  'mastery',
  'relatedness',
  'security',
  'meaning',
  'growth',
];

export const SYSTEM_PROMPT = `You are LYKN's nightly synthesis engine. Your job is to look at clusters of small atomic facts about a user and propose higher-order BELIEFS that explain them — durable principles, values, or working theories the user holds about themselves or the world.

Rules:
- ONE belief per cluster, at most. If the cluster doesn't cohere into a single principle, return propose=false and explain why in "reasoning".
- Belief text is FIRST PERSON about the user ("I value depth over breadth", "I work best in structured systems"). Never refer to the user in third person.
- Belief text is concrete and falsifiable in everyday terms — not corporate-speak ("synergy", "leveraging"), not vague platitudes ("be authentic").
- Length: 1 sentence, 6-22 words.
- "serves_need" must be one of: ${NEED_VOCAB.join(', ')}. Pick the closest.
- "confidence" is your estimate of how strongly the cluster supports this belief, 0.0 to 1.0. Be calibrated — a 2-fact cluster with marginal coherence is 0.4-0.55, a 5-fact cluster with strong cross-client convergence is 0.8+.

Output strict JSON, no other text:
{"propose": boolean, "belief_text": string?, "serves_need": string?, "confidence": number, "reasoning": string?}`;

/**
 * Build the user-facing message for a single cluster. Includes:
 *   • A short context preamble (cluster size, distinct clients, projects).
 *   • The fact texts, prefixed with their source client and project label
 *     when present so Claude can weigh cross-client convergence.
 */
export function buildClusterMessage(cluster) {
  const factLines = cluster.facts.map((f, i) => {
    const tags = [];
    if (f.source) tags.push(f.source);
    if (f.project_label) tags.push(`project:${f.project_label}`);
    if (f.fact_kind) tags.push(f.fact_kind);
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
    return `${i + 1}. "${truncate(f.fact_text, 200)}"${tagStr}`;
  });

  return [
    `Cluster of ${cluster.facts.length} facts about this user.`,
    `Distinct AI clients in cluster: ${cluster.distinct_clients}.`,
    `Distinct projects in cluster: ${cluster.distinct_projects}.`,
    '',
    'Facts:',
    ...factLines,
    '',
    'Look across these facts. Is there a single higher-order belief or principle they all support? If yes, propose it. If they\'re incoherent or too thin to ground a belief, return propose=false.',
  ].join('\n');
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

/**
 * Validate that a parsed model response matches our schema. Returns a
 * cleaned object on success, or null if the model returned junk.
 */
export function validateProposal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.propose !== true && raw.propose !== false) return null;

  if (raw.propose === false) {
    return {
      propose: false,
      reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 500) : null,
    };
  }

  const beliefText = typeof raw.belief_text === 'string' ? raw.belief_text.trim() : '';
  if (beliefText.length < 6 || beliefText.length > 240) return null;

  const need = String(raw.serves_need || '').toLowerCase();
  const servesNeed = NEED_VOCAB.includes(need) ? need : null;
  if (!servesNeed) return null;

  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    propose: true,
    belief_text: beliefText,
    serves_need: servesNeed,
    confidence,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 500) : null,
  };
}

export const NEED_OPTIONS = NEED_VOCAB;
