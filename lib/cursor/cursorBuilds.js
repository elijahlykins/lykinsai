// ============================================================================
// lib/cursor/cursorBuilds.js — dispatch coding tasks to Cursor Cloud Agents
// ============================================================================
// The LYKN voice/text agent can hand a build to a Cursor CLOUD AGENT: it runs
// async on a Cursor-hosted VM against the allowlisted repo and opens a PR. We
// talk to the Cloud Agents REST API directly (no @cursor/sdk — that pulls a
// native sqlite3 run-store we don't want inside the web server, and the
// launch-then-poll shape is a clean fit for plain HTTP).
//
//   launch:  POST /v1/agents                       → { agent:{id,...}, run:{id,...} }
//   poll:    GET  /v1/agents/{id}/runs/{runId}      → { status, result, git:{branches:[{prUrl}]} }
//
// Run status is terminal at FINISHED / ERROR / CANCELLED / EXPIRED. On
// completion we record the PR url + result, push a project-state update, and
// leave announced_at NULL so the next voice briefing tells the user.
//
// Everything is best-effort and self-contained: callers pass a Supabase admin
// client + userId. Nothing here throws into the request path — failures come
// back as { ok:false, error }.

const CURSOR_API_BASE = (process.env.CURSOR_API_BASE || 'https://api.cursor.com').replace(/\/+$/, '');
const LAUNCH_TIMEOUT_MS = 25_000;
const POLL_TIMEOUT_MS = 15_000;
// Cap how many in-flight builds one poller tick syncs, so a backlog can't
// stall the interval. The rest get picked up on the next tick.
const POLL_BATCH = 8;

const TERMINAL_OK = new Set(['FINISHED']);
const TERMINAL_FAIL = new Set(['ERROR', 'EXPIRED']);
const TERMINAL_CANCELLED = new Set(['CANCELLED']);

export function getCursorApiKey() {
  return String(process.env.CURSOR_API_KEY || '').trim();
}

export function isCursorBuildsConfigured() {
  return Boolean(getCursorApiKey());
}

export function getCursorBuildRepo() {
  return String(process.env.CURSOR_BUILD_REPO || '').trim();
}

function getCursorBuildRef() {
  return String(process.env.CURSOR_BUILD_REF || 'main').trim() || 'main';
}

function getCursorBuildModel() {
  return String(process.env.CURSOR_BUILD_MODEL || '').trim();
}

function shortRepoName(url) {
  const m = String(url || '').match(/github\.com[/:]([^/]+\/[^/.]+)/i);
  return m ? m[1] : String(url || '').replace(/^https?:\/\//, '');
}

// Thin authed fetch against the Cloud Agents API. Returns { ok, status, data }.
async function cursorApi(path, { method = 'GET', body = null, timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const apiKey = getCursorApiKey();
  if (!apiKey) return { ok: false, status: 0, data: { error: 'cursor_not_configured' } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${CURSOR_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data: data || {} };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return { ok: false, status: 0, data: { error: aborted ? 'cursor_timeout' : (err?.message || 'cursor_request_failed') } };
  } finally {
    clearTimeout(timer);
  }
}

// Map a Cloud Agents run status onto our build lifecycle.
function mapRunStatus(runStatus) {
  const s = String(runStatus || '').toUpperCase();
  if (TERMINAL_OK.has(s)) return 'completed';
  if (TERMINAL_FAIL.has(s)) return 'failed';
  if (TERMINAL_CANCELLED.has(s)) return 'cancelled';
  return 'running';
}

// Pull the PR url (and branch) out of a run's git snapshot, if present.
function extractPr(runData) {
  const branches = Array.isArray(runData?.git?.branches) ? runData.git.branches : [];
  for (const b of branches) {
    if (b?.prUrl) return { prUrl: b.prUrl, branch: b.branch || null };
  }
  // No PR yet — surface the branch so the user can still find the work.
  const withBranch = branches.find((b) => b?.branch);
  return { prUrl: null, branch: withBranch?.branch || null };
}

/**
 * Launch a Cursor cloud-agent build against the allowlisted repo.
 *
 * @returns {Promise<{ ok: boolean, build?: object, error?: string, message?: string }>}
 */
export async function launchCursorBuild({ client, userId, instruction, projectId = null } = {}) {
  if (!client || !userId) return { ok: false, error: 'unauthorized', message: 'No LYKN user resolved.' };
  if (!isCursorBuildsConfigured()) {
    return {
      ok: false,
      error: 'cursor_not_configured',
      message: 'Cursor builds are not configured on the server (missing CURSOR_API_KEY).',
    };
  }
  const task = String(instruction || '').trim();
  if (!task) return { ok: false, error: 'missing_instruction', message: 'An instruction for the build is required.' };

  const repo = getCursorBuildRepo();
  if (!repo) {
    return {
      ok: false,
      error: 'no_repo_configured',
      message: 'No build repo is configured on the server (missing CURSOR_BUILD_REPO).',
    };
  }

  const promptText = [
    task,
    '',
    'When done, open a pull request with your changes. Do NOT merge it or deploy —',
    'the user reviews, tests, and deploys manually.',
  ].join('\n');

  const body = {
    prompt: { text: promptText },
    repos: [{ url: repo, startingRef: getCursorBuildRef() }],
    autoCreatePR: true,
    skipReviewerRequest: true,
    name: task.slice(0, 100),
  };
  const model = getCursorBuildModel();
  if (model) body.model = { id: model };

  const launch = await cursorApi('/v1/agents', { method: 'POST', body, timeoutMs: LAUNCH_TIMEOUT_MS });
  if (!launch.ok) {
    const err = launch.data?.error || launch.data?.message || `http_${launch.status}`;
    return {
      ok: false,
      error: String(err),
      message:
        launch.status === 401 || launch.status === 403
          ? 'Cursor rejected the API key (check CURSOR_API_KEY has Cloud Agents access).'
          : `Cursor could not start the build (${err}).`,
    };
  }

  const agent = launch.data?.agent || {};
  const run = launch.data?.run || {};
  const agentId = agent.id || null;
  const runId = run.id || agent.latestRunId || null;

  const row = {
    user_id: userId,
    project_id: projectId || null,
    instruction: task.slice(0, 8000),
    repo,
    agent_id: agentId,
    run_id: runId,
    agent_url: agent.url || (agentId ? `https://cursor.com/agents/${agentId}` : null),
    status: 'running',
  };

  const { data: inserted, error: insErr } = await client
    .from('lykn_cursor_builds')
    .insert(row)
    .select('*')
    .single();
  if (insErr) {
    // The cloud agent IS running; we just couldn't persist it. Report enough
    // that the user can still find it on the Cursor dashboard.
    console.warn('[cursorBuilds] insert failed after launch:', insErr.message);
    return {
      ok: true,
      build: { ...row, id: null, persisted: false },
      message: 'Build started on Cursor, but I could not save it to your project tracker.',
    };
  }

  return { ok: true, build: inserted };
}

// Push a project-state update for a finished build (best-effort).
async function pushBuildToProject(client, build) {
  if (!build?.project_id) return;
  try {
    const { pushProjectStateTool } = await import('../../mcp-tools/pushProjectState.js');
    const repoName = shortRepoName(build.repo);
    const verb = build.status === 'completed' ? 'finished' : 'failed';
    const prPart = build.pr_url ? ` PR: ${build.pr_url}` : '';
    const value =
      build.status === 'completed'
        ? `Cursor ${verb} a build: ${String(build.instruction).slice(0, 200)} — ready for testing.${prPart} (${repoName})`
        : `Cursor build ${verb}: ${String(build.instruction).slice(0, 200)}. ${build.error_message || ''}`.trim();
    await pushProjectStateTool.handler(
      {
        project_id: build.project_id,
        state_key: 'recent_build',
        state_value: value.slice(0, 2000),
        reason: 'Cursor cloud-agent build update',
      },
      {
        supabaseAdmin: client,
        userId: build.user_id,
        chatModelLabel: 'cursor-build',
        attribSurface: 'lykn-chat',
      },
    );
  } catch (e) {
    console.warn('[cursorBuilds] project push failed:', e?.message || e);
  }
}

/**
 * Refresh one build from the Cloud Agents API. If it has reached a terminal
 * state, persist the result, push a project update, and (for the first
 * transition) leave announced_at NULL for the briefing. Returns the build row
 * as it now stands (refreshed when changed, original otherwise).
 */
export async function syncCursorBuild(client, build) {
  if (!client || !build) return build;
  if (build.status !== 'running') return build;
  if (!build.agent_id || !build.run_id) return build;

  const res = await cursorApi(`/v1/agents/${encodeURIComponent(build.agent_id)}/runs/${encodeURIComponent(build.run_id)}`);
  if (!res.ok) return build; // transient — try again next tick

  const runData = res.data || {};
  const nextStatus = mapRunStatus(runData.status);
  const { prUrl } = extractPr(runData);

  // Still running: only opportunistically capture an early PR url.
  if (nextStatus === 'running') {
    if (prUrl && prUrl !== build.pr_url) {
      const { data } = await client
        .from('lykn_cursor_builds')
        .update({ pr_url: prUrl, updated_at: new Date().toISOString() })
        .eq('id', build.id)
        .select('*')
        .single();
      return data || { ...build, pr_url: prUrl };
    }
    return build;
  }

  // Terminal transition.
  const patch = {
    status: nextStatus,
    pr_url: prUrl || build.pr_url || null,
    result_summary: typeof runData.result === 'string' ? runData.result.slice(0, 4000) : null,
    error_message: nextStatus === 'failed' ? String(runData.status || 'error') : null,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data: updated, error } = await client
    .from('lykn_cursor_builds')
    .update(patch)
    .eq('id', build.id)
    .select('*')
    .single();
  if (error) {
    console.warn('[cursorBuilds] terminal update failed:', error.message);
    return { ...build, ...patch };
  }

  await pushBuildToProject(client, updated);
  return updated;
}

/**
 * Poll all in-flight builds (across users) and sync any that have finished.
 * Called on an interval from server.js. No-op when Cursor isn't configured.
 *
 * @returns {Promise<{ scanned: number, completed: number }>}
 */
export async function pollRunningBuilds(client) {
  if (!client || !isCursorBuildsConfigured()) return { scanned: 0, completed: 0 };
  const { data: rows, error } = await client
    .from('lykn_cursor_builds')
    .select('*')
    .eq('status', 'running')
    .not('agent_id', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(POLL_BATCH);
  if (error || !Array.isArray(rows) || rows.length === 0) return { scanned: 0, completed: 0 };

  let completed = 0;
  for (const row of rows) {
    try {
      const after = await syncCursorBuild(client, row);
      if (after?.status && after.status !== 'running') completed += 1;
    } catch (e) {
      console.warn('[cursorBuilds] sync error:', e?.message || e);
    }
  }
  return { scanned: rows.length, completed };
}

/**
 * Read builds for a user (newest first), optionally a single one by id, and
 * refresh any still-running ones first so the agent reports fresh status.
 *
 * @returns {Promise<{ ok: boolean, builds?: object[], error?: string }>}
 */
export async function getCursorBuilds({ client, userId, buildId = null, limit = 5 } = {}) {
  if (!client || !userId) return { ok: false, error: 'unauthorized' };

  let q = client
    .from('lykn_cursor_builds')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(buildId ? 1 : Math.max(1, Math.min(20, limit)));
  if (buildId) q = q.eq('id', buildId);

  const { data: rows, error } = await q;
  if (error) return { ok: false, error: error.message };

  const builds = [];
  for (const row of rows || []) {
    builds.push(row.status === 'running' ? await syncCursorBuild(client, row) : row);
  }
  return { ok: true, builds };
}

/**
 * Mark finished-but-unannounced builds as announced, returning the ones just
 * claimed so the caller (voice briefing / chat) can speak them once. Uses a
 * timestamped update so two concurrent briefings don't double-announce.
 *
 * @returns {Promise<object[]>}
 */
export async function claimUnannouncedBuilds(client, userId) {
  if (!client || !userId) return [];
  const { data: rows, error } = await client
    .from('lykn_cursor_builds')
    .select('id, instruction, status, pr_url, repo, completed_at')
    .eq('user_id', userId)
    .in('status', ['completed', 'failed'])
    .is('announced_at', null)
    .order('completed_at', { ascending: false })
    .limit(5);
  if (error || !Array.isArray(rows) || rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  await client
    .from('lykn_cursor_builds')
    .update({ announced_at: new Date().toISOString() })
    .in('id', ids)
    .then(() => {}, () => {});
  return rows;
}

/**
 * Read finished-but-unannounced builds WITHOUT claiming them — for live grounding
 * injected on every turn (the model may or may not mention them; we don't want to
 * burn the one-shot announce). Returns a compact list.
 */
export async function peekUnannouncedBuilds(client, userId) {
  if (!client || !userId) return [];
  const { data: rows, error } = await client
    .from('lykn_cursor_builds')
    .select('instruction, status, pr_url, repo, completed_at')
    .eq('user_id', userId)
    .in('status', ['completed', 'failed'])
    .is('announced_at', null)
    .order('completed_at', { ascending: false })
    .limit(5);
  if (error || !Array.isArray(rows)) return [];
  return rows;
}
