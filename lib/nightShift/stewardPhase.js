/**
 * Night Shift Phase 1–3 — steward queue triage + research + delegation.
 */

import { searchWeb } from '../exterior/webSearch.js';
import {
  MAX_EXECUTE_PER_PROJECT,
  MAX_SUBTASKS_PER_ITEM,
  MAX_TRIAGE_PER_PROJECT,
  OVERNIGHT_PROGRESS_STATE_KEY,
  STALE_TASKS_STATE_KEY,
  STALE_TODO_DAYS,
} from './stewardConstants.js';
import {
  buildResearchUserMessage,
  buildTriageUserMessage,
  parseStewardJson,
  STEWARD_RESEARCH_SYSTEM,
  STEWARD_TRIAGE_DELEGATE_SYSTEM,
  STEWARD_TRIAGE_SYSTEM,
} from './stewardPrompt.js';
import { createTodoAdmin, loadStaleTodos, searchVaultLite } from './stewardAdminWrites.js';
import { pushProjectStateAdmin } from './pushProjectStateAdmin.js';
import { syncStewardDelegations } from './stewardCompletion.js';
import { executeDelegateItem } from './stewardDelegate.js';
import { parseExecutionKind, parseNightShiftTier } from './stewardTier.js';

const STEWARD_MODEL = process.env.NIGHT_SHIFT_MODEL || 'claude-sonnet-4-20250514';

const STEWARD_ITEM_FIELDS =
  'id, title, spec, execution_kind, repo, sub_model_id, cursor_build_id, sub_model_task_id';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} admin
 * @param {string} userId
 * @param {Array<{ id: string, name: string, description?: string|null }>} projects
 * @param {{ trigger?: string, tier?: string }} opts
 */
export async function runStewardPhaseForUser(admin, userId, projects, { trigger = 'cron', tier = 'research' } = {}) {
  const nightTier = parseNightShiftTier(tier);
  const { data: runRow, error: runErr } = await admin
    .from('lykn_steward_runs')
    .insert({ user_id: userId, trigger, status: 'running' })
    .select('id')
    .single();
  if (runErr) throw new Error(`steward run insert failed: ${runErr.message}`);
  const runId = runRow.id;

  const counters = { triaged: 0, executed: 0, delegated: 0, errors: 0 };
  const details = [];

  try {
    await syncStewardDelegations(admin, { userId });

    for (const project of projects) {
      try {
        const projectResult = await runStewardForProject(admin, userId, project, runId, { tier: nightTier });
        counters.triaged += projectResult.triaged;
        counters.executed += projectResult.executed;
        counters.delegated += projectResult.delegated;
        details.push(projectResult);
      } catch (err) {
        counters.errors += 1;
        details.push({
          project_id: project.id,
          name: project.name,
          error: err?.message || String(err),
        });
      }
    }

    await admin
      .from('lykn_steward_runs')
      .update({
        status: 'completed',
        items_triaged: counters.triaged,
        items_executed: counters.executed,
        items_delegated: counters.delegated,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);

    return { run_id: runId, ...counters, details };
  } catch (err) {
    await admin
      .from('lykn_steward_runs')
      .update({
        status: 'failed',
        error_message: String(err?.message || err).slice(0, 500),
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);
    throw err;
  }
}

async function runStewardForProject(admin, userId, project, runId, { tier }) {
  await syncStewardDelegations(admin, { userId, projectId: project.id });

  const stateRows = await loadCurrentState(admin, userId, project.id);
  let triaged = 0;
  let executed = 0;
  let delegated = 0;

  const { data: backlog } = await admin
    .from('lykn_steward_items')
    .select('id, title')
    .eq('user_id', userId)
    .eq('project_id', project.id)
    .eq('status', 'backlog')
    .order('created_at', { ascending: true })
    .limit(MAX_TRIAGE_PER_PROJECT);

  for (const item of backlog || []) {
    const ok = await triageItem(admin, userId, project, item, stateRows, runId, { tier });
    if (ok) triaged += 1;
  }

  const { data: scheduled } = await admin
    .from('lykn_steward_items')
    .select(STEWARD_ITEM_FIELDS)
    .eq('user_id', userId)
    .eq('project_id', project.id)
    .eq('status', 'scheduled')
    .order('approved_at', { ascending: true })
    .limit(MAX_EXECUTE_PER_PROJECT);

  const progressLines = [];
  for (const item of scheduled || []) {
    const result = await executeScheduledItem(admin, userId, project, item, runId, { tier });
    if (result?.line) {
      progressLines.push(result.line);
      if (result.delegated) delegated += 1;
      else executed += 1;
    }
  }

  if (progressLines.length) {
    await pushProjectStateAdmin(admin, {
      userId,
      projectId: project.id,
      stateKey: OVERNIGHT_PROGRESS_STATE_KEY,
      stateValue: progressLines.join('\n\n'),
      reason: 'Night Shift completed scheduled queue items.',
    });
  }

  const stale = await loadStaleTodos(admin, userId, project.id, STALE_TODO_DAYS);
  if (stale.length) {
    const staleText = stale
      .map((t) => `- ${t.title} (untouched since ${t.updated_at?.slice(0, 10) || '?'})`)
      .join('\n');
    await pushProjectStateAdmin(admin, {
      userId,
      projectId: project.id,
      stateKey: STALE_TASKS_STATE_KEY,
      stateValue: `${stale.length} open task(s) untouched ${STALE_TODO_DAYS}+ days:\n${staleText}`,
      reason: 'Night Shift stale task scan.',
    });
  }

  return { project_id: project.id, name: project.name, triaged, executed, delegated };
}

async function triageItem(admin, userId, project, item, stateRows, runId, { tier }) {
  const useDelegateTriage = tier === 'delegate';
  const userMessage = buildTriageUserMessage({
    title: item.title,
    projectName: project.name,
    stateRows,
    delegateMode: useDelegateTriage,
  });
  const system = useDelegateTriage ? STEWARD_TRIAGE_DELEGATE_SYSTEM : STEWARD_TRIAGE_SYSTEM;
  const parsed = await callStewardModel(system, userMessage, useDelegateTriage ? 800 : 600);
  if (!parsed) return false;

  if (parsed.blocked) {
    await admin
      .from('lykn_steward_items')
      .update({
        status: 'blocked',
        blocked_reason: String(parsed.blocked_reason || 'Needs your input').slice(0, 500),
        run_id: runId,
      })
      .eq('id', item.id)
      .eq('user_id', userId);
    return true;
  }

  const spec = String(parsed.spec || '').trim().slice(0, 4000);
  if (!spec) return false;

  const patch = {
    status: 'ready',
    spec,
    run_id: runId,
    blocked_reason: null,
  };
  if (useDelegateTriage) {
    patch.execution_kind = parseExecutionKind(parsed.execution_kind);
    if (parsed.repo) patch.repo = String(parsed.repo).trim().slice(0, 500);
  }

  await admin
    .from('lykn_steward_items')
    .update(patch)
    .eq('id', item.id)
    .eq('user_id', userId);
  return true;
}

async function executeScheduledItem(admin, userId, project, item, runId, { tier }) {
  const kind = tier === 'delegate' ? parseExecutionKind(item.execution_kind) : 'research';

  if (kind === 'code' || kind === 'agent') {
    const line = await executeDelegateItem(admin, userId, project, item, runId, kind);
    if (!line) return null;
    return { line, delegated: true };
  }

  const line = await executeResearchItem(admin, userId, project, item, runId);
  return line ? { line, delegated: false } : null;
}

async function executeResearchItem(admin, userId, project, item, runId) {
  await admin
    .from('lykn_steward_items')
    .update({ status: 'running', run_id: runId })
    .eq('id', item.id)
    .eq('user_id', userId);

  const query = `${item.title} ${item.spec || ''}`.trim().slice(0, 200);
  const [vaultSnippets, webResult] = await Promise.all([
    searchVaultLite(admin, userId, query, 5),
    searchWeb(query, { num: 4, deepBrowse: false }),
  ]);
  const webSnippets = webResult?.ok ? (webResult.results || []).slice(0, 4) : [];

  const userMessage = buildResearchUserMessage({
    title: item.title,
    projectName: project.name,
    spec: item.spec,
    vaultSnippets,
    webSnippets,
  });

  const parsed = await callStewardModel(STEWARD_RESEARCH_SYSTEM, userMessage, 1200);
  if (!parsed) {
    await admin
      .from('lykn_steward_items')
      .update({
        status: 'blocked',
        blocked_reason: 'Night Shift could not parse research output.',
        run_id: runId,
      })
      .eq('id', item.id);
    return null;
  }

  if (parsed.blocked) {
    await admin
      .from('lykn_steward_items')
      .update({
        status: 'blocked',
        blocked_reason: String(parsed.blocked_reason || 'Blocked').slice(0, 500),
        run_id: runId,
      })
      .eq('id', item.id);
    return null;
  }

  const report = String(parsed.report || '').trim().slice(0, 4000);
  const subtasks = Array.isArray(parsed.subtasks)
    ? parsed.subtasks.map((s) => String(s || '').trim()).filter(Boolean).slice(0, MAX_SUBTASKS_PER_ITEM)
    : [];

  for (const st of subtasks) {
    try {
      await createTodoAdmin(admin, {
        userId,
        projectId: project.id,
        title: st,
        notes: `From Night Shift: ${item.title}`,
      });
    } catch {
      /* best-effort */
    }
  }

  const progress = String(parsed.progress_summary || report.slice(0, 200)).trim();
  await admin
    .from('lykn_steward_items')
    .update({
      status: 'done',
      result_summary: report || progress,
      completed_at: new Date().toISOString(),
      run_id: runId,
    })
    .eq('id', item.id);

  if (progress) {
    await pushProjectStateAdmin(admin, {
      userId,
      projectId: project.id,
      stateKey: 'progress_summary',
      stateValue: progress,
      reason: `Night Shift: ${item.title}`,
    });
  }

  return `**${item.title}** — ${progress || 'Done.'}`;
}

async function loadCurrentState(admin, userId, projectId) {
  const { data } = await admin
    .from('lykn_project_state')
    .select('state_key, state_value')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .is('superseded_at', null)
    .order('created_at', { ascending: false })
    .limit(30);
  const seen = new Set();
  const out = [];
  for (const row of data || []) {
    if (seen.has(row.state_key)) continue;
    seen.add(row.state_key);
    out.push(row);
  }
  return out;
}

async function callStewardModel(system, userMessage, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: STEWARD_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`anthropic HTTP ${resp.status}: ${errText.slice(0, 160)}`);
  }
  const body = await resp.json();
  const text = body?.content?.[0]?.text || '';
  return parseStewardJson(text);
}

/** Load steward queue summary for morning brief context. */
export async function loadStewardSummaryForBrief(admin, userId, projectId) {
  const { data } = await admin
    .from('lykn_steward_items')
    .select('title, status, result_summary, execution_kind, blocked_reason')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .in('status', ['ready', 'scheduled', 'running', 'done', 'blocked'])
    .order('updated_at', { ascending: false })
    .limit(12);
  return data || [];
}
