import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { registerWaitlistRoutes } from './waitlist.routes.js';

const SEED = 2365;

function passthrough(_req, _res, next) {
  next();
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function makeApp(supabaseAdmin, resendClient = null) {
  const app = express();
  app.use(express.json());
  registerWaitlistRoutes(app, {
    supabaseAdmin,
    waitlistLimiter: passthrough,
    waitlistReadLimiter: passthrough,
    resendClient,
  });
  return app;
}

function makeResend() {
  const calls = [];
  return {
    calls,
    emails: {
      async send(payload) {
        calls.push(payload);
        return { data: { id: 'email-1' }, error: null };
      },
    },
  };
}

async function postDownloadLink(url, body) {
  const res = await fetch(`${url}/api/download-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function post(url, body) {
  const res = await fetch(`${url}/api/waitlist/windows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('windows waitlist rejects a missing email', async () => {
  const { url, close } = await listen(makeApp({}));
  try {
    const res = await post(url, {});
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_request');
  } finally {
    await close();
  }
});

test('windows waitlist rejects a malformed email', async () => {
  const { url, close } = await listen(makeApp({}));
  try {
    const res = await post(url, { email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_request');
  } finally {
    await close();
  }
});

test('windows waitlist honeypot succeeds without writing', async () => {
  let called = false;
  const supabaseAdmin = {
    from() {
      called = true;
      throw new Error('should not write');
    },
  };
  const { url, close } = await listen(makeApp(supabaseAdmin));
  try {
    const res = await post(url, { email: 'bot@example.com', website: 'http://spam.test' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.created, false);
    assert.equal(called, false);
  } finally {
    await close();
  }
});

test('windows waitlist inserts a normalized email and bumps the total', async () => {
  let inserted = null;
  const supabaseAdmin = {
    from(table) {
      assert.equal(table, 'windows_waitlist');
      return {
        async insert(row) {
          inserted = row;
          return { error: null };
        },
        select() {
          return Promise.resolve({ count: 1, error: null });
        },
      };
    },
  };
  const { url, close } = await listen(makeApp(supabaseAdmin));
  try {
    const res = await post(url, { email: '  Alex@LYKN.io ' });
    assert.equal(res.status, 200);
    assert.equal(res.json.joined, true);
    assert.equal(res.json.created, true);
    assert.equal(res.json.count, SEED + 1);
    assert.equal(inserted.email, 'alex@lykn.io');
  } finally {
    await close();
  }
});

test('windows waitlist unique races still count as joined without bumping twice', async () => {
  const supabaseAdmin = {
    from() {
      return {
        async insert() {
          return { error: { code: '23505', message: 'duplicate' } };
        },
        select() {
          return Promise.resolve({ count: 4, error: null });
        },
      };
    },
  };
  const { url, close } = await listen(makeApp(supabaseAdmin));
  try {
    const res = await post(url, { email: 'alex@lykn.io' });
    assert.equal(res.status, 200);
    assert.equal(res.json.joined, true);
    assert.equal(res.json.created, false);
    assert.equal(res.json.count, SEED + 4);
  } finally {
    await close();
  }
});

test('windows waitlist returns 503 when the database is not configured', async () => {
  const { url, close } = await listen(makeApp(null));
  try {
    const res = await post(url, { email: 'alex@lykn.io' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'db_not_configured');
  } finally {
    await close();
  }
});

test('download link rejects a malformed email', async () => {
  const { url, close } = await listen(makeApp({}, makeResend()));
  try {
    const res = await postDownloadLink(url, { email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_request');
  } finally {
    await close();
  }
});

test('download link honeypot succeeds without sending or writing', async () => {
  const resend = makeResend();
  let wrote = false;
  const supabaseAdmin = {
    from() {
      wrote = true;
      throw new Error('should not write');
    },
  };
  const { url, close } = await listen(makeApp(supabaseAdmin, resend));
  try {
    const res = await postDownloadLink(url, {
      email: 'bot@example.com',
      website: 'http://spam.test',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(resend.calls.length, 0);
    assert.equal(wrote, false);
  } finally {
    await close();
  }
});

test('download link returns 503 when email sending is not configured', async () => {
  const { url, close } = await listen(makeApp({}, null));
  try {
    const res = await postDownloadLink(url, { email: 'alex@lykn.io' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'email_not_configured');
  } finally {
    await close();
  }
});

test('download link captures the email and sends the link', async () => {
  const resend = makeResend();
  let inserted = null;
  const supabaseAdmin = {
    from(table) {
      assert.equal(table, 'download_link_requests');
      return {
        async insert(row) {
          inserted = row;
          return { error: null };
        },
      };
    },
  };
  const { url, close } = await listen(makeApp(supabaseAdmin, resend));
  try {
    const res = await postDownloadLink(url, { email: '  Alex@LYKN.io ' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.sent, true);
    assert.equal(inserted.email, 'alex@lykn.io');
    assert.equal(resend.calls.length, 1);
    assert.deepEqual(resend.calls[0].to, ['alex@lykn.io']);
    assert.match(resend.calls[0].subject, /download link/i);
    assert.match(resend.calls[0].text, /LYKN\.dmg/);
  } finally {
    await close();
  }
});

test('download link re-sends for a repeat email despite the unique violation', async () => {
  const resend = makeResend();
  const supabaseAdmin = {
    from() {
      return {
        async insert() {
          return { error: { code: '23505', message: 'duplicate' } };
        },
      };
    },
  };
  const { url, close } = await listen(makeApp(supabaseAdmin, resend));
  try {
    const res = await postDownloadLink(url, { email: 'alex@lykn.io' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(resend.calls.length, 1);
  } finally {
    await close();
  }
});

test('windows waitlist GET reports seed plus stored signups', async () => {
  const supabaseAdmin = {
    from() {
      return {
        select() {
          return Promise.resolve({ count: 12, error: null });
        },
      };
    },
  };
  const { url, close } = await listen(makeApp(supabaseAdmin));
  try {
    const res = await fetch(`${url}/api/waitlist/windows`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.count, SEED + 12);
  } finally {
    await close();
  }
});
