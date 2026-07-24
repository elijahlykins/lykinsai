// security-logger.test.js — coverage for the canonical security event sink.
//
// We exercise three pieces of contract that the rest of LYKN depends on:
//   1. logSecurityEvent emits exactly one JSON line to console.error per call.
//   2. When a supabaseAdmin sink is wired via setSecurityLoggerSink, every
//      emit also dispatches one insert into lykn_security_audit with the
//      expected column shape (event_type, target_table, target_id, user_id,
//      client_id, occurred_at, metadata).
//   3. tokenPrefix never returns the full token (replay safety).
//   4. buildRateLimitHandler returns a function that preserves the
//      express-rate-limit response contract (statusCode + JSON body)
//      AND fires logSecurityEvent fire-and-forget.
//
// Tests run with --test (the project-wide pattern). No network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SecurityEvent,
  logSecurityEvent,
  setSecurityLoggerSink,
  _getSecurityLoggerSink,
  buildRateLimitHandler,
  tokenPrefix,
} from './security-logger.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Capture every console.error call inside `fn` and return the captured args. */
async function captureConsoleError(fn) {
  const captured = [];
  const original = console.error;
  console.error = (...args) => { captured.push(args); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return captured;
}

/**
 * Build a fake supabaseAdmin that records insert calls and lets the caller
 * decide whether each insert resolves or rejects. The shape mirrors what
 * security-logger.js calls: supabase.from(table).insert(row).
 */
function makeFakeAdmin({ onInsert = () => ({ error: null }) } = {}) {
  const calls = [];
  const admin = {
    from(table) {
      return {
        insert(row) {
          calls.push({ table, row });
          return Promise.resolve(onInsert({ table, row }));
        },
      };
    },
  };
  return { admin, calls };
}

// Always reset the module-level sink between tests so order doesn't matter.
test.beforeEach(() => setSecurityLoggerSink(null));

// ── Tests ──────────────────────────────────────────────────────────────────

test('SecurityEvent registry is frozen and includes the core events', () => {
  assert.equal(Object.isFrozen(SecurityEvent), true);
  // Spot-check a representative slice — the full set is enforced by the
  // shape of the constant, not by an exhaustive enumeration here.
  for (const k of [
    'AUTH_FAILURE',
    'AUTH_MISSING_TOKEN',
    'OAUTH_REPLAY_DETECTED',
    'RATE_LIMIT_AUTH',
    'RATE_LIMIT_HIT',
    'VALIDATION_FAILURE',
    'INJECTION_STRIPPED',
    'TOOL_BLOCKED',
    'TOOL_HANDLER_FAILED',
    'UNHANDLED_ERROR',
    'AUDIT_LOG_FAILED',
  ]) {
    assert.ok(typeof SecurityEvent[k] === 'string', `${k} missing`);
    assert.ok(SecurityEvent[k].length > 0, `${k} empty string`);
  }
});

test('tokenPrefix truncates to 8 chars + ellipsis and never returns the full token', () => {
  const fake = 'lkn_live_abcdef0123456789xxxxyyyy';
  const prefix = tokenPrefix(fake);
  assert.equal(prefix, 'lkn_live...');
  // Defensive: prefix must be shorter than the input for any non-trivial
  // token — otherwise we'd be leaking the whole thing.
  assert.ok(prefix.length < fake.length);

  assert.equal(tokenPrefix(null), null);
  assert.equal(tokenPrefix(''), null);
  assert.equal(tokenPrefix('short'), 'short...'); // strings <=n still get marker
});

test('logSecurityEvent: emits one structured JSON line to console.error (no DB sink)', async () => {
  // No sink wired — console.error path only.
  const captured = await captureConsoleError(async () => {
    await logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: 'test' }, {
      userId: 'user-uuid-1',
      ip: '203.0.113.7',
      path: '/api/test',
      method: 'POST',
    });
  });

  assert.equal(captured.length, 1, 'expected exactly one console.error call');
  const arg = captured[0][0];
  assert.equal(typeof arg, 'string', 'console.error argument must be a string (JSON line)');
  const parsed = JSON.parse(arg);
  assert.equal(parsed.level, 'security');
  assert.equal(parsed.event, 'auth.failure');
  assert.equal(parsed.userId, 'user-uuid-1');
  assert.equal(parsed.ip, '203.0.113.7');
  assert.equal(parsed.path, '/api/test');
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.reason, 'test');
  assert.ok(typeof parsed.ts === 'string' && parsed.ts.endsWith('Z'), 'ts must be ISO-8601');
});

test('logSecurityEvent: dispatches an audit-row insert when sink is wired', async () => {
  const { admin, calls } = makeFakeAdmin();
  setSecurityLoggerSink(admin);
  assert.strictEqual(_getSecurityLoggerSink(), admin);

  await captureConsoleError(async () => {
    await logSecurityEvent(
      'oauth.replay_detected',
      {
        targetTable: 'lykn_oauth_refresh_tokens',
        targetId: 'refresh-row-uuid',
        tokenPrefix: 'lkn_refr...',
      },
      {
        userId: 'user-uuid-2',
        clientId: 'oauth-client-7',
        ip: '198.51.100.4',
        path: '/oauth/token',
        method: 'POST',
      },
    );
  });

  // The insert is fire-and-forget — give the microtask queue a tick to drain.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1, 'expected exactly one insert into lykn_security_audit');
  const { table, row } = calls[0];
  assert.equal(table, 'lykn_security_audit');
  assert.equal(row.event_type, 'oauth.replay_detected');
  assert.equal(row.target_table, 'lykn_oauth_refresh_tokens');
  assert.equal(row.target_id, 'refresh-row-uuid');
  assert.equal(row.user_id, 'user-uuid-2');
  assert.equal(row.client_id, 'oauth-client-7');
  assert.ok(typeof row.occurred_at === 'string' && row.occurred_at.endsWith('Z'));
  assert.equal(row.metadata.ip, '198.51.100.4');
  assert.equal(row.metadata.path, '/oauth/token');
  assert.equal(row.metadata.method, 'POST');
  assert.equal(row.metadata.tokenPrefix, 'lkn_refr...');
  // Critical: payload's redacted prefix is forwarded; the raw token must
  // NEVER appear in the audit row metadata.
  assert.equal(row.metadata.refreshToken, undefined);
});

test('logSecurityEvent: a failing DB insert does NOT throw / reject', async () => {
  const { admin } = makeFakeAdmin({
    onInsert: () => ({ error: { message: 'connection_refused' } }),
  });
  setSecurityLoggerSink(admin);

  let threw = false;
  const captured = await captureConsoleError(async () => {
    try {
      await logSecurityEvent('auth.failure', {}, { req: { ip: '127.0.0.1', path: '/x', method: 'GET' } });
    } catch {
      threw = true;
    }
    // Let the .then() catch fire.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(threw, false, 'logSecurityEvent must never throw from the request path');

  // We expect at least 2 console.error lines: the original event + the
  // audit.log_failed surface.
  const lines = captured.map((c) => {
    try { return JSON.parse(c[0]); } catch { return null; }
  }).filter(Boolean);
  const auditFailed = lines.find((l) => l.event === SecurityEvent.AUDIT_LOG_FAILED);
  assert.ok(auditFailed, 'audit.log_failed surface line should appear');
  assert.equal(auditFailed.for_event, 'auth.failure');
});

test('buildRateLimitHandler: returns a function that emits + responds with the configured 429 body', async () => {
  const { admin, calls } = makeFakeAdmin();
  setSecurityLoggerSink(admin);

  const handler = buildRateLimitHandler(SecurityEvent.RATE_LIMIT_AUTH, 'authLimiter');
  assert.equal(typeof handler, 'function');

  // Fake express req/res.
  const req = { ip: '203.0.113.99', path: '/oauth/token', method: 'POST' };
  let sentStatus = null;
  let sentBody = null;
  const res = {
    status(s) { sentStatus = s; return this; },
    json(body) { sentBody = body; return this; },
    type() { return this; },
    send(body) { sentBody = body; return this; },
  };
  const options = { statusCode: 429, message: { error: 'Too many authentication attempts. Try again later.' } };

  await captureConsoleError(async () => {
    handler(req, res, () => {}, options);
    // fire-and-forget insert needs to settle.
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(sentStatus, 429);
  assert.deepEqual(sentBody, { error: 'Too many authentication attempts. Try again later.' });

  // The handler fires logSecurityEvent fire-and-forget; the insert may or
  // may not have settled depending on event-loop ordering. Assert the
  // visible side: a row was queued for insertion.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].row.event_type, 'ratelimit.auth_endpoint');
  // target_table is NOT NULL in lykn_security_audit — app-layer events
  // without an explicit table must land a non-null sentinel.
  assert.equal(calls[0].row.target_table, 'request');
  assert.equal(calls[0].row.metadata.limiter, 'authLimiter');
  assert.equal(calls[0].row.metadata.endpoint, '/oauth/token');
});

test('logSecurityEvent: defaults target_table to "request" when omitted', async () => {
  const { admin, calls } = makeFakeAdmin();
  setSecurityLoggerSink(admin);

  await captureConsoleError(async () => {
    await logSecurityEvent(SecurityEvent.RATE_LIMIT_HIT, {
      limiter: 'aiLimiter',
      endpoint: '/api/ai/meeting-chunk',
    }, {
      userId: 'user-uuid-rl',
      ip: '203.0.113.50',
      path: '/api/ai/meeting-chunk',
      method: 'POST',
    });
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].row.event_type, 'ratelimit.hit');
  assert.equal(calls[0].row.target_table, 'request');
  assert.equal(calls[0].row.target_id, null);
});

test('logSecurityEvent: ctx.req shorthand pulls ip/path/method/userId off the request', async () => {
  setSecurityLoggerSink(null); // console-only
  const captured = await captureConsoleError(async () => {
    await logSecurityEvent('validation.failure', { target: 'body', fields: ['url'] }, {
      req: { ip: '10.0.0.1', path: '/api/feeds', method: 'POST', user: { id: 'user-uuid-3' } },
    });
  });
  const parsed = JSON.parse(captured[0][0]);
  assert.equal(parsed.event, 'validation.failure');
  assert.equal(parsed.userId, 'user-uuid-3');
  assert.equal(parsed.ip, '10.0.0.1');
  assert.equal(parsed.path, '/api/feeds');
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.target, 'body');
  assert.deepEqual(parsed.fields, ['url']);
});
