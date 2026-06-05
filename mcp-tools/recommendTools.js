// ============================================================================
// mcp-tools/recommendTools.js — capability-aware tool recommendations
// ============================================================================
// Read. Pure catalog lookup. No DB, no auth-sensitive data, no side effects.
//
// WHY THIS TOOL EXISTS
//
// LYKN's strategic position is the synthesis layer — the memory + identity
// store that every OTHER AI tool draws from. We deliberately don't dispatch
// to outside tools, run code, send email, generate images, search the live
// web, or otherwise execute on the user's behalf. The full reasoning lives
// in lykn_pushProjectState under product_strategy + agent_connection_architecture.
//
// But users still ask LYKN to do those things ("draft an email", "make me an
// image", "send this to my team"). The honest answer is "I can't do that
// directly, but here's what I CAN do, and here's the right tool to take this
// to — connect it via MCP once and it'll have your context automatically."
//
// This tool gives the chat model a fast, structured way to deliver the
// second half of that sentence without hardcoding tool names into prompts
// (which go stale). Source of truth is src/lib/connectors/outboundTargets.js,
// the same catalog the /connections page renders.
//
// PULL MODEL — strictly enforced
//
// The tool returns tools the USER can connect. It NEVER returns endpoints
// LYKN should call. LYKN does not push to outside tools; outside tools pull
// from LYKN via the MCP server or REST API. That separation is the moat.
//
// CATEGORY TAXONOMY
//
// Closed enum, deliberately narrow. Each category maps to a small set of
// clientKinds from OUTBOUND_TARGETS. New categories require a real signal
// from chat traffic, not speculation.
//
//   coding         → IDE / agent / repo-aware code assistants
//   chat-assistant → general-purpose chat models the user can pour context into
//   meeting-notes  → meeting capture + transcript / decision recall
//   image          → image + video generation
//   voice          → voice / audio generation + AI calls
//   design         → visual design tools
//   automation     → cross-app workflow automation
//   notes          → note-taking / knowledge management
//
// The model is told to use 'other' as a fallback that surfaces a small
// representative set; we never block the recommendation on a perfect match.

import { OUTBOUND_TARGETS } from '../src/lib/connectors/outboundTargets.js';
import { jsonContent, errorContent } from './index.js';

// ---------------------------------------------------------------------------
// Category → clientKind mapping
// ---------------------------------------------------------------------------
// Order inside each bucket = recommendation order. Tier 1 cards (the launch
// lineup that actually has working OAuth handshakes today) come first; tier 2+
// trail. We do not include `available: false` tools — those would just give
// the user a dead-end "coming soon" badge.

const CATEGORY_TO_CLIENT_KINDS = Object.freeze({
  coding: [
    'cursor',
    'claude-code',
    'windsurf',
    'github-copilot',
    'codex-cli',
    'jetbrains',
    'replit',
    'lovable',
  ],
  'chat-assistant': [
    'claude',
    'chatgpt',
    'gemini',
    'grok',
  ],
  'meeting-notes': [
    'fathom',
    'mem-ai',
  ],
  image: [
    'midjourney',
    'sora-veo',
  ],
  voice: [
    'elevenlabs',
  ],
  design: [
    'figma-ai',
  ],
  automation: [
    'zapier',
  ],
  notes: [
    'notion-ai',
    'mem-ai',
  ],
});

const CATEGORIES = Object.freeze(Object.keys(CATEGORY_TO_CLIENT_KINDS).concat(['other']));

// For `other` we surface a small representative slice so the model has
// something concrete to suggest instead of an empty list.
const OTHER_FALLBACK_CLIENT_KINDS = Object.freeze([
  'claude',
  'chatgpt',
  'cursor',
  'zapier',
]);

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 6;

// Trim the catalog summary to keep the response compact. The model uses
// these strings verbatim in chat, so they need to be self-contained but
// not novel-length.
function trimSummary(s, max = 240) {
  if (!s) return '';
  const str = String(s).replace(/\s+/g, ' ').trim();
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function pickTargetsByClientKinds(clientKinds, limit) {
  const byKind = new Map();
  for (const t of OUTBOUND_TARGETS) {
    if (!byKind.has(t.clientKind)) byKind.set(t.clientKind, t);
  }
  const picked = [];
  for (const kind of clientKinds) {
    const t = byKind.get(kind);
    if (!t) continue;
    if (t.available === false) continue;
    picked.push(t);
    if (picked.length >= limit) break;
  }
  return picked;
}

function shapeTarget(t) {
  return {
    id: t.id,
    name: t.name,
    summary: trimSummary(t.summary),
    direction: t.direction || 'bidirectional',
    install_type: t.installType || 'oauth-mcp',
    install_url: '/connections',
    docs_url: t.helpUrl || null,
  };
}

export const recommendToolsTool = {
  name: 'lykn_recommendTools',
  title: 'Suggest the right outside AI tool for a task LYKN cannot do directly',
  scope: 'read',
  description: [
    'Return a small, ranked list of outside AI tools the user can connect',
    'to handle a task LYKN itself cannot execute (sending email, running',
    'code in their repo, etc.). For images use lykn_generate_image first',
    '(5/month cap); recommend Midjourney etc. only when the user needs more.',
    '',
    'WHEN TO CALL THIS — only when:',
    '  (a) The user asked LYKN to perform an action that requires a',
    '      capability LYKN does not have. LYKN does NOT send messages,',
    '      execute code, generate images / video / voice, browse the live',
    '      web, access calendars, or otherwise dispatch outside itself.',
    '  (b) You have already drafted or produced the LYKN-shaped output',
    '      using the user\'s context (their tone from beliefs / rules,',
    '      relevant vault snippets, the active project\'s state, recipient',
    '      facts, etc.). The recommendation is the SECOND half of your',
    '      reply, not the whole reply.',
    '',
    'WHEN NOT TO CALL THIS:',
    '  • The user asked about their synthesis layer (vault, projects,',
    '    beliefs, facts). Use the read tools for those instead.',
    '  • The user is having a conversation; they did not ask for a',
    '    delivery / execution / generation step.',
    '  • You are tempted to "be helpful" and suggest tools unprompted.',
    '    Don\'t — recommending tools when the user didn\'t ask is noise.',
    '',
    'INPUTS:',
    '  • category — one of: coding, chat-assistant, meeting-notes, image,',
    '    voice, design, automation, notes, other. Pick the single closest',
    '    match. If genuinely ambiguous, use `other`.',
    '  • task_description — optional 1-sentence summary of what the user',
    '    asked for. Returned in the response so it\'s easy to reference',
    '    in your reply; not used for filtering (yet).',
    '  • limit — 1-6, default 4.',
    '',
    'OUTPUT — { category, task_description, tools: [...] }. Each tool has:',
    '  { id, name, summary, direction, install_type, install_url, docs_url }.',
    '  - direction: "bidirectional" means the tool can both READ from and',
    '    WRITE to the user\'s LYKN layer once connected.',
    '  - install_url is always /connections — that\'s the single page where',
    '    every outbound connector lives.',
    '',
    'HOW TO USE THE RESULT IN YOUR REPLY — the pull-model script:',
    '  1. State plainly that LYKN can\'t do the action itself.',
    '  2. Hand the user the LYKN-shaped output you already produced.',
    '  3. Recommend 1-3 of the returned tools (NOT all of them — pick',
    '     based on what fits the user). Use the `summary` field verbatim',
    '     or paraphrase tightly.',
    '  4. Tell them connecting any of them via /connections lets the tool',
    '     pull this same context automatically next time — they won\'t',
    '     have to brief it.',
    '',
    'Do NOT pretend the action was completed. Do NOT promise to dispatch.',
    'Do NOT call this tool a second time in the same turn.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: CATEGORIES.slice(),
        description: 'The kind of task the user is asking for. Closed enum.',
      },
      task_description: {
        type: 'string',
        maxLength: 280,
        description: 'Optional 1-sentence summary of the user\'s ask.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max number of tools to return (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    required: ['category'],
    additionalProperties: false,
  },
  async handler(args = {}) {
    const category = typeof args?.category === 'string' ? args.category : '';
    if (!CATEGORIES.includes(category)) {
      return errorContent(
        `Unknown category "${category}". Allowed: ${CATEGORIES.join(', ')}.`,
      );
    }
    const limit = Number.isInteger(args?.limit)
      ? Math.max(1, Math.min(MAX_LIMIT, args.limit))
      : DEFAULT_LIMIT;
    const taskDescription = typeof args?.task_description === 'string'
      ? args.task_description.trim().slice(0, 280)
      : '';

    const clientKinds = category === 'other'
      ? OTHER_FALLBACK_CLIENT_KINDS
      : CATEGORY_TO_CLIENT_KINDS[category];

    const picked = pickTargetsByClientKinds(clientKinds, limit);
    const tools = picked.map(shapeTarget);

    return jsonContent({
      ok: true,
      category,
      task_description: taskDescription || null,
      count: tools.length,
      tools,
      message: tools.length === 0
        ? `No connectors registered for category "${category}" yet — fall back to recommending the user explore /connections.`
        : `Recommended ${tools.length} tool${tools.length === 1 ? '' : 's'} for "${category}". Frame the recommendation in the pull-model script (LYKN can't dispatch — connecting the tool lets it pull context).`,
    });
  },
};
