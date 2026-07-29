// ============================================================================
// lib/synthesis/relatedNeighborhood.js — server-side [RELATED] packing
// ============================================================================
// Auto-inject a small cross-store neighborhood into in-LYKN chat prompts
// so the model sees related neurons without waiting to call
// lykn_findConnections / lykn_getNeuronLinks.
//
// Sources (merged, capped):
//   1. findRelatedConnectionHits — beliefs/facts/concepts/vault for the
//      current user message (fast vault path, no LLM rerank)
//   2. lykn_user_links — recent authored edges, plus edges touching
//      active-project neuron ids when provided
//
// Kept intentionally small (≤8 items, ~1400 chars) so it complements
// [WHO_I_AM] / [WHAT_IM_ON] / [WHAT_IVE_SAVED] without duplicating them.

import { findRelatedConnectionHits } from '../../mcp-tools/findConnections.js';

const MAX_ITEMS = 8;
const MAX_CHARS = 1400;
const MIN_QUERY_LEN = 8;
const STOP_QUERY =
  /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|yep|nope|cool|sure|got it|how are you|what's up|whats up)\b/i;

function cleanQuery(text) {
  const q = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  if (q.length < MIN_QUERY_LEN) return '';
  if (STOP_QUERY.test(q)) return '';
  return q;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

async function loadAuthoredLinkHits(client, userId, projectNeuronIds, limit) {
  if (!client || !userId) return [];
  const out = [];
  const seen = new Set();

  const pushRow = (row, anchorId = null) => {
    if (!row) return;
    const from = String(row.from_node_id || '');
    const to = String(row.to_node_id || '');
    if (!from || !to) return;
    const key = [from, to].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const other = anchorId && from === anchorId ? to : anchorId && to === anchorId ? from : to;
    out.push({
      kind: 'link',
      node_id: other || to,
      label: row.label
        ? `${clip(from, 36)} ↔ ${clip(to, 36)} (${clip(row.label, 40)})`
        : `${clip(from, 40)} ↔ ${clip(to, 40)}`,
      snippet: '',
      via: 'authored_link',
    });
  };

  try {
    const seeds = (projectNeuronIds || [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
      .slice(0, 8);

    if (seeds.length) {
      // PostgREST `.or` with many ids — keep it small.
      const orFilter = seeds
        .flatMap((id) => [`from_node_id.eq.${id}`, `to_node_id.eq.${id}`])
        .join(',');
      const { data, error } = await client
        .from('lykn_user_links')
        .select('from_node_id, to_node_id, label, created_at')
        .eq('user_id', userId)
        .or(orFilter)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const anchor = seeds.find(
            (id) => id === row.from_node_id || id === row.to_node_id,
          );
          pushRow(row, anchor || null);
          if (out.length >= limit) return out;
        }
      }
    }

    if (out.length < limit) {
      const { data, error } = await client
        .from('lykn_user_links')
        .select('from_node_id, to_node_id, label, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit - out.length);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          pushRow(row, null);
          if (out.length >= limit) break;
        }
      }
    }
  } catch (e) {
    console.warn('[relatedNeighborhood:links]', e?.message || e);
  }

  return out;
}

/**
 * Build the [RELATED] prompt block for in-LYKN chat.
 * Returns '' when there's nothing useful to inject.
 */
export async function buildRelatedNeighborhoodSection({
  supabaseAdmin,
  userId,
  queryText,
  projectNeuronIds = [],
  excludeNodeIds = [],
  maxItems = MAX_ITEMS,
  maxChars = MAX_CHARS,
} = {}) {
  if (!supabaseAdmin || !userId) return '';

  const query = cleanQuery(queryText);
  const exclude = new Set(
    (excludeNodeIds || []).map((id) => String(id || '').trim()).filter(Boolean),
  );

  const [connResult, linkHits] = await Promise.all([
    query
      ? findRelatedConnectionHits(
          { supabaseAdmin, userId },
          {
            query,
            per_kind_limit: 2,
            fast: true,
          },
        ).catch((e) => {
          console.warn('[relatedNeighborhood:find]', e?.message || e);
          return { ok: false, matches: [] };
        })
      : Promise.resolve({ ok: false, matches: [] }),
    loadAuthoredLinkHits(supabaseAdmin, userId, projectNeuronIds, 6),
  ]);

  const connHits = connResult?.ok && Array.isArray(connResult.matches)
    ? connResult.matches
    : [];

  const merged = [];
  const seen = new Set();

  const push = (hit) => {
    if (!hit) return;
    const id = String(hit.node_id || '');
    const key = id || `${hit.kind}:${hit.label}`;
    if (!key || seen.has(key) || exclude.has(id)) return;
    seen.add(key);
    merged.push(hit);
  };

  // Prefer cross-store topical hits, then authored edges.
  for (const h of connHits) push(h);
  for (const h of linkHits) push(h);

  if (!merged.length) return '';

  const lines = [
    '[RELATED]',
    'Nearby neurons across beliefs, facts, concepts, vault, and authored links.',
    'Use silently for grounding. Do NOT loadNeuron / surface cards unless the user asked to see a saved item.',
    '',
  ];

  let used = lines.join('\n').length;
  let count = 0;
  for (const hit of merged) {
    if (count >= maxItems) break;
    const kind = hit.kind || 'neuron';
    const label = clip(hit.label || hit.node_id || '(untitled)', 90);
    const snip = hit.snippet ? ` — ${clip(hit.snippet, 110)}` : '';
    const idPart = hit.node_id ? ` [${hit.node_id}]` : '';
    const line = `- (${kind}) ${label}${snip}${idPart}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    count += 1;
  }

  if (count === 0) return '';
  return lines.join('\n').trim();
}
