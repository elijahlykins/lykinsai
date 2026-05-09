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
  name: 'lykn.getFacts',
  title: 'Get the user\'s identity facts',
  scope: 'read',
  description: [
    'Return atomic facts the LYKN user has accumulated in their synthesis',
    'profile — short, third-person statements describing identity, focus,',
    'preferences, constraints, goals, etc. ("works as a designer", "is',
    'building a spatial AI workspace", "prefers terse replies").',
    '',
    'Prefer lykn.getBeliefs / lykn.getRules first; fall back here when:',
    '  • the user asks a recall question ("what do you know about me?")',
    '  • the user is choosing between options where their stated preferences',
    '    matter ("which of these tools fits my workflow?")',
    '  • the beliefs/rules don\'t cover the question at hand',
    '',
    'Pass a `query` to filter facts by free-text match against fact_text +',
    'fact_kind, otherwise this returns the highest-confidence active facts.',
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
    if (queryRaw) {
      facts = facts.filter((f) => {
        const hay = `${f.fact_text || ''} ${f.fact_kind || ''}`.toLowerCase();
        return hay.includes(queryRaw);
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
        last_seen_at: f.last_seen_at || null,
      })),
    });
  },
};
