// ============================================================================
// security-logger.js — single canonical security event emitter (Agent 06)
// ============================================================================
// Every security event in LYKN flows through this module. Two sinks per call:
//
//   1. console.error with a structured JSON line. Render's log stream picks
//      this up; a future log aggregator (Datadog, Better Stack, etc.) can
//      ingest by grep on `"level":"security"`.
//   2. Best-effort insert into the lykn_security_audit table (Agent 03's
//      service-role-only audit table, migration 065). Fire-and-forget — the
//      request path NEVER awaits this insert. If the insert fails, the
//      console.error line is still durable.
//
// The DB triggers in migration 065 already populate audit rows for OAuth
// code mint/consume, refresh mint/rotate, and MCP token mint/revoke.
// Application-layer emission is for events the DB can't see — rate-limit
// hits, validation failures, blocked tool calls, prompt-injection strips,
// auth failures, unhandled errors, startup secret validation failures.
//
// REDACTION DISCIPLINE — payload MUST NEVER contain:
//   - raw access / refresh tokens
//   - full Authorization header values
//   - passwords or password hashes
//   - PKCE code verifiers
//   - Stripe card data or full webhook payloads
//   - user PII beyond the userId UUID
//
// ALWAYS safe to log:
//   - userId (UUID, opaque)
//   - clientId (opaque)
//   - IP address (req.ip — Agent 01 made trust-proxy correct)
//   - path / method
//   - event type / rate-limit name / tool name
//   - truncated identifiers: tokenPrefix(value) → first 8 chars + '...'
//
// CIA: Integrity (audit trail), Confidentiality (no secrets in logs),
//      Availability (operational visibility).
// Principle: SoD (one logger), KISS (one function, one schema), DiD
//      (logging is the detection layer independent of prevention).

// ---------------------------------------------------------------------------
// Event type registry — stable strings consumed by alerting rules
// ---------------------------------------------------------------------------
//
// New events get a stable string here BEFORE any emit site references them
// so the alert-rule table in INCIDENT_RUNBOOK.md stays in sync.

export const SecurityEvent = Object.freeze({
  // Auth (Supabase JWT path)
  AUTH_SUCCESS:           'auth.success',
  AUTH_FAILURE:           'auth.failure',
  AUTH_MISSING_TOKEN:     'auth.missing_token',
  AUTH_EXPIRED_TOKEN:     'auth.expired_token',
  AUTH_CONFIG_MISSING:    'auth.config_missing', // M2 (Agent 02) fail-closed branch
  SESSION_SIGNOUT:        'session.signout',
  SESSION_SIGNOUT_ALL:    'session.signout_all',

  // OAuth provider (LYKN as OP)
  OAUTH_CODE_ISSUED:      'oauth.code_issued',
  OAUTH_TOKEN_ISSUED:     'oauth.token_issued',
  OAUTH_TOKEN_REFRESHED:  'oauth.token_refreshed',
  OAUTH_REPLAY_DETECTED:  'oauth.replay_detected', // RFC 6749 §10.4
  OAUTH_REVOKE:           'oauth.revoke',

  // MCP token events (DB triggers in migration 065 cover mint/revoke;
  // these constants exist for completeness — see SECURITY_REPORT_06.md
  // §"deliberate non-duplication".)
  MCP_TOKEN_MINTED:       'mcp.token_minted',
  MCP_TOKEN_REVOKED:      'mcp.token_revoked',

  // Rate limiting (each limiter handler emits exactly one of these)
  RATE_LIMIT_HIT:         'ratelimit.hit',
  RATE_LIMIT_AUTH:        'ratelimit.auth_endpoint',

  // Input / injection
  VALIDATION_FAILURE:     'validation.failure',
  INJECTION_STRIPPED:     'injection.stripped',
  TOOL_BLOCKED:           'tool.blocked',
  TOOL_HANDLER_FAILED:    'tool.handler_failed',

  // Secrets / startup
  SECRET_VALIDATION_FAIL: 'secrets.validation_failure',
  SECRET_ROTATION:        'secrets.rotation',

  // Errors
  UNHANDLED_ERROR:        'error.unhandled',
  DB_ERROR:               'error.database',

  // Audit-self
  AUDIT_LOG_FAILED:       'audit.log_failed',
});

// ---------------------------------------------------------------------------
// Public utility: redact tokens to a non-replayable prefix
// ---------------------------------------------------------------------------
//
// Use this for any token, hash, secret, or opaque-credential string you want
// to correlate across log lines WITHOUT giving an attacker who reads the log
// stream enough material to replay. 8 chars of a 32-byte random token is
// 6 bits of identifying entropy — useful for "I see this same prefix in two
// log lines five minutes apart" forensics, useless for "log this back to
// the API as a valid bearer token".

export function tokenPrefix(value, n = 8) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= n) return `${value}...`;
  return `${value.slice(0, n)}...`;
}

// ---------------------------------------------------------------------------
// Module-private supabase client holder
// ---------------------------------------------------------------------------
//
// security-logger.js must NOT import server.js (cycle: server.js → security-
// logger.js → server.js). Instead, server.js calls setSecurityLoggerSink()
// once at boot with its supabaseAdmin singleton. Until that call lands, the
// logger still works — it just degrades to console.error only. That is the
// correct fallback: dropping a request because the audit table is unreachable
// would be worse than missing the audit row.

let _supabaseAdmin = null;

/**
 * Wire the audit-table sink. Called once at boot from server.js with the
 * service-role supabaseAdmin client. Safe to call again (latest wins) for
 * test environments that swap clients.
 */
export function setSecurityLoggerSink(supabaseAdmin) {
  _supabaseAdmin = supabaseAdmin || null;
}

/**
 * Read the current sink. Exported only for tests.
 */
export function _getSecurityLoggerSink() {
  return _supabaseAdmin;
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------

function safeIso(d) {
  try {
    return (d instanceof Date ? d : new Date()).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Emit a security event.
 *
 * @param {string} eventType  - one of SecurityEvent.* (free-form strings
 *                              also accepted so a future emit site can land
 *                              before the constant is added — but prefer
 *                              adding the constant first).
 * @param {object} [payload]  - event-specific metadata. MUST NOT contain
 *                              secrets, full tokens, passwords, or PII
 *                              beyond userId. Optional fields used by the
 *                              audit row directly:
 *                                payload.targetTable → audit.target_table
 *                                payload.targetId    → audit.target_id
 *                              Everything else is folded into audit.metadata.
 * @param {object} [ctx]      - request / actor context. Recognised keys:
 *                                ctx.userId    - explicit userId override
 *                                ctx.clientId  - OAuth client id
 *                                ctx.req       - Express req (we read req.ip,
 *                                                req.path, req.method,
 *                                                req.user?.id from it)
 *                                ctx.ip        - explicit IP override
 *                                ctx.path      - explicit path override
 *                                ctx.method    - explicit method override
 *
 * @returns {Promise<void>}   - resolves after the console.error has flushed
 *                              and the DB insert has been DISPATCHED (not
 *                              awaited). Callers should not block on this
 *                              promise on the request hot path — fire-and-
 *                              forget is the intended usage.
 */
export async function logSecurityEvent(eventType, payload = {}, ctx = {}) {
  // Defensive: never let a malformed call torpedo the request that triggered
  // it. Every branch below catches its own errors.
  try {
    const userId = ctx.userId ?? ctx.req?.user?.id ?? null;
    const clientId = ctx.clientId ?? null;
    const ip = ctx.ip ?? ctx.req?.ip ?? null;
    const path = ctx.path ?? ctx.req?.path ?? null;
    const method = ctx.method ?? ctx.req?.method ?? null;
    const ts = safeIso();

    // Pull audit-column hints out of payload so the table columns are
    // populated when possible; whatever is left goes into metadata.
    const { targetTable = null, targetId = null, ...rest } = payload || {};

    // 1) Structured console line — picked up by Render's log drain.
    //    Single JSON line per event for easy ingestion.
    try {
      console.error(JSON.stringify({
        level: 'security',
        event: eventType,
        userId,
        clientId,
        ip,
        path,
        method,
        ts,
        ...rest,
      }));
    } catch {
      // JSON.stringify can fail on circular structures in `rest`. Fall back
      // to a minimal line so we still get the event signal.
      console.error(JSON.stringify({
        level: 'security',
        event: eventType,
        userId,
        clientId,
        ip,
        path,
        method,
        ts,
        _payload_serialise_failed: true,
      }));
    }

    // 2) Best-effort insert into lykn_security_audit (Agent 03's table).
    //    Fire-and-forget — request path never awaits.
    if (_supabaseAdmin) {
      const row = {
        event_type: String(eventType).slice(0, 128),
        target_table: targetTable,
        target_id: targetId !== null && targetId !== undefined
          ? String(targetId).slice(0, 256)
          : null,
        user_id: userId,
        client_id: clientId,
        occurred_at: ts,
        metadata: {
          ip,
          path,
          method,
          ...rest,
        },
      };
      // Intentionally NOT awaited. The audit insert must never block the
      // request path. If the insert throws / rejects, the catch below logs
      // a single audit.log_failed event to console.error (NOT back through
      // logSecurityEvent — that would risk an infinite loop).
      Promise.resolve(_supabaseAdmin.from('lykn_security_audit').insert(row))
        .then((result) => {
          if (result?.error) {
            console.error(JSON.stringify({
              level: 'security',
              event: SecurityEvent.AUDIT_LOG_FAILED,
              ts: safeIso(),
              for_event: eventType,
              err: String(result.error.message || result.error).slice(0, 500),
            }));
          }
        })
        .catch((err) => {
          console.error(JSON.stringify({
            level: 'security',
            event: SecurityEvent.AUDIT_LOG_FAILED,
            ts: safeIso(),
            for_event: eventType,
            err: String(err?.message || err).slice(0, 500),
          }));
        });
    }
  } catch (err) {
    // Last-resort guard: the whole emit threw synchronously somehow.
    // Drop to plain console so we at least know an emit attempt failed.
    try {
      console.error('[security-logger] emit failed:', String(err?.message || err));
    } catch {
      // Nothing else we can safely do.
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: build a limiter `handler:` callback (Agent 06 D3)
// ---------------------------------------------------------------------------
//
// express-rate-limit v7 calls `handler(req, res, next, options)` when a key
// exceeds its window. The default sends the configured `message`. We want
// to do that AND emit a security event. This helper returns a handler that
// preserves the existing 429 + message behaviour and adds a logSecurityEvent
// call. Use `buildRateLimitHandler(SecurityEvent.RATE_LIMIT_AUTH, 'authLimiter')`.

export function buildRateLimitHandler(eventType, limiterName) {
  return (req, res, _next, options) => {
    // fire-and-forget
    logSecurityEvent(eventType, {
      limiter: limiterName,
      endpoint: req.path,
      method: req.method,
    }, { req });

    const status = options?.statusCode ?? 429;
    const body = options?.message ?? { error: 'Too many requests' };
    if (typeof body === 'string') {
      return res.status(status).type('text/plain').send(body);
    }
    return res.status(status).json(body);
  };
}
