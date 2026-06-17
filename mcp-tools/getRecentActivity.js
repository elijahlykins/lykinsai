// ============================================================================
// mcp-tools/getRecentActivity.js — last-N-days changes across neuron stores
// ============================================================================
// Read. Cross-source "what's new" feed. Pulls the most recently
// created or touched rows out of every neuron store the user owns,
// merges them by timestamp, and returns a flat reverse-chronological
// list. Closes the "what have I been up to lately?" gap that no
// single existing tool covers:
//
//   • listProjects shows projects but not their internal churn.
//   • getProjectNeurons is project-scoped.
//   • findConnections is topic-scoped, not time-scoped.
//   • getBeliefs / getFacts / getRules return inventories, not deltas.
//
// Why this matters for the chat agent: at the start of a session,
// the user's brain is loaded with whatever they were thinking about
// yesterday. The agent needs the same priors. A 60-second "here's
// what changed in your synthesis layer this week" sweep gives the
// model that context cheaply — three small queries against indexed
// `created_at` / `updated_at` columns.
//
// Tables sampled and the timestamp used:
//   lykn_beliefs            — updated_at (or created_at)
//   lykn_user_model_facts   — created_at
//   lykn_concepts           — last_touched_at (recency, not birth)
//   notes (vault)           — updated_at
//   lykn_projects           — updated_at
//   lykn_user_links         — created_at
//
// Each row is reshaped to a tiny common envelope so the model gets a
// uniform stream:
//   { kind, node_id, label, at, status? }
//
// node_id is in the same format lykn_loadNeuron accepts, so the
// model can drill into any item directly.

import { jsonContent, errorContent } from './index.js';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const PER_KIND_LIMIT = 20;
const TOTAL_LIMIT = 60;

const ALL_KINDS = ['belief', 'fact', 'concept', 'vault', 'project', 'link'];
const KIND_SET = new Set(ALL_KINDS);

function trimLabel(s, max = 120) {
  if (!s) return '';
  const str = String(s).replace(/\s+/g, ' ').trim();
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export const getRecentActivityTool = {
  name: 'lykn_getRecentActivity',
  title: 'List what changed in the user\'s synthesis layer recently',
  scope: 'read',
  description: [
    'Return a flat, reverse-chronological feed of recent activity',
    'across every neuron store the user owns: beliefs, facts,',
    'concepts, vault notes, projects, and user-authored links.',
    '',
    'USE AT THE START OF A SESSION to catch up on what the user has',
    'been working with lately — the cheapest way to load the same',
    'priors they have in their head. Pair with loadNeuron to dig into',
    'any specific item.',
    '',
    'INPUTS:',
    '  • days — lookback window, 1-90, default 7.',
    '  • kinds — optional whitelist subset of',
    '    [belief, fact, concept, vault, project, link]. Defaults to all.',
    '  • limit — total cap on returned rows, 1-60, default 60.',
    '',
    'Each item: { kind, node_id, label, at, status? }. `node_id` is in',
    'lykn_loadNeuron-acceptable format for direct hydration.',
    '',
    'CHEAP — six indexed range scans. Safe to call once per session.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_DAYS,
        description: `Lookback window in days (1-${MAX_DAYS}). Defaults to ${DEFAULT_DAYS}.`,
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ALL_KINDS },
        description: 'Optional subset of kinds to include. Omit for all.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: TOTAL_LIMIT,
        description: `Max total items to return (1-${TOTAL_LIMIT}). Defaults to ${TOTAL_LIMIT}.`,
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const days = Number.isInteger(args?.days)
      ? Math.max(1, Math.min(MAX_DAYS, args.days))
      : DEFAULT_DAYS;
    const limit = Number.isInteger(args?.limit)
      ? Math.max(1, Math.min(TOTAL_LIMIT, args.limit))
      : TOTAL_LIMIT;
    const requestedKinds = Array.isArray(args?.kinds)
      ? args.kinds.filter((k) => KIND_SET.has(k))
      : ALL_KINDS.slice();
    const kinds = new Set(requestedKinds.length ? requestedKinds : ALL_KINDS);

    const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
    const sb = ctx.supabaseAdmin;
    const items = [];
    const warnings = [];

    // Each branch is intentionally independent so a single missing
    // table (e.g. on a partially-migrated dev DB) doesn't black-hole
    // the whole tool — we degrade to "no items from kind X" with a
    // warning the model can surface.

    if (kinds.has('belief')) {
      const { data, error } = await sb
        .from('lykn_beliefs')
        .select('id, belief_text, status, updated_at, created_at')
        .eq('user_id', ctx.userId)
        .gte('updated_at', sinceIso)
        .order('updated_at', { ascending: false })
        .limit(PER_KIND_LIMIT);
      if (error) warnings.push(`belief: ${error.message}`);
      else (data || []).forEach((r) => items.push({
        kind: 'belief',
        node_id: `belief_${r.id}`,
        label: trimLabel(r.belief_text),
        at: r.updated_at || r.created_at,
        status: r.status,
      }));
    }

    if (kinds.has('fact')) {
      const { data, error } = await sb
        .from('lykn_user_model_facts')
        .select('id, fact_text, created_at')
        .eq('user_id', ctx.userId)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(PER_KIND_LIMIT);
      if (error) warnings.push(`fact: ${error.message}`);
      else (data || []).forEach((r) => items.push({
        kind: 'fact',
        node_id: `fact_${r.id}`,
        label: trimLabel(r.fact_text),
        at: r.created_at,
      }));
    }

    if (kinds.has('concept')) {
      // Concepts use last_touched_at as their recency signal — that's
      // what the synthesis layer ribbon orders by, so it's the right
      // column to ask "what concepts have been live lately?"
      const { data, error } = await sb
        .from('lykn_concepts')
        .select('id, slug, label, status, last_touched_at')
        .eq('user_id', ctx.userId)
        .is('merged_into_id', null)
        .neq('status', 'dismissed')
        .gte('last_touched_at', sinceIso)
        .order('last_touched_at', { ascending: false })
        .limit(PER_KIND_LIMIT);
      if (error) warnings.push(`concept: ${error.message}`);
      else (data || []).forEach((r) => items.push({
        kind: 'concept',
        node_id: `concept_${r.slug}`,
        label: trimLabel(r.label),
        at: r.last_touched_at,
        status: r.status,
      }));
    }

    if (kinds.has('vault')) {
      const { data, error } = await sb
        .from('vault_items')
        .select('id, title, updated_at, created_at')
        .eq('user_id', ctx.userId)
        .gte('updated_at', sinceIso)
        .order('updated_at', { ascending: false })
        .limit(PER_KIND_LIMIT);
      if (error) warnings.push(`vault: ${error.message}`);
      else (data || []).forEach((r) => items.push({
        kind: 'vault',
        node_id: `vault_${r.id}`,
        label: trimLabel(r.title || '(untitled note)'),
        at: r.updated_at || r.created_at,
      }));
    }

    if (kinds.has('project')) {
      // lykn_projects uses last_active_at as the "touched" column
      // (set by listProjects ordering + edits). created_at is the
      // fallback for projects that haven't been re-touched since
      // birth, which still qualifies as "recent activity".
      const { data, error } = await sb
        .from('lykn_projects')
        .select('id, name, status, last_active_at, created_at')
        .eq('user_id', ctx.userId)
        .gte('last_active_at', sinceIso)
        .order('last_active_at', { ascending: false })
        .limit(PER_KIND_LIMIT);
      if (error) warnings.push(`project: ${error.message}`);
      else (data || []).forEach((r) => items.push({
        kind: 'project',
        node_id: `project_${r.id}`,
        label: trimLabel(r.name || '(unnamed project)'),
        at: r.last_active_at || r.created_at,
        status: r.status,
      }));
    }

    if (kinds.has('link')) {
      const { data, error } = await sb
        .from('lykn_user_links')
        .select('id, from_node_id, to_node_id, label, created_at')
        .eq('user_id', ctx.userId)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(PER_KIND_LIMIT);
      if (error) warnings.push(`link: ${error.message}`);
      else (data || []).forEach((r) => items.push({
        kind: 'link',
        // links don't have a single node_id — surface both endpoints
        // in the label and a synthetic id for hydration via
        // lykn_getNeuronLinks (anchor either endpoint).
        node_id: `link_${r.id}`,
        label: r.label
          ? `${r.from_node_id} ↔ ${r.to_node_id} (${r.label})`
          : `${r.from_node_id} ↔ ${r.to_node_id}`,
        at: r.created_at,
      }));
    }

    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const trimmed = items.slice(0, limit);

    // Per-kind tally so the model can quickly see "lots of new vault
    // notes, no new beliefs" without iterating the array itself.
    const byKind = {};
    for (const it of trimmed) byKind[it.kind] = (byKind[it.kind] || 0) + 1;

    return jsonContent({
      ok: true,
      window: { days, since: sinceIso },
      count: trimmed.length,
      by_kind: byKind,
      items: trimmed,
      ...(warnings.length ? { warnings } : {}),
      message: trimmed.length === 0
        ? `No activity in the last ${days} day${days === 1 ? '' : 's'}.`
        : `Found ${trimmed.length} item${trimmed.length === 1 ? '' : 's'} from the last ${days} day${days === 1 ? '' : 's'}.`,
    });
  },
};
