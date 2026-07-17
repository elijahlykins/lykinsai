// usageTracking.js — Session management and AI cost tracking
import fetch from 'node-fetch';

// Read env vars lazily (dotenv runs after imports in server.js)
const getSupabaseUrl = () => process.env.VITE_SUPABASE_URL;
const getServiceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Coalesce bursty chat telemetry into one RPC per session (migration 072).
const SESSION_TOTALS_DEBOUNCE_MS = 2500;

/** @type {Map<string, { cost: number, tokens: number, credits: number, timer: ReturnType<typeof setTimeout> | null, flushing: boolean }>} */
const sessionPendingUpdates = new Map();

// ─── Supabase Admin Helpers ──────────────────────────────────────────────────

function adminHeaders() {
  const key = getServiceRoleKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

async function supabaseAdmin(method, table, { query = '', body } = {}) {
  if (!getSupabaseUrl() || !getServiceRoleKey()) {
    console.warn('[UsageTracking] Supabase not configured, skipping DB operation');
    return null;
  }
  const url = `${getSupabaseUrl()}/rest/v1/${table}${query ? `?${query}` : ''}`;
  const opts = { method, headers: adminHeaders() };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`[UsageTracking] ${method} ${table} failed (${res.status}):`, err);
      return null;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.error(`[UsageTracking] ${method} ${table} error:`, e.message);
    return null;
  }
}

// ─── Model Pricing (USD per 1K tokens) ──────────────────────────────────────

const MODEL_PRICING = {
  // OpenAI
  // GPT-5.6 family (GA July 9, 2026): Sol $5/$30, Terra $2.50/$15, Luna $1/$6 per M.
  'gpt-5.6-sol':       { input: 0.005,  output: 0.030 },
  'gpt-5.6-terra':     { input: 0.0025, output: 0.015 },
  'gpt-5.6-luna':      { input: 0.001,  output: 0.006 },
  'gpt-5.5':           { input: 0.005,  output: 0.015 },
  'gpt-5.4':           { input: 0.005,  output: 0.015 },
  'gpt-5.4-pro':       { input: 0.010,  output: 0.030 },
  'gpt-5.2':           { input: 0.004,  output: 0.012 },
  'gpt-5.1':           { input: 0.003,  output: 0.010 },
  'gpt-5':             { input: 0.003,  output: 0.010 },
  'gpt-5-mini':        { input: 0.001,  output: 0.004 },
  'gpt-4.1':           { input: 0.002,  output: 0.008 },
  'gpt-4.1-mini':      { input: 0.0004, output: 0.0016 },
  'gpt-4.1-nano':      { input: 0.0001, output: 0.0004 },
  'gpt-4o':            { input: 0.0025, output: 0.010 },
  'gpt-4o-mini':       { input: 0.00015,output: 0.0006 },
  'gpt-5.3-code':      { input: 0.004,  output: 0.012 },
  'o3':                { input: 0.010,  output: 0.040 },
  'o3-pro':            { input: 0.020,  output: 0.080 },
  'o4-mini':           { input: 0.0011, output: 0.0044 },

  // Anthropic
  'claude-sonnet-4-6':            { input: 0.003, output: 0.015 },
  'claude-opus-4-20250514':       { input: 0.015, output: 0.075 },
  'claude-opus-4-8':              { input: 0.005, output: 0.025 },
  'claude-opus-4-7':              { input: 0.005, output: 0.025 },
  'claude-sonnet-4-20250514':     { input: 0.003, output: 0.015 },
  'claude-3-5-haiku-20241022':    { input: 0.0008, output: 0.004 },
  'claude-3-5-sonnet-20241022':   { input: 0.003, output: 0.015 },

  // Google Gemini
  'gemini-3.1-pro-preview':  { input: 0.00125, output: 0.005 },
  'gemini-3-flash-preview':  { input: 0.00015, output: 0.0006 },
  'gemini-2.5-pro-preview-05-06': { input: 0.00125, output: 0.01 },
  'gemini-2.5-flash-preview-05-20': { input: 0.00015, output: 0.0006 },
  'gemini-2.0-flash':        { input: 0.0001, output: 0.0004 },
  'gemini-flash-latest':     { input: 0.0001, output: 0.0004 },

  // xAI / Grok
  'grok-4.5':   { input: 0.002, output: 0.006 },
  'grok-4.3':   { input: 0.00125, output: 0.0025 },
  'grok-4.1':   { input: 0.003, output: 0.015 },
  'grok-4':     { input: 0.003, output: 0.015 },
  'grok-3':     { input: 0.003, output: 0.015 },
  'grok-3-mini':{ input: 0.0005, output: 0.002 },

  // Whisper (cost per second of audio, stored as "input")
  'whisper-1': { input: 0.0001, output: 0 },

  // TTS (cost per 1K characters, stored as "input")
  'tts-1': { input: 0.015, output: 0 },
  'tts-1-hd': { input: 0.030, output: 0 },

  // OpenAI Embeddings (output cost is always 0, only input tokens billed)
  'text-embedding-3-small': { input: 0.00002, output: 0 },
  'text-embedding-3-large': { input: 0.00013, output: 0 },
  'text-embedding-ada-002': { input: 0.0001,  output: 0 },
};

// Fixed costs for non-token-based actions (in USD)
const FIXED_COSTS = {
  image_gen_grok:    0.04,
  image_gen_dalle:   0.04,
  image_gen_openai:  0.05, // GPT Image 2, default quality 1024px
  image_gen_google:  0.039,
  video_gen_grok:    0.10,
  image_edit_gemini: 0.02,
};

// ─── Credit Costs by Action Type ─────────────────────────────────────────────

const CREDIT_COSTS = {
  chat_short:           1,
  chat_long:            2,
  chat_complex:         3,
  board_analysis_light: 3,
  board_analysis_deep:  5,
  file_small:           5,
  file_large:           15,
  image_analysis:       7,
  image_gen:            15,
  image_edit:           10,
  video:                35,
  transcription:        5,
  tts:                  3,
  // Internal / system actions (no end-user credit charge but tracked for admin)
  guest_chat:           0,
  embedding_retrieval:  0,
  embedding_reindex:    0,
  intake_profile:       0,
  profile_refresh:      0,
  fact_extraction:      0,
  youtube_transcribe:   0,
  vault_search:         1,
  vault_enrich:         2,
  describe_image:       2,
  describe_text:        1,
  summarize_conversation: 1,
  name_grid:            0,
  name_chat:            0,
  discover_takeaway:    0,
};

// ─── Cost Calculation ────────────────────────────────────────────────────────

function calculateCost(model, inputTokens, outputTokens) {
  const pricing = findPricing(model);
  if (!pricing) return 0;
  return (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
}

function findPricing(model) {
  if (!model) return null;
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const lower = model.toLowerCase();
  for (const [key, val] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  // Fallback: moderate pricing assumption
  return { input: 0.002, output: 0.008 };
}

function getFixedCost(actionType, provider) {
  const key = `${actionType}_${provider}`;
  return FIXED_COSTS[key] || FIXED_COSTS[actionType] || 0;
}

function classifyActionType(endpoint, { promptLength = 0, responseLength = 0, hasImages = false, intent } = {}) {
  if (endpoint === 'image') return 'image_gen';
  if (endpoint === 'video') return 'video';
  if (endpoint === 'image-edit') return 'image_edit';
  if (endpoint === 'transcribe') return 'transcription';
  if (endpoint === 'tts') return 'tts';

  if (hasImages) return 'image_analysis';

  if (intent === 'board_analysis' || intent === 'analyze') {
    return promptLength > 4000 ? 'board_analysis_deep' : 'board_analysis_light';
  }

  if (intent === 'file' || intent === 'document') {
    return promptLength > 8000 ? 'file_large' : 'file_small';
  }

  // Text chat classification by response size
  if (responseLength > 3000) return 'chat_complex';
  if (responseLength > 1000) return 'chat_long';
  return 'chat_short';
}

function getCreditCost(actionType) {
  return CREDIT_COSTS[actionType] || 1;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// ─── Session Management ──────────────────────────────────────────────────────

async function getOrCreateSession(userId, chatId) {
  if (!userId) return null;

  const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();

  // Look for active session (same user + board, not ended, active within 30 min)
  let query = `user_id=eq.${userId}&ended_at=is.null&last_activity_at=gte.${cutoff}&order=last_activity_at.desc&limit=1`;
  if (chatId) query += `&chat_id=eq.${chatId}`;

  const existing = await supabaseAdmin('GET', 'usage_sessions', { query });

  if (existing && existing.length > 0) {
    return existing[0];
  }

  // Create new session
  const newSession = { user_id: userId };
  if (chatId) newSession.chat_id = chatId;

  const created = await supabaseAdmin('POST', 'usage_sessions', { body: newSession });
  return created?.[0] || null;
}

async function updateSessionTotalsLegacy(sessionId, { cost, tokens, credits }) {
  if (!sessionId) return;

  // Pre-072 fallback: read current totals then PATCH (two round trips).
  const rows = await supabaseAdmin('GET', 'usage_sessions', {
    query: `id=eq.${sessionId}&select=total_cost,total_tokens,total_credits`,
  });
  if (!rows || !rows[0]) return;

  const current = rows[0];
  await supabaseAdmin('PATCH', 'usage_sessions', {
    query: `id=eq.${sessionId}`,
    body: {
      total_cost: parseFloat(current.total_cost || 0) + (cost || 0),
      total_tokens: (current.total_tokens || 0) + (tokens || 0),
      total_credits: (current.total_credits || 0) + (credits || 0),
      last_activity_at: new Date().toISOString(),
    },
  });
}

async function flushSessionTotalsUpdate(sessionId) {
  const pending = sessionPendingUpdates.get(sessionId);
  if (!pending || pending.flushing) return;

  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }

  const payload = {
    cost: pending.cost,
    tokens: pending.tokens,
    credits: pending.credits,
  };
  // Drop before the async RPC so concurrent logAiUsage calls accumulate
  // in a fresh pending bucket instead of racing this flush.
  sessionPendingUpdates.delete(sessionId);
  pending.flushing = true;

  try {
    await callRpc('increment_session_totals', {
      p_session_id: sessionId,
      p_cost_delta: payload.cost,
      p_tokens_delta: payload.tokens,
      p_credits_delta: payload.credits,
    });
  } catch (e) {
    if (e.code === 'rpc_missing') {
      await updateSessionTotalsLegacy(sessionId, payload);
    } else {
      console.warn('[UsageTracking] increment_session_totals failed:', e?.message || e);
    }
  } finally {
    pending.flushing = false;
  }
}

function scheduleSessionTotalsUpdate(sessionId, { cost = 0, tokens = 0, credits = 0 } = {}) {
  if (!sessionId) return;

  let pending = sessionPendingUpdates.get(sessionId);
  if (!pending) {
    pending = { cost: 0, tokens: 0, credits: 0, timer: null, flushing: false };
    sessionPendingUpdates.set(sessionId, pending);
  }

  pending.cost += cost || 0;
  pending.tokens += tokens || 0;
  pending.credits += credits || 0;

  if (pending.timer || pending.flushing) return;

  pending.timer = setTimeout(() => {
    pending.timer = null;
    void flushSessionTotalsUpdate(sessionId);
  }, SESSION_TOTALS_DEBOUNCE_MS);
}

function updateSessionActivity(sessionId) {
  scheduleSessionTotalsUpdate(sessionId, { cost: 0, tokens: 0, credits: 0 });
}

function updateSessionTotals(sessionId, { cost, tokens, credits }) {
  scheduleSessionTotalsUpdate(sessionId, { cost, tokens, credits });
}

// ─── AI Usage Logging ────────────────────────────────────────────────────────

async function logAiUsage({
  sessionId,
  userId,
  guestSessionId = null,
  actionType,
  model,
  provider,
  inputTokens = 0,
  outputTokens = 0,
  metadata = null,
}) {
  // Allow guest rows (no userId) as long as we have a guestSessionId so they
  // still aggregate in the admin dashboard. Authenticated rows must have userId.
  if (!userId && !guestSessionId) return;

  const totalTokens = inputTokens + outputTokens;
  const costUsd = (actionType === 'image_gen' || actionType === 'video' || actionType === 'image_edit')
    ? getFixedCost(actionType, provider)
    : calculateCost(model, inputTokens, outputTokens);
  const creditsUsed = getCreditCost(actionType);

  const row = {
    user_id: userId || null,
    action_type: actionType,
    model: model || 'unknown',
    provider: provider || 'unknown',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    credits_used: creditsUsed,
    metadata: metadata || null,
  };
  if (sessionId) row.session_id = sessionId;
  if (guestSessionId) row.guest_session_id = String(guestSessionId).slice(0, 200);

  const inserted = await supabaseAdmin('POST', 'ai_usage_logs', { body: row });

  // Update session totals in the background (only for logged-in users with sessions)
  if (sessionId) {
    try {
      updateSessionTotals(sessionId, {
        cost: costUsd,
        tokens: totalTokens,
        credits: creditsUsed,
      });
    } catch {
      /* ignore */
    }
  }

  const who = userId ? `uid=${String(userId).slice(0, 8)}` : `guest=${String(guestSessionId || '').slice(0, 8)}`;
  console.log(`[Usage] ${who} | ${actionType} | ${model} | ${totalTokens} tokens | $${costUsd.toFixed(4)} | ${creditsUsed} credits`);
  return inserted?.[0] || null;
}

// ─── Session Cleanup (background) ────────────────────────────────────────────

let cleanupTimer = null;

async function endExpiredSessions() {
  const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
  await supabaseAdmin('PATCH', 'usage_sessions', {
    query: `ended_at=is.null&last_activity_at=lt.${cutoff}`,
    body: { ended_at: new Date().toISOString() },
  });
}

function startSessionCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    endExpiredSessions().catch((e) => console.error('[UsageTracking] Cleanup error:', e.message));
  }, CLEANUP_INTERVAL_MS);
  console.log('[UsageTracking] Session cleanup started (every 5 min)');
}

function stopSessionCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ─── Usage Query Helpers ─────────────────────────────────────────────────────

async function getUserMonthlyUsage(userId) {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const logs = await supabaseAdmin('GET', 'ai_usage_logs', {
    query: `user_id=eq.${userId}&created_at=gte.${firstOfMonth}&select=action_type,total_tokens,cost_usd,credits_used`,
  });

  if (!logs || !logs.length) {
    return { total_tokens: 0, total_cost: 0, total_credits: 0, action_breakdown: {}, log_count: 0 };
  }

  let totalTokens = 0, totalCost = 0, totalCredits = 0;
  const breakdown = {};

  for (const log of logs) {
    totalTokens += log.total_tokens || 0;
    totalCost += parseFloat(log.cost_usd) || 0;
    totalCredits += log.credits_used || 0;
    const t = log.action_type || 'unknown';
    if (!breakdown[t]) breakdown[t] = { count: 0, tokens: 0, cost: 0, credits: 0 };
    breakdown[t].count++;
    breakdown[t].tokens += log.total_tokens || 0;
    breakdown[t].cost += parseFloat(log.cost_usd) || 0;
    breakdown[t].credits += log.credits_used || 0;
  }

  return {
    total_tokens: totalTokens,
    total_cost: parseFloat(totalCost.toFixed(4)),
    total_credits: totalCredits,
    action_breakdown: breakdown,
    log_count: logs.length,
  };
}

async function getUserSessions(userId, limit = 20) {
  const sessions = await supabaseAdmin('GET', 'usage_sessions', {
    query: `user_id=eq.${userId}&order=started_at.desc&limit=${limit}&select=id,chat_id,started_at,last_activity_at,ended_at,total_cost,total_tokens,total_credits`,
  });
  return sessions || [];
}

async function getSessionWithLogs(sessionId, userId) {
  const sessions = await supabaseAdmin('GET', 'usage_sessions', {
    query: `id=eq.${sessionId}&user_id=eq.${userId}`,
  });
  if (!sessions || !sessions.length) return null;

  const logs = await supabaseAdmin('GET', 'ai_usage_logs', {
    query: `session_id=eq.${sessionId}&order=created_at.asc&select=*`,
  });

  return { session: sessions[0], logs: logs || [] };
}

// ─── Provider Detection ──────────────────────────────────────────────────────

function detectProvider(model) {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('gpt') || m.includes('o3') || m.includes('o4') || m === 'dall-e-3') return 'openai';
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gemini')) return 'google';
  if (m.includes('grok')) return 'xai';
  if (m.includes('whisper')) return 'openai';
  if (m.includes('tts')) return 'openai';
  return 'unknown';
}

// ─── Extract Usage from Provider Responses ───────────────────────────────────

function extractOpenAIUsage(data) {
  if (!data) return { input_tokens: 0, output_tokens: 0 };
  const u = data.usage;
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || u.input_tokens || 0,
    output_tokens: u.completion_tokens || u.output_tokens || 0,
  };
}

function extractAnthropicUsage(data) {
  if (!data?.usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: data.usage.input_tokens || 0,
    output_tokens: data.usage.output_tokens || 0,
  };
}

function extractGeminiUsage(data) {
  const meta = data?.usageMetadata;
  if (!meta) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: meta.promptTokenCount || 0,
    output_tokens: meta.candidatesTokenCount || 0,
  };
}

function extractGrokUsage(data) {
  return extractOpenAIUsage(data); // Same format as OpenAI
}

// ─── Admin Dashboard Queries (service-role, cross-user) ──────────────────────
// All four helpers proxy to SECURITY DEFINER RPCs defined in
// supabase-migrations/040_admin_usage_rpcs.sql so they can join ai_usage_logs
// to auth.users without exposing auth.users via PostgREST.

async function callRpc(fnName, args) {
  if (!getSupabaseUrl() || !getServiceRoleKey()) {
    const msg = `[UsageTracking] Supabase not configured (missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY) — cannot call RPC ${fnName}`;
    console.warn(msg);
    const err = new Error('Service role not configured on server (set SUPABASE_SERVICE_ROLE_KEY).');
    err.code = 'no_service_role';
    throw err;
  }
  const url = `${getSupabaseUrl()}/rest/v1/rpc/${fnName}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(args || {}),
    });
  } catch (e) {
    console.error(`[UsageTracking] RPC ${fnName} fetch error:`, e?.message || e);
    const err = new Error(`Network error calling RPC ${fnName}: ${e?.message || e}`);
    err.code = 'rpc_network';
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[UsageTracking] RPC ${fnName} failed (${res.status}):`, body);
    // 404 on PostgREST RPC almost always means the function doesn't exist —
    // i.e. the migration wasn't applied. Make that loud.
    if (res.status === 404) {
      const err = new Error(`Database function "${fnName}" not found. Apply the latest migrations in supabase-migrations/ to your Supabase project.`);
      err.code = 'rpc_missing';
      err.status = 404;
      throw err;
    }
    const err = new Error(`RPC ${fnName} failed (${res.status}): ${body.slice(0, 240)}`);
    err.code = 'rpc_error';
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function rangeStartFromKey(rangeKey) {
  const now = new Date();
  switch (String(rangeKey || '30d')) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    case '90d':
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    case 'mtd':
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    case 'ytd':
      return new Date(now.getFullYear(), 0, 1).toISOString();
    case 'all':
      return new Date(2000, 0, 1).toISOString();
    default:
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
}

async function getAdminOverview(rangeKey = '30d') {
  const since = rangeStartFromKey(rangeKey);
  const result = await callRpc('admin_usage_overview', { p_since: since });
  return result || { totals: null, today: null, all_time: null, by_action: [], by_provider: [], by_model: [], daily: [] };
}

async function getAdminUsersList(rangeKey = 'mtd') {
  const since = rangeStartFromKey(rangeKey);
  const rows = await callRpc('admin_users_with_usage', { p_since: since });
  return Array.isArray(rows) ? rows : [];
}

async function getAdminUserDrilldown(userId, rangeKey = '30d') {
  if (!userId) return null;
  const since = rangeStartFromKey(rangeKey);
  return await callRpc('admin_user_drilldown', { p_user: userId, p_since: since });
}

async function getAdminRecentActivity(limit = 50) {
  const safe = Math.max(1, Math.min(Number(limit) || 50, 500));
  const rows = await callRpc('admin_recent_activity', { p_limit: safe });
  return Array.isArray(rows) ? rows : [];
}

// Probe each admin RPC by calling it with a trivial argument and reporting
// success / 404 (= migration not applied) / other error.
async function probeRpc(fnName, args) {
  if (!getSupabaseUrl() || !getServiceRoleKey()) {
    return { ok: false, reason: 'no_service_role' };
  }
  try {
    const res = await fetch(`${getSupabaseUrl()}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(args || {}),
    });
    if (res.ok) return { ok: true };
    if (res.status === 404) return { ok: false, reason: 'missing', status: 404 };
    const body = await res.text().catch(() => '');
    return { ok: false, reason: 'error', status: res.status, message: body.slice(0, 200) };
  } catch (e) {
    return { ok: false, reason: 'network', message: String(e?.message || e).slice(0, 200) };
  }
}

async function getAdminDiagnostics() {
  const serviceRoleConfigured = Boolean(getSupabaseUrl() && getServiceRoleKey());

  // Raw row checks via plain PostgREST against ai_usage_logs. These bypass
  // the new admin_* RPCs so we can tell whether the issue is "no logs at all"
  // vs "logs exist but RPCs are missing".
  const out = {
    service_role_configured: serviceRoleConfigured,
    supabase_url: getSupabaseUrl() || null,
    table_reachable: false,
    table_error: null,
    total_rows: null,
    rows_last_hour: null,
    rows_today: null,
    latest_row: null,
    rpcs: {
      admin_usage_overview: { ok: false, reason: 'untested' },
      admin_users_with_usage: { ok: false, reason: 'untested' },
      admin_recent_activity: { ok: false, reason: 'untested' },
      admin_usage_live: { ok: false, reason: 'untested' },
    },
  };

  if (!serviceRoleConfigured) return out;

  // 1. Try a HEAD with Prefer: count=exact to get total rows cheaply.
  try {
    const url = `${getSupabaseUrl()}/rest/v1/ai_usage_logs?select=id`;
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { ...adminHeaders(), Prefer: 'count=exact', Range: '0-0' },
    });
    if (res.ok) {
      out.table_reachable = true;
      const cr = res.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+|\*)$/);
      if (m && m[1] !== '*') out.total_rows = Number(m[1]);
    } else {
      out.table_error = `HEAD ai_usage_logs ${res.status}`;
    }
  } catch (e) {
    out.table_error = String(e?.message || e).slice(0, 240);
  }

  // 2. Latest row (one round-trip).
  try {
    const url = `${getSupabaseUrl()}/rest/v1/ai_usage_logs?select=id,created_at,action_type,model,user_id,cost_usd&order=created_at.desc&limit=1`;
    const res = await fetch(url, { headers: adminHeaders() });
    if (res.ok) {
      const rows = await res.json().catch(() => []);
      if (Array.isArray(rows) && rows[0]) out.latest_row = rows[0];
    }
  } catch { /* tolerate */ }

  // 3. Rows in last hour and today (counts only).
  try {
    const sinceHour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const url = `${getSupabaseUrl()}/rest/v1/ai_usage_logs?select=id&created_at=gte.${encodeURIComponent(sinceHour)}`;
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { ...adminHeaders(), Prefer: 'count=exact', Range: '0-0' },
    });
    if (res.ok) {
      const cr = res.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+|\*)$/);
      if (m && m[1] !== '*') out.rows_last_hour = Number(m[1]);
    }
  } catch { /* tolerate */ }

  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const url = `${getSupabaseUrl()}/rest/v1/ai_usage_logs?select=id&created_at=gte.${encodeURIComponent(startOfDay.toISOString())}`;
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { ...adminHeaders(), Prefer: 'count=exact', Range: '0-0' },
    });
    if (res.ok) {
      const cr = res.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+|\*)$/);
      if (m && m[1] !== '*') out.rows_today = Number(m[1]);
    }
  } catch { /* tolerate */ }

  // 4. Probe each RPC. These reveal whether migrations 040 / 042 ran.
  const sinceProbe = new Date(Date.now() - 60_000).toISOString();
  const fakeUuid = '00000000-0000-0000-0000-000000000000';
  const [overviewProbe, usersProbe, recentProbe, liveProbe] = await Promise.all([
    probeRpc('admin_usage_overview', { p_since: sinceProbe }),
    probeRpc('admin_users_with_usage', { p_since: sinceProbe }),
    probeRpc('admin_recent_activity', { p_limit: 1 }),
    probeRpc('admin_usage_live', { p_minutes: 1 }),
  ]);
  out.rpcs.admin_usage_overview = overviewProbe;
  out.rpcs.admin_users_with_usage = usersProbe;
  out.rpcs.admin_recent_activity = recentProbe;
  out.rpcs.admin_usage_live = liveProbe;
  // Also probe drilldown (uses uuid arg type — different signature).
  out.rpcs.admin_user_drilldown = await probeRpc('admin_user_drilldown', { p_user: fakeUuid, p_since: sinceProbe });

  return out;
}

async function getAdminLiveActivity(minutes = 60) {
  const safe = Math.max(1, Math.min(Number(minutes) || 60, 360));
  const result = await callRpc('admin_usage_live', { p_minutes: safe });
  return result || {
    minutes: safe,
    since: new Date(Date.now() - safe * 60_000).toISOString(),
    now: new Date().toISOString(),
    totals: null,
    per_minute: [],
    by_action: [],
    top_users: [],
    recent: [],
  };
}

export {
  getOrCreateSession,
  updateSessionActivity,
  logAiUsage,
  classifyActionType,
  estimateTokens,
  detectProvider,
  extractOpenAIUsage,
  extractAnthropicUsage,
  extractGeminiUsage,
  extractGrokUsage,
  calculateCost,
  getCreditCost,
  getUserMonthlyUsage,
  getUserSessions,
  getSessionWithLogs,
  startSessionCleanup,
  stopSessionCleanup,
  getAdminOverview,
  getAdminUsersList,
  getAdminUserDrilldown,
  getAdminRecentActivity,
  getAdminLiveActivity,
  getAdminDiagnostics,
  rangeStartFromKey,
  MODEL_PRICING,
  CREDIT_COSTS,
};
