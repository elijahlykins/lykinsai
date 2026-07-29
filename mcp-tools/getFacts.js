// ============================================================================
// mcp-tools/getFacts.js — list atomic facts in the user's synthesis profile
// ============================================================================
// Read-only. The wider, longer-tail layer underneath beliefs/rules. Facts
// are atomic statements about the user ("works as a designer in Brooklyn",
// "uses Figma daily", "is exploring spatial UIs"). Use these when beliefs
// alone don't cover a question — they're cheaper context than belief
// generalisations when the question is specifically about the user.

import { listActiveFactsForUser } from '../userModelLearning.js';
import { jsonContent, errorContent } from './index.js';

export const getFactsTool = {
  name: 'lykn_getFacts',
  title: 'Get the user\'s identity facts',
  scope: 'read',
  description: [
    'On-demand recall of the user\'s User Facts (chat-ratified personalization).',
    'Short third-person claims: identity, focus, preferences, style, constraints,',
    'goals, relationships, etc. Confirmed (✓) facts beat soft ones.',
    '',
    'Call this when [WHO_I_AM] in the prompt is missing detail for the topic',
    '(prefs, people, places, style), or on "what do you know about me?" when',
    '[WHO_I_AM] is thin. Answer as identity prose from these facts — never as',
    'a project inventory. Do not dump a full bullet audit.',
    '',
    'Pass `query` for relevance ranking (token match on fact_text + kind).',
    'Do NOT use Core Beliefs / rules as the personalization engine.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional free-text filter (case-insensitive substring against fact_text + fact_kind).',
      },
      kind: {
        type: 'string',
        description: 'Optional fact-kind filter (identity, focus, theme, preference, constraint, goal, ...).',
      },
      min_confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Minimum confidence (0-1). Defaults to 0 (return everything active).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Max facts to return. Defaults to 60.',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const minConfidence = Number.isFinite(args.min_confidence)
      ? Math.max(0, Math.min(1, args.min_confidence))
      : 0;
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 60;

    let facts = await listActiveFactsForUser(ctx.supabaseAdmin, ctx.userId, {
      minConfidence,
      limit: Math.min(500, limit * 4), // overfetch a bit so post-filters still hit `limit`
    });

    const queryRaw = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const tokens = queryRaw
      ? queryRaw.replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter((t) => t.length >= 3).slice(0, 12)
      : [];
    if (tokens.length) {
      facts = facts
        .map((f) => {
          const hay = `${f.fact_text || ''} ${f.fact_kind || ''}`.toLowerCase();
          let hits = 0;
          for (const t of tokens) if (hay.includes(t)) hits += 1;
          const statusBoost = f.status === 'confirmed' ? 0.5 : f.status === 'stated' ? 0.25 : 0;
          return { f, score: hits / tokens.length + statusBoost };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.f);
    } else {
      // Confirmed + recent first when no query.
      facts = facts.slice().sort((a, b) => {
        const sr = { confirmed: 5, stated: 4, corrected: 3, inferred: 1 };
        const ds = (sr[b.status] || 0) - (sr[a.status] || 0);
        if (ds !== 0) return ds;
        return (Date.parse(b.confirmed_at || b.last_seen_at || 0) || 0)
          - (Date.parse(a.confirmed_at || a.last_seen_at || 0) || 0);
      });
    }
    const kindFilter = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
    if (kindFilter) facts = facts.filter((f) => f.fact_kind === kindFilter);

    facts = facts.slice(0, limit);

    return jsonContent({
      ok: true,
      count: facts.length,
      facts: facts.map((f) => ({
        id: f.id,
        kind: f.fact_kind,
        text: f.fact_text,
        confidence: f.confidence,
        status: f.status,
        confirmed_at: f.confirmed_at || null,
        last_seen_at: f.last_seen_at || null,
      })),
    });
  },
};
