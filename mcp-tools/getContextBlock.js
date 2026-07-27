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
  loadActiveProjectContext,
  loadProjectContextById,
  loadOtherProjectsForUser,
} from '../beliefSystem.js';
import { resolveRelevantProjects } from '../lib/projectResolver.js';
import { textContent, errorContent } from './index.js';

export const getContextBlockTool = {
  name: 'lykn_getContextBlock',
  title: 'Get a one-shot summary of the user\'s active beliefs + rules',
  scope: 'read',
  description: [
    'CALL THIS AUTOMATICALLY AT THE START OF EVERY NEW CONVERSATION with',
    'this user, before responding to their first message. Do not wait for',
    'the user to ask about LYKN — they connected this server so you would',
    'load their context unprompted. This is a read-only, side-effect-free,',
    'cheap call (one round-trip, ~600 tokens by default).',
    '',
    'Returns a single pre-formatted text block summarising LYKN\'s three',
    'memory buckets:',
    '  1. [WHO_I_AM]     — beliefs + rules (who they are / how to treat them).',
    '  2. [WHAT_IM_ON]   — focus project + working state (what they\'re doing).',
    '  3. [WHAT_IM_ON — other projects] — other active projects with ids so',
    '     you can connect the dots and lykn_setActiveProject({ project_id }).',
    'Vault / saved files are NOT in this block — use lykn_searchVault for',
    '[WHAT_IVE_SAVED] when they need something from their stuff.',
    '',
    'Treat the block as binding governance for the rest of the conversation.',
    'The project sections are what other AI clients (Claude Desktop, Cursor,',
    'Claude Code, ChatGPT) have been accumulating about the work — pick up',
    'from there instead of re-litigating decisions. If the user references',
    'a project listed under [OTHER_PROJECTS], call',
    'lykn_setActiveProject({ project_id }) with the id from that block;',
    'don\'t paraphrase the name into a duplicate.',
    '',
    'Call once at the start. For finer-grained mid-conversation access',
    '(filtering rules by trigger, citing specific rule_ids, walking project',
    'state history) use the more specific tools: lykn_getBeliefs /',
    'lykn_getRules / lykn_getProjectState / lykn_pushProjectState /',
    'lykn_listProjects.',
    '',
    'When you follow one of the rules in this block, call',
    'lykn_recordRuleApplication with the rule_id so LYKN can show the user',
    'an audit trail. Tag-less / call-less replies are normal — only record',
    'when a rule actually changed how you responded.',
    '',
    'Projects are user-created only. Use lykn_resolveProject({ query }) when',
    'the topic might belong to a different main or branch than the current',
    'focus. Any agent may read/update any project by id; never create projects.',
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

    const [beliefs, rules, activeContext] = await Promise.all([
      listActiveBeliefsForUser(ctx.supabaseAdmin, ctx.userId),
      listActiveRulesForUser(ctx.supabaseAdmin, ctx.userId),
      loadActiveProjectContext(ctx.supabaseAdmin, ctx.userId),
    ]);

    let projectContext = activeContext;
    if (!projectContext) {
      const resolved = await resolveRelevantProjects(ctx.supabaseAdmin, ctx.userId, { limit: 1 });
      if (resolved.best?.id) {
        projectContext = await loadProjectContextById(ctx.supabaseAdmin, ctx.userId, resolved.best.id);
      }
    }

    const otherProjects = await loadOtherProjectsForUser(ctx.supabaseAdmin, ctx.userId, {
      excludeId: projectContext?.project?.id || null,
      limit: 8,
    });

    // No beliefs AND no project AND no other projects = brand-new user.
    // Tell the model so it doesn't waste its turn looking for context
    // that isn't there yet. Project (or other-project candidates) alone
    // are worth shipping — most users will have a project before they
    // accrue ratified beliefs.
    if (!beliefs.length && !projectContext && otherProjects.length === 0) {
      return textContent(
        'This LYKN user has no active beliefs and no active project yet.' +
        ' Treat them as a fresh conversation — but you can call lykn_getFacts' +
        ' for atomic identity facts, or ask the user to create a project in the' +
        ' synthesis layer (+ → Create project). Beliefs are user-authored only' +
        ' (+ → Core Belief neuron in Synthesis Layer) — do not propose beliefs.',
      );
    }

    const block = formatBeliefsAndRulesForPromptOutsideClient(beliefs, rules, {
      maxChars,
      projectContext,
      otherProjects,
    });
    return textContent(block || '(no active beliefs or project state returned)');
  },
};
