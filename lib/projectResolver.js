// ============================================================================
// lib/projectResolver.js — pick the most relevant project for a conversation
// ============================================================================
// GitHub-style mental model: the user owns main projects (+ optional branches).
// Agents never create projects — they discover via list/resolve, then focus
// or read/write any project by id. This scorer ranks candidates when the
// user's topic doesn't obviously match the current focus pointer.

const DEFAULT_CANDIDATE_LIMIT = 8;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function scoreProject(row, tokens) {
  let score = 0;
  const name = String(row.name || '').toLowerCase();
  const desc = String(row.description || '').toLowerCase();
  const blob = `${name} ${desc}`;

  for (const t of tokens) {
    if (name.includes(t)) score += 12;
    else if (blob.includes(t)) score += 6;
  }

  if (row.is_focus) score += 4;

  const stateKeys = Number(row.state_key_count) || 0;
  if (stateKeys > 0) score += Math.min(stateKeys, 6);

  const last = row.last_active_at ? Date.parse(row.last_active_at) : 0;
  if (last) {
    const days = (Date.now() - last) / 86_400_000;
    if (days < 1) score += 8;
    else if (days < 3) score += 5;
    else if (days < 7) score += 3;
    else if (days < 30) score += 1;
  }

  // Branches slightly prefer when tokens match branch name specifically
  if (row.parent_project_id && tokens.some((t) => name.includes(t))) {
    score += 3;
  }

  return score;
}

/**
 * Rank active projects for a conversation topic.
 *
 * @returns {Promise<{
 *   activeProjectId: string|null,
 *   best: object|null,
 *   candidates: object[],
 * }>}
 */
export async function resolveRelevantProjects(client, userId, opts = {}) {
  if (!client || !userId) {
    return { activeProjectId: null, best: null, candidates: [] };
  }

  const query = String(opts.query || opts.conversationText || '').trim();
  const tokens = tokenize(query);
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_CANDIDATE_LIMIT, 1), 20);

  const [{ data: profile }, { data: rows, error }] = await Promise.all([
    client
      .from('lykn_user_synthesis_profile')
      .select('active_project_id')
      .eq('user_id', userId)
      .maybeSingle(),
    client
      .from('lykn_projects')
      .select('id, name, description, status, parent_project_id, created_by, created_by_client, last_active_at')
      .eq('user_id', userId)
      .eq('status', 'active')
      .eq('created_by', 'user')
      .order('last_active_at', { ascending: false })
      .limit(40),
  ]);

  if (error || !Array.isArray(rows) || rows.length === 0) {
    return {
      activeProjectId: profile?.active_project_id || null,
      best: null,
      candidates: [],
    };
  }

  const activeProjectId = profile?.active_project_id || null;
  const byId = new Map(rows.map((r) => [r.id, r]));

  // State key counts — one batch query
  const counts = new Map();
  try {
    const ids = rows.map((r) => r.id);
    const { data: stateRows } = await client
      .from('lykn_project_state')
      .select('project_id, state_key')
      .eq('user_id', userId)
      .in('project_id', ids)
      .is('superseded_at', null);
    for (const sr of stateRows || []) {
      counts.set(sr.project_id, (counts.get(sr.project_id) || 0) + 1);
    }
  } catch {
    /* non-fatal */
  }

  const enriched = rows.map((row) => {
    const parent = row.parent_project_id ? byId.get(row.parent_project_id) : null;
    return {
      ...row,
      state_key_count: counts.get(row.id) || 0,
      is_focus: row.id === activeProjectId,
      is_branch: Boolean(row.parent_project_id),
      main_project_id: row.parent_project_id || row.id,
      main_project_name: parent?.name || (row.parent_project_id ? null : row.name),
      relevance_score: scoreProject(
        { ...row, state_key_count: counts.get(row.id) || 0, is_focus: row.id === activeProjectId },
        tokens,
      ),
    };
  });

  const sorted = enriched
    .slice()
    .sort((a, b) => {
      if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score;
      const bLast = b.last_active_at ? Date.parse(b.last_active_at) : 0;
      const aLast = a.last_active_at ? Date.parse(a.last_active_at) : 0;
      return bLast - aLast;
    })
    .slice(0, limit);

  const best = sorted[0] || null;

  return {
    activeProjectId,
    best: best && best.relevance_score > 0 ? best : (sorted.find((p) => p.is_focus) || best),
    candidates: sorted,
  };
}
