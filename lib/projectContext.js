// Retained project-product context, split from the retired belief system.
// Projects, project state, membership, and project neurons are not personal memory.

/**
 * Render the user's OTHER recent projects (the ones that are NOT the
 * current focus) as a compact discovery footer for outside AI clients.
 *
 * The goal is to let an external model (Claude Desktop, Cursor, Claude
 * Code, ChatGPT) see in one round-trip that "LYKN MCP integrations" or
 * "Q1 fundraising deck" already exist as projects, BEFORE it tells the
 * user it can't find their project. Every entry includes the project
 * id, so the model can call lykn_setActiveProject({ project_id }) or
 * lykn_getProjectState({ project_id }) directly without a separate
 * lykn_listProjects round-trip.
 *
 * Returns '' if there are no candidates so the caller can decide
 * whether to emit anything at all.
 *
 *   otherProjects = [{ id, name, description, last_active_at,
 *                      state_key_count, parent_project_id, main_project_name,
 *                      is_branch }]
 */
export function formatOtherProjectsForPromptOutsideClient(otherProjects) {
  const list = Array.isArray(otherProjects) ? otherProjects.filter(Boolean) : [];
  if (list.length === 0) return '';

  const lines = [
    '[WHAT_IM_ON — other projects]',
    'Other active projects (main + branches). Connect the current screen / topic',
    'to the best fit — the user may have several. ONLY the user creates projects;',
    'you may read/update by id but never create one. When the fit is clear, call',
    'lykn_setActiveProject({ project_id }) or lykn_getProjectState({ project_id }).',
    '',
    'Structure: main projects have no parent. Branches belong to a main.',
    '',
  ];

  for (const p of list) {
    const last = p.last_active_at
      ? new Date(p.last_active_at).toISOString().slice(0, 10)
      : 'unknown';
    const stateCount = Number.isFinite(p.state_key_count) ? p.state_key_count : 0;
    const desc = p.description
      ? ` — ${String(p.description).replace(/\s+/g, ' ').trim().slice(0, 120)}`
      : '';
    const branchTag = p.is_branch && p.main_project_name
      ? ` branch of "${p.main_project_name}"`
      : p.is_branch
        ? ' branch'
        : ' main';
    lines.push(`- ${p.name || '(unnamed)'}${branchTag} [id=${p.id}] last=${last} state_keys=${stateCount}${desc}`);
  }

  return lines.join('\n').trim();
}
const PROJECT_CLIENT_LABELS = {
  LYKN: 'LYKN',
  'lykn-chat': 'LYKN',
  'lykn-synthesis': 'LYKN',
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  chatgpt: 'ChatGPT',
  'custom-agent': 'Custom Agent',
};

function labelForProjectClient(kind) {
  const k = String(kind || '').trim();
  if (!k) return '';
  return PROJECT_CLIENT_LABELS[k] || k.replace(/-/g, ' ');
}

function formatProjectTimestamp(iso) {
  const raw = String(iso || '').trim();
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** One kv entry with when + who pushed it. */
function formatProjectStateEntryLine(key, entry) {
  const at = formatProjectTimestamp(entry?.set_at);
  const client = labelForProjectClient(entry?.set_by_client);
  const meta = [at, client].filter(Boolean).join(' · ');
  const metaSuffix = meta ? ` @ ${meta}` : '';
  const value = String(entry?.value || '').replace(/\s+/g, ' ').trim();
  return `- ${key}${metaSuffix}: ${value}`;
}

/**
 * Pull a compact Who / What / Next resume from project state keys so the
 * model can continue a project without re-reading the full kv dump.
 */
function buildProjectResumeLines(state, opts = {}) {
  const slim = !!opts.slim;
  if (!state || typeof state !== 'object') return [];
  const pick = (...keys) => {
    for (const k of keys) {
      const entry = state[k];
      const v = String(entry?.value || '').replace(/\s+/g, ' ').trim();
      if (v) return v.slice(0, slim ? 120 : 200);
    }
    return null;
  };
  const who = pick(
    'who',
    'stakeholders',
    'audience',
    'users',
    'customer',
    'team',
    'collaborators',
  );
  const what = pick(
    'what',
    'current_focus',
    'focus',
    'status',
    'summary',
    'goal',
    'milestone',
    'tech_stack',
  );
  const next = pick(
    'next',
    'next_step',
    'next_steps',
    'todo',
    'current_blocker',
    'blocker',
    'blocked_by',
  );
  if (!who && !what && !next) return [];
  const lines = ['', 'Resume (who / what / next — prefer these over inventing status):'];
  if (who) lines.push(`Who: ${who}`);
  if (what) lines.push(`What: ${what}`);
  if (next) lines.push(`Next: ${next}`);
  return lines;
}

/** Chronological push log — helps models reason about sequence of decisions. */
function formatProjectRecentActivityLines(recentActivity) {
  const list = Array.isArray(recentActivity) ? recentActivity.filter(Boolean) : [];
  if (!list.length) return [];
  const lines = [
    '',
    'Recent updates (chronological — newest first):',
    'Each line is one push; the client/model in parentheses is who wrote it.',
  ];
  for (const row of list.slice(0, 16)) {
    const at = formatProjectTimestamp(row.set_at);
    const client = labelForProjectClient(row.set_by_client);
    const meta = [at, client].filter(Boolean).join(' · ');
    const value = String(row.value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    lines.push(`- ${row.state_key}${meta ? ` (${meta})` : ''}: ${value}`);
  }
  if (list.length > 16) {
    lines.push(`(+ ${list.length - 16} older — call lykn_getProjectState with include_history for more)`);
  }
  return lines;
}

/**
 * Format the user's active project + its current state as a prompt
 * block suitable for outside-AI clients. Returns '' when there's no
 * active project or when the project has no state pushes yet.
 *
 *   projectContext = {
 *     project: { id, name, description, last_active_at, ... },
 *     state:   { tech_stack: { value, set_by_client, set_at }, ... }
 *   }
 *
 * The block tells the model TWO things:
 *   1. What's already known about this project (state kv-pairs).
 *   2. How to push back when this conversation produces a new decision
 *      (lykn_pushProjectState contract, named so the model can find
 *      and call it without re-reading tool descriptors mid-turn).
 *
 * Keep this terse. It runs before BELIEFS_AND_RULES, takes ~150–400
 * tokens depending on state count, and is included in EVERY
 * getContextBlock response — so density matters.
 */
export function formatProjectStateForPromptOutsideClient(projectContext) {
  if (!projectContext || !projectContext.project) return '';
  const { project, state, neurons, recentActivity, mainContext } = projectContext;
  const stateEntries = state && typeof state === 'object' ? Object.entries(state) : [];

  // Header. We tell the model the project name + description (if any)
  // + when it was last touched + by which client. The "by which client"
  // bit lets the model say "Cursor was on this yesterday" naturally.
  const lastActive = project.last_active_at
    ? new Date(project.last_active_at).toISOString()
    : null;

  const header = [
    '[WHAT_IM_ON]',
    'What this person is working on — connect the current screen / conversation to their projects.',
    'They may have multiple projects; pick the best fit and name it. Don\'t re-litigate decisions below.',
    '',
    `Active focus: ${project.name || '(unnamed)'}`,
  ];
  if (project.description) header.push(`Description: ${project.description}`);
  if (lastActive) header.push(`Last activity: ${lastActive}`);
  if (project.created_by_client) header.push(`Started in: ${project.created_by_client}`);
  if (project.parent_project_id && project.main_project_name) {
    header.push(`Branch of main: ${project.main_project_name} [id=${project.parent_project_id}]`);
  } else if (!project.parent_project_id) {
    header.push('Type: main project');
  }
  if (project.id) header.push(`project_id: ${project.id}`);

  // State kv-pairs. Sort so the most-recently-set keys appear first —
  // the model is more likely to lean on recent decisions, and recency
  // also doubles as "what we last cared about." Cap to keep prompt
  // size sane; lykn_getProjectState is available for the long tail.
  const sorted = stateEntries
    .filter(([, v]) => v && v.value)
    .sort((a, b) => {
      const aSet = a[1]?.set_at ? Date.parse(a[1].set_at) : 0;
      const bSet = b[1]?.set_at ? Date.parse(b[1].set_at) : 0;
      return bSet - aSet;
    })
    .slice(0, 24);

  const stateLines = sorted.length
    ? sorted.map(([key, entry]) => formatProjectStateEntryLine(key, entry))
    : ['(no state pushes yet — this project was just created)'];

  const activityLines = formatProjectRecentActivityLines(recentActivity);

  const mainLines = [];
  if (mainContext?.project && mainContext?.state) {
    const mainEntries = Object.entries(mainContext.state).filter(([, v]) => v?.value).slice(0, 8);
    if (mainEntries.length) {
      mainLines.push(
        '',
        `Main project context (${mainContext.project.name || 'main'} — inherited baseline for this branch):`,
      );
      for (const [key, entry] of mainEntries) {
        mainLines.push(formatProjectStateEntryLine(key, entry));
      }
    }
  }

  // Clustered neurons. The user explicitly grouped these synthesis-
  // layer neurons into the project from LYKN's "+ Create project"
  // flow on the project page. Working state above is what
  // outside AI clients pushed in; THIS section is the user's
  // hand-picked answer to "what is this project made of?". Worth
  // keeping in the context block because the model can reference
  // specific clustered notes/beliefs/concepts directly without
  // needing to call extra discovery tools.
  const neuronList = Array.isArray(neurons) ? neurons : [];
  const neuronLines = [];
  if (neuronList.length > 0) {
    neuronLines.push('', 'Clustered context (user-grouped for this project):');
    // Cap at ~16 entries inline; the project is the user's pick of
    // what matters, so list density beats the long tail. The full
    // list is reachable via lykn_listProjects if the model needs it.
    for (const n of neuronList.slice(0, 16)) {
      const kind = n?.kind ? ` [${n.kind}]` : '';
      const label = (n?.label || '(unlabeled)').toString().replace(/\s+/g, ' ').trim();
      neuronLines.push(`- ${label}${kind}`);
    }
    if (neuronList.length > 16) {
      neuronLines.push(`(+ ${neuronList.length - 16} more — call lykn_listProjects for the rest)`);
    }
  }

  const footer = [
    '',
    'Timestamps and client labels show WHEN each key was last updated and WHICH',
    'AI client pushed it — do not attribute a push to yourself unless you made it',
    'in this conversation. When this conversation produces a meaningful decision,',
    'milestone, or change to one of the keys above, call:',
    '  lykn_pushProjectState({ state_key: "<slug>", state_value: "<≤2000 chars>" })',
    'Reuse keys (e.g. "current_blocker", "tech_stack") so the value replaces,',
    'not appends. New keys are fine when the topic is genuinely new.',
  ];

  return [
    ...header,
    '',
    'Current state (sorted by most recently updated key):',
    ...stateLines,
    ...mainLines,
    ...activityLines,
    ...neuronLines,
    ...footer,
  ].join('\n').trim();
}

/**
 * In-LYKN variant of the [CURRENT_PROJECT] block. Same body (header +
 * state kv-pairs + clustered neurons) as the outside-client formatter,
 * but the trailing footer doesn't push the model toward MCP tool calls
 * (the in-LYKN AI doesn't have those wired into its chat loop yet — it
 * gets project context via this prompt block, and writes happen via the
 * synthesis-page UI). Tells the model the project is the user's current
 * work and to reference it conversationally rather than re-litigating.
 *
 * If `projectContext` is null (no active project), returns ''.
 */
export function formatProjectStateForPromptInLykn(projectContext, opts = {}) {
  if (!projectContext || !projectContext.project) return '';
  const { project, state, neurons, recentActivity, mainContext } = projectContext;
  const stateEntries = state && typeof state === 'object' ? Object.entries(state) : [];
  const slim = !!opts.slim;
  const maxState = slim ? 4 : 24;
  const maxNeurons = slim ? 6 : 16;

  const lastActive = project.last_active_at
    ? new Date(project.last_active_at).toISOString()
    : null;

  const header = slim
    ? [
        '[WHAT_IM_ON]',
        'Active project (context only — do not open tools or re-litigate unless they ask).',
        '',
        `Active focus: ${project.name || '(unnamed)'}`,
      ]
    : [
        '[WHAT_IM_ON]',
        'What this person is working on — connect the current screen / this conversation to their projects.',
        'They may have several; pick the best fit, name it, and don\'t re-litigate decisions already captured below.',
        '',
        `Active focus: ${project.name || '(unnamed)'}`,
      ];
  if (project.description) {
    const desc = String(project.description);
    header.push(`Description: ${slim && desc.length > 160 ? `${desc.slice(0, 157)}…` : desc}`);
  }
  if (!slim && lastActive) header.push(`Last activity: ${lastActive}`);
  if (!slim && project.created_by_client) header.push(`Started in: ${project.created_by_client}`);
  if (!slim) {
    if (project.parent_project_id && project.main_project_name) {
      header.push(`Branch of main: ${project.main_project_name} [id=${project.parent_project_id}]`);
    } else if (!project.parent_project_id) {
      header.push('Type: main project');
    }
  }
  if (project.id) header.push(`project_id: ${project.id}`);

  const sorted = stateEntries
    .filter(([, v]) => v && v.value)
    .sort((a, b) => {
      const aSet = a[1]?.set_at ? Date.parse(a[1].set_at) : 0;
      const bSet = b[1]?.set_at ? Date.parse(b[1].set_at) : 0;
      return bSet - aSet;
    })
    .slice(0, maxState);

  const stateLines = sorted.length
    ? sorted.map(([key, entry]) => formatProjectStateEntryLine(key, entry))
    : (slim ? [] : ['(no state pushes yet — this project was just created)']);

  const activityLines = slim ? [] : formatProjectRecentActivityLines(recentActivity);

  const mainLines = [];
  if (!slim && mainContext?.project && mainContext?.state) {
    const mainEntries = Object.entries(mainContext.state).filter(([, v]) => v?.value).slice(0, 8);
    if (mainEntries.length) {
      mainLines.push(
        '',
        `Main project context (${mainContext.project.name || 'main'} — inherited baseline for this branch):`,
      );
      for (const [key, entry] of mainEntries) {
        mainLines.push(formatProjectStateEntryLine(key, entry));
      }
    }
  }

  const neuronList = Array.isArray(neurons) ? neurons : [];
  const neuronLines = [];
  if (neuronList.length > 0) {
    neuronLines.push('', slim ? 'Clustered context:' : 'Clustered context (user-grouped for this project):');
    for (const n of neuronList.slice(0, maxNeurons)) {
      const kind = n?.kind ? ` [${n.kind}]` : '';
      const label = (n?.label || '(unlabeled)').toString().replace(/\s+/g, ' ').trim();
      neuronLines.push(`- ${label}${kind}`);
    }
    if (neuronList.length > maxNeurons) {
      neuronLines.push(`(+ ${neuronList.length - maxNeurons} more — visible on the project page)`);
    }
  }

  const resumeLines = buildProjectResumeLines(state, { slim });

  if (slim) {
    const slimBody = [
      ...header,
      ...resumeLines,
      ...(stateLines.length
        ? ['', 'Recent state:', ...stateLines]
        : []),
      ...neuronLines,
    ];
    return slimBody.join('\n').trim();
  }

  const footer = [
    '',
    'Timestamps and client labels show WHEN each key was last updated and WHICH',
    'AI client pushed it. Prior assistant replies in [CONVERSATION] are labeled',
    'with their model — those were written by that model, not necessarily you.',
    'If this conversation produces a meaningful new decision, blocker, or',
    'next step for this project, push it (who / what / next / current_blocker)',
    'so Resume stays accurate. Outside AI clients can update via MCP; in-LYKN',
    'chat can use project tools when available — otherwise point them at the',
    'project panel for durable changes.',
  ];

  return [
    ...header,
    ...resumeLines,
    '',
    'Current state (sorted by most recently updated key):',
    ...stateLines,
    ...mainLines,
    ...activityLines,
    ...neuronLines,
    ...footer,
  ].join('\n').trim();
}

/**
 * Load one project's context (state + neurons + recent activity).
 * Used by active-project loader and by resolve/focus flows.
 */
// Resolve the caller's access role to a project: 'owner' (they created it),
// the membership role ('owner'|'editor'|'viewer') if it's shared with them, or
// null if they have no access. Collaboration (109/110): the AI context loaders
// below use this so a member who focuses a SHARED project still gets its team
// working memory, while non-members get nothing.
export async function resolveProjectAccessRole(client, userId, projectId) {
  if (!client || !userId || !projectId) return null;
  try {
    const { data: proj } = await client
      .from('lykn_projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();
    if (proj && proj.user_id === userId) return 'owner';
    const { data: member } = await client
      .from('lykn_project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    return member?.role || null;
  } catch {
    return null;
  }
}

export async function loadProjectContextById(client, userId, projectId) {
  if (!client || !userId || !projectId) return null;
  try {
    // Membership-aware (110): the row may be owned by someone else and shared
    // with this user. Verify access, then read state project-wide (every
    // member's pushes form the shared working memory).
    const accessRole = await resolveProjectAccessRole(client, userId, projectId);
    if (!accessRole) return null;

    const { data: project } = await client
      .from('lykn_projects')
      .select('id, name, description, status, created_by_client, created_by, parent_project_id, last_active_at')
      .eq('id', projectId)
      .maybeSingle();
    if (!project || project.status !== 'active') return null;

    let mainProjectName = null;
    if (project.parent_project_id) {
      const { data: mainRow } = await client
        .from('lykn_projects')
        .select('name')
        .eq('id', project.parent_project_id)
        .maybeSingle();
      mainProjectName = mainRow?.name || null;
    }

    const { data: rows } = await client
      .from('lykn_project_state')
      .select('state_key, state_value, set_by_client, created_at')
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

    let recentActivity = [];
    try {
      const { data: activityRows } = await client
        .from('lykn_project_state')
        .select('state_key, state_value, set_by_client, created_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(20);
      recentActivity = (activityRows || []).map((row) => ({
        state_key: row.state_key,
        value: row.state_value,
        set_by_client: row.set_by_client,
        set_at: row.created_at,
      }));
    } catch (err) {
      console.warn('[projectContext] project activity load failed:', err?.message || err);
    }

    let neurons = [];
    try {
      const { data: memberRows } = await client
        .from('lykn_project_neurons')
        .select('node_id, node_label, node_kind, created_at')
        .eq('user_id', userId)
        .eq('project_id', projectId)
        .like('node_id', 'vault_%')
        .order('created_at', { ascending: true })
        .limit(40);
      neurons = (memberRows || []).map((r) => ({
        node_id: r.node_id,
        label: r.node_label,
        kind: r.node_kind,
      }));
    } catch (err) {
      console.warn('[projectContext] project neuron load failed:', err?.message || err);
    }

    let mainContext = null;
    if (project.parent_project_id) {
      mainContext = await loadProjectContextById(client, userId, project.parent_project_id);
    }

    return {
      project: {
        ...project,
        main_project_name: mainProjectName,
      },
      state,
      neurons,
      recentActivity,
      mainContext: mainContext
        ? {
            project: mainContext.project,
            state: mainContext.state,
          }
        : null,
    };
  } catch (err) {
    console.warn('[projectContext] project context load failed:', err?.message || err);
    return null;
  }
}

/**
 * Load the user's active project, current key-value state, and attached
 * Vault knowledge for Chat grounding.
 *
 * Best-effort: any failure (missing preferences, missing tables, network
 * blip) returns null so the caller can keep going without project
 * context. Tables involved:
 *   • lykn_user_preferences.active_project_id  → which project
 *   • lykn_projects                                  → header
 *   • lykn_project_state (superseded_at IS NULL)     → kv state
 *   • lykn_project_neurons (migration 063, optional) → Vault membership
 *
 * Returns:
 *   null
 *   | {
 *       project:  { id, name, description, status, created_by_client, last_active_at },
 *       state:    { [state_key]: { value, set_by_client, set_at } },
 *       neurons:  [{ node_id, label, kind }],
 *       recentActivity: [{ state_key, value, set_by_client, set_at }],
 *     }
 */
export async function loadActiveProjectContext(client, userId) {
  if (!client || !userId) return null;
  try {
    const { data: profile } = await client
      .from('lykn_user_preferences')
      .select('active_project_id')
      .eq('user_id', userId)
      .maybeSingle();
    const projectId = profile?.active_project_id;
    if (!projectId) return null;
    return loadProjectContextById(client, userId, projectId);
  } catch (err) {
    console.warn('[projectContext] active project load failed:', err?.message || err);
    return null;
  }
}

/**
 * Load a short list of the user's OTHER recent projects — i.e. projects
 * the user has touched that are NOT the current active focus. Powers the
 * `[OTHER_PROJECTS]` footer in `getContextBlock` so outside AI clients
 * can see at a glance what else exists without spending a separate
 * `lykn_listProjects` round-trip.
 *
 * Why this matters:
 *   The single-project context block was lying-by-omission whenever the
 *   user mentioned a project that wasn't the current focus — agents
 *   would say "I can't find that project" and then fumble. Surfacing
 *   2–5 candidates upfront eliminates the ambiguity in one round-trip.
 *
 * Best-effort: returns [] on any failure so the caller can keep going.
 *
 * Returns:
 *   [{ id, name, description, last_active_at, state_key_count }]
 */
export async function loadOtherProjectsForUser(client, userId, opts = {}) {
  if (!client || !userId) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || 5, 1), 12);
  const excludeId = typeof opts.excludeId === 'string' ? opts.excludeId : null;

  try {
    let q = client
      .from('lykn_projects')
      .select('id, name, description, last_active_at, parent_project_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('last_active_at', { ascending: false })
      .limit(limit + (excludeId ? 1 : 0));

    const { data: rows, error } = await q;
    if (error) {
      console.warn('[projectContext] other projects load failed:', error.message);
      return [];
    }

    const filtered = (rows || [])
      .filter((r) => r && r.id !== excludeId)
      .slice(0, limit);
    if (filtered.length === 0) return [];

    const nameById = new Map((rows || []).map((r) => [r.id, r.name]));

    // Tally state_key_count per candidate so the model can tell at a
    // glance which "other" projects have working memory accumulated
    // vs which are just empty shells. One round-trip for the batch.
    const ids = filtered.map((r) => r.id);
    const counts = new Map();
    try {
      const { data: stateRows } = await client
        .from('lykn_project_state')
        .select('project_id, state_key')
        .eq('user_id', userId)
        .in('project_id', ids)
        .is('superseded_at', null);
      for (const sr of stateRows || []) {
        counts.set(sr.project_id, (counts.get(sr.project_id) || 0) + 1);
      }
    } catch (err) {
      console.warn('[projectContext] other projects state-count failed:', err?.message || err);
    }

    return filtered.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      last_active_at: r.last_active_at,
      state_key_count: counts.get(r.id) || 0,
      parent_project_id: r.parent_project_id || null,
      is_branch: Boolean(r.parent_project_id),
      main_project_name: r.parent_project_id ? (nameById.get(r.parent_project_id) || null) : null,
    }));
  } catch (err) {
    console.warn('[projectContext] other projects load threw:', err?.message || err);
    return [];
  }
}
