// =====================================================================
// jobs/nightBriefJob.js — Night Shift morning brief (Phase 0)
// =====================================================================
// For each opted-in user, synthesize a `morning_brief` project-state push
// per active project. Read-only on beliefs/facts; writes only morning_brief.

import { createClient } from '@supabase/supabase-js';
import {
  buildNightBriefUserMessage,
  NIGHT_BRIEF_SYSTEM,
} from '../lib/nightShift/nightBriefPrompt.js';
import {
  MORNING_BRIEF_STATE_KEY,
  pushProjectStateAdmin,
} from '../lib/nightShift/pushProjectStateAdmin.js';
import {
  loadStewardSummaryForBrief,
  runStewardPhaseForUser,
} from '../lib/nightShift/stewardPhase.js';
import { parseNightShiftTier } from '../lib/nightShift/stewardTier.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const BRIEF_MODEL = process.env.NIGHT_SHIFT_MODEL || 'claude-sonnet-4-20250514';
const BRIEF_MAX_TOKENS = 700;
const PROJECT_ACTIVITY_DAYS = 30;
const RECENT_PUSH_HOURS = 24;
const UPCOMING_EVENT_DAYS = 7;
const MAX_PROJECTS_PER_USER = 8;

function buildAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('nightBriefJob: missing SUPABASE_URL / SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function runNightBriefForAllUsers({ trigger = 'cron' } = {}) {
  const admin = buildAdminClient();
  const userIds = await loadEligibleUserIds(admin);
  console.log(`🌙 nightBriefJob: ${userIds.length} opted-in users (trigger=${trigger})`);

  const summaries = [];
  for (const entry of userIds) {
    const uid = entry.userId || entry;
    const tier = entry.tier || 'brief';
    try {
      const summary = await runNightBriefForUser(admin, uid, { trigger, tier });
      summaries.push({ user_id: uid, tier, ...summary });
    } catch (err) {
      console.error(`❌ nightBriefJob[${uid}]:`, err?.stack || err?.message || err);
      summaries.push({ user_id: uid, tier, error: err?.message || String(err) });
    }
  }
  return summaries;
}

async function loadEligibleUserIds(admin) {
  const { data, error } = await admin
    .from('lykn_user_preferences')
    .select('user_id, memory_paused, night_shift_enabled, night_shift_tier')
    .eq('night_shift_enabled', true)
    .eq('memory_paused', false);
  if (error) throw error;
  return (data || []).map((r) => ({
    userId: r.user_id,
    tier: parseNightShiftTier(r.night_shift_tier),
  })).filter((r) => r.userId);
}

export async function runNightBriefForUser(admin, userId, { trigger = 'cron', tier = 'brief' } = {}) {
  const startedAt = Date.now();
  const counters = {
    projects_considered: 0,
    projects_briefed: 0,
    projects_skipped: 0,
    steward_triaged: 0,
    steward_executed: 0,
    steward_delegated: 0,
    error_count: 0,
  };
  const details = { projects: [], trigger, tier };

  const projects = await loadActiveProjects(admin, userId);
  counters.projects_considered = projects.length;

  if ((tier === 'research' || tier === 'delegate') && projects.length) {
    try {
      const steward = await runStewardPhaseForUser(admin, userId, projects, { trigger, tier });
      counters.steward_triaged = steward.triaged || 0;
      counters.steward_executed = steward.executed || 0;
      counters.steward_delegated = steward.delegated || 0;
      details.steward = steward;
    } catch (err) {
      counters.error_count += 1;
      details.steward_error = err?.message || String(err);
      console.warn(`⚠️ nightBriefJob steward[${userId}]:`, err?.message || err);
    }
  }

  for (const project of projects.slice(0, MAX_PROJECTS_PER_USER)) {
    try {
      const result = await briefOneProject(admin, userId, project);
      details.projects.push(result);
      if (result.skipped) counters.projects_skipped += 1;
      else counters.projects_briefed += 1;
    } catch (err) {
      counters.error_count += 1;
      details.projects.push({
        project_id: project.id,
        name: project.name,
        error: err?.message || String(err),
      });
    }
  }

  return {
    ...counters,
    elapsed_ms: Date.now() - startedAt,
    details,
  };
}

async function loadActiveProjects(admin, userId) {
  const cutoff = new Date(Date.now() - PROJECT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('lykn_projects')
    .select('id, name, description, last_active_at, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .gte('last_active_at', cutoff)
    .order('last_active_at', { ascending: false })
    .limit(MAX_PROJECTS_PER_USER + 4);
  if (error) throw error;

  const projects = data || [];
  if (projects.length) return projects.slice(0, MAX_PROJECTS_PER_USER);

  // Fallback: projects with open todos even if dormant on last_active_at.
  const { data: todoRows } = await admin
    .from('lykn_todos')
    .select('project_id')
    .eq('user_id', userId)
    .eq('status', 'open')
    .not('project_id', 'is', null)
    .limit(40);
  const todoProjectIds = [...new Set((todoRows || []).map((r) => r.project_id).filter(Boolean))];
  if (!todoProjectIds.length) return [];

  const { data: fallback, error: fbErr } = await admin
    .from('lykn_projects')
    .select('id, name, description, last_active_at, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('id', todoProjectIds)
    .order('last_active_at', { ascending: false })
    .limit(MAX_PROJECTS_PER_USER);
  if (fbErr) throw fbErr;
  return fallback || [];
}

async function briefOneProject(admin, userId, project) {
  const [stateRows, todos, upcomingEvents, recentPushes, stewardItems] = await Promise.all([
    loadCurrentState(admin, userId, project.id),
    loadOpenTodos(admin, userId, project.id),
    loadUpcomingEvents(admin, userId, project.id),
    loadRecentPushes(admin, userId, project.id),
    loadStewardSummaryForBrief(admin, userId, project.id),
  ]);

  const hasSignal =
    stateRows.some((r) => r.state_key !== MORNING_BRIEF_STATE_KEY) ||
    todos.length > 0 ||
    upcomingEvents.length > 0 ||
    recentPushes.length > 0;

  if (!hasSignal) {
    return {
      project_id: project.id,
      name: project.name,
      skipped: true,
      reason: 'no_project_signal',
    };
  }

  const userMessage = buildNightBriefUserMessage({
    projectName: project.name,
    projectDescription: project.description,
    stateRows,
    todos,
    upcomingEvents,
    recentPushes,
    stewardItems,
  });

  const briefText = await callBriefModel(userMessage);
  await pushProjectStateAdmin(admin, {
    userId,
    projectId: project.id,
    stateKey: MORNING_BRIEF_STATE_KEY,
    stateValue: briefText,
    setByClient: 'night-shift',
    reason: 'Overnight project steward morning handoff.',
  });

  return {
    project_id: project.id,
    name: project.name,
    skipped: false,
    chars: briefText.length,
  };
}

async function loadCurrentState(admin, userId, projectId) {
  const { data, error } = await admin
    .from('lykn_project_state')
    .select('state_key, state_value, set_by_client, created_at')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .is('superseded_at', null)
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) throw error;

  const seen = new Set();
  const out = [];
  for (const row of data || []) {
    if (seen.has(row.state_key)) continue;
    seen.add(row.state_key);
    out.push(row);
  }
  return out;
}

async function loadOpenTodos(admin, userId, projectId) {
  const { data, error } = await admin
    .from('lykn_todos')
    .select('title, status, priority, due_at, updated_at')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .eq('status', 'open')
    .order('priority', { ascending: false })
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(20);
  if (error) throw error;
  return data || [];
}

async function loadUpcomingEvents(admin, userId, projectId) {
  const now = new Date().toISOString();
  const horizon = new Date(Date.now() + UPCOMING_EVENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('lykn_events')
    .select('title, start_at, end_at')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .gte('start_at', now)
    .lte('start_at', horizon)
    .order('start_at', { ascending: true })
    .limit(10);
  if (error) throw error;
  return data || [];
}

async function loadRecentPushes(admin, userId, projectId) {
  const since = new Date(Date.now() - RECENT_PUSH_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('lykn_project_state')
    .select('state_key, state_value, created_at')
    .eq('user_id', userId)
    .eq('project_id', projectId)
    .gte('created_at', since)
    .neq('state_key', MORNING_BRIEF_STATE_KEY)
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) throw error;
  return data || [];
}

async function callBriefModel(userMessage) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: BRIEF_MODEL,
      max_tokens: BRIEF_MAX_TOKENS,
      system: NIGHT_BRIEF_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`anthropic HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const body = await resp.json();
  const text = String(body?.content?.[0]?.text || '').trim();
  if (!text) throw new Error('empty brief from model');
  return text.slice(0, 2000);
}
