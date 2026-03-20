// usageTracking.js — Session management and AI cost tracking
import fetch from 'node-fetch';

// Read env vars lazily (dotenv runs after imports in server.js)
const getSupabaseUrl = () => process.env.VITE_SUPABASE_URL;
const getServiceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
  'claude-opus-4-20250514':       { input: 0.015, output: 0.075 },
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
  'grok-4.1':   { input: 0.003, output: 0.015 },
  'grok-4':     { input: 0.003, output: 0.015 },
  'grok-3':     { input: 0.003, output: 0.015 },
  'grok-3-mini':{ input: 0.0005, output: 0.002 },

  // Whisper (cost per second of audio, stored as "input")
  'whisper-1': { input: 0.0001, output: 0 },

  // TTS (cost per 1K characters, stored as "input")
  'tts-1': { input: 0.015, output: 0 },
  'tts-1-hd': { input: 0.030, output: 0 },
};

// Fixed costs for non-token-based actions (in USD)
const FIXED_COSTS = {
  image_gen_grok:    0.04,
  image_gen_dalle:   0.04,
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

async function getOrCreateSession(userId, boardId) {
  if (!userId) return null;

  const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();

  // Look for active session (same user + board, not ended, active within 30 min)
  let query = `user_id=eq.${userId}&ended_at=is.null&last_activity_at=gte.${cutoff}&order=last_activity_at.desc&limit=1`;
  if (boardId) query += `&board_id=eq.${boardId}`;

  const existing = await supabaseAdmin('GET', 'sessions', { query });

  if (existing && existing.length > 0) {
    return existing[0];
  }

  // Create new session
  const newSession = { user_id: userId };
  if (boardId) newSession.board_id = boardId;

  const created = await supabaseAdmin('POST', 'sessions', { body: newSession });
  return created?.[0] || null;
}

async function updateSessionActivity(sessionId) {
  if (!sessionId) return;
  await supabaseAdmin('PATCH', 'sessions', {
    query: `id=eq.${sessionId}`,
    body: { last_activity_at: new Date().toISOString() },
  });
}

async function updateSessionTotals(sessionId, { cost, tokens, credits }) {
  if (!sessionId) return;

  // Read current totals then increment (Supabase REST doesn't support atomic increment)
  const rows = await supabaseAdmin('GET', 'sessions', {
    query: `id=eq.${sessionId}&select=total_cost,total_tokens,total_credits`,
  });
  if (!rows || !rows[0]) return;

  const current = rows[0];
  await supabaseAdmin('PATCH', 'sessions', {
    query: `id=eq.${sessionId}`,
    body: {
      total_cost: parseFloat(current.total_cost || 0) + (cost || 0),
      total_tokens: (current.total_tokens || 0) + (tokens || 0),
      total_credits: (current.total_credits || 0) + (credits || 0),
      last_activity_at: new Date().toISOString(),
    },
  });
}

// ─── AI Usage Logging ────────────────────────────────────────────────────────

async function logAiUsage({
  sessionId,
  userId,
  actionType,
  model,
  provider,
  inputTokens = 0,
  outputTokens = 0,
  metadata = null,
}) {
  if (!userId) return;

  const totalTokens = inputTokens + outputTokens;
  const costUsd = (actionType === 'image_gen' || actionType === 'video' || actionType === 'image_edit')
    ? getFixedCost(actionType, provider)
    : calculateCost(model, inputTokens, outputTokens);
  const creditsUsed = getCreditCost(actionType);

  const row = {
    user_id: userId,
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

  const inserted = await supabaseAdmin('POST', 'ai_usage_logs', { body: row });

  // Update session totals in the background
  if (sessionId) {
    updateSessionTotals(sessionId, {
      cost: costUsd,
      tokens: totalTokens,
      credits: creditsUsed,
    }).catch(() => {});
  }

  console.log(`[Usage] ${actionType} | ${model} | ${totalTokens} tokens | $${costUsd.toFixed(4)} | ${creditsUsed} credits`);
  return inserted?.[0] || null;
}

// ─── Session Cleanup (background) ────────────────────────────────────────────

let cleanupTimer = null;

async function endExpiredSessions() {
  const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
  await supabaseAdmin('PATCH', 'sessions', {
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
  const sessions = await supabaseAdmin('GET', 'sessions', {
    query: `user_id=eq.${userId}&order=started_at.desc&limit=${limit}&select=id,board_id,started_at,last_activity_at,ended_at,total_cost,total_tokens,total_credits`,
  });
  return sessions || [];
}

async function getSessionWithLogs(sessionId, userId) {
  const sessions = await supabaseAdmin('GET', 'sessions', {
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
  MODEL_PRICING,
  CREDIT_COSTS,
};
