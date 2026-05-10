// ============================================================================
// mcp-tools/getContextBlock.js — single-shot context dump for "lazy" clients
// ============================================================================
// Read-only. Returns a pre-rendered text block summarising the user's
// active beliefs + rules + CURRENT PROJECT STATE, suitable for stuffing
// at the top of a system prompt. Wraps `formatBeliefsAndRulesForPromptOutsideClient`
// from beliefSystem.js so the in-LYKN model and outside clients converge
// on shared content with surface-appropriate attribution instructions.
//
// What ships in the block:
//   1. [BELIEFS_AND_RULES] — Tier-1 governance. User-ratified, slow-moving.
//   2. [CURRENT_PROJECT]   — Tier-2 working memory. The user's active
//                            project + its current state kv-pairs.
//                            Auto-injected when an active project exists.
//
// When to call this vs lykn_getBeliefs / lykn_getRules / lykn_getProjectState:
//   • Use this once per CONVERSATION when you just want "who is this user
//     and what are they working on right now".
//   • Use the structured tools when you need to walk individual rules /
//     filter by need / push project state / surface specific rule_ids
//     in your reasoning.

import {
  listActiveBeliefsForUser,
  listActiveRulesForUser,
  formatBeliefsAndRulesForPromptOutsideClient,
} from '../beliefSystem.js';
import { textContent, errorContent } from './index.js';

// ---------------------------------------------------------------------------
// Active project + state loader
// ---------------------------------------------------------------------------
// Internal helper, kept here rather than in beliefSystem.js so that the
// project tier can evolve (add scoping, decay, etc.) without touching
// the prompt-formatting layer. Returns null if the user has no active
// project or if any of the lookups fail (we treat project context as
// best-effort — a transient db error should NOT empty the entire
// context block).
async function loadActiveProjectContext(supabaseAdmin, userId) {
  try {
    const { data: profile } = await supabaseAdmin
      .from('lykn_user_synthesis_profile')
      .select('active_project_id')
      .eq('user_id', userId)
      .maybeSingle();
    const projectId = profile?.active_project_id;
    if (!projectId) return null;

    const { data: project } = await supabaseAdmin
      .from('lykn_projects')
      .select('id, name, description, status, created_by_client, last_active_at')
      .eq('id', projectId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!project || project.status !== 'active') return null;

    const { data: rows } = await supabaseAdmin
      .from('lykn_project_state')
      .select('state_key, state_value, set_by_client, created_at')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .is('superseded_at', null)
      .order('created_at', { ascending: false })
      .limit(50);

    const state = {};
    for (const row of rows || []) {
      if (!(row.state_key in state)) {
        state[row.state_key] = {
          value: row.state_value,
          set_by_client: row.set_by_client,
          set_at: row.created_at,
        };
      }
    }

    return { project, state };
  } catch (err) {
    console.warn('[mcp:getContextBlock] project load failed:', err?.message || err);
    return null;
  }
}

export const getContextBlockTool = {
  name: 'lykn_getContextBlock',
  title: 'Get a one-shot summary of the user\'s active beliefs + rules',
  scope: 'read',
  description: [
    'Return a single pre-formatted text block summarising:',
    '  1. the LYKN user\'s active beliefs and if-then rules (governance), AND',
    '  2. the user\'s CURRENT PROJECT and its working state, if any.',
    '',
    'Designed to be pasted at the top of your system prompt for the rest',
    'of this conversation. The project section is what other AI clients',
    '(Claude Desktop, Cursor, Claude Code) have been accumulating about',
    'the work — pick up from there instead of re-litigating decisions.',
    '',
    'Call this ONCE per conversation as an upfront context-load step. For',
    'finer-grained control (filtering by need, citing specific rule_ids,',
    'pushing project state updates, searching by trigger), use the more',
    'specific tools: lykn_getBeliefs / lykn_getRules / lykn_getProjectState',
    '/ lykn_pushProjectState.',
    '',
    'When you follow one of the rules in this block, call',
    'lykn_recordRuleApplication with the rule_id so LYKN can show the user',
    'an audit trail. Tag-less / call-less replies are normal — only record',
    'when a rule actually changed how you responded.',
    '',
    'When this conversation produces a meaningful project decision, call',
    'lykn_pushProjectState so the next AI client to read this block has',
    'the latest. (This is what makes the synthesis layer "living.")',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      max_chars: {
        type: 'integer',
        minimum: 200,
        maximum: 8000,
        description: 'Cap the block size. Defaults to 2400 (~600 tokens).',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const maxChars = Number.isFinite(args.max_chars)
      ? Math.max(200, Math.min(8000, args.max_chars))
      : 2400;

    const [beliefs, rules, projectContext] = await Promise.all([
      listActiveBeliefsForUser(ctx.supabaseAdmin, ctx.userId),
      listActiveRulesForUser(ctx.supabaseAdmin, ctx.userId),
      loadActiveProjectContext(ctx.supabaseAdmin, ctx.userId),
    ]);

    // No beliefs AND no project = brand-new user. Tell the model so it
    // doesn't waste its turn looking for context that isn't there yet.
    // Project alone (without beliefs) IS still worth shipping — most
    // users will have a project before they accrue ratified beliefs.
    if (!beliefs.length && !projectContext) {
      return textContent(
        'This LYKN user has no active beliefs and no active project yet.' +
        ' Treat them as a fresh conversation — but you can call lykn_getFacts' +
        ' for atomic identity facts, lykn_proposeBelief if a clear durable' +
        ' principle emerges, or lykn_setActiveProject to start tracking the' +
        ' work this conversation produces.',
      );
    }

    const block = formatBeliefsAndRulesForPromptOutsideClient(beliefs, rules, {
      maxChars,
      projectContext,
    });
    return textContent(block || '(no active beliefs or project state returned)');
  },
};
