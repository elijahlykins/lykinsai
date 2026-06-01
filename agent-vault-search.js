// ============================================================================
// agent-vault-search.js — topic-focused vault runs for Agent Studio sandbox
// ============================================================================

const EMAIL_TAGS = new Set(['gmail', 'email', 'inbox', 'outbox', 'mail']);

const STOPWORDS = new Set([
  'everything', 'wanted', 'pull', 'agent', 'vault', 'build', 'make', 'that',
  'this', 'with', 'from', 'your', 'need', 'have', 'just', 'about', 'into',
  'everything', 'actually', 'should', 'would', 'could', 'please', 'using',
]);

const UI_QUERY_SEEDS = [
  'UI design',
  'user interface',
  'UX design',
  'design system',
  'figma',
  'wireframe',
  'mockup',
  'prototype',
  'typography',
  'color palette',
  'component library',
  'layout',
  'visual design',
  'style guide',
  'design tokens',
  'interface design',
  'screenshot',
  'design asset',
];

/**
 * @param {string} message
 * @param {object} [spec]
 */
export function deriveTopicSearchQueries(message, spec = {}) {
  const combined = [
    message,
    spec?.instructions,
    spec?.description,
    spec?.source_description,
    spec?.name,
  ]
    .filter(Boolean)
    .join('\n');
  const lower = combined.toLowerCase();

  const queries = [];
  const uiIntent =
    /\b(ui|ux|user interface|design system|figma|sketch|wireframe|mockup|typography|visual design|interface)\b/i.test(
      combined,
    );

  if (uiIntent) {
    for (const q of UI_QUERY_SEEDS) queries.push(q);
  }

  for (const w of String(message || '').split(/\s+/)) {
    const clean = w.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    if (clean.length > 3 && !STOPWORDS.has(clean)) queries.push(clean);
  }

  if (!queries.length) {
    queries.push(String(message || 'vault').trim().slice(0, 80) || 'notes');
  }

  return [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, 14);
}

/** User wants a full catalog of vault items, not keyword search. */
export function wantsFullVaultInventory(message, spec = {}) {
  const text = [
    message,
    spec?.instructions,
    spec?.description,
    spec?.source_description,
    spec?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const vaultish = /\b(vault|saved items?|my notes?)\b/.test(text);
  if (!vaultish) return false;
  return /\b(lists?|inventory|catalog|everything|all items?|entire vault|full vault|go(?:es)?\s+through|browse through|walk through|show me all|show all|every note|every item|complete list|what(?:'s| is) in|all (?:the )?(?:notes|items|files)|enumerate)\b/.test(
    text,
  );
}

export function shouldUseVaultInventoryExecutor(spec, message) {
  const tools = spec?.tools || [];
  if (!tools.includes('lykn_searchVault')) return false;
  return wantsFullVaultInventory(message, spec);
}

export function wantsEmailInTask(message, spec = {}) {
  const text = [
    message,
    spec?.instructions,
    spec?.description,
    spec?.source_description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\b(gmail|inbox|email|e-mail|newsletter|unsubscribe)\b/.test(text)) return true;
  const integrations = spec?.integrations_required || [];
  return integrations.some((i) => {
    const id = String(i?.id || i?.provider || '').toLowerCase();
    return id === 'gmail';
  });
}

/**
 * @param {object} hit
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => {
      if (typeof t === 'string') return t;
      if (t && typeof t === 'object') return String(t.name || t.label || t.tag || t.id || '');
      return String(t || '');
    })
    .filter(Boolean);
}

export function isLikelyEmailVaultHit(hit) {
  const tags = normalizeTags(hit?.tags).map((t) => t.toLowerCase());
  if (tags.some((t) => EMAIL_TAGS.has(t))) return true;

  const title = String(hit?.title || '');
  const snippet = String(hit?.snippet || '').toLowerCase();
  const titleL = title.toLowerCase();

  if (/^(re:|fwd:|fw:)\s*/i.test(title)) return true;
  if (/\b@\S+\.\S+/.test(title) && title.length < 120) return true;
  if (snippet.includes('unsubscribe') || snippet.includes('mailto:')) return true;
  if (titleL.includes('gmail') || titleL.includes('inbox')) return true;

  return false;
}

/**
 * @param {object} hit
 * @param {string[]} queries
 */
export function scoreVaultHitRelevance(hit, queries) {
  const blob = `${hit?.title || ''} ${hit?.snippet || ''} ${(hit?.tags || []).join(' ')}`.toLowerCase();
  let score = 0;
  for (const q of queries) {
    const ql = String(q).toLowerCase();
    if (ql.length < 3) continue;
    if (blob.includes(ql)) score += ql.length >= 8 ? 4 : ql.length >= 5 ? 2 : 1;
  }
  const tags = normalizeTags(hit?.tags).map((t) => t.toLowerCase());
  if (tags.some((t) => /design|ui|ux|figma|wireframe|mockup|style/.test(t))) score += 8;
  if (isLikelyEmailVaultHit(hit)) score -= 100;
  return score;
}

/**
 * @param {object[]} hits
 * @param {object} options
 */
export function filterAndRankVaultHits(hits, { queries, excludeEmail = true, minScore = 1 } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  return list
    .map((h) => ({ hit: h, score: scoreVaultHitRelevance(h, queries) }))
    .filter(({ hit, score }) => {
      if (excludeEmail && isLikelyEmailVaultHit(hit)) return false;
      return score >= minScore;
    })
    .sort((a, b) => b.score - a.score)
    .map(({ hit }) => hit);
}

export function shouldUseVaultTopicExecutor(spec, message) {
  const tools = spec?.tools || [];
  if (!tools.includes('lykn_searchVault')) return false;
  if (wantsFullVaultInventory(message, spec)) return false;
  if (wantsEmailInTask(message, spec)) return false;
  return true;
}

/**
 * Load vault notes by recency (no substring filter) — for "list everything" agents.
 */
export async function listVaultNotesFromDb(ctx, { limit = 120 } = {}) {
  if (!ctx?.supabaseAdmin || !ctx?.userId) {
    throw new Error('Unauthorized — no LYKN user resolved.');
  }
  const cap = Math.max(1, Math.min(200, Number(limit) || 120));
  const { data, error } = await ctx.supabaseAdmin
    .from('notes')
    .select('id, title, content, created_at, updated_at, tags')
    .eq('user_id', ctx.userId)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(cap);
  if (error) {
    throw new Error(`vault list failed: ${error.message}`);
  }
  return (data || []).map((n) => {
    const text = String(n.content || '');
    return {
      node_id: `vault_${n.id}`,
      id: n.id,
      title: n.title || '(untitled)',
      snippet: text.slice(0, 240).trim(),
      tags: Array.isArray(n.tags) ? n.tags.slice(0, 8) : [],
      created_at: n.created_at,
      updated_at: n.updated_at,
      url: `/vault?note=${encodeURIComponent(n.id)}`,
    };
  });
}

/**
 * Full vault inventory — lists recent notes directly (not keyword search).
 */
export async function executeVaultInventoryAgent({
  spec,
  ctx,
  contextBlock,
  excludeEmail = false,
  toolsFn,
  limit = 120,
}) {
  const toolCalls = [];
  const wrap = async (toolName, args) => {
    const result = await toolsFn(toolName, args);
    toolCalls.push({ tool: toolName, args, ok: true, result });
    return result;
  };

  let hits = await listVaultNotesFromDb(ctx, { limit });
  const totalFetched = hits.length;

  if (excludeEmail) {
    hits = hits.filter((h) => !isLikelyEmailVaultHit(h));
  }

  const lines = [
    `# ${spec?.name || 'Vault inventory'}`,
    '',
    `Listed **${hits.length}** vault items (most recent first, up to ${limit} loaded).`,
  ];
  if (excludeEmail && hits.length < totalFetched) {
    lines.push(`_${totalFetched - hits.length} email/Gmail-tagged items omitted._`);
  }
  lines.push('');

  if (!hits.length) {
    if (totalFetched === 0) {
      lines.push(
        '_Your LYKN vault has no saved notes yet. Save links, files, or notes in **Connections → Vault** first._',
      );
    } else {
      lines.push(
        '_Notes exist in your vault but were all filtered out (e.g. email-only). Re-run without email filters or connect Gmail if you want inbox items._',
      );
    }
  } else {
    lines.push('## Vault items', '');
    let n = 0;
    for (const h of hits) {
      n += 1;
      const tags = Array.isArray(h.tags) && h.tags.length ? ` _(${h.tags.join(', ')})_` : '';
      const updated = h.updated_at ? ` · updated ${String(h.updated_at).slice(0, 10)}` : '';
      lines.push(`### ${n}. ${h.title || 'Untitled'}${tags}${updated}`);
      if (h.snippet) lines.push(String(h.snippet).slice(0, 320));
      if (h.url) lines.push(`[Open in vault](${h.url})`);
      lines.push('');
    }
    if (totalFetched >= limit) {
      lines.push(`_Showing the ${limit} most recently updated items. Ask to search for older or specific topics._`);
    }
  }

  if (contextBlock) {
    lines.push('', '## Synthesis context (excerpt)', contextBlock.slice(0, 1200));
  }

  return {
    ok: true,
    reply: lines.join('\n'),
    tool_calls: toolCalls,
    runtime: 'vault-inventory',
    meta: {
      total_fetched: totalFetched,
      listed: hits.length,
      exclude_email: excludeEmail,
    },
  };
}

/**
 * Deterministic vault agent: multi-query search, email filtering, relevance ranking.
 */
export async function executeVaultTopicAgent({
  message,
  spec,
  toolsFn,
  contextBlock,
  excludeEmail = true,
}) {
  const queries = deriveTopicSearchQueries(message, spec);
  const toolCalls = [];
  const byId = new Map();

  const wrap = async (toolName, args) => {
    const result = await toolsFn(toolName, args);
    toolCalls.push({ tool: toolName, args, ok: true, result });
    return result;
  };

  for (const query of queries) {
    try {
      const res = await wrap('lykn_searchVault', {
        query,
        limit: 25,
        ...(excludeEmail
          ? { exclude_tags: ['gmail', 'email', 'inbox', 'outbox', 'mail'] }
          : {}),
      });
      const hits = res?.hits || [];
      const ranked = filterAndRankVaultHits(hits, { queries, excludeEmail, minScore: 0 });
      for (const h of ranked) {
        const id = h?.node_id || (h?.id ? `vault_${h.id}` : null);
        if (!id) continue;
        const score = scoreVaultHitRelevance(h, queries);
        const prev = byId.get(id);
        if (!prev || score > prev.score) {
          byId.set(id, { hit: h, score });
        }
      }
    } catch (err) {
      toolCalls.push({
        tool: 'lykn_searchVault',
        args: { query },
        ok: false,
        error: String(err?.message || err),
      });
    }
  }

  const sorted = [...byId.values()].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 32).map((x) => x.hit);
  const nodeIds = top.map((h) => h.node_id || `vault_${h.id}`).filter(Boolean);

  let loadedDetails = [];
  if (nodeIds.length && (spec?.tools || []).includes('lykn_loadNeurons')) {
    const batchSize = 12;
    for (let i = 0; i < nodeIds.length; i += batchSize) {
      const batch = nodeIds.slice(i, i + batchSize);
      try {
        const loaded = await wrap('lykn_loadNeurons', { node_ids: batch });
        const neurons = loaded?.neurons || loaded?.results || [];
        if (Array.isArray(neurons)) loadedDetails.push(...neurons);
      } catch (err) {
        toolCalls.push({
          tool: 'lykn_loadNeurons',
          args: { node_ids: batch },
          ok: false,
          error: String(err?.message || err),
        });
      }
    }
  }

  const emailSkipped = excludeEmail;
  const lines = [
    `# ${spec?.name || 'Vault results'}`,
    '',
    `Searched your vault with **${queries.length}** focused queries${emailSkipped ? ' (email/Gmail items excluded)' : ''}.`,
    '',
    `**${top.length}** relevant items after ranking.`,
    '',
  ];

  if (!top.length) {
    lines.push(
      '_No vault items matched these keyword searches. If you wanted a **full list of everything**, re-run with a task like "list all items in my vault" — that uses inventory mode instead of search._',
    );
  } else {
    lines.push('## Items found', '');
    let n = 0;
    for (const h of top.slice(0, 25)) {
      n += 1;
      const tags = Array.isArray(h.tags) && h.tags.length ? ` _(${h.tags.join(', ')})_` : '';
      lines.push(`### ${n}. ${h.title || 'Untitled'}${tags}`);
      if (h.snippet) lines.push(String(h.snippet).slice(0, 500));
      if (h.url) lines.push(`[Open in vault](${h.url})`);
      lines.push('');
    }
    if (top.length > 25) {
      lines.push(`_…and ${top.length - 25} more matches._`);
    }
  }

  if (loadedDetails.length) {
    lines.push('', '## Loaded details', '');
    for (const n of loadedDetails.slice(0, 8)) {
      const title = n?.title || n?.name || n?.label || 'Item';
      const body = String(n?.content || n?.body || n?.text || '').slice(0, 600);
      lines.push(`### ${title}`, body || '_No body_', '');
    }
  }

  if (contextBlock) {
    lines.push('', '## Synthesis context (excerpt)', contextBlock.slice(0, 1500));
  }

  return {
    ok: true,
    reply: lines.join('\n'),
    tool_calls: toolCalls,
    runtime: 'vault-topic',
    meta: {
      queries,
      match_count: top.length,
      excluded_email: emailSkipped,
    },
  };
}
