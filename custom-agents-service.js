// ============================================================================
// custom-agents-service.js — bring-your-own-agent outbound webhook layer.
//
// Mirror of connectors-service.js, but pointed in the OPPOSITE direction:
//
//   connectors-service.js  — LYKN PULLS data FROM third-party services
//                            (GitHub, Notion, Spotify, etc.)
//   custom-agents-service  — LYKN PUSHES context TO user-built agents
//                            (n8n, LangChain, Vapi, FastAPI, robot stacks)
//
// One row in `lykn_custom_agents` per registered webhook. The user provides
// an HTTPS URL their agent listens on; LYKN POSTs to it with the user's
// current context block + a trigger payload when a configured trigger
// fires inside the app.
//
// Status (v1): CRUD + /test ping work. The real dispatcher (callCustomAgent
// against live triggers like chat messages or project_state_push) is
// scaffolded below but NOT wired into any trigger source yet — that's
// follow-up work. See migration 070 for the planned trigger vocabulary.
// ============================================================================

import { encryptToken, decryptToken } from './connectors-service.js';

const FETCH_TIMEOUT_MS = 15_000;

// Triggers we accept on insert/update. Mirror the docstring + check
// constraint reservation in migration 070. The DB doesn't enforce this
// set (we use a TEXT[] without an array element check), so the service
// is the canonical filter.
const ALLOWED_TRIGGERS = new Set([
  'manual',
  'chat',
  'belief_ratified',
  'project_state_push',
  'scheduled',
]);

const ALLOWED_CONTEXT_MODES = new Set(['full', 'project', 'minimal', 'none']);

// Display columns we ever return to the client. Critically excludes
// `auth_token_encrypted` — that blob never leaves the server. The
// `has_auth_token` derived flag tells the UI whether ANY secret is
// configured without leaking the value.
const SELECT_COLS = [
  'id',
  'user_id',
  'name',
  'description',
  'endpoint_url',
  'auth_header_name',
  'triggers',
  'context_mode',
  'status',
  'last_called_at',
  'last_status_code',
  'last_latency_ms',
  'last_error',
  'total_call_count',
  'consecutive_errors',
  'metadata',
  'created_at',
  'updated_at',
].join(', ');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

class CustomAgentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CustomAgentValidationError';
  }
}

function sanitizeName(raw) {
  const s = String(raw || '').trim();
  if (s.length < 1 || s.length > 80) {
    throw new CustomAgentValidationError('name must be 1-80 chars');
  }
  return s;
}

function sanitizeEndpointUrl(raw) {
  const s = String(raw || '').trim();
  if (s.length < 1 || s.length > 2048) {
    throw new CustomAgentValidationError('endpoint_url must be 1-2048 chars');
  }
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new CustomAgentValidationError('endpoint_url must be a valid URL');
  }
  // In prod we require https. In dev we allow http://localhost +
  // http://127.0.0.1 so users can iterate against `ngrok http 3000`
  // or a local FastAPI server before deploying.
  const isLocal =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    /\.local$/.test(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new CustomAgentValidationError(
      'endpoint_url must be https (http only allowed for localhost dev)',
    );
  }
  return parsed.toString();
}

function sanitizeTriggers(raw) {
  if (raw === undefined || raw === null) return ['manual'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CustomAgentValidationError('triggers must be a non-empty array');
  }
  const cleaned = Array.from(
    new Set(raw.map((t) => String(t || '').trim()).filter(Boolean)),
  );
  for (const t of cleaned) {
    if (!ALLOWED_TRIGGERS.has(t)) {
      throw new CustomAgentValidationError(
        `unknown trigger "${t}" — allowed: ${[...ALLOWED_TRIGGERS].join(', ')}`,
      );
    }
  }
  return cleaned;
}

function sanitizeContextMode(raw) {
  const s = String(raw || 'full').trim();
  if (!ALLOWED_CONTEXT_MODES.has(s)) {
    throw new CustomAgentValidationError(
      `context_mode must be one of: ${[...ALLOWED_CONTEXT_MODES].join(', ')}`,
    );
  }
  return s;
}

function sanitizeAuthHeaderName(raw) {
  const s = String(raw || 'Authorization').trim();
  if (s.length < 1 || s.length > 64) {
    throw new CustomAgentValidationError('auth_header_name must be 1-64 chars');
  }
  // Lock down to RFC 7230 token chars to prevent header injection.
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(s)) {
    throw new CustomAgentValidationError(
      'auth_header_name must contain only valid HTTP token chars',
    );
  }
  return s;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listCustomAgents(supabaseAdmin, userId) {
  if (!supabaseAdmin) throw new Error('no_db');
  if (!userId) throw new Error('no_user');
  const { data, error } = await supabaseAdmin
    .from('lykn_custom_agents')
    .select(SELECT_COLS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`db: ${error.message}`);
  return (data || []).map(decorateRow);
}

export async function getCustomAgent(supabaseAdmin, userId, agentId) {
  if (!supabaseAdmin) throw new Error('no_db');
  if (!userId) throw new Error('no_user');
  if (!agentId) throw new Error('no_agent');
  const { data, error } = await supabaseAdmin
    .from('lykn_custom_agents')
    .select(SELECT_COLS)
    .eq('user_id', userId)
    .eq('id', agentId)
    .maybeSingle();
  if (error) throw new Error(`db: ${error.message}`);
  return data ? decorateRow(data) : null;
}

export async function createCustomAgent(supabaseAdmin, userId, payload = {}) {
  if (!supabaseAdmin) throw new Error('no_db');
  if (!userId) throw new Error('no_user');

  const row = {
    user_id: userId,
    name: sanitizeName(payload.name),
    description:
      typeof payload.description === 'string'
        ? payload.description.slice(0, 2000)
        : null,
    endpoint_url: sanitizeEndpointUrl(payload.endpoint_url),
    auth_header_name: sanitizeAuthHeaderName(payload.auth_header_name),
    triggers: sanitizeTriggers(payload.triggers),
    context_mode: sanitizeContextMode(payload.context_mode),
    status: 'active',
    metadata:
      payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : {},
  };

  // Encrypt the inbound bearer the user wants their agent to receive.
  // Null is allowed (the agent endpoint is public / no auth) but we
  // discourage in UI copy.
  if (payload.auth_token) {
    row.auth_token_encrypted = encryptToken(String(payload.auth_token));
  }

  const { data, error } = await supabaseAdmin
    .from('lykn_custom_agents')
    .insert(row)
    .select(SELECT_COLS)
    .single();
  if (error) throw new Error(`db: ${error.message}`);
  return decorateRow(data);
}

export async function updateCustomAgent(supabaseAdmin, userId, agentId, patch = {}) {
  if (!supabaseAdmin) throw new Error('no_db');
  if (!userId) throw new Error('no_user');
  if (!agentId) throw new Error('no_agent');

  const update = {};
  if ('name' in patch) update.name = sanitizeName(patch.name);
  if ('description' in patch) {
    update.description =
      typeof patch.description === 'string'
        ? patch.description.slice(0, 2000)
        : null;
  }
  if ('endpoint_url' in patch) update.endpoint_url = sanitizeEndpointUrl(patch.endpoint_url);
  if ('auth_header_name' in patch) update.auth_header_name = sanitizeAuthHeaderName(patch.auth_header_name);
  if ('triggers' in patch) update.triggers = sanitizeTriggers(patch.triggers);
  if ('context_mode' in patch) update.context_mode = sanitizeContextMode(patch.context_mode);
  if ('status' in patch) {
    const s = String(patch.status || '').trim();
    if (!['active', 'paused', 'error', 'reauth'].includes(s)) {
      throw new CustomAgentValidationError(`invalid status "${s}"`);
    }
    update.status = s;
  }
  if ('metadata' in patch && patch.metadata && typeof patch.metadata === 'object') {
    update.metadata = patch.metadata;
  }

  // Secret rotation: a string value REPLACES; explicit null CLEARS;
  // omitted = leave alone (so a patch updating just `name` doesn't
  // accidentally wipe the secret).
  if ('auth_token' in patch) {
    if (patch.auth_token === null) {
      update.auth_token_encrypted = null;
    } else if (typeof patch.auth_token === 'string' && patch.auth_token.length > 0) {
      update.auth_token_encrypted = encryptToken(patch.auth_token);
    }
  }

  if (Object.keys(update).length === 0) {
    return getCustomAgent(supabaseAdmin, userId, agentId);
  }

  const { data, error } = await supabaseAdmin
    .from('lykn_custom_agents')
    .update(update)
    .eq('user_id', userId)
    .eq('id', agentId)
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) throw new Error(`db: ${error.message}`);
  return data ? decorateRow(data) : null;
}

export async function deleteCustomAgent(supabaseAdmin, userId, agentId) {
  if (!supabaseAdmin) throw new Error('no_db');
  if (!userId) throw new Error('no_user');
  if (!agentId) throw new Error('no_agent');
  const { error } = await supabaseAdmin
    .from('lykn_custom_agents')
    .delete()
    .eq('user_id', userId)
    .eq('id', agentId);
  if (error) throw new Error(`db: ${error.message}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dispatch — the bit that actually POSTs to the user's agent.
//
// Two callers today:
//   testCustomAgent — fires a synthetic ping so the user can verify
//                     reachability before wiring real triggers.
//   callCustomAgent — the real dispatcher. NOT wired into trigger
//                     sources yet (scaffold only). Exported so future
//                     trigger-emitter code can import it.
// ---------------------------------------------------------------------------

/**
 * Internal: load + decrypt the secret blob for an agent row. Returns
 * `null` if the agent has no secret configured (public endpoint case).
 * Throws if the blob is present but malformed (key rotation gone wrong,
 * etc.) so the caller can surface a clear error instead of silently
 * dispatching with no auth header.
 */
async function loadAgentSecret(supabaseAdmin, userId, agentId) {
  const { data, error } = await supabaseAdmin
    .from('lykn_custom_agents')
    .select('id, user_id, endpoint_url, auth_header_name, auth_token_encrypted, context_mode, status')
    .eq('user_id', userId)
    .eq('id', agentId)
    .maybeSingle();
  if (error) throw new Error(`db: ${error.message}`);
  if (!data) return null;
  let secret = null;
  if (data.auth_token_encrypted) {
    secret = decryptToken(data.auth_token_encrypted);
  }
  return { row: data, secret };
}

/**
 * Build the JSON body POSTed to the user's agent. Shape is stable so
 * users can write a single handler that switches on `trigger`:
 *
 *   {
 *     "trigger": "manual" | "chat" | "test" | …,
 *     "user_id": "<uuid>",
 *     "context_block": "<long string or empty>",
 *     "payload": <trigger-specific extras, free-form>,
 *     "lykn": { "version": "1", "agent_id": "<uuid>" }
 *   }
 */
function buildDispatchBody({ trigger, userId, agentId, contextBlock, payload }) {
  return {
    trigger,
    user_id: userId,
    context_block: contextBlock || '',
    payload: payload || {},
    lykn: {
      version: '1',
      agent_id: agentId,
    },
  };
}

/**
 * Internal: actually POST to the user's endpoint with a timeout and
 * normalised error handling. Returns a telemetry blob the caller can
 * persist on the agent row (status, latency, body preview, error).
 */
async function postToAgent(row, secret, body) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'LYKN-CustomAgent/1.0' };
  if (secret) {
    // Most agents expect "Bearer X" but a few (Vapi, custom) want the
    // raw secret. We default to Bearer prefix UNLESS the user already
    // typed Bearer into the secret field (then we'd double-prefix).
    const raw = String(secret).trim();
    headers[row.auth_header_name] =
      row.auth_header_name.toLowerCase() === 'authorization' && !/^bearer\s/i.test(raw)
        ? `Bearer ${raw}`
        : raw;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(row.endpoint_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latency = Date.now() - startedAt;
    let bodyText = '';
    try {
      bodyText = (await res.text()).slice(0, 4000);
    } catch {
      bodyText = '';
    }
    return {
      ok: res.ok,
      status: res.status,
      latency_ms: latency,
      body_preview: bodyText,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const latency = Date.now() - startedAt;
    const message =
      err?.name === 'AbortError'
        ? `timeout after ${FETCH_TIMEOUT_MS}ms`
        : err?.message || 'fetch failed';
    return { ok: false, status: 0, latency_ms: latency, body_preview: '', error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record dispatch telemetry on the agent row. Best-effort; we don't
 * fail the caller if the update doesn't land.
 *
 * Increment-counter caveat: the Supabase JS client can't express
 * `total_call_count = total_call_count + 1` in a single round-trip
 * without an RPC, so today we do a read-then-write that's racy under
 * concurrent dispatches. v1 only dispatches via /test (a user click,
 * not a fan-out trigger), so the race is theoretical. When the real
 * dispatcher ships in 071 we'll add an RPC (or move telemetry into
 * the audit-log table) and drop this read-then-write.
 */
async function recordTelemetry(supabaseAdmin, userId, agentId, telemetry) {
  try {
    const { data: current } = await supabaseAdmin
      .from('lykn_custom_agents')
      .select('total_call_count, consecutive_errors')
      .eq('user_id', userId)
      .eq('id', agentId)
      .maybeSingle();
    const patch = {
      last_called_at: new Date().toISOString(),
      last_status_code: telemetry.status,
      last_latency_ms: telemetry.latency_ms,
      last_error: telemetry.error,
      total_call_count: (current?.total_call_count || 0) + 1,
      consecutive_errors: telemetry.ok
        ? 0
        : (current?.consecutive_errors || 0) + 1,
    };
    await supabaseAdmin
      .from('lykn_custom_agents')
      .update(patch)
      .eq('user_id', userId)
      .eq('id', agentId);
  } catch {
    // swallow — telemetry is best-effort
  }
}

/**
 * Fire a synthetic ping at the agent so the user can confirm
 * reachability + auth before wiring real triggers. The body uses
 * trigger="test" so the user's handler can branch.
 *
 * Does NOT load the user's real context block — that would be wasteful
 * for a reachability ping. We stuff a one-line placeholder into
 * `context_block` so the user can see the shape their agent will
 * receive in production.
 */
export async function testCustomAgent(supabaseAdmin, userId, agentId) {
  const loaded = await loadAgentSecret(supabaseAdmin, userId, agentId);
  if (!loaded) return { ok: false, error: 'agent_not_found' };
  const { row, secret } = loaded;
  if (row.status === 'paused') {
    return { ok: false, error: 'agent_paused' };
  }
  const body = buildDispatchBody({
    trigger: 'test',
    userId,
    agentId,
    contextBlock:
      '[BELIEFS_AND_RULES]\n(placeholder — real context block will appear here on live triggers)\n',
    payload: {
      message:
        'This is a LYKN custom-agent reachability test. If you can see this body, the wiring works.',
    },
  });
  const telemetry = await postToAgent(row, secret, body);
  await recordTelemetry(supabaseAdmin, userId, agentId, telemetry);
  return {
    ok: telemetry.ok,
    status: telemetry.status,
    latency_ms: telemetry.latency_ms,
    body_preview: telemetry.body_preview,
    error: telemetry.error,
  };
}

/**
 * Real dispatcher. NOT wired into any trigger source yet — included
 * here so future work (chat orchestrator firing on every send, project
 * state push hook, scheduled job, etc.) can import it without round-
 * tripping through the route layer.
 *
 * @param contextLoader  async function returning the string to put in
 *                       `context_block` for this dispatch. Caller picks
 *                       which projection (full / project / minimal /
 *                       none) based on the agent's context_mode. The
 *                       service can't pick because it doesn't have a
 *                       circular import on beliefSystem.js — keeping
 *                       that decision in the trigger emitter avoids it.
 *
 * Example wiring (TODO — not active today):
 *
 *   import { callCustomAgent } from './custom-agents-service.js';
 *   import { buildContextBlockString } from './beliefSystem.js';
 *
 *   await callCustomAgent(supabaseAdmin, userId, agentId, {
 *     trigger: 'project_state_push',
 *     payload: { state_key, state_value },
 *     contextLoader: () => buildContextBlockString(supabaseAdmin, userId, {
 *       projection: row.context_mode,
 *     }),
 *   });
 */
export async function callCustomAgent(
  supabaseAdmin,
  userId,
  agentId,
  { trigger, payload, contextLoader },
) {
  if (!ALLOWED_TRIGGERS.has(String(trigger || ''))) {
    return { ok: false, error: 'invalid_trigger' };
  }
  const loaded = await loadAgentSecret(supabaseAdmin, userId, agentId);
  if (!loaded) return { ok: false, error: 'agent_not_found' };
  const { row, secret } = loaded;
  if (row.status !== 'active') {
    return { ok: false, error: `agent_status_${row.status}` };
  }
  let contextBlock = '';
  if (row.context_mode !== 'none' && typeof contextLoader === 'function') {
    try {
      contextBlock = String((await contextLoader(row)) || '');
    } catch {
      contextBlock = '';
    }
  }
  const body = buildDispatchBody({
    trigger,
    userId,
    agentId,
    contextBlock,
    payload,
  });
  const telemetry = await postToAgent(row, secret, body);
  await recordTelemetry(supabaseAdmin, userId, agentId, telemetry);
  return {
    ok: telemetry.ok,
    status: telemetry.status,
    latency_ms: telemetry.latency_ms,
    body_preview: telemetry.body_preview,
    error: telemetry.error,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function decorateRow(row) {
  if (!row) return row;
  const { auth_token_encrypted, ...rest } = row;
  return {
    ...rest,
    has_auth_token: Boolean(auth_token_encrypted),
  };
}

export { CustomAgentValidationError, ALLOWED_TRIGGERS, ALLOWED_CONTEXT_MODES };
